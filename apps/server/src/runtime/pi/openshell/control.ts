// What the session can do with one OpenShell sandbox beyond running commands: the network approvals the supervisor
// raises, and attaching credential providers.
import type { DraftChunk, NetworkRule, OpenShellClient, SandboxLog } from "./client";
import { ExecTracker, runCommand, type RunOutcome, type RunRequest } from "./exec";

export interface CapturedRun {
  outcome: RunOutcome;
  stdout: string;
  stderr: string;
}

/**
 * Binaries a host the user allowed is opened to. Rules are per executable in OpenShell (a rule on bash does not cover
 * what bash starts, verified), and these are the real paths of the tools that reach the network in this image.
 */
export const NETWORK_BINARIES = ["/usr/bin/curl", "/usr/bin/wget", "/usr/bin/git", "/usr/lib/git-core/git-remote-http", "/usr/local/bin/node"];

/** Told about commands of the model that failed, so it can recognise a network denial. */
export interface CommandWatch {
  /** Returns a line to append to the failed command's output, or null. */
  afterFailure(info: { startedAt: number; command: string; output: string; code: number }): Promise<string | null>;
}

export class OpenShellControl {
  readonly tracker = new ExecTracker();
  /** Set by the session: what to do when a command fails. */
  network: CommandWatch | undefined;
  private recycling: Promise<number> | undefined;
  private detaching: Promise<void> | undefined;
  private detachFailure: Error | undefined;
  private baseline: Set<number> | undefined;

  constructor(
    private client: OpenShellClient,
    readonly name: string,
  ) {}

  pendingChunks(): Promise<DraftChunk[]> {
    return this.client.pendingChunks(this.name);
  }


  rejectChunk(chunk: DraftChunk, reason: string): Promise<void> {
    return this.client.rejectChunk(this.name, chunk.id, reason);
  }

