// The execution environment of an OpenShell sandbox. Commands and file operations both go through ExecSandbox, so
// everything the agent's tools do happens under the sandbox's Landlock and seccomp rules, never in the server process.
import type { Context } from "@earendil-works/chord";
import { err, ok, ExecutionError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import type { OpenShellClient } from "./client";
import type { OpenShellControl } from "./control";
import { killCommand, runCommand } from "./exec";
import { SandboxFileSystem } from "./files";

/** Output kept for the check of a failed command, so a signature near the end is still seen in a long log. */
const TAIL_BYTES = 16 * 1024;
const SPILL_FLUSH_BYTES = 256 * 1024;

export class OpenShellEnv extends SandboxFileSystem implements ExecutionEnv {
  constructor(
    client: OpenShellClient,
    private control: OpenShellControl,
    cwd: string,
  ) {
    super(client, control.name, cwd);
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
      return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    }
    const argv = typeof command === "string" ? ["bash", "-c", command] : [...command];
    if (argv.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
    const cwd = options?.cwd ? (options.cwd.startsWith("/") ? options.cwd : `${this.cwd}/${options.cwd}`) : this.cwd;

    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const spill = options?.spill;
    let seenBytes = 0;
    let seenNewlines = 0;
    let spillPath: string | undefined;
    let spilling = false;
    let spillError: Error | undefined;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let chain: Promise<void> = Promise.resolve();
    let tail = Buffer.alloc(0);
    const flush = (): void => {
      if (pendingBytes === 0 || !spillPath) return;
      const data = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      chain = chain.then(async () => {
        const r = await this.appendFile(spillPath!, data, context);
        if (!r.ok) spillError ??= r.error;
      });
    };
    const startSpill = (): void => {
      chain = chain.then(async () => {
        const created = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
        if (!created.ok) throw created.error;
        spillPath = created.value;
        flush();
      }).catch((e) => { spillError ??= e as Error; });
    };
    const feed = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
      const text = decoders[stream].decode(chunk, { stream: true });
      if (text) {
        try { options?.onOutput?.(text, context, { stream }); } catch { /* the caller's callback must not break the stream */ }
      }
      if (!spill) return;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (spilling) {
        if (pendingBytes >= SPILL_FLUSH_BYTES) flush();
        return;
      }
      seenBytes += chunk.length;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) seenNewlines++;
      const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
      if (seenBytes > spill.afterBytes || lines > spill.afterLines) {
        spilling = true;
        startSpill();
      }
    };
    // Lines telepi adds to what the model sees as the command's output.
    const addendum = (line: string): void => {
      try { options?.onOutput?.(`\n${line}\n`, context, { stream: "stderr" }); } catch { /* ignore */ }
    };

    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await runCommand(this.client, this.control.name, {
        argv, cwd, env: options?.env, timeoutMs: options?.timeout !== undefined ? options.timeout * 1000 : undefined, signal: context.abortSignal,
        onStdout: feed("stdout"), onStderr: feed("stderr"),
      }, this.control.tracker);
    } catch (error) {
      return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error), error instanceof Error ? error : undefined));
    }

    if (outcome.kind !== "exit" && outcome.survivors.length > 0) {
      const names = [...new Set(outcome.survivors.map((s) => s.command))].join(", ");
      console.warn(`telepi: ${outcome.survivors.length} process(es) outlived a ${outcome.kind} command in ${this.control.name} (${names}); recycling the sandbox`);
      try {
        const ms = await this.control.recycle();
        addendum(`[telepi] The sandbox was restarted (${(ms / 1000).toFixed(1)} s) because a process started by this command would not stop (${names}). Files in the workspace and /tmp are kept; every running process is gone.`);
      } catch (e) {
        addendum(`[telepi] A process started by this command would not stop (${names}), and restarting the sandbox failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (outcome.kind === "exit" && outcome.code !== 0) {
      const line = await this.control.network?.afterFailure({ startedAt, command: argv.length === 3 && argv[0] === "bash" ? argv[2]! : argv.join(" "), output: tail.toString("utf8"), code: outcome.code }).catch(() => null);
      if (line) addendum(line);
    }

    flush();
    await chain;
    if (spillError) return err(new ExecutionError("unknown", `Failed to preserve complete shell output: ${(spillError as Error).message}`));
    const result = (e: ExecutionError) => { if (spillPath) e.spillPath = spillPath; return err<ShellExecResult, ExecutionError>(e); };
    if (outcome.kind === "timeout") return result(new ExecutionError("timeout", `timeout:${options?.timeout}`));
    if (outcome.kind === "aborted") return result(new ExecutionError("aborted", "aborted"));
    return ok({ exitCode: outcome.code, ...(spillPath ? { spillPath } : {}) });
  }

  async cleanup(_context: Context): Promise<void> {
    // Commands still running when the owner shuts down.
    await Promise.all([...this.control.tracker.active].map((id) => killCommand(this.client, this.control.name, id)));
  }
}
