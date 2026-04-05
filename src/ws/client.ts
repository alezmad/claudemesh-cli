/**
 * BrokerClient — WebSocket client connecting a CLI session to a claudemesh
 * broker. Handles:
 *   - hello handshake + ack
 *   - send / ack / push message flow
 *   - auto-reconnect with exponential backoff (1s, 2s, 4s, ..., max 30s)
 *   - in-memory outbound queue while reconnecting
 *   - push buffer so the MCP check_messages tool can drain inbound history
 *
 * Encryption is deferred to Step 18 (libsodium). Until then, ciphertext
 * is plaintext UTF-8, nonce is a random 24-byte base64 string (for
 * future-compat layout only).
 */

import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import type { JoinedMesh } from "../state/config";
import {
  decryptDirect,
  encryptDirect,
  isDirectTarget,
} from "../crypto/envelope";
import { signHello } from "../crypto/hello-sig";

export type Priority = "now" | "next" | "low";
export type ConnStatus = "connecting" | "open" | "closed" | "reconnecting";

export interface InboundPush {
  messageId: string;
  meshId: string;
  senderPubkey: string;
  priority: Priority;
  nonce: string;
  ciphertext: string;
  createdAt: string;
  receivedAt: string;
  /** Decrypted plaintext (if encryption succeeded). null = broadcast
   *  or channel (no per-recipient crypto yet), or decryption failed. */
  plaintext: string | null;
  /** Hint for UI: "direct" (crypto_box), "channel"/"broadcast"
   *  (plaintext for now). */
  kind: "direct" | "broadcast" | "channel" | "unknown";
}

type PushHandler = (msg: InboundPush) => void;

interface PendingSend {
  id: string;
  targetSpec: string;
  priority: Priority;
  nonce: string;
  ciphertext: string;
  resolve: (v: { ok: boolean; messageId?: string; error?: string }) => void;
}

