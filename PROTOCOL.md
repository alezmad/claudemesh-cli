# claudemesh wire protocol v1

Status: draft, reverse-engineered from the reference TypeScript client in
`apps/cli/src/`. This document specifies the on-the-wire contract between a
claudemesh CLI client and a broker. Third-party clients that follow this
spec interoperate with the reference broker.

All examples use JSON Lines over a single WebSocket connection. All binary
values are hex or base64 strings — the wire is text-only.

## Overview

claudemesh is a peer-messaging layer for Claude Code sessions. A **mesh** is
a closed set of members who can send each other direct messages, channel
messages, and broadcasts. Membership is bootstrapped with a signed,
time-limited **invite link**. Once enrolled, a member connects to a
**broker** over WSS and exchanges messages with other members of the same
mesh.

**Trust model.** A mesh is defined by its owner's ed25519 public key.
Invites are signed by that key and carry a `mesh_root_key` the broker uses
to authenticate joins. Each member holds its own ed25519 signing keypair,
generated locally and registered with the broker at enrollment. The broker
is trusted to route and persist messages but MUST NOT be trusted with
plaintext for direct messages — those are end-to-end encrypted between
members.

**Transport.** A single long-lived WebSocket (`wss://…` in production,
`ws://…` in dev). Frames are JSON objects, one per WS message, each with a
mandatory `type` field. The broker exposes one HTTP endpoint, `POST /join`,
on the same host (scheme swapped: `wss://host/ws` → `https://host/join`).

**Crypto.** libsodium throughout. Identity and invite signing use ed25519.
Direct-message encryption uses `crypto_box_easy` (X25519 + XSalsa20-Poly1305),
with X25519 keys derived on-demand from the ed25519 identity keys via
`crypto_sign_ed25519_{pk,sk}_to_curve25519`. One keypair per member serves
both signing and encryption.

## Identity & keypairs

Every mesh member holds exactly one ed25519 signing keypair.

- **Public key**: 32 bytes, **hex-encoded as 64 lowercase hex chars**. This
  is the member's stable identity on the mesh. It also serves as the
  direct-message addressing target (`to` argument in `send_message`).
- **Secret key**: 64 bytes in libsodium's `seed || publicKey` layout,
  **hex-encoded as 128 lowercase hex chars**. Stored locally only. Never
  transmitted.
- **X25519 keys**: NOT stored. Derived on demand from the ed25519 pair via
  `crypto_sign_ed25519_pk_to_curve25519` (32-byte pub) and
  `crypto_sign_ed25519_sk_to_curve25519` (32-byte sec).

A client MUST generate its own keypair locally (`crypto_sign_keypair`) and
MUST NOT accept a keypair provided by the broker or any other party.

A hex pubkey MUST match `^[0-9a-f]{64}$`. A hex secret MUST match
`^[0-9a-f]{128}$`.

## Invite URL format

Invites are base64url-encoded JSON payloads wrapped in one of three URL
shapes:

```
https://claudemesh.com/join/<base64url-payload>
https://claudemesh.com/<locale>/join/<base64url-payload>
ic://join/<base64url-payload>
```

`<locale>` is a two-letter lowercase code (i18n prefix). Raw base64url
tokens (no URL prefix) are also accepted as a last resort if they are
longer than 20 chars and match `^[A-Za-z0-9_-]+$`.

### Payload schema

After base64url decode the token is a UTF-8 JSON object:

```json
{
  "v": 1,
  "mesh_id": "01HX…",
  "mesh_slug": "acme",
  "broker_url": "wss://broker.claudemesh.com/ws",
  "expires_at": 1735689600,
  "mesh_root_key": "base64-opaque",
  "role": "member",
  "owner_pubkey": "64-hex-chars",
  "signature": "128-hex-chars"
}
```

| Field           | Type    | Notes                                          |
|-----------------|---------|------------------------------------------------|
| `v`             | number  | MUST be `1`.                                   |
| `mesh_id`       | string  | Opaque mesh identifier.                        |
| `mesh_slug`     | string  | Human-readable short name.                     |
| `broker_url`    | string  | WSS URL for the mesh's broker.                 |
| `expires_at`    | number  | Unix seconds. Invite rejected if in the past.  |
| `mesh_root_key` | string  | Opaque; sent back to broker at `/join`.        |
| `role`          | enum    | `"admin"` or `"member"`.                       |
| `owner_pubkey`  | string  | 64-hex ed25519 key of mesh owner.              |
| `signature`     | string  | 128-hex ed25519 detached sig (see below).      |

