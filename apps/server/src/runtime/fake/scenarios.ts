// Scripted scenarios. Every tool call goes through TaskRun.tool, so the decision pipeline is the only gate.
import type { PluginAction, ReviewPayload, TaskUsage } from "@telepi/contract";
import type { KeptReview } from "../types";
import { changesOf, deltaOf, resumedFiles, scenarioFiles } from "./diffs";
import { dur, type TaskRun } from "./engine";

export type Scenario = (t: TaskRun) => Promise<void>;

const OPEN_PR: PluginAction = { id: "github.open_pr", plugin: "github", label: "Open PR", class: "write" };
const GIT_PUSH: PluginAction = { id: "git.push", plugin: "git", label: "Push branch", class: "write" };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

const lower = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

async function setBranch(t: TaskRun, branch?: string) {
  t.host.patchTask(t.id, { branch: branch ?? `agent/${slug(t.task.title || t.task.instruction) || "task"}` });
}

// ---------------------------------------------------------------------------
// Review: the end of every task
// ---------------------------------------------------------------------------

async function review(t: TaskRun, first: Omit<ReviewPayload, "kind" | "branch" | "actions" | "notes"> & { actions?: PluginAction[]; notes?: string[] }, branch: string | null, kept?: string) {
  let payload: ReviewPayload = { kind: "review", branch, actions: [GIT_PUSH, OPEN_PR], notes: [], ...first };
  if (!kept) t.host.patchTask(t.id, { usage: scriptedUsage(t.id) });
  for (;;) {
    t.host.patchTask(t.id, { state: payload.outcome, currentStep: null });
    const answer = await t.ask(payload, kept);
    kept = undefined;
    if (answer.kind !== "review") return;

    if (answer.decision === "discard") {
      await t.say("Understood. I'll leave the branch as it is and stop here.");
      return;
    }

    if (answer.decision === "action") {
      const action = payload.actions.find((a) => a.id === answer.actionId);
      if (!action) {
        await t.say("That action is not available for this result.");
        continue;
      }
      const isPr = action.id === OPEN_PR.id;
      const result = await t.tool({
        call: {
          kind: "action",
          action,
          detail: isPr
            ? `Push ${branch ?? "the task branch"} to origin, then open a pull request into main.`
            : `Push ${branch ?? "the task branch"} to origin.`,
        },
        label: isPr ? "Opened pull request" : "Pushed branch",
        title: action.label,
        target: branch,
        detail: branch,
        doneDetail: isPr ? `#${100 + Math.floor(Math.random() * 90)}` : undefined,
        ms: dur(4500, 6000),
        phases: isPr ? ["Connecting to GitHub", `Pushing ${branch ?? "the branch"}`, "Opening pull request"] : ["Connecting to GitHub", `Pushing ${branch ?? "the branch"}`],
      });
      await t.say(
        result === "ran"
          ? isPr
            ? "The pull request is open and ready for review."
            : "The branch is pushed."
          : `Okay, I won't ${lower(action.label)}.`,
      );
      t.host.patchTask(t.id, { currentStep: null });
      return;
    }

    // Changes requested: a short follow-up, then a new review.
    t.host.patchTask(t.id, { state: "running" });
    const text = (answer.text ?? "").trim() || "your feedback";
    await t.say(`Got it. I'll make this change: ${text.length > 120 ? `${text.slice(0, 117)}...` : text}`);
    await t.step("Applying your changes", { detail: payload.files[0]?.path ?? null, ms: dur(1200, 2400) });
    await t.step("Ran npm test", { doneDetail: "all passed", ms: dur(900, 1600) });
    await t.say("Done. I've updated the branch with that change.");
    payload = {
      ...payload,
      outcome: "done",
      summary: `${payload.summary} Follow-up applied: ${text.length > 80 ? `${text.slice(0, 77)}...` : text}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const webhookRetry: Scenario = async (t) => {
  const branch = "agent/webhook-retry";
  await setBranch(t, branch);
  await t.say("I'll start by reading how the webhook sender handles failures today.");
  await t.step("Read 6 files", { detail: "src/webhooks" });
  await t.say("The sender drops events on 5xx. I'll add exponential backoff with jitter, capped at 5 attempts.");
  await t.step("Edited sender.ts, retry.ts", { detail: deltaOf("src/webhooks/sender.ts", "src/webhooks/retry.ts") });
  await t.tool({ call: { kind: "shell", command: "npm test" }, label: "Ran npm test", detail: "npm test", doneDetail: "42 passed" });
  await t.say("Retries only happen on 5xx and network errors; 4xx fails immediately, except 429, which honours Retry-After.");
  await t.tool({ call: { kind: "shell", command: "npm run test:integration" }, label: "Ran integration tests", detail: "1:12", doneDetail: "18 passed", ms: dur(2000, 3000) });
  await t.say("Everything passes.");

  await review(
    t,
    {
      outcome: "done",
      summary:
        "Added exponential backoff with jitter to the webhook sender. Retries only on 5xx and network errors, up to 5 attempts; 4xx fails immediately. Unit and integration tests pass.",
      files: changesOf(scenarioFiles["webhook-retry"]!),
    },
    branch,
  );
};

const cartQuestion: Scenario = async (t) => {
  const branch = "agent/cart-server-actions";
  await setBranch(t, branch);
  await t.say("I'll look at how the cart is wired today before moving it.");
  await t.step("Read 9 files", { detail: "app/cart, app/api/cart" });
  await t.say("The new server actions cover everything the cart page needs, but the old /api/cart route still has a caller I can't rule out.");
  const answer = await t.ask({
    kind: "question",
    question: "Keep the legacy /api/cart route?",
    options: ["Keep it, forward to the new action", "Remove it", "Keep it unchanged for now"],
  });
  const choice = answer.kind === "question" ? answer.text : "";
  await t.say(`Understood: "${choice}". I'll go ahead on that basis.`);
  await t.step("Edited cart actions", { detail: deltaOf("app/cart/actions.ts", "app/cart/page.tsx") });
  await t.step("Edited app/api/cart/route.ts", { detail: /remove/i.test(choice) ? "deleted" : deltaOf("app/api/cart/route.ts") });
  await t.tool({ call: { kind: "shell", command: "npm test" }, label: "Ran npm test", detail: "npm test", doneDetail: "57 passed" });
  await t.say("The cart now runs on server actions and the tests pass.");
  await review(
    t,
    {
      outcome: "done",
      summary: `Moved the cart to server actions. Legacy /api/cart route: ${choice || "kept"}. Tests pass.`,
      files: changesOf(scenarioFiles["question"]!),
    },
    branch,
  );
};

const fixLinks: Scenario = async (t) => {
  const branch = "agent/fix-broken-links";
  await setBranch(t, branch);
  await t.say("I'll run the link checker to see what is broken.");
  await t.tool({ call: { kind: "shell", command: "npm run check-links" }, label: "Ran link check", detail: "npm run check-links", doneDetail: "23 broken", ok: false });
  await t.say("23 broken links. Most point at paths from before the folder rename.");
  await t.step("Edited guides/install.md", { detail: deltaOf("guides/install.md") });
  await t.step("Edited guides/deploy/docker.md", { detail: deltaOf("guides/deploy/docker.md") });
  await t.step("Edited reference/cli.md", { detail: deltaOf("reference/cli.md") });
  await t.say("Two links point at pages that were deleted, so I removed them instead of redirecting.");
  await t.tool({ call: { kind: "shell", command: "npm run check-links" }, label: "Ran link check", detail: "npm run check-links", doneDetail: "0 broken" });
  await t.say("The link check passes now.");
  await review(
    t,
    {
      outcome: "done",
      summary: "Found 23 broken links. Fixed 21 by updating paths after the folder rename; removed 2 that pointed to deleted pages. Link check now passes.",
      files: changesOf(scenarioFiles["fix-links"]!),
    },
    branch,
  );
};

const failingUpgrade: Scenario = async (t) => {
  const branch = "agent/upgrade-node-22";
  await setBranch(t, branch);
  await t.say("I'll bump Node to 22 and see what breaks.");
  await t.step("Edited .nvmrc, package.json", { detail: deltaOf(".nvmrc", "package.json") });
  await t.tool({ call: { kind: "shell", command: "npm install" }, label: "Ran npm install", detail: "npm install", doneDetail: "214 packages", ms: dur(1500, 2500) });
  const runs: Array<[string, string, string]> = [
    ["7 failed", "Seven tests fail on the removed url.parse behaviour. I'll switch them to the URL class.", "Edited src/lib/urls.ts"],
    ["3 failed", "Three left, all in the TLS client. The default cipher list changed in Node 22.", "Edited src/net/tls.ts"],
    ["1 failed", "One test still fails: the client rejects the test certificate.", ""],
  ];
  for (const [failed, note, fix] of runs) {
    await t.tool({ call: { kind: "shell", command: "npm test" }, label: "Ran npm test", detail: "npm test", doneDetail: failed, ok: false, ms: dur(1500, 2500) });
    await t.say(note);
    if (fix) await t.step(fix, { detail: deltaOf(fix.replace("Edited ", "")) });
  }
  await t.say("I couldn't get the last test to pass. The fixture certificate uses an algorithm Node 22 no longer accepts, and replacing it is outside what I should change on my own.");
  await review(
    t,
    {
      outcome: "failed",
      summary: "Bumped Node to 22 and fixed the url.parse and TLS cipher issues, but 1 test still fails: the TLS fixture certificate is rejected. Tests failed three times in a row.",
      files: changesOf(scenarioFiles["failing-upgrade"]!),
      actions: [],
    },
    branch,
  );
};

const sendData: Scenario = async (t) => {
  const branch = "agent/tighten-config";
  await setBranch(t, branch);
  await t.say("I'll tighten the config defaults and report the legacy auth flag upstream.");
  await t.step("Read 3 files", { detail: "src/config.ts" });
  await t.tool({ call: { kind: "shell", command: "git clone https://github.com/acme/ui-kit" }, label: "Cloned github.com/acme/ui-kit", detail: "read only", doneDetail: "read only" });
  await t.step("Edited src/config.ts", { detail: deltaOf("src/config.ts") });
  await t.tool({ call: { kind: "shell", command: "npm test" }, label: "Ran npm test", detail: "npm test", doneDetail: "63 passed" });
  await t.say("The tests pass. The ui-kit library still reads the legacy auth flag, so I'd like to open an issue there.");
  const sent = await t.askSend("github.com", "POST", "/repos/acme/ui-kit/issues");
  if (sent === "approve") {
    await t.step("Opened an issue on acme/ui-kit", { detail: "github.com", doneDetail: "#212", ms: dur(1000, 1800) });
    await t.say("The issue is open upstream.");
  } else {
    await t.say("Okay, I won't send anything to GitHub. I'll mention the flag in the summary instead.");
  }
  await review(
    t,
    {
      outcome: "done",
      summary: `Tightened the config defaults: quieter log level, a cache TTL from the environment, legacy auth off. Tests pass. ${sent === "approve" ? "Opened an issue upstream about the legacy auth flag." : "Nothing was sent upstream; the legacy auth flag still needs a report."}`,
      files: changesOf(scenarioFiles["send-data"]!),
    },
    branch,
  );
};

const blocked: Scenario = async (t) => {
  const branch = "agent/currency-rates";
  await setBranch(t, branch);
  await t.say("I'll fetch the current exchange rates to update the pricing table.");
  await t.step("Read 4 files", { detail: "src/pricing" });
  const host = "api.thirdparty.example";
  const allowed = await t.askNetwork(host, `curl -s https://${host}/v2/rates`);
  if (allowed === "approve") {
    await t.step(`Read from ${host}`, { detail: host, doneDetail: "401 Unauthorized", ok: false, ms: dur(900, 1600) });
    await t.say("The host is reachable, but it needs an API key I don't have, so I'll use the rates fixture already in the repo.");
  } else {
    await t.step("Tried curl", { detail: host, doneDetail: "Network access denied", ok: false, ms: dur(500, 900) });
    await t.say("That host is not allowed, so I'll use the rates fixture already in the repo instead.");
  }
  await t.step("Read fixtures/rates.json", { detail: "31 currencies" });
  await t.step("Edited src/pricing/table.ts", { detail: deltaOf("src/pricing/table.ts") });
  await t.tool({ call: { kind: "shell", command: "npm test" }, label: "Ran npm test", detail: "npm test", doneDetail: "29 passed" });
  await t.say("The pricing table now uses the fixture rates.");
  await review(
    t,
    {
      outcome: "done",
      summary: "Updated the pricing table from the bundled rates fixture. A live rates call was not possible, so the values may be out of date.",
      files: changesOf(scenarioFiles["blocked"]!),
      notes: allowed === "approve" ? [`${host} needs an API key; the call returned 401.`] : [`Wanted network access to ${host}; it stayed blocked.`],
    },
    branch,
  );
};

export const scenarios: Array<{ name: string; keywords: string[]; run: Scenario }> = [
  { name: "webhook-retry", keywords: ["webhook", "retry"], run: webhookRetry },
  { name: "question", keywords: ["cart", "question"], run: cartQuestion },
  { name: "fix-links", keywords: ["link", "docs"], run: fixLinks },
  { name: "failing-upgrade", keywords: ["upgrade", "node"], run: failingUpgrade },
  { name: "send-data", keywords: ["issue", "report", "config"], run: sendData },
  { name: "blocked", keywords: ["blocked", "outside"], run: blocked },
];

/** Generic tail for a task whose scenario position was lost in a restart. */
/** Usage for a scripted task: made up, in the range real runs show, and stable for a task id. */
function scriptedUsage(taskId: string): TaskUsage {
  let h = 0;
  for (const ch of taskId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const turns = 5 + (h % 16);
  const inputTokens = 900 * turns + (h % 3000);
  const cachedTokens = Math.round(inputTokens * (2 + (h % 5)));
  const outputTokens = 110 * turns + (h % 700);
  return {
    costUsd: (inputTokens * 0.3 + outputTokens * 1.2 + cachedTokens * 0.006) / 1_000_000,
    inputTokens,
    cachedTokens,
    outputTokens,
    turns,
    modelMs: turns * (1400 + (h % 900)),
    toolMs: turns * (150 + (h % 200)),
    contextTokens: 2000 + 420 * turns,
    contextWindow: 1_048_576,
    compactions: 0,
  };
}

/** A finished task whose review stayed open across a restart: wait on that review again, as it is. */
export const keptReview = (kept: KeptReview): Scenario => (t) => review(t, kept.payload, kept.payload.branch, kept.requestId);

export const resumedTail: Scenario = async (t) => {
  await setBranch(t, t.task.branch ?? undefined);
  await t.say("I'm picking the work back up after the restart. Let me check where things stand.");
  await t.step("Checked the worktree", { detail: "git status" });
  await t.tool({ call: { kind: "shell", command: "npm test" }, label: "Ran npm test", detail: "npm test", doneDetail: "all passed" });
  await t.step("Wrote summary", { ms: dur(800, 1200) });
  await t.say("Everything is in place.");
  const files = changesOf(resumedFiles);
  await review(
    t,
    { outcome: "done", summary: "Resumed after a restart, verified the worktree and re-ran the tests. They pass.", files },
    t.task.branch ?? `agent/${slug(t.task.title || "task") || "task"}`,
  );
};
