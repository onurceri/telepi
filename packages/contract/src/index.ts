// The contract between the telepi app (PWA) and the telepi server.
// Everything the client and server exchange is defined here and nowhere else.
import { z } from "zod";

/** Bump when a change breaks older clients. A client that sees a different version drops its cache. */
export const CONTRACT_VERSION = 2;

// ---------------------------------------------------------------------------
// Projects and tasks
// ---------------------------------------------------------------------------

export const ProjectStatus = z.enum(["running", "waiting", "idle"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  status: ProjectStatus,
  /** Action ids the user has allowed permanently in this project. */
  allowedActions: z.array(z.string()),
});
export type Project = z.infer<typeof Project>;

export const TaskState = z.enum(["running", "waiting", "done", "failed", "stopped"]);
export type TaskState = z.infer<typeof TaskState>;

/**
 * What a task has cost so far, as the agent runtime reports it. Tokens and cost are the provider's own figures.
 * Updated after every model turn.
 */
export const TaskUsage = z.object({
  costUsd: z.number(),
  /** Tokens sent to the model that were not served from the provider's cache. */
  inputTokens: z.number().int(),
  /** Tokens sent to the model that the provider served from its cache (billed at a fraction). */
  cachedTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** Model calls made. */
  turns: z.number().int(),
  /** Time the model spent answering, and time commands and tools spent running. Waiting on the person is in neither. */
  modelMs: z.number().int(),
  toolMs: z.number().int(),
  /** Size of the conversation the model read on its last call, and the most the model can read. */
  contextTokens: z.number().int(),
  contextWindow: z.number().int().nullable(),
  /** Times older parts of the conversation were summarised to fit the context window. */
  compactions: z.number().int(),
});
export type TaskUsage = z.infer<typeof TaskUsage>;

export const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  instruction: z.string(),
  state: TaskState,
  /** One-line description of what the agent is doing right now. */
  currentStep: z.string().nullable(),
  branch: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Absent until the first model turn has ended, and for tasks from before usage was recorded. */
  usage: TaskUsage.nullable().optional(),
});
export type Task = z.infer<typeof Task>;

// ---------------------------------------------------------------------------
// Actions (publish and network, declared by the runtime) and requests (things that need the user)
// ---------------------------------------------------------------------------

export const ActionClass = z.enum(["read", "write", "destructive"]);
export type ActionClass = z.infer<typeof ActionClass>;

export const PluginAction = z.object({
  /** Stable id: "git.push" (push the task branch to origin) or "github.open_pr" (push, then open a pull request). */
  id: z.string(),
  plugin: z.string(),
  label: z.string(),
  class: ActionClass,
});
export type PluginAction = z.infer<typeof PluginAction>;

/** Why an approval was asked. Shown on the approval card. */
export const ApprovalReasonCode = z.enum(["destructive", "first_time", "pattern", "judge", "send_data"]);
export type ApprovalReasonCode = z.infer<typeof ApprovalReasonCode>;

const DetailFormat = z.enum(["command", "sql", "diff", "text"]);

/** One part of an approval's detail, so the part that matters can be shown first and the rest folded away. */
export const DetailSection = z.object({
  title: z.string(),
  format: DetailFormat,
  text: z.string(),
  /** True for context the user rarely needs to read, e.g. a second host that comes along. Shown folded. */
  collapsed: z.boolean(),
});
export type DetailSection = z.infer<typeof DetailSection>;

export const ApprovalPayload = z.object({
  kind: z.literal("approval"),
  title: z.string(),
  action: PluginAction,
  target: z.string().nullable(),
  detail: z.object({
    format: DetailFormat,
    /** The whole detail as one text. Always present. */
    text: z.string(),
    /** When not empty, show these instead of text, in order. */
    sections: z.array(DetailSection).default([]),
  }),
  reason: z.object({ code: ApprovalReasonCode, text: z.string() }),
  /**
   * Set when the agent wants to send data to a site the user already allowed it to read from (a POST, PUT, PATCH or
   * DELETE, or a git push). Absent on every other approval, including all stored before this field existed.
   */
  send: z.object({ host: z.string(), method: z.string(), path: z.string() }).optional(),
  /** False for destructive actions: they ask every time. */
  canAllowPermanently: z.boolean(),
  /**
   * True when a denial can be widened to the rest of the task, e.g. "deny all network access for this task".
   * The app then offers that next to Deny.
   */
  canDenyForTask: z.boolean().default(false),
});
export type ApprovalPayload = z.infer<typeof ApprovalPayload>;

