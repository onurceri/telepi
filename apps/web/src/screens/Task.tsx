import { useVirtualizer } from "@tanstack/react-virtual";
import { RetryButton } from "../components/models";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { JumpButton } from "../components/Jump";
import { Chip, Detail, Icon, requestKind, StepIcon, StepLabel, taskTone, Top, UsageRows } from "../components/ui";
import { useAppState, useData, useTaskEvents, type OutboxItem, type Request, type Task, type TaskEvent } from "../data/api";
import { Markdown } from "../lib/markdown";
import { formatAge, useNow } from "../lib/time";

type Item =
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "user"; text: string; queued: boolean }
  | { key: string; kind: "step"; label: string; status: "running" | "ok" | "fail"; detail: string | null }
  | { key: string; kind: "request"; requestId: string }
  | { key: string; kind: "resumed" };

/** Fold the raw event log into display rows. */
function buildTimeline(events: TaskEvent[], queuedIds: ReadonlySet<string>): Item[] {
  const items: Item[] = [];
  const text = new Map<string, number>();
  const steps = new Map<string, number>();
  for (const e of events) {
    switch (e.type) {
      case "agent_text": {
        const at = text.get(e.messageId);
        if (at === undefined) {
          text.set(e.messageId, items.length);
          items.push({ key: `m-${e.messageId}`, kind: "text", text: e.delta });
        } else {
          const prev = items[at] as Extract<Item, { kind: "text" }>;
          items[at] = { ...prev, text: prev.text + e.delta };
        }
        break;
      }
      case "user_message":
        items.push({ key: `u-${e.seq}`, kind: "user", text: e.text, queued: e.clientId !== null && queuedIds.has(e.clientId) });
        break;
      case "step_started":
        steps.set(e.stepId, items.length);
        items.push({ key: `s-${e.stepId}`, kind: "step", label: e.label, status: "running", detail: e.detail });
        break;
      case "step_finished": {
        const at = steps.get(e.stepId);
        if (at !== undefined) {
          const prev = items[at] as Extract<Item, { kind: "step" }>;
          items[at] = { ...prev, status: e.ok ? "ok" : "fail", detail: e.detail ?? prev.detail };
        }
        break;
      }
      case "step_progress": {
        const at = steps.get(e.stepId);
        if (at !== undefined) {
          const prev = items[at] as Extract<Item, { kind: "step" }>;
          items[at] = { ...prev, label: e.label, detail: e.detail };
        }
        break;
      }
      case "request_opened":
        items.push({ key: `r-${e.requestId}`, kind: "request", requestId: e.requestId });
        break;
      case "resumed":
        items.push({ key: `x-${e.seq}`, kind: "resumed" });
        break;
      default:
        break;
    }
  }
  return items;
}

function RequestMarker({ request }: { request: Request | undefined }) {
  if (!request) return <div className="mark-small">A request was opened</div>;
  const k = requestKind(request);
  if (request.state === "open") {
    return (
      <Link to={`/requests/${request.id}`} className="req-marker">
        <span className={`kind k-${k.tone}`}>{k.label} · waiting for you</span>
        <span className="go"><Icon name="go" size={16} /></span>
      </Link>
    );
  }
  return <div className="mark-small">{k.label} {request.state === "answered" ? "answered" : "cancelled"}</div>;
}

/** How a row should move: fresh rows rise in, a step that was seen running lands, the last text may still be streaming. */
interface Motion {
  fresh: boolean;
  landed: boolean;
  streaming: boolean;
}

function Row({ item, requests, motion }: { item: Item; requests: Map<string, Request>; motion: Motion }) {
  const enter = motion.fresh ? "enter" : "";
  switch (item.kind) {
    case "text":
      return <Markdown className={`agent-text ${motion.streaming ? "streaming" : ""} ${enter}`} text={item.text} />;
    case "user":
      return <p className={`user-text ${item.queued ? "queued" : ""} ${enter}`}><span className="lab">{item.queued ? "Queued" : "You"}</span> {item.text}</p>;
    case "step": {
      const state = item.status === "running" ? "now" : item.status === "fail" ? "failed" : "";
      return (
        <div className={`step ${state} ${motion.landed ? "landed" : ""} ${enter}`}>
          {/* Keyed by status so the mark is drawn fresh when the step lands. */}
          <span key={item.status} className={`mk ${item.status === "fail" ? "bad" : ""}`}>
            <StepIcon status={item.status} />
          </span>
          {/* Keyed by the label while it runs, so each phase of a longer step fades in. */}
          <span key={item.status === "running" ? item.label : "done"} className="what"><StepLabel label={item.label} /></span>
          {item.detail && <span className="det"><Detail text={item.detail} /></span>}
        </div>
      );
    }
    case "request":
      return <RequestMarker request={requests.get(item.requestId)} />;
    case "resumed":
      return <div className="mark-small">Resumed after a restart</div>;
  }
}

