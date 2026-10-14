// The server core's side of the runtime seam: everything a runtime may ask of the server.
import type { DecisionRecord, ModelRef, Project, Request, RequestAnswer, RequestPayload, Task, TaskEventInput } from "@telepi/contract";
import type { RuntimeHost } from "./runtime/types";
import type { Push } from "./push";
import type { State } from "./state";

export class Host implements RuntimeHost {
  private waiters = new Map<string, (answer: RequestAnswer | null) => void>();

  constructor(private state: State, private push: Push) {}

  getProject(projectId: string): Project | undefined {
    return this.state.projects.get(projectId);
  }

  emit(taskId: string, event: TaskEventInput): void {
    if (!this.state.tasks.has(taskId)) return;
    this.state.appendEvent(taskId, event);
  }

  patchTask(taskId: string, patch: Partial<Pick<Task, "state" | "currentStep" | "branch" | "title" | "usage">>): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;
    const next: Task = { ...task, ...patch, updatedAt: Date.now() };
    this.state.putTask(next);
    if (patch.state !== undefined && patch.state !== task.state) {
      this.state.appendEvent(taskId, { type: "state_changed", state: patch.state });
    }
  }

  ask(taskId: string, payload: RequestPayload, kept?: string): Promise<RequestAnswer | null> {
    const task = this.state.tasks.get(taskId);
    // A stopped or finished task cannot be waited on, except for the review that closes a finished one.
    if (!task || task.state === "stopped") return Promise.resolve(null);

    // A request kept open across a restart: wait on it again, without a new card or a second notification.
    const open = kept ? this.state.requests.get(kept) : undefined;
    if (open && open.taskId === taskId && open.state === "open") {
      return new Promise<RequestAnswer | null>((resolve) => this.waiters.set(open.id, resolve));
    }
    // Answered while the runtime was still coming back up.
    if (open && open.taskId === taskId && open.state === "answered" && open.answer) return Promise.resolve(open.answer);

    const request: Request = {
      id: this.state.newId("req"),
      taskId,
      projectId: task.projectId,
      state: "open",
      createdAt: Date.now(),
      closedAt: null,
      payload,
      answer: null,
    };
    const answered = new Promise<RequestAnswer | null>((resolve) => this.waiters.set(request.id, resolve));
    this.state.putRequest(request);
    this.state.appendEvent(taskId, { type: "request_opened", requestId: request.id });
    if (task.state === "running") this.patchTask(taskId, { state: "waiting" });
    try {
      this.push.notifyOpened(request);
    } catch (err) {
      console.warn("telepi: push failed:", err);
    }
    return answered;
  }

  /** Close an open request with the user's answer and wake the runtime. The caller has validated the answer. */
  answer(requestId: string, answer: RequestAnswer): Request {
    const request = this.state.requests.get(requestId);
    if (!request || request.state !== "open") throw new Error(`request ${requestId} is not open`);

    const closed: Request = { ...request, state: "answered", closedAt: Date.now(), answer };
    this.state.appendEvent(request.taskId, { type: "request_closed", requestId });
    this.state.putRequest(closed);

    if (answer.kind === "approval" && answer.allowPermanently && request.payload.kind === "approval" && request.payload.canAllowPermanently) {
      this.allowAction(request.projectId, request.payload.action.id);
    }
    if (answer.kind !== "review") this.resumeIfNothingOpen(request.taskId);

    const waiter = this.waiters.get(requestId);
    this.waiters.delete(requestId);
    waiter?.(answer);
    return closed;
  }

  addReviewNotes(taskId: string, lines: string[]): boolean {
    const review = [...this.state.requests.values()].find((r) => r.taskId === taskId && r.state === "open" && r.payload.kind === "review");
    if (!review || review.payload.kind !== "review" || lines.length === 0) return review !== undefined;
    this.state.putRequest({ ...review, payload: { ...review.payload, notes: [...review.payload.notes, ...lines] } });
    return true;
  }

  /** Cancel every open request of a task (it was stopped), or all but `keep`. The runtime's ask() resolves null. */
  cancelRequests(taskId?: string, keep?: ReadonlySet<string>): void {
    for (const request of [...this.state.requests.values()]) {
      if (request.state !== "open" || (taskId && request.taskId !== taskId) || keep?.has(request.id)) continue;
      this.state.appendEvent(request.taskId, { type: "request_closed", requestId: request.id });
      this.state.putRequest({ ...request, state: "cancelled", closedAt: Date.now() });
      const waiter = this.waiters.get(request.id);
      this.waiters.delete(request.id);
      waiter?.(null);
    }
  }

  private resumeIfNothingOpen(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (task?.state === "waiting" && this.state.openRequestCount(taskId) === 0) this.patchTask(taskId, { state: "running" });
  }

  isActionAllowed(projectId: string, actionId: string): boolean {
    return this.state.projects.get(projectId)?.allowedActions.includes(actionId) ?? false;
  }

  allowAction(projectId: string, actionId: string): void {
    const project = this.state.projects.get(projectId);
    if (!project || project.allowedActions.includes(actionId)) return;
    this.state.putProject({ ...project, allowedActions: [...project.allowedActions, actionId] });
  }

  recordDecision(record: DecisionRecord): void {
    this.state.persist.appendLine("decisions.jsonl", record);
  }

  modelChoice(): ModelRef | null {
    return this.state.modelChoice;
  }
}
