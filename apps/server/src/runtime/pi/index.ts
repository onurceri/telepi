// The Pi runtime: real tasks with a real model inside an OpenShell sandbox, behind the AgentRuntime seam.
import path from "node:path";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { Task } from "@telepi/contract";
import type { AgentRuntime, RuntimeHost } from "../types";
import { fileDiff, git, hostView, isSha } from "./git";
import { openHarness } from "./harness";
import type { ToolSession } from "./extension";
import type { PiOptions } from "./options";
import { TaskSession, type SessionCore } from "./session";
import { MetaStore } from "./store";

export type { PiOptions } from "./options";

export interface PiRuntime extends AgentRuntime {
  /** Closes the harness and removes the sandboxes. Tasks stay as they are and resume on the next start. */
  close(): Promise<void>;
}

export function createPiRuntime(host: RuntimeHost, options: PiOptions): PiRuntime {
  const store = new MetaStore(path.join(options.dataDir, "pi"));
  const sessions = new Map<string, TaskSession>();
  const byConversation = (id: number): TaskSession | undefined => [...sessions.values()].find((s) => s.conversationId === id);
  let closing = false;

  let harness: Promise<Harness> | undefined;
  const core: SessionCore = {
    options,
    host,
    store,
    closing: () => closing,
    harness: () => {
      harness ??= (async () => {
        await options.backend.prepare();
        return openHarness(options, (id) => byConversation(id) as ToolSession | undefined, async (id) => byConversation(id)?.env());
      })();
      return harness;
    },
  };

  return {
    start(task: Task, opts) {
      sessions.get(task.id)?.stop();
      const session = new TaskSession(core, task);
      sessions.set(task.id, session);
      if (opts.resumed) session.adopt();
      void session.begin(opts.resumed, opts.review).finally(() => {
        if (sessions.get(task.id) === session) sessions.delete(task.id);
      });
    },

    message(taskId, text) {
      sessions.get(taskId)?.message(text);
    },

    stop(taskId) {
      sessions.get(taskId)?.stop();
    },

    async diff(taskId, file) {
      const meta = store.get(taskId);
      if (!meta) return null;
      // While the task's sandbox lives, git runs in it. After that (a finished task, a restart) it runs in a view that
      // telepi owns, at the commit recorded when the work went to review.
      const live = sessions.get(taskId)?.gitRunner();
      if (live) return fileDiff(live, meta.base, meta.head ?? "HEAD", file);
      let head = meta.head;
      if (!head) {
        // A task from before the commit was recorded: ask the clone, with the options that stop it running its own config.
        const r = await git(meta.workspace, ["rev-parse", "--verify", `refs/heads/${meta.branch}`]);
        head = r.stdout.trim();
      }
      if (!isSha(head)) return null;
      const view = await hostView({ dataDir: options.dataDir, taskId, workspace: meta.workspace });
      return fileDiff(view.run, meta.base, head, file);
    },

    models: () => options.catalog.response(),

    async close() {
      closing = true;
      const live = [...sessions.values()]; // runs unwind and leave the map as soon as the harness closes
      // Close the harness first, so running tools are interrupted (and resume as such) rather than killed under their
      // feet. A tool waiting on the user never returns, so give it a few seconds.
      const h = await harness?.catch(() => undefined);
      await Promise.race([h?.close(CTX).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      await Promise.all(live.map((s) => s.shutdown()));
    },
  };
}
