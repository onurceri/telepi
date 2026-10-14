// The one Pi Durable harness of the server: Pi's models and login, SQLite storage, the tools, the sandbox env.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createTelepiExtension, type SessionLookup } from "./extension";
import type { PiOptions } from "./options";

export async function openHarness(
  options: PiOptions,
  sessions: SessionLookup,
  envFor: (conversationId: number) => Promise<ExecutionEnv | undefined>,
): Promise<Harness> {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(createTelepiExtension(sessions, { github: options.github !== null }));
  // Loaded extensions come after telepi's own. One that reuses an installed name would replace it, so it is left out.
  for (const extension of options.extensions) {
    if (registry.snapshot().extension(extension.name)) {
      console.warn(`telepi: extension "${extension.name}" has the name of one that is already installed; skipped`);
      continue;
    }
    registry.install(extension);
  }

  const dir = path.join(options.dataDir, "pi");
  await mkdir(dir, { recursive: true });
  return Harness.open(
    await openNodeSqliteStorage(path.join(dir, "session.sqlite")),
    {
      models: options.catalog.models,
      registry,
      env: ({ conversationId }) => envFor(Number(conversationId)),
      settings: { toolExecution: "sequential", stream: { timeoutMs: 180_000 } },
      onReport: (error) => console.warn("telepi: pi-durable report:", error instanceof Error ? error.message : error),
    },
    BACKGROUND_CONTEXT,
  );
}
