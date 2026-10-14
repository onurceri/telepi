// Believable unified diffs for every file a fake scenario's review lists.
// The catalog is static data, so a diff still resolves after a server restart. The review's
// added/removed counts are computed from these patches, so the two always agree.
import type { FileChange } from "@telepi/contract";

export interface FileDiff {
  binary: boolean;
  patch: string;
}

/** One hunk. Lines start with " " (context), "+" (added) or "-" (removed); the header is computed. */
function hunk(oldStart: number, newStart: number, section: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] !== "+").length;
  const newCount = lines.filter((l) => l[0] !== "-").length;
  const head = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section ? ` ${section}` : ""}`;
  return [head, ...lines].join("\n");
}

const patch = (...hunks: string[]) => ({ binary: false, patch: hunks.join("\n") });

function countOf(d: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of d.patch.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** The review's file list for a set of diffs. */
export function changesOf(files: Record<string, FileDiff>): FileChange[] {
  return Object.entries(files).map(([path, d]) => ({ path, ...countOf(d) }));
}

// A lockfile bump: long on purpose, so the app has something to truncate.
function lockfile(): FileDiff {
  const hunks: string[] = [];
  let oldLine = 12;
  let newLine = 12;
  const pkgs = ["undici", "ws", "semver", "yaml", "tar", "glob", "minimatch", "debug", "ms", "cookie", "qs", "bytes"];
  for (let i = 0; i < 28; i++) {
    const name = `${pkgs[i % pkgs.length]}${i >= pkgs.length ? `-${i}` : ""}`;
    const from = `${3 + (i % 4)}.${i % 9}.${i % 5}`;
    const to = `${3 + (i % 4)}.${(i % 9) + 1}.0`;
    const lines = [
      `     "node_modules/${name}": {`,
      `-      "version": "${from}",`,
      `-      "resolved": "https://registry.npmjs.org/${name}/-/${name}-${from}.tgz",`,
      `-      "integrity": "sha512-${(i * 7919).toString(36).padStart(6, "0")}Qk3vXw9ZpL2mT8nB5cYhR1dJfA0sUeGxVo4iKzN7yWbMtCaPqErDl6HjSgFuOI==",`,
      `+      "version": "${to}",`,
      `+      "resolved": "https://registry.npmjs.org/${name}/-/${name}-${to}.tgz",`,
      `+      "integrity": "sha512-${(i * 6151).toString(36).padStart(6, "0")}Zr8cNw2QhT5yVb1mXjL9dKfA3sUeGxPo7iKzN4yWbMtCaPqErDl0HjSgFuOI==",`,
      `       "dev": true,`,
      `       "engines": {`,
      `+        "node": ">=22"`,
      `-        "node": ">=18"`,
      `       }`,
      `     },`,
    ];
    hunks.push(hunk(oldLine, newLine, `"packages": {`, lines));
    oldLine += 40;
    newLine += 40;
  }
  return patch(...hunks);
}

// An API index where every entry's link moved with the folder rename: long on purpose.
function apiIndex(): FileDiff {
  const hunks: string[] = [];
  for (let i = 0; i < 80; i++) {
    const name = `endpoint-${String(i + 1).padStart(3, "0")}`;
    const line = 20 + i * 12;
    hunks.push(
      hunk(line, line, `### ${name}`, [
        ` `,
        ` Handles requests for \`${name}\`.`,
        `-See [the request format](../getting-started/formats/${name}.md).`,
        `+See [the request format](../start/formats/${name}.md).`,
        `-See [error codes](../help/errors/${name}.md).`,
        `+See [error codes](../support/errors/${name}.md).`,
        ` `,
      ]),
    );
  }
  return patch(...hunks);
}

// ---------------------------------------------------------------------------
// Per scenario
// ---------------------------------------------------------------------------

