import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { modelLabel, modelProblemOf, useModels } from "../components/models";
import { ModelPicker } from "./ModelPicker";
import { NoProjects } from "../components/NoProjects";
import { Kind, statusTone, statusWord, Top } from "../components/ui";
import { useAppState, useData, type Project } from "../data/api";

const MAX_CHIPS = 3;
const CHIP_LIMIT = 4; // up to this many projects, all of them are chips

/** Projects, most recently used first (newest task), then those never used by name. */
function byRecent(projects: Project[], lastUsed: Map<string, number>): Project[] {
  return [...projects].sort((a, b) => {
    const ta = lastUsed.get(a.id);
    const tb = lastUsed.get(b.id);
    if (ta !== undefined && tb !== undefined && ta !== tb) return tb - ta;
    if (ta !== undefined && tb === undefined) return -1;
    if (ta === undefined && tb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

function ProjectPicker({ projects, selected, onPick, onClose }: {
  projects: Project[];
  selected: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal(); // modal: focus is trapped, Escape closes
    searchRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

  return (
    <dialog ref={ref} className="sheet" aria-labelledby="picker-title" onClose={onClose} onCancel={onClose}>
      <form
        className="sheet-in"
        onSubmit={(e) => {
          e.preventDefault();
          const first = shown[0];
          if (first) onPick(first.id);
        }}
      >
        <div className="sheet-top">
          <h2 className="h" id="picker-title">All projects</h2>
          <button type="button" className="link-btn" onClick={() => ref.current?.close()}>Cancel</button>
        </div>
        <div className="sheet-search">
          <input
            ref={searchRef}
            type="text" enterKeyHint="go"
            className="field"
            placeholder="Search projects"
            aria-label="Search projects"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sheet-list">
          {shown.length === 0 ? (
            <p className="empty-note" role="status">No project matches “{query.trim()}”.</p>
          ) : (
            <ul aria-label="Projects">
              {shown.map((p) => (
                <li key={p.id}>
                  <button type="button" className="pick-row" aria-current={p.id === selected ? "true" : undefined} onClick={() => onPick(p.id)}>
                    <span className="pick-check" aria-hidden="true">{p.id === selected ? "✓" : ""}</span>
                    <span className="pick-name">{p.name}</span>
                    <Kind tone={statusTone(p.status)}>{statusWord(p.status)}</Kind>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </dialog>
  );
}

export function NewTask() {
  const data = useData();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useAppState((s) => s.projects);
  const tasks = useAppState((s) => s.tasks);
  const [chosen, setChosen] = useState<string | null>(params.get("project"));
  const [picking, setPicking] = useState(false);
  const allRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recent = useMemo(() => {
    const lastUsed = new Map<string, number>();
    for (const t of tasks) lastUsed.set(t.projectId, Math.max(lastUsed.get(t.projectId) ?? 0, t.createdAt));
    return byRecent(projects, lastUsed);
  }, [projects, tasks]);
  const lastUsedId = useMemo(() => {
    const used = new Set(tasks.map((t) => t.projectId));
    return recent.find((p) => used.has(p.id))?.id ?? null;
  }, [recent, tasks]);

  const projectId = projects.some((p) => p.id === chosen) ? chosen : lastUsedId ?? (projects.length === 1 ? projects[0]!.id : null);

  // The model is shown where the task is started, and a missing one is said before the task starts, not after it fails.
  const { models, choose } = useModels();
  const [pickingModel, setPickingModel] = useState(false);
  const modelProblem = modelProblemOf(models);
  const model = modelLabel(models);

  const all = recent.length <= CHIP_LIMIT;
  let chips = all ? recent : recent.slice(0, MAX_CHIPS);
  const sel = recent.find((p) => p.id === projectId);
  if (!all && sel && !chips.includes(sel)) chips = [...chips.slice(0, MAX_CHIPS - 1), sel];

  const closePicker = () => {
    setPicking(false);
    requestAnimationFrame(() => allRef.current?.focus());
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await data.createTask(projectId, text.trim());
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    if (res.value.queued || !res.value.taskId) {
      navigate("/", { replace: true, state: { notice: "Saved on this phone. The task starts when your home machine is reachable." } });
    } else {
      navigate(`/tasks/${res.value.taskId}`, { replace: true });
    }
  };

  if (projects.length === 0) {
    return (
      <>
        <Top title="New task" sub="Add a project first" />
        <div className="body"><NoProjects title="No project to run a task in." /></div>
      </>
    );
  }

  return (
    <>
      <Top title="New task" sub="Runs in the project’s own sandbox and branch" />
      <form className="form" onSubmit={start}>
        <div className="body">
          <div className="pad">
            <span className="lab" id="project-label">Project</span>
            <div className="chips" role="radiogroup" aria-labelledby="project-label">
              {chips.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === projectId}
                  className={`chip pick ${p.id === projectId ? "run" : ""}`}
                  onClick={() => setChosen(p.id)}
                >
                  {p.name}
                </button>
              ))}
              {!all && (
                <button ref={allRef} type="button" className="chip pick" aria-haspopup="dialog" onClick={() => setPicking(true)}>
                  All projects ({projects.length})
                </button>
              )}
            </div>
            <label className="field-label">
              <span className="lab">What should it do?</span>
              <textarea
                className="field tall"
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Describe the work in a sentence or two."
              />
            </label>
            {models && (models.current || models.problem) && <div className="model-line">
              <span className="lab">Model</span>
              <button type="button" className="model-pick" aria-haspopup="dialog" disabled={!models || models.available.length === 0} onClick={() => setPickingModel(true)}>
                <span className={model.by ? "" : "none"}>{model.name}</span>
                {model.by && <span className="by">{model.by}</span>}
                <span className="change">Change</span>
              </button>
            </div>}
            <span className="hint">
              Works freely inside the sandbox. Asks before it reads from a new site, sends data anywhere, or publishes your branch.
            </span>
          </div>
        </div>
        <div className="bottom">
          {modelProblem && (
            <div className="model-warn" role="status">
              <span>{modelProblem.replace(/ Choose a model in telepi under Settings → Model,.*$/, "")}</span>
              {models && models.available.length > 0 && <button type="button" className="warn-link" onClick={() => setPickingModel(true)}>Choose a model →</button>}
            </div>
          )}
          {error && <span className="err" role="alert">{error}</span>}
          <button type="submit" className="btn pri" disabled={!projectId || !text.trim() || busy || !!modelProblem}>{busy ? "Starting…" : modelProblem ? "Choose a model to start" : !projectId ? "Choose a project to start" : !text.trim() ? "Describe the task to start" : "Start task"}</button>
        </div>
      </form>
      {pickingModel && models && (
        <ModelPicker
          models={models}
          onChoose={async (m) => {
            const err = await choose(m);
            if (!err) setPickingModel(false);
            return err;
          }}
          onClose={() => setPickingModel(false)}
        />
      )}
      {picking && (
        <ProjectPicker
          projects={recent}
          selected={projectId}
          onPick={(id) => {
            setChosen(id);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </>
  );
}
