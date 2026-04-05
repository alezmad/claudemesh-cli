/**
 * Process-wide registry of BrokerClient connections, keyed by meshId.
 *
 * The MCP server lazily starts a client per joined mesh on startup,
 * keeps them alive for the life of the process, and uses them to
 * service MCP tool calls.
 */

import { BrokerClient } from "./client";
import type { Config, JoinedMesh } from "../state/config";
import { env } from "../env";

const clients = new Map<string, BrokerClient>();

/** Ensure a BrokerClient exists + is connecting/open for this mesh. */
export async function ensureClient(mesh: JoinedMesh): Promise<BrokerClient> {
  const existing = clients.get(mesh.meshId);
  if (existing) return existing;
  const client = new BrokerClient(mesh, { debug: env.CLAUDEMESH_DEBUG });
  clients.set(mesh.meshId, client);
  try {
    await client.connect();
  } catch {
    // Connect failed → client is in "reconnecting" state, leave it
    // wired so tool calls can surface the status.
  }
  return client;
}

/** Start clients for every joined mesh. Called once on MCP server start. */
export async function startClients(config: Config): Promise<void> {
  await Promise.allSettled(config.meshes.map(ensureClient));
}

/** Look up a client by mesh slug (human-friendly) or meshId. */
export function findClient(needle: string): BrokerClient | null {
  // Try meshId first, then slug.
  const byId = clients.get(needle);
  if (byId) return byId;
  for (const c of clients.values()) {
    if (c.meshSlug === needle) return c;
  }
  return null;
}

/** All clients across all meshes. */
export function allClients(): BrokerClient[] {
  return [...clients.values()];
}

/** Close every client (shutdown hook). */
export function stopAll(): void {
  for (const c of clients.values()) c.close();
  clients.clear();
}
