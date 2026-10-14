// Sample model list for the model picker: about 25 models across three providers, or ~300 with ?manymodels.
import type { ModelInfo } from "../api";

const m = (provider: string, id: string, name: string, contextWindow: number | null, inputCost: number | null, outputCost: number | null): ModelInfo =>
  ({ provider, id, name, contextWindow, inputCost, outputCost });

export const MOCK_MODELS: ModelInfo[] = [
  m("anthropic", "claude-opus-4-1", "Claude Opus 4.1", 200_000, 15, 75),
  m("anthropic", "claude-opus-4", "Claude Opus 4", 200_000, 15, 75),
  m("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5", 1_000_000, 3, 15),
  m("anthropic", "claude-sonnet-4", "Claude Sonnet 4", 200_000, 3, 15),
  m("anthropic", "claude-3-7-sonnet", "Claude Sonnet 3.7", 200_000, 3, 15),
  m("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 1, 5),
  m("anthropic", "claude-3-5-haiku", "Claude Haiku 3.5", 200_000, 0.8, 4),
  m("openai", "gpt-5", "GPT-5", 400_000, 1.25, 10),
  m("openai", "gpt-5-mini", "GPT-5 mini", 400_000, 0.25, 2),
  m("openai", "gpt-5-nano", "GPT-5 nano", 400_000, 0.05, 0.4),
  m("openai", "gpt-4.1", "GPT-4.1", 1_047_576, 2, 8),
  m("openai", "gpt-4.1-mini", "GPT-4.1 mini", 1_047_576, 0.4, 1.6),
  m("openai", "o3", "o3", 200_000, 2, 8),
  m("openai", "o4-mini", "o4-mini", 200_000, 1.1, 4.4),
  m("openai", "codex-mini-latest", "Codex mini", 200_000, 1.5, 6),
  m("openrouter", "anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5", 1_000_000, 3, 15),
  m("openrouter", "google/gemini-2.5-pro", "Google: Gemini 2.5 Pro", 1_048_576, 1.25, 10),
  m("openrouter", "google/gemini-2.5-flash", "Google: Gemini 2.5 Flash", 1_048_576, 0.3, 2.5),
  m("openrouter", "deepseek/deepseek-chat-v3.1", "DeepSeek: DeepSeek V3.1", 163_840, 0.2, 0.8),
  m("openrouter", "deepseek/deepseek-r1", "DeepSeek: R1", 163_840, 0.4, 2),
  m("openrouter", "qwen/qwen3-coder", "Qwen: Qwen3 Coder 480B", 262_144, 0.22, 0.95),
  m("openrouter", "moonshotai/kimi-k2", "MoonshotAI: Kimi K2", 131_072, 0.14, 2.49),
  m("openrouter", "z-ai/glm-4.5", "Z.AI: GLM 4.5", 131_072, 0.2, 0.2),
  m("openrouter", "meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick", 1_048_576, 0.15, 0.6),
  m("openrouter", "mistralai/codestral-2508", "Mistral: Codestral 2508", 256_000, null, null),
];

/** About 300 models, to check that the picker stays smooth with a long list. */
export function manyModels(): ModelInfo[] {
  const extra: ModelInfo[] = [];
  for (let i = 1; i <= 275; i++) {
    const vendor = ["acme", "nova", "lumen", "orbit", "quill"][i % 5]!;
    extra.push(m("openrouter", `${vendor}/model-${i}`, `${vendor[0]!.toUpperCase()}${vendor.slice(1)}: Model ${i}${i % 7 === 0 ? " (free)" : ""}`, i % 11 === 0 ? null : 8_192 * (1 + (i % 16)), i % 7 === 0 ? 0 : i % 9 === 0 ? null : (i % 13) / 4 + 0.1, i % 7 === 0 ? 0 : i % 9 === 0 ? null : (i % 13) + 1));
  }
  return [...MOCK_MODELS, ...extra];
}
