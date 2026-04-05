/**
 * Broker /join HTTP enrollment.
 *
 * Takes a parsed invite + freshly generated keypair, POSTs to the
 * broker, returns the member_id. Converts the broker's WSS URL to
 * HTTPS for the /join call (same host, different protocol).
 */

export interface EnrollResult {
  memberId: string;
  alreadyMember: boolean;
}

function wsToHttp(wsUrl: string): string {
  // wss://host/ws → https://host
  // ws://host:port/ws → http://host:port
  const u = new URL(wsUrl);
  const httpScheme = u.protocol === "wss:" ? "https:" : "http:";
  return `${httpScheme}//${u.host}`;
}

import type { InvitePayload } from "./parse";

export async function enrollWithBroker(args: {
  brokerWsUrl: string;
  inviteToken: string;
  invitePayload: InvitePayload;
  peerPubkey: string;
  displayName: string;
}): Promise<EnrollResult> {
  const base = wsToHttp(args.brokerWsUrl);
  const res = await fetch(`${base}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invite_token: args.inviteToken,
      invite_payload: args.invitePayload,
      peer_pubkey: args.peerPubkey,
      display_name: args.displayName,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    memberId?: string;
    error?: string;
    alreadyMember?: boolean;
  };
  if (!res.ok || !body.ok || !body.memberId) {
    throw new Error(
      `broker /join failed (${res.status}): ${body.error ?? "unknown"}`,
    );
  }
  return {
    memberId: body.memberId,
    alreadyMember: body.alreadyMember ?? false,
  };
}
