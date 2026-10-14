// Durable extensions the owner adds: <data dir>/extensions.json is an array of module specifiers (absolute paths or
// package names). Each module's default export is an Extension, or an array of them. They run in the server's process,
// with the server's rights; they are the owner's own code.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";

const isExtension = (v: unknown): v is Extension => typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string";

/** Loads what extensions.json names. A module that fails is reported by name and skipped; the server still starts. */
export async function loadExtensions(dataDir: string): Promise<Extension[]> {
  const file = path.join(dataDir, "extensions.json");
  let specifiers: unknown;
  try {
    specifiers = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn(`telepi: could not read ${file}; no extensions loaded:`, error instanceof Error ? error.message : error);
    return [];
  }
  if (!Array.isArray(specifiers) || !specifiers.every((s) => typeof s === "string")) {
    console.warn(`telepi: ${file} must be an array of module specifiers; no extensions loaded`);
    return [];
  }
  const loaded: Extension[] = [];
  for (const specifier of specifiers as string[]) {
    try {
      const mod = (await import(path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier)) as { default?: unknown };
      const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
      if (!exported.every(isExtension)) throw new Error("its default export is not a Pi Durable Extension (or an array of them)");
      loaded.push(...exported);
      console.log(`telepi: loaded extension ${exported.map((e) => e.name).join(", ")} from ${specifier}`);
    } catch (error) {
      console.warn(`telepi: extension ${specifier} failed to load and was skipped:`, error instanceof Error ? error.message : error);
    }
  }
  return loaded;
}
