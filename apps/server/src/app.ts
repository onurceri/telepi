// Builds the Fastify instance: plugins, session hook, error shape, routes, static app.
import fs from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { ApiError } from "@telepi/contract";
import { SESSION_COOKIE } from "./auth";
import { HttpError } from "./http";
import { LOCAL_PREFIX, registerLocal } from "./local";
import { registerRoutes, type Deps } from "./routes";
import type { DeviceRecord } from "./state";
import { isAllowedOrigin } from "./stream";

declare module "fastify" {
  interface FastifyRequest {
    device: DeviceRecord | null;
  }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config, auth } = deps;
  const app = Fastify({ logger: { level: "warn" } });

  // An empty body with a JSON content type (e.g. DELETE from fetch) is just "no body".
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError("invalid", "Body is not valid JSON."), undefined);
    }
  });

  await app.register(cookie);
  await app.register(websocket);

  app.decorateRequest("device", null);
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    // A page on another site must not be able to act with this device's session. The cookie is SameSite=Lax already;
    // this is the second lock. Non-browser clients send no Origin and still need the cookie.
    if (req.method !== "GET" && req.method !== "HEAD" && !isAllowedOrigin(req.headers.origin, config)) throw new HttpError("invalid", "Origin not allowed.");
    // The CLI endpoints have their own guard (local.ts): no device session.
    if (path === "/api/pair" || path.startsWith(LOCAL_PREFIX)) return;
    const device = auth.authenticate(req.cookies[SESSION_COOKIE]);
    if (!device) throw new HttpError("unauthenticated", "Pair this device first.");
    req.device = device;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send(err.toBody());
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const body: ApiError = { error: status === 404 ? "not_found" : "invalid", message: err.message };
      return reply.code(status).send(body);
    }
    app.log.error(err);
    const body: ApiError = { error: "internal", message: "Internal error." };
    return reply.code(500).send(body);
  });

  const deviceOf = (req: FastifyRequest): DeviceRecord => {
    if (!req.device) throw new HttpError("unauthenticated", "Pair this device first.");
    return req.device;
  };
  registerRoutes(app, deps, deviceOf);
  registerLocal(app, deps, deps.localToken);

  const hasWeb = fs.existsSync(config.webDist);
  if (hasWeb) await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (hasWeb && req.method === "GET" && !path.startsWith("/api/") && path !== "/api") return reply.sendFile("index.html");
    const body: ApiError = { error: "not_found", message: "Not found." };
    return reply.code(404).send(body);
  });

  return app;
}
