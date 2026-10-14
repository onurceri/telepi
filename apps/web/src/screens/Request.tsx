import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { RetryButton } from "../components/models";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Chip, Delta, Top, UsageRows } from "../components/ui";
import { useAppState, useData, type Request, type RequestAnswer, type Task } from "../data/api";
import { Sheet } from "../components/Sheet";
import { Markdown, MarkdownInline } from "../lib/markdown";
import { formatAge, useNow } from "../lib/time";

type Payload<K extends Request["payload"]["kind"]> = Extract<Request["payload"], { kind: K }>;

interface Ctx {
  request: Request;
  task: Task | undefined;
  projectName: string;
  /** Submit an answer; resolves to an error message, or null when it went through. */
  submit: (answer: RequestAnswer) => Promise<string | null>;
  online: boolean;
}

/** When the bottom bar changes height and the content above was scrolled to its end, keep it at its end so the last control stays in view. */
function useKeepBottom(bar: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = bar.current;
    const body = el?.previousElementSibling as HTMLElement | null;
    if (!el || !body || typeof ResizeObserver === "undefined") return;
    let atEnd = false;
    let first = true;
    const measure = () => { atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 8; };
    body.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(() => { if (first) { first = false; return; } if (atEnd) body.scrollTop = body.scrollHeight; });
    ro.observe(el);
    return () => { body.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [bar]);
}

const OFFLINE_NOTE = "Answers need a live connection. Nothing is queued, so a late reply can’t land on work that has moved on.";

function Highlighted({ format, text }: { format: "command" | "sql" | "diff" | "text"; text: string }) {
  const lines = text.split("\n");
  // Everything the user must read to decide wraps, with a hanging indent so wrapped lines stay readable.
  // Only a diff keeps its columns and scrolls sideways inside the block.
  const wrap = format !== "diff";
  return (
    <pre className={`pre ${wrap ? "wrap" : ""}`} tabIndex={0}>
      {lines.map((line, i) => {
        let cls = "";
        if (format === "sql" && /\b(DROP|TRUNCATE|DELETE)\b/.test(line)) cls = "bad";
        else if (format === "diff") cls = line.startsWith("+") ? "plus" : line.startsWith("-") ? "minus" : "";
        else if (format === "command" && /\brm\s+-rf?\b|\bsudo\b/.test(line)) cls = "bad";
        if (!wrap) return <span key={i} className={cls}>{line}{i < lines.length - 1 ? "\n" : ""}</span>;
        const indent = line.length - line.trimStart().length;
        return (
          <span key={i} className={`ln ${cls}`} style={{ paddingLeft: `${indent + 2}ch` }}>
            {line.trim() === "" ? "\u00a0" : line.trimStart()}
          </span>
        );
      })}
    </pre>
  );
}

type DetailFormat = "command" | "sql" | "diff" | "text";

/** The agent's sandbox has no network by default; a denied request can be widened to the whole task. */
const isNetworkAction = (a: { id: string }) => /^network\./.test(a.id);

function Sections({ sections }: { sections: { title: string; format: DetailFormat; text: string; collapsed: boolean }[] }) {
  return (
    <div className="sections">
      {sections.map((s, i) =>
        s.collapsed ? (
          <details key={i} className="sec fold">
            <summary>{s.title}</summary>
            <Highlighted format={s.format} text={s.text} />
          </details>
        ) : (
          <section key={i} className="sec" aria-label={s.title}>
            <h2 className="sec-h">{s.title}</h2>
            <Highlighted format={s.format} text={s.text} />
          </section>
        ),
      )}
    </div>
  );
}

