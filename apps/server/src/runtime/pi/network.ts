// Network access of one task's sandbox, as the user sees it. The supervisor of an OpenShell sandbox denies every
// connection that no rule allows; this module turns that into approval cards and applies the answers.
//
// Two ways a request reaches the user:
//  - Ahead of time: a shell command that plainly targets a host (curl, git clone, npm install, ...) is put to the user
//    before it runs (askAhead). On approval the rule is added to the sandbox policy and the command runs after the
//    sandbox has loaded it, so it works at the first attempt.
//  - After a denial: everything that cannot be seen in advance (a script, a node fetch) is refused by the supervisor.
//    The supervisor's log reports the denial about half a second later; a second source, the gateway's pending
//    "draft chunks" (about eight seconds later), catches what the log stream missed.
// Either way requests that are pending together share one card, a denied host is never asked about again in the task,
// and a denial can be widened to the whole task.
import type { ApprovalPayload, DetailSection, PluginAction } from "@telepi/contract";
import type { RuntimeHost } from "../types";
import type { DraftChunk, SandboxLog } from "./openshell/client";
import type { CommandWatch, OpenShellControl } from "./openshell/control";
import { NETWORK_BINARIES } from "./openshell/control";
import { READ_RULES, describeSend, hostLabel, isWebPort, readId, sendId, sendKey, sendPath } from "./egress";

export const NETWORK_ACTION: PluginAction = { id: "network.allow", plugin: "openshell", label: "Network access", class: "write" };
export const SEND_ACTION: PluginAction = { id: "network.send", plugin: "openshell", label: "Send data", class: "write" };
/** Project-level allow ids for reading from a host look like "network:example.com:443"; for a send see egress.ts. */
export const networkActionId = readId;

const POLL_MS = 2000;
/** Requests that arrive within this time of each other share one card. */
const GROUP_MS = 1200;
/** How long to wait for a denial's report after a command failed like one. */
const REPORT_WAIT_MS = 900;
/** Before a review opens, how long a late report of a denial is waited for. */
export const LATE_REPORT_MS = 12_000;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** A host and port the sandbox tried to reach, or that a command is about to reach. */
export interface Target {
  host: string;
  port: number;
  /** The executable that connected, when the supervisor said so. */
  binary?: string;
  /** The command that will connect, for requests seen ahead of time. */
  command?: string;
  /** Set when the host is already open for reading and the supervisor refused this request, which would send data. */
  send?: { method: string; path: string };
}

const key = (t: Target) => (t.send ? sendKey({ ...t.send, host: t.host, port: t.port }) : `${t.host}:${t.port}`);
const label = (targets: Target[]) => (targets.length === 1 ? targets[0]!.host : `${targets.length} hosts`);

// Failure signatures of a connection that the supervisor refused: curl exit 7 and friends, node/npm EACCES on
// connect, the synthetic address (198.18.x.x) the supervisor hands out for unapproved names.
const SIGNATURES = [
  /Couldn't connect to server/i,
  /curl: \((?:7|35|56|60)\)/,
  /CONNECT tunnel failed/i,
  /\bconnect EACCES\b/,
  /syscall connect[\s\S]{0,80}EACCES|EACCES[\s\S]{0,80}syscall connect/,
  /\b198\.18\.\d{1,3}\.\d{1,3}\b/,
];
/** Words that make a failure worth a short wait for the supervisor's report. */
const NETWORK_HINT = /fetch failed|network|connect|resolve|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timed? ?out|socket|ssl|certificate|unreachable|refused/i;

export interface NetworkDeps {
  host: RuntimeHost;
  taskId: string;
  projectId: string;
  control: OpenShellControl;
  /** "host:port" pairs already open in the sandbox's initial policy. */
  allowedAtStart: string[];
  /** True while the model runs and for a moment after it finished: requests are put to the user. Later ones are refused. */
  accepting(): boolean;
  /** True while the model is running. Only then can it be told anything. */
  running(): boolean;
  stopped(): boolean;
  /** Tells the model something through the steering path. */
  tell(text: string): void;
  /** Adds lines to the review if one is open; false when none is. */
  addReviewNotes(lines: string[]): boolean;
}

export type Ahead = { ok: true } | { ok: false; text: string };

interface Answer {
  approved: boolean;
  note: string | null;
  denyForTask: boolean;
}

