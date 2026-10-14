// The pre-tool decision pipeline. Pure: no I/O, no clock beyond judge timeouts.
// Stage 1 (rules) is deterministic and may run, ask or block. Stage 2 (judges) can only escalate:
// it is reached only through the rules' `continue` result and its verdicts have no way to say "run".
import type { ApprovalReasonCode, PluginAction } from "@telepi/contract";

// Timers exist in every runtime this runs in; declared here so the package needs no DOM or Node types.
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A shell command, optionally with the script it invokes. */
export interface ShellCall {
  kind: "shell";
  command: string;
  script?: { path: string; content?: string };
}

/** A plugin action, with a human-readable detail such as the request or the command it will run. */
export interface ActionCall {
  kind: "action";
  action: PluginAction;
  detail: string;
}

export type ToolCall = ShellCall | ActionCall;

export interface DecisionContext {
  /** The project has allowed this call's action id permanently. Ignored for shell calls. */
  actionAllowed: boolean;
  /** The destination is inside policy at all. */
  insidePolicy: boolean;
  /** The call can reach an endpoint that holds a credential. */
  reachesCredentialed: boolean;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface Reason<C extends string = string> {
  code: C;
  /** One sentence fit to show a user. */
  text: string;
}

export type Decision =
  | { outcome: "run"; stage: string; reason: Reason<"ok">; canAllowPermanently: false }
  | { outcome: "block"; stage: string; reason: Reason<"outside_policy">; canAllowPermanently: false }
  | { outcome: "ask"; stage: string; reason: Reason<ApprovalReasonCode>; canAllowPermanently: boolean };

export type AskDecision = Extract<Decision, { outcome: "ask" }>;

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

/** What a judge may say. There is deliberately no "run" or "block": judges only escalate. */
export type Verdict =
  | { verdict: "pass" }
  | { verdict: "ask"; reason: Reason<ApprovalReasonCode> }
  | { verdict: "unsure" };

export interface Judge {
  /** Reported as the decision's stage when this judge asks. */
  name: string;
  judge(call: ToolCall, ctx: DecisionContext): Promise<Verdict>;
}

// ---------------------------------------------------------------------------
// Stage 1: rules
// ---------------------------------------------------------------------------

export type RulesResult = { next: "decided"; decision: Decision } | { next: "judges" };

export function applyRules(call: ToolCall, ctx: DecisionContext): RulesResult {
  if (!ctx.insidePolicy) {
    return {
      next: "decided",
      decision: {
        outcome: "block",
        stage: "rules",
        reason: { code: "outside_policy", text: "The destination is outside this project's policy." },
        canAllowPermanently: false,
      },
    };
  }
  if (call.kind === "action") {
    const label = call.action.label;
    if (call.action.class === "destructive") {
      return {
        next: "decided",
        decision: {
          outcome: "ask",
          stage: "rules",
          reason: { code: "destructive", text: `"${label}" is destructive. It asks every time and can't be allowed permanently.` },
          canAllowPermanently: false,
        },
      };
    }
    if (call.action.class === "write" && !ctx.actionAllowed) {
      return {
        next: "decided",
        decision: {
          outcome: "ask",
          stage: "rules",
          reason: { code: "first_time", text: `"${label}" has not been allowed in this project yet.` },
          canAllowPermanently: true,
        },
      };
    }
  }
  return { next: "judges" };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /** Consulted in order, only when the rules let the call through. */
  judges: Judge[];
  /** A judge that takes longer counts as ask. Default 5000. */
  judgeTimeoutMs?: number;
}

export interface Pipeline {
  decide(call: ToolCall, ctx: DecisionContext): Promise<Decision>;
}

function judgeAsk(stage: string, reason: Reason<ApprovalReasonCode>): AskDecision {
  return { outcome: "ask", stage, reason, canAllowPermanently: false };
}

async function consult(judge: Judge, call: ToolCall, ctx: DecisionContext, timeoutMs: number): Promise<Verdict> {
  let timer: unknown;
  try {
    const timeout = new Promise<Verdict>((resolve) => {
      timer = setTimeout(
        () => resolve({ verdict: "ask", reason: { code: "judge", text: `The check "${judge.name}" timed out, so it needs your call.` } }),
        timeoutMs,
      );
    });
    return await Promise.race([judge.judge(call, ctx), timeout]);
  } catch {
    return { verdict: "ask", reason: { code: "judge", text: `The check "${judge.name}" failed, so it needs your call.` } };
  } finally {
    clearTimeout(timer);
  }
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const timeoutMs = options.judgeTimeoutMs ?? 5000;
  return {
    async decide(call, ctx) {
      const rules = applyRules(call, ctx);
      if (rules.next === "decided") return rules.decision;

      let last: Verdict = { verdict: "pass" };
      for (const judge of options.judges) {
        last = await consult(judge, call, ctx, timeoutMs);
        if (last.verdict === "ask") return judgeAsk(judge.name, last.reason);
      }
      if (last.verdict === "unsure" && ctx.reachesCredentialed) {
        return judgeAsk("judges", { code: "judge", text: "Nothing could confirm this is safe and it can reach a credentialed endpoint." });
      }
      return { outcome: "run", stage: "judges", reason: { code: "ok", text: "No check objected." }, canAllowPermanently: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in judge: the pattern list
// ---------------------------------------------------------------------------

/** Splits a command line into simple commands on ; & | and newlines, then into words with quotes stripped. */
function segments(text: string): string[][] {
  return text
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "")))
    .filter((words) => words.length > 0);
}

/** The target leaves the worktree: absolute, home, parent-relative, or a bare `*` at the root. */
function escapesWorktree(target: string): boolean {
  return (
    target.startsWith("/") ||
    target.startsWith("~") ||
    target.startsWith("$HOME") ||
    target === ".." ||
    target.startsWith("../") ||
    target.includes("/../") ||
    target.endsWith("/..") ||
    target === "*"
  );
}

const shortFlags = (words: string[]) => words.filter((w) => /^-[A-Za-z]+$/.test(w)).map((w) => w.slice(1)).join("");
const operands = (words: string[]) => words.filter((w) => !w.startsWith("-"));

/** Returns what matched in one simple command, or null. */
function matchSegment(words: string[]): string | null {
  // Skip leading `sudo`, env assignments.
  let i = 0;
  while (words[i] === "sudo" || /^\w+=/.test(words[i] ?? "")) i++;
  const [cmd, ...args] = words.slice(i);
  if (!cmd) return null;
  const name = cmd.split("/").pop() ?? cmd;

  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "push") {
      const rest = args.slice(args.indexOf("push") + 1);
      if (rest.some((a) => a === "--force" || a === "--force-with-lease" || a.startsWith("--force-with-lease=") || /^-[A-Za-z]*f[A-Za-z]*$/.test(a))) {
        return "The command force-pushes a branch.";
      }
    }
    if (sub === "clean") {
      const rest = args.slice(args.indexOf("clean") + 1);
      const f = shortFlags(rest);
      if (f.includes("f") && f.includes("d") && operands(rest).some(escapesWorktree)) {
        return "The command removes untracked files outside the worktree.";
      }
    }
    return null;
  }
  if (name === "rm") {
    const recursive = args.some((a) => a === "--recursive") || /[rR]/.test(shortFlags(args));
    if (recursive && operands(args).some(escapesWorktree)) return "The command recursively deletes files outside the worktree.";
    return null;
  }
  if (name === "chmod") {
    const recursive = args.includes("--recursive") || /R/.test(shortFlags(args));
    // First operand is the mode; the rest are targets.
    if (recursive && operands(args).slice(1).some(escapesWorktree)) return "The command changes permissions recursively outside the worktree.";
    return null;
  }
  if (name === "mkfs" || name.startsWith("mkfs.")) {
    if (operands(args).some(escapesWorktree)) return "The command formats a disk or partition.";
    return null;
  }
  if (name === "dd") {
    if (args.some((a) => a.startsWith("of=/dev/"))) return "The command writes raw data to a device.";
    return null;
  }
  if (name === "kubectl" && args.includes("delete")) return "The command deletes Kubernetes resources.";
  if (name === "terraform" && args.includes("destroy")) return "The command destroys Terraform-managed infrastructure.";
  if (name === "docker" && args[0] === "system" && args[1] === "prune") return "The command prunes Docker data.";
  return null;
}

