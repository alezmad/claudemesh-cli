/**
 * Client-side signing of the WS hello handshake.
 *
 * Canonical bytes: `${meshId}|${memberId}|${pubkey}|${timestamp}` —
 * MUST match the broker's `canonicalHello()` exactly. Any mismatch
 * (delimiter, field order, whitespace) produces a bad_signature reject.
 *
 * Uses the full ed25519 secret key (64 bytes) that libsodium returns
 * from crypto_sign_keypair — seed || pubkey layout.
 */

import { ensureSodium } from "./keypair";

export async function signHello(
  meshId: string,
  memberId: string,
  pubkey: string,
  secretKeyHex: string,
): Promise<{ timestamp: number; signature: string }> {
  const s = await ensureSodium();
  const timestamp = Date.now();
  const canonical = `${meshId}|${memberId}|${pubkey}|${timestamp}`;
  const sig = s.crypto_sign_detached(
    s.from_string(canonical),
    s.from_hex(secretKeyHex),
  );
  return { timestamp, signature: s.to_hex(sig) };
}
