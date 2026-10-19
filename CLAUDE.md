# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the Bang & Olufsen products
of the Mozart platform, over their official local API (REST + WebSocket
notifications): a Node.js service (Node 22+, ESM, no build step) that runs in
its own sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template;
the endpoints and models it uses are ported from `mozart-api` (MIT, published
by Bang & Olufsen, see `THIRD_PARTY_NOTICES.md`). Older BeoLink products are
out of scope. Decisions are recorded in `TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "volume"  # tests whose name matches
npm run cover                             # regenerates cover.png
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   every SDK handler -> BangOlufsenApp (shared with the tests)
src/app.js                        products, polling and backoff, notification channels, commands, status
src/mozart/client.js              REST endpoints used, parsing of the untrusted answers
src/mozart/notifications.js       WebSocketEvent* notifications -> partial readings (pure)
src/mozart/websocket.js           minimal RFC 6455 client over node:net, every input bounded
src/mozart/http.js                node:http, bounded time and size, error kinds
src/model.js                      products -> Gladys devices and states (pure)
src/store.js                      /data/bang-olufsen.json
src/constants.js                  frozen keys, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys + fake product (test/fixtures/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here the serial number of the Beolink id), never
  a label. Gladys keys devices, their history, scenes and dashboards on them:
  changing one creates a new device and orphans the old one. The same goes
  for every key users store: manifest `config_schema`, `actions`, feature
  keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **The volume cap** (`max_volume`) is read from the configuration just
  before each volume request; never send a volume above it.
- **No switch** for power or mute: an "everything off" must never command a
  product. Read-only states and push buttons.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action handlers): change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the loopback interface.
