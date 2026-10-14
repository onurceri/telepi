// Sample data and light simulated behaviour behind the DataApi seam. Doubles as the demo mode.
// URL switches: ?offline shows the unreachable state (the third "Retry now" reconnects),
// ?rejected seeds a queued message the server refused, ?many adds about 25 projects (picker demo),
// ?unpaired starts at the pairing screen (any code of 4+ characters works, "0000" is wrong),
// The default data has one of each card: a network read approval (/requests/r-retry, one new host), a send-data card (/requests/r-send),
// a question, a review with Open PR and Push branch, a failed review. ?send is kept for old links and changes nothing.
// ?network adds a task blocked on a two-host network approval (/requests/r-network; "Deny all network access for this task"
// closes it for good, a plain Deny makes the agent try one more host, which opens a second card),
// ?notes adds a finished task whose result has two notes under the summary (/requests/r-notes),
// ?edge adds long-content cases for layout checks: a long project name, a 120-character task title, a 50-character branch,
// a three-host network approval (/requests/r-edge-net), a long question with long options (/requests/r-edge-q), a long review
// (/requests/r-edge-review) and a long refused message under "Not sent".
// The docs-site review (/requests/r-links, default data) and the first t-retry timeline message use Markdown.
// Reviews offer the new actions: r-links both (Open PR first, Push branch under More), r-notes (?notes) only Push branch,
// the failed review /requests/r-node none; ?edge gives /requests/r-edge-review two long publish actions.
// ?long makes the detail of the network approval very long (/requests/r-retry, buttons must stay reachable).
// ?nomodel gives the model picker in Settings its empty state (no provider logged in); ?manymodels lists about 300 models;
// ?retired makes Pi's default model one the login cannot use (New task warns, Settings explains).
import type { PluginAction, ReviewPayload, TaskEventInput } from "@telepi/contract";
import type {
  AppState,
  DataApi,
  Device,
  ModelRef,
  ModelsResponse,
  OutboxItem,
  Project,
  Request,
  RejectedItem,
  RequestAnswer,
  Result,
  Task,
  TaskEvent,
  TaskEventsHandle,
} from "../api";
import { BIG_FILES, mockDiff } from "./diffs";
import { MOCK_MODELS, manyModels } from "./models";

const MIN = 60_000;
const HOUR = 60 * MIN;

const OPEN_PR: PluginAction = { id: "github.open_pr", plugin: "github", label: "Open PR", class: "write" };
const GIT_PUSH: PluginAction = { id: "git.push", plugin: "git", label: "Push branch", class: "write" };
const longCommands = Array.from({ length: 60 }, (_, i) => `curl -s https://registry.npmjs.org/p-retry/-/p-retry-${i + 1}.0.0.tgz -o /tmp/p-retry-${i + 1}.tgz`).join("\n");

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string, message: string): Result<never> => ({ ok: false, error, message });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

const EMPTY_EVENTS: TaskEvent[] = [];

interface EventLog {
  events: TaskEvent[];
  listeners: Set<() => void>;
  handle: TaskEventsHandle;
}