const webhookRetry: Record<string, FileDiff> = {
  "src/webhooks/sender.ts": patch(
    hunk(1, 1, "", [
      ` import { request } from "undici";`,
      `+import { backoffDelay, isRetryable, MAX_ATTEMPTS } from "./retry";`,
      ` import type { WebhookEvent } from "./types";`,
      ` import { markFailed, markSent } from "./store";`,
      ` `,
    ]),
    hunk(14, 15, "export async function deliver(event: WebhookEvent) {", [
      `   const body = JSON.stringify(event.payload);`,
      `-  try {`,
      `-    const res = await request(event.url, { method: "POST", body });`,
      `-    if (res.statusCode >= 400) throw new Error(\`status \${res.statusCode}\`);`,
      `-    await markSent(event.id);`,
      `-  } catch (err) {`,
      `-    await markFailed(event.id, String(err));`,
      `-  }`,
      `+  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {`,
      `+    try {`,
      `+      const res = await request(event.url, { method: "POST", body });`,
      `+      if (res.statusCode < 400) {`,
      `+        await markSent(event.id, attempt);`,
      `+        return;`,
      `+      }`,
      `+      if (!isRetryable(res.statusCode)) {`,
      `+        await markFailed(event.id, \`status \${res.statusCode}\`, attempt);`,
      `+        return;`,
      `+      }`,
      `+    } catch (err) {`,
      `+      if (attempt === MAX_ATTEMPTS) {`,
      `+        await markFailed(event.id, String(err), attempt);`,
      `+        return;`,
      `+      }`,
      `+    }`,
      `+    await sleep(backoffDelay(attempt));`,
      `+  }`,
      `+  await markFailed(event.id, "retries exhausted", MAX_ATTEMPTS);`,
      ` }`,
      ` `,
      `+const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));`,
    ]),
    hunk(31, 42, "", [
      ` export async function deliverAll(events: WebhookEvent[]) {`,
      `-  for (const event of events) await deliver(event);`,
      `+  await Promise.all(events.map((event) => deliver(event)));`,
      ` }`,
    ]),
  ),
  "src/webhooks/retry.ts": patch(
    hunk(0, 1, "", [
      `+export const MAX_ATTEMPTS = 5;`,
      `+const BASE_MS = 500;`,
      `+const CAP_MS = 30_000;`,
      `+`,
      `+/** Only server errors and rate limits are worth another try; other 4xx will not change. */`,
      `+export function isRetryable(status: number): boolean {`,
      `+  return status >= 500 || status === 429;`,
      `+}`,
      `+`,
      `+/** Exponential backoff with full jitter. */`,
      `+export function backoffDelay(attempt: number): number {`,
      `+  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));`,
      `+  return Math.floor(Math.random() * ceiling);`,
      `+}`,
    ]),
  ),
};

const cartQuestion: Record<string, FileDiff> = {
  "app/cart/actions.ts": patch(
    hunk(1, 1, "", [
      `-import { NextResponse } from "next/server";`,
      `+"use server";`,
      `+`,
      `+import { revalidatePath } from "next/cache";`,
      ` import { getCart, saveCart } from "@/lib/cart";`,
      `+import { getSession } from "@/lib/session";`,
      ` `,
    ]),
    hunk(8, 9, "", [
      `-export async function POST(req: Request) {`,
      `-  const { sku, qty } = await req.json();`,
      `-  const cart = await getCart();`,
      `-  const line = cart.lines.find((l) => l.sku === sku);`,
      `-  if (line) line.qty += qty;`,
      `-  else cart.lines.push({ sku, qty });`,
      `-  await saveCart(cart);`,
      `-  return NextResponse.json(cart);`,
      `-}`,
      `+export async function addToCart(sku: string, qty: number) {`,
      `+  const session = await getSession();`,
      `+  const cart = await getCart(session.cartId);`,
      `+  const line = cart.lines.find((l) => l.sku === sku);`,
      `+  if (line) line.qty += qty;`,
      `+  else cart.lines.push({ sku, qty });`,
      `+  await saveCart(cart);`,
      `+  revalidatePath("/cart");`,
      `+  return cart;`,
      `+}`,
      `+`,
      `+export async function removeFromCart(sku: string) {`,
      `+  const session = await getSession();`,
      `+  const cart = await getCart(session.cartId);`,
      `+  cart.lines = cart.lines.filter((l) => l.sku !== sku);`,
      `+  await saveCart(cart);`,
      `+  revalidatePath("/cart");`,
      `+  return cart;`,
      `+}`,
    ]),
  ),
  "app/cart/page.tsx": patch(
    hunk(1, 1, "", [
      ` import { getCart } from "@/lib/cart";`,
      `+import { removeFromCart } from "./actions";`,
      ` import { CartLine } from "./cart-line";`,
      ` `,
    ]),
    hunk(9, 10, "export default async function CartPage() {", [
      `   const cart = await getCart();`,
      `   return (`,
      `     <main>`,
      `       <h1>Your cart</h1>`,
      `-      {cart.lines.map((line) => (`,
      `-        <CartLine key={line.sku} line={line} onRemove={() => fetch("/api/cart", { method: "DELETE", body: line.sku })} />`,
      `-      ))}`,
      `+      {cart.lines.map((line) => (`,
      `+        <form key={line.sku} action={removeFromCart.bind(null, line.sku)}>`,
      `+          <CartLine line={line} />`,
      `+        </form>`,
      `+      ))}`,
      `     </main>`,
      `   );`,
      ` }`,
    ]),
  ),
  "app/api/cart/route.ts": patch(
    hunk(1, 1, "", [
      `-import { NextResponse } from "next/server";`,
      `-import { getCart, saveCart } from "@/lib/cart";`,
      `+import { addToCart } from "@/app/cart/actions";`,
      ` `,
      `-export async function GET() {`,
      `-  return NextResponse.json(await getCart());`,
      `-}`,
      `-`,
      ` export async function POST(req: Request) {`,
      `   const { sku, qty } = await req.json();`,
      `-  const cart = await getCart();`,
      `-  cart.lines.push({ sku, qty });`,
      `-  await saveCart(cart);`,
      `-  return NextResponse.json(cart);`,
      `+  // Kept for old clients; forwards to the server action.`,
      `+  return Response.json(await addToCart(sku, qty));`,
      ` }`,
    ]),
  ),
};

