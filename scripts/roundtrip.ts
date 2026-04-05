#!/usr/bin/env bun
/**
 * End-to-end round-trip: two BrokerClient instances talking via the
 * broker. Runs against a live broker + seeded DB.
 *
 * Reads /tmp/cli-seed.json (output of broker's scripts/seed-test-mesh.ts),
 * connects peer A and peer B, sends a message from A to B, waits for
 * the push on B, asserts receipt + sender pubkey.
 */

import { readFileSync } from "node:fs";
import { BrokerClient } from "../src/ws/client";
import type { JoinedMesh } from "../src/state/config";

const seed = JSON.parse(readFileSync("/tmp/cli-seed.json", "utf-8")) as {
  meshId: string;
  peerA: { memberId: string; pubkey: string; secretKey: string };
  peerB: { memberId: string; pubkey: string; secretKey: string };
};

const brokerUrl = process.env.BROKER_WS_URL ?? "ws://localhost:7900/ws";
const meshA: JoinedMesh = {
  meshId: seed.meshId,
  memberId: seed.peerA.memberId,
  slug: "rt-a",
  name: "roundtrip-a",
  pubkey: seed.peerA.pubkey,
  secretKey: seed.peerA.secretKey,
  brokerUrl,
  joinedAt: new Date().toISOString(),
};
const meshB: JoinedMesh = {
  ...meshA,
  memberId: seed.peerB.memberId,
  slug: "rt-b",
  pubkey: seed.peerB.pubkey,
  secretKey: seed.peerB.secretKey,
};

async function main(): Promise<void> {
  const a = new BrokerClient(meshA, { debug: true });
  const b = new BrokerClient(meshB, { debug: true });

  let received: string | null = null;
  let receivedSender: string | null = null;
  b.onPush((msg) => {
    received = msg.plaintext;
    receivedSender = msg.senderPubkey;
    console.log(`[b] push (kind=${msg.kind}): "${received}" from ${receivedSender?.slice(0, 16)}…`);
  });

  console.log("[rt] connecting A + B…");
  await Promise.all([a.connect(), b.connect()]);
  console.log(`[rt] A: ${a.status}, B: ${b.status}`);

  console.log("[rt] A → B …");
  const result = await a.send(seed.peerB.pubkey, "hello from A", "now");
  console.log("[rt] send result:", result);

  // Wait up to 3s for the push to land.
  for (let i = 0; i < 30 && !received; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  a.close();
  b.close();

  if (!received) {
    console.error("✗ FAIL: no push received");
    process.exit(1);
  }
  if (received !== "hello from A") {
    console.error(`✗ FAIL: body mismatch: "${received}"`);
    process.exit(1);
  }
  if (receivedSender !== seed.peerA.pubkey) {
    console.error(`✗ FAIL: sender mismatch: "${receivedSender}"`);
    process.exit(1);
  }
  console.log("✓ round-trip PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("✗ FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