const MAX_QUEUED = 100;
const HELLO_ACK_TIMEOUT_MS = 5_000;
const BACKOFF_CAPS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export class BrokerClient {
  private ws: WebSocket | null = null;
  private _status: ConnStatus = "closed";
  private pendingSends = new Map<string, PendingSend>();
  private outbound: Array<() => void> = []; // closures that send once ws is open
  private pushHandlers = new Set<PushHandler>();
  private pushBuffer: InboundPush[] = [];
  private closed = false;
  private reconnectAttempt = 0;
  private helloTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private mesh: JoinedMesh,
    private opts: {
      onStatusChange?: (status: ConnStatus) => void;
      debug?: boolean;
    } = {},
  ) {}

  get status(): ConnStatus {
    return this._status;
  }
  get meshId(): string {
    return this.mesh.meshId;
  }
  get meshSlug(): string {
    return this.mesh.slug;
  }
  get pushHistory(): readonly InboundPush[] {
    return this.pushBuffer;
  }

  /** Open WS, send hello, resolve when hello_ack received. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("client is closed");
    this.setStatus("connecting");
    const ws = new WebSocket(this.mesh.brokerUrl);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      const onOpen = async (): Promise<void> => {
        this.debug("ws open → signing + sending hello");
        try {
          const { timestamp, signature } = await signHello(
            this.mesh.meshId,
            this.mesh.memberId,
            this.mesh.pubkey,
            this.mesh.secretKey,
          );
          ws.send(
            JSON.stringify({
              type: "hello",
              meshId: this.mesh.meshId,
              memberId: this.mesh.memberId,
              pubkey: this.mesh.pubkey,
              sessionId: `${process.pid}-${Date.now()}`,
              pid: process.pid,
              cwd: process.cwd(),
              timestamp,
              signature,
            }),
          );
        } catch (e) {
          reject(
            new Error(
              `hello sign failed: ${e instanceof Error ? e.message : e}`,
            ),
          );
          return;
        }
        // Arm the hello_ack timeout.
        this.helloTimer = setTimeout(() => {
          this.debug("hello_ack timeout");
          ws.close();
          reject(new Error("hello_ack timeout"));
        }, HELLO_ACK_TIMEOUT_MS);
      };

      const onMessage = (raw: WebSocket.RawData): void => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "hello_ack") {
          if (this.helloTimer) clearTimeout(this.helloTimer);
          this.helloTimer = null;
          this.setStatus("open");
          this.reconnectAttempt = 0;
          this.flushOutbound();
          resolve();
          return;
        }
        this.handleServerMessage(msg);
      };

      const onClose = (): void => {
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.ws = null;
        if (this._status !== "open" && this._status !== "reconnecting") {
          reject(new Error("ws closed before hello_ack"));
        }
        if (!this.closed) this.scheduleReconnect();
        else this.setStatus("closed");
      };

      const onError = (err: Error): void => {
        this.debug(`ws error: ${err.message}`);
      };

      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    });
  }

  /** Fire-and-wait send: resolves when broker acks. */
  async send(
    targetSpec: string,
    message: string,
    priority: Priority = "next",
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const id = randomId();
    // Direct messages get crypto_box encryption; broadcasts + channels
    // still pass through as base64 plaintext until channel crypto lands.
    let nonce: string;
    let ciphertext: string;
    if (isDirectTarget(targetSpec)) {
      const env = await encryptDirect(
        message,
        targetSpec,
        this.mesh.secretKey,
      );
      nonce = env.nonce;
      ciphertext = env.ciphertext;
    } else {
      nonce = randomNonce();
      ciphertext = Buffer.from(message, "utf-8").toString("base64");
    }

    return new Promise((resolve) => {
      if (this.pendingSends.size >= MAX_QUEUED) {
        resolve({ ok: false, error: "outbound queue full" });
        return;
      }
      this.pendingSends.set(id, {
        id,
        targetSpec,
        priority,
        nonce,
        ciphertext,
        resolve,
      });
      const dispatch = (): void => {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
        this.ws.send(
          JSON.stringify({
            type: "send",
            id,
            targetSpec,
            priority,
            nonce,
            ciphertext,
          }),
        );
      };
      if (this._status === "open") dispatch();
      else {
        // Queue the dispatch closure; flushed on (re)connect.
        if (this.outbound.length >= MAX_QUEUED) {
          this.pendingSends.delete(id);
          resolve({ ok: false, error: "outbound queue full" });
          return;
        }
        this.outbound.push(dispatch);
      }
      // Ack timeout: 10s to hear back.
      setTimeout(() => {
        if (this.pendingSends.has(id)) {
          this.pendingSends.delete(id);
          resolve({ ok: false, error: "ack timeout" });
        }
      }, 10_000);
    });
  }

  /** Subscribe to inbound pushes. Returns an unsubscribe function. */
  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  /** Drain the buffered push history (used by check_messages tool). */
  drainPushBuffer(): InboundPush[] {
    const drained = this.pushBuffer.slice();
    this.pushBuffer.length = 0;
    return drained;
  }

  /** Send a manual status override. Fire-and-forget (no ack). */
  async setStatus(status: "idle" | "working" | "dnd"): Promise<void> {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ type: "set_status", status }));
  }

  close(): void {
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.setStatus("closed");
  }

  // --- Internals ---

  private handleServerMessage(msg: Record<string, unknown>): void {
    if (msg.type === "ack") {
      const pending = this.pendingSends.get(String(msg.id ?? ""));
      if (pending) {
        pending.resolve({
          ok: true,
          messageId: String(msg.messageId ?? ""),
        });
        this.pendingSends.delete(pending.id);
      }
      return;
    }
    if (msg.type === "push") {
      const nonce = String(msg.nonce ?? "");
      const ciphertext = String(msg.ciphertext ?? "");
      const senderPubkey = String(msg.senderPubkey ?? "");
      // Decrypt asynchronously, then enqueue. Ordering within the
      // buffer is preserved by awaiting before push.
      void (async (): Promise<void> => {
        const kind: InboundPush["kind"] = senderPubkey
          ? "direct"
          : "unknown";
        let plaintext: string | null = null;
        if (senderPubkey && nonce && ciphertext) {
          plaintext = await decryptDirect(
            { nonce, ciphertext },
            senderPubkey,
            this.mesh.secretKey,
          );
        }
        // Legacy/broadcast path: no senderPubkey means the message
        // was not crypto_box'd, so base64 UTF-8 unwrap is correct.
        // For direct messages (senderPubkey present) we MUST NOT
        // base64-decode the ciphertext on decrypt failure — that
        // produces garbage binary that surfaces as garbled bytes
        // to Claude. Leave plaintext=null and let consumers emit
        // a clear "failed to decrypt" warning.
        if (plaintext === null && ciphertext && !senderPubkey) {
          try {
            plaintext = Buffer.from(ciphertext, "base64").toString("utf-8");
          } catch {
            plaintext = null;
          }
        }
        const push: InboundPush = {
          messageId: String(msg.messageId ?? ""),
          meshId: String(msg.meshId ?? ""),
          senderPubkey,
          priority: (msg.priority as Priority) ?? "next",
          nonce,
          ciphertext,
          createdAt: String(msg.createdAt ?? ""),
          receivedAt: new Date().toISOString(),
          plaintext,
          kind,
        };
        this.pushBuffer.push(push);
        if (this.pushBuffer.length > 500) this.pushBuffer.shift();
        for (const h of this.pushHandlers) {
          try {
            h(push);
          } catch {
            /* handler errors are not the transport's problem */
          }
        }
      })();
      return;
    }
    if (msg.type === "error") {
      this.debug(`broker error: ${msg.code} ${msg.message}`);
      const id = msg.id ? String(msg.id) : null;
      if (id) {
        const pending = this.pendingSends.get(id);
        if (pending) {
          pending.resolve({
            ok: false,
            error: `${msg.code}: ${msg.message}`,
          });
          this.pendingSends.delete(id);
        }
      }
    }
  }

  private flushOutbound(): void {
    const queued = this.outbound.slice();
    this.outbound.length = 0;
    for (const send of queued) send();
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const delay =
      BACKOFF_CAPS[Math.min(this.reconnectAttempt, BACKOFF_CAPS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.debug(
      `reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.connect().catch((e) => {
        this.debug(`reconnect failed: ${e instanceof Error ? e.message : e}`);
      });
    }, delay);
  }

  private setStatus(s: ConnStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.opts.onStatusChange?.(s);
  }

  private debug(msg: string): void {
    if (this.opts.debug) console.error(`[broker-client] ${msg}`);
  }
}

function randomId(): string {
  return randomBytes(8).toString("hex");
}

function randomNonce(): string {
  // 24-byte nonce layout (compatible with libsodium crypto_secretbox later)
  return randomBytes(24).toString("base64");
}
