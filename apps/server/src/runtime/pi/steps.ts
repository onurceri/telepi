// Human labels for tool calls: what the app shows as steps. Never file contents or long command output.

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function oneLine(text: string, max: number): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function stepStart(tool: string, args: Record<string, unknown>): { label: string; detail: string | null } {
  switch (tool) {
    case "read":
      return { label: `Read ${str(args.path, "a file")}`, detail: null };
    case "write":
      return { label: `Wrote ${str(args.path, "a file")}`, detail: null };
    case "edit":
      return { label: `Edited ${str(args.path, "a file")}`, detail: null };
    case "bash":
      return { label: `Ran ${oneLine(str(args.command, "a command"), 60)}`, detail: null };
    case "ask_user":
      return { label: "Asked a question", detail: null };
    case "report_failure":
      return { label: "Reported a problem", detail: null };
    case "open_pull_request":
      return { label: "Opened pull request", detail: oneLine(str(args.title), 80) || null };
    default:
      return { label: `Used ${tool}`, detail: null };
  }
}

function countPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function testSummary(output: string): { passed?: number; failed?: number } {
  const pass = /(?:ℹ|#)\s*pass\s+(\d+)/.exec(output) ?? /(\d+)\s+passed/.exec(output);
  const fail = /(?:ℹ|#)\s*fail\s+(\d+)/.exec(output) ?? /(\d+)\s+failed/.exec(output);
  return { passed: pass ? Number(pass[1]) : undefined, failed: fail ? Number(fail[1]) : undefined };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  details: unknown;
}

export function stepFinish(tool: string, args: Record<string, unknown> | undefined, r: ToolOutcome): { ok: boolean; detail: string | null } {
  const ok = !r.isError;
  switch (tool) {
    case "edit": {
      const details = r.details as { patch?: string; diff?: string } | undefined;
      const patch = details?.patch ?? details?.diff;
      if (!ok || !patch) return { ok, detail: ok ? null : oneLine(r.text, 80) };
      const { added, removed } = countPatch(patch);
      return { ok, detail: `+${added} -${removed}` };
    }
    case "write": {
      const content = str(args?.content);
      return { ok, detail: ok && content ? `${content.split("\n").length} lines` : ok ? null : oneLine(r.text, 80) };
    }
    case "bash": {
      const exit = /Command exited with code (\d+)/.exec(r.text)?.[1];
      const t = testSummary(r.text);
      if (ok) {
        if (t.passed !== undefined) return { ok, detail: t.failed ? `${t.passed} passed, ${t.failed} failed` : `${t.passed} passed` };
        return { ok, detail: "ok" };
      }
      if (/timed out/.test(r.text)) return { ok, detail: "timed out" };
      const base = exit ? `exit ${exit}` : "failed";
      return { ok, detail: t.failed ? `${base}, ${t.failed} failed` : base };
    }
    case "open_pull_request": {
      const n = /#(\d+)/.exec(r.text)?.[1];
      return { ok, detail: ok ? (n ? `#${n}` : null) : oneLine(r.text, 80) };
    }
    default:
      return { ok, detail: ok ? null : oneLine(r.text, 80) };
  }
}
