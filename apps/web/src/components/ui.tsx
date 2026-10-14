import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Project, Request, Task, TaskUsage } from "../data/api";
import { formatCost, formatSpan, formatTokens } from "../lib/usage";

export type Tone = "wait" | "run" | "ok" | "fail" | "none";

export function Chip({ tone = "none", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip ${tone === "none" ? "" : tone}`}>{children}</span>;
}

export function Kind({ tone, children, where }: { tone: Tone; children: ReactNode; where?: ReactNode }) {
  return (
    <span className={`kind k-${tone}`}>
      {children}
      {where != null && <span className="where">{where}</span>}
    </span>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return <h2 className="sect">{children}</h2>;
}

export function Pulse() {
  return <span className="pulse" aria-hidden="true" />;
}

export function Dot({ tone }: { tone: "ok" | "run" | "off" }) {
  return <span className={`dot ${tone === "ok" ? "" : tone}`} aria-hidden="true" />;
}

/** Line icons, drawn on a 20px grid with a 1.5px stroke. */
const ICONS = {
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></>,
  inbox: <><path d="M3.5 11.5 5.6 5a1.5 1.5 0 0 1 1.4-1h6a1.5 1.5 0 0 1 1.4 1l2.1 6.5" /><path d="M3.5 11.5V15A1.5 1.5 0 0 0 5 16.5h10a1.5 1.5 0 0 0 1.5-1.5v-3.5h-4l-1 2h-3l-1-2h-4Z" /></>,
  folder: <path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3l1.5 2H15A1.5 1.5 0 0 1 16.5 8v6.5A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5V6Z" />,
  plus: <><circle cx="10" cy="10" r="6.5" /><path d="M10 7.25v5.5M7.25 10h5.5" /></>,
  back: <path d="m11.5 5.5-4.5 4.5 4.5 4.5" />,
  go: <path d="m8 5.5 4.5 4.5L8 14.5" />,
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/** The mark in front of a tool call: a turning ring while it runs, a check or a cross once it lands. */
export function StepIcon({ status }: { status: "running" | "ok" | "fail" }) {
  if (status === "running") {
    return (
      <svg className="spin" width="14" height="14" viewBox="0 0 14 14" fill="none" strokeWidth="1.5" role="img" aria-label="Running">
        <circle cx="7" cy="7" r="5.25" stroke="var(--line-strong)" />
        <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeLinecap="round" strokeDasharray="9 33" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={status === "ok" ? "Done" : "Failed"}>
      {status === "ok" ? <path className="draw" d="m3.25 7.4 2.5 2.5 5-5.6" /> : <path className="draw" d="M4 4l6 6M10 4l-6 6" />}
    </svg>
  );
}

const COMMAND_VERBS = new Set(["Ran", "Tried"]);
const PATH_VERBS = new Set(["Read", "Edited", "Wrote", "Created", "Deleted", "Listed"]);

/** "Ran npm test" reads as a quiet verb and the thing it acted on, set in mono when that thing is a command or a path. */
export function StepLabel({ label }: { label: string }) {
  const space = label.indexOf(" ");
  const verb = space > 0 ? label.slice(0, space) : "";
  const rest = label.slice(space + 1);
  // "Read 4 files" is a count, not a path: only things that look like commands or paths are set in mono.
  const code = COMMAND_VERBS.has(verb) || (PATH_VERBS.has(verb) && /[./]/.test(rest));
  if (!COMMAND_VERBS.has(verb) && !PATH_VERBS.has(verb)) return <>{label}</>;
  return (
    <>
      <span className="verb">{verb}</span> <span className={code ? "obj" : undefined}>{rest}</span>
    </>
  );
}

/** The header every screen starts with. */
export function Top({ back, title, sub, right, chips, busy }: {
  back?: { to: string; label: string };
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  chips?: ReactNode;
  /** Shows a thin line of progress under the header while work is going on. */
  busy?: boolean;
}) {
  return (
    <header className="top" data-busy={busy || undefined}>
      {back && (
        <Link to={back.to} className="back">
          <Icon name="back" size={16} />
          <span>{back.label}</span>
        </Link>
      )}
      <div className="top-row">
        <h1 className="h">{title}</h1>
        {right}
      </div>
      {sub != null && <span className="sub">{sub}</span>}
      {chips != null && <div className="chips">{chips}</div>}
    </header>
  );
}

/** "+48 −7" with the numbers coloured. */
export function Delta({ added, removed }: { added: number; removed: number }) {
  return (
    <span>
      <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
    </span>
  );
}

/** A free-form detail string; tokens like +48 and −7 get the diff colours. */
export function Detail({ text }: { text: string }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((p, i) =>
        /^\+\d+$/.test(p) ? <span key={i} className="plus">{p}</span> : /^[−-]\d+$/.test(p) ? <span key={i} className="minus">{p}</span> : p,
      )}
    </>
  );
}

export function requestKind(r: Request): { tone: Tone; label: string } {
  const p = r.payload;
  if (p.kind === "approval") return { tone: "fail", label: "Approval" };
  if (p.kind === "question") return { tone: "wait", label: "Question" };
  return p.outcome === "failed" ? { tone: "fail", label: "Failed" } : { tone: "ok", label: "Review" };
}

export function taskTone(state: Task["state"]): Tone {
  switch (state) {
    case "running": return "run";
    case "waiting": return "wait";
    case "done": return "ok";
    case "failed": return "fail";
    default: return "none";
  }
}

export const statusTone = (s: Project["status"]): Tone => (s === "waiting" ? "wait" : s === "running" ? "run" : "none");
export const statusWord = (s: Project["status"]) => (s === "waiting" ? "Waiting for you" : s === "running" ? "Running" : "Idle");

/**
 * What a task cost, as rows of a `dl.kv`. One figure per row; the breakdown sits beside it, quieter. The context row
 * turns to the waiting colour when the model is close to the most it can read.
 */
export function UsageRows({ usage }: { usage: TaskUsage }) {
  const sent = usage.inputTokens + usage.cachedTokens;
  const cached = sent > 0 ? Math.round((usage.cachedTokens / sent) * 100) : 0;
  const full = usage.contextWindow ? usage.contextTokens / usage.contextWindow : 0;
  return (
    <>
      <dt>Cost</dt>
      <dd>
        {formatCost(usage.costUsd)}
        <span className="aside">{formatTokens(sent + usage.outputTokens)} tokens{cached > 0 ? `, ${cached}% from cache` : ""}</span>
      </dd>
      <dt>Worked</dt>
      <dd>
        {formatSpan(usage.modelMs + usage.toolMs)}
        <span className="aside">{usage.turns} {usage.turns === 1 ? "turn" : "turns"}{usage.toolMs >= 1000 ? `, ${formatSpan(usage.toolMs)} of it in commands` : ""}</span>
      </dd>
      {/* In ordinary tasks the model reads a sliver of what it can; the row appears only once that stops being true. */}
      {(full >= 0.5 || usage.compactions > 0) && (
        <>
      <dt>Context</dt>
      <dd className={full >= 0.8 ? "near-full" : undefined}>
        {usage.contextWindow ? `${full < 0.01 ? "<1" : Math.round(full * 100)}% used` : `${formatTokens(usage.contextTokens)} tokens`}
        <span className="aside">
          {usage.contextWindow ? `${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)}` : ""}
          {usage.compactions > 0 ? `${usage.contextWindow ? ", " : ""}older steps summarised ${usage.compactions === 1 ? "once" : `${usage.compactions} times`}` : ""}
        </span>
      </dd>
        </>
      )}
    </>
  );
}
