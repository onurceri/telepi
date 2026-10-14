// Which model a task runs on, and the list of models to choose from. All of it is Pi's: its providers, its login
// (auth.json), its model catalogs and its defaults (settings.json). telepi adds one choice of its own on top.
import path from "node:path";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelInfo, ModelRef, ModelsResponse } from "@telepi/contract";
import { FileCredentialStore, FileModelsStore, readPiSettings } from "./pihome";

/** Cap on tokens the model may produce in one request. */
export const MAX_OUTPUT_TOKENS = 4096;

export interface ModelPick {
  model: Model<Api>;
  source: "telepi" | "pi" | "env";
  thinkingLevel: ModelThinkingLevel;
}

/** What is wrong when no model can be picked, said so that the person knows what to do. */
export type ModelProblem = { problem: string };

const capped = <M>(m: M): M => (typeof (m as { maxTokens?: unknown }).maxTokens === "number" ? { ...m, maxTokens: Math.min((m as unknown as { maxTokens: number }).maxTokens, MAX_OUTPUT_TOKENS) } : m);

export class ModelCatalog {
  readonly models: MutableModels;

  /**
   * @param choice telepi's own choice, persisted by the server core.
   * @param envModel TELEPI_MODEL as "provider/modelId", if set.
   */
  constructor(private piDir: string, private choice: () => ModelRef | null, private envModel: string | undefined) {
    this.models = builtinModels({
      credentials: new FileCredentialStore(path.join(piDir, "auth.json")),
      modelsStore: new FileModelsStore(path.join(piDir, "models-store.json")),
    });
    for (const p of this.models.getProviders()) {
      this.models.setProvider({ ...p, getModels: () => p.getModels().map(capped), getAllModels: p.getAllModels && (() => p.getAllModels!().map(capped)) });
    }
  }

  /** Catalogs Pi may have refreshed since, then every model of a provider that has a credential (stored or in the environment). */
  private async available(): Promise<readonly Model<Api>[]> {
    await this.models.refresh({ allowNetwork: false });
    return this.models.getAvailable();
  }

  /** Brings the catalogs of dynamic providers up to date, the way Pi does when it starts. Quiet on failure. */
  refreshInBackground(): void {
    void this.models.refresh().then((r) => {
      for (const [id, error] of r.errors) console.warn(`telepi: could not refresh the ${id} model list:`, error.message);
    }, () => {});
  }

  /** The three places a model can come from, in order, as references. */
  private async candidates(): Promise<{ ref: ModelRef; source: ModelPick["source"] }[]> {
    const found: { ref: ModelRef; source: ModelPick["source"] }[] = [];
    const chosen = this.choice();
    if (chosen) found.push({ ref: chosen, source: "telepi" });
    const slash = this.envModel?.indexOf("/") ?? -1;
    if (this.envModel && slash > 0) found.push({ ref: { provider: this.envModel.slice(0, slash), id: this.envModel.slice(slash + 1) }, source: "env" });
    else if (this.envModel) console.warn(`telepi: TELEPI_MODEL must be "provider/modelId" (for example openrouter/deepseek/deepseek-v4.1-flash); ignoring "${this.envModel}"`);
    const settings = await readPiSettings(this.piDir);
    if (settings.defaultProvider && settings.defaultModel) found.push({ ref: { provider: settings.defaultProvider, id: settings.defaultModel }, source: "pi" });
    return found;
  }

  async response(): Promise<ModelsResponse> {
    const available = await this.available();
    const pick = await this.pick(available);
    return {
      current: "problem" in pick ? null : { provider: pick.model.provider, id: pick.model.id },
      source: "problem" in pick ? null : pick.source,
      available: available.map(infoOf),
      problem: "problem" in pick ? pick.problem : null,
    };
  }

  async pick(available?: readonly Model<Api>[]): Promise<ModelPick | ModelProblem> {
    const usable = available ?? (await this.available());
    if (usable.length === 0) {
      return { problem: "No model is available: this machine is not logged in to any model provider. Run `pi` on the home machine and use /login, then start the task again." };
    }
    const missing: { ref: ModelRef; source: ModelPick["source"] }[] = [];
    for (const { ref, source } of await this.candidates()) {
      const model = usable.find((m) => m.provider === ref.provider && m.id === ref.id);
      if (!model) { missing.push({ ref, source }); continue; }
      const level = (await readPiSettings(this.piDir)).defaultThinkingLevel ?? "off";
      return { model, source, thinkingLevel: clampThinkingLevel(model, level as ModelThinkingLevel) };
    }
    // A model was named somewhere but cannot be used: say which, where it came from, and what to do.
    const first = missing[0];
    if (first) {
      const where = { telepi: "The model chosen in telepi", env: "TELEPI_MODEL", pi: "Pi's default model" }[first.source];
      return { problem: `${where}, ${first.ref.provider}/${first.ref.id}, is not one this machine's login can use (it may have been retired). Choose a model in telepi under Settings → Model, or pick another with \`pi\` and /model.` };
    }
    return { problem: "No model is chosen yet. Choose one in telepi under Settings → Model, or set a default with `pi` and /model." };
  }

  /** True when a model is among those a person may pick now. */
  async isAvailable(ref: ModelRef): Promise<boolean> {
    return (await this.available()).some((m) => m.provider === ref.provider && m.id === ref.id);
  }

  /** The most the model can read at once. Null for a model the catalog does not know. */
  contextWindowOf(ref: ModelRef): number | null {
    return this.models.getModel(ref.provider, ref.id)?.contextWindow ?? null;
  }
}

function infoOf(m: Model<Api>): ModelInfo {
  return { provider: m.provider, id: m.id, name: m.name, contextWindow: m.contextWindow ?? null, inputCost: m.cost?.input ?? null, outputCost: m.cost?.output ?? null };
}
