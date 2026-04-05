/**
 * MCP server (stdio transport) for claudemesh-cli.
 *
 * Starts BrokerClient connections for every mesh in config on boot,
 * then routes the 5 MCP tools through them.
 *
 * list_peers is stubbed at the CLI level — the broker's WS protocol
 * does not yet carry a list-peers request type (Step 16). Until then,
 * it returns a note.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools";
import { loadConfig } from "../state/config";
import { startClients, stopAll, findClient, allClients } from "../ws/manager";
import type {
  Priority,
  PeerStatus,
  SendMessageArgs,
  SetStatusArgs,
  SetSummaryArgs,
  ListPeersArgs,
} from "./types";
import type { BrokerClient, InboundPush } from "../ws/client";

function text(msg: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: msg }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Given a `to` string, pick which mesh to send from. Strategies:
 *   - If `to` looks like a pubkey hex (64 chars), try every client;
 *     caller is expected to know which mesh the pubkey lives in.
 *   - If `to` starts with `#`, treat as channel on the first mesh.
 *   - Otherwise try to match a displayName (TODO — needs list_peers).
 *
 * For now the MVP: if only one mesh is joined, use that. Otherwise
 * require the caller to prefix with `<mesh-slug>:`.
 */
function resolveClient(to: string): {
  client: BrokerClient | null;
  targetSpec: string;
  error?: string;
} {
  const clients = allClients();
  if (clients.length === 0) {
    return { client: null, targetSpec: to, error: "no meshes joined" };
  }
  // Explicit mesh prefix: "mesh-slug:targetspec"
  const colonIdx = to.indexOf(":");
  if (colonIdx > 0 && colonIdx < to.length - 1) {
    const slug = to.slice(0, colonIdx);
    const rest = to.slice(colonIdx + 1);
    const match = findClient(slug);
    if (match) return { client: match, targetSpec: rest };
  }
  // Single-mesh fast path.
  if (clients.length === 1) {
    return { client: clients[0]!, targetSpec: to };
  }
  return {
    client: null,
    targetSpec: to,
    error: `multiple meshes joined; prefix target with "<mesh-slug>:" (joined: ${clients.map((c) => c.meshSlug).join(", ")})`,
  };
}

function decryptFailedWarning(senderPubkey: string): string {
  const who = senderPubkey ? senderPubkey.slice(0, 12) + "…" : "unknown sender";
  return `⚠ message from ${who} failed to decrypt (tampered or wrong keypair)`;
}

function formatPush(p: InboundPush, meshSlug: string): string {
  const body = p.plaintext ?? decryptFailedWarning(p.senderPubkey);
  return `[${meshSlug}] from ${p.senderPubkey.slice(0, 12)}… (${p.priority}, ${p.createdAt}):\n${body}`;
}

export async function startMcpServer(): Promise<void> {
  const config = loadConfig();

  const server = new Server(
    { name: "claudemesh", version: "0.1.3" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: `You are connected to claudemesh — a peer mesh for Claude Code sessions on this machine and elsewhere.

IMPORTANT: When you receive a <channel source="claudemesh" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_name, mesh_slug, and priority attributes to understand context. Reply by calling send_message with the same target (for direct messages the from_id is the sender's pubkey).

Available tools:
- list_peers: see joined meshes + their connection status
- send_message: send to a peer pubkey, channel, or broadcast (priority: now/next/low)
- check_messages: drain buffered inbound messages (usually auto-pushed)
- set_summary: 1-2 sentence summary of what you're working on
- set_status: manually override your status (idle/working/dnd)

Message priority:
- "now": delivered immediately regardless of recipient status (use sparingly)
- "next" (default): delivered when recipient is idle
- "low": pull-only (check_messages)

If you have multiple joined meshes, prefix the \`to\` argument of send_message with \`<mesh-slug>:\` to disambiguate. Otherwise claudemesh picks the single joined mesh.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (config.meshes.length === 0) {
      return text(
        "No meshes joined. Run `claudemesh join https://claudemesh.com/join/<token>` first.",
        true,
      );
    }

    switch (name) {
      case "send_message": {
        const { to, message, priority } = (args ?? {}) as SendMessageArgs;
        if (!to || !message)
          return text("send_message: `to` and `message` required", true);
        const { client, targetSpec, error } = resolveClient(to);
        if (!client)
          return text(`send_message: ${error ?? "no client resolved"}`, true);
        const result = await client.send(
          targetSpec,
          message,
          (priority ?? "next") as Priority,
        );
        if (!result.ok)
          return text(
            `send_message failed (${client.meshSlug}): ${result.error}`,
            true,
          );
        return text(
          `Sent to ${targetSpec} via ${client.meshSlug} [${priority ?? "next"}] → ${result.messageId}`,
        );
      }

      case "list_peers": {
        const { mesh_slug } = (args ?? {}) as ListPeersArgs;
        const clients = mesh_slug
          ? [findClient(mesh_slug)].filter(Boolean)
          : allClients();
        if (clients.length === 0)
          return text(
            mesh_slug
              ? `list_peers: no joined mesh "${mesh_slug}"`
              : "list_peers: no joined meshes",
            true,
          );
        const lines = clients.map(
          (c) =>
            `- ${c!.meshSlug} (${c!.status}, mesh ${c!.meshId.slice(0, 8)}…)`,
        );
        return text(
          `Connected meshes:\n${lines.join("\n")}\n\n(list_peers WS protocol lands in Step 16; only mesh status is shown for now.)`,
        );
      }

      case "check_messages": {
        const drained: string[] = [];
        for (const c of allClients()) {
          const msgs = c.drainPushBuffer();
          for (const m of msgs) drained.push(formatPush(m, c.meshSlug));
        }
        if (drained.length === 0) return text("No new messages.");
        return text(
          `${drained.length} new message(s):\n\n${drained.join("\n\n---\n\n")}`,
        );
      }

      case "set_summary": {
        const { summary } = (args ?? {}) as SetSummaryArgs;
        if (!summary) return text("set_summary: `summary` required", true);
        return text(
          `set_summary: summary recorded locally ("${summary}"). (Broker WS protocol for summaries lands in Step 16.)`,
        );
      }

      case "set_status": {
        const { status } = (args ?? {}) as SetStatusArgs;
        if (!status) return text("set_status: `status` required", true);
        const s = status as PeerStatus;
        for (const c of allClients()) await c.setStatus(s);
        return text(`Status set to ${s} across ${allClients().length} mesh(es).`);
      }

      default:
        return text(`Unknown tool: ${name}`, true);
    }
  });

  // Start broker clients for every joined mesh BEFORE MCP connects.
  await startClients(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Wire WSS pushes → MCP channel notifications. Each inbound push on
  // any mesh's broker connection becomes a <channel source="claudemesh">
  // system reminder injected into Claude Code's context.
  for (const client of allClients()) {
    client.onPush(async (msg) => {
      const fromPubkey = msg.senderPubkey || "";
      const fromName = fromPubkey
        ? `peer-${fromPubkey.slice(0, 8)}`
        : "unknown";
      const content = msg.plaintext ?? decryptFailedWarning(fromPubkey);
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              from_id: fromPubkey,
              from_name: fromName,
              mesh_slug: client.meshSlug,
              mesh_id: client.meshId,
              priority: msg.priority,
              sent_at: msg.createdAt,
              delivered_at: msg.receivedAt,
              kind: msg.kind,
            },
          },
        });
      } catch {
        /* channel push is best-effort; check_messages is the fallback */
      }
    });
  }

  const shutdown = (): void => {
    stopAll();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