export const QuestionPayload = z.object({
  kind: z.literal("question"),
  question: z.string(),
  options: z.array(z.string()),
});
export type QuestionPayload = z.infer<typeof QuestionPayload>;

export const FileChange = z.object({ path: z.string(), added: z.number(), removed: z.number() });
export type FileChange = z.infer<typeof FileChange>;

export const ReviewPayload = z.object({
  kind: z.literal("review"),
  outcome: z.enum(["done", "failed"]),
  summary: z.string(),
  files: z.array(FileChange),
  branch: z.string().nullable(),
  /** Actions offered for this result, e.g. Open PR. */
  actions: z.array(PluginAction),
  /**
   * Short plain sentences about things that happened during the task and that the summary may not mention,
   * e.g. "Wanted network access to example.com; it stayed blocked." Shown under the summary.
   */
  notes: z.array(z.string()).default([]),
});
export type ReviewPayload = z.infer<typeof ReviewPayload>;

export const RequestPayload = z.discriminatedUnion("kind", [ApprovalPayload, QuestionPayload, ReviewPayload]);
export type RequestPayload = z.infer<typeof RequestPayload>;
export type RequestKind = RequestPayload["kind"];

export const RequestAnswer = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    decision: z.enum(["approve", "deny"]),
    note: z.string().optional(),
    /** Only honoured when the request has canAllowPermanently. */
    allowPermanently: z.boolean().optional(),
    /** With decision "deny" on a request that has canDenyForTask: deny every further request of this kind in the task without asking. */
    denyForTask: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("question"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("review"),
    decision: z.enum(["action", "changes", "discard"]),
    /** Required when decision is "action". */
    actionId: z.string().optional(),
    /** Required when decision is "changes". */
    text: z.string().optional(),
  }),
]);
export type RequestAnswer = z.infer<typeof RequestAnswer>;

export const RequestState = z.enum(["open", "answered", "cancelled"]);
export type RequestState = z.infer<typeof RequestState>;

export const Request = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  state: RequestState,
  createdAt: z.number(),
  closedAt: z.number().nullable(),
  payload: RequestPayload,
  answer: RequestAnswer.nullable(),
});
export type Request = z.infer<typeof Request>;

// ---------------------------------------------------------------------------
// Task events: an append-only log per task, ordered by seq
// ---------------------------------------------------------------------------

const eventBase = { taskId: z.string(), seq: z.number().int(), at: z.number() };

export const TaskEvent = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("instruction"), text: z.string() }),
  /** clientId echoes the requestId of the command that sent it, so the client can match its optimistic copy. */
  z.object({ ...eventBase, type: z.literal("user_message"), text: z.string(), clientId: z.string().nullable() }),
  /** Streamed agent text. Deltas with the same messageId concatenate in seq order. */
  z.object({ ...eventBase, type: z.literal("agent_text"), messageId: z.string(), delta: z.string() }),
  z.object({ ...eventBase, type: z.literal("step_started"), stepId: z.string(), label: z.string(), detail: z.string().nullable() }),
  z.object({ ...eventBase, type: z.literal("step_finished"), stepId: z.string(), ok: z.boolean(), detail: z.string().nullable() }),
  /** A running step moved on: its label becomes `label`, and `detail` (for example "2 of 3") replaces its detail. Clients that do not know this event keep the step's first label. */
  z.object({ ...eventBase, type: z.literal("step_progress"), stepId: z.string(), label: z.string(), detail: z.string().nullable() }),
  z.object({ ...eventBase, type: z.literal("request_opened"), requestId: z.string() }),
  z.object({ ...eventBase, type: z.literal("request_closed"), requestId: z.string() }),
  z.object({ ...eventBase, type: z.literal("state_changed"), state: TaskState }),
  /** The server restarted and the task picked up where it stopped. */
  z.object({ ...eventBase, type: z.literal("resumed") }),
]);
export type TaskEvent = z.infer<typeof TaskEvent>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** An event before the server stamps taskId, seq and at. */
export type TaskEventInput = DistributiveOmit<TaskEvent, "taskId" | "seq" | "at">;

