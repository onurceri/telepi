import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Dot, Kind, requestKind, Section, Top } from "../components/ui";
import { useAppState, useData, type Request } from "../data/api";
import { NoProjects } from "../components/NoProjects";
import { plainText } from "../lib/markdown";
import { formatAge, formatClock, useNow } from "../lib/time";

function requestRow(r: Request, taskTitle: string): { title: string; context: string } {
  const p = r.payload;
  if (p.kind === "approval") return { title: p.title, context: taskTitle };
  if (p.kind === "question") return { title: plainText(p.question), context: taskTitle };
  const n = p.files.length;
  return {
    title: taskTitle,
    context: p.outcome === "done" ? `Done · ${n} ${n === 1 ? "file" : "files"} changed` : plainText(p.summary),
  };
}

export function NeedsYou() {
  const data = useData();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const now = useNow();

  const connection = useAppState((s) => s.connection);
  const lastSyncedAt = useAppState((s) => s.lastSyncedAt);
  const projects = useAppState((s) => s.projects);
  const tasks = useAppState((s) => s.tasks);
  const requests = useAppState((s) => s.requests);
  const outbox = useAppState((s) => s.outbox);
  const rejected = useAppState((s) => s.rejected);

  const open = useMemo(() => requests.filter((r) => r.state === "open").sort((a, b) => a.createdAt - b.createdAt), [requests]);
  const running = useMemo(() => tasks.filter((t) => t.state === "running").sort((a, b) => a.createdAt - b.createdAt), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const unreachable = connection === "unreachable";
  const projectCount = new Set(open.map((r) => r.projectId)).size;
  const sub =
    open.length === 0
      ? rejected.length > 0
        ? `${rejected.length} not sent`
        : "Nothing is waiting on you"
      :`${open.length} waiting across ${projectCount} ${projectCount === 1 ? "project" : "projects"}`;
  const connWord = connection === "online" ? "home" : connection;

  return (
    <>
      <Top
        title="Needs you"
        sub={unreachable ? (lastSyncedAt ? `Last synced ${formatClock(lastSyncedAt)}` : "Never synced") : sub}
        right={
          <span className="top-right">
            <span className="conn" role="status">
              <Dot tone={connection === "online" ? "ok" : connection === "connecting" ? "run" : "off"} />
              {connWord}
            </span>
          </span>
        }
      />
      <div className="body">
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" className="link-btn" onClick={() => navigate(".", { replace: true, state: null })}>Dismiss</button>
          </div>
        )}
        {unreachable && (
          <div className="banner" role="alert">
            <b>Can’t reach your home machine</b>
            <span>
              {lastSyncedAt ? `Showing what was true at ${formatClock(lastSyncedAt)}.` : "Nothing has been synced yet."} Retrying.
            </span>
            <button type="button" className="banner-btn" onClick={() => data.retryNow()}>Retry now</button>
          </div>
        )}
        {connection === "connecting" && open.length === 0 && running.length === 0 && (
          <p className="empty-note">Connecting to your home machine…</p>
        )}

        {rejected.length > 0 && (
          <>
            <Section>Not sent</Section>
            {rejected.map(({ item, message, rejectedAt }) => {
              const what =
                item.kind === "task"
                  ? `New task in ${projectName.get(item.projectId) ?? item.projectId}`
                  : `Message to ${taskById.get(item.taskId ?? "")?.title ?? "a task"}`;
              return (
                <div key={item.id} className="row rejected">
                  <Kind tone="fail" where={formatAge(now - rejectedAt)}>Refused</Kind>
                  <span className="ttl">{what}</span>
                  <p className="rej-text pre-wrap">{item.text}</p>
                  <p className="rej-why">{message}</p>
                  <button type="button" className="rej-dismiss" onClick={() => data.dismissRejected(item.id)}>Dismiss</button>
                </div>
              );
            })}
          </>
        )}

        {open.map((r) => {
          const k = requestKind(r);
          const task = taskById.get(r.taskId);
          const { title, context } = requestRow(r, task?.title ?? "");
          const approvalOffline = unreachable && r.payload.kind === "approval";
          return (
            <Link key={r.id} to={`/requests/${r.id}`} className={`row ${unreachable && !approvalOffline ? "dim" : ""}`} data-new={Date.now() - r.createdAt < 8000 || undefined}>
              <Kind tone={k.tone} where={projectName.get(r.projectId)}>{k.label}</Kind>
              <span className="ttl">{title}</span>
              <span className="meta">
                <span>{approvalOffline ? "Opens when you’re connected" : context}</span>
                <span>{formatAge(now - r.createdAt)}</span>
              </span>
            </Link>
          );
        })}

        {open.length === 0 && rejected.length === 0 && connection !== "connecting" && projects.length === 0 && tasks.length === 0 && <NoProjects title="Nothing here yet." />}
        {open.length === 0 && rejected.length === 0 && connection !== "connecting" && !(projects.length === 0 && tasks.length === 0) && (
          <div className="empty">
            <b>Nothing is waiting on you.</b>
            <span>The agent will ask here when it needs an approval, an answer or a review.</span>
            <Link to="/new" className="btn">Start a task</Link>
          </div>
        )}

        {running.length > 0 && (
          <>
            <Section>Running</Section>
            {running.map((t) => (
              <Link key={t.id} to={`/tasks/${t.id}`} className="row">
                <Kind tone="run" where={formatAge(now - t.createdAt)}>{projectName.get(t.projectId) ?? t.projectId}</Kind>
                <span className="meta">
                  <span>{t.title}{t.currentStep ? ` · ${t.currentStep}` : ""}</span>
                </span>
              </Link>
            ))}
          </>
        )}

        {outbox.length > 0 && (
          <>
            <Section>Queued on this phone</Section>
            {outbox.map((o) => (
              <div key={o.id} className="row">
                <Kind tone="run" where={projectName.get(o.projectId) ?? o.projectId}>{o.kind === "task" ? "New task" : "Message"}</Kind>
                <span className="meta">
                  <span>“{o.text}” · {unreachable ? "sends on reconnect" : "sending"}</span>
                </span>
              </div>
            ))}
          </>
        )}

        {unreachable && (
          <p className="hint pad-x">Messages and new tasks queue. Approvals never queue: a late “yes” could land on work that has moved on.</p>
        )}
      </div>
    </>
  );
}
