// Believable unified diffs for the files in the mock reviews.
import type { TaskDiff } from "@telepi/contract";

const LIMIT = 400; // lines served without `full`
const FULL_LIMIT = 5000; // lines served even with `full`

export const BINARY_PATHS = new Set(["static/img/architecture.png"]);
/** Files whose counts differ from the generic small patch. */
export const BIG_FILES: Record<string, { added: number; removed: number }> = {
  "reference/config.md": { added: 400, removed: 400 },
  "package-lock.json": { added: 2000, removed: 2000 },
};

const LONG_URL =
  "curl -fsSL https://downloads.example.com/releases/v4.2.0/linux/amd64/docs-cli-4.2.0-linux-amd64.tar.gz?checksum=sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08&mirror=eu-west-1 | tar -xz -C /usr/local/bin";

function hunk(start: number, ctxBefore: string[], removed: string[], added: string[], ctxAfter: string[]): string[] {
  const oldLen = ctxBefore.length + removed.length + ctxAfter.length;
  const newLen = ctxBefore.length + added.length + ctxAfter.length;
  return [
    `@@ -${start},${oldLen} +${start},${newLen} @@`,
    ...ctxBefore.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...ctxAfter.map((l) => ` ${l}`),
  ];
}

function bigPatch(path: string, hunks: number, each: number): string[] {
  const out: string[] = [];
  const json = path.endsWith(".json");
  for (let h = 0; h < hunks; h++) {
    const n = h + 1;
    const row = (v: string, i: number) => (json ? `    "node_modules/pkg-${n}-${i}": { "version": "${v}" },` : `| option_${n}_${i} | ${v} | see the guide |`);
    const mk = (v: string) => Array.from({ length: each }, (_, i) => row(v, i));
    out.push(...hunk(1 + h * 24, [row("ctx", 90), row("ctx", 91)], mk("1.4.2"), mk("1.5.0"), [row("ctx", 92), row("ctx", 93)]));
  }
  return out;
}

function smallPatch(path: string, added: number, removed: number): string[] {
  const code = /\.(ts|js|json)$/.test(path);
  const old = Array.from({ length: removed }, (_, i) => (code ? `  const legacy${i} = load("old/${i}");` : `See [the old guide](../old/page-${i}.md) for details.`));
  const neu = Array.from({ length: added }, (_, i) => (code ? `  const current${i} = load("new/${i}");` : `See [the guide](../guides/page-${i}.md) for details.`));
  if (path === "guides/install.md") neu[0] = LONG_URL;
  const ctx = code ? ["export function setup() {", "  // load the pieces"] : ["## Install", ""];
  return hunk(8, ctx, old, neu, code ? ["  return true;", "}"] : ["", "Then run the check."]);
}

export function mockDiff(path: string, counts: { added: number; removed: number } | null, full: boolean): TaskDiff {
  if (BINARY_PATHS.has(path)) return { path, binary: true, patch: "", truncated: false };
  let lines: string[];
  if (path === "reference/config.md") lines = bigPatch(path, 100, 4);
  else if (path === "package-lock.json") lines = bigPatch(path, 400, 5);
  else lines = smallPatch(path, Math.min(counts?.added ?? 3, 60), Math.min(counts?.removed ?? 2, 60));
  const cap = full ? FULL_LIMIT : LIMIT;
  const truncated = lines.length > cap;
  return { path, binary: false, patch: (truncated ? lines.slice(0, cap) : lines).join("\n"), truncated };
}
