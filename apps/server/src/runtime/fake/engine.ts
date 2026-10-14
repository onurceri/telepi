// The machinery a scripted scenario runs on: timing, streamed text, steps, and the decision pipeline.
import { createPipeline, patternJudge, type Decision, type Pipeline, type ToolCall } from "@telepi/decision";
import type {
  ApprovalPayload,
  PluginAction,
  QuestionPayload,
  RequestAnswer,
  ReviewPayload,
  Task,
} from "@telepi/contract";
import type { RuntimeHost } from "../types";

/** Thrown inside a scenario when the task is stopped; ends it quietly. */
export class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

export const SHELL_ACTION: PluginAction = { id: "shell.run", plugin: "shell", label: "Run command", class: "write" };
// The same two actions the real runtime raises for the sandbox network (runtime/pi/network.ts).
const NETWORK_ACTION: PluginAction = { id: "network.allow", plugin: "openshell", label: "Network access", class: "write" };
const SEND_ACTION: PluginAction = { id: "network.send", plugin: "openshell", label: "Send data", class: "write" };

export const pipeline: Pipeline = createPipeline({ judges: [patternJudge] });

const rand = (min: number, max: number) => min + Math.random() * (max - min);
/** A realistic step duration, 0.8 to 3 seconds unless told otherwise. */
export const dur = (min = 800, max = 3000) => rand(min, max);

interface Wait {
  handle: ReturnType<typeof setTimeout>;
  reject: (e: Error) => void;
}

export interface ToolSpec {
  call: ToolCall;
  /** Step label once it runs, e.g. "Ran npm test". */
  label: string;
  /** Step detail when it starts. */
  detail?: string | null;
  /** Step detail when it finishes. */
  doneDetail?: string | null;
  ok?: boolean;
  ms?: number;
  /** What the step says while it runs, one phase after another across `ms`, ending as `label`. */
  phases?: string[];
  /** Approval card title. Defaults to the label. */
  title?: string;
  target?: string | null;
  format?: "command" | "sql" | "diff" | "text";
  /** Context for the pipeline. */
  insidePolicy?: boolean;
  reachesCredentialed?: boolean;
}

export type ToolResult = "ran" | "denied" | "blocked";

/** Everything a scenario needs for one task. */
export class TaskRun {
  cancelled = false;
  private waits = new Set<Wait>();
  private speech: Promise<void> = Promise.resolve();
  private stepCount = 0;
  private messageCount = 0;

  constructor(
    readonly host: RuntimeHost,
    readonly task: Task,
  ) {}

  get id() {
    return this.task.id;
  }

  cancel() {
    this.cancelled = true;
    for (const w of this.waits) {
      clearTimeout(w.handle);
      w.reject(new Stopped());
    }
    this.waits.clear();
  }

  sleep(ms: number): Promise<void> {
    if (this.cancelled) return Promise.reject(new Stopped());
    return new Promise((resolve, reject) => {
      const w: Wait = {
        handle: setTimeout(() => {
          this.waits.delete(w);
          resolve();
        }, ms),
        reject,
      };
      this.waits.add(w);
    });
  }

  /** Streams agent text as small deltas. Texts from one task never interleave. */
  say(text: string): Promise<void> {
    const run = this.speech.then(() => this.stream(text));
    this.speech = run.catch(() => {});
    return run;
  }

  private async stream(text: string) {
    const messageId = `m${++this.messageCount}-${Math.random().toString(36).slice(2, 7)}`;
    const words = text.split(" ");
    for (let i = 0; i < words.length; ) {
      const n = 2 + Math.floor(Math.random() * 3);
      const chunk = words.slice(i, i + n).join(" ");
      i += n;
      await this.sleep(rand(30, 60));
      this.host.emit(this.id, { type: "agent_text", messageId, delta: i < words.length ? `${chunk} ` : chunk });
    }
  }

  /** A step that takes a while and then finishes. */
  async step(label: string, opts: { detail?: string | null; doneDetail?: string | null; ok?: boolean; ms?: number; phases?: string[] } = {}) {
    const stepId = `s${++this.stepCount}`;
    const phases = opts.phases ?? [];
    this.host.emit(this.id, { type: "step_started", stepId, label: phases[0] ?? label, detail: phases.length > 0 ? null : (opts.detail ?? null) });
    this.host.patchTask(this.id, { currentStep: phases[0] ?? label });
    try {
      const ms = opts.ms ?? dur();
      for (const phase of phases.slice(1)) {
        await this.sleep(ms / phases.length);
        this.host.emit(this.id, { type: "step_progress", stepId, label: phase, detail: null });
        this.host.patchTask(this.id, { currentStep: phase });
      }
      await this.sleep(ms / Math.max(phases.length, 1));
      if (phases.length > 0) this.host.emit(this.id, { type: "step_progress", stepId, label, detail: opts.detail ?? null });
    } catch (e) {
      this.host.emit(this.id, { type: "step_finished", stepId, ok: false, detail: "Stopped" });
      throw e;
    }
    this.host.emit(this.id, { type: "step_finished", stepId, ok: opts.ok ?? true, detail: opts.doneDetail ?? opts.detail ?? null });
  }