  /**
   * Adds rules to the sandbox's network policy and waits until the sandbox has loaded them: after that, the first
   * request to the new endpoints goes through. Loading takes up to ten seconds (the supervisor polls for changes).
   */
  async allow(rules: NetworkRule[], timeoutMs = 45_000): Promise<number> {
    const t0 = Date.now();
    const version = await this.client.addNetworkRules(this.name, rules);
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.client.policyStatus(this.name, version);
      if (s.status === "FAILED") throw new Error(`The sandbox rejected the network rule: ${s.error || "no reason given"}`);
      if (s.active >= version) {
        console.log(`telepi: ${this.name} loaded network policy v${version} (${rules.map((r) => r.endpoints.map((e) => `${e.host}:${e.port}`).join(",")).join(" ")}) ${Date.now() - t0} ms after the request`);
        return version;
      }
      if (Date.now() > end) throw new Error(`The sandbox did not load the network rule within ${Math.round(timeoutMs / 1000)} s.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Follows the supervisor's log lines. See OpenShellClient.watchLogs. */
  watchLogs(onLog: (log: SandboxLog) => void, onEnd: (error?: Error) => void): () => void {
    return this.client.watchLogs(this.name, onLog, onEnd);
  }

  /**
   * Stops and starts the sandbox. This ends every process in it (nothing signals across execs, so this is the only way
   * to end one that detached). Kept: the workspace and other mounts, files elsewhere in the container's filesystem,
   * the network policy with its approved rules, and attached providers. Resolves with how long it took.
   */
  recycle(): Promise<number> {
    this.recycling ??= (async () => {
      const t0 = Date.now();
      try {
        await this.client.stopSandbox(this.name);
        await this.client.startSandbox(this.name);
        await this.client.waitReady(this.name);
        await this.markBaseline().catch(() => { this.baseline = undefined; });
        return Date.now() - t0;
      } finally {
        this.recycling = undefined;
      }
    })();
    return this.recycling;
  }

  /**
   * Detaches a provider without making the caller wait for the supervisor's poll (about ten seconds). Until it is done
   * the credential is still in the sandbox, so nothing that runs the agent may start: callers await providersDetached()
   * first, and attachProvider() does it too. A failed detach is retried; if it still fails the failure stays, and
   * providersDetached() keeps throwing it, so the agent never runs next to a credential that could not be taken away.
   */
  detachProviderLater(provider: string): void {
    const before = this.detaching;
    this.detaching = (async () => {
      await before;
      let last: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.detachProvider(provider);
          return;
        } catch (e) {
          // A sandbox that is gone has no credential left in it.
          if (/NOT_FOUND/.test(String(e instanceof Error ? e.message : e))) return;
          last = e;
          console.warn(`telepi: could not detach ${provider} from ${this.name} (attempt ${attempt}):`, e instanceof Error ? e.message : e);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      this.detachFailure = new Error(`OpenShell would not take the credential ${provider} away from the sandbox: ${last instanceof Error ? last.message : String(last)}`);
    })();
  }

  /** True while a background detach has not finished. */
  get detachPending(): boolean {
    return this.detaching !== undefined;
  }

  /** Resolves when no detach is pending; throws when one failed for good. */
  async providersDetached(): Promise<void> {
    while (this.detaching) {
      const pending = this.detaching;
      await pending;
      if (this.detaching === pending) this.detaching = undefined;
    }
    if (this.detachFailure) throw this.detachFailure;
  }

  private async processes(): Promise<Map<number, string>> {
    const out: Buffer[] = [];
    await this.client.exec(this.name, {
      command: ["bash", "-c", `me=$$; ps -eo pid=,ppid=,stat=,comm= | while read pid ppid stat comm; do case "$stat" in Z*) continue;; esac; [ "$pid" = "$me" ] || [ "$ppid" = "$me" ] && continue; echo "$pid $comm"; done`],
      timeoutSecs: 20,
      onStdout: (d) => out.push(d),
    });
    const found = new Map<number, string>();
    for (const line of Buffer.concat(out).toString().split("\n").filter(Boolean)) {
      const [pid, ...rest] = line.split(" ");
      found.set(Number(pid), rest.join(" "));
    }
    return found;
  }

  /** Remembers what runs in a fresh sandbox (its own init), before any command of the agent has. */
  async markBaseline(): Promise<void> {
    this.baseline = new Set((await this.processes()).keys());
  }

  /**
   * Processes the agent left running in the sandbox: alive now and not part of the sandbox as it started. While a task
   * is in review nothing of telepi's runs there, so these are a background job or a command that detached.
   */
  async strayProcesses(): Promise<string[]> {
    if (!this.baseline) throw new Error("no baseline of the sandbox's processes");
    return [...(await this.processes())].filter(([pid]) => !this.baseline!.has(pid)).map(([, comm]) => comm);
  }

  /** Attaches a provider and waits until the supervisor has installed its credential (about ten seconds). */
  async attachProvider(provider: string): Promise<void> {
    await this.providersDetached();
    const receipt = await this.client.attachProvider(this.name, provider);
    await this.waitProvider(provider, receipt, (s) => s === "READY");
  }

  /** Detaches a provider and waits until the supervisor has dropped the credential and its network access. */
  async detachProvider(provider: string): Promise<void> {
    const receipt = await this.client.detachProvider(this.name, provider);
    await this.waitProvider(provider, receipt, (s) => s === "REVOKED" || s === "SUPERSEDED");
  }

  private async waitProvider(provider: string, receipt: string, done: (state: string) => boolean): Promise<void> {
    const end = Date.now() + 60_000;
    for (;;) {
      const status = await this.client.providerStatus(this.name, provider, receipt).catch((e: Error) => ({ state: `ERROR ${e.message}`, reason: "" }));
      if (process.env.TELEPI_DEBUG_PROVIDER) console.log(`telepi: provider ${provider} ${status.state} ${status.reason}`);
      if (done(status.state)) return;
      if (status.state === "FAILED") throw new Error(`OpenShell could not change provider ${provider}: ${status.reason}`);
      if (Date.now() > end) throw new Error(`OpenShell did not finish changing provider ${provider} in time (${status.state} ${status.reason}).`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Runs a command in the sandbox and collects its output. */
  async run(req: Omit<RunRequest, "onStdout" | "onStderr">): Promise<CapturedRun> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const outcome = await runCommand(this.client, this.name, { ...req, onStdout: (d) => out.push(d), onStderr: (d) => err.push(d) }, this.tracker);
    return { outcome, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
  }
}
