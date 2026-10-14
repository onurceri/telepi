// The four commands that change work: create a task, send a message, stop, answer a request.
import type { AnswerRequestBody, CreateTaskBody, ModelsResponse, Request, RequestAnswer, SendMessageBody, SetModelBody, Task } from "@telepi/contract";
import type { Host } from "./host";
import { HttpError } from "./http";
import type { AgentRuntime, KeptReview } from "./runtime/types";
import type { State } from "./state";

const TITLE_MAX = 60;

function titleOf(instruction: string): string {
  const line = instruction.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "Untitled";
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

const isLive = (task: Task) => task.state === "running" || task.state === "waiting";

export class Commands {
  constructor(private state: State, private host: Host, private runtime: AgentRuntime) {}

  private task(id: string): Task {
    const task = this.state.tasks.get(id);
    if (!task) throw new HttpError("not_found", "Task not found.");
    return task;
  }

  /** Start (or resume) a task in the runtime. A runtime that throws fails the task instead of the server. */
  startInRuntime(task: Task, resumed: boolean, review?: KeptReview): void {
    try {
      this.runtime.start({ ...task }, { resumed, review });
    } catch (err) {
      console.error(`telepi: runtime.start failed for ${task.id}:`, err);
      this.host.patchTask(task.id, { state: "failed", currentStep: null });
    }
  }

  createTask(body: CreateTaskBody): Task {
    const instruction = body.instruction.trim();
    if (!instruction) throw new HttpError("invalid", "instruction: must not be empty");
    if (!this.state.projects.has(body.projectId)) throw new HttpError("not_found", "Project not found.");

    const now = Date.now();
    const task: Task = {
      id: this.state.newId("task"),
      projectId: body.projectId,
      title: titleOf(instruction),
      instruction,
      state: "running",
      currentStep: null,
      branch: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.putTask(task);
    this.state.appendEvent(task.id, { type: "instruction", text: instruction });
    this.startInRuntime(task, false);
    return task;
  }

  sendMessage(taskId: string, body: SendMessageBody): void {
    const task = this.task(taskId);
    if (!isLive(task)) throw new HttpError("invalid", `Task is ${task.state}; it cannot take messages.`);
    this.state.appendEvent(taskId, { type: "user_message", text: body.text, clientId: body.requestId });
    this.runtime.message(taskId, body.text);
  }

  stopTask(taskId: string): void {
    const task = this.task(taskId);
    if (!isLive(task)) return;
    this.host.cancelRequests(taskId);
    try {
      this.runtime.stop(taskId);
    } catch (err) {
      console.error(`telepi: runtime.stop failed for ${taskId}:`, err);
    }
    if (this.state.tasks.get(taskId)?.state !== "stopped") this.host.patchTask(taskId, { state: "stopped", currentStep: null });
  }

  answerRequest(requestId: string, body: AnswerRequestBody): Request {
    const request = this.state.requests.get(requestId);
    if (!request) throw new HttpError("not_found", "Request not found.");
    if (request.state !== "open") throw new HttpError("request_closed", "This request is already closed.");
    const answer = this.checkAnswer(request, body.answer);
    return this.host.answer(requestId, answer);
  }

  /** The models new tasks can use. A runtime without models lists none. */
  async models(): Promise<ModelsResponse> {
    return (await this.runtime.models?.()) ?? { current: null, source: null, available: [] };
  }

  /** Chooses the model for new tasks (or, with null, goes back to Pi's default). Running tasks keep theirs. */
  async setModel(body: SetModelBody): Promise<ModelsResponse> {
    if (body.model && !(await this.models()).available.some((m) => m.provider === body.model!.provider && m.id === body.model!.id)) {
      throw new HttpError("invalid", "model: this model is not available on the home machine.");
    }
    this.state.setModelChoice(body.model);
    return this.models();
  }

  private checkAnswer(request: Request, answer: RequestAnswer): RequestAnswer {
    const payload = request.payload;
    if (answer.kind !== payload.kind) throw new HttpError("invalid", `Expected a ${payload.kind} answer, got ${answer.kind}.`);
    if (answer.kind === "approval") {
      const canAllow = payload.kind === "approval" && payload.canAllowPermanently;
      return canAllow || !answer.allowPermanently ? answer : { ...answer, allowPermanently: false };
    }
    if (answer.kind === "review" && payload.kind === "review") {
      if (answer.decision === "action") {
        if (!answer.actionId) throw new HttpError("invalid", "answer.actionId is required for decision \"action\".");
        if (!payload.actions.some((a) => a.id === answer.actionId)) throw new HttpError("invalid", "answer.actionId is not offered by this review.");
      }
      if (answer.decision === "changes" && !answer.text?.trim()) throw new HttpError("invalid", "answer.text is required for decision \"changes\".");
    }
    return answer;
  }
}
