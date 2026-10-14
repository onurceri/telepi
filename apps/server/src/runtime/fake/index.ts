// The fake agent runtime: plays scripted scenarios so the whole product works without a real agent.
import type { Task } from "@telepi/contract";
import type { AgentRuntime, RuntimeHost } from "../types";
import { resumedFiles, scenarioFiles } from "./diffs";
import { Stopped, TaskRun } from "./engine";
import { keptReview, resumedTail, scenarios } from "./scenarios";

/**
 * The scenario for a task depends only on data that is persisted (its instruction and id), so the same
 * task maps to the same scenario after a server restart. That is what lets diffs resolve later.
 */
function pick(task: Pick<Task, "id" | "instruction">) {
  const text = task.instruction.toLowerCase();
  const hit = scenarios.find((s) => s.keywords.some((k) => text.includes(k)));
  if (hit) return hit;
  let h = 0;
  for (const ch of task.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return scenarios[h % scenarios.length]!;
}

/**
 * `getTask` looks up a persisted task; the server core passes it so diffs can be answered after a restart,
 * when the in-memory runs are gone.
 */
export function createFakeRuntime(host: RuntimeHost, getTask: (taskId: string) => Task | undefined = () => undefined): AgentRuntime {
  const runs = new Map<string, TaskRun>();

  return {
    start(task, opts) {
      runs.get(task.id)?.cancel();
      const run = new TaskRun(host, task);
      runs.set(task.id, run);
      const script = opts.review ? keptReview(opts.review) : opts.resumed ? resumedTail : pick(task).run;

      if (!opts.review) host.patchTask(task.id, { state: "running", currentStep: opts.resumed ? "Picking the work back up" : "Starting" });
      script(run)
        .catch(async (e: unknown) => {
          if (e instanceof Stopped || run.cancelled) return;
          host.patchTask(task.id, { state: "failed", currentStep: null });
          await run.say(`Something went wrong on my side: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
        })
        .finally(() => {
          run.cancel();
          if (runs.get(task.id) === run) runs.delete(task.id);
        });
    },

    message(taskId, text) {
      const run = runs.get(taskId);
      if (!run) return;
      const quote = text.trim().replace(/\s+/g, " ");
      const short = quote.length > 80 ? `${quote.slice(0, 77)}...` : quote;
      run.say(`Noted: "${short}". I'll keep that in mind as I continue.`).catch(() => {});
    },

    stop(taskId) {
      const run = runs.get(taskId);
      if (!run) return;
      run.cancel();
      runs.delete(taskId);
    },

    async diff(taskId, path) {
      const task = getTask(taskId);
      if (!task) return null;
      // A resumed task ends with the generic tail, so its files are valid for any task.
      const file = scenarioFiles[pick(task).name]?.[path] ?? resumedFiles[path];
      return file ? { binary: file.binary, patch: file.patch } : null;
    },
  };
}
