import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Kind, Section, statusTone, statusWord, taskTone, Top } from "../components/ui";
import { useAppState, type Project } from "../data/api";
import { NoProjects } from "../components/NoProjects";
import { formatAge, useNow } from "../lib/time";


export function ProjectsScreen() {
  const projects = useAppState((s) => s.projects);
  const tasks = useAppState((s) => s.tasks);
  const requests = useAppState((s) => s.requests);

  return (
    <>
      <Top title="Projects" sub={`${projects.length} ${projects.length === 1 ? "project" : "projects"}`} />
      <div className="body">
        {projects.length === 0 && <NoProjects />}
        {projects.map((p) => {
          const mine = tasks.filter((t) => t.projectId === p.id);
          const active = mine.filter((t) => t.state === "running" || t.state === "waiting").length;
          const open = requests.filter((r) => r.projectId === p.id && r.state === "open").length;
          return (
            <Link key={p.id} to={`/projects/${p.id}`} className="row">
              <Kind tone={statusTone(p.status)}>{statusWord(p.status)}</Kind>
              <span className="ttl">{p.name}</span>
              <span className="meta">
                <span>{mine.length} {mine.length === 1 ? "task" : "tasks"}{active ? ` · ${active} active` : ""}{open ? ` · ${open} waiting on you` : ""}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function ProjectScreen() {
  const { id = "" } = useParams();
  const now = useNow();
  const projects = useAppState((s) => s.projects);
  const tasks = useAppState((s) => s.tasks);
  const project = projects.find((p) => p.id === id);

  const [active, past] = useMemo(() => {
    const mine = tasks.filter((t) => t.projectId === id);
    const isActive = (t: (typeof mine)[number]) => t.state === "running" || t.state === "waiting";
    return [
      mine.filter(isActive).sort((a, b) => b.updatedAt - a.updatedAt),
      mine.filter((t) => !isActive(t)).sort((a, b) => b.updatedAt - a.updatedAt),
    ];
  }, [tasks, id]);

  if (!project) {
    return (
      <>
        <Top back={{ to: "/projects", label: "Projects" }} title="Project not found" />
        <div className="body"><p className="empty-note">This project is not on this phone.</p></div>
      </>
    );
  }

  const taskRow = (t: (typeof tasks)[number]) => (
    <Link key={t.id} to={`/tasks/${t.id}`} className="row">
      <Kind tone={taskTone(t.state)}>{t.state}</Kind>
      <span className="ttl">{t.title}</span>
      <span className="meta">
        <span>{t.currentStep ?? (t.state === "waiting" ? "Waiting for you" : "")}</span>
        <span>{formatAge(now - t.updatedAt)} ago</span>
      </span>
    </Link>
  );

  return (
    <>
      <Top
        back={{ to: "/projects", label: "Projects" }}
        title={project.name}
        sub={statusWord(project.status)}
        right={<Link to={`/new?project=${project.id}`} className="link-btn">New task</Link>}
      />
      <div className="body">
        <Section>Active</Section>
        {active.length === 0 ? <p className="hint pad-x">Nothing running.</p> : active.map(taskRow)}
        <Section>Past</Section>
        {past.length === 0 ? <p className="hint pad-x">No finished tasks yet.</p> : past.map(taskRow)}
        <Section>Allowed in this project</Section>
        {project.allowedActions.length === 0 ? (
          <p className="hint pad-x">Nothing is allowed permanently yet. The agent asks the first time it needs something new.</p>
        ) : (
          <ul className="allowed">
            {project.allowedActions.map((a) => <li key={a}>{a}</li>)}
          </ul>
        )}
      </div>
    </>
  );
}
