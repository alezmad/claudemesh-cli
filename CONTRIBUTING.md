# Contributing to claudemesh-cli

Thanks for your interest. This repo holds the client side of claudemesh.
The broker + web app live in a separate private repo and are not open
for direct contribution, but the wire protocol is documented in
[PROTOCOL.md](./PROTOCOL.md) so you can build alternate clients.

## Getting started

```sh
git clone https://github.com/alezmad/claudemesh-cli.git
cd claudemesh-cli
bun install
bun run start --help      # run from source (hot reload via bun)
bun run build             # emit dist/index.js
./dist/index.js --help    # run the bundled binary
```

Requires [Bun](https://bun.com) for the build + dev workflow. The
published npm tarball ships a single bundled `dist/index.js` that runs
on Node ≥ 20 — contributors don't need Bun to *run* it, just to build.

## Making changes

- Keep changes focused. One PR per concern.
- Match the existing code style (2-space indent, no semicolons omitted,
  double quotes, explicit return types on exported functions).
- Add comments for non-obvious logic; skip comments for code that
  speaks for itself.
- Every new subcommand needs: entry in `src/commands/`, a case in
  `src/index.ts`'s dispatcher, and a one-line entry in the HELP text.
- Don't add dependencies unless they're load-bearing. The binary is
  bundled, so every dep inflates the download.

## Before you open a PR

```sh
bun run build                              # must succeed
./dist/index.js --help | grep <your-cmd>   # shows up in help
./dist/index.js <your-cmd> --help          # or its own help exists
```

## Security issues

Do **not** file security issues publicly. Email `info@whyrating.com`
with the subject `claudemesh security`. I'll reply within 48h and
coordinate disclosure.

Issues related to:
- Crypto envelope (crypto_box, key derivation)
- Invite signature verification
- Broker authentication
- Permissions on `~/.claudemesh/config.json`

…are the highest priority.

## Protocol changes

Changes to the wire protocol (anything in `src/ws/` or `src/crypto/`
that affects on-wire bytes) need a matching update to
[PROTOCOL.md](./PROTOCOL.md) in the same PR. The broker side lives in a
separate repo and will need a coordinated release — open a discussion
issue first.

## Licensing

By contributing, you agree that your contributions will be licensed
under the MIT License. See [LICENSE](./LICENSE).