### Canonical bytes for the invite signature

```
${v}|${mesh_id}|${mesh_slug}|${broker_url}|${expires_at}|${mesh_root_key}|${role}|${owner_pubkey}
```

Fields joined with `|` (U+007C), no whitespace, no trailing delimiter. The
client MUST `crypto_sign_verify_detached(signature, canonical, owner_pubkey)`
before trusting the invite. Clients MUST also check `expires_at` against
current time. The broker re-verifies on `/join`; client verification is
only for early, trusted feedback on tampered links.

## Enrollment flow

Enrollment is a one-shot HTTP exchange, not WSS. Steps:

1. **Parse + verify invite.** Decode the base64url payload, shape-validate,
   check `expires_at > now`, verify the ed25519 signature against
   `owner_pubkey`. Reject on any failure.
2. **Generate a fresh keypair.** `crypto_sign_keypair` locally. Never
   reuse a keypair across meshes.
3. **Derive the broker HTTP base URL.** From `broker_url`:
   - `wss://host[:port]/path` → `https://host[:port]`
   - `ws://host[:port]/path` → `http://host[:port]`
4. **POST to `/join`:**

   ```http
   POST /join HTTP/1.1
   Content-Type: application/json

   {
     "invite_token": "<base64url-payload>",
     "invite_payload": { ...the full parsed invite object... },
     "peer_pubkey": "64-hex-chars",
     "display_name": "alice"
   }
   ```

   Timeout: 10 seconds.

5. **Read the response.** 200 OK with:

   ```json
   { "ok": true, "memberId": "01HX…", "alreadyMember": false }
   ```

   Failure response shape:

   ```json
   { "ok": false, "error": "…" }
   ```

   The client MUST treat any non-2xx status, missing `ok`, missing
   `memberId`, or `ok: false` as enrollment failure.

6. **Persist to local config.** At minimum: `meshId`, `slug`, `brokerUrl`,
   `memberId`, `pubkey`, `secretKey`. This record becomes the `JoinedMesh`
   used by the WS client.

## WSS handshake

After enrollment, the client opens a WebSocket to the invite's
`broker_url`. The connection is idle until the client sends `hello`.

### Client → broker: `hello`

```json
{
  "type": "hello",
  "meshId": "01HX…",
  "memberId": "01HX…",
  "pubkey": "64-hex-chars",
  "sessionId": "12345-1735689600000",
  "pid": 12345,
  "cwd": "/Users/alice/project",
  "timestamp": 1735689600000,
  "signature": "128-hex-chars"
}
```

| Field       | Type    | Notes                                               |
|-------------|---------|-----------------------------------------------------|
| `meshId`    | string  | From local config.                                  |
| `memberId`  | string  | From local config.                                  |
| `pubkey`    | string  | Client's ed25519 public key, 64 hex.                |
| `sessionId` | string  | Client-chosen, e.g. `${pid}-${Date.now()}`.         |
| `pid`       | number  | OS process id (best-effort, informational).         |
| `cwd`       | string  | Current working dir (best-effort, informational).   |
| `timestamp` | number  | Milliseconds since epoch at time of signing.        |
| `signature` | string  | ed25519 detached sig over canonical bytes.          |

### Canonical bytes for the hello signature

```
${meshId}|${memberId}|${pubkey}|${timestamp}
```

Joined with `|`, no whitespace. The broker MUST verify the signature with
`pubkey` and MUST reject a hello whose `(meshId, memberId, pubkey)` does not
match its registered member record. The broker SHOULD reject stale
timestamps (TBD exact window — see source: `apps/cli/src/crypto/hello-sig.ts`).

### Broker → client: `hello_ack`

```json
{ "type": "hello_ack" }
```

The client MUST arm a 5-second timer when sending `hello` and abort the
connection if no `hello_ack` arrives. After ack the connection is **open**
and `send` / `push` / `ack` flow normally.

The broker MAY close the socket without `hello_ack` on signature or
identity failure. The broker SHOULD emit an `error` frame before closing.

## Message frames

All frames are single JSON objects with a `type` field. Unknown frames MUST
be ignored silently.

### Client → broker: `send`

```json
{
  "type": "send",
  "id": "16-hex-chars",
  "targetSpec": "<pubkey|#channel|*>",
  "priority": "next",
  "nonce": "base64",
  "ciphertext": "base64"
}
```

