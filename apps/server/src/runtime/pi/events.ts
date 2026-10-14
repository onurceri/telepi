// Turns Pi Durable's agent events into telepi task events: streamed text and tool steps.
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { TaskUsage } from "@telepi/contract";
import type { RuntimeHost } from "../types";
import { stepFinish, stepStart } from "./steps";

interface Sink {
  host: RuntimeHost;
  taskId: string;
  /** False after stop or shutdown: nothing more is emitted. */
  live(): boolean;
  stepOpened(stepId: string): void;
  stepClosed(stepId: string): void;
  onTurnEnd(): void;
  /** What was counted before this process took the task over (a restart), and the model's context window. */
  usageBase: TaskUsage | null;
  contextWindow(): number | null;
}

type Msg = { role?: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: { type?: string; text?: string }) => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

export class EventForwarder {
  /** Cumulative usage of the conversation, as of the latest event. */
  usage: unknown;
  private messageId: string | null = null;
  private sent = "";
  private blocks = new Map<number, string>();
  private messages = 0;
  private open = new Map<string, { tool: string; args: Record<string, unknown> }>();
  private done = new Set<string>();
  private readonly nonce = Math.random().toString(36).slice(2, 7);

  // Counted here, event by event. Tokens and cost are not: Pi keeps those per conversation, across restarts.
  private turns: number;
  private modelMs: number;
  private toolMs: number;
  private compactions: number;
  private contextTokens: number;

  constructor(private sink: Sink) {
    const base = sink.usageBase;
    this.turns = base?.turns ?? 0;
    this.modelMs = base?.modelMs ?? 0;
    this.toolMs = base?.toolMs ?? 0;
    this.compactions = base?.compactions ?? 0;
    this.contextTokens = base?.contextTokens ?? 0;
  }

