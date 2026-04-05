/**
 * `claudemesh status` — one-shot health report.
 *
 * Reports CLI version, config path + permissions, each joined mesh
 * with broker reachability (WS handshake probe). Exit 0 if every
 * mesh's broker is reachable, 1 otherwise.
 */

import { statSync, existsSync } from "node:fs";
import WebSocket from "ws";
import { loadConfig, getConfigPath } from "../state/config";
import { VERSION } from "../version";

interface MeshStatus {
  slug: string;
  brokerUrl: string;
  pubkey: string;
  reachable: boolean;
  error?: string;
}

async function probeBroker(url: string, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* noop */ }
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    ws.on("open", () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      resolve({ ok: true });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

export async function runStatus(): Promise<void> {
  const useColor =
    !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY;
  const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
  const green = (s: string): string => (useColor ? `\x1b[32m${s}\x1b[39m` : s);
  const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[39m` : s);

  console.log(`claudemesh status  (v${VERSION})`);
  console.log("─".repeat(60));

  const configPath = getConfigPath();
  let configPerms = "missing";
  if (existsSync(configPath)) {
    const st = statSync(configPath);
    const mode = (st.mode & 0o777).toString(8).padStart(4, "0");
    configPerms = mode === "0600" ? `${mode} ✓` : `${mode} ⚠ (expected 0600)`;
  }
  console.log(`Config:     ${configPath} (${configPerms})`);

  const config = loadConfig();
  if (config.meshes.length === 0) {
    console.log("");
    console.log(dim("No meshes joined. Run `claudemesh join <invite-url>` to get started."));
    process.exit(0);
  }

  console.log("");
  console.log(`Meshes (${config.meshes.length}):`);

  const results: MeshStatus[] = [];
  for (const m of config.meshes) {
    process.stdout.write(`  ${m.slug.padEnd(20)} probing ${m.brokerUrl}… `);
    const probe = await probeBroker(m.brokerUrl);
    results.push({
      slug: m.slug,
      brokerUrl: m.brokerUrl,
      pubkey: m.pubkey,
      reachable: probe.ok,
      error: probe.error,
    });
    if (probe.ok) {
      console.log(green("reachable"));
    } else {
      console.log(red(`unreachable (${probe.error})`));
    }
  }

  console.log("");
  for (const r of results) {
    console.log(dim(`  ${r.slug}: pubkey ${r.pubkey.slice(0, 16)}…`));
  }

  const allOk = results.every((r) => r.reachable);
  console.log("");
  if (allOk) {
    console.log(green("All meshes reachable."));
    process.exit(0);
  } else {
    const broken = results.filter((r) => !r.reachable).length;
    console.log(red(`${broken} of ${results.length} mesh(es) unreachable.`));
    process.exit(1);
  }
}
