// HTTP routes under /api.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AnswerRequestBody,
  CONTRACT_VERSION,
  CreateTaskBody,
  PairBody,
  PushSubscribeBody,
  SendMessageBody,
  SetModelBody,
  StopTaskBody,
  TaskDiff,
  routes,
  type DevicesResponse,
  type ModelsResponse,
  type PushKeyResponse,
  type SessionResponse,
  type Snapshot,
  type TaskEventsResponse,
} from "@telepi/contract";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, publicDevice, type Auth } from "./auth";
import type { Commands } from "./commands";
import type { Config } from "./config";
import { HttpError, parseBody } from "./http";
import { idempotent, idempotentAsync } from "./idempotency";
import type { AgentRuntime } from "./runtime/types";
import type { Push } from "./push";
import type { State } from "./state";
import type { Stream } from "./stream";

export interface Deps {
  config: Config;
  state: State;
  auth: Auth;
  push: Push;
  commands: Commands;
  stream: Stream;
  runtime: AgentRuntime;
  /** Secret of the CLI-only endpoints (local.ts). */
  localToken: string;
}

const UnsubscribeBody = z.object({ endpoint: z.string() });
const DiffQuery = z.object({ path: z.string().min(1), full: z.string().optional() });
const DIFF_LINES = 400;
const DIFF_LINES_FULL = 5000;
const AfterQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

export function registerRoutes(app: FastifyInstance, deps: Deps, deviceOf: (req: FastifyRequest) => import("./state").DeviceRecord): void {
  const { config, state, auth, push, commands, stream, runtime } = deps;

  const send = (reply: FastifyReply, r: { status: number; body: unknown }) => reply.code(r.status).send(r.body);

  app.post(routes.pair, async (req, reply): Promise<SessionResponse> => {
    auth.checkRate(req.ip);
    const body = parseBody(PairBody, req.body);
    const { device, token } = auth.pair(body.code, body.deviceName);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
      secure: config.secureCookies,
    });
    return { device: publicDevice(device), contractVersion: CONTRACT_VERSION };
  });

  app.get(routes.session, async (req): Promise<SessionResponse> => ({
    device: publicDevice(deviceOf(req)),
    contractVersion: CONTRACT_VERSION,
  }));

  app.get(routes.devices, async (): Promise<DevicesResponse> => ({
    devices: [...state.devices.values()].map(publicDevice),
  }));

  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req, reply) => {
    if (!auth.revoke(req.params.id)) throw new HttpError("not_found", "Device not found.");
    stream.closeDevice(req.params.id);
    if (req.params.id === deviceOf(req).id) reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get(routes.snapshot, async (req): Promise<Snapshot> => ({
    contractVersion: CONTRACT_VERSION,
    rev: state.rev,
    serverTime: Date.now(),
    device: publicDevice(deviceOf(req)),
    projects: [...state.projects.values()],
    tasks: [...state.tasks.values()],
    requests: state.snapshotRequests(),
  }));

  stream.register(app, (req) => deviceOf(req).id);

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events", async (req): Promise<TaskEventsResponse> => {
    if (!state.tasks.has(req.params.id)) throw new HttpError("not_found", "Task not found.");
    const { after } = parseBody(AfterQuery, req.query);
    return { events: state.taskEvents(req.params.id).filter((e) => e.seq > after) };
  });

  // Fetched on demand; nothing here is stored or put on the op stream.
  app.get<{ Params: { id: string } }>(routes.taskDiff(":id"), async (req): Promise<TaskDiff> => {
    if (!state.tasks.has(req.params.id)) throw new HttpError("not_found", "Task not found.");
    const { path, full } = parseBody(DiffQuery, req.query);
    const diff = await runtime.diff(req.params.id, path);
    if (!diff) throw new HttpError("not_found", "That file has no changes in this task.");
    const limit = full === "1" ? DIFF_LINES_FULL : DIFF_LINES;
    const lines = diff.binary ? [] : diff.patch.split("\n");
    const truncated = lines.length > limit;
    return TaskDiff.parse({
      path,
      binary: diff.binary,
      patch: diff.binary ? "" : truncated ? lines.slice(0, limit).join("\n") : diff.patch,
      truncated,
    });
  });

  app.get(routes.models, async (): Promise<ModelsResponse> => commands.models());

  app.post(routes.models, async (req, reply) => {
    const body = parseBody(SetModelBody, req.body);
    return send(reply, await idempotentAsync(state, deviceOf(req).id, body.requestId, async () => ({ status: 200, body: await commands.setModel(body) })));
  });

  app.post(routes.tasks, async (req, reply) => {
    const body = parseBody(CreateTaskBody, req.body);
    return send(reply, idempotent(state, deviceOf(req).id, body.requestId, () => ({ status: 201, body: { task: commands.createTask(body) } })));
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages", async (req, reply) => {
    const body = parseBody(SendMessageBody, req.body);
    return send(reply, idempotent(state, deviceOf(req).id, body.requestId, () => {
      commands.sendMessage(req.params.id, body);
      return { status: 200, body: { ok: true } };
    }));
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async (req, reply) => {
    const body = parseBody(StopTaskBody, req.body);
    return send(reply, idempotent(state, deviceOf(req).id, body.requestId, () => {
      commands.stopTask(req.params.id);
      return { status: 200, body: { ok: true } };
    }));
  });

  app.post<{ Params: { id: string } }>("/api/requests/:id/answer", async (req, reply) => {
    const body = parseBody(AnswerRequestBody, req.body);
    return send(reply, idempotent(state, deviceOf(req).id, body.requestId, () => ({
      status: 200,
      body: { request: commands.answerRequest(req.params.id, body) },
    })));
  });

  app.get(routes.pushKey, async (): Promise<PushKeyResponse> => ({ publicKey: push.publicKey }));

  app.post(routes.pushSubscription, async (req, reply) => {
    push.subscribe(deviceOf(req).id, parseBody(PushSubscribeBody, req.body).subscription);
    return reply.code(204).send();
  });

  app.delete(routes.pushSubscription, async (req, reply) => {
    push.unsubscribe(deviceOf(req).id, parseBody(UnsubscribeBody, req.body).endpoint);
    return reply.code(204).send();
  });
}
