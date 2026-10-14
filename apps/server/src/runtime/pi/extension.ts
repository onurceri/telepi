// The Pi Durable extension telepi installs next to the coding tools: the extra tools, the system prompt, and the hook
// that puts the approvals in front of the tool calls that need them.
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type, type ToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask, type HookApi } from "@earendil-works/pi-durable";
import { systemPrompt } from "./options";

/** What the tools and the hook need from the task a conversation belongs to. */
export interface ToolSession {
  /** Asks the user; null when the task was stopped. */
  askUser(question: string, options: string[]): Promise<string | null>;
  /** The decision pipeline for one tool call. Resolves with a block message, or undefined to let the call run. */
  guard(call: ToolCall, api: HookApi, context: Context): Promise<{ block: string } | undefined>;
  openPullRequest(title: string, body: string): Promise<string>;
  reportFailure(reason: string): void;
}

export type SessionLookup = (conversationId: number) => ToolSession | undefined;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
/** The most of AGENTS.md that goes into the prompt. */
const AGENTS_MD_MAX_BYTES = 20_000;

/** The workspace's AGENTS.md, read through the sandbox and cut to a size; null when there is none. */
async function agentsMd(env: ExecutionEnv | undefined, context: Context): Promise<string | null> {
  if (!env) return null;
  let text = "";
  const r = await env.exec(["sh", "-c", `[ -f AGENTS.md ] && head -c ${AGENTS_MD_MAX_BYTES + 1} AGENTS.md`], { onOutput: (chunk, _ctx, info) => { if (info.stream === "stdout") text += chunk; } }, context);
  if (!r.ok || r.value.exitCode !== 0) return null;
  if (!text.trim()) return null;
  return text.length > AGENTS_MD_MAX_BYTES ? `${text.slice(0, AGENTS_MD_MAX_BYTES)}\n[AGENTS.md continues; cut here]` : text;
}

const NO_SESSION = "This task is no longer running.";

export function createTelepiExtension(sessions: SessionLookup, opts: { github: boolean }) {
  const askUser = defineTool({
    name: "ask_user",
    description:
      "Ask the user a question and wait for the answer. Use it only for real ambiguity: a decision that is the user's to make and that you cannot settle by reading the code or the instructions. Never use it to confirm work or ask for permission.",
    parameters: Type.Object({
      question: Type.String({ description: "One short, plain question." }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Suggested answers, if there are a few clear ones." })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const s = sessions(api.conversationId);
      if (!s) return text(NO_SESSION, true);
      const answer = await s.askUser(args.question, args.options ?? []);
      return answer === null ? text("The task was stopped before the user answered.", true) : text(answer);
    },
  });

  const reportFailure = defineTool({
    name: "report_failure",
    description:
      "Record that you could not complete the task, with the exact reason. Call it instead of pretending the work is done, then end with a final message explaining the same to the user.",
    parameters: Type.Object({ reason: Type.String({ description: "Exactly why the task could not be completed." }) }),
    replay: "safe",
    execute: async (args, api) => {
      sessions(api.conversationId)?.reportFailure(args.reason);
      return text("Recorded. Now write your final message to the user: what you did, what is missing, and why.");
    },
  });

  const openPullRequest = defineTool({
    name: "open_pull_request",
    description:
      "Push the task branch to the project's GitHub remote and open a pull request against its default branch. Runs from inside the sandbox with a GitHub token the sandbox's supervisor adds; you never see the token. May need the user's approval. Commit your work first. Only call it when the instruction asks for a pull request.",
    parameters: Type.Object({ title: Type.String(), body: Type.String({ description: "What changed and why, in a few sentences." }) }),
    execute: async (args, api) => {
      const s = sessions(api.conversationId);
      if (!s) return text(NO_SESSION, true);
      try {
        return text(await s.openPullRequest(args.title, args.body));
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  });

  return defineExtension({
    name: "telepi",
    tools: opts.github ? [askUser, reportFailure, openPullRequest] : [askUser, reportFailure],
    sections: [section("preamble", () => systemPrompt(opts), { tag: false }), section("agents_md", async (input, context) => (await agentsMd(input.env, context)) ?? undefined)],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => sessions(api.conversationId)?.guard(call, api, context),
      }),
    ],
  });
}