const fixLinks: Record<string, FileDiff> = {
  "guides/install.md": patch(
    hunk(8, 8, "## Requirements", [
      ` Install the CLI with your package manager, then follow the`,
      `-[quick start](../getting-started/quickstart.md) to create a project.`,
      `+[quick start](../start/quickstart.md) to create a project.`,
      ` `,
      `-If you run into trouble, see [troubleshooting](../help/troubleshooting.md).`,
      `+If you run into trouble, see [troubleshooting](../support/troubleshooting.md).`,
      ` `,
    ]),
    hunk(30, 30, "## Next steps", [
      `-- [Configuration](../getting-started/config.md)`,
      `-- [Deploying with Docker](deploy/docker.md)`,
      `-- [CLI reference](../reference/cli.md)`,
      `+- [Configuration](../start/config.md)`,
      `+- [Deploying with Docker](deploy/docker.md)`,
      `+- [CLI reference](../reference/cli.md)`,
      ` `,
      `-See also the [old migration guide](../help/migrate-v1.md).`,
      `+See also the [migration guide](../support/migrate-v1.md).`,
    ]),
  ),
  "guides/deploy/docker.md": patch(
    hunk(5, 5, "## Build the image", [
      ` The image is built from the repository root. Use the same Node version as`,
      `-in [the install guide](../../getting-started/install.md).`,
      `+in [the install guide](../install.md).`,
      ` `,
      `-Environment variables are listed in [configuration](../../getting-started/config.md).`,
      `+Environment variables are listed in [configuration](../../start/config.md).`,
    ]),
    hunk(40, 40, "## Health checks", [
      ` The container exposes \`/healthz\`.`,
      `-Probes are described in the [operations handbook](../../ops/handbook.md).`,
      `+Probes are described in the [operations handbook](../../operations/handbook.md).`,
    ]),
  ),
  "reference/cli.md": patch(
    hunk(12, 12, "## telepi init", [
      ` Creates a new project in the current directory.`,
      `-See the [project layout](../getting-started/layout.md) and the`,
      `-[legacy init flags](../help/legacy-flags.md).`,
      `+See the [project layout](../start/layout.md).`,
      ` `,
    ]),
    hunk(58, 57, "## telepi deploy", [
      ` Deploys the current branch.`,
      `-Deprecated: [the old deploy wizard](../help/wizard.md) is gone; use flags instead.`,
      `-See [deploying with Docker](../guides/deploy/docker.md).`,
      `+See [deploying with Docker](../guides/deploy/docker.md).`,
    ]),
  ),
  "reference/api-index.md": apiIndex(),
  // A binary file: the diagram that was re-exported after the rename.
  "guides/images/install-flow.png": { binary: true, patch: "" },
};

const failingUpgrade: Record<string, FileDiff> = {
  ".nvmrc": patch(hunk(1, 1, "", [`-20.18.0`, `+22.11.0`])),
  "package.json": patch(
    hunk(24, 24, `"engines": {`, [
      `   "engines": {`,
      `-    "node": ">=20"`,
      `+    "node": ">=22"`,
      `   },`,
    ]),
  ),
  "src/lib/urls.ts": patch(
    hunk(1, 1, "", [
      `-import url from "node:url";`,
      ` `,
      ` export interface ParsedLink {`,
      `   host: string;`,
      `   path: string;`,
      `+  query: Record<string, string>;`,
      ` }`,
      ` `,
    ]),
    hunk(9, 9, "", [
      ` export function parseLink(input: string): ParsedLink | null {`,
      `-  const u = url.parse(input, true);`,
      `-  if (!u.hostname) return null;`,
      `-  return { host: u.hostname, path: u.pathname ?? "/" };`,
      `+  if (!URL.canParse(input)) return null;`,
      `+  const u = new URL(input);`,
      `+  return { host: u.hostname, path: u.pathname, query: Object.fromEntries(u.searchParams) };`,
      ` }`,
      ` `,
      ` export function joinLink(base: string, rel: string): string {`,
      `-  return url.resolve(base, rel);`,
      `+  return new URL(rel, base).toString();`,
      ` }`,
    ]),
  ),
  "src/net/tls.ts": patch(
    hunk(3, 3, "", [
      ` import tls from "node:tls";`,
      ` `,
      `-const CIPHERS = "ECDHE-RSA-AES128-SHA:AES128-SHA";`,
      `+// Node 22 dropped the SHA-1 CBC suites from its defaults.`,
      `+const CIPHERS = "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384";`,
      ` `,
      ` export function connect(host: string, port: number) {`,
      `-  return tls.connect({ host, port, ciphers: CIPHERS, rejectUnauthorized: false });`,
      `+  return tls.connect({ host, port, ciphers: CIPHERS, minVersion: "TLSv1.2" });`,
      ` }`,
    ]),
  ),
  "package-lock.json": lockfile(),
};