  /**
   * Counts again from what Pi has recorded, after a restart. A turn that ended just before the process died was never
   * seen as an event by anyone; the record has it.
   */
  recount(messages: readonly { role?: string; durationMs?: number; usage?: { input?: number; cacheRead?: number } }[]): void {
    let turns = 0, modelMs = 0, toolMs = 0, context = 0;
    for (const m of messages) {
      if (m.role === "assistant") {
        turns += 1;
        modelMs += m.durationMs ?? 0;
        if (m.usage) context = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0);
      } else if (m.role === "toolResult") {
        toolMs += m.durationMs ?? 0;
      }
    }
    if (turns < this.turns) return; // the record is behind what was counted (it should never be)
    this.turns = turns;
    this.modelMs = modelMs;
    this.toolMs = toolMs;
    if (context > 0) this.contextTokens = context;
  }

  /** The task's usage so far, or null before the model has answered once. */
  taskUsage(): TaskUsage | null {
    const models = (this.usage as { models?: Record<string, { input: number; output: number; cacheRead: number; cost: { total: number } }> } | undefined)?.models;
    const totals = Object.values(models ?? {});
    if (totals.length === 0 && this.turns === 0) return null;
    const sum = (pick: (u: (typeof totals)[number]) => number) => totals.reduce((n, u) => n + pick(u), 0);
    return {
      costUsd: sum((u) => u.cost.total),
      inputTokens: sum((u) => u.input),
      cachedTokens: sum((u) => u.cacheRead),
      outputTokens: sum((u) => u.output),
      turns: this.turns,
      modelMs: Math.round(this.modelMs),
      toolMs: Math.round(this.toolMs),
      contextTokens: this.contextTokens,
      contextWindow: this.sink.contextWindow(),
      compactions: this.compactions,
    };
  }

  /** Ids of steps that must not be reported again (closed by a restart). */
  ignore(stepIds: string[]): void {
    for (const id of stepIds) this.done.add(id);
  }

  handle(events: readonly AgentEvent[]): void {
    for (const e of events) {
      if (e.type === "snapshot") {
        this.usage = e.usage;
        continue;
      }
      if (e.type === "usage_changed") this.usage = e.usage;
      if (e.type === "task_failed") console.warn(`telepi: pi task ${e.kind} failed: ${e.message}`);
      if (!this.sink.live()) continue;
      switch (e.type) {
        case "message_start": {
          if ((e.message as Msg).role !== "assistant") break;
          this.beginMessage();
          // The partial message can already hold its first text.
          const content = (e.message as Msg).content;
          if (Array.isArray(content)) content.forEach((b: { type?: string; text?: string }, i) => { if (b.type === "text") this.blocks.set(i, b.text ?? ""); });
          this.flush();
          break;
        }
        case "message_update": {
          if (this.messageId === null) this.beginMessage();
          for (const c of e.changes) {
            if (c.type === "text_start" || c.type === "block") {
              if (c.block.type === "text") this.blocks.set(c.contentIndex, c.block.text ?? "");
              else this.blocks.delete(c.contentIndex);
            } else if (c.type === "text_delta") {
              this.blocks.set(c.contentIndex, (this.blocks.get(c.contentIndex) ?? "") + c.delta);
            } else if (c.type === "message") {
              this.blocks.clear();
              c.message.content.forEach((b, i) => { if (b.type === "text") this.blocks.set(i, b.text); });
            }
          }
          this.flush();
          break;
        }
        case "message_end": {
          const message = e.entry.model?.[0] as (Msg & { durationMs?: number; usage?: { input?: number; cacheRead?: number } }) | undefined;
          if (message?.role !== "assistant") break;
          this.turns += 1;
          this.modelMs += message.durationMs ?? 0;
          if (message.usage) this.contextTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);
          if (this.messageId === null) this.beginMessage();
          this.blocks.clear();
          this.blocks.set(0, textOf(message.content));
          this.flush();
          this.messageId = null;
          break;
        }
        case "turn_end":
          this.sink.onTurnEnd();
          break;
        case "tool_execution_start":
          this.started(e.toolCallId, e.toolName, e.args as Record<string, unknown>);
          break;
        case "compaction_end":
          this.compactions += 1;
          break;
        case "tool_execution_end":
          this.toolMs += (e.entry?.model?.[0] as { durationMs?: number } | undefined)?.durationMs ?? 0;
          this.finished(e.toolCallId, e.toolName, e.entry?.model?.[0] as { content?: unknown; isError?: boolean; details?: unknown } | undefined);
          break;
      }
    }
  }

  private beginMessage(): void {
    this.messageId = `a${++this.messages}-${this.nonce}`;
    this.sent = "";
    this.blocks.clear();
  }

  /** Emits what the message's text gained since the last emit. Hidden reasoning is never part of it. */
  private flush(): void {
    if (this.messageId === null) return;
    const full = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
    if (full.length <= this.sent.length || !full.startsWith(this.sent)) return;
    const delta = full.slice(this.sent.length);
    this.sent = full;
    this.sink.host.emit(this.sink.taskId, { type: "agent_text", messageId: this.messageId, delta });
  }

  private started(id: string, tool: string, args: Record<string, unknown>): void {
    if (this.done.has(id) || this.open.has(id)) return;
    const { label, detail } = stepStart(tool, args);
    this.open.set(id, { tool, args });
    this.sink.stepOpened(id);
    this.sink.host.emit(this.sink.taskId, { type: "step_started", stepId: id, label, detail });
    this.sink.host.patchTask(this.sink.taskId, { currentStep: label });
  }

  private finished(id: string, tool: string, result: { content?: unknown; isError?: boolean; details?: unknown } | undefined): void {
    if (this.done.has(id)) return;
    const was = this.open.get(id);
    if (!was) return;
    const r = stepFinish(tool, was?.args, { isError: result?.isError ?? result === undefined, text: textOf(result?.content), details: result?.details });
    this.done.add(id);
    this.open.delete(id);
    this.sink.stepClosed(id);
    this.sink.host.emit(this.sink.taskId, { type: "step_finished", stepId: id, ok: r.ok, detail: r.detail });
  }

  /** A call the pipeline stopped never reaches Pi's tool events, so it gets its own step here. */
  refuse(id: string, tool: string, args: Record<string, unknown>, detail: string): void {
    if (this.done.has(id) || !this.sink.live()) return;
    this.done.add(id);
    const { label, detail: shown } = stepStart(tool, args);
    this.sink.host.emit(this.sink.taskId, { type: "step_started", stepId: id, label: label.replace(/^Ran /, "Tried "), detail: shown });
    this.sink.host.emit(this.sink.taskId, { type: "step_finished", stepId: id, ok: false, detail });
  }

  /** Closes every step that is still open, e.g. on stop. */
  closeOpen(detail: string): void {
    for (const id of [...this.open.keys()]) {
      this.done.add(id);
      this.open.delete(id);
      this.sink.stepClosed(id);
      this.sink.host.emit(this.sink.taskId, { type: "step_finished", stepId: id, ok: false, detail });
    }
  }
}
