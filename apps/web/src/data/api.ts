// The seam between the screens and the data layer.
// Screens import only from this file. Two implementations exist behind it:
// the live one (src/data/live) talks to the server, the mock one (src/data/mock) serves sample data.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Device, ModelInfo, ModelRef, ModelsResponse, Project, Request, RequestAnswer, Task, TaskDiff, TaskEvent, TaskUsage } from "@telepi/contract";

export type Connection =
  | "connecting" // first load, nothing known yet
  | "online"
  | "unreachable" // the home machine cannot be reached; state shown is from cache
  | "unauthenticated"; // no valid device session; show pairing

/** Something the user sent while unreachable. Sent in order on reconnect. Approvals are never queued. */
export interface OutboxItem {
  id: string;
  kind: "task" | "message";
  projectId: string;
  taskId: string | null;
  text: string;
  createdAt: number;
}

/** A queued item the server refused when it was finally sent. Kept until the user dismisses it. */
export interface RejectedItem {
  item: OutboxItem;
  /** Why the server refused it, in words fit to show. */
  message: string;
  rejectedAt: number;
}

export type PushState =
  | "unsupported"
  | "needs-install" // iOS: the app must be added to the home screen first
  | "default" // permission not asked yet
  | "granted"
  | "denied";

export interface AppState {
  connection: Connection;
  /** When the state shown was last confirmed by the server. */
  lastSyncedAt: number | null;
  device: Device | null;
  projects: Project[];
  tasks: Task[];
  /** Open requests plus recently closed ones. */
  requests: Request[];
  outbox: OutboxItem[];
  /** Queued items the server refused. Persisted like the outbox. */
  rejected: RejectedItem[];
  push: PushState;
  /** A newer version of the app is downloaded and waiting. */
  updateReady: boolean;
}

export type Result<T = undefined> =
  | { ok: true; value: T }
  /** error is an ErrorCode from the contract, or "offline" when the server could not be reached. */
  | { ok: false; error: string; message: string };

export interface TaskEventsHandle {
  /** Events in seq order, including optimistic user messages not yet confirmed. Stable reference until it changes. */
  getEvents(): TaskEvent[];
  subscribe(listener: () => void): () => void;
}

export interface DataApi {
  /** Returns the same object reference until something changes. */
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  /** Loads the task's events (cache first) and keeps them live while subscribed. */
  taskEvents(taskId: string): TaskEventsHandle;

  pair(code: string, deviceName: string): Promise<Result<Device>>;
  /** Queued in the outbox when unreachable. */
  createTask(projectId: string, instruction: string): Promise<Result<{ taskId: string | null; queued: boolean }>>;
  /** Queued in the outbox when unreachable. */
  sendMessage(taskId: string, text: string): Promise<Result<{ queued: boolean }>>;
  stopTask(taskId: string): Promise<Result>;
  /** Never queued: fails with error "offline" unless the connection is online. */
  answerRequest(requestId: string, answer: RequestAnswer): Promise<Result>;
  /** Removes a rejected item by its OutboxItem id. */
  dismissRejected(id: string): void;
  /**
   * The diff of one changed file of a task. Fetched every time and never cached on the device.
   * Fails with error "offline" unless the connection is online.
   */
  getDiff(taskId: string, path: string, opts?: { full?: boolean }): Promise<Result<TaskDiff>>;
  /** The models the agent can run on and the current choice. Never cached: fails with error "offline" unless the connection is online. */
  getModels(): Promise<Result<ModelsResponse>>;
  /** Chooses the model for new tasks; null clears telepi's choice (back to Pi's default). Never queued, like getModels. */
  setModel(model: ModelRef | null): Promise<Result<ModelsResponse>>;
  enablePush(): Promise<Result>;
  /** Try to reconnect now instead of waiting for the next retry. */
  retryNow(): void;
  /** Switch to the waiting version of the app. Reloads the page. */
  applyUpdate(): void;
}

export const DataContext = createContext<DataApi | null>(null);

export function useData(): DataApi {
  const api = useContext(DataContext);
  if (!api) throw new Error("DataContext is missing");
  return api;
}

/** Select a slice of state. The selector must return a value that is stable while the state object is unchanged. */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const api = useData();
  return useSyncExternalStore(api.subscribe, () => selector(api.getState()));
}

export function useTaskEvents(taskId: string): TaskEvent[] {
  const handle = useData().taskEvents(taskId);
  return useSyncExternalStore(handle.subscribe, handle.getEvents);
}

export type { Device, ModelInfo, ModelRef, ModelsResponse, Project, Request, RequestAnswer, Task, TaskDiff, TaskEvent, TaskUsage };
