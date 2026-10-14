import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { JumpButton } from "../components/Jump";
import { Delta, Top } from "../components/ui";
import { useAppState, useData, type TaskDiff } from "../data/api";

type Line =
  | { kind: "hunk"; label: string }
  | { kind: "add" | "del" | "ctx"; text: string }
  | { kind: "note"; text: string };

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function hunkLabel(raw: string): string {
  const m = HUNK.exec(raw);
  if (!m) return raw;
  const start = Number(m[1]);
  const len = m[2] === undefined ? 1 : Number(m[2]);
  const range = len === 0 ? `Before line ${start + 1}` : len === 1 ? `Line ${start}` : `Lines ${start}–${start + len - 1}`;
  return m[3] ? `${range} · ${m[3]}` : range;
}

function parsePatch(patch: string): { lines: Line[]; added: number; removed: number; width: number } {
  const raw = patch.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  let added = 0;
  let removed = 0;
  let width = 0;
  const lines = raw.map((l): Line => {
    let line: Line;
    if (l.startsWith("@@")) line = { kind: "hunk", label: hunkLabel(l) };
    else if (l.startsWith("+")) (added++, (line = { kind: "add", text: l.slice(1) }));
    else if (l.startsWith("-")) (removed++, (line = { kind: "del", text: l.slice(1) }));
    else if (l.startsWith("\\")) line = { kind: "note", text: l.slice(1).trim() };
    else line = { kind: "ctx", text: l.startsWith(" ") ? l.slice(1) : l };
    if (line.kind !== "hunk") width = Math.max(width, line.text.length);
    return line;
  });
  return { lines, added, removed, width };
}

const GUTTER: Record<string, string> = { add: "+", del: "−", ctx: " ", note: " " };

function DiffLine({ line }: { line: Line }) {
  if (line.kind === "hunk") {
    return <div className="dl hunk"><span>{line.label}</span></div>;
  }
  return (
    <div className={`dl ${line.kind}`}>
      <span className="dg" aria-hidden="true">{GUTTER[line.kind]}</span>
      <span className="dc">{line.text === "" ? " " : line.text}</span>
    </div>
  );
}

const ROW_HEIGHT = 20;
const PLAIN_LIMIT = 300;

