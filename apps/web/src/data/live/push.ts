// Web push: what the browser supports, and subscribing.
import { PushKeyResponse, PushSubscribeBody, routes } from "@telepi/contract";
import type { PushState, Result } from "../api";
import { HttpError, Unreachable, call } from "./http";

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function currentPushState(): PushState {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // iOS Safari outside the home screen has neither; the fix there is installing the app.
    return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (isIos() && !isStandalone()) return "needs-install";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The service worker is not ready.")), 10_000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  const body = PushSubscribeBody.parse({ subscription: sub.toJSON() });
  await call("POST", routes.pushSubscription, { body });
}

/** Must be called from a user gesture (a tap). */
export async function enablePush(): Promise<Result> {
  const state = currentPushState();
  if (state === "unsupported" || state === "needs-install") {
    return { ok: false, error: state, message: state === "needs-install" ? "Add telepi to the home screen first." : "Push is not supported here." };
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, error: permission, message: "Notifications were not allowed." };
    const { publicKey } = await call("GET", routes.pushKey, { schema: PushKeyResponse });
    const reg = await registration();
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    await sendSubscription(sub);
    return { ok: true, value: undefined };
  } catch (e) {
    if (e instanceof Unreachable) return { ok: false, error: "offline", message: "The home machine cannot be reached." };
    if (e instanceof HttpError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: "internal", message: e instanceof Error ? e.message : "Could not enable push." };
  }
}

/** Subscriptions can rotate; tell the server about the current one when permission is already granted. */
export async function refreshSubscription(): Promise<void> {
  try {
    if (currentPushState() !== "granted") return;
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) await sendSubscription(sub);
  } catch {
    // best effort
  }
}
