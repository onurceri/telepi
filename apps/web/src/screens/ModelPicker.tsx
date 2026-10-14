import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelRef, ModelsResponse } from "../data/api";
import { formatTokens } from "../lib/usage";

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

/** "$3", "$0.80", "$1.25": whole dollars stay whole. */
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** "$3 / $15 per M" (input / output), "Free", or null when the provider lists no price. */
function formatPrice(m: ModelInfo): string | null {
  if (m.inputCost === null || m.outputCost === null) return null;
  if (m.inputCost === 0 && m.outputCost === 0) return "Free";
  return `${usd(m.inputCost)} / ${usd(m.outputCost)} per M`;
}

type Item =
  | { kind: "default"; key: string }
  | { kind: "group"; key: string; label: string }
  | { kind: "model"; key: string; model: ModelInfo };

const same = (a: ModelRef | null, m: ModelInfo) => a !== null && a.provider === m.provider && a.id === m.id;

/** Rows to show: optional "Use Pi's default", then models under their provider. Every word typed must match name, id or provider. */
function buildItems(models: ModelInfo[], query: string, withDefault: boolean): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items: Item[] = [];
  if (withDefault && words.length === 0) items.push({ kind: "default", key: "default" });
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const hay = `${m.name} ${m.id} ${m.provider} ${providerName(m.provider)}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  for (const [provider, list] of groups) {
    items.push({ kind: "group", key: `g:${provider}`, label: providerName(provider) });
    for (const model of list) items.push({ kind: "model", key: `${provider}/${model.id}`, model });
  }
  return items;
}

/**
 * Full-screen picker for the model new tasks run on. The real list can hold ~300 models, so only the rows in view are rendered.
 * `onChoose` resolves to an error message, or null when it worked (the parent then closes the picker).
 */
export function ModelPicker({ models, onChoose, onClose, note }: {
  models: ModelsResponse;
  /** One line under the title saying why the picker opened, when the person did not open it themselves. */
  note?: string;
  onChoose: (model: ModelRef | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal(); // modal: focus is trapped, Escape closes
    searchRef.current?.focus();
  }, []);

  const items = useMemo(() => buildItems(models.available, query, models.source === "telepi"), [models, query]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (items[i]?.kind === "group" ? 32 : 52),
    overscan: 10,
    getItemKey: (i) => items[i]!.key,
  });

  // A new search starts at the top.
  useEffect(() => {
    scrollEl?.scrollTo(0, 0);
  }, [query, scrollEl]);

  const choose = async (key: string, model: ModelRef | null) => {
    if (pending) return;
    setPending(key);
    setError(null);
    const message = await onChoose(model);
    if (message !== null) {
      setPending(null);
      setError(message);
    }
  };

  const firstModel = items.find((i): i is Extract<Item, { kind: "model" }> => i.kind === "model");

  return (
    <dialog ref={ref} className="sheet" aria-labelledby="model-title" onClose={onClose} onCancel={onClose}>
      <form
        className="sheet-in"
        onSubmit={(e) => {
          e.preventDefault();
          if (firstModel) void choose(firstModel.key, firstModel.model);
        }}
      >
        <div className="sheet-top">
          <h2 className="h" id="model-title">Model</h2>
          <button type="button" className="link-btn" onClick={() => ref.current?.close()}>Cancel</button>
        </div>
        {note && <p className="sheet-note">{note}</p>}
        <div className="sheet-search">
          <input
            ref={searchRef}
            type="text" enterKeyHint="go"
            className="field"
            placeholder="Search models"
            aria-label="Search models"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && <span className="err pick-err" role="alert">{error}</span>}
        </div>
        <div className="sheet-list" ref={setScrollEl}>
          {items.length === 0 ? (
            <p className="empty-note" role="status">No model matches “{query.trim()}”.</p>
          ) : (
            <ul aria-label="Models" className="pick-virtual" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                const item = items[v.index]!;
                const style = { transform: `translateY(${v.start}px)` };
                if (item.kind === "group") {
                  return <li key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={style} role="presentation" className="pick-group">{item.label}</li>;
                }
                const isDefault = item.kind === "default";
                const model = isDefault ? null : item.model;
                const price = model ? formatPrice(model) : null;
                return (
                  <li key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={style}>
                    <button
                      type="button"
                      className="pick-row"
                      disabled={pending !== null}
                      aria-current={model && same(models.current, model) ? "true" : undefined}
                      onClick={() => void choose(item.key, model ? { provider: model.provider, id: model.id } : null)}
                    >
                      <span className="pick-check" aria-hidden="true">{model && same(models.current, model) ? "✓" : ""}</span>
                      <span className="pick-name">{model ? model.name : "Use Pi’s default"}</span>
                      {pending === item.key ? (
                        <span className="pick-meta" role="status">Saving…</span>
                      ) : model ? (
                        <span className="pick-meta">
                          {model.contextWindow !== null && <span>{formatTokens(model.contextWindow)}</span>}
                          {price && <span>{price}</span>}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </form>
    </dialog>
  );
}
