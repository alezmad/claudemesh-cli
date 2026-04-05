/**
 * `claudemesh hook <status>` — Claude Code hook handler.
 *
 * Registered as a Stop + UserPromptSubmit hook by `claudemesh install`.
 * On each turn boundary, Claude Code invokes:
 *
 *   Stop              → `claudemesh hook idle`
 *   UserPromptSubmit  → `claudemesh hook working`
 *
 * We read the Claude Code hook JSON payload from stdin (contains cwd +
 * session_id), then POST `/hook/set-status` to EVERY joined mesh's
 * broker with {cwd, pid, status, session_id}. Each broker looks up
 * its local presence row by (pid, cwd) and updates status.
 *
 * Fire-and-forget, silent. Hooks must NEVER block Claude Code or
 * surface errors to the user. Debug logging available via
 * CLAUDEMESH_HOOK_DEBUG=1.
 *
 * Why send to every broker? A user joined to multiple meshes has
 * one presence row per mesh, each on its own broker. A turn boundary
 * updates the status on every broker where this session is active.
 * Brokers that don't have a matching presence just queue the signal
 * in pending_status (harmless, TTL-swept).
 */

import { loadConfig } from "../state/config";

const DEBUG = process.env.CLAUDEMESH_HOOK_DEBUG === "1";

function debug(msg: string): void {
  if (DEBUG) console.error(`[claudemesh-hook] ${msg}`);
}

/** WS URL → HTTP URL (same host, swap scheme). */
function wsToHttp(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const httpScheme = u.protocol === "wss:" ? "https:" : "http:";
    return `${httpScheme}//${u.host}`;
  } catch {
    return wsUrl;
  }
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Uint8Array[] = [];
  const reader = process.stdin;
  try {
    for await (const chunk of reader) {
      chunks.push(chunk as Uint8Array);
      if (chunks.reduce((n, c) => n + c.length, 0) > 256 * 1024) break;
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function postHook(
  brokerWsUrl: string,
  body: Record<string, unknown>,
): Promise<void> {
  const base = wsToHttp(brokerWsUrl);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1000);
    await fetch(`${base}/hook/set-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(t));
  } catch (e) {
    debug(`post failed ${base}: ${e instanceof Error ? e.message : e}`);
  }
}

export async function runHook(args: string[]): Promise<void> {
  const status = args[0];
  if (!status || !["idle", "working", "dnd"].includes(status)) {
    // Silent no-op — we never want a hook to surface an error.
    process.exit(0);
  }

  // Read Claude Code's stdin payload for cwd + session_id.
  const stdinTimeout = new Promise<Record<string, unknown>>((r) =>
    setTimeout(() => r({}), 500),
  );
  const payload = await Promise.race([readStdinJson(), stdinTimeout]);
  const cwd =
    (typeof payload.cwd === "string" && payload.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const sessionId =
    (typeof payload.session_id === "string" && payload.session_id) || "";

  // Fan out to EVERY joined mesh's broker in parallel.
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    debug(`config load failed: ${e instanceof Error ? e.message : e}`);
    process.exit(0);
  }
  if (config.meshes.length === 0) {
    debug("no joined meshes, nothing to do");
    process.exit(0);
  }

  const body = { cwd, pid: process.ppid, status, session_id: sessionId };
  debug(
    `status=${status} cwd=${cwd} meshes=${config.meshes.length} session=${sessionId.slice(0, 8)}`,
  );

  // Dedupe by brokerUrl — if multiple meshes share a broker, one POST
  // covers them (broker resolves presence by cwd+pid regardless).
  const brokerUrls = [...new Set(config.meshes.map((m) => m.brokerUrl))];
  await Promise.all(brokerUrls.map((url) => postHook(url, body)));
  process.exit(0);
}
