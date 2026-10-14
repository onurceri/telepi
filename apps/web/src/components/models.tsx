import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useData, type ModelRef, type ModelsResponse, type Task } from "../data/api";
import { ModelPicker, providerName } from "../screens/ModelPicker";

/** The models new tasks can run on, and a way to choose one, for screens other than Settings. */
export function useModels() {
  const data = useData();
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const load = useCallback(async (): Promise<ModelsResponse | null> => {
    const res = await data.getModels();
    if (res.ok) setModels(res.value);
    return res.ok ? res.value : null;
  }, [data]);
  useEffect(() => { void load(); }, [load]);
  const choose = useCallback(async (model: ModelRef | null): Promise<string | null> => {
    const res = await data.setModel(model);
    if (!res.ok) return res.message;
    setModels(res.value);
    return null;
  }, [data]);
  return { models, load, choose };
}

/**
 * Why new tasks cannot run, as the server says it, or null. Null too while the list has not loaded, and for a runtime
 * that has no models to choose from (the fake one), which reports no problem.
 */
export function modelProblemOf(models: ModelsResponse | null): string | null {
  if (!models || models.current) return null;
  return models.problem ?? null;
}

/** The model's display name and provider, as in Settings. */
export function modelLabel(models: ModelsResponse | null): { name: string; by: string | null } {
  if (!models) return { name: "…", by: null };
  if (!models.current) return { name: "None", by: null };
  const m = models.available.find((x) => x.provider === models.current!.provider && x.id === models.current!.id);
  return { name: m?.name ?? models.current.id, by: providerName(models.current.provider) };
}

/**
 * Runs a failed task again as a new task with the same instruction in the same project. When no model can run it,
 * the model picker opens first, so the second attempt does not fail the same way.
 */
export function RetryButton({ task, className = "btn pri", before }: { task: Task; className?: string; before?: () => Promise<void> }) {
  const data = useData();
  const navigate = useNavigate();
  const { load, choose } = useModels();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<ModelsResponse | null>(null);

  const startAgain = async () => {
    setBusy(true);
    setError(null);
    const res = await data.createTask(task.projectId, task.instruction);
    if (!res.ok) { setBusy(false); setError(res.message); return; }
    await before?.();
    if (res.value.queued || !res.value.taskId) navigate("/", { state: { notice: "Saved on this phone. The task starts when your home machine is reachable." } });
    else navigate(`/tasks/${res.value.taskId}`);
  };

  const onClick = async () => {
    setBusy(true);
    const models = await load();
    if (modelProblemOf(models) && models!.available.length > 0) { setBusy(false); setPicking(models); return; }
    await startAgain();
  };

  return (
    <>
      {error && <span className="err" role="alert">{error}</span>}
      <button type="button" className={className} disabled={busy} onClick={() => void onClick()}>{busy ? "Starting…" : "Try again"}</button>
      {picking && (
        <ModelPicker
          models={picking}
          note="The task needs a model it can run on. Choose one, and it starts right away."
          onChoose={async (model) => {
            const err = await choose(model);
            if (err) return err;
            setPicking(null);
            await startAgain();
            return null;
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
