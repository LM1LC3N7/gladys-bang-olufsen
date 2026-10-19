# TODO — Bang & Olufsen v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-19): products added by IP
      address or found by mDNS (`scanNetwork('mdns')`, optional), identity by
      the serial number of the Beolink id; power state, standby, volume
      (capped), mute, play/pause/next/previous, playback state, source
      dropdown, title; live notifications over WebSocket; spaced retries for
      a product that does not answer; "Find" and "Check" buttons; docs en/fr.
      Tested against a fake product on the loopback interface only, never
      with a real product. The store validator was not run by the
      development agent (it cannot run it): to run from the real terminal.
- [ ] **Milestone 2 — real products** (testers with a Mozart product): record
      real answers and notifications as fixtures, fix what differs. To check
      first:
  - the port and TXT records of `_bangolufsen._tcp` as relayed by Gladys
    (today the REST API is always asked on port 80 for a product found by
    mDNS);
  - what `GET /api/v1/state` holds in standby and network standby, and
    whether the WebSocket stays open then;
  - the source ids of each product family (Beosound Theatre: `tv`, HDMI
    inputs?), and whether `isPlayable` is reliable;
  - the notifications sent while the volume knob turns (rate), and those of
    a product following another one in a Beolink session;
  - the answer of a pre-Mozart product to `GET /api/v1/beolink/self`
    (assumed: no answer on port 80 or a 404, shown as "not a Mozart
    product");
  - the rendering on the Gladys dashboard (not checked: no Gladys front
    here): the `music` buttons (min = max = 1, as the core Sonos service),
    the `television/volume-mute` press with its state, the `button/push`
    Standby, the `unknown/binary` power, the `text/select` Source and the
    `text/text` title.
- [ ] **Milestone 3 — more**: Beolink multiroom (join, expand, leave), sound
      settings (bass, treble, loudness, listening modes), presets, overlay
      announcements (`/api/v1/overlay/play`), volume up/down buttons, a
      "forget a product" action, the model name from the Beolink type number.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: mozart-api 6.2.0.44.2 (MIT, published by Bang & Olufsen,
  <https://github.com/bang-olufsen/mozart-open-api>) is an OpenAPI document
  plus a generated Python client (aiohttp). Only what this integration needs
  is ported to JavaScript (`src/mozart/`): the endpoints `beolink/self`,
  `state`, `playback/sources`, `sound/volume`, `sound/volume/level`,
  `sound/volume/mute`, `playback/command/{play,pause,skip,prev}`,
  `playback/sources/active/{id}`, `state/standby`, the Beolink id check
  (serial number = its third part) and the notification channel
  (`ws://<ip>:9339/`, `WebSocketEventVolume`, `PlaybackState`,
  `PlaybackMetadata`, `PowerState`, `SourceChange`, `PlaybackSource`). The
  generated client is not ported. MIT notice in `THIRD_PARTY_NOTICES.md`,
  copied into the image. No runtime dependency besides the SDK: node:http
  and a minimal WebSocket client over node:net (Node 22's global WebSocket
  cannot bound the size of a message before it is buffered).
- Mozart products only. Older BeoLink products (Beoplay, BeoSound Core,
  Essence, BeoSound 35, Beovision without a Mozart product, ASE platform)
  have another API and are not supported: an address that answers HTTP but
  not `beolink/self` with a valid Beolink id is named in the status ("older
  BeoLink products are not supported") and never added. Said in the docs,
  the manifest and the README.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('product', <serial number>)`, never the
  address. Feature keys are frozen: `power`, `standby`, `volume`, `mute`,
  `play`, `pause`, `next`, `previous`, `playback`, `source`, `title`. Every
  publication carries the full, fixed feature list (a device published again
  never loses a feature); only the source options grow.
- **Volume cap** (`max_volume`, 1..100, 70 by default, the brief's "volume
  plafonné par option"): a volume above it is lowered to it, not refused (a
  scene asking 100 still gets a sound, and the log says it was lowered).
  The cap is read from the configuration inside the command queue, just
  before the request, so a cap lowered while a command waited applies to it.
  An unreadable value falls back to 70, never to "no cap". 100 removes it.
  It does not touch the product's own maximum volume setting (no persistent
  change of the product).
- **Power: read-only state + `button/push` "Standby", not a `switch`.** The
  API has no "power on" (`PUT /state/standby` only): a switch would offer an
  "on" that cannot work, and an "everything off" (voice assistants,
  `switch.*` scenes) would put the products in standby. The power state is
  `unknown/binary`, read only: 1 `on`, 0 `standby`, `networkStandby`,
  `shutdown`, `storage`, or nothing accepts the connection. Standby on a
  product that does not answer sends nothing and fails with "does not
  answer: nothing sent" (review, minor 8). Standby is
  not a sensitive command (no physical risk): no option to enable it.
- Categories and types from the core only (`server/utils/constants.js`):
  `music` for volume, play, pause, next, previous and playback state (as the
  core Sonos service), `television/volume-mute` for mute (music has no mute
  type), `text/select` and `text/text`, `button/push`, `unknown/binary`. No
  unit: `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none for music, television,
  text, button or unknown. Store category `multimedia`.
- Mute is a push (Gladys sends a press, not a target): the mute is read from
  the product just before (`GET /sound/volume`, 1.5 s at most) and the
  opposite is sent as an explicit `{ "muted": bool }`, never a toggle.
  Unknown mute state: nothing sent. Not a switch: an "everything off" would
  unmute.
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Source: the select values are the Mozart source ids (`spotify`, `lineIn`,
  `netRadio`…), labels their names; only enabled and playable sources are
  added; the options are kept in `/data` and only grow (merged with the
  `supported_options` of the created device). A command is checked against
  the options, then against the live list read again (enabled and playable),
  and sent URL-encoded.
- Notifications: one WebSocket per created product that answers REST. Own
  RFC 6455 client: no TLS, no extension, no User-Agent or Origin (nothing
  imitates a browser), handshake answer bounded to 8 KB and its accept key
  checked, every message bounded to 64 KB (fragments included), masked or
  reserved-bit server frames refused, bytes kept as a chunk list (linear for
  a peer sending one byte at a time). Pings every 20 s, closed after 50 s of
  silence. Reopened after 5 s, doubled each time up to 5 minutes (reset only
  after a channel stayed open 5 minutes); never reopened for a product that
  does not answer REST, nor after stop(). 50 notifications per second and
  product at most, the rest dropped (the polling still reads). Notified
  states are merged, one `publishChangedStates` per product per second at
  most (the core takes 300 states per minute).
- Reachability: a refused connection, no route or a connection never
  accepted is "off or unreachable": power 0, named in the status message,
  read again after the interval doubled each time (5 minutes at most), never
  faster than the interval; a start or configuration save skips the backoff,
  not the interval. A connection accepted then silent, an HTTP error or an
  unreadable answer is unknown (nothing published), spaced like no answer
  for HTTP errors and unreadable answers. When a product answers again, the
  serial at its address is read first: another product there clears the
  address (DHCP), never commanded there; while a created product has no
  address, a search runs by itself every 10 minutes. The status stays
  "connected" (local integration, no account).
- No secret: the Mozart API has no authentication, the integration asks for
  no password and keeps none. HTTP error bodies (`ErrorModel`) are never
  shown, only the status code.
- Commands: serialized per product, budget 3.5 s from the Gladys request (the
  wait in the queue included), each request bounded by what is left; a
  command still queued at its deadline is dropped, never sent late. A
  request that may have reached the product (connected then silent) is
  answered "sent, without confirmation" and the state read again once due (see the review fixes);
  a product that does not accept the connection gets "nothing sent". The
  states a command implies are published in the background (the ack never
  waits for Gladys).
- Hostile answers: 64 KB read at most, `JSON.parse` once, only the expected
  fields of the expected types kept, strings cleaned (control and bidi
  characters) and cut (200 characters for the title, 64 for names), ids kept
  only when they are plain identifiers (`__proto__`, `constructor`,
  `prototype` refused), product table without prototype, 32 sources at most,
  20 products at most, 50 mDNS results at most. No redirect followed.
- On every (re)connection to Gladys: the status cache is cleared and
  `forgetPublishedStates()` called, then the devices (Discovery), the last
  readings and the status published again and the products read. The
  spacing of the reads is kept across reconnections.
- Polling 10 s to 300 s (default 30 s, the notifications carry the changes),
  own timer (`should_poll: false`): only the created products; identity and
  source list read again every 10 minutes.
- Text features show "—" when nothing plays.
- mDNS: the REST API is asked on port 80 for a product found by mDNS (the
  port the mozart-api client uses), whatever port the announcement carries.

### Review fixes (2026-10-19)

- B1: a message counts its frames too: more than `MAX_FRAGMENTS` (1024),
  empty continuations included, closes with 1009.
- I1: one pong per batch of pings read (the last ping); a channel whose send
  buffer (`writableLength`) passes 64 KB is dropped ("peer not reading").
- I2: unmuting reads the level with the mute state; above the cap (read at
  that moment) `setVolume(cap)` is sent first within the command budget, the
  unmute only if it succeeded; a level unknown with a cap below 100: nothing
  sent. Play and a source change lower the last known level (reading or
  notification) to the cap first: it may be a few seconds old (said in the
  docs).
- Handshake: `Connection` must hold the `upgrade` token, a
  `Sec-WebSocket-Protocol` is refused, the end is searched in the new bytes
  only (linear); text decoded with `TextDecoder` fatal (1007 otherwise).
- Close: empty or valid code answered 1000, a 1-byte payload or a reserved
  code answered 1002 (never echoed); the close frame is flushed with
  `socket.end()`, the socket destroyed one second later at most.
- Command answers (PUT, POST): only the status counts, the body is ignored.
- Queue per product: pause, mute and standby go before the volumes waiting;
  a volume waiting is replaced by the newer one, both commands get the
  result of the one sent.
- Reads after a command (recheck) and device updates go through `isDue`
  (backoff skipped, interval kept): a recheck not due is planned once for
  when it is, then dropped if still not due. This replaces the "re-read 2 s
  later" of the first version: the notifications carry the change at once.
- The spacing of the reads (`attempts`) and the identity timestamp are
  cleared whenever the address of a product changes.
- `start()` never runs twice at once: the starts asked while one runs are
  merged into one (last configuration, "connected" if any was).
- The reading of a deleted device is kept (created again right after: not
  read before the interval).