const PLAIN_LIMIT = 80;
const NEAR_BOTTOM = 48;

/** Rows that arrive this long after the screen opened are new, not part of the history being loaded. */
const SETTLE_MS = 1500;

function Timeline({ items, requests, scrollEl, live }: { items: Item[]; requests: Map<string, Request>; scrollEl: HTMLDivElement | null; live: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const virtual = items.length > PLAIN_LIMIT;

  // Motion is for what changes while you watch: history that was already there stays still.
  const opened = useRef(Date.now());
  const known = useRef(new Set<string>());
  const fresh = useRef(new Set<string>());
  const ran = useRef(new Set<string>());
  const settled = Date.now() - opened.current > SETTLE_MS;
  for (const item of items) {
    if (!known.current.has(item.key)) {
      known.current.add(item.key);
      if (settled) fresh.current.add(item.key);
    }
    // A step seen running, even one already running when the screen opened, lands when it finishes.
    if (item.kind === "step" && item.status === "running") ran.current.add(item.key);
  }
  const lastKey = items[items.length - 1]?.key;
  const motionOf = (item: Item): Motion => ({
    fresh: fresh.current.has(item.key),
    landed: item.kind === "step" && item.status !== "running" && ran.current.has(item.key),
    streaming: live && item.kind === "text" && item.key === lastKey,
  });

  useLayoutEffect(() => {
    if (virtual && listRef.current) setMargin(listRef.current.offsetTop);
  }, [virtual]);

  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => 34,
    overscan: 10,
    scrollMargin: margin,
    getItemKey: (i) => items[i]!.key,
  });

  if (!virtual) {
    return (
      <div className="timeline" ref={listRef}>
        {items.map((item) => <Row key={item.key} item={item} requests={requests} motion={motionOf(item)} />)}
      </div>
    );
  }
  return (
    <div className="timeline" ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((v) => (
        <div
          key={v.key}
          data-index={v.index}
          ref={virtualizer.measureElement}
          style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start - margin}px)` }}
        >
          <Row item={items[v.index]!} requests={requests} motion={motionOf(items[v.index]!)} />
        </div>
      ))}
    </div>
  );
}

function Composer({ task, queued }: { task: Task; queued: OutboxItem[] }) {
  const data = useData();
  const connection = useAppState((s) => s.connection);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const res = await data.sendMessage(task.id, value);
    setBusy(false);
    if (res.ok) setText("");
    else setError(res.message);
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    const res = await data.stopTask(task.id);
    setBusy(false);
    setConfirmStop(false);
    if (!res.ok) setError(res.error === "offline" ? "Stopping needs a live connection." : res.message);
  };

  return (
    <div className="bottom">
      {queued.length > 0 && <span className="hint">{queued.length === 1 ? "1 message" : `${queued.length} messages`} queued on this phone, sends on reconnect.</span>}
      {connection === "unreachable" && queued.length === 0 && <span className="hint">Can’t reach your home machine. Messages queue and send on reconnect.</span>}
      {error && <span className="err" role="alert">{error}</span>}
      {confirmStop ? (
        <div className="btns">
          <button type="button" className="btn" onClick={() => setConfirmStop(false)}>Keep going</button>
          <button type="button" className="btn danger" onClick={stop} disabled={busy}>Stop task</button>
        </div>
      ) : (
        <form className="composer" onSubmit={send}>
          <input
            className="in"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Steer this task…"
            aria-label="Message to the agent"
            enterKeyHint="send"
            autoComplete="off"
          />
          {text.trim() ? (
            <button type="submit" className="send" disabled={busy}>Send</button>
          ) : (
            <button type="button" className="stop" onClick={() => setConfirmStop(true)}>Stop</button>
          )}
        </form>
      )}
    </div>
  );
}

export function TaskScreen() {
  const data = useData();
  const { id = "" } = useParams();
  const now = useNow();
  const tasks = useAppState((s) => s.tasks);
  const projects = useAppState((s) => s.projects);
  const requests = useAppState((s) => s.requests);
  const outbox = useAppState((s) => s.outbox);
  const events = useTaskEvents(id);

  const task = useMemo(() => tasks.find((t) => t.id === id), [tasks, id]);
  const project = projects.find((p) => p.id === task?.projectId);
  const requestMap = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);
  const queued = useMemo(() => outbox.filter((o) => o.taskId === id), [outbox, id]);
  // A queued message may already be in the event list as an optimistic copy; show it once.
  const queuedIds = useMemo(() => new Set(queued.map((o) => o.id)), [queued]);
  const items = useMemo(() => buildTimeline(events, queuedIds), [events, queuedIds]);
  const queuedNotShown = useMemo(() => {
    const shown = new Set(events.flatMap((e) => (e.type === "user_message" && e.clientId ? [e.clientId] : [])));
    return queued.filter((o) => !shown.has(o.id));
  }, [events, queued]);
  const review = useMemo(
    () => requests.filter((r) => r.taskId === id && r.payload.kind === "review").sort((a, b) => b.createdAt - a.createdAt)[0],
    [requests, id],
  );

  // Keep pinned to the bottom, but only when the reader was already there.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    if (scrollEl) pinned.current = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < NEAR_BOTTOM;
  }, [scrollEl]);
  useLayoutEffect(() => {
    if (!scrollEl || !pinned.current) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    const frame = requestAnimationFrame(() => {
      if (pinned.current) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollEl, items, queued.length]);
  useEffect(() => {
    pinned.current = true;
  }, [id]);

  if (!task) {
    return (
      <>
        <Top back={{ to: "/", label: "Needs you" }} title="Task not found" />
        <div className="body"><p className="empty-note">This task is not on this phone. It may still be loading.</p></div>
      </>
    );
  }

  const live = task.state === "running" || task.state === "waiting";
  const age = formatAge((live ? now : task.updatedAt) - task.createdAt);
  // A publish from the review is a step that runs while the task still shows its result.
  const working = !live && items.some((i) => i.kind === "step" && i.status === "running");
  const chip =
    working ? "Publishing"
    : task.state === "running" ? `Running · ${age}`
    : task.state === "waiting" ? `Waiting for you · ${age}`
    : task.state === "done" ? `Done in ${age}`
    : task.state === "failed" ? `Failed after ${age}`
    : `Stopped after ${age}`;

  return (
    <>
      <Top
        back={{ to: project ? `/projects/${project.id}` : "/projects", label: project?.name ?? "Projects" }}
        title={task.title}
        chips={<Chip tone={working ? "run" : taskTone(task.state)}>{chip}</Chip>}
        busy={task.state === "running" || working}
      />
      <div className="body" ref={setScrollEl} onScroll={onScroll}>
        <div className="pad">
          <div className="block">
            <span className="lab">Your instruction</span>
            <span className="pre-wrap">{task.instruction}</span>
          </div>
          <Timeline items={items} requests={requestMap} scrollEl={scrollEl} live={task.state === "running"} />
          {!live && task.usage && (
            <dl className="kv usage"><UsageRows usage={task.usage} /></dl>
          )}
          {queuedNotShown.map((o) => (
            <p key={o.id} className="user-text queued"><span className="lab">Queued</span> {o.text}</p>
          ))}
        </div>
        <JumpButton scrollEl={scrollEl} to="bottom" />
      </div>
      {live ? (
        <Composer task={task} queued={queued} />
      ) : (
        <div className="bottom">
          {task.state === "failed" ? (
            // A failed task can be run again as is; what went wrong stays one tap away.
            <div className="btns">
              {review && <Link to={`/requests/${review.id}`} className="btn">{review.state === "open" ? "What went wrong" : "View review"}</Link>}
              <RetryButton task={task} before={review?.state === "open" ? async () => { await data.answerRequest(review.id, { kind: "review", decision: "discard" }); } : undefined} />
            </div>
          ) : review ? (
            review.state === "open" ? (
              <Link to={`/requests/${review.id}`} className="btn pri">Open review</Link>
            ) : (
              <Link to={`/requests/${review.id}`} className="btn">View review</Link>
            )
          ) : (
            <span className="hint">This task is finished.</span>
          )}
        </div>
      )}
    </>
  );
}
