// Web push. Payloads carry no task content. A push failure never breaks the request flow.
import webpush from "web-push";
import { PushPayload, type Request } from "@telepi/contract";
import type { Config } from "./config";
import type { State } from "./state";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class Push {
  readonly publicKey: string;

  constructor(private state: State, config: Config) {
    const stored = state.persist.read("vapid.json") as VapidKeys | undefined;
    const keys = stored?.publicKey && stored.privateKey ? stored : webpush.generateVAPIDKeys();
    if (keys !== stored) state.persist.writeNow("vapid.json", keys);
    this.publicKey = keys.publicKey;
    const subject = config.publicOrigin?.startsWith("https:") ? config.publicOrigin : "mailto:telepi@example.com";
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  }

  /** Fire and forget. */
  notifyOpened(request: Request): void {
    const project = this.state.projects.get(request.projectId);
    const p = request.payload;
    const payload = PushPayload.parse({
      kind: p.kind === "review" && p.outcome === "failed" ? "failed" : p.kind,
      projectName: project?.name ?? request.projectId,
      taskId: request.taskId,
      requestId: request.id,
      url: `/requests/${request.id}`,
      badge: this.state.openRequestCount(),
    });
    const body = JSON.stringify(payload);
    for (const sub of [...this.state.subscriptions]) {
      webpush
        .sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 24 * 60 * 60, urgency: "high" })
        .catch((err: { statusCode?: number; message?: string }) => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            this.state.subscriptions = this.state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
            this.state.saveSubscriptions();
          } else {
            console.warn(`telepi: push failed (${err.statusCode ?? "no status"}): ${err.message ?? err}`);
          }
        });
    }
  }

  subscribe(deviceId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
    this.state.subscriptions.push({ deviceId, endpoint: subscription.endpoint, keys: subscription.keys });
    this.state.saveSubscriptions();
  }

  unsubscribe(deviceId: string, endpoint: string): void {
    this.state.subscriptions = this.state.subscriptions.filter((s) => !(s.deviceId === deviceId && s.endpoint === endpoint));
    this.state.saveSubscriptions();
  }
}
