# gladys-bang-olufsen

[Gladys Assistant](https://gladysassistant.com) external integration for the
recent **Bang & Olufsen** products of the **Mozart** platform (Beosound,
Beolab, Beoconnect Core, the sound of a Beovision with a Beosound Theatre),
on the local network: volume (capped by an option), mute, source, play,
pause, next, previous, the title playing and standby, through their official
local API (REST `http://<ip>/api/v1/...` and WebSocket notifications
`ws://<ip>:9339/`), without any cloud. **Mozart products only**: the older
BeoLink products (Beoplay, BeoSound Core, Essence…) are not supported.
Unofficial, not affiliated with Bang & Olufsen.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake product only,
> never with a real Bang & Olufsen product.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (BangOlufsenApp)
                                   ├─ src/mozart/client.js         REST endpoints used, parsing of untrusted answers
                                   ├─ src/mozart/notifications.js  WebSocketEvent* -> partial readings (pure)
                                   ├─ src/mozart/websocket.js      minimal RFC 6455 client over node:net, bounded
                                   ├─ src/mozart/http.js           node:http, no keep-alive, bounded time and size (64 KB)
                                   ├─ src/model.js                 known products -> Gladys devices and states (pure)
                                   └─ src/store.js                 /data/bang-olufsen.json: known products, their sources
```

- **Products** are added by IP address (configuration), or found with
  `gladys.scanNetwork('mdns')` (service `_bangolufsen._tcp`, optional: a
  failure never blocks; the REST API is then asked on port 80). Each product
  is identified by the serial number of its Beolink id
  (`GET /api/v1/beolink/self`, `<type>.<item>.<serial>@products.bang-olufsen.com`,
  external id `product:<serial>`). An address that answers 404 there (an
  older BeoLink product) is named in the status, never added.
- **Polling** (own timer, 10 to 300 s, 30 by default): `GET /api/v1/state`
  (power, volume, mute, playback state, metadata, active source), and
  `GET /api/v1/playback/sources` every 10 minutes. A refused connection or no
  answer at all means "off or unreachable" (power 0, named in the status),
  then reads spaced out (interval doubled each time, 5 minutes at most).
  Connected then silent, or an unexpected answer: unknown, nothing
  published.
- **Notifications**: one WebSocket per created product that answers
  (`ws://<ip>:9339/`): volume, playback state, metadata, power state and
  source change are applied at once and published merged (one publication
  per product per second at most, `publishChangedStates`). Frames and
  messages bounded (64 KB), 50 notifications per second at most, idle
  channel closed after 50 s (pings every 20 s), reconnection after 5 s
  doubled each time up to 5 minutes.
- **Commands**: validated first (volume an integer 0..100, source among the
  dropdown options), serialized per product, each within a 3.5 s budget
  (Gladys acks in 5 s), dropped when they cannot start in time. The volume
  is lowered to the configured cap (`max_volume`, 70 by default), read again
  just before the request. Mute is a press: the state is read just before
  and an explicit `{ "muted": true|false }` is sent. A source is checked
  again against the live list (enabled and playable). A request that may
  have reached the product is reported "sent, without confirmation" and the
  state read again.
- **Features**: `music` (volume, play, pause, next, previous, playback state)
  like the core Sonos service, `television/volume-mute`, `text/select`
  (source), `text/text` (title), `button/push` (standby) and a read-only
  `unknown/binary` power state. No switch: the API has no "power on".

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake product)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeProduct.js` is a fake Mozart product on 127.0.0.1 (the
endpoints used, the WebSocket channel, plus silent, hostile and legacy
modes). The end-to-end tests run the real handlers against the SDK's fake
Gladys.

## Credits

- [`mozart-api`](https://github.com/bang-olufsen/mozart-open-api) 6.2.0.44.2
  (MIT), the OpenAPI document and Python client published by Bang & Olufsen:
  the endpoints, models and notification channel this integration uses are
  ported from it to JavaScript (not the generated client).
- The Home Assistant Bang & Olufsen integration (Apache-2.0) was consulted
  for the mDNS discovery (service type).
- The app structure follows
  [LM1LC3N7/gladys-devialet](https://github.com/LM1LC3N7/gladys-devialet)
  (same author, Apache-2.0).

Bang & Olufsen, Beosound, Beolab, Beovision, Beoconnect and BeoLink are
trademarks of Bang & Olufsen, used here only to name the compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (mozart-api, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
