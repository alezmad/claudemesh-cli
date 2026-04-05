/**
 * Invite-link parser for claudemesh `ic://join/<base64url(JSON)>` links.
 *
 * v0.1.0: parses + shape-validates + checks expiry. Signature
 * verification and one-time-use invite-token tracking land in Step 18.
 */

import { z } from "zod";
import { ensureSodium } from "../crypto/keypair";

const invitePayloadSchema = z.object({
  v: z.literal(1),
  mesh_id: z.string().min(1),
  mesh_slug: z.string().min(1),
  broker_url: z.string().min(1),
  expires_at: z.number().int().positive(),
  mesh_root_key: z.string().min(1),
  role: z.enum(["admin", "member"]),
  owner_pubkey: z.string().regex(/^[0-9a-f]{64}$/i),
  signature: z.string().regex(/^[0-9a-f]{128}$/i),
});

export type InvitePayload = z.infer<typeof invitePayloadSchema>;

export interface ParsedInvite {
  payload: InvitePayload;
  raw: string; // the original ic://join/... string
  token: string; // base64url(JSON) — DB lookup key (everything after ic://join/)
}

/** Canonical invite bytes — must match broker's canonicalInvite(). */
export function canonicalInvite(p: {
  v: number;
  mesh_id: string;
  mesh_slug: string;
  broker_url: string;
  expires_at: number;
  mesh_root_key: string;
  role: "admin" | "member";
  owner_pubkey: string;
}): string {
  return `${p.v}|${p.mesh_id}|${p.mesh_slug}|${p.broker_url}|${p.expires_at}|${p.mesh_root_key}|${p.role}|${p.owner_pubkey}`;
}

/**
 * Extract the raw base64url token from any accepted invite input.
 *
 * Accepts three formats:
 *   - `ic://join/<token>`             (dev-era scheme, still supported)
 *   - `https://claudemesh.com/join/<token>` (clickable landing page)
 *   - `https://claudemesh.com/<locale>/join/<token>` (i18n prefix)
 *   - `<token>` (raw base64url, last resort)
 */
export function extractInviteToken(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("ic://join/")) {
    const token = trimmed.slice("ic://join/".length).replace(/\/$/, "");
    if (!token) throw new Error("invite link has no payload");
    return token;
  }
  const httpsMatch = trimmed.match(
    /^https?:\/\/[^/]+(?:\/[a-z]{2})?\/join\/([A-Za-z0-9_-]+)\/?$/,
  );
  if (httpsMatch) return httpsMatch[1]!;
  // Last resort: treat as raw base64url token.
  if (/^[A-Za-z0-9_-]+$/.test(trimmed) && trimmed.length > 20) {
    return trimmed;
  }
  throw new Error(
    `invalid invite format. Expected one of:\n` +
      `  https://claudemesh.com/join/<token>\n` +
      `  ic://join/<token>\n` +
      `  <raw-token>\n` +
      `Got: "${input.slice(0, 40)}${input.length > 40 ? "…" : ""}"`,
  );
}

export async function parseInviteLink(link: string): Promise<ParsedInvite> {
  const encoded = extractInviteToken(link);

  let json: string;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf-8");
  } catch (e) {
    throw new Error(
      `invite link base64 decode failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `invite link JSON parse failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  const parsed = invitePayloadSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(
      `invite link shape invalid: ${parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`,
    );
  }

  // Expiry check (unix seconds).
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (parsed.data.expires_at < nowSeconds) {
    throw new Error(
      `invite expired: expires_at=${parsed.data.expires_at}, now=${nowSeconds}`,
    );
  }

  // Verify the ed25519 signature against the embedded owner_pubkey.
  // Client-side verification gives immediate feedback on tampered
  // links; broker re-verifies authoritatively on /join.
  const s = await ensureSodium();
  const canonical = canonicalInvite({
    v: parsed.data.v,
    mesh_id: parsed.data.mesh_id,
    mesh_slug: parsed.data.mesh_slug,
    broker_url: parsed.data.broker_url,
    expires_at: parsed.data.expires_at,
    mesh_root_key: parsed.data.mesh_root_key,
    role: parsed.data.role,
    owner_pubkey: parsed.data.owner_pubkey,
  });
  const sigOk = (() => {
    try {
      return s.crypto_sign_verify_detached(
        s.from_hex(parsed.data.signature),
        s.from_string(canonical),
        s.from_hex(parsed.data.owner_pubkey),
      );
    } catch {
      return false;
    }
  })();
  if (!sigOk) {
    throw new Error("invite signature invalid (link tampered?)");
  }

  return { payload: parsed.data, raw: link, token: encoded };
}

/**
 * Encode a payload back to an `ic://join/...` link. Used for testing
 * + for building links server-side once we add that flow.
 */
export function encodeInviteLink(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, "utf-8").toString("base64url");
  return `ic://join/${encoded}`;
}

/**
 * Sign and assemble an invite payload → ic://join/... link.
 * The canonical bytes (everything except signature) are signed with
 * the mesh owner's ed25519 secret key.
 */
export async function buildSignedInvite(args: {
  v: 1;
  mesh_id: string;
  mesh_slug: string;
  broker_url: string;
  expires_at: number;
  mesh_root_key: string;
  role: "admin" | "member";
  owner_pubkey: string;
  owner_secret_key: string;
}): Promise<{ link: string; token: string; payload: InvitePayload }> {
  const s = await ensureSodium();
  const canonical = canonicalInvite({
    v: args.v,
    mesh_id: args.mesh_id,
    mesh_slug: args.mesh_slug,
    broker_url: args.broker_url,
    expires_at: args.expires_at,
    mesh_root_key: args.mesh_root_key,
    role: args.role,
    owner_pubkey: args.owner_pubkey,
  });
  const signature = s.to_hex(
    s.crypto_sign_detached(
      s.from_string(canonical),
      s.from_hex(args.owner_secret_key),
    ),
  );
  const payload: InvitePayload = {
    v: args.v,
    mesh_id: args.mesh_id,
    mesh_slug: args.mesh_slug,
    broker_url: args.broker_url,
    expires_at: args.expires_at,
    mesh_root_key: args.mesh_root_key,
    role: args.role,
    owner_pubkey: args.owner_pubkey,
    signature,
  };
  const json = JSON.stringify(payload);
  const token = Buffer.from(json, "utf-8").toString("base64url");
  return { link: `ic://join/${token}`, token, payload };
}