function matchSql(text: string): string | null {
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i.test(text)) return "The statement drops a database object.";
  if (/\bTRUNCATE\s+(TABLE\s+)?[\w"`.]+/i.test(text) && !/^\s*truncate\s+-/i.test(text)) return "The statement truncates a table.";
  for (const stmt of text.split(";")) {
    if (/\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) return "The statement deletes every row of a table.";
  }
  return null;
}

/** The file names one simple command downloads to: curl -o/-O, wget and wget -O. Empty when it downloads nothing to a file. */
function downloadsOf(words: string[]): string[] {
  const at = words.findIndex((w) => /^(.*\/)?(curl|wget)$/.test(w));
  if (at < 0) return [];
  const isCurl = /curl$/.test(words[at]!);
  const args = words.slice(at + 1);
  const base = (w: string) => w.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
  const urls = args.filter((a) => /^https?:\/\//.test(a)).map(base).filter(Boolean);
  const named: string[] = [];
  args.forEach((a, i) => {
    const next = args[i + 1];
    if ((isCurl ? /^(-[A-Za-z]*o|--output)$/ : /^(-[A-Za-z]*O|--output-document)$/).test(a) && next && next !== "-") named.push(base(next));
    const joined = a.match(isCurl ? /^--output=(.+)$/ : /^--output-document=(.+)$/);
    if (joined?.[1] && joined[1] !== "-") named.push(base(joined[1]));
  });
  if (named.length > 0) return named;
  // curl saves under the URL's name only with -O; wget does it unless told to write elsewhere.
  if (isCurl) return args.some((a) => /^(-[A-Za-z]*O[A-Za-z]*|--remote-name(-all)?)$/.test(a)) ? urls : [];
  return args.some((a) => /^(-[A-Za-z]*O|--output-document)/.test(a)) ? [] : urls;
}

const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "source", ".", "python", "python3", "node", "perl", "ruby", "exec"]);

