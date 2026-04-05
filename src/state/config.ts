/**
 * Local persistent config — ~/.claudemesh/config.json
 *
 * Stores: joined meshes, per-mesh identity keys (ed25519 keypairs),
 * last-seen broker URL. Loaded on CLI start, on MCP server start,
 * and on every join/leave.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import { env } from "../env";

const joinedMeshSchema = z.object({
  meshId: z.string(),
  memberId: z.string(),
  slug: z.string(),
  name: z.string(),
  pubkey: z.string(), // ed25519 hex (32 bytes = 64 chars)
  secretKey: z.string(), // ed25519 hex (64 bytes = 128 chars)
  brokerUrl: z.string(),
  joinedAt: z.string(),
});

const configSchema = z.object({
  version: z.literal(1).default(1),
  meshes: z.array(joinedMeshSchema).default([]),
});

export type JoinedMesh = z.infer<typeof joinedMeshSchema>;
export type Config = z.infer<typeof configSchema>;

const CONFIG_DIR = env.CLAUDEMESH_CONFIG_DIR ?? join(homedir(), ".claudemesh");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    return configSchema.parse({ version: 1, meshes: [] });
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return configSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new Error(
      `Failed to load ${CONFIG_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  // Config holds ed25519 secret keys — restrict to owner read/write.
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows filesystems ignore chmod; that's fine.
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
