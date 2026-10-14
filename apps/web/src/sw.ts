// Service worker: precache the build, open offline, show push notifications, route notification taps.
/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, getCacheKeyForURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { PushPayload } from "@telepi/contract";

declare const self: ServiceWorkerGlobalScope;

clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Every navigation gets the app shell, so the app opens offline. /api is never cached or answered from here.
// (In dev the shell is not precached; the route is skipped then.)
if (getCacheKeyForURL("/index.html") ?? getCacheKeyForURL("index.html")) {
  registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }));
}

// The page asks a waiting worker to take over (virtual:pwa-register's updateSW).
self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

const TITLES: Record<PushPayload["kind"], string> = {
  approval: "Approval waiting",
  question: "Question from the agent",
  review: "Task finished",
  failed: "Task failed",
};

type BadgeNavigator = WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

async function showPush(event: PushEvent): Promise<void> {
  let payload: PushPayload | null = null;
  try {
    const parsed = PushPayload.safeParse(event.data?.json());
    if (parsed.success) payload = parsed.data;
  } catch {
    // not JSON
  }
  // A push must always show something, or the browser may drop the subscription.
  if (!payload) {
    await self.registration.showNotification("telepi", { body: "Something is waiting.", data: { url: "/" } });
    return;
  }
  const nav = self.navigator as BadgeNavigator;
  const badge = payload.badge > 0 ? nav.setAppBadge?.(payload.badge) : nav.clearAppBadge?.();
  await Promise.all([
    self.registration.showNotification(TITLES[payload.kind], {
      body: payload.projectName,
      tag: payload.requestId ?? payload.taskId,
      icon: "/icon-192.png",
      data: { url: payload.url },
    }),
    badge?.catch(() => {}),
  ]);
}

self.addEventListener("push", (event) => event.waitUntil(showPush(event)));

async function openFromNotification(url: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const target = windows.find((w) => w.focused) ?? windows.find((w) => w.visibilityState === "visible") ?? windows[0];
  if (target) {
    await target.focus();
    target.postMessage({ type: "telepi:navigate", url });
    return;
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: unknown } | null)?.url;
  event.waitUntil(openFromNotification(typeof url === "string" ? url : "/"));
});
