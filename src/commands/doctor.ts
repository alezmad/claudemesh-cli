/**
 * `claudemesh doctor` — diagnostic checks.
 *
 * Walks through the install + runtime preconditions and prints each
 * as pass/fail with a fix hint on failure. Exit 0 if everything
 * passes, 1 otherwise.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, getConfigPath } from "../state/config";
import { VERSION } from "../version";

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
  fix?: string;
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "Node.js >= 20",
    pass: major >= 20,
    detail: `v${process.versions.node}`,
    fix: "Install Node 20 or newer (https://nodejs.org)",
  };
}

function checkClaudeOnPath(): Check {
  const res =
    platform() === "win32"
      ? spawnSync("where", ["claude"])
      : spawnSync("sh", ["-c", "command -v claude"]);
  const onPath = res.status === 0;
  const location = onPath ? res.stdout.toString().trim().split("\n")[0] : undefined;
  return {
    name: "claude binary on PATH",
    pass: onPath,
    detail: location,
    fix: "Install Claude Code (https://claude.com/claude-code)",
  };
}

function checkMcpRegistered(): Check {
  const claudeConfig = join(homedir(), ".claude.json");
  if (!existsSync(claudeConfig)) {
    return {
      name: "claudemesh MCP registered in ~/.claude.json",
      pass: false,
      fix: "Run `claudemesh install`",
    };
  }
  try {
    const cfg = JSON.parse(readFileSync(claudeConfig, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    const registered = Boolean(cfg.mcpServers?.["claudemesh"]);
    return {
      name: "claudemesh MCP registered in ~/.claude.json",
      pass: registered,
      fix: registered ? undefined : "Run `claudemesh install`",
    };
  } catch (e) {
    return {
      name: "claudemesh MCP registered in ~/.claude.json",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "Check ~/.claude.json for JSON parse errors",
    };
  }
}

function checkHooksRegistered(): Check {
  const settings = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settings)) {
    return {
      name: "Status hooks registered in ~/.claude/settings.json",
      pass: false,
      fix: "Run `claudemesh install` (remove --no-hooks)",
    };
  }
  try {
    const raw = readFileSync(settings, "utf-8");
    const has = raw.includes("claudemesh hook ");
    return {
      name: "Status hooks registered in ~/.claude/settings.json",
      pass: has,
      fix: has ? undefined : "Run `claudemesh install` (remove --no-hooks)",
    };
  } catch (e) {
    return {
      name: "Status hooks registered in ~/.claude/settings.json",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkConfigFile(): Check {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return {
      name: "~/.claudemesh/config.json exists and parses",
      pass: true,
      detail: "not created yet (fine — no meshes joined)",
    };
  }
  try {
    loadConfig();
    const st = statSync(path);
    const mode = (st.mode & 0o777).toString(8);
    const secure = platform() === "win32" || mode === "600";
    return {
      name: "~/.claudemesh/config.json parses + chmod 0600",
      pass: secure,
      detail: platform() === "win32" ? "chmod skipped on Windows" : `0${mode}`,
      fix: secure ? undefined : `chmod 600 ${path}`,
    };
  } catch (e) {
    return {
      name: "~/.claudemesh/config.json exists and parses",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "Inspect or delete ~/.claudemesh/config.json and re-join",
    };
  }
}

function checkKeypairs(): Check {
  try {
    const cfg = loadConfig();
    if (cfg.meshes.length === 0) {
      return {
        name: "Mesh keypairs valid",
        pass: true,
        detail: "no meshes joined",
      };
    }
    for (const m of cfg.meshes) {
      if (m.pubkey.length !== 64 || !/^[0-9a-f]+$/.test(m.pubkey)) {
        return {
          name: "Mesh keypairs valid",
          pass: false,
          detail: `${m.slug}: pubkey malformed`,
          fix: `Leave + re-join the mesh: claudemesh leave ${m.slug}`,
        };
      }
      if (m.secretKey.length !== 128 || !/^[0-9a-f]+$/.test(m.secretKey)) {
        return {
          name: "Mesh keypairs valid",
          pass: false,
          detail: `${m.slug}: secret key malformed`,
          fix: `Leave + re-join the mesh: claudemesh leave ${m.slug}`,
        };
      }
    }
    return {
      name: "Mesh keypairs valid",
      pass: true,
      detail: `${cfg.meshes.length} mesh(es)`,
    };
  } catch (e) {
    return {
      name: "Mesh keypairs valid",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runDoctor(): Promise<void> {
  const useColor =
    !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY;
  const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
  const green = (s: string): string => (useColor ? `\x1b[32m${s}\x1b[39m` : s);
  const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[39m` : s);

  console.log(`claudemesh doctor  (v${VERSION})`);
  console.log("─".repeat(60));

  const checks: Check[] = [
    checkNode(),
    checkClaudeOnPath(),
    checkMcpRegistered(),
    checkHooksRegistered(),
    checkConfigFile(),
    checkKeypairs(),
  ];

  for (const c of checks) {
    const mark = c.pass ? green("✓") : red("✗");
    const detail = c.detail ? dim(` (${c.detail})`) : "";
    console.log(`${mark} ${c.name}${detail}`);
    if (!c.pass && c.fix) {
      console.log(dim(`   → ${c.fix}`));
    }
  }

  const failing = checks.filter((c) => !c.pass);
  console.log("");
  if (failing.length === 0) {
    console.log(green("All checks passed."));
    process.exit(0);
  } else {
    console.log(red(`${failing.length} check(s) failed.`));
    process.exit(1);
  }
}
