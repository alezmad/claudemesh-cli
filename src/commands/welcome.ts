/**
 * Stateful welcome screen — shown when the user runs `claudemesh`
 * with no arguments. Detects install state + joined meshes + prints
 * the next action they should take.
 *
 * States, in priority order:
 *   1. MCP not registered in ~/.claude.json       → run install
 *   2. Config dir exists but no meshes joined     → run join
 *   3. Meshes joined, all reachable               → run launch
 *   4. Meshes joined, broker unreachable          → run status / doctor
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../state/config";
import { VERSION } from "../version";

type State = "no-install" | "no-meshes" | "ready" | "broken-config";

function detectState(): State {
  // 1. MCP registered?
  const claudeConfig = join(homedir(), ".claude.json");
  let mcpRegistered = false;
  if (existsSync(claudeConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(claudeConfig, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      mcpRegistered = Boolean(cfg.mcpServers?.["claudemesh"]);
    } catch {
      /* treat parse errors as not-registered */
    }
  }
  if (!mcpRegistered) return "no-install";

  // 2. Config parseable + has meshes?
  try {
    const cfg = loadConfig();
    return cfg.meshes.length === 0 ? "no-meshes" : "ready";
  } catch {
    return "broken-config";
  }
}

export function runWelcome(): void {
  const useColor =
    !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY;
  const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[22m` : s);
  const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
  const green = (s: string): string => (useColor ? `\x1b[32m${s}\x1b[39m` : s);
  const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[39m` : s);

  console.log(bold(`claudemesh v${VERSION}`) + dim(" — peer mesh for Claude Code"));
  console.log("─".repeat(60));

  const state = detectState();

  switch (state) {
    case "no-install":
      console.log("Welcome. Let's get you set up.");
      console.log("");
      console.log(bold("Step 1:") + " register the MCP server + status hooks");
      console.log(`  ${green("$")} claudemesh install`);
      console.log("");
      console.log(dim("Step 2 (after restart): claudemesh join <invite-url>"));
      console.log(dim("Step 3:                 claudemesh launch"));
      break;

    case "no-meshes":
      console.log(green("✓") + " MCP registered. Now join a mesh.");
      console.log("");
      console.log(bold("Step 2:") + " join a mesh");
      console.log(`  ${green("$")} claudemesh join https://claudemesh.com/join/<token>`);
      console.log("");
      console.log(
        dim("  Don't have an invite? Create one at ") +
          bold("https://claudemesh.com") +
          dim(" or ask a mesh owner."),
      );
      console.log("");
      console.log(dim("Step 3 (after joining): claudemesh launch"));
      break;

    case "ready": {
      const cfg = loadConfig();
      const meshNames = cfg.meshes.map((m) => m.slug).join(", ");
      console.log(green("✓") + " MCP registered.");
      console.log(green("✓") + ` ${cfg.meshes.length} mesh(es) joined: ${meshNames}`);
      console.log("");
      console.log(bold("You're ready.") + " Launch Claude Code with real-time peer messages:");
      console.log(`  ${green("$")} claudemesh launch`);
      console.log("");
      console.log(dim("  (Plain `claude` works too — messages pull-only via check_messages.)"));
      console.log("");
      console.log(dim("Health check:  claudemesh status"));
      console.log(dim("Diagnostics:   claudemesh doctor"));
      console.log(dim("All commands:  claudemesh --help"));
      break;
    }

    case "broken-config":
      console.log(yellow("⚠") + "  Your ~/.claudemesh/config.json is unreadable.");
      console.log("");
      console.log("Run diagnostics to see what's wrong:");
      console.log(`  ${green("$")} claudemesh doctor`);
      break;
  }

  console.log("");
}