export class NetworkGate implements CommandWatch {
  private allowed: Set<string>;
  /** Hosts the user denied, whatever the port. Never asked about again. */
  private denied = new Set<string>();
  /** Sends the user denied (by key). Asking again would not change the answer. */
  private deniedSends = new Set<string>();
  /** What was wanted and denied, for the review. */
  private deniedSendNotes: string[] = [];
  /** When each send was last reported refused. */
  private recentSends = new Map<string, number>();
  /** Executables a host was opened to beyond the usual ones, so a send rule covers them too. */
  private extraBinaries = new Map<string, Set<string>>();
  private denyAll = false;
  /** Hosts refused without asking because of denyAll or a late arrival, for the review. */
  private refusedUnasked = new Set<string>();
  private lateRefused = new Set<string>();
  private lateSeen = new Set<string>();
  /** Hosts the user said no to, for the review. */
  private deniedHosts: string[] = [];
  /** Hosts a card is open for, whatever the port: another port of one of them waits for that answer. */
  private deferred: Target[] = [];

  /** Seen but not yet in a card. */
  private waiting = new Map<string, Target>();
  private groupTimer: ReturnType<typeof setTimeout> | undefined;
  /** Keys that are in a card or being applied. */
  private busy = new Set<string>();
  private inFlight = new Set<Promise<unknown>>();

  /** When each target was last reported as refused. */
  private recent = new Map<string, number>();
  private lastSeenAt = 0;
  private lastSignatureAt = 0;
  private reportWaiters = new Set<() => void>();

  private active = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopLogs: (() => void) | undefined;
  private logRetry: ReturnType<typeof setTimeout> | undefined;
  /** Log stream failures in a row, for the pause before the next try and for warning once per outage. */
  private logFailures = 0;
  private pollFailing = false;
  private seenChunks = new Set<string>();

  constructor(private deps: NetworkDeps) {
    this.allowed = new Set(deps.allowedAtStart);
  }

  // --- watching -------------------------------------------------------------------

  start(): void {
    this.active = true;
    this.followLogs();
    this.schedulePoll();
  }

  private followLogs(): void {
    if (!this.active) return;
    // One stream can report its end more than once (an error, then the close). Only the first report counts, and only
    // one reconnect is ever pending: anything else multiplies the streams while the gateway is away.
    let ended = false;
    this.stopLogs = this.deps.control.watchLogs(
      (log) => {
        this.logFailures = 0;
        this.onLog(log);
      },
      (error) => {
        if (ended || !this.active) return;
        ended = true;
        if (error && this.logFailures === 0) console.warn(`telepi: the log stream of ${this.deps.control.name} ended (${error.message}); chunks still work, reconnecting`);
        this.logFailures = error ? this.logFailures + 1 : 0;
        clearTimeout(this.logRetry);
        this.logRetry = setTimeout(() => this.followLogs(), Math.min(30_000, 2000 * 2 ** Math.min(Math.max(this.logFailures - 1, 0), 4)));
        this.logRetry.unref();
      },
    );
  }