function Patch({ lines, width, scrollEl }: { lines: Line[]; width: number; scrollEl: HTMLDivElement | null }) {
  const codeRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const virtual = lines.length > PLAIN_LIMIT;

  useLayoutEffect(() => {
    if (!virtual || !codeRef.current || !scrollEl) return;
    setMargin(codeRef.current.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop);
  }, [virtual, scrollEl, lines]);

  const virtualizer = useVirtualizer({
    count: virtual ? lines.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
    scrollMargin: margin,
  });

  // Lines never wrap, so the block is as wide as its longest line and scrolls sideways as one.
  const inner = { minWidth: `max(100%, calc(${width}ch + 40px))` };
  return (
    <div className="code" ref={codeRef} tabIndex={0} role="region" aria-label="Changed lines">
      {virtual ? (
        <div className="code-in" style={{ ...inner, height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => (
            <div key={v.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${v.start - margin}px)` }}>
              <DiffLine line={lines[v.index]!} />
            </div>
          ))}
        </div>
      ) : (
        <div className="code-in" style={inner}>
          {lines.map((l, i) => <DiffLine key={i} line={l} />)}
        </div>
      )}
    </div>
  );
}

type Load =
  | { status: "loading" }
  | { status: "ready"; diff: TaskDiff; full: boolean }
  | { status: "error"; error: string; message: string };

export function DiffScreen() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const data = useData();
  const online = useAppState((s) => s.connection === "online");
  const requests = useAppState((s) => s.requests);

  const review = useMemo(() => {
    const mine = requests.filter((r) => r.taskId === id && r.payload.kind === "review").sort((a, b) => b.createdAt - a.createdAt);
    return mine[0];
  }, [requests, id]);
  const reviewFile = review && review.payload.kind === "review" ? review.payload.files.find((f) => f.path === path) : undefined;
  const back = review ? { to: `/requests/${review.id}`, label: "Result" } : { to: `/tasks/${id}`, label: "Task" };

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busyFull, setBusyFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const token = useRef(0);

  const fetchDiff = useCallback(
    async (full: boolean) => {
      const mine = ++token.current;
      const res = await data.getDiff(id, path, full ? { full: true } : undefined);
      if (mine !== token.current) return null;
      return res;
    },
    [data, id, path],
  );

  useEffect(() => {
    setFullError(null);
    if (!online) {
      // Keep what is already on screen; only a screen with nothing to show reports the problem.
      setLoad((prev) => (prev.status === "ready" ? prev : { status: "error", error: "offline", message: "Diffs need a live connection." }));
      return;
    }
    setLoad({ status: "loading" });
    void fetchDiff(false).then((res) => {
      if (!res) return;
      setLoad(res.ok ? { status: "ready", diff: res.value, full: false } : { status: "error", error: res.error, message: res.message });
    });
    return () => void token.current++;
  }, [online, attempt, fetchDiff]);

  const showRest = async () => {
    setBusyFull(true);
    setFullError(null);
    const res = await fetchDiff(true);
    setBusyFull(false);
    if (!res) return;
    if (res.ok) setLoad({ status: "ready", diff: res.value, full: true });
    else setFullError(res.error === "offline" ? "Diffs need a live connection." : res.message);
  };

  const ready = load.status === "ready" ? load : null;
  const parsed = useMemo(() => (ready ? parsePatch(ready.diff.patch) : null), [ready]);
  const counts = reviewFile ?? (parsed && !ready?.diff.truncated ? { added: parsed.added, removed: parsed.removed } : null);

  return (
    <>
      <Top
        back={back}
        title={<span className="diff-path mono">{path.split("/").flatMap((seg, i, a) => (i < a.length - 1 ? [seg, "/", <wbr key={i} />] : [seg]))}</span>}
        sub={counts ? <Delta added={counts.added} removed={counts.removed} /> : undefined}
      />
      <div className="body" ref={setScrollEl}>
        {load.status === "loading" && <p className="empty-note" role="status">Loading the diff…</p>}

        {load.status === "error" && (
          <div className="empty" role="alert">
            {load.error === "not_found" ? (
              <>
                <b>This file is not in the task’s changes.</b>
                <span>It may have been renamed or removed since the result was written.</span>
              </>
            ) : load.error === "offline" ? (
              <>
                <b>Diffs need a live connection</b>
                <span>They are fetched when you open them and never stored on this phone.</span>
                <button type="button" className="btn" onClick={() => (data.retryNow(), setAttempt((a) => a + 1))}>Retry</button>
              </>
            ) : (
              <>
                <b>Couldn’t load the diff</b>
                <span>{load.message}</span>
                <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>Retry</button>
              </>
            )}
          </div>
        )}

        {ready && ready.diff.binary && (
          <p className="empty-note">This is a binary file. There is no text diff to show.</p>
        )}
        {ready && !ready.diff.binary && parsed && parsed.lines.length === 0 && (
          <p className="empty-note">No line changes to show for this file.</p>
        )}
        {ready && !ready.diff.binary && parsed && parsed.lines.length > 0 && (
          <Patch lines={parsed.lines} width={parsed.width} scrollEl={scrollEl} />
        )}

        {ready && ready.diff.truncated && (
          <div className="pad">
            {ready.full ? (
              <p className="hint" role="status">This file is too large to show in full. These are its first {parsed?.lines.length.toLocaleString("en")} lines.</p>
            ) : (
              <>
                <p className="hint">Showing the first {parsed?.lines.length.toLocaleString("en")} lines.</p>
                <button type="button" className="btn" disabled={busyFull || !online} onClick={() => void showRest()}>
                  {busyFull ? "Loading…" : "Show the rest"}
                </button>
              </>
            )}
            {fullError && <span className="err" role="alert">{fullError}</span>}
          </div>
        )}
        {ready && !ready.diff.truncated && !ready.diff.binary && parsed && parsed.lines.length > 0 && (
          <p className="hint pad-x"><Link to={back.to} className="link-btn">Back to {back.label.toLowerCase()}</Link></p>
        )}
        <JumpButton scrollEl={scrollEl} to="top" />
      </div>
    </>
  );
}
