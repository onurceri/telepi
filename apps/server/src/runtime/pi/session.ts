// One telepi task on Pi Durable: workspace, sandbox, conversation, the run loop and the review.
import path from "node:path";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { watchEvents, type AgentEventStream, type Conversation, type ConversationId, type HookApi, type Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createPipeline, patternJudge, type ToolCall as PipelineCall } from "@telepi/decision";
import type { ApprovalPayload, DetailSection, PluginAction, ReviewPayload, Task } from "@telepi/contract";
import type { KeptReview, RuntimeHost } from "../types";
import { EventForwarder } from "./events";
import type { ToolSession } from "./extension";
import { changedFiles, isSha, localOriginPath, prepareWorkspace, sandboxGit, type GitRunner } from "./git";
import { MAX_SCRIPT_BYTES, networkDestinations, reachesGitRemote, shellCall } from "./guard";
import { githubRepoOf, openPullRequest, prDetail, publishingOf, pushBranch, pushDetail, type Progress } from "./github";
import { readGrants, sendGrants, sendKey } from "./egress";
import { NetworkGate } from "./network";
import { DEFAULT_MAX_TURNS, OPEN_PR_ACTION, PUSH_ACTION, SHELL_ACTION, type PiOptions } from "./options";
import type { TaskSandbox } from "./sandbox";
import type { MetaStore, TaskMeta } from "./store";

class SetupError extends Error {}

const pipeline = createPipeline({ judges: [patternJudge] });

/** What the core gives a session. */
export interface SessionCore {
  options: PiOptions;
  host: RuntimeHost;
  store: MetaStore;
  harness(): Promise<Harness>;
  closing(): boolean;
}

type Authorization = { kind: "run" } | { kind: "denied"; note: string | null } | { kind: "blocked"; text: string } | { kind: "stopped" };

interface ApprovalUi {
  title: string;
  target: string | null;
  format: ApprovalPayload["detail"]["format"];
  detail: string;
  /** The detail in parts, the part that matters first. */
  sections?: DetailSection[];
  insidePolicy?: boolean;
  reachesCredentialed?: boolean;
}

/** The model provider's common refusals, said so that the person knows what to do. Null for anything else. */
function modelErrorInWords(detail: string): string | null {
  const status = detail.match(/\b(401|402|403|429)\b/)?.[1];
  if (status === "401" || status === "403") return "The model provider rejected the login, so I could not start. Log in again with `pi` (/login) on the home machine and start the task again.";
  if (status === "402") return "The model provider account is out of credit, so I had to stop. Add credit and start the task again. This is what exists on the branch.";
  if (status === "429") return "The model provider is limiting requests right now, so I had to stop. Try again in a little while. This is what exists on the branch.";
  return null;
}

/** How a submission ended, as Pi Durable reports it. */
type Settled = Awaited<ReturnType<Awaited<ReturnType<Conversation["submit"]>>["wait"]>>;

/** A pull request title from the task: the instruction's first line, cut at a word, without the ellipsis a clipped title carries. */
function prTitle(task: Task): string {
  const line = (task.instruction.split("\n")[0] ?? task.title).trim().replace(/\s+/g, " ");
  if (line.length <= 72) return line.replace(/[.\s]+$/, "") || task.title;
  return line.slice(0, 72).replace(/\s+\S*$/, "");
}

/** How long the review waits for a message that reached the model as its run was ending. */
const STEER_WAIT_MS = 10 * 60_000;

type RunOutcome = { kind: "done"; text: string } | { kind: "failed"; text: string } | { kind: "stopped" };