// ---------------------------------------------------------------------------
// Sync: snapshot + one global ordered stream of ops
// ---------------------------------------------------------------------------

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
});
export type Device = z.infer<typeof Device>;

export const Snapshot = z.object({
  contractVersion: z.number(),
  /** Every op with rev <= this is already reflected in the snapshot. */
  rev: z.number().int(),
  serverTime: z.number(),
  device: Device,
  projects: z.array(Project),
  tasks: z.array(Task),
  /** Open requests plus recently closed ones. */
  requests: z.array(Request),
});
export type Snapshot = z.infer<typeof Snapshot>;

const opBase = { rev: z.number().int() };
export const StreamOp = z.discriminatedUnion("op", [
  z.object({ ...opBase, op: z.literal("project_upsert"), project: Project }),
  z.object({ ...opBase, op: z.literal("task_upsert"), task: Task }),
  z.object({ ...opBase, op: z.literal("task_event"), event: TaskEvent }),
  z.object({ ...opBase, op: z.literal("request_upsert"), request: Request }),
]);
export type StreamOp = z.infer<typeof StreamOp>;

/**
 * WebSocket at routes.stream, opened with ?after=<rev>.
 * The server replays ops after that rev, then sends new ones as they happen.
 * "resync" means the rev is too old: refetch the snapshot and reconnect.
 * The server pings every 25 seconds; the client answers with pong.
 */
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ops"), ops: z.array(StreamOp) }),
  z.object({ type: z.literal("resync") }),
  z.object({ type: z.literal("ping") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.object({ type: z.literal("pong") });
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// Commands. Every command carries a client-generated requestId; the server
// treats a repeated requestId as the same command and returns the first result.
// ---------------------------------------------------------------------------

const commandBase = { requestId: z.string().min(8) };

export const CreateTaskBody = z.object({ ...commandBase, projectId: z.string(), instruction: z.string().min(1) });
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;
export const CreateTaskResponse = z.object({ task: Task });
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>;

export const SendMessageBody = z.object({ ...commandBase, text: z.string().min(1) });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const StopTaskBody = z.object({ ...commandBase });
export type StopTaskBody = z.infer<typeof StopTaskBody>;

/** Fails with "request_closed" (409) when the request is no longer open. */
export const AnswerRequestBody = z.object({ ...commandBase, answer: RequestAnswer });
export type AnswerRequestBody = z.infer<typeof AnswerRequestBody>;
export const AnswerRequestResponse = z.object({ request: Request });
export type AnswerRequestResponse = z.infer<typeof AnswerRequestResponse>;

export const TaskEventsResponse = z.object({ events: z.array(TaskEvent) });
export type TaskEventsResponse = z.infer<typeof TaskEventsResponse>;

/**
 * The diff of one changed file of a task, against the branch the task started from.
 * Fetched on demand and never part of the snapshot or the op stream, so file content
 * does not sit in the phone's cache.
 */
export const TaskDiff = z.object({
  path: z.string(),
  /** True for binary files; patch is then empty. */
  binary: z.boolean(),
  /** Unified diff text: hunk headers (@@ ... @@) and lines starting with " ", "+" or "-". No file header lines. */
  patch: z.string(),
  /** True when the patch was cut at the line limit. Ask again with ?full=1 for the rest. */
  truncated: z.boolean(),
});
export type TaskDiff = z.infer<typeof TaskDiff>;

// ---------------------------------------------------------------------------
// Devices, pairing and push
// ---------------------------------------------------------------------------

export const PairBody = z.object({ code: z.string().min(4), deviceName: z.string().min(1).max(60) });
export type PairBody = z.infer<typeof PairBody>;
export const SessionResponse = z.object({ device: Device, contractVersion: z.number() });
export type SessionResponse = z.infer<typeof SessionResponse>;
export const DevicesResponse = z.object({ devices: z.array(Device) });
export type DevicesResponse = z.infer<typeof DevicesResponse>;

/** A model the agent can run on. Only models of providers the home machine is logged in to are listed. */
export const ModelInfo = z.object({
  /** Provider id as Pi knows it, e.g. "anthropic", "openrouter". */
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().nullable(),
  /** US dollars per million tokens, when the provider lists a price. */
  inputCost: z.number().nullable(),
  outputCost: z.number().nullable(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ModelRef = z.object({ provider: z.string(), id: z.string() });
export type ModelRef = z.infer<typeof ModelRef>;

/**
 * `current` is what new tasks run on, or null when no usable model is configured (nobody is logged in to a provider).
 * `source` says where it comes from: chosen in telepi, or Pi's own default on the home machine.
 */
export const ModelsResponse = z.object({
  current: ModelRef.nullable(),
  source: z.enum(["telepi", "pi", "env"]).nullable(),
  available: z.array(ModelInfo),
  /** Why no model can be used for new tasks, in words for the person; null or absent when one can. */
  problem: z.string().nullable().optional(),
});
export type ModelsResponse = z.infer<typeof ModelsResponse>;

/** Chooses the model for new tasks. Running tasks keep theirs. `model: null` goes back to Pi's default. */
export const SetModelBody = z.object({ ...commandBase, model: ModelRef.nullable() });
export type SetModelBody = z.infer<typeof SetModelBody>;

export const PushKeyResponse = z.object({ publicKey: z.string() });
export type PushKeyResponse = z.infer<typeof PushKeyResponse>;
export const PushSubscribeBody = z.object({
  subscription: z.object({
    /** A push service's address. Always https: the server posts to it. */
    endpoint: z.string().url().startsWith("https://"),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBody>;

/** What a push notification carries. No task content: only enough to say what is waiting and where to go. */
export const PushPayload = z.object({
  kind: z.enum(["approval", "question", "review", "failed"]),
  projectName: z.string(),
  taskId: z.string(),
  requestId: z.string().nullable(),
  /** Path to open in the app, e.g. "/requests/abc". */
  url: z.string(),
  /** Number of open requests, for the app badge. */
  badge: z.number().int(),
});
export type PushPayload = z.infer<typeof PushPayload>;

// ---------------------------------------------------------------------------
// Errors and routes
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum([
  "unauthenticated", // 401: no valid device session; the app shows pairing
  "bad_pairing_code", // 401
  "rate_limited", // 429
  "invalid", // 400
  "not_found", // 404
  "request_closed", // 409
  "internal", // 500
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({ error: ErrorCode, message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const routes = {
  session: "/api/session", // GET
  pair: "/api/pair", // POST PairBody -> SessionResponse, sets the session cookie
  devices: "/api/devices", // GET -> DevicesResponse
  device: (id: string) => `/api/devices/${id}`, // DELETE
  snapshot: "/api/snapshot", // GET -> Snapshot
  stream: "/api/stream", // WebSocket, ?after=<rev>
  tasks: "/api/tasks", // POST CreateTaskBody -> CreateTaskResponse
  taskEvents: (id: string) => `/api/tasks/${id}/events`, // GET ?after=<seq> -> TaskEventsResponse
  taskMessages: (id: string) => `/api/tasks/${id}/messages`, // POST SendMessageBody
  taskStop: (id: string) => `/api/tasks/${id}/stop`, // POST StopTaskBody
  taskDiff: (id: string) => `/api/tasks/${id}/diff`, // GET ?path=<file>&full=1 -> TaskDiff; not_found for an unknown file
  requestAnswer: (id: string) => `/api/requests/${id}/answer`, // POST AnswerRequestBody -> AnswerRequestResponse
  models: "/api/models", // GET -> ModelsResponse; POST SetModelBody -> ModelsResponse
  pushKey: "/api/push/key", // GET -> PushKeyResponse
  pushSubscription: "/api/push/subscription", // POST PushSubscribeBody, DELETE { endpoint }
} as const;

// ---------------------------------------------------------------------------
// Decision records: one per tool call that reached the decision pipeline.
// Kept server-side; they are the data used later to evaluate model judges.
// ---------------------------------------------------------------------------

export const DecisionRecord = z.object({
  at: z.number(),
  taskId: z.string(),
  projectId: z.string(),
  call: z.object({ kind: z.enum(["shell", "action"]), text: z.string(), actionId: z.string().nullable() }),
  outcome: z.enum(["run", "ask", "block"]),
  /** Which stage decided: "rules", "patterns", or a judge name. */
  stage: z.string(),
  reasonCode: z.string(),
  userDecision: z.enum(["approve", "deny"]).nullable(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
