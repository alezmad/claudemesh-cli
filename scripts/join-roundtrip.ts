#!/usr/bin/env bun
/**
 * Full join → connect → send round-trip.
 *
 * Uses a mesh already seeded in the DB (reads /tmp/cli-seed.json).
 * Creates a fresh invite link, runs the join command, connects with
 * the newly-generated member identity, sends a message to peer B,
 * asserts receipt.
 */

// Run this script with CLAUDEMESH_CONFIG_DIR=/tmp/... set in env —
// ESM imports hoist above statements, so we can't set process.env
// after the `import { env }` side effect has already run.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { BrokerClient } from "../src/ws/client";
import type { JoinedMesh } from "../src/state/config";
import { loadConfig, getConfigPath } from "../src/state/config";

if (!process.env.CLAUDEMESH_CONFIG_DIR) {
  console.error(
    "Run with: CLAUDEMESH_CONFIG_DIR=/tmp/claudemesh-join-test-rt bun scripts/join-roundtrip.ts",
  );
  process.exit(1);
}
execSync(`rm -rf "${process.env.CLAUDEMESH_CONFIG_DIR}"`, {
  stdio: "ignore",
});

const seed = JSON.parse(readFileSync("/tmp/cli-seed.json", "utf-8")) as {
  meshId: string;
  peerB: { memberId: string; pubkey: string; secretKey: string };
};

async function main(): Promise<void> {
  // 1. Build invite.
  const link = execSync("bun scripts/make-invite.ts").toString().trim();
  console.log("[rt] invite:", link.slice(0, 60) + "…");

  // 2. Run `claudemesh join` with the same CONFIG_DIR.
  const joinOut = execSync(`bun src/index.ts join "${link}"`, {
    env: {
      ...process.env,
      CLAUDEMESH_CONFIG_DIR: "/tmp/claudemesh-join-test-rt",
    },
  }).toString();
  console.log("[rt] join output (tail):");
  console.log(
    joinOut
      .split("\n")
      .slice(-7)
      .map((l) => "    " + l)
      .join("\n"),
  );

  // 3. Load the fresh config and connect as the new peer.
  console.log(`[rt] loading config from: ${getConfigPath()}`);
  const config = loadConfig();
  console.log(`[rt] loaded ${config.meshes.length} mesh(es)`);
  const joined = config.meshes.find((m) => m.slug === "smoke-test");
  if (!joined) throw new Error("smoke-test mesh not found in config");
  const joinedMesh: JoinedMesh = joined;
  console.log(
    `[rt] joined member_id=${joinedMesh.memberId} pubkey=${joinedMesh.pubkey.slice(0, 16)}…`,
  );

  // 4. Connect also as peer-B (the target) so we can observe receipt.
  //    Uses the real keypair from the seed (needed for crypto_box decrypt).
  const targetMesh: JoinedMesh = {
    ...joinedMesh,
    memberId: seed.peerB.memberId,
    slug: "rt-join-b",
    pubkey: seed.peerB.pubkey,
    secretKey: seed.peerB.secretKey,
  };
  const joiner = new BrokerClient(joinedMesh);
  const target = new BrokerClient(targetMesh);

  let received = "";
  target.onPush((m) => {
    received = m.plaintext ?? "";
    console.log(`[rt] target got: "${received}"`);
  });

  await Promise.all([joiner.connect(), target.connect()]);
  console.log(`[rt] joiner=${joiner.status} target=${target.status}`);

  const res = await joiner.send(
    seed.peerB.pubkey,
    "sent-by-newly-joined-peer",
    "now",
  );
  console.log("[rt] send result:", res);

  for (let i = 0; i < 30 && !received; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  joiner.close();
  target.close();

  if (!res.ok) {
    console.error("✗ FAIL: send did not ack");
    process.exit(1);
  }
  if (received !== "sent-by-newly-joined-peer") {
    console.error(`✗ FAIL: receive mismatch: "${received}"`);
    process.exit(1);
  }
  console.log("✓ join → connect → send → receive FLOW PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("✗ FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