  /** Waits for the user. A null answer means the task was stopped. */
  async ask(payload: ApprovalPayload | QuestionPayload | ReviewPayload, kept?: string): Promise<RequestAnswer> {
    const answer = await this.host.ask(this.id, payload, kept);
    if (answer === null || this.cancelled) throw new Stopped();
    return answer;
  }

  /** Runs one tool call through the decision pipeline and acts on the outcome. */
  async tool(spec: ToolSpec): Promise<ToolResult> {
    const { call } = spec;
    const projectId = this.task.projectId;
    const decision: Decision = await pipeline.decide(call, {
      actionAllowed: call.kind === "action" ? this.host.isActionAllowed(projectId, call.action.id) : false,
      insidePolicy: spec.insidePolicy ?? true,
      reachesCredentialed: spec.reachesCredentialed ?? false,
    });
    if (this.cancelled) throw new Stopped();

    const record = (userDecision: "approve" | "deny" | null) =>
      this.host.recordDecision({
        at: Date.now(),
        taskId: this.id,
        projectId,
        call:
          call.kind === "shell"
            ? { kind: "shell", text: call.command, actionId: null }
            : { kind: "action", text: call.detail, actionId: call.action.id },
        outcome: decision.outcome,
        stage: decision.stage,
        reasonCode: decision.reason.code,
        userDecision,
      });
    const run = () => this.step(spec.label, spec);

    if (decision.outcome === "run") {
      record(null);
      await run();
      return "ran";
    }

    if (decision.outcome === "block") {
      record(null);
      await this.step(spec.label.replace(/^Ran /, "Tried "), { detail: spec.detail, doneDetail: "Refused: outside policy", ok: false, ms: dur(500, 900) });
      await this.say(`That was refused: ${decision.reason.text.charAt(0).toLowerCase()}${decision.reason.text.slice(1)}`);
      return "blocked";
    }

    this.host.patchTask(this.id, { currentStep: `Waiting for approval: ${spec.title ?? spec.label}` });
    const answer = await this.askApproval(spec, decision);
    if (answer.kind !== "approval") throw new Stopped();
    record(answer.decision);
    const note = answer.note?.trim();
    if (answer.decision === "approve") {
      if (note) await this.say(`Noted: ${note}`);
      await run();
      return "ran";
    }
    return "denied";
  }

  /** Network read approval for a host the project has not allowed yet. */
  async askNetwork(host: string, command: string): Promise<"approve" | "deny"> {
    const text = `${host}:443\nTried by: ${command}`;
    return this.askAccess({
      kind: "approval",
      title: `Allow reading from ${host}`,
      action: NETWORK_ACTION,
      target: `${host}:443`,
      detail: { format: "text", text, sections: [{ title: `${host}:443`, format: "text", text: `Tried by: ${command}\nThe sandbox has no network by default.`, collapsed: false }] },
      reason: { code: "first_time", text: "Approving a site lets the agent read from it. Sending data to it asks again." },
      canAllowPermanently: true,
      canDenyForTask: true,
    });
  }

  /** Send-data approval for a host the user already allowed the agent to read from. */
  async askSend(host: string, method: string, path: string): Promise<"approve" | "deny"> {
    const text = `The agent wants to send data to ${host}.\n\n${method} ${path}`;
    return this.askAccess({
      kind: "approval",
      title: `Allow sending data to ${host}`,
      action: SEND_ACTION,
      target: `${method} ${host}${path}`,
      detail: { format: "text", text: `${host}\n${text}`, sections: [{ title: host, format: "text", text, collapsed: false }] },
      reason: { code: "send_data", text: `You allowed the agent to read from ${host}. Sending data to it needs a separate yes.` },
      send: { host, method, path },
      canAllowPermanently: true,
      canDenyForTask: true,
    });
  }

  private async askAccess(payload: ApprovalPayload): Promise<"approve" | "deny"> {
    this.host.patchTask(this.id, { currentStep: `Waiting for approval: ${payload.title}` });
    const answer = await this.ask(payload);
    if (answer.kind !== "approval") throw new Stopped();
    const note = answer.note?.trim();
    if (answer.decision === "approve" && note) await this.say(`Noted: ${note}`);
    return answer.decision === "approve" ? "approve" : "deny";
  }

  private askApproval(spec: ToolSpec, decision: Extract<Decision, { outcome: "ask" }>) {
    const { call } = spec;
    return this.ask({
      kind: "approval",
      title: spec.title ?? spec.label,
      action: call.kind === "action" ? call.action : SHELL_ACTION,
      target: spec.target ?? null,
      detail: {
        format: spec.format ?? (call.kind === "shell" ? "command" : "text"),
        text: call.kind === "shell" ? [call.command, call.script?.content].filter(Boolean).join("\n\n") : call.detail,
        sections: [],
      },
      reason: decision.reason,
      canAllowPermanently: decision.canAllowPermanently,
      canDenyForTask: false,
    });
  }
}