const networkApproval = (hosts: string[], command?: string): Extract<Request["payload"], { kind: "approval" }> => ({
  kind: "approval",
  title: hosts.length === 1 ? `Allow reading from ${hosts[0]}` : `Allow network access to ${hosts.length} hosts`,
  action: { id: "network.allow", plugin: "openshell", label: "Network access", class: "write" },
  target: hosts.map((h) => `${h}:443`).join("\n"),
  detail: {
    format: "text",
    text: hosts.map((h) => `${h}:443\nTried by: ${command ?? `curl -s https://${h}/v1/latest?base=EUR`}`).join("\n\n"),
    sections: hosts.map((h) => ({ title: `${h}:443`, format: "text" as const, text: `Tried by: ${command ?? `curl -s https://${h}/v1/latest?base=EUR`}\nThe sandbox has no network by default.`, collapsed: false })),
  },
  reason: { code: "first_time", text: "Approving a site lets the agent read from it. Sending data to it asks again." },
  canAllowPermanently: true,
  canDenyForTask: true,
});

/** The agent wants to send data to a site the user already allowed it to read from. */
const sendApproval = (host: string, method: string, path: string): Extract<Request["payload"], { kind: "approval" }> => ({
  kind: "approval",
  title: `Allow sending data to ${host}`,
  action: { id: "network.send", plugin: "openshell", label: "Send data", class: "write" },
  target: `${method} ${host}${path}`,
  detail: {
    format: "text",
    text: `${host}\nThe agent wants to send data to ${host}.\n\n${method} ${path}`,
    sections: [{ title: host, format: "text" as const, text: `The agent wants to send data to ${host}.\n\n${method} ${path}`, collapsed: false }],
  },
  reason: { code: "send_data", text: `You allowed the agent to read from ${host}. Sending data to it needs a separate yes.` },
  send: { host, method, path },
  canAllowPermanently: true,
  canDenyForTask: true,
});

export function createMockData(): DataApi {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const startOffline = params.has("offline");
  const startUnpaired = params.has("unpaired");
  const startRejected = params.has("rejected");
  const many = params.has("many");
  const withNetwork = params.has("network");
  const withNotes = params.has("notes");
  const longDetail = params.has("long");
  const edge = params.has("edge");
  const noModel = params.has("nomodel");
  const modelList = noModel ? [] : params.has("manymodels") ? manyModels() : MOCK_MODELS;
  const now = Date.now();
  const ago = (ms: number) => now - ms;

  const device: Device = { id: "dev-1", name: "Pixel 8", createdAt: ago(9 * 24 * HOUR), lastSeenAt: now };

  // ---- seed ---------------------------------------------------------------

  const projects: Project[] = [
    { id: "storefront", name: "storefront", status: "idle", allowedActions: ["network:registry.npmjs.org:443"] },
    { id: "billing-api", name: "billing-api", status: "idle", allowedActions: ["network:registry.npmjs.org:443", "github.open_pr"] },
    { id: "docs-site", name: "docs-site", status: "idle", allowedActions: [] },
  ];

  const tasks: Task[] = [];
  const requests: Request[] = [];
  const logs = new Map<string, EventLog>();

  const mkTask = (t: Omit<Task, "updatedAt" | "branch"> & { branch?: string | null; updatedAt?: number }): Task => {
    const task: Task = { branch: null, updatedAt: t.createdAt, ...t };
    tasks.push(task);
    return task;
  };

  const logFor = (taskId: string): EventLog => {
    let log = logs.get(taskId);
    if (!log) {
      const listeners = new Set<() => void>();
      const created: EventLog = {
        events: [],
        listeners,
        handle: {
          getEvents: () => created.events,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      };
      log = created;
      logs.set(taskId, log);
    }
    return log;
  };

  /** Append an event. `at` defaults to now. */
  const emit = (taskId: string, input: TaskEventInput, at = Date.now()) => {
    const log = logFor(taskId);
    const seq = (log.events[log.events.length - 1]?.seq ?? 0) + 1;
    log.events = [...log.events, { ...input, taskId, seq, at } as TaskEvent];
    log.listeners.forEach((l) => l());
  };

  /** Seed helper: a step that already finished. */
  const seedStep = (taskId: string, at: number, label: string, detail: string | null, okay = true, finishDetail?: string | null) => {
    const stepId = uid();
    emit(taskId, { type: "step_started", stepId, label, detail: null }, at);
    emit(taskId, { type: "step_finished", stepId, ok: okay, detail: finishDetail === undefined ? detail : finishDetail }, at + 20_000);
  };
  const seedText = (taskId: string, at: number, text: string) => {
    const messageId = uid();
    const cut = Math.max(1, text.indexOf(" ", Math.floor(text.length / 2)));
    emit(taskId, { type: "agent_text", messageId, delta: text.slice(0, cut) }, at);
    emit(taskId, { type: "agent_text", messageId, delta: text.slice(cut) }, at + 800);
  };
  const seedRequest = (r: Omit<Request, "state" | "closedAt" | "answer"> & Partial<Pick<Request, "state" | "closedAt" | "answer">>) => {
    requests.push({ state: "open", closedAt: null, answer: null, ...r });
    emit(r.taskId, { type: "request_opened", requestId: r.id }, r.createdAt);
  };

  // 1. billing-api: retry, blocked on an approval
  {
    const start = ago(9 * MIN);
    mkTask({
      id: "t-retry", projectId: "billing-api", title: "Add retry to webhook sender",
      instruction: "Webhook sender drops events on 5xx. Add retry with backoff, max 5 attempts.",
      state: "waiting", currentStep: null, createdAt: start, updatedAt: ago(4 * MIN), branch: "agent/webhook-retry",
    });
    emit("t-retry", { type: "instruction", text: "Webhook sender drops events on 5xx. Add retry with backoff, max 5 attempts." }, start);
    seedStep("t-retry", start + 20_000, "Read 6 files", "src/webhooks");
    seedStep("t-retry", start + 70_000, "Edited sender.ts, retry.ts", "+48 −7");
    seedText("t-retry", start + 120_000, "**What I did:** added exponential backoff with jitter to `sender.ts`.\n\n- Retries only on `5xx` and network errors\n- A `4xx` fails immediately\n  - except `429`, which honours `Retry-After`\n\nSee https://example.com/docs/retries for the policy. Next I will run:\n\n```\nnpm test -- --filter webhooks\n```");
    seedStep("t-retry", start + 150_000, "Ran npm test", "42 passed");
    seedStep("t-retry", start + 200_000, "Wrote the retry tests", "+31 −0");
    seedRequest({ id: "r-retry", taskId: "t-retry", projectId: "billing-api", createdAt: ago(4 * MIN), payload: networkApproval(["registry.npmjs.org"], longDetail ? longCommands : undefined) });
  }

  // 2. storefront: cart, blocked on a question
  {
    const start = ago(20 * MIN);
    mkTask({
      id: "t-cart", projectId: "storefront", title: "Move cart to server actions",
      instruction: "Replace the /api/cart fetch calls with server actions. Keep behaviour the same.",
      state: "waiting", currentStep: null, createdAt: start, updatedAt: ago(12 * MIN), branch: "agent/cart-server-actions",
    });
    emit("t-cart", { type: "instruction", text: "Replace the /api/cart fetch calls with server actions. Keep behaviour the same." }, start);
    seedStep("t-cart", start + 20_000, "Read 11 files", "src/cart, src/app");
    seedStep("t-cart", start + 90_000, "Searched for callers of /api/cart", "3 callers");
    seedText("t-cart", start + 150_000, "All three callers are now using the new actions. The mobile app still calls the old route directly, so I paused before removing it.");
    seedRequest({
      id: "r-cart", taskId: "t-cart", projectId: "storefront", createdAt: ago(12 * MIN),
      payload: { kind: "question", question: "Keep the legacy /api/cart route?", options: ["Keep it", "Remove it"] },
    });
  }

  // 3. docs-site: broken links, done, waiting for review
  {
    const start = ago(70 * MIN);
    mkTask({
      id: "t-links", projectId: "docs-site", title: "Fix broken links",
      instruction: "Run the link checker and fix whatever it reports.",
      state: "done", currentStep: null, createdAt: start, updatedAt: ago(61 * MIN), branch: "agent/fix-broken-links",
      usage: { costUsd: 0.0075, inputTokens: 8185, cachedTokens: 65920, outputTokens: 3859, turns: 10, modelMs: 42000, toolMs: 3200, contextTokens: 11008, contextWindow: 1048576, compactions: 0 },
    });
    emit("t-links", { type: "instruction", text: "Run the link checker and fix whatever it reports." }, start);
    seedStep("t-links", start + 20_000, "Ran link check", "23 broken");
    seedStep("t-links", start + 120_000, "Edited 14 files", "+27 −31");
    seedText("t-links", start + 300_000, "Fixed 21 links by updating paths after the folder rename. The other two pointed to pages that were deleted, so I removed them.");
    seedStep("t-links", start + 400_000, "Ran link check", "0 broken");
    emit("t-links", { type: "state_changed", state: "done" }, ago(61 * MIN));
    seedRequest({
      id: "r-links", taskId: "t-links", projectId: "docs-site", createdAt: ago(61 * MIN),
      payload: {
        kind: "review", outcome: "done",
        summary: "**What I did:** ran the link checker, which found 23 broken links.\n\n- Fixed 21 by updating paths after the folder rename\n- Removed 2 that pointed to deleted pages\n\n**Result:** `npm run links` now passes. Details in [the report](https://example.com/reports/links-2026-10-12) and in the check below:\n\n```\n$ npm run links\n23 checked, 0 broken\n```\n\n1. Review the renamed paths\n2. Open the PR",
        files: [
          { path: "guides/install.md", added: 6, removed: 6 },
          { path: "guides/deploy/docker.md", added: 4, removed: 4 },
          { path: "reference/cli.md", added: 3, removed: 5 },
          { path: "reference/config.md", added: 400, removed: 400 },
          { path: "guides/deploy/compose.md", added: 2, removed: 2 },
          { path: "reference/api/overview.md", added: 2, removed: 2 },
          { path: "reference/api/auth.md", added: 1, removed: 1 },
          { path: "reference/api/errors.md", added: 1, removed: 2 },
          { path: "reference/changelog.md", added: 2, removed: 3 },
          { path: "guides/faq.md", added: 1, removed: 1 },
          { path: "guides/migrate.md", added: 1, removed: 1 },
          { path: "guides/deploy/kubernetes.md", added: 0, removed: 1 },
          { path: "guides/deploy/fly.md", added: 0, removed: 1 },
          { path: "static/img/architecture.png", added: 0, removed: 0 }
        ],
        branch: "agent/fix-broken-links", actions: [OPEN_PR, GIT_PUSH], notes: [],
      },
    });
  }

  // 4. storefront: Node 22, failed
  {
    const start = ago(150 * MIN);
    mkTask({
      id: "t-node", projectId: "storefront", title: "Upgrade to Node 22",
      instruction: "Move the project to Node 22 and make sure CI is green.",
      state: "failed", currentStep: null, createdAt: start, updatedAt: ago(121 * MIN), branch: "agent/node-22",
      usage: { costUsd: 0.0043, inputTokens: 9712, cachedTokens: 11136, outputTokens: 1059, turns: 6, modelMs: 11000, toolMs: 1400, contextTokens: 4626, contextWindow: 1048576, compactions: 0 },
    });
    emit("t-node", { type: "instruction", text: "Move the project to Node 22 and make sure CI is green." }, start);
    seedStep("t-node", start + 20_000, "Updated .nvmrc and engines", "3 files");
    seedStep("t-node", start + 200_000, "Ran npm test", "9 failed", false);
    seedText("t-node", start + 260_000, "The image-processing package uses a native binding that does not build on Node 22.");
    seedStep("t-node", start + 400_000, "Tried sharp 0.34", "still failing", false);
    seedStep("t-node", start + 700_000, "Ran npm test", "6 failed", false);
    emit("t-node", { type: "state_changed", state: "failed" }, ago(121 * MIN));
    seedRequest({
      id: "r-node", taskId: "t-node", projectId: "storefront", createdAt: ago(121 * MIN),
      payload: {
        kind: "review", outcome: "failed",
        summary: "Tests still failing after 3 attempts. The native image package does not build on Node 22 and has no release that does.",
        files: [{ path: "package.json", added: 3, removed: 3 }, { path: ".nvmrc", added: 1, removed: 1 }, { path: "package-lock.json", added: 2000, removed: 2000 }],
        branch: "agent/node-22", actions: [], notes: [],
      },
    });
  }

  // 5. billing-api: idempotency keys, running
  {
    const start = ago(6 * MIN);
    mkTask({
      id: "t-idem", projectId: "billing-api", title: "Add idempotency keys",
      instruction: "Add an idempotency key to POST /charges. Reject a repeated key within 24 hours and return the original response.",
      state: "running", currentStep: "running tests", createdAt: start, updatedAt: ago(30_000), branch: "agent/idempotency-keys",
    });
    emit("t-idem", { type: "instruction", text: "Add an idempotency key to POST /charges. Reject a repeated key within 24 hours and return the original response." }, start);
    seedStep("t-idem", start + 10_000, "Read 4 files", "src/charges");
    seedStep("t-idem", start + 60_000, "Edited charges.ts, store.ts", "+61 −4");
    seedText("t-idem", start + 150_000, "Keys are stored with the response body for 24 hours. A repeated key returns the stored response without charging again.");
    emit("t-idem", { type: "step_started", stepId: "idem-test", label: "Running tests", detail: null }, ago(30_000));
  }

  // 6. docs-site: install guide, running
  {
    const start = ago(1 * MIN);
    mkTask({
      id: "t-guide", projectId: "docs-site", title: "Rewrite install guide",
      instruction: "Rewrite the install guide for the new CLI. Keep it under one page.",
      state: "running", currentStep: "reading files", createdAt: start, updatedAt: ago(10_000), branch: "agent/install-guide",
    });
    emit("t-guide", { type: "instruction", text: "Rewrite the install guide for the new CLI. Keep it under one page." }, start);
    emit("t-guide", { type: "step_started", stepId: "guide-read", label: "Reading files", detail: "guides/install.md" }, ago(10_000));
  }

  // 7. an older finished task, already reviewed
  {
    const start = ago(26 * HOUR);
    mkTask({
      id: "t-eslint", projectId: "storefront", title: "Bump eslint to v9",
      instruction: "Upgrade eslint to v9 and migrate the config.",
      state: "done", currentStep: null, createdAt: start, updatedAt: ago(25 * HOUR), branch: "agent/eslint-9",
      usage: { costUsd: 1.84, inputTokens: 412000, cachedTokens: 2960000, outputTokens: 48200, turns: 143, modelMs: 1260000, toolMs: 318000, contextTokens: 171000, contextWindow: 200000, compactions: 2 },
    });
    emit("t-eslint", { type: "instruction", text: "Upgrade eslint to v9 and migrate the config." }, start);
    seedStep("t-eslint", start + 30_000, "Migrated to flat config", "eslint.config.js");
    seedStep("t-eslint", start + 200_000, "Ran npm run lint", "0 errors");
    emit("t-eslint", { type: "state_changed", state: "done" }, ago(25 * HOUR));
    seedRequest({
      id: "r-eslint", taskId: "t-eslint", projectId: "storefront", createdAt: ago(25 * HOUR), state: "answered", closedAt: ago(24 * HOUR),
      answer: { kind: "review", decision: "action", actionId: OPEN_PR.id },
      payload: {
        kind: "review", outcome: "done", summary: "Upgraded to eslint 9 with a flat config. Lint passes.",
        files: [{ path: "eslint.config.js", added: 40, removed: 0 }, { path: "package.json", added: 2, removed: 2 }],
        branch: "agent/eslint-9", actions: [OPEN_PR], notes: [],
      },
    });
    emit("t-eslint", { type: "request_closed", requestId: "r-eslint" }, ago(24 * HOUR));
  }

  {
    const start = ago(4 * MIN);
    mkTask({
      id: "t-issue", projectId: "storefront", title: "Report the flaky test upstream",
      instruction: "Open an issue on the library's repository about the flaky test.",
      state: "waiting", currentStep: null, createdAt: start, updatedAt: ago(1 * MIN), branch: "agent/report-flaky",
    });
    emit("t-issue", { type: "instruction", text: "Open an issue on the library's repository about the flaky test." }, start);
    seedStep("t-issue", start + 30_000, "Cloned github.com/acme/ui-kit", "read only");
    seedRequest({ id: "r-send", taskId: "t-issue", projectId: "storefront", createdAt: ago(1 * MIN), payload: sendApproval("github.com", "POST", "/repos/acme/ui-kit/issues") });
  }

  {
    const start = ago(35 * MIN);
    mkTask({
      id: "t-pub", projectId: "docs-site", title: "Document the new CLI flags",
      instruction: "Add the new CLI flags to the reference and open a pull request.",
      state: "waiting", currentStep: null, createdAt: start, updatedAt: ago(2 * MIN), branch: "agent/cli-flags-docs",
    });
    emit("t-pub", { type: "instruction", text: "Add the new CLI flags to the reference and open a pull request." }, start);
    seedStep("t-pub", start + 30_000, "Edited reference/cli.md", "+22 −3");
    seedRequest({
      id: "r-pr", taskId: "t-pub", projectId: "docs-site", createdAt: ago(2 * MIN),
      payload: {
        kind: "approval", title: "Open a pull request", action: OPEN_PR, target: "agent/cli-flags-docs",
        detail: {
          format: "text",
          text: "Title: Document the new CLI flags\nBranch: agent/cli-flags-docs into main\n\nPush the branch to origin, then open a pull request.",
          sections: [],
        },
        reason: { code: "first_time", text: "\"Open PR\" has not been allowed in this project yet." },
        canAllowPermanently: true, canDenyForTask: false,
      },
    });
  }

  if (withNetwork) {
    const start = ago(3 * MIN);
    mkTask({
      id: "t-rates", projectId: "storefront", title: "Show live exchange rates in the cart",
      instruction: "Show prices in the visitor's currency, using a public exchange rate API.",
      state: "waiting", currentStep: null, createdAt: start, updatedAt: ago(1 * MIN), branch: "agent/live-rates",
    });
    emit("t-rates", { type: "instruction", text: "Show prices in the visitor's currency, using a public exchange rate API." }, start);
    seedStep("t-rates", start + 20_000, "Read 5 files", "src/cart");
    seedStep("t-rates", start + 60_000, "Edited rates.ts", "+34 −2");
    seedRequest({ id: "r-network", taskId: "t-rates", projectId: "storefront", createdAt: ago(1 * MIN), payload: networkApproval(["api.exchangerate.example", "cdn.fxdata.example"]) });
  }

  if (withNotes) {
    const start = ago(40 * MIN);
    mkTask({
      id: "t-notes", projectId: "billing-api", title: "Add currency field to invoices",
      instruction: "Add a currency field to invoices and show it in the PDF.",
      state: "done", currentStep: null, createdAt: start, updatedAt: ago(30 * MIN), branch: "agent/invoice-currency",
      usage: { costUsd: 0.0089, inputTokens: 18900, cachedTokens: 93184, outputTokens: 2216, turns: 20, modelMs: 48000, toolMs: 4200, contextTokens: 7504, contextWindow: 1048576, compactions: 0 },
    });
    emit("t-notes", { type: "instruction", text: "Add a currency field to invoices and show it in the PDF." }, start);
    seedStep("t-notes", start + 30_000, "Edited 3 files", "+41 −6");
    emit("t-notes", { type: "state_changed", state: "done" }, ago(30 * MIN));
    seedRequest({
      id: "r-notes", taskId: "t-notes", projectId: "billing-api", createdAt: ago(30 * MIN),
      payload: {
        kind: "review", outcome: "done",
        summary: "Invoices now carry a currency (default EUR) and the PDF shows it next to the total. Tests pass.",
        files: [{ path: "src/invoices/model.ts", added: 12, removed: 1 }, { path: "src/invoices/pdf.ts", added: 22, removed: 4 }, { path: "src/invoices/model.test.ts", added: 7, removed: 1 }],
        branch: "agent/invoice-currency", actions: [GIT_PUSH],
        notes: ["Wanted network access to api.exchangerate.example; it stayed blocked.", "Skipped two tests that need the staging database."],
      },
    });
  }

  if (edge) {
    const longName = "payments-reconciliation-service-for-european-marketplace-sellers";
    projects.push({ id: longName, name: longName, status: "idle", allowedActions: ["network:internal-artifact-registry.corp.example.com:443", "network.send:POST:internal-artifact-registry.corp.example.com:443/v2/packages/upload"] });
    const longTitle = "Reconcile settlement files from all three acquiring banks against the ledger and report every mismatch above one cent";
    const branch = "agent/reconcile-settlement-files-against-the-ledger";
    const start = ago(25 * MIN);
    mkTask({ id: "t-edge", projectId: longName, title: longTitle, instruction: longTitle + ". Keep the existing report format and do not change the ledger schema.", state: "waiting", currentStep: null, createdAt: start, updatedAt: ago(2 * MIN), branch });
    emit("t-edge", { type: "instruction", text: longTitle }, start);
    seedStep("t-edge", start + 20_000, "Read 212 files under services/reconciliation/settlement-parsers/acquirer-three", "src/services/reconciliation/settlement-parsers");
    seedRequest({
      id: "r-edge-net", taskId: "t-edge", projectId: longName, createdAt: ago(2 * MIN),
      payload: {
        ...networkApproval(["sandbox.acquirer-one.payments-gateway.example.com", "files.settlement-reports.acquirer-two.example.org", "registry.internal-artifact-store.corp.example.com"]),
        action: { id: "network.allow", plugin: "openshell", label: "Network access from the sandbox to an external host over TLS", class: "write" },
      },
    });
    seedRequest({
      id: "r-edge-q", taskId: "t-edge", projectId: longName, createdAt: ago(5 * MIN),
      payload: {
        kind: "question",
        question: "Two of the three banks report amounts in minor units while the third uses decimal strings with a locale-specific separator. Should I normalise everything to minor units before comparing, even though that changes how the existing report prints amounts?",
        options: ["Normalise to minor units and update the report format to match", "Keep the report format exactly as it is and convert only for the comparison", "Stop and ask someone on the finance team first"],
      },
    });
    seedRequest({
      id: "r-edge-review", taskId: "t-edge", projectId: longName, createdAt: ago(1 * MIN),
      payload: {
        kind: "review", outcome: "done",
        summary: "Added a reconciliation job that compares settlement files with ledger entries. " + "It reports every difference above one cent and groups them by bank. ".repeat(3),
        files: [
          { path: "services/reconciliation/settlement-parsers/acquirer-three/decimal-string-amount-parser.test.ts", added: 120, removed: 0 },
          { path: "services/reconciliation/settlement-parsers/acquirer-three/decimal-string-amount-parser.ts", added: 64, removed: 2 },
          { path: "README.md", added: 3, removed: 1 },
        ],
        branch, actions: [
          { id: "github.open_pr", plugin: "github", label: "Open a pull request against the default branch", class: "write" },
          { id: "git.push", plugin: "git", label: "Push the branch to the remote repository without opening anything", class: "write" },
        ],
        notes: ["Wanted network access to sandbox.acquirer-one.payments-gateway.example.com; it stayed blocked, so the parser tests use recorded files only.", "Skipped the integration suite because it needs the staging database."],
      },
    });
  }

  if (many) {
    const names = [
      "acme-web", "acme-mobile", "analytics-pipeline", "auth-service", "blog", "cli-tools", "data-warehouse", "design-system",
      "edge-workers", "email-templates", "infra-terraform", "internal-admin", "ios-app", "ledger", "marketing-site", "notifications",
      "ops-runbooks", "payments-gateway", "search-index", "sdk-python", "sdk-typescript", "status-page", "tax-engine", "webhooks-relay", "zeta-experiments",
    ];
    names.forEach((name, i) => {
      projects.push({ id: name, name, status: "idle", allowedActions: [] });
      if (i % 3 !== 0) return; // some projects have never been used
      const id = `t-many-${name}`;
      const running = i % 6 === 0;
      mkTask({
        id, projectId: name, title: `Housekeeping in ${name}`, instruction: "Tidy up.",
        state: running ? "running" : "done", currentStep: running ? "working" : null, createdAt: ago((3 + i) * HOUR),
      });
      if (i === 9 || i === 15) {
        seedRequest({
          id: `r-${id}`, taskId: id, projectId: name, createdAt: ago(2 * HOUR),
          payload: { kind: "question", question: `Which branch should ${name} target?`, options: ["main", "develop"] },
        });
        tasks[tasks.length - 1]!.state = "waiting";
      }
    });
  }

  // ?empty is a first run: no projects, no tasks, no requests.
  if (params.has("empty")) {
    projects.length = 0;
    tasks.length = 0;
    requests.length = 0;
  }

  // ---- state --------------------------------------------------------------

  const withStatus = (list: Project[], reqs: Request[], ts: Task[]): Project[] => {
    let changed = false;
    const next = list.map((p) => {
      const status: Project["status"] = reqs.some((r) => r.projectId === p.id && r.state === "open")
        ? "waiting"
        : ts.some((t) => t.projectId === p.id && t.state === "running")
          ? "running"
          : "idle";
      if (status === p.status) return p;
      changed = true;
      return { ...p, status };
    });
    return changed ? next : list;
  };

  let state: AppState = {
    connection: startUnpaired ? "unauthenticated" : startOffline ? "unreachable" : "online",
    lastSyncedAt: startOffline ? ago(14 * MIN) : now,
    device: startUnpaired ? null : device,
    projects: withStatus(projects, requests, tasks),
    tasks,
    requests,
    outbox: startOffline
      ? [{ id: "ob-1", kind: "message", projectId: "billing-api", taskId: "t-idem", text: "Use a 24 hour window, not 12", createdAt: ago(3 * MIN) }]
      : [],
    rejected: startRejected || edge
      ? [{
          item: { id: "ob-rej", kind: "message", projectId: "billing-api", taskId: "t-eslint", text: edge ? "Also bump the minimum Node version to 22 in the README, then re-run the lint step and make sure that the reconciliation-settlement-parsers workspace still builds." : "Also bump the minimum Node version to 22 in the README.\nThen re-run the lint step.", createdAt: ago(40 * MIN) },
          message: edge ? "That task has finished and no longer takes messages. The server answered: task t-eslint is in state done, which does not accept user messages until it is resumed by an operator." : "That task has finished and no longer takes messages.",
          rejectedAt: ago(6 * MIN),
        } satisfies RejectedItem]
      : [],
    push: "default",
    updateReady: params.has("update"),
  };

  const listeners = new Set<() => void>();
  const commit = (patch: Partial<AppState>) => {
    const next = { ...state, ...patch };
    next.projects = withStatus(next.projects, next.requests, next.tasks);
    if (next.connection === "online") next.lastSyncedAt = Date.now();
    state = next;
    listeners.forEach((l) => l());
  };

  const patchTask = (id: string, patch: Partial<Task>) =>
    commit({ tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)) });
  const patchRequest = (id: string, patch: Partial<Request>) =>
    commit({ requests: state.requests.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const taskOf = (id: string) => state.tasks.find((t) => t.id === id);
  /** Tasks the user denied network access for, as a whole. */
  const deniedNetwork = new Set<string>();

  // ---- simulated agent work ----------------------------------------------

  /** Run a list of steps one after another, then call done. Stops quietly if the task was stopped. */
  const runSteps = (taskId: string, steps: { label: string; detail?: string; ms?: number }[], done: () => void) => {
    const next = (i: number) => {
      if (taskOf(taskId)?.state !== "running") return;
      if (i >= steps.length) return done();
      const step = steps[i]!;
      const stepId = uid();
      emit(taskId, { type: "step_started", stepId, label: step.label, detail: null });
      patchTask(taskId, { currentStep: step.label.toLowerCase() });
      setTimeout(() => {
        if (taskOf(taskId)?.state !== "running") return;
        emit(taskId, { type: "step_finished", stepId, ok: true, detail: step.detail ?? null });
        next(i + 1);
      }, step.ms ?? 1800);
    };
    next(0);
  };

  /** A push or pull request from the review: one step whose words move on as the work does. */
  const publish = (taskId: string, pr: boolean) => {
    const branch = taskOf(taskId)?.branch ?? "agent/task";
    const phases = pr ? ["Connecting to GitHub", `Pushing ${branch}`, "Opening pull request"] : ["Connecting to GitHub", `Pushing ${branch}`];
    const stepId = uid();
    patchTask(taskId, { state: "running", currentStep: phases[0]! });
    emit(taskId, { type: "step_started", stepId, label: phases[0]!, detail: null });
    phases.slice(1).forEach((label, i) => setTimeout(() => {
      emit(taskId, { type: "step_progress", stepId, label, detail: null });
      patchTask(taskId, { currentStep: label });
    }, 2200 * (i + 1)));
    setTimeout(() => {
      emit(taskId, { type: "step_progress", stepId, label: pr ? "Opened pull request" : "Pushed branch", detail: pr ? "#118" : branch });
      emit(taskId, { type: "step_finished", stepId, ok: true, detail: pr ? "#118" : branch });
      patchTask(taskId, { state: "done", currentStep: null });
      emit(taskId, { type: "agent_text", messageId: uid(), delta: pr ? "The pull request is open and ready for review." : "The branch is pushed." });
    }, 2200 * phases.length);
  };

  const finishWithReview = (taskId: string, summary: string, files: ReviewPayload["files"], notes: string[] = []) => {
    const task = taskOf(taskId);
    if (!task || task.state !== "running") return;
    const requestId = `r-${uid()}`;
    emit(taskId, { type: "agent_text", messageId: uid(), delta: summary });
    emit(taskId, { type: "state_changed", state: "done" });
    emit(taskId, { type: "request_opened", requestId });
    const request: Request = {
      id: requestId, taskId, projectId: task.projectId, state: "open", createdAt: Date.now(), closedAt: null, answer: null,
      payload: {
        kind: "review", outcome: "done", summary, files,
        branch: task.branch ?? `agent/${taskId}`, actions: [OPEN_PR, GIT_PUSH], notes,
      },
    };
    commit({
      requests: [...state.requests, request],
      tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, state: "done", currentStep: null, updatedAt: Date.now() } : t)),
    });
  };

  const resume = (taskId: string, steps: { label: string; detail?: string; ms?: number }[], summary: string, files: ReviewPayload["files"], notes: string[] = []) => {
    emit(taskId, { type: "state_changed", state: "running" });
    patchTask(taskId, { state: "running", currentStep: "working" });
    setTimeout(() => runSteps(taskId, steps, () => finishWithReview(taskId, summary, files, notes)), 1200);
  };

  // The tasks that were running at seed time finish by themselves, so the demo has motion.
  setTimeout(() => {
    const stepId = "idem-test";
    if (taskOf("t-idem")?.state !== "running") return;
    emit("t-idem", { type: "step_finished", stepId, ok: true, detail: "58 passed" });
    patchTask("t-idem", { currentStep: "reviewing the diff" });
    emit("t-idem", { type: "step_started", stepId: "idem-diff", label: "Reviewing the diff", detail: null });
    setTimeout(() => {
      if (taskOf("t-idem")?.state !== "running") return;
      emit("t-idem", { type: "step_finished", stepId: "idem-diff", ok: true, detail: "4 files" });
      finishWithReview("t-idem", "Repeated keys within 24 hours now return the stored response. Tests pass, including a new one for the replay case.", [
        { path: "src/charges/charges.ts", added: 38, removed: 4 },
        { path: "src/charges/store.ts", added: 23, removed: 0 },
        { path: "src/charges/charges.test.ts", added: 44, removed: 0 },
      ]);
    }, 9000);
  }, 14000);

  // ---- outbox -------------------------------------------------------------

  const startTask = (projectId: string, instruction: string): Task => {
    const id = `t-${uid()}`;
    const title = instruction.trim().split("\n")[0]!.slice(0, 60);
    const t = Date.now();
    const task: Task = {
      id, projectId, title, instruction: instruction.trim(), state: "running", currentStep: "reading files",
      branch: `agent/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}`, createdAt: t, updatedAt: t,
    };
    emit(id, { type: "instruction", text: task.instruction }, t);
    commit({ tasks: [...state.tasks, task] });
    setTimeout(() => {
      runSteps(
        id,
        [
          { label: "Reading files", detail: "src" },
          { label: "Editing files", detail: "+32 −5" },
          { label: "Running tests", detail: "31 passed" },
        ],
        () =>
          finishWithReview(id, "Done. The change is on its own branch and the tests pass.", [
            { path: "src/index.ts", added: 22, removed: 3 },
            { path: "src/index.test.ts", added: 10, removed: 2 },
          ]),
      );
    }, 900);
    return task;
  };

  const sendNow = (taskId: string, text: string) => {
    emit(taskId, { type: "user_message", text, clientId: null });
    const task = taskOf(taskId);
    if (task && (task.state === "running" || task.state === "waiting")) {
      setTimeout(() => emit(taskId, { type: "agent_text", messageId: uid(), delta: "Got it. I’ll take that into account from here." }), 1400);
    }
  };

  let retries = 0;
  const flushOutbox = () => {
    const items = state.outbox;
    commit({ outbox: [] });
    for (const item of items) {
      if (item.kind === "task") startTask(item.projectId, item.text);
      else if (item.taskId) sendNow(item.taskId, item.text);
    }
  };

  // ---- API ----------------------------------------------------------------

  // Pi's own default is Sonnet 4.5; choosing a model in telepi overrides it until cleared.
  let chosenModel: ModelRef | null = null;
  const modelsNow = (): ModelsResponse => {
    // ?retired: Pi's default names a model the login can no longer use, so nothing runs until one is chosen.
    const retired = params.has("retired") && !chosenModel;
    const current = retired ? null : chosenModel ?? (modelList.length > 0 ? { provider: "anthropic", id: "claude-sonnet-4-5" } : null);
    const problem = retired
      ? "Pi's default model, openrouter/stealth/ox-alpha, is not one this machine's login can use (it may have been retired). Choose a model in telepi under Settings → Model, or pick another with `pi` and /model."
      : current ? null : modelList.length === 0 ? "No model is available: this machine is not logged in to any model provider." : null;
    return { current, source: current ? (chosenModel ? "telepi" : "pi") : null, available: modelList, problem };
  };

  const offline = (): Result<never> | null =>
    state.connection === "online" ? null : fail("offline", "Can’t reach your home machine.");

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    taskEvents: (taskId) => (logs.has(taskId) ? logs.get(taskId)!.handle : { getEvents: () => EMPTY_EVENTS, subscribe: () => () => {} }),

    async pair(code, deviceName) {
      await delay(500);
      if (code.trim() === "0000") return fail("bad_pairing_code", "That code is not right.");
      const paired: Device = { ...device, name: deviceName, createdAt: Date.now(), lastSeenAt: Date.now() };
      commit({ device: paired, connection: "online" });
      return ok(paired);
    },

    async createTask(projectId, instruction) {
      await delay(300);
      if (state.connection !== "online") {
        const item: OutboxItem = { id: `ob-${uid()}`, kind: "task", projectId, taskId: null, text: instruction, createdAt: Date.now() };
        commit({ outbox: [...state.outbox, item] });
        return ok({ taskId: null, queued: true });
      }
      return ok({ taskId: startTask(projectId, instruction).id, queued: false });
    },

    async sendMessage(taskId, text) {
      await delay(200);
      const task = taskOf(taskId);
      if (!task) return fail("not_found", "That task does not exist.");
      if (state.connection !== "online") {
        const item: OutboxItem = { id: `ob-${uid()}`, kind: "message", projectId: task.projectId, taskId, text, createdAt: Date.now() };
        commit({ outbox: [...state.outbox, item] });
        return ok({ queued: true });
      }
      sendNow(taskId, text);
      return ok({ queued: false });
    },

    async stopTask(taskId) {
      await delay(250);
      const off = offline();
      if (off) return off;
      const task = taskOf(taskId);
      if (!task || (task.state !== "running" && task.state !== "waiting")) return fail("invalid", "That task is not running.");
      // A waiting task also loses its open request.
      const open = state.requests.filter((r) => r.taskId === taskId && r.state === "open");
      for (const r of open) emit(taskId, { type: "request_closed", requestId: r.id });
      emit(taskId, { type: "state_changed", state: "stopped" });
      commit({
        requests: state.requests.map((r) => (open.includes(r) ? { ...r, state: "cancelled", closedAt: Date.now() } : r)),
        tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, state: "stopped", currentStep: null, updatedAt: Date.now() } : t)),
      });
      return ok(undefined);
    },

    async answerRequest(requestId, answer: RequestAnswer) {
      await delay(350);
      const off = offline();
      if (off) return off;
      const request = state.requests.find((r) => r.id === requestId);
      if (!request) return fail("not_found", "That request does not exist.");
      if (request.state !== "open") return fail("request_closed", "That request was already answered.");
      const taskId = request.taskId;
      patchRequest(requestId, { state: "answered", closedAt: Date.now(), answer });
      emit(taskId, { type: "request_closed", requestId });

      if (answer.kind === "approval" && request.payload.kind === "approval" && request.payload.action.id === "network.send") {
        resume(taskId, answer.decision === "approve" ? [{ label: "Opened the issue", detail: "github.com" }] : [{ label: "Kept the report in a file instead", detail: "1 file" }],
          answer.decision === "approve" ? "The issue is open." : "I did not send anything; the report is in REPORT.md.", [],
          answer.decision === "approve" ? [] : ["Wanted to send data to github.com (POST /repos/acme/ui-kit/issues); you denied it, so it stayed blocked."]);
      } else if (answer.kind === "approval" && request.payload.kind === "approval" && request.payload.action.id === "network.allow") {
        const hosts = (request.payload.target ?? "").split("\n").map((h) => h.replace(/:443$/, ""));
        const files = [{ path: "src/cart/rates.ts", added: 34, removed: 2 }, { path: "src/cart/rates.test.ts", added: 18, removed: 0 }];
        if (answer.decision === "approve") {
          resume(taskId, [{ label: "Fetched exchange rates", detail: hosts[0] ?? "" }, { label: "Ran npm test", detail: "44 passed", ms: 2200 }],
            "Cart prices now follow the live exchange rate.", files);
        } else if (answer.denyForTask) {
          deniedNetwork.add(taskId);
          resume(taskId, [{ label: "Using a bundled rate table instead", detail: "1 file" }, { label: "Ran npm test", detail: "44 passed", ms: 2200 }],
            "Cart prices use a rate table that ships with the app. It needs a manual refresh.", files,
            [`Wanted network access to ${hosts.join(" and ")}; it stayed blocked.`, "Network access was denied for the whole task, so nothing else was asked."]);
        } else if (!request.id.endsWith("-again")) {
          emit(taskId, { type: "agent_text", messageId: uid(), delta: "That host is blocked. I’ll try a different rates provider." });
          emit(taskId, { type: "state_changed", state: "running" });
          patchTask(taskId, { state: "running", currentStep: "trying another provider" });
          // The agent asks for another host instead of giving up; the denial for the task stops exactly this.
          setTimeout(() => {
            if (taskOf(taskId)?.state !== "running") return;
            const again = `${request.id}-again`;
            emit(taskId, { type: "request_opened", requestId: again });
            commit({
              requests: [...state.requests, { id: again, taskId, projectId: request.projectId, state: "open", createdAt: Date.now(), closedAt: null, answer: null, payload: networkApproval(["rates.backup.example"]) }],
              tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, state: "waiting", currentStep: null, updatedAt: Date.now() } : t)),
            });
            emit(taskId, { type: "state_changed", state: "waiting" });
          }, 3200);
        } else {
          resume(taskId, [{ label: "Using a bundled rate table instead", detail: "1 file" }],
            "Cart prices use a rate table that ships with the app. It needs a manual refresh.", files,
            [`Wanted network access to ${hosts.join(" and ")}; it stayed blocked.`]);
        }
      } else if (answer.kind === "approval" && request.payload.kind === "approval" && (request.payload.action.id === OPEN_PR.id || request.payload.action.id === GIT_PUSH.id)) {
        // A publish approval: approve runs the push (and the pull request); deny leaves the branch as it is.
        if (answer.decision === "approve") publish(taskId, request.payload.action.id === OPEN_PR.id);
        else patchTask(taskId, { state: "done", currentStep: null });
      } else if (answer.kind === "approval" && request.payload.kind === "approval") {
        if (answer.decision === "approve") {
          if (answer.allowPermanently && request.payload.canAllowPermanently) {
            const id = request.payload.action.id;
            commit({ projects: state.projects.map((p) => (p.id === request.projectId && !p.allowedActions.includes(id) ? { ...p, allowedActions: [...p.allowedActions, id] } : p)) });
          }
          resume(taskId, [{ label: "Read from registry.npmjs.org", detail: "p-retry" }, { label: "Ran integration tests", detail: "58 passed", ms: 2600 }],
            "Retries are in. I used the p-retry package and the integration tests pass.",
            [{ path: "src/webhooks/sender.ts", added: 31, removed: 5 }, { path: "src/webhooks/retry.ts", added: 17, removed: 2 }]);
        } else {
          emit(taskId, { type: "agent_text", messageId: uid(), delta: "Understood. I won’t fetch it." + (answer.note ? ` Noted: ${answer.note}` : "") });
          resume(taskId, [{ label: "Writing the backoff by hand", detail: "2 files" }],
            "Retries use a small backoff helper in the repo instead of a new package.",
            [{ path: "src/webhooks/sender.ts", added: 36, removed: 5 }, { path: "src/webhooks/retry.ts", added: 21, removed: 2 }]);
        }
      } else if (answer.kind === "question") {
        resume(taskId, [{ label: "Removing the old cart route", detail: "4 files" }, { label: "Ran npm test", detail: "63 passed", ms: 2400 }],
          `Done. Following your answer: “${answer.text}”.`,
          [{ path: "src/cart/actions.ts", added: 52, removed: 0 }, { path: "src/app/api/cart/route.ts", added: 0, removed: 48 }]);
      } else if (answer.kind === "review") {
        if (answer.decision === "action") publish(taskId, answer.actionId === OPEN_PR.id);
        if (answer.decision === "changes") {
          emit(taskId, { type: "user_message", text: answer.text ?? "", clientId: null });
          resume(taskId, [{ label: "Applying your changes", detail: "2 files" }, { label: "Ran npm test", detail: "all passed", ms: 2200 }],
            "Changes made and the tests still pass.",
            [{ path: "src/index.ts", added: 12, removed: 4 }]);
        }
      }
      return ok(undefined);
    },

    dismissRejected(id) {
      commit({ rejected: state.rejected.filter((r) => r.item.id !== id) });
    },

    async getDiff(taskId, path, opts) {
      await delay(450);
      const off = offline();
      if (off) return off;
      let counts: { added: number; removed: number } | null = null;
      for (const r of state.requests) {
        if (r.taskId !== taskId || r.payload.kind !== "review") continue;
        const f = r.payload.files.find((x) => x.path === path);
        if (f) counts = f;
      }
      if (!counts) return fail("not_found", "That file is not part of this task’s changes.");
      return ok(mockDiff(path, BIG_FILES[path] ?? counts, opts?.full === true));
    },

    async getModels() {
      await delay(250);
      const off = offline();
      if (off) return off;
      return ok(modelsNow());
    },

    async setModel(model) {
      await delay(600);
      const off = offline();
      if (off) return off;
      if (model && !modelList.some((x) => x.provider === model.provider && x.id === model.id)) return fail("invalid", "That model is not available.");
      chosenModel = model;
      return ok(modelsNow());
    },

    async enablePush() {
      await delay(400);
      commit({ push: "granted" });
      return ok(undefined);
    },

    applyUpdate() {
      commit({ updateReady: false });
    },

    retryNow() {
      if (state.connection === "online" || state.connection === "unauthenticated") return;
      retries += 1;
      commit({ connection: "connecting" });
      setTimeout(() => {
        if (startOffline && retries < 3) {
          commit({ connection: "unreachable" });
          return;
        }
        commit({ connection: "online" });
        flushOutbox();
      }, 900);
    },
  };
}
