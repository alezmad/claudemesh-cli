/**
 * Direct-message encryption via libsodium crypto_box.
 *
 * Keys: our peers hold ed25519 signing keypairs (from Step 17).
 * crypto_box uses X25519 (curve25519) keys, so we convert on the fly
 * via crypto_sign_ed25519_{pk,sk}_to_curve25519. One signing keypair
 * serves both purposes cleanly.
 *
 * Wire format: {nonce, ciphertext} both base64. Nonce is 24 bytes
 * (crypto_box_NONCEBYTES), fresh-random per message.
 *
 * Broadcasts ("*") and channels ("#foo") are NOT encrypted here —
 * they need a shared key (mesh_root_key) and land in a later step.
 */

import { ensureSodium } from "./keypair";

export interface Envelope {
  nonce: string; // base64
  ciphertext: string; // base64
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/** Does this targetSpec look like a direct-message pubkey? */
export function isDirectTarget(targetSpec: string): boolean {
  return HEX_PUBKEY.test(targetSpec);
}

/**
 * Encrypt a plaintext message addressed to a single recipient.
 * Recipient's ed25519 pubkey (64 hex chars) is converted to X25519
 * on the fly. Sender's full ed25519 secret key (128 hex chars) is
 * also converted.
 */
export async function encryptDirect(
  message: string,
  recipientPubkeyHex: string,
  senderSecretKeyHex: string,
): Promise<Envelope> {
  const sodium = await ensureSodium();
  const recipientPub = sodium.crypto_sign_ed25519_pk_to_curve25519(
    sodium.from_hex(recipientPubkeyHex),
  );
  const senderSec = sodium.crypto_sign_ed25519_sk_to_curve25519(
    sodium.from_hex(senderSecretKeyHex),
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy(
    sodium.from_string(message),
    nonce,
    recipientPub,
    senderSec,
  );
  return {
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  };
}

/**
 * Decrypt an inbound envelope from a known sender. Returns null if
 * decryption fails (wrong keys, tampered ciphertext, malformed input).
 */
export async function decryptDirect(
  envelope: Envelope,
  senderPubkeyHex: string,
  recipientSecretKeyHex: string,
): Promise<string | null> {
  const sodium = await ensureSodium();
  try {
    const senderPub = sodium.crypto_sign_ed25519_pk_to_curve25519(
      sodium.from_hex(senderPubkeyHex),
    );
    const recipientSec = sodium.crypto_sign_ed25519_sk_to_curve25519(
      sodium.from_hex(recipientSecretKeyHex),
    );
    const nonce = sodium.from_base64(
      envelope.nonce,
      sodium.base64_variants.ORIGINAL,
    );
    const ciphertext = sodium.from_base64(
      envelope.ciphertext,
      sodium.base64_variants.ORIGINAL,
    );
    const plain = sodium.crypto_box_open_easy(
      ciphertext,
      nonce,
      senderPub,
      recipientSec,
    );
    return sodium.to_string(plain);
  } catch {
    return null;
  }
}