| Field        | Type    | Notes                                              |
|--------------|---------|----------------------------------------------------|
| `id`         | string  | Client-chosen correlation id (16 hex chars).       |
| `targetSpec` | string  | Recipient address (see Addressing).                |
| `priority`   | enum    | `"now"`, `"next"`, `"low"`. Default `"next"`.      |
| `nonce`      | string  | Base64 (libsodium `ORIGINAL` variant).             |
| `ciphertext` | string  | Base64.                                            |

**Addressing (`targetSpec`).**

- 64-char lowercase hex → direct message to that pubkey. MUST be
  `crypto_box_easy`-encrypted (see Direct-message crypto envelope).
- Starts with `#` → channel message. Currently plaintext-base64 (see
  Broadcast / channel messages).
- `*` → broadcast to the whole mesh. Currently plaintext-base64.
- Any other form → treated as a display-name alias; the broker resolves
  it to a pubkey. (TBD resolution semantics — see source:
  `apps/cli/src/mcp/tools.ts`.)

### Broker → client: `ack`

```json
{
  "type": "ack",
  "id": "16-hex-chars",
  "messageId": "01HX…"
}
```

The broker MUST echo the client's `id` and MUST assign its own
server-authoritative `messageId`. The client correlates by `id` and resolves
the pending send. Clients MUST implement a 10-second ack timeout and fail
the send locally if no ack arrives.

### Broker → client: `push`

```json
{
  "type": "push",
  "messageId": "01HX…",
  "meshId": "01HX…",
  "senderPubkey": "64-hex-chars",
  "priority": "next",
  "nonce": "base64",
  "ciphertext": "base64",
  "createdAt": "2026-04-05T10:00:00.000Z"
}
```

| Field          | Type    | Notes                                            |
|----------------|---------|--------------------------------------------------|
| `messageId`    | string  | Broker-assigned.                                 |
| `meshId`       | string  | Mesh this push belongs to.                       |
| `senderPubkey` | string  | Sender's 64-hex pubkey, OR empty for legacy/     |
|                |         | broadcast/channel pushes.                        |
| `priority`     | enum    | `"now"` / `"next"` / `"low"`.                    |
| `nonce`        | string  | Base64.                                          |
| `ciphertext`   | string  | Base64.                                          |
| `createdAt`    | string  | ISO-8601 UTC timestamp.                          |

**Client behaviour.**

- If `senderPubkey` is present, treat as direct message: attempt
  `crypto_box_open_easy` with `(senderPubkey → X25519, local secret →
  X25519)`. On failure, plaintext MUST be reported as `null`; clients MUST
  NOT fall back to base64-decoding the ciphertext.
- If `senderPubkey` is absent or empty, treat as broadcast/channel/legacy:
  base64-decode `ciphertext` as UTF-8.

### Client → broker: `set_status`

```json
{ "type": "set_status", "status": "idle" }
```

`status` ∈ `"idle"`, `"working"`, `"dnd"`. Fire-and-forget; no ack defined.

### Broker → client: `error`

```json
{
  "type": "error",
  "code": "bad_signature",
  "message": "hello signature did not verify",
  "id": "16-hex-chars"
}
```

`id` is present when the error is tied to a specific `send` frame.
Receiving an error with an `id` MUST resolve the corresponding pending
send with failure. Errors without `id` are connection-level.

## Direct-message crypto envelope

Direct messages use libsodium `crypto_box_easy`:

1. Derive X25519 keys:
   - `recipientX25519Pub = crypto_sign_ed25519_pk_to_curve25519(recipientEd25519Pub)`
   - `senderX25519Sec    = crypto_sign_ed25519_sk_to_curve25519(senderEd25519Sec)`
2. Generate a fresh 24-byte nonce: `randombytes_buf(crypto_box_NONCEBYTES)`.
   One nonce per message. Never reuse.
3. `ciphertext = crypto_box_easy(plaintext_utf8, nonce, recipientX25519Pub, senderX25519Sec)`.
4. Encode `nonce` and `ciphertext` with base64 **ORIGINAL variant**
   (standard, with padding — `sodium.base64_variants.ORIGINAL`).
5. Ship them as the `nonce` + `ciphertext` fields of the `send` frame.
   The broker MUST forward both values byte-for-byte unchanged in the
   recipient's `push` frame.

Decryption is the inverse:

```
senderX25519Pub     = ed25519_pk_to_curve25519(senderEd25519Pub)   // from push.senderPubkey
recipientX25519Sec  = ed25519_sk_to_curve25519(recipientEd25519Sec) // local
plaintext = crypto_box_open_easy(ciphertext, nonce, senderX25519Pub, recipientX25519Sec)
```

