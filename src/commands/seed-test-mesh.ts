/**
 * `claudemesh seed-test-mesh` — dev-only helper for 15b testing.
 *
 * Writes a locally-valid JoinedMesh entry to ~/.claudemesh/config.json
 * so the MCP server can connect to a locally-running broker without
 * invite-link / crypto plumbing.
 *
 * Usage:
 *   claudemesh seed-test-mesh <broker-url> <mesh-id> <member-id> <pubkey> <slug>
 */

import { loadConfig, saveConfig } from "../state/config";

export function runSeedTestMesh(args: string[]): void {
  const [brokerUrl, meshId, memberId, pubkey, slug] = args;
  if (!brokerUrl || !meshId || !memberId || !pubkey || !slug) {
    console.error(
      "Usage: claudemesh seed-test-mesh <broker-ws-url> <mesh-id> <member-id> <pubkey> <slug>",
    );
    console.error("");
    console.error(
      'Example: claudemesh seed-test-mesh "ws://localhost:7900/ws" mesh-123 member-abc aaa..aaa smoke-test',
    );
    process.exit(1);
  }
  const config = loadConfig();
  // Remove any prior entry with same slug (idempotent).
  config.meshes = config.meshes.filter((m) => m.slug !== slug);
  config.meshes.push({
    meshId,
    memberId,
    slug,
    name: `Test: ${slug}`,
    pubkey,
    secretKey: "dev-only-stub", // real keypair generated during join in Step 17
    brokerUrl,
    joinedAt: new Date().toISOString(),
  });
  saveConfig(config);
  console.log(`Seeded mesh "${slug}" (${meshId}) into local config.`);
  console.log(
    `Run \`claudemesh mcp\` to connect, or register with Claude Code via \`claudemesh install\`.`,
  );
}
