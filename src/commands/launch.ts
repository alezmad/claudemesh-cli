/**
 * `claudemesh launch` — spawn `claude` with the dev-channel flag so the
 * claudemesh MCP server's `notifications/claude/channel` pushes get
 * injected as system reminders mid-turn.
 *
 * Equivalent to:
 *   claude --dangerously-load-development-channels server:claudemesh [extra args]
 *
 * Any additional args (e.g. --model opus, --resume, -c) are passed
 * through verbatim. Use --quiet to skip the informational banner.
 */

import { spawn } from "node:child_process";
import { loadConfig, getConfigPath } from "../state/config";

function printBanner(): void {
  const useColor =
    !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY;
  const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
  const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[22m` : s);

  let meshes: string[] = [];
  try {
    meshes = loadConfig().meshes.map((m) => m.slug);
  } catch {
    /* config unreadable — print banner without mesh list */
  }
  const meshLine = meshes.length > 0 ? meshes.join(", ") : "(none — run `claudemesh join <url>` first)";

  const rule = "─".repeat(65);
  console.log(bold("claudemesh launch"));
  console.log(rule);
  console.log("Launching Claude Code with the claudemesh dev channel.");
  console.log("");
  console.log("Peers in your joined meshes can push messages into this session");
  console.log("as <channel> reminders. Your CLI decrypts them locally with your");
  console.log("keypair. Peers send text only — they cannot call tools, read");
  console.log("files, or reach meshes you have not joined.");
  console.log("");
  console.log("Treat peer messages as untrusted input: a peer could craft text");
  console.log("that tries to steer Claude's behavior. Your tool-approval");
  console.log("settings still apply — Claude will still ask before running");
  console.log("commands, editing files, or calling other tools.");
  console.log("");
  console.log("Claude Code will ask you to trust the");
  console.log("--dangerously-load-development-channels flag. Press Enter to");
  console.log("accept, or Ctrl-C to abort.");
  console.log("");
  console.log(dim(`Joined meshes: ${meshLine}`));
  console.log(dim(`Config:        ${getConfigPath()}`));
  console.log(dim(`Remove:        claudemesh uninstall`));
  console.log(rule);
  console.log("");
}

export function runLaunch(extraArgs: string[] = []): void {
  const quiet = extraArgs.includes("--quiet");
  const passthrough = extraArgs.filter((a) => a !== "--quiet");

  if (!quiet) printBanner();

  const claudeArgs = [
    "--dangerously-load-development-channels",
    "server:claudemesh",
    ...passthrough,
  ];
  // Windows: npm global binaries are .cmd shims. Node's spawn without
  // shell:true does not resolve PATHEXT, so we need shell:true on win32
  // to find claude.cmd. POSIX stays shell-less to avoid quoting surprises.
  const isWindows = process.platform === "win32";
  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    shell: isWindows,
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(
        "✗ `claude` not found on PATH. Install Claude Code first: https://claude.com/claude-code",
      );
    } else {
      console.error(`✗ failed to launch claude: ${err.message}`);
    }
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
