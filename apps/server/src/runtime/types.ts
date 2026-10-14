// The seam between the server core and whatever runs the agent.
// Today the runtime is a fake that plays scripted scenarios; later it is Pi Durable + OpenShell.
// The server core implements RuntimeHost; a runtime implements AgentRuntime.
import type {
  DecisionRecord,
  ModelRef,
  ModelsResponse,
  Project,
  RequestAnswer,
  RequestPayload,
  ReviewPayload,
  Task,
  TaskEventInput,
} from "@telepi/contract";

/** What the server core gives a runtime. */
export interface RuntimeHost {
  getProject(projectId: string): Project | undefined;
  /** Appends an event to the task's log; the host stamps seq and time and streams it to clients. */
  emit(taskId: string, event: TaskEventInput): void;
  patchTask(taskId: string, patch: Partial<Pick<Task, "state" | "currentStep" | "branch" | "title" | "usage">>): void;
  /**
   * Opens a request for the user, marks the task waiting and sends a push.
   * Resolves with the answer, or null if the request was cancelled (task stopped).
   * The host emits request_opened / request_closed and restores the task state itself.
   * `kept` names a request that stayed open across a restart: the host waits on that one instead of opening another.
   */
  ask(taskId: string, payload: RequestPayload, kept?: string): Promise<RequestAnswer | null>;
  /**
   * Adds lines to the notes of the task's open review. False when no review is open (the caller keeps the lines for
   * the next one).
   */
  addReviewNotes(taskId: string, lines: string[]): boolean;
  isActionAllowed(projectId: string, actionId: string): boolean;
  /** Records a permanent allow for an action in a project. */
  allowAction(projectId: string, actionId: string): void;
  recordDecision(record: DecisionRecord): void;
  /** The model chosen in telepi for new tasks, or null. */
  modelChoice(): ModelRef | null;
}

/** A finished task's review that was open when the server stopped. The runtime waits on it again as it is. */
export interface KeptReview {
  requestId: string;
  payload: ReviewPayload;
}

/** What a runtime gives the server core. */
export interface AgentRuntime {
  /** Called once for a new task, and again after a server restart for tasks that were running or waiting. */
  start(task: Task, opts: { resumed: boolean; review?: KeptReview }): void;
  /** A steering message from the user while the task is live. The host has already emitted user_message. */
  message(taskId: string, text: string): void;
  stop(taskId: string): void;
  /**
   * The full diff of one changed file of a task, or null if the task has no such file.
   * The server core applies the line limit; return the whole patch.
   * Patch format: unified diff hunks only, no file header lines. Empty for binary files.
   */
  diff(taskId: string, path: string): Promise<{ binary: boolean; patch: string } | null>;
  /** The models new tasks can run on and the one they will run on. Absent in a runtime that has no models. */
  models?(): Promise<ModelsResponse>;
  /** Server shutdown: release what the runtime holds (sandboxes, connections). Tasks stay as they are and resume on the next start. */
  close?(): Promise<void>;
}

export type RuntimeFactory = (host: RuntimeHost) => AgentRuntime;
