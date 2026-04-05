#!/usr/bin/env bun
/**
 * Emit the signed invite link produced by the broker's seed-test-mesh.
 *
 * The seed script (apps/broker/scripts/seed-test-mesh.ts) creates a
 * mesh with an owner keypair and a signed invite row, then writes
 * both into /tmp/cli-seed.json. We just echo its inviteLink here so
 * downstream test scripts can pipe it.
 */

import { readFileSync } from "node:fs";

const seed = JSON.parse(readFileSync("/tmp/cli-seed.json", "utf-8")) as {
  inviteLink: string;
};

if (!seed.inviteLink) {
  console.error(
    "seed missing inviteLink — re-run apps/broker/scripts/seed-test-mesh.ts",
  );
  process.exit(1);
}
console.log(seed.inviteLink);