  private onLog(log: SandboxLog): void {
    // e.g. "NET:OPEN [MED] DENIED /usr/bin/curl(0) -> example.org:80 [reason:transparent_tcp_policy_denied]"
    // A refused request on a host that is open for reading, e.g.
    // "HTTP:POST [MED] DENIED POST http://github.com:443/o/r.git/git-receive-pack [policy:tp_github_com_443 engine:l7] [reason:...]"
    // (the port is left out for 80).
    const h = /^HTTP:\w+ \[\w+\] DENIED (\w+) https?:\/\/([^\s/:]+)(?::(\d+))?(\/\S*)? \[policy:[^\]]*engine:l7\]/.exec(log.message);
    if (h) {
      this.observe({ host: h[2]!.toLowerCase(), port: Number(h[3] ?? 80), send: { method: h[1]!.toUpperCase(), path: sendPath(h[4] ?? "/") } });
      return;
    }
    const m = /DENIED (\S+?)\(\d+\) -> ([^\s:]+):(\d+) \[reason:(\w+)\]/.exec(log.message);
    if (!m || m[4] === "transparent_tcp_mapping_denied" || /^198\.18\./.test(m[2]!)) return;
    this.observe({ host: m[2]!.toLowerCase(), port: Number(m[3]), binary: m[1] });
  }

  private schedulePoll(): void {
    if (!this.active) return;
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    try {
      const chunks = await this.deps.control.pendingChunks();
      this.pollFailing = false;
      if (!this.active) return;
      for (const chunk of chunks) {
        if (this.seenChunks.has(chunk.id)) continue;
        this.seenChunks.add(chunk.id);
        this.fromChunk(chunk);
      }
    } catch (e) {
      // Said once per outage, not once per poll.
      if (this.active && !this.pollFailing) console.warn(`telepi: could not read pending network requests for task ${this.deps.taskId}:`, e instanceof Error ? e.message : e);
      this.pollFailing = true;
    }
    this.schedulePoll();
  }

  /** A pending chunk is only a second report of a denial. It is never approved: telepi adds the rule itself. */
  private fromChunk(chunk: DraftChunk): void {
    const reject = (reason: string) => void this.deps.control.rejectChunk(chunk, reason).catch(() => {});
    const targets = chunk.endpoints.map((e) => ({ host: e.host.toLowerCase(), port: e.port, binary: chunk.binary }));
    if (targets.length === 0) return reject("No endpoint.");
    for (const t of targets) this.observe(t);
    // The question is asked (or answered) through observe; the chunk itself is not needed any more.
    reject("Decided in telepi.");
  }

  /** Something tried to reach a target and was refused. */
  private observe(t: Target): void {
    this.lastSeenAt = Date.now();
    this.recent.set(key(t), this.lastSeenAt);
    for (const wake of this.reportWaiters) wake();
    const k = key(t);
    if (t.send) this.recentSends.set(k, this.lastSeenAt);
    if (this.allowed.has(k) || this.busy.has(k) || this.waiting.has(k)) return;
    if (t.send ? this.deniedSends.has(k) || this.denyAll : this.denied.has(t.host) || this.denyAll) {
      if (this.denyAll && !this.denied.has(t.host)) this.refusedUnasked.add(t.host);
      return;
    }
    if (!this.deps.accepting()) {
      const what = t.send ? `sending data to ${hostLabel(t.host, t.port)}` : t.host;
      if (!this.lateSeen.has(what)) {
        this.lateSeen.add(what);
        this.lateRefused.add(what);
        this.noteLate(what);
      }
      return;
    }
    // Another port of a host whose card is open: it waits for that answer (a denial covers it, an approval does not).
    if (!t.send && [...this.busy].some((b) => b.slice(0, b.lastIndexOf(":")) === t.host)) {
      if (!this.deferred.some((d) => key(d) === k)) this.deferred.push(t);
      return;
    }
    this.waiting.set(k, t);
    this.groupTimer ??= setTimeout(() => this.flushWaiting(), GROUP_MS);
  }

  private flushWaiting(): void {
    clearTimeout(this.groupTimer);
    this.groupTimer = undefined;
    const targets = [...this.waiting.values()];
    this.waiting.clear();
    if (targets.length === 0) return;
    // Reads share a card; every send gets its own, because the card is about one request.
    const groups = [targets.filter((t) => !t.send), ...targets.filter((t) => t.send).map((t) => [t])].filter((g) => g.length > 0);
    for (const group of groups) {
      this.track(this.request(group, "after").catch((e) => console.warn(`telepi: network approval failed for task ${this.deps.taskId}:`, e instanceof Error ? e.message : e)));
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p)).catch(() => {});
    return p;
  }

  // --- what the session asks -------------------------------------------------------

  /** Puts a command's obvious destinations to the user before it runs. */
  async askAhead(targets: Target[]): Promise<Ahead> {
    const fresh = dedupe(targets).filter((t) => !this.allowed.has(key(t)));
    if (fresh.length === 0) return { ok: true };
    const refused = fresh.filter((t) => this.denied.has(t.host));
    if (this.denyAll || refused.length > 0) {
      for (const t of fresh) if (this.denyAll && !this.denied.has(t.host)) this.refusedUnasked.add(t.host);
      return { ok: false, text: this.denyAll ? DENY_ALL_TEXT : `The user already denied network access to ${[...new Set(refused.map((t) => t.host))].join(", ")}. ${NO_WORKAROUND}` };
    }
    for (const t of fresh) {
      this.busy.add(key(t));
      this.waiting.delete(key(t));
    }
    try {
      const answer = await this.track(this.ask(fresh, "ahead"));
      if (answer === null) return { ok: false, text: "The task was stopped." };
      if (!answer.approved) return { ok: false, text: this.denialText(fresh, answer) };
      await this.apply(fresh);
      return { ok: true };
    } catch (e) {
      return { ok: false, text: `Network access to ${label(fresh)} was approved, but the sandbox could not open it: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      for (const t of fresh) this.busy.delete(key(t));
      this.replayDeferred();
    }
  }

  /** CommandWatch: a command of the model failed. If it was a denial, say so in its output. */
  async afterFailure(info: { startedAt: number; command: string; output: string; code?: number }): Promise<string | null> {
    const sends = [...this.recentSends.entries()].filter(([, at]) => at >= info.startedAt).map(([k]) => k);
    if (sends.length > 0 || /"error":\s*"policy_denied"|returned error: 403/.test(info.output)) {
      await this.reported(info.startedAt);
      this.lastSignatureAt = Date.now();
      if (this.denyAll) return `[telepi] ${DENY_ALL_TEXT}`;
      const now = [...this.recentSends.entries()].filter(([, at]) => at >= info.startedAt).map(([k]) => k);
      if (now.length === 0) return null;
      const refused = now.filter((k) => this.deniedSends.has(k));
      if (refused.length > 0) return `[telepi] The user already denied this request (${refused.join(", ")}). ${NO_WORKAROUND}`;
      return `[telepi] The request was blocked: you may read from this site but sending data to it needs the user's approval (${now.join(", ")}). The user has been asked. ${NO_WORKAROUND} Wait for their answer.`;
    }
    const signature = SIGNATURES.some((re) => re.test(info.output)) || (info.code === 4 && /\bwget\b/.test(info.command));
    if (!signature && !(NETWORK_HINT.test(info.output) && (await this.reported(info.startedAt)))) return null;
    this.lastSignatureAt = Date.now();
    // The supervisor's report arrives about half a second after the connection; the line can then name the host.
    await this.reported(info.startedAt);
    if (this.denyAll) return `[telepi] ${DENY_ALL_TEXT}`;
    const hosts = [...new Set([...this.waiting.values(), ...this.recentTargets(info.startedAt)].map((t) => t.host))];
    const known = hosts.filter((h) => this.denied.has(h));
    if (known.length > 0) return `[telepi] The user already denied network access to ${known.join(", ")}. ${NO_WORKAROUND}`;
    return `[telepi] Network access is closed by policy${hosts.length ? ` for ${hosts.join(", ")}` : ""}. The user has been asked. ${NO_WORKAROUND} Wait for their answer.`;
  }

  private recentTargets(since: number): Target[] {
    return [...this.recent.entries()].filter(([, at]) => at >= since).map(([k]) => {
      const i = k.lastIndexOf(":");
      return { host: k.slice(0, i), port: Number(k.slice(i + 1)) };
    });
  }

  /** Resolves true when a denial was reported since `since`, waiting a moment for it. */
  private reported(since: number): Promise<boolean> {
    if (this.lastSeenAt >= since) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => { clearTimeout(timer); this.reportWaiters.delete(wake); resolve(v); };
      const wake = () => { if (this.lastSeenAt >= since) setTimeout(() => done(true), 150); };
      const timer = setTimeout(() => done(this.lastSeenAt >= since), REPORT_WAIT_MS);
      this.reportWaiters.add(wake);
    });
  }

  /**
   * Called when the model's run has ended, before the review opens: waits for the report of a denial that a command
   * showed shortly before (bounded), then for every card to be answered.
   */
  async settle(): Promise<void> {
    const deadline = this.lastSignatureAt + LATE_REPORT_MS;
    while (this.lastSignatureAt > 0 && this.lastSeenAt < this.lastSignatureAt - 3000 && Date.now() < deadline && this.active) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.waiting.size > 0) this.flushWaiting();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** The lines for the review, once: what the user denied, what was refused, what came too late. */
  takeNotes(): string[] {
    const lines: string[] = [];
    if (this.denyAll) {
      const asked = this.deniedHosts.length ? ` Asked about: ${this.deniedHosts.join(", ")}.` : "";
      const refused = this.refusedUnasked.size ? ` Refused without asking: ${[...this.refusedUnasked].join(", ")}.` : "";
      lines.push(`You denied all network access for this task.${asked}${refused}`);
    } else if (this.deniedHosts.length) {
      lines.push(`Wanted network access to ${this.deniedHosts.join(", ")}; you denied it, so it stayed blocked.`);
    }
    this.deniedHosts = [];
    this.refusedUnasked.clear();
    lines.push(...this.deniedSendNotes);
    this.deniedSendNotes = [];
    for (const h of this.lateRefused) lines.push(`A request to ${h} came after the work had ended; it was refused.`);
    this.lateRefused.clear();
    return lines;
  }

  private noteLate(host: string): void {
    // The review may already be open: put the line there, else it waits for the next review.
    if (this.deps.addReviewNotes([`A request to ${host} came after the work had ended; it was refused.`])) this.lateRefused.delete(host);
  }

  /** Stops watching without touching the gateway (the sandbox is about to be destroyed anyway). */
  halt(): void {
    this.active = false;
    clearTimeout(this.pollTimer);
    clearTimeout(this.groupTimer);
    clearTimeout(this.logRetry);
    this.stopLogs?.();
  }

  /** Stops watching and rejects whatever is still pending, so nothing is left to be approved later. */
  async stop(): Promise<void> {
    this.halt();
    const chunks = await this.deps.control.pendingChunks().catch(() => [] as DraftChunk[]);
    await Promise.all(chunks.map((c) => this.deps.control.rejectChunk(c, "The task ended.").catch(() => {})));
  }

  // --- cards ------------------------------------------------------------------------

  /** A request seen after a denial: ask, then act, then tell the model. */
  private async request(targets: Target[], mode: "after"): Promise<void> {
    for (const t of targets) this.busy.add(key(t));
    try {
      const answer = await this.ask(targets, mode);
      if (answer === null) return;
      const hosts = targets.map(key).join(", ");
      if (answer.approved) {
        try {
          await this.apply(targets);
          if (this.deps.running()) this.deps.tell(targets[0]!.send ? `[telepi] The user allowed ${hosts}, and it is open now. Retry the request.` : `[telepi] The user approved network access to ${hosts}, and it is open now. Retry the request.`);
        } catch (e) {
          if (this.deps.running()) this.deps.tell(`[telepi] The user approved network access to ${hosts}, but the sandbox could not open it: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (this.deps.running()) {
        this.deps.tell(`[telepi] ${this.denialText(targets, answer)}`);
      }
    } finally {
      for (const t of targets) this.busy.delete(key(t));
      this.replayDeferred();
    }
  }

  /** Targets that waited for a card to be answered are looked at again: dropped if denied, asked if still closed. */
  private replayDeferred(): void {
    const again = this.deferred;
    this.deferred = [];
    for (const t of again) this.observe(t);
  }

  /** Opens the card and records the answer. Null when the task was stopped. */
  private async ask(targets: Target[], mode: "ahead" | "after"): Promise<Answer | null> {
    const { host, taskId, projectId } = this.deps;
    const single = targets.length === 1 ? targets[0]! : undefined;
    const permanent = host.getProject(projectId) !== undefined && single !== undefined;
    const sendTarget = single?.send ? { host: single.host, port: single.port, ...single.send } : undefined;
    const action: PluginAction = sendTarget
      ? permanent ? { ...SEND_ACTION, id: sendId(sendTarget) } : SEND_ACTION
      : permanent ? { ...NETWORK_ACTION, id: networkActionId(single!.host, single!.port) } : NETWORK_ACTION;
    const sections: DetailSection[] = targets.map((t) => ({
      title: sendTarget ? hostLabel(t.host, t.port) : key(t),
      format: "text",
      text: sendTarget
        ? `The agent wants to ${describeSend(sendTarget)}.\n\n${sendTarget.method} ${sendTarget.path}`
        : (isWebPort(t.port) ? "" : "This is not a web connection, so what goes through it cannot be checked. Anything can be sent to it.\n\n") +
          (mode === "ahead"
            ? `The command will connect to ${key(t)}.${t.command ? `\n\n${clip(t.command, 400)}` : ""}`
            : `${t.binary ? `${t.binary} tried` : "A program tried"} to connect to ${key(t)} and the sandbox refused it.`),
      collapsed: false,
    }));
    const allWeb = targets.every((t) => isWebPort(t.port));
    const payload: ApprovalPayload = {
      kind: "approval",
      title: sendTarget
        ? `Allow sending data to ${hostLabel(sendTarget.host, sendTarget.port)}`
        : single ? (allWeb ? `Allow reading from ${single.host}` : `Allow a direct connection to ${key(single)}`) : `Allow network access to ${targets.length} hosts`,
      action,
      target: sendTarget ? `${sendTarget.method} ${hostLabel(sendTarget.host, sendTarget.port)}${sendTarget.path}` : targets.map(key).join(", "),
      detail: { format: "text", text: sections.map((s) => `${s.title}\n${s.text}`).join("\n\n"), sections },
      reason: sendTarget
        ? { code: "send_data", text: `You allowed the agent to read from ${hostLabel(sendTarget.host, sendTarget.port)}. Sending data to it needs a separate yes.` }
        : { code: "first_time", text: allWeb ? "Approving a site lets the agent read from it. Sending data to it asks again." : "Nothing is allowed on the network until you say so. A direct connection is open both ways: it cannot be limited to reading." },
      ...(sendTarget ? { send: { host: hostLabel(sendTarget.host, sendTarget.port), method: sendTarget.method, path: sendTarget.path } } : {}),
      canAllowPermanently: permanent,
      canDenyForTask: true,
    };
    const answer = await host.ask(taskId, payload);
    if (answer === null || answer.kind !== "approval" || this.deps.stopped()) return null;
    host.recordDecision({
      at: Date.now(), taskId, projectId,
      call: { kind: "action", text: payload.detail.text, actionId: action.id },
      outcome: "ask", stage: "openshell", reasonCode: "first_time", userDecision: answer.decision,
    });
    const approved = answer.decision === "approve";
    const note = answer.note?.trim() || null;
    const denyForTask = !approved && answer.denyForTask === true;
    if (!approved && sendTarget) {
      this.deniedSends.add(key(single!));
      this.deniedSendNotes.push(`Wanted to ${describeSend(sendTarget)} (${sendTarget.method} ${sendTarget.path}); you denied it, so it stayed blocked.`);
      if (denyForTask) this.denyAll = true;
    } else if (!approved) {
      for (const t of targets) this.denied.add(t.host);
      for (const h of new Set(targets.map((t) => t.host))) if (!this.deniedHosts.includes(h)) this.deniedHosts.push(h);
      if (denyForTask) this.denyAll = true;
    }
    return { approved, note, denyForTask };
  }

  /** Opens the targets in the sandbox and waits until the sandbox has loaded the rules. */
  private async apply(targets: Target[]): Promise<void> {
    // Rules for one host and port merge in the sandbox (verified), so reads and later sends add up on one endpoint.
    const rules = targets.map((t) => {
      const hp = `${t.host}:${t.port}`;
      if (t.binary && !t.send) this.extraBinaries.set(hp, new Set([...(this.extraBinaries.get(hp) ?? []), t.binary]));
      return {
        name: `tp_${t.host.replace(/[^a-z0-9]+/g, "_")}_${t.port}`.slice(0, 60),
        endpoints: [{ host: t.host, port: t.port, ...(isWebPort(t.port) ? { http: t.send ? [{ method: t.send.method, path: t.send.path }] : READ_RULES } : {}) }],
        binaries: [...new Set([...NETWORK_BINARIES, ...(this.extraBinaries.get(hp) ?? [])])],
      };
    });
    await this.deps.control.allow(rules);
    for (const t of targets) this.allowed.add(key(t));
  }

  private denialText(targets: Target[], answer: Answer): string {
    const hosts = [...new Set(targets.map((t) => t.host))].join(", ");
    if (answer.denyForTask) return DENY_ALL_TEXT;
    if (targets[0]?.send) return `The user denied sending data to ${hosts} (${targets[0].send.method} ${targets[0].send.path}).${answer.note ? ` Their note: ${clip(answer.note, 300)}` : ""} Reading from it still works. ${NO_WORKAROUND}`;
    return `The user denied network access to ${hosts}.${answer.note ? ` Their note: ${clip(answer.note, 300)}` : ""} ${NO_WORKAROUND}`;
  }
}

const NO_WORKAROUND = "Do not try other hosts or other tools to get around it.";
const DENY_ALL_TEXT = "The user denied all network access for this task. Do not try to reach any host, with any tool.";

function dedupe(targets: Target[]): Target[] {
  const seen = new Map<string, Target>();
  for (const t of targets) seen.set(key(t), seen.get(key(t)) ?? t);
  return [...seen.values()];
}