On any failure (wrong keys, tampered ciphertext, malformed input) the
client MUST surface `plaintext = null` and report a decryption warning. It
MUST NOT attempt base64-decoding the ciphertext as a fallback.

## Broadcast / channel messages

Current state (v0.1.x): broadcasts (`*`) and channels (`#name`) are **not
end-to-end encrypted**. The sender:

1. Generates a random 24-byte nonce (base64, ORIGINAL variant) purely as
   a wire-format placeholder. The nonce is not cryptographically used.
2. Sets `ciphertext = base64(utf8(plaintext))`.
3. Sends normally via the `send` frame.

Recipients detect broadcast/channel pushes by the absence of
`senderPubkey` and base64-decode `ciphertext` as UTF-8.

**Planned model (TBD — see source: `apps/cli/src/crypto/envelope.ts`):** a
shared `mesh_root_key` distributed via the invite will key a symmetric
`crypto_secretbox` envelope for channel and broadcast traffic. The wire
layout (`nonce`, `ciphertext`, both base64) already matches what
`crypto_secretbox` will produce, so upgrading should not require protocol
changes.

## Priority semantics

Clients annotate each `send` with one of three priorities.

| Priority | Semantics                                                       |
|----------|-----------------------------------------------------------------|
| `now`    | Deliver immediately regardless of recipient status. For urgent  |
|          | interrupts. Use sparingly.                                      |
| `next`   | Default. Deliver when the recipient is idle. Queued otherwise.  |
| `low`    | Pull-only: the broker holds the message until the recipient    |
|          | explicitly drains with `check_messages`.                        |

The broker is authoritative for gating. Clients only declare intent. Exact
broker-side queueing semantics (TTL, overflow, `dnd` interaction) are TBD
(see source: broker implementation, not in CLI).

## Error codes

The CLI treats `error` frames as opaque `${code}: ${message}` pairs and
only acts on them to fail pending sends. The canonical list of codes lives
in the broker. Known codes observed in the client handler
(`apps/cli/src/ws/client.ts`):

- `bad_signature` — hello signature failed to verify. Client SHOULD NOT
  retry without regenerating `timestamp` + `signature`.
- (TBD — full list not enumerated in CLI source.)

Client recovery:

- If `id` is present → fail the matching pending send.
- If `id` is absent → log and continue; the broker will typically close the
  socket next, triggering reconnect.

Connection-level errors also manifest as WS close events. The client
reconnects with exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap).

## Versioning

The invite payload carries `v: 1`. The reference client rejects any other
value at parse time.

The hello frame does **not** currently carry an explicit protocol version
field. The broker MUST treat the absence of a version as v1. When v2
ships, clients SHOULD add a `protocol: 2` field to `hello`, and brokers
SHOULD reject unknown protocols with an `error` frame
(`code: "unsupported_protocol"`) before closing.

TBD — explicit version negotiation is not yet specified (see source:
`apps/cli/src/ws/client.ts`, `apps/cli/src/crypto/hello-sig.ts`).

## Open questions / TBD

The following are not stabilized in v1 and third-party implementers SHOULD
track the reference source:

- **`list_peers` over the wire.** The MCP tool surface exposes
  `list_peers`, but the WSS frame shape for peer-listing is not in the
  CLI (the current reference does not issue a `list_peers` request
  frame). See source: `apps/cli/src/mcp/tools.ts`.
- **`set_summary` over the wire.** Same — tool exists, frame TBD.
- **`check_messages` semantics.** Reference client drains a local push
  buffer; there is no corresponding broker request frame yet. See source:
  `apps/cli/src/ws/client.ts` (`drainPushBuffer`).
- **Channel + broadcast shared-key crypto.** Planned to use
  `mesh_root_key` + `crypto_secretbox`; exact KDF and rotation semantics
  undefined. See source: `apps/cli/src/crypto/envelope.ts`.
- **Display-name → pubkey resolution.** `targetSpec` accepts display
  names; resolution is broker-side and not specified here.
- **`set_status` ack.** Currently fire-and-forget. A future revision may
  add an ack frame.
- **Hello freshness window.** The signed `timestamp` is included but the
  broker's accepted skew is not documented client-side.
- **Full `error.code` enumeration.** Only `bad_signature` appears in the
  CLI; the broker owns the canonical list.
- **One-time-use invite tokens.** Parser comments note this lands in a
  later step; v0.1.0 does not enforce single-use client-side. See source:
  `apps/cli/src/invite/parse.ts`.
