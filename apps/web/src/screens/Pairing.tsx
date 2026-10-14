import { useState, type FormEvent } from "react";
import { useData } from "../data/api";

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac/.test(ua)) return "Mac";
  return "My device";
}

const ERRORS: Record<string, string> = {
  bad_pairing_code: "That code is wrong. Check the one the server printed and try again.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  offline: "Can’t reach the server. Check your network and that the server is running.",
};

export function Pairing() {
  const data = useData();
  // `telepi pair` shows a link like https://host/#pair=ABCD-EFGH (and a QR of it): the code arrives filled in.
  const [code, setCode] = useState(() => /^#pair=([A-Za-z0-9-]{4,16})$/.exec(location.hash)?.[1] ?? "");
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await data.pair(code.trim(), name.trim());
    setBusy(false);
    if (!res.ok) setError(ERRORS[res.error] ?? res.message);
  };

  return (
    <form className="screen" onSubmit={submit}>
      <header className="top">
        <h1 className="h">Pair this device</h1>
        <span className="sub">Enter the one-time code from <code>pnpm telepi pair</code> on your computer.</span>
      </header>
      <div className="body">
        <div className="pad">
          <label className="field-label">
            <span className="lab">Pairing code</span>
            <input
              className="field mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              required
              minLength={4}
            />
          </label>
          <label className="field-label">
            <span className="lab">Device name</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </label>
          {error && <div className="why" role="alert">{error}</div>}
          <span className="hint">The code works once. For a new one, run <code>pnpm telepi pair</code> again.</span>
        </div>
      </div>
      <div className="bottom">
        <button type="submit" className="btn pri" disabled={busy || code.trim().length < 4 || !name.trim()}>{busy ? "Pairing…" : code.trim().length < 4 ? "Enter the code to pair" : !name.trim() ? "Name this device to pair" : "Pair"}</button>
      </div>
    </form>
  );
}
