// Entry point: load state, start the runtime, listen on loopback.
import { Auth, printPairingCode } from "./auth";
import { buildApp } from "./app";
import { Commands } from "./commands";
import { loadConfig } from "./config";
import { Host } from "./host";
import { writeLocalToken } from "./local";
import { Persist } from "./persist";
import { Push } from "./push";
import { createFakeRuntime } from "./runtime/fake";
import { createPiRuntime } from "./runtime/pi";
import { loadExtensions } from "./runtime/pi/extensions";
import { ModelCatalog } from "./runtime/pi/models";
import { checkGateway, openshellBackend } from "./runtime/pi/openshell";
import type { KeptReview } from "./runtime/types";
import { State } from "./state";
import { Stream } from "./stream";

const config = loadConfig();
const persist = new Persist(config.dataDir);
const state = new State(persist);
const auth = new Auth(state);
const push = new Push(state, config);
const host = new Host(state, push);
// The real agent needs OpenShell and a model: fail now, with a clear message, if the gateway is not there.
let piRuntime: ReturnType<typeof createPiRuntime> | null = null;
if (config.runtime === "pi") {
  const catalog = new ModelCatalog(config.piDir, () => state.modelChoice, config.model);
  catalog.refreshInBackground();
  const backend = openshellBackend(await checkGateway(config.openshellGateway, config.openshellTls), config.github);
  piRuntime = createPiRuntime(host, {
    dataDir: config.dataDir, maxTurns: config.maxTurns, repoPath: (projectId) => state.repoPaths.get(projectId),
    backend, workspacesDir: config.workspacesDir, remotesDir: config.remotesDir, catalog,
    askPatterns: config.askPatterns, github: config.github, extensions: await loadExtensions(config.dataDir),
  });
}
const runtime = piRuntime ?? createFakeRuntime(host, (id) => state.tasks.get(id));
console.log(`telepi runtime: ${config.runtime}${piRuntime ? ` (Pi home ${config.piDir}${config.github ? ", GitHub token set" : ""}${config.askPatterns ? ", asking on command patterns" : ""})` : ""}`);
const commands = new Commands(state, host, runtime);
const stream = new Stream(state, config);

// Restart: requests that were open have lost their promises; running tasks pick up where they stopped.
// The review of a finished task is the exception: nothing is running behind it, so it stays open as it is and the
// runtime waits on it again.
state.recomputeProjectStatuses();
const keptReviews = new Map<string, KeptReview>();
// Finished tasks caught in the middle of something chosen from their review (an approval to open a pull request, say).
const midAction = new Set<string>();
for (const request of state.requests.values()) {
  const task = state.tasks.get(request.taskId);
  if (request.state !== "open" || !task || (task.state !== "done" && task.state !== "failed")) continue;
  if (request.payload.kind === "review") keptReviews.set(task.id, { requestId: request.id, payload: request.payload });
  else midAction.add(task.id);
}
host.cancelRequests(undefined, new Set([...keptReviews.values()].map((r) => r.requestId)));
for (const task of [...state.tasks.values()]) {
  const review = keptReviews.get(task.id);
  if (review) {
    commands.startInRuntime(task, true, review);
    continue;
  }
  if (task.state !== "running" && task.state !== "waiting" && !midAction.has(task.id)) continue;
  state.appendEvent(task.id, { type: "resumed" });
  if (task.state === "waiting") host.patchTask(task.id, { state: "running" });
  commands.startInRuntime(state.tasks.get(task.id)!, true);
}

const app = await buildApp({ config, state, auth, push, commands, stream, runtime, localToken: writeLocalToken(config.dataDir) });
await app.listen({ port: config.port, host: config.host });
console.log(`telepi server listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);

if (state.devices.size === 0 || config.forcePair) printPairingCode(auth.newPairingCode());

setInterval(() => state.prune(), 60 * 60 * 1000).unref();

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  stream.closeAll();
  await app.close().catch(() => {});
  await runtime.close?.().catch(() => {});
  persist.flush();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
