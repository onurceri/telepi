import { useCallback, useEffect, useRef, useState } from "react";
import { Dot, Top } from "../components/ui";
import { useAppState, useData, type ModelRef, type ModelsResponse, type PushState } from "../data/api";
import { setTheme, useTheme, type Theme } from "../lib/theme";
import { formatAge, formatClock, useNow } from "../lib/time";
import { ModelPicker, providerName } from "./ModelPicker";

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: "This browser can’t receive notifications.",
  "needs-install": "On iPhone and iPad, add telepi to the home screen first: tap Share, then Add to Home Screen. Open it from there and come back to this page.",
  default: "Get a notification when something needs you. It says what is waiting and where, never what the task is about.",
  granted: "Notifications are on for this device. They say what is waiting and where, never what the task is about.",
  denied: "Notifications are blocked. Allow them for this site in your browser or system settings, then reload.",
};

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const MODEL_SOURCE_TEXT = {
  pi: "Using Pi’s default on your home machine.",
  telepi: "Chosen here. New tasks use it; running tasks keep theirs.",
  env: "Set by the server’s environment.",
} as const;

/** The last list loaded, so the row still shows something when the home machine is out of reach. */
let lastModels: ModelsResponse | null = null;

export function Settings() {
  const data = useData();
  const theme = useTheme();
  const now = useNow();
  const device = useAppState((s) => s.device);
  const connection = useAppState((s) => s.connection);
  const lastSyncedAt = useAppState((s) => s.lastSyncedAt);
  const push = useAppState((s) => s.push);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(lastModels);
  const [modelError, setModelError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const modelRowRef = useRef<HTMLButtonElement>(null);
  const online = connection === "online";

  const loadModels = useCallback(async () => {
    setModelError(null);
    const res = await data.getModels();
    if (res.ok) {
      lastModels = res.value;
      setModels(res.value);
    } else if (res.error !== "offline") {
      setModelError(res.message);
    }
  }, [data]);

  useEffect(() => {
    if (online) void loadModels();
  }, [online, loadModels]);

  const chooseModel = async (model: ModelRef | null): Promise<string | null> => {
    setSwitching(true);
    const res = await data.setModel(model);
    setSwitching(false);
    if (!res.ok) return res.message;
    lastModels = res.value;
    setModels(res.value);
    closePicker();
    return null;
  };

  const closePicker = () => {
    setPicking(false);
    requestAnimationFrame(() => modelRowRef.current?.focus());
  };

  const current = models?.current ? models.available.find((m) => m.provider === models.current!.provider && m.id === models.current!.id) : undefined;
  let modelName: string;
  let modelBy: string | null = null;
  let modelHint: string;
  if (!models) {
    modelName = online && !modelError ? "Loading…" : modelError ? "Couldn’t load models" : "Not loaded";
    modelHint = online ? (modelError ?? "Asking your home machine…") : "Needs a live connection.";
  } else if (models.available.length === 0) {
    modelName = "No model available";
    modelHint = "Log in to a model provider with pi on your home machine: run pi, then /login.";
  } else {
    // current can be missing from the list (the provider was logged out since): still say what it is.
    modelName = switching ? "Switching…" : current?.name ?? models.current?.id ?? "Choose a model";
    modelBy = switching ? null : models.current ? providerName(models.current.provider) : null;
    modelHint = !online ? "Needs a live connection." : models.source ? MODEL_SOURCE_TEXT[models.source] : (models.problem ?? "No default is set. Pick one for new tasks.");
  }
  const canPick = online && models !== null && models.available.length > 0 && !switching;

  const enable = async () => {
    setBusy(true);
    setError(null);
    const res = await data.enablePush();
    setBusy(false);
    if (!res.ok) setError(res.message);
  };

  const word = connection === "online" ? "Connected" : connection === "connecting" ? "Connecting" : connection === "unreachable" ? "Unreachable" : "Not paired";

  return (
    <>
      <Top title="Settings" />
      <div className="body">
        <div className="pad">
          <section className="stack" aria-labelledby="dev-h">
            <h2 className="lab" id="dev-h">This device</h2>
            <dl className="kv wide">
              <dt>Name</dt><dd>{device?.name ?? "—"}</dd>
              <dt>Connection</dt>
              <dd><span className="conn"><Dot tone={connection === "online" ? "ok" : connection === "connecting" ? "run" : "off"} />{word}</span></dd>
              <dt>Last sync</dt>
              <dd>{lastSyncedAt ? `${formatClock(lastSyncedAt)} · ${formatAge(now - lastSyncedAt)} ago` : "Never"}</dd>
            </dl>
          </section>
          <section className="stack" aria-labelledby="model-h">
            <h2 className="lab" id="model-h">Model</h2>
            <button ref={modelRowRef} type="button" className="btn row-btn" aria-haspopup={canPick ? "dialog" : undefined} disabled={!canPick} onClick={() => setPicking(true)}>
              <span className="lbl">{modelName}{modelBy && <span className="by plain">{modelBy}</span>}</span>
            </button>
            <p className="hint" role={switching ? "status" : undefined}>{modelHint}</p>
            {!models && online && modelError && <button type="button" className="link-btn model-retry" onClick={() => void loadModels()}>Try again</button>}
          </section>
          <section className="stack" aria-labelledby="look-h">
            <h2 className="lab" id="look-h">Appearance</h2>
            <div className="seg" role="radiogroup" aria-labelledby="look-h">
              {THEMES.map((t) => (
                <label key={t.value} className="seg-opt">
                  <input type="radio" name="theme" value={t.value} checked={theme === t.value} onChange={() => setTheme(t.value)} />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
            <p className="hint">{theme === "system" ? "Follows this device’s light or dark setting." : `Always ${theme} on this device.`}</p>
          </section>
          <section className="stack" aria-labelledby="push-h">
            <h2 className="lab" id="push-h">Notifications</h2>
            <p className="hint">{PUSH_TEXT[push]}</p>
            {error && <span className="err" role="alert">{error}</span>}
            {(push === "default" || push === "denied") && (
              <button type="button" className="btn pri" onClick={enable} disabled={busy || push === "denied"}>
                {busy ? "Asking…" : "Turn on notifications"}
              </button>
            )}
          </section>
        </div>
      </div>
      {picking && models && <ModelPicker models={models} onChoose={chooseModel} onClose={closePicker} />}
    </>
  );
}
