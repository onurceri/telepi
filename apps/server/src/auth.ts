// Device sessions and one-time pairing.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Device } from "@telepi/contract";
import { HttpError } from "./http";
import type { DeviceRecord, State } from "./state";

export const SESSION_COOKIE = "telepi_session";
export const SESSION_MAX_AGE_S = 365 * 24 * 60 * 60;

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOUCH_INTERVAL_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_PER_IP = 5;
/** Behind a local proxy every client shares one IP, so also cap attempts overall. */
const RATE_GLOBAL = 20;

const hash = (s: string) => createHash("sha256").update(s).digest();
const normalizeCode = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

export function publicDevice({ tokenHash: _, ...device }: DeviceRecord): Device {
  return device;
}

export class Auth {
  private code: { hash: Buffer; expiresAt: number } | null = null;
  private attempts = new Map<string, number[]>();
  private globalAttempts: number[] = [];

  constructor(private state: State) {}

  /** Creates a one-time code, replacing any earlier one. Returns it for display. */
  newPairingCode(): string {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    this.code = { hash: hash(raw), expiresAt: Date.now() + CODE_TTL_MS };
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  /** Throws rate_limited after too many attempts. Every call counts as an attempt. */
  checkRate(ip: string): void {
    const now = Date.now();
    const recent = (this.attempts.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    this.globalAttempts = this.globalAttempts.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_PER_IP || this.globalAttempts.length >= RATE_GLOBAL) {
      this.attempts.set(ip, recent);
      throw new HttpError("rate_limited", "Too many pairing attempts. Try again in a minute.");
    }
    recent.push(now);
    this.globalAttempts.push(now);
    this.attempts.set(ip, recent);
    if (this.attempts.size > 1000) for (const [k, v] of this.attempts) if (!v.some((t) => now - t < RATE_WINDOW_MS)) this.attempts.delete(k);
  }

  /** Consumes the code on success. Returns the new device and its raw session token. */
  pair(code: string, deviceName: string): { device: DeviceRecord; token: string } {
    const current = this.code;
    const ok =
      current !== null &&
      Date.now() < current.expiresAt &&
      timingSafeEqual(current.hash, hash(normalizeCode(code)));
    if (!ok) throw new HttpError("bad_pairing_code", "That pairing code is not valid.");
    this.code = null;

    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const device: DeviceRecord = {
      id: this.state.newId("dev"),
      name: deviceName.trim() || "Device",
      createdAt: now,
      lastSeenAt: now,
      tokenHash: hash(token).toString("hex"),
    };
    this.state.devices.set(device.id, device);
    this.state.saveDevices();
    return { device, token };
  }

  /** The device for a raw session token, or null. */
  authenticate(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const wanted = hash(token).toString("hex");
    for (const device of this.state.devices.values()) {
      const a = Buffer.from(device.tokenHash);
      const b = Buffer.from(wanted);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        const now = Date.now();
        if (now - device.lastSeenAt > TOUCH_INTERVAL_MS) {
          const updated = { ...device, lastSeenAt: now };
          this.state.devices.set(device.id, updated);
          this.state.saveDevices();
          return updated;
        }
        return device;
      }
    }
    return null;
  }

  revoke(deviceId: string): boolean {
    if (!this.state.devices.delete(deviceId)) return false;
    this.state.saveDevices();
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.deviceId !== deviceId);
    this.state.saveSubscriptions();
    return true;
  }
}

export function printPairingCode(code: string): void {
  const line = "=".repeat(44);
  console.log(`\n${line}\n  telepi pairing code:  ${code}\n  Valid for 10 minutes, one use.\n${line}\n`);
}
