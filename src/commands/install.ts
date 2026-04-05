/**
 * `claudemesh install` / `uninstall` — manage Claude Code MCP registration.
 *
 * install:
 *   1. Preflight: bun is on PATH, this package's MCP entry is on disk.
 *   2. Read ~/.claude.json (or empty object if absent).
 *   3. Add/update `mcpServers.claudemesh` with the resolved entry path.
 *   4. Write back with 0600 perms.
 *   5. Verify via read-back, print success.
 *
 * uninstall:
 *   1. Read ~/.claude.json (bail if missing).
 *   2. Delete `mcpServers.claudemesh` if present.
 *   3. Write back.
 *
 * Both are idempotent — re-running install is a no-op if the entry is
 * already correct, and uninstall is a no-op if no entry exists.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const MCP_NAME = "claudemesh";
const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOK_COMMAND_STOP = "claudemesh hook idle";
const HOOK_COMMAND_USER_PROMPT = "claudemesh hook working";
const HOOK_MARKER = "claudemesh hook ";

type McpEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

interface HookCommand {
  type: "command";
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksConfig = Record<string, HookMatcher[]>;

function readClaudeConfig(): Record<string, unknown> {
  if (!existsSync(CLAUDE_CONFIG)) return {};
  const text = readFileSync(CLAUDE_CONFIG, "utf-8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `failed to parse ${CLAUDE_CONFIG}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function writeClaudeConfig(obj: Record<string, unknown>): void {
  mkdirSync(dirname(CLAUDE_CONFIG), { recursive: true });
  writeFileSync(
    CLAUDE_CONFIG,
    JSON.stringify(obj, null, 2) + "\n",
    "utf-8",
  );
  try {
    chmodSync(CLAUDE_CONFIG, 0o600);
  } catch {
    /* windows has no chmod */
  }
}

/** Check `bun` is on PATH — OS-agnostic, node:child_process. */
function bunAvailable(): boolean {
  const res =
    platform() === "win32"
      ? spawnSync("where", ["bun"])
      : spawnSync("sh", ["-c", "command -v bun"]);
  return res.status === 0;
}

/** Absolute path to this CLI's entry file. */
function resolveEntry(): string {
  const here = fileURLToPath(import.meta.url);
  // When bundled (dist/index.js), this file IS the entry → return self.
  // When running from source (src/index.ts via bun), walk up to the
  // dir + resolve index.ts.
  if (here.endsWith("/dist/index.js") || here.endsWith("\\dist\\index.js")) {
    return here;
  }
  return resolve(dirname(here), "..", "index.ts");
}

/**
 * Build the MCP server entry for Claude Code's config.
 *
 * Two modes:
 *   - Installed globally (npm i -g claudemesh-cli): use `claudemesh`
 *     as the command, relies on it being on PATH.
 *   - Local dev (bun apps/cli/src/index.ts): use `bun <absolute-path>`.
 */
function buildMcpEntry(entryPath: string): McpEntry {
  const isBundled = entryPath.endsWith("/dist/index.js") ||
    entryPath.endsWith("\\dist\\index.js");
  if (isBundled) {
    return {
      command: "claudemesh",
      args: ["mcp"],
    };
  }
  return {
    command: "bun",
    args: [entryPath, "mcp"],
  };
}

function entriesEqual(a: McpEntry, b: McpEntry): boolean {
  return (
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
  );
}

