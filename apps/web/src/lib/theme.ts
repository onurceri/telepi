// The appearance setting: follow the system, or force light or dark on this device.
import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "telepi.theme";
const SURFACE = { light: "#ffffff", dark: "#0a0a0a" } as const;
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system"; // storage can be blocked; the system setting still works
  }
}

let current: Theme = read();

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  // Keep the browser chrome in step: the two theme-color metas follow the system unless a theme is forced.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const system = meta.media.includes("dark") ? "dark" : "light";
    meta.content = SURFACE[theme === "system" ? system : theme];
  }
}

/** Call once before the first render so the page never flashes the wrong theme. */
export function initTheme(): void {
  apply(current);
}

export function setTheme(theme: Theme): void {
  current = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // not saved; it still applies until the app is closed
  }
  apply(theme);
  for (const listener of listeners) listener();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