const clip = (text: string, max: number) => {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40))}…`;
};

export class TaskSession implements ToolSession {
  /** Set as soon as the conversation is known; lets the harness's tools and hooks find this session. */
  conversationId: number | null = null;
  readonly ready: Promise<TaskSandbox>;
  private resolveReady!: (s: TaskSandbox) => void;
  private rejectReady!: (e: unknown) => void;

  private stopped = false;
  private conversation: Conversation | undefined;
  private sandbox: TaskSandbox | undefined;
  private network: NetworkGate | undefined;
  private stream: AgentEventStream | undefined;
  private forwarder: EventForwarder;
  /** "settle": the model has finished and a denial it ran into just before may still be reported and put to the user. */
  private phase: "setup" | "run" | "settle" | "review" = "setup";
  private reviewOpen = false;
  private stash: string[] = [];
  /** Messages handed to the model during a run that it has not finished with. */
  private steers = new Set<Promise<Settled | undefined>>();
  private turns = 0;
  private capped = false;
  private failure: string | null = null;
  private say_ = 0;
  /** The context window of the model this task runs on, once known. */
  private contextWindow: number | null = null;

  constructor(private core: SessionCore, private task: Task) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.forwarder = new EventForwarder({
      host: core.host,
      taskId: task.id,
      live: () => !this.stopped && !core.closing(),
      stepOpened: (id) => this.mutateSteps((s) => (s.includes(id) ? s : [...s, id])),
      stepClosed: (id) => this.mutateSteps((s) => s.filter((x) => x !== id)),
      onTurnEnd: () => this.turnEnded(),
      usageBase: task.usage ?? null,
      contextWindow: () => this.contextWindow,
    });
  }

  get taskId(): string {
    return this.task.id;
  }

  private get host(): RuntimeHost {
    return this.core.host;
  }

  private get meta(): TaskMeta {
    const meta = this.core.store.get(this.task.id);
    if (!meta) throw new Error("task has no workspace");
    return meta;
  }

  private mutateSteps(fn: (s: string[]) => string[]): void {
    const meta = this.core.store.get(this.task.id);
    if (meta) this.core.store.update(this.task.id, { openSteps: fn(meta.openSteps) });
  }

  /** The execution environment of this task's conversation. Waits for the sandbox. */
  async env(): Promise<ExecutionEnv | undefined> {
    if (this.stopped) return undefined;
    return (await this.ready).env;
  }

  // --- lifecycle -----------------------------------------------------------

  /** Registers an existing conversation (restart) before anything can call into it. */
  adopt(): void {
    this.conversationId = this.core.store.get(this.task.id)?.conversationId ?? null;
  }

  async begin(resumed: boolean, kept?: KeptReview): Promise<void> {
    try {
      let resumeNote: string | null = null;
      // First, so that clearing containers a dead process left behind cannot touch this task's new one.
      await this.core.harness();
      if (!resumed) {
        await this.setup();
      } else if (!this.core.store.get(this.task.id)) {
        return await this.giveUp("I could not pick this task back up after the restart: its workspace was never set up.");
      } else {
        const stored = this.meta;
        if (stored.model) this.contextWindow = this.core.options.catalog.contextWindowOf(stored.model);
        // Nothing is picked back up when the last round had already finished: only its review is shown again.
        resumeNote = await this.reopen(kept !== undefined || (stored.round > 0 && stored.pendingInput === null));
      }
      const meta = this.meta;
      const harness = await this.core.harness();
      this.conversation = await harness.conversation(meta.conversationId as unknown as ConversationId, CTX);
      if (!this.conversation) {
        this.rejectReady(new Error("no conversation"));
        return await this.endWithReview("I could not pick this task back up after the restart: its conversation is gone. This is what exists on the branch.", kept);
      }
      this.stream = await watchEvents(harness, this.conversation.id, CTX);
      this.forwarder.usage = this.stream.snapshot.usage;
      this.stream.start(async (events) => this.forwarder.handle(events));
      void this.stream.closed.catch(() => {});

      if (resumed) await this.recountUsage(this.conversation);
      if (resumeNote) await this.say(resumeNote);
      harness.resume();
      if (resumed && meta.round > 0 && meta.pendingInput === null) {
        // The last round had finished before the restart. Its review either stayed open (kept) or is shown again.
        this.phase = "review";
        const lost = "The server restarted while the work was being reviewed. This is what exists on the branch.";
        if (!kept) await this.say(meta.outcome ? "The server restarted while you were reviewing this. Here is the result again." : lost);
        const next = await this.review(kept ? { kind: kept.payload.outcome, text: kept.payload.summary } : (meta.outcome ?? { kind: "failed", text: lost }), kept?.requestId);
        if (next !== null) await this.loop(next);
        return;
      }
      await this.loop(resumed && meta.round > 0 ? meta.pendingInput : this.task.instruction);
    } catch (error) {
      if (this.stopped || this.core.closing()) return;
      console.error(`telepi: task ${this.task.id} failed:`, error);
      await this.giveUp(error instanceof SetupError ? error.message : `Something went wrong on my side: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.core.closing()) await this.dispose();
    }
  }

  /** New task: clone, branch, conversation, sandbox. */
  private async setup(): Promise<void> {
    const { options, store } = this.core;
    const task = this.task;
    const repoPath = options.repoPath(task.projectId);
    if (!repoPath) {
      this.rejectReady(new Error("no repository"));
      throw new SetupError("This project has no repository configured, so I have nowhere to work. Add a repoPath for it in the server's projects.json.");
    }
    // Before anything is made: without a model there is no task.
    const pick = await options.catalog.pick();
    if ("problem" in pick) {
      this.rejectReady(new Error("no model"));
      throw new SetupError(pick.problem);
    }
    const model = { provider: pick.model.provider, id: pick.model.id };
    this.contextWindow = pick.model.contextWindow ?? null;
    this.host.patchTask(task.id, { state: "running", currentStep: "Preparing a workspace" });
    const ws = await prepareWorkspace({ repoPath, dir: path.join(options.workspacesDir, task.id), taskId: task.id, title: task.title });
    this.host.patchTask(task.id, { branch: ws.branch });

    const harness = await this.core.harness();
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: pick.thinkingLevel,
          cwd: ws.dir,
          instructions: `Your branch is ${ws.branch}, started from commit ${ws.base.slice(0, 10)}. The repository is the current directory.`,
        },
      },
      CTX,
    );
    this.conversationId = Number(conversation.id);
    store.set(task.id, { conversationId: this.conversationId, workspace: ws.dir, branch: ws.branch, base: ws.base, defaultBranch: ws.defaultBranch, model, originUrl: ws.originUrl, round: 0, pendingInput: null, openSteps: [] });
    await this.startSandbox();
    this.host.patchTask(task.id, { currentStep: "Starting" });
  }

  /** Restart: close what the dead process left open, bring the sandbox back. Returns a line to say, if any. */
  private async reopen(quiet = false): Promise<string | null> {
    const meta = this.meta;
    this.forwarder.ignore(meta.openSteps);
    for (const id of meta.openSteps) this.host.emit(this.task.id, { type: "step_finished", stepId: id, ok: false, detail: "Interrupted by the restart" });
    this.core.store.update(this.task.id, { openSteps: [] });
    if (!quiet) this.host.patchTask(this.task.id, { currentStep: "Picking the work back up" });
    try {
      await this.startSandbox();
    } catch (error) {
      this.rejectReady(error);
      throw error;
    }
    return quiet ? null : "The server restarted. I am picking the work back up from where it stopped.";
  }

  private async startSandbox(): Promise<void> {
    const { options } = this.core;
    const meta = this.meta;
    const origin = localOriginPath(meta.originUrl);
    try {
      if (origin && options.remotesDir && origin !== options.remotesDir && !origin.startsWith(options.remotesDir + path.sep)) {
        throw new SetupError(`This project's origin (${origin}) is outside TELEPI_REMOTES (${options.remotesDir}), so the sandbox could not push to it. Point TELEPI_REMOTES (and the gateway's mount) at it.`);
      }
      const project = this.host.getProject(this.task.projectId);
      this.sandbox = await options.backend.start({
        taskId: this.task.id,
        projectId: this.task.projectId,
        workspace: meta.workspace,
        extraMounts: origin ? [origin] : [],
        allowedHosts: readGrants(project?.allowedActions ?? []),
        allowedSends: sendGrants(project?.allowedActions ?? []),
      });
      this.resolveReady(this.sandbox);
      const control = this.sandbox.openshell;
      await control.markBaseline().catch((e: Error) => console.warn(`telepi: could not list the processes of ${control.name}:`, e.message));
      this.network = new NetworkGate({
        host: this.host, taskId: this.task.id, projectId: this.task.projectId, control,
        allowedAtStart: [...readGrants(project?.allowedActions ?? []), ...sendGrants(project?.allowedActions ?? []).map(sendKey)],
        accepting: () => (this.phase === "run" || this.phase === "settle") && !this.stopped && !this.core.closing(),
        running: () => this.phase === "run" && !this.stopped && !this.core.closing(),
        stopped: () => this.stopped,
        tell: (text) => this.tell(text),
        addReviewNotes: (lines) => this.reviewOpen && this.host.addReviewNotes(this.task.id, lines),
      });
      control.network = this.network;
      this.network.start();
    } catch (error) {
      this.rejectReady(error);
      throw error;
    }
  }

  private async dispose(): Promise<void> {
    this.phase = "setup";
    await this.stream?.stop().catch(() => {});
    await this.network?.stop().catch(() => {});
    this.network = undefined;
    await this.sandbox?.remove().catch(() => {});
  }

  /** Shutdown: remove the container; the task stays running in telepi's state and resumes on the next start. */
  async shutdown(): Promise<void> {
    this.network?.halt();
    await this.sandbox?.remove().catch(() => {});
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.forwarder.closeOpen("Stopped");
    void (async () => {
      await this.conversation?.abort(CTX).catch(() => {});
      await this.dispose();
    })();
  }

  // --- messages ------------------------------------------------------------

  message(text: string): void {
    if (this.stopped || !this.conversation) return;
    if (this.phase === "run") {
      this.steer(text, "deliver a message");
    } else {
      this.stash.push(text);
    }
  }

  /** Tells the model something while it runs, the way a steering message does. Not stashed: if no run is on, it is dropped. */
  private tell(text: string): void {
    if (this.stopped || !this.conversation || this.phase !== "run") return;
    this.steer(text, "tell the model");
  }

  /**
   * Hands the model a message while it runs and remembers it until the model is done with it. One that lands as the run
   * is ending gets a turn of its own afterwards; the review must not open before that turn is over.
   */
  private steer(text: string, what: string): void {
    const conversation = this.conversation;
    if (!conversation) return;
    const settled: Promise<Settled | undefined> = conversation
      .submit({ type: "input", content: text, whenBusy: "steer" }, CTX)
      .then((submission) => submission.wait(CTX))
      .catch((e) => {
        if (!this.stopped && !this.core.closing()) console.warn(`telepi: could not ${what}:`, e);
        return undefined;
      });
    this.steers.add(settled);
    void settled.finally(() => this.steers.delete(settled));
  }

  // --- the run loop --------------------------------------------------------

  private async loop(first: string | null): Promise<void> {
    const conversation = this.conversation!;
    let input = first;
    while (input !== null && !this.stopped) {
      const meta = this.meta;
      // A resumed round has its input stored and its submission already admitted (same request id).
      const resumedRound = input === meta.pendingInput && meta.round > 0;
      const round = resumedRound ? meta.round : meta.round + 1;
      if (!resumedRound) this.core.store.update(this.task.id, { round, pendingInput: input });

      await this.credentialsGone();
      const outcome = await this.runOnce(conversation, input, `${this.task.id}:${round}`);
      if (outcome.kind === "stopped") return;
      this.core.store.update(this.task.id, { pendingInput: null, outcome });
      input = await this.review(outcome);
    }
  }

  /**
   * The agent only runs when no provider credential is attached. A publish from the review detaches in the background,
   * so every start of the agent comes through here first.
   */
  private async credentialsGone(): Promise<void> {
    const control = this.sandbox?.openshell;
    if (!control) return;
    if (control.detachPending) this.host.patchTask(this.task.id, { currentStep: "Disconnecting from GitHub" });
    try {
      await control.providersDetached();
    } catch (error) {
      console.error(`telepi: task ${this.task.id}:`, error instanceof Error ? error.message : error);
      throw new SetupError("I stopped here: the sandbox could not be cut off from GitHub again after the publish, so I did not let the agent run. The branch is as it was.");
    }
  }

  private async runOnce(conversation: Conversation, input: string, requestId: string): Promise<RunOutcome> {
    this.phase = "run";
    this.turns = 0;
    this.capped = false;
    this.failure = null;
    this.host.patchTask(this.task.id, { state: "running" });
    const submission = await conversation.submit({ type: "input", content: input, requestId }, CTX);
    let settled: Settled = await submission.wait(CTX);
    // Messages still with the model: each one ends its own turn, and the last of them is how the run ended.
    while (this.steers.size > 0 && !this.stopped && !this.core.closing()) {
      const late = await Promise.race([Promise.all([...this.steers]), new Promise<null>((r) => setTimeout(() => r(null), STEER_WAIT_MS).unref())]);
      if (late === null) {
        console.warn(`telepi: task ${this.task.id} still had a message with the model after ${STEER_WAIT_MS / 60_000} minutes; opening the review anyway`);
        break;
      }
      settled = late.filter((s): s is Settled => s !== undefined).pop() ?? settled;
    }
    if (this.stopped || this.core.closing()) return { kind: "stopped" };
    this.phase = "settle";
    await this.network?.settle(); // a denial reported late is handled, and network cards still open are answered, before the review opens
    this.phase = "review";
    if (this.stopped || this.core.closing()) return { kind: "stopped" };
    this.logUsage();

    if (settled.status === "done" && settled.type === "input") {
      const text = await this.answerText(conversation, settled.answer as unknown as number);
      if (this.failure) return { kind: "failed", text: text || this.failure };
      return { kind: "done", text };
    }
    if (this.capped) return { kind: "failed", text: `I reached the limit of ${this.core.options.maxTurns ?? DEFAULT_MAX_TURNS} model turns and stopped. This is what exists on the branch.` };
    const detail = settled.status === "unanswered" && typeof settled.detail === "string" ? ` (${settled.detail})` : "";
    const plain = settled.status === "unanswered" && settled.reason === "model_error" ? modelErrorInWords(detail) : null;
    if (plain) return { kind: "failed", text: plain };
    return { kind: "failed", text: `The run ended early: ${settled.status === "unanswered" ? settled.reason : "unknown"}${detail}. This is what exists on the branch.` };
  }

  private async answerText(conversation: Conversation, entryId: number): Promise<string> {
    const page = await conversation.entries({}, 12, undefined, CTX);
    const entry = page.items.find((e) => Number(e.id) === entryId);
    const message = entry?.model?.[0] as { content?: unknown } | undefined;
    const content = message?.content;
    return Array.isArray(content) ? content.map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("").trim() : "";
  }

  /** After a restart: turns and times are read back from the conversation's record rather than trusted from memory. */
  private async recountUsage(conversation: Conversation): Promise<void> {
    try {
      const messages: { role?: string; durationMs?: number }[] = [];
      let cursor: Parameters<Conversation["entries"]>[2];
      do {
        const page = await conversation.entries({ order: "ascending" }, 200, cursor, CTX);
        for (const entry of page.items) messages.push(...((entry.model ?? []) as readonly { role?: string; durationMs?: number }[]));
        cursor = page.next;
      } while (cursor !== undefined);
      this.forwarder.recount(messages);
      this.publishUsage();
    } catch (error) {
      console.warn(`telepi: could not recount the usage of ${this.task.id}:`, error instanceof Error ? error.message : error);
    }
  }

  /** Puts what the task has used so far on the task, where the app reads it. */
  private publishUsage(): void {
    const usage = this.forwarder.taskUsage();
    if (usage && !this.stopped) this.host.patchTask(this.task.id, { usage });
  }

  private turnEnded(): void {
    this.turns++;
    this.publishUsage();
    const cap = this.core.options.maxTurns ?? DEFAULT_MAX_TURNS;
    if (this.turns >= cap && !this.capped) {
      this.capped = true;
      void this.conversation?.abort(CTX).catch(() => {});
    }
  }

  private logUsage(): void {
    this.publishUsage();
    const usage = this.forwarder.usage as { models?: Record<string, { input: number; output: number; cacheRead: number; cost: { total: number } }> } | undefined;
    let input = 0, output = 0, cached = 0, cost = 0;
    for (const u of Object.values(usage?.models ?? {})) {
      input += u.input; output += u.output; cached += u.cacheRead; cost += u.cost.total;
    }
    console.log(`telepi: task ${this.task.id} usage: ${input} input (${cached} cached), ${output} output tokens, $${cost.toFixed(4)}, ${this.turns} turns`);
  }

  // --- review --------------------------------------------------------------

  /** Opens the review and acts on the answer. Returns the next input when changes were requested, else null. */
  private async review(outcome: Exclude<RunOutcome, { kind: "stopped" }>, kept?: string): Promise<string | null> {
    const meta = this.meta;
    await this.commitLeftovers();
    const head = await this.headOf();
    if (head) this.core.store.update(this.task.id, { head });
    let files: ReviewPayload["files"] = [];
    try {
      const run = this.gitRunner();
      if (run && head) files = await changedFiles(run, meta.base, head);
    } catch (error) {
      console.warn(`telepi: could not list the changed files of ${this.task.id}:`, error instanceof Error ? error.message : error);
    }
    // Nothing to publish when the task failed or changed no files.
    const publishing = publishingOf(meta, this.core.options.github);
    const offered = outcome.kind === "done" && files.length > 0;
    const payload: ReviewPayload = {
      kind: "review",
      outcome: outcome.kind,
      summary: clip(outcome.text || (outcome.kind === "done" ? "Finished." : "Could not complete the task."), 900),
      files,
      branch: meta.branch,
      actions: offered ? [...(publishing.push ? [PUSH_ACTION] : []), ...(publishing.pr ? [OPEN_PR_ACTION] : [])] : [],
      notes: offered && publishing.note ? [publishing.note] : [],
    };
    const baseNotes = payload.notes;
    for (;;) {
      // A message that came in while the result was being put together: it gets its turn before anything is shown.
      if (this.stash.length > 0 && !this.stopped) {
        const text = this.stash.join("\n\n");
        this.stash = [];
        return text;
      }
      this.host.patchTask(this.task.id, { state: payload.outcome, currentStep: null });
      payload.notes = [...baseNotes, ...(this.network?.takeNotes() ?? [])];
      this.reviewOpen = true;
      const answer = await this.host.ask(this.task.id, payload, kept).finally(() => { this.reviewOpen = false; });
      kept = undefined;
      if (answer === null || answer.kind !== "review" || this.stopped) return null;

      if (answer.decision === "discard") {
        await this.say("Understood. I'll leave the branch as it is and stop here.");
        return null;
      }
      if (answer.decision === "action") {
        const action = payload.actions.find((a) => a.id === answer.actionId);
        if (!action) {
          await this.say("That action is not available for this result.");
          continue;
        }
        const published = action.id === PUSH_ACTION.id ? await this.pushFromReview(files.length) : await this.openPrFromReview(payload);
        if (!published) continue;
        // A pull request includes the push; once the branch is out, there is nothing left to offer for it.
        payload.actions = action.id === OPEN_PR_ACTION.id ? [] : payload.actions.filter((a) => a.id !== PUSH_ACTION.id);
        if (payload.actions.length === 0) return null;
        continue;
      }
      const text = [...this.stash, (answer.text ?? "").trim()].filter(Boolean).join("\n\n");
      this.stash = [];
      return text || "Please continue.";
    }
  }

  /** Git inside the sandbox, for the commands that inspect the agent's work. Undefined without a sandbox. */
  gitRunner(): GitRunner | undefined {
    const sandbox = this.sandbox;
    return sandbox ? sandboxGit((argv) => sandbox.run(argv)) : undefined;
  }

  /** The commit the branch is at, read in the sandbox. */
  private async headOf(): Promise<string | undefined> {
    const sandbox = this.sandbox ?? (await this.ready.catch(() => undefined));
    if (!sandbox) return undefined;
    const r = await sandbox.run(["git", "rev-parse", "HEAD"]);
    const head = r.stdout.trim();
    return r.code === 0 && isSha(head) ? head : undefined;
  }

  /** Reads a file of the workspace through the sandbox, for looking at the scripts a command runs. */
  private readWorkspaceFile = async (relative: string): Promise<string | null> => {
    const sandbox = this.sandbox ?? (await this.ready.catch(() => undefined));
    if (!sandbox) return null;
    const r = await sandbox.run(["sh", "-c", `[ -f "$1" ] && head -c ${MAX_SCRIPT_BYTES} -- "$1"`, "sh", relative]);
    return r.code === 0 ? r.stdout : null;
  };

  /** Commits whatever the model left uncommitted, in the sandbox. */
  private async commitLeftovers(): Promise<void> {
    const sandbox = this.sandbox ?? (await this.ready.catch(() => undefined));
    if (!sandbox) return;
    const status = await sandbox.run(["git", "status", "--porcelain"]);
    if (status.code !== 0 || !status.stdout.trim()) return;
    await sandbox.run(["git", "add", "-A"]);
    const commit = await sandbox.run(["git", "commit", "-q", "-m", `${clip(this.task.title, 60)} (uncommitted changes saved by telepi)`]);
    if (commit.code !== 0) console.warn(`telepi: could not commit leftovers for ${this.task.id}: ${commit.stderr.trim()}`);
  }

  /** Runs a publishing action behind its approval, as a step the app shows. True when it went through. */
  private async publish(action: PluginAction, spec: { detail: string; title: string; target: string; label: string; failedLabel: string; stepDetail: (result: string) => string | null; work: (progress: Progress) => Promise<string>; denied: string; failed: string }): Promise<boolean> {
    const stepId = `review-${action.id.replace(/\W/g, "-")}-${this.say_++}`;
    const result = await this.authorizeAction(action, spec.detail, spec.title, spec.target);
    if (result.kind === "stopped") return false;
    if (result.kind !== "run") {
      await this.say(result.kind === "denied" ? spec.denied : `That was refused: ${result.text}`);
      return false;
    }
    const branch = this.meta.branch;
    // The step's label is what is happening now; it ends as what happened.
    const progress: Progress = (label, detail = null) => {
      if (this.stopped) return;
      this.host.emit(this.task.id, { type: "step_progress", stepId, label, detail });
      this.host.patchTask(this.task.id, { currentStep: label });
    };
    this.host.emit(this.task.id, { type: "step_started", stepId, label: spec.title, detail: null });
    this.host.patchTask(this.task.id, { currentStep: spec.title });
    try {
      const text = await spec.work(progress);
      progress(spec.label, branch);
      this.host.emit(this.task.id, { type: "step_finished", stepId, ok: true, detail: spec.stepDetail(text) });
      this.host.patchTask(this.task.id, { currentStep: null });
      await this.say(text);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress(spec.failedLabel);
      this.host.emit(this.task.id, { type: "step_finished", stepId, ok: false, detail: clip(message, 100) });
      this.host.patchTask(this.task.id, { currentStep: null });
      await this.say(`${spec.failed} ${message}`);
      return false;
    }
  }

  private pushFromReview(fileCount: number): Promise<boolean> {
    const github = this.core.options.github;
    return this.publish(PUSH_ACTION, {
      detail: pushDetail(this.meta, github, fileCount), title: "Push the branch", target: this.meta.branch, label: "Pushed branch", failedLabel: "Could not push the branch",
      stepDetail: () => null, work: (progress) => this.pushBranch(progress), denied: "Okay, I won't push the branch.", failed: "I could not push the branch.",
    });
  }

  /** A one-commit branch is titled by its commit; otherwise by the task's instruction. Shown on the approval card. */
  private async prTitleOfBranch(): Promise<string> {
    const subjects = await this.gitRunner()?.(["log", "--format=%s", `${this.meta.base}..HEAD`]).catch(() => undefined);
    const lines = subjects?.code === 0 ? subjects.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    return lines.length === 1 && lines[0]!.length <= 120 ? lines[0]! : prTitle(this.task);
  }

  private async openPrFromReview(payload: ReviewPayload): Promise<boolean> {
    const input = { title: await this.prTitleOfBranch(), body: payload.summary };
    return this.publish(OPEN_PR_ACTION, {
      detail: this.prDetailOf(input), title: "Open a pull request", target: this.meta.branch, label: "Opened pull request", failedLabel: "Could not open the pull request",
      stepDetail: (text) => /#(\d+)/.exec(text)?.[1] ? `#${/#(\d+)/.exec(text)![1]}` : null,
      work: (progress) => this.openPullRequest(input.title, input.body, progress), denied: "Okay, I won't open a pull request.", failed: "I could not open the pull request.",
    });
  }

  private prDetailOf(input: { title: string; body: string }): string {
    const github = this.core.options.github;
    const repo = github ? githubRepoOf(this.meta.originUrl, github) : null;
    return github && repo ? prDetail(this.meta, github, repo, input) : `Open a pull request for ${this.meta.branch}.`;
  }

  // --- the decision pipeline -----------------------------------------------

  private async decide(call: PipelineCall, ui: ApprovalUi, action = SHELL_ACTION): Promise<Authorization> {
    const projectId = this.task.projectId;
    const decision = await pipeline.decide(call, {
      actionAllowed: call.kind === "action" ? this.host.isActionAllowed(projectId, call.action.id) : false,
      insidePolicy: ui.insidePolicy ?? true,
      reachesCredentialed: ui.reachesCredentialed ?? false,
    });
    if (this.stopped) return { kind: "stopped" };
    const record = (userDecision: "approve" | "deny" | null) =>
      this.host.recordDecision({
        at: Date.now(),
        taskId: this.task.id,
        projectId,
        call: call.kind === "shell" ? { kind: "shell", text: call.command, actionId: null } : { kind: "action", text: call.detail, actionId: call.action.id },
        outcome: decision.outcome,
        stage: decision.stage,
        reasonCode: decision.reason.code,
        userDecision,
      });

    if (decision.outcome === "run") {
      record(null);
      return { kind: "run" };
    }
    if (decision.outcome === "block") {
      record(null);
      return { kind: "blocked", text: decision.reason.text };
    }
    this.host.patchTask(this.task.id, { currentStep: `Waiting for approval: ${ui.title}` });
    const answer = await this.host.ask(this.task.id, {
      kind: "approval",
      title: ui.title,
      action: call.kind === "action" ? call.action : action,
      target: ui.target,
      detail: { format: ui.format, text: ui.detail, sections: ui.sections ?? [] },
      reason: decision.reason,
      canAllowPermanently: decision.canAllowPermanently,
      canDenyForTask: false,
    });
    if (answer === null || answer.kind !== "approval" || this.stopped) return { kind: "stopped" };
    record(answer.decision);
    this.host.patchTask(this.task.id, { currentStep: ui.title });
    return answer.decision === "approve" ? { kind: "run" } : { kind: "denied", note: answer.note?.trim() || null };
  }

  private authorizeAction(action: PluginAction, detail: string, title: string, target = this.meta.branch): Promise<Authorization> {
    return this.decide({ kind: "action", action, detail }, { title, target, format: "text", detail });
  }

  /** The hook in front of every tool call. */
  async guard(call: ToolCall, api: HookApi, context: Parameters<ToolSession["guard"]>[2]): Promise<{ block: string } | undefined> {
    const args = call.arguments as Record<string, unknown>;
    let auth: Authorization;
    let what: string;
    const memoKey = `telepi-decision:${call.id}`;

    if (call.name === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      what = "command";
      // Commands run without asking: the sandbox is the boundary. The pattern list asks only when the owner turned it on.
      auth = this.core.options.askPatterns
        ? await this.memoized(api, context, memoKey, async () =>
            this.decide(await shellCall(this.readWorkspaceFile, command), {
              title: `Run ${clip(command.split("\n")[0] ?? command, 60)}`,
              target: null,
              format: "command",
              detail: command,
              reachesCredentialed: reachesGitRemote(command),
            }),
          )
        : { kind: "run" };
    } else if (call.name === "open_pull_request") {
      what = "pull request";
      const input = { title: String(args.title ?? prTitle(this.task)), body: String(args.body ?? "") };
      if (!this.pullRequestTarget()) return undefined; // the tool itself says why it cannot run
      auth = await this.memoized(api, context, memoKey, () => this.authorizeAction(OPEN_PR_ACTION, this.prDetailOf(input), "Open a pull request"));
    } else {
      return undefined;
    }

    switch (auth.kind) {
      case "run": {
        // A command that plainly reaches a host asks for it now, so it runs once, after the sandbox has the rule.
        const gate = call.name === "bash" ? this.network : undefined;
        if (!gate) return undefined;
        const command = typeof args.command === "string" ? args.command : "";
        const destinations = networkDestinations(command, this.meta.originUrl).map((d) => ({ ...d, command }));
        if (destinations.length === 0) return undefined;
        this.host.patchTask(this.task.id, { currentStep: `Waiting for approval: network access to ${destinations[0]!.host}` });
        const ahead = await gate.askAhead(destinations);
        if (this.stopped) return { block: "The task was stopped." };
        this.host.patchTask(this.task.id, { currentStep: `Run ${clip(command.split("\n")[0] ?? command, 60)}` });
        if (ahead.ok) return undefined;
        this.forwarder.refuse(call.id, call.name, args, "Network access denied");
        return { block: `Not run. ${ahead.text}` };
      }
      case "stopped":
        return { block: "The task was stopped." };
      case "blocked":
        this.forwarder.refuse(call.id, call.name, args, "Refused: outside policy");
        return { block: `Refused: ${auth.text} This ${what} is not available in this project. Do not retry it; find another way or say so in your final message.` };
      case "denied":
        this.forwarder.refuse(call.id, call.name, args, "Denied by you");
        return { block: `The user denied this ${what}.${auth.note ? ` Their note: ${auth.note}` : ""} Do not retry it; adapt your approach.` };
    }
  }

  /** A user decision survives a restart: the tool task reruns its hook, and must not ask again. */
  private async memoized(api: HookApi, context: Parameters<ToolSession["guard"]>[2], key: string, decide: () => Promise<Authorization>): Promise<Authorization> {
    const prior = await api.memo<string>(key, context);
    if (prior !== undefined) return JSON.parse(prior) as Authorization;
    const auth = await decide();
    if (auth.kind === "run" || auth.kind === "denied") await api.memo(key, JSON.stringify(auth), context);
    return auth;
  }

  // --- tool bodies -----------------------------------------------------------

  async askUser(question: string, options: string[]): Promise<string | null> {
    const answer = await this.host.ask(this.task.id, { kind: "question", question, options });
    if (answer === null || answer.kind !== "question" || this.stopped) return null;
    return answer.text;
  }

  reportFailure(reason: string): void {
    this.failure = reason;
  }

  /** The GitHub repository this task's origin is, when pull requests can be opened for it. */
  private pullRequestTarget(): { github: NonNullable<PiOptions["github"]>; repo: { owner: string; repo: string } } | null {
    const github = this.core.options.github;
    const repo = github ? githubRepoOf(this.meta.originUrl, github) : null;
    return github && repo ? { github, repo } : null;
  }

  /** The agent's tool calls this with no `progress`: it then runs while the agent waits for it, and detaches before it returns. */
  async openPullRequest(title: string, body: string, progress?: Progress): Promise<string> {
    const target = this.pullRequestTarget();
    if (!target) throw new Error(`Pull requests can only be opened for a GitHub origin when the server has a GitHub token. This project's origin is ${this.meta.originUrl}.`);
    const control = (this.sandbox ?? (await this.ready)).openshell;
    const pr = await openPullRequest({ control, meta: this.meta, ...target, input: { title, body }, inReview: progress !== undefined, progress });
    return `Pushed ${this.meta.branch} and opened pull request${pr.number ? ` #${pr.number}` : ""}: ${pr.url}`;
  }

  private async pushBranch(progress: Progress): Promise<string> {
    const control = (this.sandbox ?? (await this.ready)).openshell;
    return pushBranch({ control, meta: this.meta, github: this.core.options.github, progress });
  }

  // --- small helpers -------------------------------------------------------

  async say(text: string): Promise<void> {
    if (this.stopped) return;
    this.host.emit(this.task.id, { type: "agent_text", messageId: `s${++this.say_}-${this.task.id.slice(-5)}`, delta: text });
  }

  private async giveUp(message: string): Promise<void> {
    await this.say(message);
    this.host.patchTask(this.task.id, { state: "failed", currentStep: null });
  }

  /** A task that cannot go on, but has a workspace: say why and show what exists. */
  private async endWithReview(line: string, kept?: KeptReview): Promise<void> {
    if (!kept) await this.say(line);
    this.phase = "review";
    await this.review({ kind: "failed", text: line }, kept?.requestId);
  }
}