function readClaudeSettings(): Record<string, unknown> {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  const text = readFileSync(CLAUDE_SETTINGS, "utf-8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `failed to parse ${CLAUDE_SETTINGS}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function writeClaudeSettings(obj: Record<string, unknown>): void {
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(
    CLAUDE_SETTINGS,
    JSON.stringify(obj, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Add a Stop + UserPromptSubmit hook entry to ~/.claude/settings.json,
 * idempotent on the command string. Returns counts for reporting.
 */
function installHooks(): { added: number; unchanged: number } {
  const settings = readClaudeSettings();
  const hooks = ((settings.hooks ??= {}) as HooksConfig) ?? {};
  let added = 0;
  let unchanged = 0;

  const ensure = (event: string, command: string): void => {
    const list = (hooks[event] ??= []);
    const alreadyPresent = list.some((entry) =>
      (entry.hooks ?? []).some((h) => h.command === command),
    );
    if (alreadyPresent) {
      unchanged += 1;
      return;
    }
    list.push({ hooks: [{ type: "command", command }] });
    added += 1;
  };
  ensure("Stop", HOOK_COMMAND_STOP);
  ensure("UserPromptSubmit", HOOK_COMMAND_USER_PROMPT);

  settings.hooks = hooks;
  writeClaudeSettings(settings);
  return { added, unchanged };
}

/**
 * Remove every hook entry whose command contains "claudemesh hook "
 * from ~/.claude/settings.json. Idempotent. Returns removed count.
 */
function uninstallHooks(): number {
  if (!existsSync(CLAUDE_SETTINGS)) return 0;
  const settings = readClaudeSettings();
  const hooks = settings.hooks as HooksConfig | undefined;
  if (!hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const kept: HookMatcher[] = [];
    for (const entry of hooks[event] ?? []) {
      const filtered = (entry.hooks ?? []).filter(
        (h) => !(h.command ?? "").includes(HOOK_MARKER),
      );
      removed += (entry.hooks ?? []).length - filtered.length;
      if (filtered.length > 0) kept.push({ ...entry, hooks: filtered });
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  settings.hooks = hooks;
  writeClaudeSettings(settings);
  return removed;
}

export function runInstall(args: string[] = []): void {
  const skipHooks = args.includes("--no-hooks");
  console.log("claudemesh install");
  console.log("------------------");

  const entry = resolveEntry();
  const isBundled = entry.endsWith("/dist/index.js") ||
    entry.endsWith("\\dist\\index.js");

  // Dev mode (running from src/) requires bun on PATH; bundled mode
  // (npm install -g) just uses node + the claudemesh bin shim.
  if (!isBundled && !bunAvailable()) {
    console.error(
      "✗ `bun` is not on PATH. Install Bun first: https://bun.com",
    );
    process.exit(1);
  }
  if (!existsSync(entry)) {
    console.error(`✗ MCP entry not found at ${entry}`);
    process.exit(1);
  }

  const cfg = readClaudeConfig();
  const servers =
    ((cfg.mcpServers ??= {}) as Record<string, McpEntry>) ?? {};
  const desired = buildMcpEntry(entry);
  const existing = servers[MCP_NAME];
  let action: "added" | "updated" | "unchanged";
  if (!existing) {
    servers[MCP_NAME] = desired;
    action = "added";
  } else if (entriesEqual(existing, desired)) {
    action = "unchanged";
  } else {
    servers[MCP_NAME] = desired;
    action = "updated";
  }
  cfg.mcpServers = servers;

  writeClaudeConfig(cfg);

  // Read-back verification.
  const verify = readClaudeConfig();
  const verifyServers = (verify.mcpServers ?? {}) as Record<string, McpEntry>;
  const stored = verifyServers[MCP_NAME];
  if (!stored || !entriesEqual(stored, desired)) {
    console.error(
      `✗ post-write verification failed — ${CLAUDE_CONFIG} may be corrupt`,
    );
    process.exit(1);
  }

  // ANSI color helpers — stick to 8-color set so terminals without
  // truecolor still render. Fall back to plain if NO_COLOR or dumb TERM.
  const useColor =
    !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY;
  const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[22m` : s);
  const yellow = (s: string) => (useColor ? `\x1b[33m${s}\x1b[39m` : s);
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);

  console.log(`✓ MCP server "${MCP_NAME}" ${action}`);
  console.log(dim(`  config:  ${CLAUDE_CONFIG}`));
  console.log(
    dim(
      `  command: ${desired.command}${desired.args?.length ? " " + desired.args.join(" ") : ""}`,
    ),
  );

  // Hooks — status accuracy (Stop/UserPromptSubmit → POST /hook/set-status).
  if (!skipHooks) {
    try {
      const { added, unchanged } = installHooks();
      if (added > 0) {
        console.log(
          `✓ Hooks registered (Stop + UserPromptSubmit) → ${added} added, ${unchanged} already present`,
        );
      } else {
        console.log(`✓ Hooks already registered (${unchanged} present)`);
      }
      console.log(dim(`  config:  ${CLAUDE_SETTINGS}`));
    } catch (e) {
      console.error(
        `⚠  hook registration failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      console.error(
        "   (MCP is still installed — hooks just skip. Retry with --no-hooks to suppress.)",
      );
    }
  } else {
    console.log(dim("· Hooks skipped (--no-hooks)"));
  }

  console.log("");
  console.log(yellow(bold("⚠  RESTART CLAUDE CODE")) + yellow(" for MCP tools to appear."));
  console.log("");
  console.log(
    `Next: ${bold("claudemesh join https://claudemesh.com/join/<token>")}`,
  );
  console.log("");
  console.log(
    yellow("⚠  For real-time push messages from peers, launch with:"),
  );
  console.log(
    `     ${bold("claudemesh launch")}` +
      dim("    (or: claude --dangerously-load-development-channels server:claudemesh)"),
  );
  console.log(
    dim("   Plain `claude` still works — messages are then pull-only via check_messages."),
  );
}

export function runUninstall(): void {
  console.log("claudemesh uninstall");
  console.log("--------------------");

  // MCP entry
  if (existsSync(CLAUDE_CONFIG)) {
    const cfg = readClaudeConfig();
    const servers = cfg.mcpServers as
      | Record<string, McpEntry>
      | undefined;
    if (servers && MCP_NAME in servers) {
      delete servers[MCP_NAME];
      cfg.mcpServers = servers;
      writeClaudeConfig(cfg);
      console.log(`✓ MCP server "${MCP_NAME}" removed`);
    } else {
      console.log(`· MCP server "${MCP_NAME}" not present`);
    }
  } else {
    console.log(`· no ${CLAUDE_CONFIG} — MCP entry skipped`);
  }

  // Hooks
  try {
    const removed = uninstallHooks();
    if (removed > 0) {
      console.log(`✓ Hooks removed (${removed} entries)`);
    } else {
      console.log("· No claudemesh hooks to remove");
    }
  } catch (e) {
    console.error(
      `⚠  hook removal failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  console.log("");
  console.log("Restart Claude Code to drop the MCP connection + hooks.");
}
