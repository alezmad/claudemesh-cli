/**
 * `claudemesh list` — show all joined meshes + their status.
 */

import { loadConfig, getConfigPath } from "../state/config";

export function runList(): void {
  const config = loadConfig();
  if (config.meshes.length === 0) {
    console.log("No meshes joined yet.");
    console.log("");
    console.log(
      "Join one with: claudemesh join https://claudemesh.com/join/<token>",
    );
    console.log(`Config file:   ${getConfigPath()}`);
    return;
  }
  console.log(`Joined meshes (${config.meshes.length}):`);
  console.log("");
  for (const m of config.meshes) {
    console.log(`  ${m.name} (${m.slug})`);
    console.log(`    mesh id:   ${m.meshId}`);
    console.log(`    member id: ${m.memberId}`);
    console.log(`    pubkey:    ${m.pubkey.slice(0, 16)}…`);
    console.log(`    broker:    ${m.brokerUrl}`);
    console.log(`    joined:    ${m.joinedAt}`);
    console.log("");
  }
  console.log(`Config: ${getConfigPath()}`);
}
