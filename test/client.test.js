// -----------------------------------------------------------------------------
// The parsing of the untrusted answers and notifications of a Mozart product
// (pure), and the requests the client sends (a recording fake request).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/constants.js';
import {
  MozartClient,
  cleanText,
  isSafeId,
  parseSelf,
  parseSources,
  parseState,
  parseVolume,
} from '../src/mozart/client.js';
import { ERROR_KINDS } from '../src/mozart/http.js';
import { parseNotification } from '../src/mozart/notifications.js';

test('the identity comes from a valid Beolink id only', () => {
  assert.deepEqual(
    parseSelf({ jid: '2714.1200304.26451293@products.bang-olufsen.com', friendlyName: ' Salon ' }),
    { serial: '26451293', typeNumber: '2714', itemNumber: '1200304', name: 'Salon' },
  );
  for (const jid of [
    undefined,
    '',
    '2714.1200304.2645129@products.bang-olufsen.com',
    '2714.1200304.26451293@evil.example',
    '2714.1200304.26451293@products.bang-olufsen.com\n',
    ['2714.1200304.26451293@products.bang-olufsen.com'],
  ]) {
    assert.throws(() => parseSelf({ jid }), { kind: ERROR_KINDS.PROTOCOL }, String(jid));
  }
});

test('the state: only the expected fields, of the expected types', () => {
  const reading = parseState({
    powerState: { value: 'on' },
    volume: { level: { level: 33.4 }, maximum: { level: 80 }, muted: { muted: false } },
    playback: {
      state: { value: 'started' },
      metadata: { artistName: 'A\u0000rtist', title: 'T'.repeat(500) },
    },
    source: { id: 'spotify', name: 'Spotify' },
  });
  assert.equal(reading.power, true);
  assert.equal(reading.volume, 33);
  assert.equal(reading.maximum, 80);
  assert.equal(reading.muted, false);
  assert.equal(reading.playing, true);
  assert.equal(reading.artist, 'A rtist');
  assert.equal(reading.title.length, LIMITS.title);
  assert.equal(reading.source, 'spotify');

  const odd = parseState({
    powerState: { value: 'exploding' },
    volume: { level: { level: 101 }, muted: { muted: 'yes' } },
    playback: { state: { value: 'buffering' }, source: { id: '__proto__' } },
  });
  assert.deepEqual(
    [odd.power, odd.volume, odd.muted, odd.playing, odd.source],
    [undefined, undefined, undefined, undefined, undefined],
  );
  for (const standby of ['standby', 'networkStandby', 'shutdown', 'storage']) {
    assert.equal(parseState({ powerState: { value: standby } }).power, false);
  }
  assert.throws(() => parseState([]), { kind: ERROR_KINDS.PROTOCOL });
  assert.throws(() => parseState(null), { kind: ERROR_KINDS.PROTOCOL });
});

test('the volume answer', () => {
  assert.deepEqual(parseVolume({ level: { level: 0 }, muted: { muted: true } }), {
    level: 0,
    maximum: undefined,
    muted: true,
  });
  assert.deepEqual(parseVolume('x'), { level: undefined, maximum: undefined, muted: undefined });
});

test('the source list: bounded, each id once, unsafe ids dropped', () => {
  const items = [
    { id: 'spotify', name: 'Spotify', isEnabled: true, isPlayable: true },
    { id: 'spotify', name: 'Again' },
    { id: 'tidal', isEnabled: false },
    { id: 'constructor', name: 'x' },
    { id: 'a/b', name: 'x' },
    { name: 'no id' },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, name: `S${i}` })),
  ];
  const list = parseSources({ items });
  assert.equal(list.length, LIMITS.sources);
  assert.deepEqual(list[0], { id: 'spotify', name: 'Spotify', enabled: true, playable: true });
  assert.deepEqual(list[1], { id: 'tidal', name: 'tidal', enabled: false, playable: true });
  assert.ok(list.every((s) => isSafeId(s.id)));
  assert.deepEqual(parseSources({ items: 'x' }), []);
});

test('cleanText removes control and bidi characters', () => {
  assert.equal(cleanText('a‮b⁦c‏d e', 64), 'a b c d e');
  assert.equal(cleanText('   ', 64), undefined);
  assert.equal(cleanText(42, 64), undefined);
});

test('notifications: the shown events only', () => {
  const n = (eventType, eventData) => parseNotification(JSON.stringify({ eventType, eventData }));
  assert.deepEqual(n('WebSocketEventVolume', { level: { level: 12 } }), { volume: 12 });
  assert.deepEqual(n('WebSocketEventPlaybackState', { value: 'stopped' }), { playing: false });
  assert.deepEqual(n('WebSocketEventPowerState', { value: 'on' }), { power: true });
  assert.deepEqual(n('WebSocketEventSourceChange', { id: 'tv' }), { source: 'tv' });
  assert.deepEqual(n('WebSocketEventPlaybackMetadata', { title: 'X' }), {
    artist: undefined,
    title: 'X',
    metadata: true,
  });
  assert.equal(n('WebSocketEventPlaybackState', { value: 'buffering' }), undefined);
  assert.equal(n('WebSocketEventBattery', { batteryLevel: 3 }), undefined);
  assert.equal(n('__proto__', {}), undefined);
  assert.equal(parseNotification('not json'), undefined);
  assert.equal(parseNotification('[1]'), undefined);
  assert.equal(parseNotification('null'), undefined);
});

test('the client sends what the Mozart API expects', async () => {
  const calls = [];
  const client = new MozartClient({
    host: 'h',
    port: 80,
    request: async (options) => {
      calls.push(options);
      return { status: options.method === 'GET' ? 200 : 201, body: '' };
    },
  });
  await client.setVolume(20);
  await client.setMute(true);
  await client.command('skip');
  await client.setSource('netRadio');
  await client.standby();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path} ${c.body ?? ''}`.trim()),
    [
      'PUT /api/v1/sound/volume/level {"level":20}',
      'PUT /api/v1/sound/volume/mute {"muted":true}',
      'POST /api/v1/playback/command/skip',
      'POST /api/v1/playback/sources/active/netRadio',
      'PUT /api/v1/state/standby',
    ],
  );
  assert.throws(() => client.command('reboot'), { kind: ERROR_KINDS.PROTOCOL });
  assert.throws(() => client.setSource('../state/reboot'), { kind: ERROR_KINDS.PROTOCOL });
});

test('client errors: HTTP status, not JSON, budget', async () => {
  const answer = (status, body) =>
    new MozartClient({ host: 'h', port: 80, request: async () => ({ status, body }) });
  await assert.rejects(answer(404, '{"errorMessage":"secret details"}').describe(), {
    kind: ERROR_KINDS.HTTP,
    message: 'HTTP 404',
  });
  await assert.rejects(answer(200, '<html>').state(), { kind: ERROR_KINDS.PROTOCOL });
  let now = 0;
  const budget = new MozartClient({
    host: 'h',
    port: 80,
    now: () => now,
    request: async () => ({ status: 200, body: '{}' }),
  }).withBudget(100);
  now = 80;
  await assert.rejects(budget.state(), { kind: ERROR_KINDS.BUDGET });
});
