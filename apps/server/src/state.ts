// In-memory state, the global op log, and persistence of all of it.
// Stored objects are treated as immutable: every change replaces the object, so ops in the log never change.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Device,
  ModelRef,
  Project,
  Request,
  Task,
  TaskEvent,
  type StreamOp,
  type TaskEventInput,
} from "@telepi/contract";
import type { Persist } from "./persist";

export const DeviceRecord = Device.extend({ tokenHash: z.string() });
export type DeviceRecord = z.infer<typeof DeviceRecord>;

export const SubscriptionRecord = z.object({
  deviceId: z.string(),
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type SubscriptionRecord = z.infer<typeof SubscriptionRecord>;

export const IdempotencyRecord = z.object({ at: z.number(), status: z.number(), body: z.unknown() });
export type IdempotencyRecord = z.infer<typeof IdempotencyRecord>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type OpInput = DistributiveOmit<StreamOp, "rev">;

const MAX_OPS = 5000;
const OPS_SLACK = 500;
/** Added to the persisted rev on boot, so a crash that lost the last debounced write never reuses a rev. */
const REV_BOOT_BUMP = 100;
const RECENT_REQUEST_MS = 24 * 60 * 60 * 1000;

const SEED_PROJECTS = ["storefront", "billing-api", "docs-site"];
/** `repoPath` is server-only (the real agent works in a clone of it); it is never part of a Project sent to clients. */
const StoredProject = Project.partial({ status: true, allowedActions: true }).extend({ repoPath: z.string().optional() });

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export class State {
  projects = new Map<string, Project>();
  /** Absolute path of each project's git repository, from projects.json. */
  repoPaths = new Map<string, string>();
  tasks = new Map<string, Task>();
  private events = new Map<string, TaskEvent[]>();
  requests = new Map<string, Request>();
  devices = new Map<string, DeviceRecord>();
  subscriptions: SubscriptionRecord[] = [];
  idempotency = new Map<string, IdempotencyRecord>();
  /** The model chosen in telepi for new tasks; null means Pi's own default applies. */
  modelChoice: ModelRef | null = null;

  rev: number;
  /** Ops with rev <= floorRev are not in the buffer; a client older than this must resync. */
  floorRev: number;
  private ops: StreamOp[] = [];
  private listeners = new Set<(op: StreamOp) => void>();

  constructor(readonly persist: Persist) {
    const meta = z.object({ rev: z.number().int() }).safeParse(persist.read("meta.json"));
    const persistedRev = meta.success ? meta.data.rev : 0;
    this.floorRev = persistedRev;
    this.rev = persistedRev + REV_BOOT_BUMP;

    const stored = persist.read("projects.json");
    const projects: z.infer<typeof StoredProject>[] = stored === undefined ? SEED_PROJECTS.map((id) => ({ id, name: id })) : z.array(StoredProject).parse(stored);
    for (const { repoPath, ...p } of projects) {
      this.projects.set(p.id, { status: "idle", allowedActions: [], ...p });
      if (repoPath) this.repoPaths.set(p.id, repoPath);
    }
    if (stored === undefined) this.saveProjects();

    for (const t of z.array(Task).parse(persist.read("tasks.json") ?? [])) {
      this.tasks.set(t.id, t);
      this.events.set(t.id, z.array(TaskEvent).parse(persist.read(`events/${t.id}.json`) ?? []));
    }
    for (const r of z.array(Request).parse(persist.read("requests.json") ?? [])) this.requests.set(r.id, r);
    for (const d of z.array(DeviceRecord).parse(persist.read("devices.json") ?? [])) this.devices.set(d.id, d);
    this.subscriptions = z.array(SubscriptionRecord).parse(persist.read("push.json") ?? []);
    const idem = z.record(z.string(), IdempotencyRecord).parse(persist.read("idempotency.json") ?? {});
    for (const [k, v] of Object.entries(idem)) this.idempotency.set(k, v);
    this.modelChoice = ModelRef.nullable().catch(null).parse(persist.read("model.json") ?? null);
    this.prune();
    this.saveMeta();
  }

  // --- ops -----------------------------------------------------------------

  publish(op: OpInput): StreamOp {
    const full = { ...op, rev: ++this.rev } as StreamOp;
    this.ops.push(full);
    if (this.ops.length > MAX_OPS + OPS_SLACK) {
      const dropped = this.ops.splice(0, this.ops.length - MAX_OPS);
      this.floorRev = dropped[dropped.length - 1]!.rev;
    }
    this.saveMeta();
    for (const listener of this.listeners) listener(full);
    return full;
  }

  /** Ops after `rev`, or null when the buffer no longer reaches back that far (or rev is from the future). */
  opsAfter(rev: number): StreamOp[] | null {
    if (rev < this.floorRev || rev > this.rev) return null;
    return this.ops.filter((op) => op.rev > rev);
  }

  subscribe(listener: (op: StreamOp) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- projects ------------------------------------------------------------

  putProject(project: Project): void {
    this.projects.set(project.id, project);
    this.saveProjects();
    this.publish({ op: "project_upsert", project });
  }

  /** Recompute a project's derived status and emit an op if it changed. */
  refreshProject(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    let waiting = false;
    let running = false;
    for (const r of this.requests.values()) if (r.projectId === projectId && r.state === "open") waiting = true;
    for (const t of this.tasks.values()) if (t.projectId === projectId && t.state === "running") running = true;
    const status = waiting ? "waiting" : running ? "running" : "idle";
    if (status !== project.status) this.putProject({ ...project, status });
  }

  /** Called once at boot, before anything is connected: bring stored statuses in line without emitting ops. */
  recomputeProjectStatuses(): void {
    for (const id of this.projects.keys()) this.refreshProject(id);
  }

  // --- tasks and events ----------------------------------------------------

  putTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.persist.schedule("tasks.json", () => [...this.tasks.values()]);
    this.publish({ op: "task_upsert", task });
    this.refreshProject(task.projectId);
  }

  taskEvents(taskId: string): TaskEvent[] {
    return this.events.get(taskId) ?? [];
  }

  appendEvent(taskId: string, input: TaskEventInput): TaskEvent {
    const log = this.events.get(taskId) ?? [];
    this.events.set(taskId, log);
    const event = { ...input, taskId, seq: (log[log.length - 1]?.seq ?? 0) + 1, at: Date.now() } as TaskEvent;
    log.push(event);
    this.persist.schedule(`events/${taskId}.json`, () => this.events.get(taskId) ?? []);
    this.publish({ op: "task_event", event });
    return event;
  }

  // --- requests ------------------------------------------------------------

  putRequest(request: Request): void {
    this.requests.set(request.id, request);
    this.persist.schedule("requests.json", () => [...this.requests.values()]);
    this.publish({ op: "request_upsert", request });
    this.refreshProject(request.projectId);
  }

  openRequestCount(taskId?: string): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.state === "open" && (!taskId || r.taskId === taskId)) n++;
    return n;
  }

  snapshotRequests(): Request[] {
    const cutoff = Date.now() - RECENT_REQUEST_MS;
    return [...this.requests.values()].filter((r) => r.state === "open" || (r.closedAt ?? 0) > cutoff);
  }

  newId = newId;

  // --- devices, push, idempotency -----------------------------------------

  saveDevices(): void {
    this.persist.schedule("devices.json", () => [...this.devices.values()]);
  }
  saveSubscriptions(): void {
    this.persist.schedule("push.json", () => this.subscriptions);
  }
  saveIdempotency(): void {
    this.persist.schedule("idempotency.json", () => Object.fromEntries(this.idempotency));
  }
  saveProjects(): void {
    this.persist.schedule("projects.json", () =>
      [...this.projects.values()].map((p) => (this.repoPaths.has(p.id) ? { ...p, repoPath: this.repoPaths.get(p.id) } : p)),
    );
  }
  setModelChoice(model: ModelRef | null): void {
    this.modelChoice = model;
    this.persist.schedule("model.json", () => this.modelChoice);
  }
  private saveMeta(): void {
    this.persist.schedule("meta.json", () => ({ rev: this.rev }));
  }

  /** Drop idempotency results older than 24 h and requests closed longer ago than that. */
  prune(): void {
    const cutoff = Date.now() - RECENT_REQUEST_MS;
    for (const [k, v] of this.idempotency) if (v.at < cutoff) this.idempotency.delete(k);
    for (const [k, r] of this.requests) if (r.state !== "open" && (r.closedAt ?? 0) < cutoff) this.requests.delete(k);
    this.saveIdempotency();
    this.persist.schedule("requests.json", () => [...this.requests.values()]);
  }
}