/** One simple command runs one of the named files: `sh x`, `./x`, `sudo bash x`, `python x`. */
function runsOneOf(words: string[], files: string[]): boolean {
  let i = 0;
  while (words[i] === "sudo" || words[i] === "env" || /^\w+=/.test(words[i] ?? "")) i++;
  const [cmd, ...args] = words.slice(i);
  if (!cmd) return false;
  const name = (w: string) => w.split("/").pop() ?? w;
  if (files.includes(name(cmd)) && cmd.includes("/")) return true;
  // The file an interpreter runs is its first operand; later ones are that script's own arguments.
  const script = args.find((a) => !a.startsWith("-"));
  return RUNNERS.has(name(cmd)) && script !== undefined && files.includes(name(script));
}

function matchText(text: string): string | null {
  if (/\b(curl|wget)\b[^|;\n]*\|\s*(sudo\s+)?(\S*\/)?(ba|z|da|k)?sh\b/.test(text)) return "The command pipes a download into a shell.";
  const saved: string[] = [];
  for (const words of segments(text)) {
    if (saved.length > 0 && runsOneOf(words, saved)) return "The command downloads a file and runs it.";
    saved.push(...downloadsOf(words));
  }
  for (const words of segments(text)) {
    const hit = matchSegment(words);
    if (hit) return hit;
  }
  return matchSql(text);
}

/** Known destructive patterns in shell commands and in the content of scripts they invoke. No model. */
export const patternJudge: Judge = {
  name: "patterns",
  async judge(call) {
    const texts: string[] = [];
    if (call.kind === "shell") {
      texts.push(call.command);
      if (call.script?.content) texts.push(call.script.content);
    } else {
      texts.push(call.detail);
    }
    for (const t of texts) {
      const hit = matchText(t);
      if (hit) return { verdict: "ask", reason: { code: "pattern", text: hit } };
    }
    return { verdict: "pass" };
  },
};
