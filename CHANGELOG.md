# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Bang & Olufsen products of the Mozart platform (Beosound, Beolab,
  Beoconnect Core, the sound of a Beovision with a Beosound Theatre) over
  their official local API, without any cloud: added by IP address, or found
  with an optional mDNS search through Gladys, and kept by their serial
  number when their address changes. Older BeoLink products are not
  supported, and an address where one answers is named in the status.
- Volume (0 to 100, validated strictly before anything is sent, lowered to a
  configurable cap, 70 by default), mute (each press reads the mute from the
  product and sets the opposite), play, pause, next, previous, playback
  state, a "Source" dropdown read and set (enabled and playable sources),
  the title playing, and a standby button. Every command is answered to
  Gladys within 5 seconds, or dropped, never sent late.
- Live states through the WebSocket notifications of each product (volume,
  playback, title, power, source), merged to one publication per second at
  most, reopened at spaced intervals when lost; the whole state is also read
  at the refresh interval (30 seconds by default).
- A product off or unreachable shows its power at 0 and is named in the
  integration status; it is asked again at spaced intervals (5 minutes at
  most). Answers and notifications are read with a 64 KB limit and only the
  expected fields are kept.
- "Find the products" and "Check the products" buttons.

### Fixed

- Unmuting a product whose volume is above the cap lowers the volume to the
  cap first (or does not unmute, "nothing sent"); play and a source change
  lower a known volume above the cap first.
- Pause, mute and standby go before the volume changes still waiting, which
  are merged into the last one.
- The reads after a command or a device update are never faster than the
  refresh interval; the spacing of the reads restarts when a product
  changes address; two starts never run at once.
- Standby on a product that does not answer says "does not answer: nothing
  sent"; the body of a command answer is ignored.

### Security

- The notification channel refuses a message of more than 1024 frames
  (empty fragments made the memory grow without limit), answers one pong
  per batch of pings and drops a peer that does not read past 64 KB.
- The handshake requires `Connection: Upgrade`, refuses a subprotocol not
  asked for and is read in linear time; text messages must be valid UTF-8;
  a 1-byte or reserved close code is answered 1002, never echoed, and the
  close frame is flushed before the end.

[Unreleased]: https://github.com/LM1LC3N7/gladys-bang-olufsen/commits/main
