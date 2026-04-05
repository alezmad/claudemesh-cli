/**
 * Ed25519 keypair generation using libsodium.
 *
 * We use libsodium-wrappers even in Step 17 (pre-crypto) so the key
 * format matches what Step 18's signing/encryption code will expect —
 * no migration needed later.
 */

import sodium from "libsodium-wrappers";

let ready = false;

export async function ensureSodium(): Promise<typeof sodium> {
  if (!ready) {
    await sodium.ready;
    ready = true;
  }
  return sodium;
}

export interface Ed25519Keypair {
  /** 32-byte public key, hex-encoded. */
  publicKey: string;
  /** 64-byte secret key (seed || publicKey), hex-encoded. */
  secretKey: string;
}

/** Generate a fresh ed25519 keypair. */
export async function generateKeypair(): Promise<Ed25519Keypair> {
  const s = await ensureSodium();
  const kp = s.crypto_sign_keypair();
  return {
    publicKey: s.to_hex(kp.publicKey),
    secretKey: s.to_hex(kp.privateKey),
  };
}
