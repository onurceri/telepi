// The page side of the service worker: registration, updates, notification-click navigation, app badge.
import { registerSW } from "virtual:pwa-register";
import type { Store } from "./store";

/** An update found this soon after opening is applied at once: nothing has been typed yet. */
const QUIET_MS = 4000;

export interface PageBridge {
  /** Switch to the waiting version. Reloads the page. */
  applyUpdate(): void;
  /** The app cannot talk to the server as it is: look for a newer version now and take it without asking. */
  requireUpdate(): void;
}

export function installPageBridge(store: Store): PageBridge {
  const openedAt = Date.now();
  let update: ((reload?: boolean) => Promise<void>) | null = null;
  let registration: ServiceWorkerRegistration | undefined;
  let required = false;
  const apply = () => void update?.(true);

  if ("serviceWorker" in navigator) {
    try {
      // A new version does not take over under the user's hands, where it could lose a half-typed answer: it is
      // applied silently right after opening, and offered with a notice once the app is in use.
      update = registerSW({
        immediate: true,
        onNeedRefresh() {
          if (required || Date.now() - openedAt < QUIET_MS) apply();
          else store.set({ updateReady: true });
        },
        onRegisteredSW(_url, r) {
          registration = r;
          // An installed app can stay open for days; look for a new version whenever it comes back to the front.
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") void r?.update().catch(() => {});
          });
        },
      });
    } catch (e) {
      console.error("service worker registration failed", e);
    }
    navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "telepi:navigate" && typeof data.url === "string") {
        window.dispatchEvent(new CustomEvent("telepi:navigate", { detail: { url: data.url } }));
      }
    });
  }

  let cleared = false;
  store.subscribe(() => {
    const s = store.get();
    if (s.connection !== "online") return; // cached counts may be stale
    const open = s.requests.filter((r) => r.state === "open").length;
    if (open > 0) {
      cleared = false;
    } else if (!cleared) {
      cleared = true;
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      void nav.clearAppBadge?.().catch(() => {});
    }
  });

  return {
    applyUpdate: apply,
    requireUpdate() {
      if (required) return;
      required = true;
      if (store.get().updateReady) apply();
      else void registration?.update().catch(() => {});
    },
  };
}