const sendData: Record<string, FileDiff> = {
  "src/config.ts": patch(
    hunk(10, 10, "export const config = {", [
      `   port: Number(process.env.PORT ?? 3000),`,
      `-  logLevel: process.env.LOG_LEVEL ?? "info",`,
      `-  cacheTtl: 60,`,
      `+  logLevel: process.env.LOG_LEVEL ?? "warn",`,
      `+  cacheTtlSeconds: Number(process.env.CACHE_TTL ?? 60),`,
      `   dbUrl: required("DATABASE_URL"),`,
      `-  legacyAuth: true,`,
      `+  legacyAuth: false,`,
      ` };`,
    ]),
  ),
};

const blocked: Record<string, FileDiff> = {
  "src/pricing/table.ts": patch(
    hunk(1, 1, "", [
      `-import { fetchRates } from "./live-rates";`,
      `+import rates from "../../fixtures/rates.json";`,
      ` `,
      ` export interface Rate {`,
      `   currency: string;`,
      `   perUsd: number;`,
      ` }`,
    ]),
    hunk(12, 12, "", [
      `-export async function loadTable(): Promise<Rate[]> {`,
      `-  const live = await fetchRates();`,
      `-  return Object.entries(live.rates).map(([currency, perUsd]) => ({ currency, perUsd }));`,
      `-}`,
      `+// Values come from the bundled fixture, so they can be out of date.`,
      `+export function loadTable(): Rate[] {`,
      `+  return Object.entries(rates.rates).map(([currency, perUsd]) => ({ currency, perUsd: Number(perUsd) }));`,
      `+}`,
      ` `,
      `-export async function convert(amount: number, currency: string): Promise<number> {`,
      `-  const table = await loadTable();`,
      `+export function convert(amount: number, currency: string): number {`,
      `+  const table = loadTable();`,
      `   const rate = table.find((r) => r.currency === currency);`,
      `   if (!rate) throw new Error(\`unknown currency \${currency}\`);`,
      `   return amount * rate.perUsd;`,
      ` }`,
    ]),
  ),
};

/** Files of the generic tail used when a task is resumed after a restart. */
const resumed: Record<string, FileDiff> = {
  "src/worktree-check.ts": patch(
    hunk(0, 1, "", [
      `+import { execFileSync } from "node:child_process";`,
      `+`,
      `+/** True when the worktree has no uncommitted changes. */`,
      `+export function isClean(cwd: string): boolean {`,
      `+  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() === "";`,
      `+}`,
    ]),
  ),
  "CHANGELOG.md": patch(
    hunk(1, 1, "", [
      ` # Changelog`,
      ` `,
      `+## Unreleased`,
      `+`,
      `+- Verify the worktree is clean before resuming a task.`,
      `+`,
      ` ## 1.4.0`,
    ]),
  ),
};

export const scenarioFiles: Record<string, Record<string, FileDiff>> = {
  "webhook-retry": webhookRetry,
  question: cartQuestion,
  "fix-links": fixLinks,
  "failing-upgrade": failingUpgrade,
  "send-data": sendData,
  blocked,
};
export const resumedFiles = resumed;

/** "+N -M" for one or more catalog files, for step details that must agree with the review. */
export function deltaOf(...paths: string[]): string {
  const all: Record<string, FileDiff> = Object.assign({}, ...Object.values(scenarioFiles), resumed);
  let added = 0;
  let removed = 0;
  for (const path of paths) {
    const d = all[path];
    if (!d) continue;
    const c = countOf(d);
    added += c.added;
    removed += c.removed;
  }
  return `+${added} -${removed}`;
}
