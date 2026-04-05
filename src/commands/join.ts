/**
 * `claudemesh join <invite-link>` — full join flow.
 *
 * 1. Parse + validate the ic://join/... link
 * 2. Generate a fresh ed25519 keypair (libsodium)
 * 3. POST /join to the broker → get member_id
 * 4. Persist the mesh + keypair to ~/.claudemesh/config.json (0600)
 * 5. Print success
 *
 * Signature verification + invite-token one-time-use land in Step 18.
 */

import { parseInviteLink } from "../invite/parse";
import { enrollWithBroker } from "../invite/enroll";
import { generateKeypair } from "../crypto/keypair";
import { loadConfig, saveConfig, getConfigPath } from "../state/config";
import { hostname } from "node:os";

export async function runJoin(args: string[]): Promise<void> {
  const link = args[0];
  if (!link) {
    console.error("Usage: claudemesh join <invite-url-or-token>");
    console.error("");
    console.error(
      "Example: claudemesh join https://claudemesh.com/join/eyJ2IjoxLC4uLn0",
    );
    process.exit(1);
  }

  // 1. Parse + verify signature client-side.
  let invite;
  try {
    invite = await parseInviteLink(link);
  } catch (e) {
    console.error(
      `claudemesh: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
  const { payload, token } = invite;
  console.log(`Joining mesh "${payload.mesh_slug}" (${payload.mesh_id})…`);

  // 2. Generate keypair.
  const keypair = await generateKeypair();

  // 3. Enroll with broker.
  const displayName = `${hostname()}-${process.pid}`;
  let enroll;
  try {
    enroll = await enrollWithBroker({
      brokerWsUrl: payload.broker_url,
      inviteToken: token,
      invitePayload: payload,
      peerPubkey: keypair.publicKey,
      displayName,
    });
  } catch (e) {
    console.error(
      `claudemesh: broker enrollment failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  // 4. Persist.
  const config = loadConfig();
  config.meshes = config.meshes.filter(
    (m) => m.slug !== payload.mesh_slug,
  );
  config.meshes.push({
    meshId: payload.mesh_id,
    memberId: enroll.memberId,
    slug: payload.mesh_slug,
    name: payload.mesh_slug,
    pubkey: keypair.publicKey,
    secretKey: keypair.secretKey,
    brokerUrl: payload.broker_url,
    joinedAt: new Date().toISOString(),
  });
  saveConfig(config);

  // 5. Report.
  console.log("");
  console.log(
    `✓ Joined "${payload.mesh_slug}" as ${displayName}${enroll.alreadyMember ? " (already a member — re-enrolled with same pubkey)" : ""}`,
  );
  console.log(`  member id: ${enroll.memberId}`);
  console.log(`  pubkey:    ${keypair.publicKey.slice(0, 16)}…`);
  console.log(`  broker:    ${payload.broker_url}`);
  console.log(`  config:    ${getConfigPath()}`);
  console.log("");
  console.log("Restart Claude Code to pick up the new mesh.");
}