function Approval({ ctx, payload }: { ctx: Ctx; payload: Payload<"approval"> }) {
  const [note, setNote] = useState("");
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmTask, setConfirmTask] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useKeepBottom(barRef);

  const decide = async (decision: "approve" | "deny", forTask = false) => {
    setBusy(decision);
    setError(null);
    const message = await ctx.submit({
      kind: "approval",
      decision,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(decision === "approve" && always && payload.canAllowPermanently ? { allowPermanently: true } : {}),
      // Opposite of "always allow": never sent together.
      ...(decision === "deny" && forTask && payload.canDenyForTask && !always ? { denyForTask: true } : {}),
    });
    if (message) {
      setBusy(null);
      setError(message);
    }
  };
  const disabled = !ctx.online || busy !== null;
  const destructive = payload.reason.code === "destructive";
  const network = isNetworkAction(payload.action);
  const denyTaskLabel = network ? "Deny all network access for this task" : "Deny for the rest of this task";
  const denyTaskHelp = network
    ? "Denies this and every later network request in this task without asking."
    : "Denies this and every later request of this kind in this task without asking.";
  const sections = payload.detail.sections;

  return (
    <>
      <div className="body">
        <div className="pad">
          <dl className="kv">
            <dt>Project</dt><dd>{ctx.projectName}</dd>
            <dt>Task</dt><dd>{ctx.task?.title ?? "—"}</dd>
            {payload.send ? (
              <>
                <dt>Sending to</dt><dd className="target">{payload.send.host}</dd>
                <dt>Request</dt><dd className="mono target">{payload.send.method} {payload.send.path}</dd>
              </>
            ) : (
              <>
                <dt>Action</dt><dd>{payload.action.label} <span className="by">{payload.action.plugin}</span></dd>
                {payload.target && (<><dt>Target</dt><dd className="target">{payload.target}</dd></>)}
              </>
            )}
          </dl>
          {sections.length > 0 ? <Sections sections={sections} /> : <Highlighted format={payload.detail.format} text={payload.detail.text} />}
          <div className={destructive ? "why" : "block why-plain"}>{payload.reason.text}</div>
          <label className="field-label">
            <span className="visually-hidden">Note for the agent</span>
            <textarea className="field" rows={2} placeholder="Add a note for the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {payload.canAllowPermanently && (
            <label className="check">
              <input type="checkbox" checked={always} disabled={confirmTask} onChange={(e) => setAlways(e.target.checked)} />
              <span>{payload.send ? "Always allow this request in this project" : "Always allow in this project"}</span>
            </label>
          )}
          {payload.canDenyForTask && always && (
            <p className="hint">With “Always allow” ticked, denying for the whole task is not offered. Untick it to get that option.</p>
          )}
        </div>
      </div>
      <div className="bottom" ref={barRef}>
        {!ctx.online && <span className="hint">Approvals need a live connection.</span>}
        {error && <span className="err" role="alert">{error}</span>}
        {confirmTask ? (
          <div className="task-deny" role="group" aria-label={denyTaskLabel}>
            <span className="hint">{denyTaskHelp}</span>
            <div className="btns">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirmTask(false)}>Cancel</button>
              <button type="button" className="btn danger" disabled={disabled} onClick={() => decide("deny", true)}>{busy === "deny" ? "Denying…" : "Deny for the task"}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="btns">
              <button type="button" className="btn" disabled={disabled} onClick={() => decide("deny")}>{busy === "deny" ? "Denying…" : "Deny"}</button>
              <button type="button" className="btn pri" disabled={disabled} onClick={() => decide("approve")}>{busy === "approve" ? "Approving…" : "Approve"}</button>
            </div>
            {payload.canDenyForTask && !always && (
              <button type="button" className="task-deny-open" disabled={disabled} onClick={() => setConfirmTask(true)}>{denyTaskLabel}</button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Question({ ctx, payload }: { ctx: Ctx; payload: Payload<"question"> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (answer: string) => {
    if (!answer.trim()) return;
    setBusy(true);
    setError(null);
    const message = await ctx.submit({ kind: "question", text: answer.trim() });
    if (message) {
      setBusy(false);
      setError(message);
    }
  };
  const disabled = !ctx.online || busy;

  return (
    <>
      <div className="body">
        <div className="pad">
          <dl className="kv">
            <dt>Project</dt><dd>{ctx.projectName}</dd>
            <dt>Task</dt><dd>{ctx.task?.title ?? "—"}</dd>
          </dl>
          <Markdown className="question" text={payload.question} />
          {payload.options.length > 0 && (
            <div className="stack">
              {payload.options.map((o) => (
                <button key={o} type="button" className="btn" disabled={disabled} onClick={() => send(o)}><MarkdownInline text={o} /></button>
              ))}
            </div>
          )}
          <label className="field-label">
            <span className="lab">{payload.options.length > 0 ? "Or answer in your own words" : "Your answer"}</span>
            <textarea className="field" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="bottom">
        {!ctx.online && <span className="hint">{OFFLINE_NOTE}</span>}
        {error && <span className="err" role="alert">{error}</span>}
        <button type="button" className="btn pri" disabled={disabled || !text.trim()} onClick={() => send(text)}>{text.trim() ? "Send answer" : payload.options.length > 0 ? "Pick an option or write an answer" : "Write an answer to send"}</button>
      </div>
    </>
  );
}

function Review({ ctx, payload }: { ctx: Ctx; payload: Payload<"review"> }) {
  const [sheet, setSheet] = useState<"none" | "more" | "changes">("none");
  const [discarding, setDiscarding] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const usage = useAppState((s) => s.tasks.find((t) => t.id === ctx.request.taskId)?.usage ?? null);

  const run = async (answer: RequestAnswer, inSheet = false) => {
    setBusy(true);
    setError(null);
    setSheetError(null);
    const message = await ctx.submit(answer);
    if (message) {
      setBusy(false);
      if (inSheet) setSheetError(message);
      else setError(message);
    }
  };
  const doAction = (id: string) => {
    setSheet("none");
    void run({ kind: "review", decision: "action", actionId: id });
  };
  const disabled = !ctx.online || busy;
  const added = payload.files.reduce((n, f) => n + f.added, 0);
  const removed = payload.files.reduce((n, f) => n + f.removed, 0);
  // Opening a PR (which includes the push) is the primary action when offered; Push branch alone is primary otherwise.
  const primary = payload.actions.find((a) => a.id === "github.open_pr") ?? payload.actions[0];
  const others = payload.actions.filter((a) => a !== primary);

  return (
    <>
      <div className="body">
        <div className="pad">
          <Markdown text={payload.summary} />
          {payload.notes.length > 0 && (
            <section className="notes" aria-labelledby="notes-h">
              <h2 id="notes-h" className="lab">During this task</h2>
              <ul>
                {payload.notes.map((n, i) => <li key={i}><MarkdownInline text={n} /></li>)}
              </ul>
            </section>
          )}
          {payload.files.length > 0 && (
            <div className="files" role="list" aria-label="Changed files">
              {payload.files.map((f) =>
                // A summary row such as "11 more files" is not a path; there is nothing to open.
                /^\d+ more files?$/.test(f.path) ? (
                  <div key={f.path} role="listitem" className="total"><span>{f.path}</span><Delta added={f.added} removed={f.removed} /></div>
                ) : (
                  <Link
                    key={f.path}
                    role="listitem"
                    className="file-link"
                    to={`/tasks/${ctx.request.taskId}/diff?path=${encodeURIComponent(f.path)}`}
                    aria-label={`${f.path}, ${f.added} added, ${f.removed} removed. Show changes`}
                  >
                    <span>{f.path}</span><Delta added={f.added} removed={f.removed} />
                  </Link>
                ),
              )}
              {payload.files.length > 1 && (
                <div role="listitem" className="total"><span>Total</span><Delta added={added} removed={removed} /></div>
              )}
            </div>
          )}
          {(payload.branch || usage) && (
            <dl className="kv">
              {payload.branch && <><dt>Branch</dt><dd className="mono">{payload.branch}</dd></>}
              {usage && <UsageRows usage={usage} />}
            </dl>
          )}
        </div>
      </div>
      <div className="bottom">
        {!ctx.online && <span className="hint">Needs a live connection.</span>}
        {error && <span className="err" role="alert">{error}</span>}
        {discarding ? (
          <>
            <span className="hint">Discard this result? This can’t be undone.</span>
            <div className="btns">
              <button type="button" className="btn" onClick={() => setDiscarding(false)}>Keep it</button>
              <button type="button" className="btn danger" disabled={disabled} onClick={() => run({ kind: "review", decision: "discard" })}>Discard</button>
            </div>
          </>
        ) : primary ? (
          // One row: Open PR (else the first action) is the primary one, everything else is behind More.
          <div className="btns">
            <button type="button" className="btn more" aria-haspopup="dialog" onClick={() => setSheet("more")}>More</button>
            <button type="button" className="btn pri" disabled={disabled} onClick={() => doAction(primary.id)}>
              <span className="lbl">{primary.label}<span className="by">{primary.plugin}</span></span>
            </button>
          </div>
        ) : payload.outcome === "failed" && ctx.task ? (
          // A failed run: trying again is what most people want; asking for changes stays under More.
          <div className="btns">
            <button type="button" className="btn more" aria-haspopup="dialog" onClick={() => setSheet("more")}>More</button>
            <RetryButton task={ctx.task} before={async () => { await ctx.submit({ kind: "review", decision: "discard" }); }} />
          </div>
        ) : (
          // Nothing to publish: asking for changes is the stronger choice.
          <div className="btns">
            <button type="button" className="btn" onClick={() => setDiscarding(true)}>Discard</button>
            <button type="button" className="btn pri" onClick={() => setSheet("changes")}>Ask for changes</button>
          </div>
        )}
      </div>
      {sheet === "more" && (
        <Sheet title="More" onClose={() => setSheet("none")}>
          <div className="stack">
            {others.map((a) => (
              <button key={a.id} type="button" className="btn row-btn" disabled={disabled} onClick={() => doAction(a.id)}>
                <span className="lbl">{a.label}<span className="by">{a.plugin}</span></span>
              </button>
            ))}
            <button type="button" className="btn row-btn" onClick={() => setSheet("changes")}>Ask for changes</button>
            <button type="button" className="btn row-btn danger" onClick={() => { setSheet("none"); setDiscarding(true); }}>Discard</button>
            <button type="button" className="btn quiet" onClick={() => setSheet("none")}>Cancel</button>
          </div>
        </Sheet>
      )}
      {sheet === "changes" && (
        <Sheet title="Ask for changes" onClose={() => setSheet("none")}>
          <label className="field-label">
            <span className="lab">What should change?</span>
            <textarea className="field" rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {!ctx.online && <span className="hint">Needs a live connection.</span>}
          {sheetError && <span className="err" role="alert">{sheetError}</span>}
          <div className="btns">
            <button type="button" className="btn" onClick={() => setSheet("none")}>Cancel</button>
            <button type="button" className="btn pri" disabled={disabled || !text.trim()} onClick={() => run({ kind: "review", decision: "changes", text: text.trim() }, true)}>{text.trim() ? "Send to agent" : "Write what to change"}</button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function answeredText(r: Request): string {
  const a = r.answer;
  if (r.state === "cancelled") return "This request was cancelled.";
  if (!a) return "This request was already answered.";
  if (a.kind === "approval") return a.decision === "approve" ? "You approved this." : a.denyForTask ? "You denied this and every later request of this kind in the task." : "You denied this.";
  if (a.kind === "question") return `You answered: “${a.text}”`;
  if (a.decision === "action") return "You acted on this result.";
  if (a.decision === "changes") return `You asked for changes: “${a.text ?? ""}”`;
  return "You discarded this result.";
}

export function RequestScreen() {
  const { id = "" } = useParams();
  const data = useData();
  const navigate = useNavigate();
  const now = useNow();
  const requests = useAppState((s) => s.requests);
  const tasks = useAppState((s) => s.tasks);
  const projects = useAppState((s) => s.projects);
  const connection = useAppState((s) => s.connection);

  const request = useMemo(() => requests.find((r) => r.id === id), [requests, id]);
  const task = tasks.find((t) => t.id === request?.taskId);
  const projectName = projects.find((p) => p.id === request?.projectId)?.name ?? "";

  if (!request) {
    return (
      <>
        <Top back={{ to: "/", label: "Needs you" }} title={connection === "connecting" ? "Loading…" : "Not found"} />
        <div className="body">
          <p className="empty-note">{connection === "connecting" ? "Fetching from your home machine." : "This request is not on this phone. It may have been removed."}</p>
        </div>
      </>
    );
  }

  const p = request.payload;
  const submit = async (answer: RequestAnswer): Promise<string | null> => {
    const res = await data.answerRequest(request.id, answer);
    if (res.ok) {
      const notice =
        answer.kind === "approval" ? (answer.decision === "approve" ? "Approved. The agent carries on." : answer.denyForTask ? "Denied for the rest of this task. The agent was told." : "Denied. The agent was told.")
        : answer.kind === "question" ? "Answer sent."
        : answer.decision === "changes" ? "Sent. The agent is working on it."
        : answer.decision === "discard" ? "Discarded." : "Okay. Working on it.";
      if (answer.kind === "review" && answer.decision === "changes") navigate(`/tasks/${request.taskId}`, { replace: true });
      else navigate("/", { replace: true, state: { notice } });
      return null;
    }
    if (res.error === "request_closed") {
      navigate("/", { replace: true, state: { notice: "That request was already answered, so nothing was sent." } });
      return null;
    }
    return res.error === "offline" ? "Can’t reach your home machine. Nothing was sent." : res.message;
  };
  const ctx: Ctx = { request, task, projectName, submit, online: connection === "online" };

  const waited = formatAge((request.closedAt ?? now) - request.createdAt);
  let title: string;
  let chips: ReactNode;
  if (p.kind === "approval") {
    title = p.title;
    chips = (
      <>
        <Chip tone={p.action.class === "destructive" ? "fail" : "none"}>{p.action.class === "destructive" ? "Destructive" : p.action.class === "write" ? "Write" : "Read"}</Chip>
        {request.state === "open" && <Chip>Waiting {waited}</Chip>}
      </>
    );
  } else if (p.kind === "question") {
    title = "Question";
    chips = request.state === "open" ? <Chip tone="wait">Waiting {waited}</Chip> : null;
  } else {
    title = task?.title ?? "Result";
    const dur = task ? formatAge(task.updatedAt - task.createdAt) : "";
    chips = (
      <>
        <Chip tone={p.outcome === "failed" ? "fail" : "ok"}>{p.outcome === "failed" ? `Failed after ${dur}` : `Done in ${dur}`}</Chip>
        <Chip>{projectName}</Chip>
      </>
    );
  }

  return (
    <>
      <Top back={{ to: "/", label: "Needs you" }} title={title} chips={chips} />
      {request.state !== "open" ? (
        <>
          <div className="body">
            <div className="pad">
              <div className="block"><span className="lab">Closed</span><span>{answeredText(request)}</span></div>
            </div>
          </div>
          <div className="bottom">
            <Link to={`/tasks/${request.taskId}`} className="btn">Open task</Link>
          </div>
        </>
      ) : p.kind === "approval" ? (
        <Approval ctx={ctx} payload={p} />
      ) : p.kind === "question" ? (
        <Question ctx={ctx} payload={p} />
      ) : (
        <Review ctx={ctx} payload={p} />
      )}
    </>
  );
}
