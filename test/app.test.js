// -----------------------------------------------------------------------------
// BangOlufsenApp with the SDK's fake Gladys, the exact handlers of the
// container (src/handlers.js), a memory store and the fake product on the
// loopback interface (REST and WebSocket). The polling timer never fires: the
// tests drive it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BangOlufsenApp, parseVolumeCommand } from '../src/app.js';
import { LIMITS, NOTHING, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { request as httpRequest } from '../src/mozart/http.js';
import { SERIAL, serverFrame, startFakeProduct } from './fixtures/fakeProduct.js';

const SELECTOR = 'bang-olufsen';
const id = (key, serial = SERIAL) => `ext:${SELECTOR}:product:${serial}${key ? `:${key}` : ''}`;

/** No polling interval; short real timeouts for the background work. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

async function setup(
  t,
  { productOptions, config, scanResults = {}, timings = {}, clock, request } = {},
) {
  const product = await startFakeProduct(productOptions);
  t.after(() => product.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${product.port}` },
    scanResults,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const store = new MemoryStore();
  const app = new BangOlufsenApp({
    gladys,
    logger,
    store,
    timers,
    websocketPort: product.port,
    scanPort: product.port,
    ...(request ? { request } : {}),
    now: clock ? () => clock.now : Date.now,
    timings: { ...TIMINGS, httpTimeout: 500, recheckDelay: 1, ...timings },
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { product, gladys, app, logs, store };
}

async function createProduct(gladys, serial = SERIAL) {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, serial));
  assert.ok(device, 'the product is in the Discovery tab');
  await gladys.fake.deviceCreated(device);
  return device;
}

const set = (gladys, device, key, value) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) {
      return;
    }
    await settle(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const channelOpen = (app, product) => () =>
  app.channels.get(SERIAL)?.open === true && product.channels.size > 0;

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const { gladys } = await setup(t);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id());
  assert.equal(device.name, 'Living room');
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'standby',
    'volume',
    'mute',
    'play',
    'pause',
    'next',
    'previous',
    'playback',
    'source',
    'title',
  ]);
  assert.ok(device.features.every((f) => f.min !== undefined && f.max !== undefined));
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.equal(byKey.power.read_only, true);
  assert.equal(byKey.power.category, 'unknown');
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.volume.category, byKey.volume.type], ['music', 'volume']);
  assert.equal(byKey.volume.unit, undefined, 'no unit for the music category');
  assert.deepEqual(
    byKey.source.supported_options,
    [
      { value: 'lineIn', label: 'Line-In' },
      { value: 'spotify', label: 'Spotify' },
    ],
    'enabled and playable sources only; an id "__proto__" is never kept',
  );
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createProduct(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(gladys.fake.lastState(id('mute')), 0);
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.equal(gladys.fake.lastState(id('title')), 'Daft Punk - Get Lucky');
  assert.equal(gladys.fake.lastState(id('source')), 'spotify');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal({}.lineIn, undefined, 'Object.prototype untouched');
});

test('volume: set, and validated strictly before anything is sent', async (t) => {
  const { product, gladys } = await setup(t);
  const device = await createProduct(gladys);
  assert.equal((await set(gladys, device, 'volume', 42)).success, true);
  assert.equal(product.state.volume, 42);
  assert.equal(gladys.fake.lastState(id('volume')), 42);
  const write = product.writes().at(-1);
  assert.deepEqual(
    [write.method, write.path, JSON.parse(write.body)],
    ['PUT', '/api/v1/sound/volume/level', { level: 42 }],
  );
  const before = product.writes().length;
  for (const bad of [null, '', ' ', -1, 101, 12.5, '12abc', true, NaN, Infinity, '1e2', {}]) {
    assert.equal((await set(gladys, device, 'volume', bad)).success, false, String(bad));
  }
  assert.equal(product.writes().length, before, 'no invalid volume reached the product');
  assert.equal((await set(gladys, device, 'volume', '0')).success, true);
  assert.equal(product.state.volume, 0);
});

test('volume: capped by the option, read again just before each command', async (t) => {
  const { product, gladys, logs } = await setup(t);
  const device = await createProduct(gladys);
  // Default cap: 70.
  assert.equal((await set(gladys, device, 'volume', 100)).success, true);
  assert.equal(product.state.volume, 70);
  assert.equal(gladys.fake.lastState(id('volume')), 70);
  assert.ok(logs.some((l) => /lowered to the cap 70/.test(l)));
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${product.port}`, max_volume: 25 });
  assert.equal((await set(gladys, device, 'volume', 60)).success, true);
  assert.equal(product.state.volume, 25);
  assert.equal((await set(gladys, device, 'volume', 10)).success, true);
  assert.equal(product.state.volume, 10, 'below the cap: unchanged');
  // An unreadable cap is the default cap, never "no cap".
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${product.port}`, max_volume: 'x' });
  assert.equal((await set(gladys, device, 'volume', 99)).success, true);
  assert.equal(product.state.volume, 70);
});

test('parseVolumeCommand accepts integers 0..100 only', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(100), 100);
  assert.equal(parseVolumeCommand(' 7 '), 7);
  for (const bad of [null, undefined, '', -0.5, 100.1, '0x10', [], false]) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

test('mute: each press sets the opposite of the state read from the product', async (t) => {
  const { product, gladys } = await setup(t);
  const device = await createProduct(gladys);
  await set(gladys, device, 'mute', 1);
  assert.equal(product.state.muted, true);
  assert.equal(gladys.fake.lastState(id('mute')), 1);
  // Unmuted from the B&O app meanwhile: the press reads it first.
  product.state.muted = false;
  await set(gladys, device, 'mute', 1);
  assert.equal(product.state.muted, true);
  const bodies = product.writes().map((r) => JSON.parse(r.body));
  assert.deepEqual(bodies, [{ muted: true }, { muted: true }], 'explicit values, never a toggle');
});

test('mute state unknown: nothing sent', async (t) => {
  const { product, gladys } = await setup(t);
  const device = await createProduct(gladys);
  product.state.muted = 'maybe';
  const ack = await set(gladys, device, 'mute', 1);
  assert.equal(ack.success, false);
  assert.equal(product.writes().length, 0);
});

test('play, pause, next, previous and standby', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys } = await setup(t, { clock });
  const device = await createProduct(gladys);
  const reads = () => product.state.requests.filter((r) => r.path === '/api/v1/state').length;
  const before = reads();
  for (const key of ['pause', 'play', 'next', 'previous', 'standby']) {
    assert.equal((await set(gladys, device, key, 1)).success, true, key);
  }
  assert.deepEqual(
    product.writes().map((r) => `${r.method} ${r.path}`),
    [
      'POST /api/v1/playback/command/pause',
      'POST /api/v1/playback/command/play',
      'POST /api/v1/playback/command/skip',
      'POST /api/v1/playback/command/prev',
      'PUT /api/v1/state/standby',
    ],
  );
  assert.ok(product.writes().every((r) => r.headers['content-length'] === '0'));
  await settle();
  // Minor 7: the reads after the commands go through isDue: not before the interval.
  assert.equal(reads(), before, 'no read faster than the interval');
  assert.equal(gladys.fake.lastState(id('power')), 1);
});

test('minor 7: a read after a command waits for the interval, then happens once', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  const device = await createProduct(gladys);
  const reads = () => product.state.requests.filter((r) => r.path === '/api/v1/state').length;
  const before = reads();
  assert.equal((await set(gladys, device, 'standby', 1)).success, true);
  assert.equal((await set(gladys, device, 'play', 1)).success, true);
  assert.ok(app.plannedReads.size <= 1, 'one planned read per product at most');
  assert.equal(reads(), before, 'not before the interval');
  clock.now += 30_000;
  app.recheck(app.products[0]);
  await settle();
  assert.equal(reads(), before + 1, 'once');
  assert.equal(gladys.fake.lastState(id('power')), 0, 'read again after the standby');
});

test('minor 7: device updates in a row do not read faster than the interval', async (t) => {
  const { product, gladys } = await setup(t);
  const device = await createProduct(gladys);
  const before = product.state.requests.filter((r) => r.method === 'GET').length;
  for (let i = 0; i < 5; i += 1) {
    await gladys.fake.deviceUpdated(device);
  }
  const after = product.state.requests.filter((r) => r.method === 'GET').length;
  assert.equal(after, before);
});

test('source: validated against the dropdown, then against the live list', async (t) => {
  const { product, gladys } = await setup(t);
  const device = await createProduct(gladys);
  assert.equal((await set(gladys, device, 'source', 'lineIn')).success, true);
  assert.equal(product.state.active, 'lineIn');
  assert.equal(gladys.fake.lastState(id('source')), 'lineIn');
  const before = product.writes().length;
  for (const bad of ['tidal', 'phono', '../../state/standby', '__proto__', 3, null]) {
    assert.equal((await set(gladys, device, 'source', bad)).success, false, String(bad));
  }
  // Disabled on the product since: refused, nothing sent.
  product.state.sources[0].isEnabled = false;
  const disabled = await set(gladys, device, 'source', 'spotify');
  assert.equal(disabled.success, false);
  assert.match(JSON.stringify(disabled), /not available now, nothing sent/);
  assert.equal(product.writes().length, before);
});

test('a product off or unreachable is marked so, then asked again at spaced intervals', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  const device = await createProduct(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  await product.close();

  clock.now += 30_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /Not answering.*Living room/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Ne répondent pas/);
  assert.equal(gladys.fake.connectionStatus.connected, true);

  // Asked again after 30 s, then 60 s, 120 s...: never in a loop.
  const reads = () => app.attempts.get(SERIAL).count;
  clock.now += 30_000;
  await app.tick();
  assert.equal(reads(), 2);
  clock.now += 30_000;
  await app.tick();
  assert.equal(reads(), 2, 'not due before 60 s');
  clock.now += 30_000;
  await app.tick();
  assert.equal(reads(), 3);
  for (let i = 0; i < 40; i += 1) {
    clock.now += 30_000;
    await app.tick();
  }
  const record = app.attempts.get(SERIAL);
  assert.ok(record.nextAt - record.last <= TIMINGS.maxBackoff, 'the backoff is capped');

  // A command to a product that does not answer says so, standby included.
  const volume = await set(gladys, device, 'volume', 10);
  assert.equal(volume.success, false);
  assert.match(JSON.stringify(volume), /nothing sent/);
  const standby = await set(gladys, device, 'standby', 1);
  assert.equal(standby.success, false, 'minor 8');
  assert.match(JSON.stringify(standby), /does not answer.*nothing sent/);
});

test('standby and network standby show power 0 while the product answers', async (t) => {
  const { gladys } = await setup(t, { productOptions: { power: 'networkStandby' } });
  await createProduct(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
});

test('connected then silent: nothing published, then read normally again', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  await createProduct(gladys);
  product.state.silent = true;
  clock.now += 30_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('power')), 1, 'not proof of standby');
  product.state.silent = false;
  product.state.volume = 55;
  clock.now += 30_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('volume')), 55);
});

test('a hostile answer is cut, never published', async (t) => {
  const { product, gladys, app } = await setup(t);
  await createProduct(gladys);
  const count = gladys.fake.states.length;
  product.state.hostile = true;
  await app.readState(app.products[0]);
  assert.equal(gladys.fake.states.length, count, 'nothing published from a 200 KB answer');
});

test('nothing playing: the title says so', async (t) => {
  const { gladys } = await setup(t, {
    productOptions: { metadata: undefined, rendering: 'idle' },
  });
  await createProduct(gladys);
  assert.equal(gladys.fake.lastState(id('title')), NOTHING);
  assert.equal(gladys.fake.lastState(id('playback')), 0);
});

test('an older BeoLink product (no Mozart API) is named in the status, never added', async (t) => {
  const { gladys, app } = await setup(t, { productOptions: { legacy: true } });
  assert.equal(app.products.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /older BeoLink products.*not supported/);
  assert.match(gladys.fake.connectionStatus.message.fr, /anciens produits BeoLink/);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /No Mozart product answers yet/);
});

test('a typed address that does not answer is reported, then found', async (t) => {
  const { product, gladys, app } = await setup(t, {
    config: { addresses: '127.0.0.1:1, bad_host!' },
  });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /127\.0\.0\.1:1/);
  assert.match(gladys.fake.connectionStatus.message.en, /Ignored.*bad_host!/);
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${product.port}` });
  assert.equal(app.products.length, 1);
  assert.equal(gladys.fake.discoveredDevices.at(-1).external_id, id());
});

test('mDNS search through Gladys (optional), and its failure never blocks', async (t) => {
  const { gladys, app } = await setup(t, {
    config: { addresses: '' },
    scanResults: {
      mdns: [
        { name: 'junk', host: null, addresses: ['::1', 'zzz'], port: null, txt: [] },
        {
          name: 'Living room._bangolufsen._tcp.local',
          host: 'beosound.local',
          addresses: ['127.0.0.1'],
          port: 9999,
          txt: [`sn=${SERIAL}`],
        },
      ],
    },
  });
  const ack = await gladys.fake.action('find_products');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Living room/);
  assert.equal(app.products.length, 1);

  app.gladys.scanNetwork = async () => {
    throw new Error('403');
  };
  const again = await gladys.fake.action('find_products');
  assert.equal(again.success, true);
});

test('another product at the address (DHCP): never commanded there', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  await createProduct(gladys);
  await product.close();
  clock.now += 30_000;
  await app.tick();
  const other = await startFakeProduct({
    jid: '2714.1200304.87654321@products.bang-olufsen.com',
    friendlyName: 'Kitchen',
  });
  t.after(() => other.close());
  app.products[0].port = other.port;
  clock.now += 60_000;
  await app.tick();
  assert.equal(app.data.products[SERIAL].host, '', 'the address is cleared');
  assert.ok(app.data.products['87654321'], 'the other product is remembered');
  assert.equal(other.writes().length, 0);
});

test('a reconnection to Gladys publishes the devices, the states and the status again', async (t) => {
  const { product, gladys, app } = await setup(t, { config: { addresses: '127.0.0.1:1' } });
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${product.port}, 127.0.0.1:1` });
  await createProduct(gladys);
  const states = gladys.fake.states.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  await app.start(
    { addresses: app.config.addresses.map((a) => `${a.host}:${a.port}`).join(',') },
    { connected: true },
  );
  assert.ok(gladys.fake.states.length > states, 'states published again');
  assert.ok(gladys.fake.bodies('POST', '/discovered_device').length > discoveries);
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status published again');
});

test('check the products', async (t) => {
  const { gladys } = await setup(t);
  const ack = await gladys.fake.action('check_products');
  assert.match(ack.data.message.en, /answers, on, volume 30/);
  assert.match(ack.data.message.fr, /répond, allumé, volume 30/);
});

test('notifications: states published as they change, merged', async (t) => {
  const { product, gladys, app } = await setup(t);
  await createProduct(gladys);
  await waitFor(channelOpen(app, product), 'the notification channel');
  const handshake = product.state.requests.find((r) => r.method === 'UPGRADE');
  assert.equal(handshake.path, '/');
  assert.equal(handshake.headers['user-agent'], undefined, 'no User-Agent sent');

  product.notify('WebSocketEventVolume', {
    level: { level: 44 },
    muted: { muted: true },
    maximum: { level: 90 },
  });
  product.notify('WebSocketEventPlaybackState', { value: 'paused' });
  product.notify('WebSocketEventPlaybackMetadata', { artistName: 'Air', title: 'La femme' });
  product.notify('WebSocketEventSourceChange', { id: 'lineIn', name: 'Line-In' });
  product.notify('WebSocketEventSomethingElse', { value: 1 });
  await waitFor(() => gladys.fake.lastState(id('title')) === 'Air - La femme', 'the title');
  assert.equal(gladys.fake.lastState(id('volume')), 44);
  assert.equal(gladys.fake.lastState(id('mute')), 1);
  assert.equal(gladys.fake.lastState(id('playback')), 0);
  assert.equal(gladys.fake.lastState(id('source')), 'lineIn');

  product.notify('WebSocketEventPlaybackMetadata', {});
  product.notify('WebSocketEventPowerState', { value: 'standby' });
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'the power');
  assert.equal(gladys.fake.lastState(id('title')), NOTHING, 'the old title is not kept');
});

test('notifications: a flood is dropped, an oversized message closes the channel', async (t) => {
  const { product, gladys, app, logs } = await setup(t);
  await createProduct(gladys);
  await waitFor(channelOpen(app, product), 'the notification channel');
  const frames = [];
  for (let i = 0; i < LIMITS.messagesPerSecond * 3; i += 1) {
    frames.push(
      serverFrame(
        1,
        JSON.stringify({
          eventType: 'WebSocketEventVolume',
          eventData: { level: { level: i % 50 } },
        }),
      ),
    );
  }
  product.raw(Buffer.concat(frames));
  await settle(60);
  assert.ok(logs.some((l) => /too many notifications/.test(l)));
  const channel = app.channels.get(SERIAL);
  assert.ok(channel.window.count > LIMITS.messagesPerSecond);

  product.raw(serverFrame(1, 'x'.repeat(LIMITS.message + 1)));
  await waitFor(() => app.channels.get(SERIAL)?.open !== true, 'the channel to close');
  // Opened again later, spaced out.
  await waitFor(channelOpen(app, product), 'the channel to open again');
});

test('notifications: a lost channel is opened again, spaced out', async (t) => {
  const { product, gladys, app } = await setup(t, {
    timings: { wsRetryMin: 5_000, wsRetryMax: 5 * 60_000 },
  });
  await createProduct(gladys);
  await waitFor(channelOpen(app, product), 'the notification channel');
  product.dropChannels();
  await waitFor(() => app.channels.get(SERIAL)?.open === false, 'the channel to drop');
  assert.equal(app.channels.get(SERIAL).failures, 1);
  await waitFor(channelOpen(app, product), 'the channel to open again');
  // Refused: each retry doubles (the test timers shorten the waits).
  product.state.refuseUpgrade = true;
  product.dropChannels();
  await waitFor(() => (app.channels.get(SERIAL)?.failures ?? 0) >= 3, 'refused retries');
  assert.ok(app.channels.get(SERIAL).failures >= 3);
});

test('a deleted device closes its channel; stop() closes every channel', async (t) => {
  const { product, gladys, app } = await setup(t);
  const device = await createProduct(gladys);
  await waitFor(channelOpen(app, product), 'the notification channel');
  await gladys.fake.deviceDeleted(device);
  assert.equal(app.channels.size, 0);
  await waitFor(() => product.channels.size === 0, 'the socket to close');
  await gladys.fake.deviceCreated(device);
  await waitFor(channelOpen(app, product), 'the notification channel');
  await app.stop();
  assert.equal(app.channels.size, 0);
  await waitFor(() => product.channels.size === 0, 'the socket to close');
});

test('a slow Gladys never turns an accepted command into a failed ack', async (t) => {
  const { product, gladys, app } = await setup(t, { timings: { commandBudget: 400 } });
  const device = await createProduct(gladys);
  // Publishing the states never ends.
  app.gladys.publishChangedStates = () => new Promise(() => {});
  for (const [key, value] of [
    ['volume', 21],
    ['mute', 1],
    ['source', 'lineIn'],
  ]) {
    const ack = await set(gladys, device, key, value);
    assert.equal(ack.success, true, key);
  }
  assert.equal(product.state.volume, 21);
  assert.equal(product.state.muted, true);
  assert.equal(product.state.active, 'lineIn');
});

test('deadline: "sent, without confirmation" once a request left, "nothing sent" before', async (t) => {
  let hangWrites = false;
  const request = (options) =>
    hangWrites && options.method !== 'GET' ? new Promise(() => {}) : httpRequest(options);
  const { product, gladys } = await setup(t, { request, timings: { commandBudget: 300 } });
  const device = await createProduct(gladys);
  hangWrites = true;
  const sent = await set(gladys, device, 'volume', 40);
  assert.equal(sent.success, false);
  assert.match(JSON.stringify(sent), /Sent, without confirmation/);

  // The pre-read of the mute hangs: nothing was sent.
  hangWrites = false;
  product.state.silent = true;
  const before = product.writes().length;
  const muted = await set(gladys, device, 'mute', 1);
  assert.equal(muted.success, false);
  assert.match(JSON.stringify(muted), /nothing sent/);
  assert.equal(product.writes().length, before);
});

test('getDevices failing at start: the products are still read', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  await createProduct(gladys);
  const original = app.gladys.getDevices.bind(app.gladys);
  app.gladys.getDevices = async () => {
    throw new Error('503');
  };
  app.created.clear();
  clock.now += 30_000;
  await app.start({ addresses: `127.0.0.1:${product.port}` }, { connected: true });
  assert.equal(app.created.has(SERIAL), true);
  assert.equal(app.createdStale, true);

  const sdkDevices = app.gladys.devices;
  app.gladys.devices = undefined;
  app.created.clear();
  clock.now += 30_000;
  await app.start({ addresses: `127.0.0.1:${product.port}` }, { connected: true });
  assert.equal(app.created.size, 0);
  app.gladys.getDevices = original;
  app.gladys.devices = sdkDevices;
  product.state.volume = 66;
  clock.now += 30_000;
  await app.tick();
  assert.equal(app.created.has(SERIAL), true);
  assert.equal(app.createdStale, false);
  assert.equal(gladys.fake.lastState(id('volume')), 66);
});

test('a created product that lost its address: power 0, status, automatic search', async (t) => {
  const clock = { now: 1_000_000 };
  const { gladys, app } = await setup(t, { clock, config: { addresses: '' } });
  app.gladys.scanNetwork = async () => [
    { name: 'x', host: null, addresses: ['127.0.0.1'], port: null, txt: [] },
  ];
  await gladys.fake.action('find_products');
  await createProduct(gladys);
  app.data.products[SERIAL].host = '';
  let searches = 0;
  app.gladys.scanNetwork = async () => {
    searches += 1;
    return [];
  };
  clock.now += 30_000;
  await app.tick();
  await settle();
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /Address unknown.*Find the products/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Adresse inconnue.*Chercher les produits/);
  assert.equal(searches, 1);
  clock.now += 60_000;
  await app.tick();
  await settle();
  assert.equal(searches, 1, 'not again before 10 minutes');
  clock.now += 10 * 60_000;
  await app.tick();
  await settle();
  assert.equal(searches, 2);
  app.gladys.scanNetwork = async () => [
    { name: 'x', host: null, addresses: ['127.0.0.1'], port: null, txt: [] },
  ];
  await gladys.fake.action('find_products');
  assert.equal(app.data.products[SERIAL].host, '127.0.0.1');
  clock.now += 60_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('power')), 1);
});

test('the Source options of the created device are never dropped', async (t) => {
  const { gladys, app } = await setup(t);
  const device = await createProduct(gladys);
  const withPhono = {
    ...device,
    features: device.features.map((f) =>
      f.external_id === id('source')
        ? { ...f, supported_options: [...f.supported_options, { value: 'tv', label: 'TV' }] }
        : f,
    ),
  };
  await gladys.fake.deviceUpdated(withPhono);
  app.data.products[SERIAL].sources = [{ id: 'spotify', name: 'Spotify' }];
  await app.publishDevices();
  const published = gladys.fake.discoveredDevices.at(-1);
  const values = published.features
    .find((f) => f.external_id === id('source'))
    .supported_options.map((o) => o.value);
  assert.deepEqual(values, ['lineIn', 'spotify', 'tv']);
});

test('the identity is read again at most every 10 minutes, even when the sources fail', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  await createProduct(gladys);
  product.state.failSources = true;
  const describes = () =>
    product.state.requests.filter((r) => r.path === '/api/v1/beolink/self').length;
  const start = describes();
  for (let i = 0; i < 5; i += 1) {
    clock.now += 30_000;
    await app.tick();
  }
  assert.equal(describes(), start, 'not at every round');
  clock.now += TIMINGS.sourcesRefresh;
  await app.tick();
  assert.equal(describes(), start + 1);
});

test('a renamed product republishes its device', async (t) => {
  const clock = { now: 1_000_000 };
  const { product, gladys, app } = await setup(t, { clock });
  await createProduct(gladys);
  product.state.friendlyName = 'Salon‮';
  clock.now += TIMINGS.sourcesRefresh;
  await app.tick();
  assert.equal(gladys.fake.discoveredDevices.at(-1).name, 'Salon');
});

test('one search at a time', async (t) => {
  const { app } = await setup(t, { config: { addresses: '' } });
  let calls = 0;
  app.gladys.scanNetwork = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [];
  };
  await Promise.all([app.scan(), app.scan(), app.scan()]);
  assert.equal(calls, 1);
});

// --- Review fixes ---------------------------------------------------------------

test('I2: unmuting above the cap lowers the volume first', async (t) => {
  const { product, gladys } = await setup(t, { productOptions: { volume: 90, muted: true } });
  const device = await createProduct(gladys);
  const ack = await set(gladys, device, 'mute', 1);
  assert.equal(ack.success, true);
  assert.equal(product.state.muted, false);
  assert.equal(product.state.volume, 70, 'the default cap');
  assert.deepEqual(
    product.writes().map((r) => r.path),
    ['/api/v1/sound/volume/level', '/api/v1/sound/volume/mute'],
    'the volume before the unmute',
  );
  assert.equal(gladys.fake.lastState(id('volume')), 70);
  // Muting never touches the volume.
  product.state.volume = 95;
  assert.equal((await set(gladys, device, 'mute', 1)).success, true);
  assert.equal(product.state.volume, 95);
});

test('I2: the cap is read when unmuting; volume refused: not unmuted, nothing else sent', async (t) => {
  let refuseLevel = false;
  const request = async (options) =>
    refuseLevel && options.path.endsWith('/volume/level')
      ? { status: 400, body: '' }
      : httpRequest(options);
  const { product, gladys } = await setup(t, {
    request,
    productOptions: { volume: 50, muted: true },
  });
  const device = await createProduct(gladys);
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${product.port}`, max_volume: 40 });
  refuseLevel = true;
  const ack = await set(gladys, device, 'mute', 1);
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /not lowered to the cap 40.*unmute not sent/);
  assert.equal(product.state.muted, true, 'still muted');
  assert.equal(product.writes().filter((r) => r.path.endsWith('/mute')).length, 0);
});

test('I2: unmuting with a volume unknown and a cap: nothing sent', async (t) => {
  const { product, gladys } = await setup(t, { productOptions: { volume: 'loud', muted: true } });
  const device = await createProduct(gladys);
  const ack = await set(gladys, device, 'mute', 1);
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /volume unknown, not unmuted, nothing sent/);
  assert.equal(product.writes().length, 0);
});

test('minor 4: the body of a command answer is ignored', async (t) => {
  const request = async (options) => {
    const answer = await httpRequest(options);
    return options.method !== 'GET' ? { ...answer, body: 'Created <html>' } : answer;
  };
  const { product, gladys } = await setup(t, { request });
  const device = await createProduct(gladys);
  assert.equal((await set(gladys, device, 'volume', 40)).success, true);
  assert.equal(product.state.volume, 40);
});

test('minor 5: play and a source change lower a known volume above the cap first', async (t) => {
  const { product, gladys, app } = await setup(t, { productOptions: { volume: 90 } });
  const device = await createProduct(gladys);
  assert.equal(app.readings.get(SERIAL).volume, 90);
  assert.equal((await set(gladys, device, 'play', 1)).success, true);
  assert.deepEqual(
    product.writes().map((r) => r.path),
    ['/api/v1/sound/volume/level', '/api/v1/playback/command/play'],
  );
  assert.equal(product.state.volume, 70);
  // Known level now 70: nothing more for the source change.
  assert.equal((await set(gladys, device, 'source', 'lineIn')).success, true);
  assert.equal(product.writes().length, 3);
  // Raised to 95 from the B&O app (notified): lowered before the next source change.
  app.readings.get(SERIAL).volume = 95;
  product.state.volume = 95;
  assert.equal((await set(gladys, device, 'source', 'spotify')).success, true);
  assert.deepEqual(
    product
      .writes()
      .slice(-2)
      .map((r) => r.path),
    ['/api/v1/sound/volume/level', '/api/v1/playback/sources/active/spotify'],
  );
  assert.equal(product.state.volume, 70);
});

test('minor 6: pause goes before the volumes waiting, which are merged', async (t) => {
  let slow = false;
  const request = async (options) => {
    if (slow && options.path.endsWith('/volume/level')) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return httpRequest(options);
  };
  const { product, gladys } = await setup(t, { request });
  const device = await createProduct(gladys);
  slow = true;
  const acks = await Promise.all([
    set(gladys, device, 'volume', 40),
    settle(20).then(() => set(gladys, device, 'volume', 45)),
    settle(25).then(() => set(gladys, device, 'volume', 50)),
    settle(30).then(() => set(gladys, device, 'pause', 1)),
  ]);
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, true, true],
  );
  assert.deepEqual(
    product.writes().map((r) => `${r.path.split('/').pop()} ${r.body}`.trim()),
    ['level {"level":40}', 'pause', 'level {"level":50}'],
    'pause before the waiting volumes; 45 and 50 merged into 50',
  );
  assert.equal(product.state.volume, 50);
});

test('minor 9: the spacing of the reads is cleared when the address changes', async (t) => {
  const { product, gladys, app } = await setup(t);
  await createProduct(gladys);
  app.attempts.set(SERIAL, { count: 5, last: Date.now(), nextAt: Date.now() + 300_000 });
  app.remember({ serial: SERIAL, name: 'Living room' }, { host: '127.0.0.1', port: product.port });
  assert.ok(app.attempts.has(SERIAL), 'same address: kept');
  app.remember({ serial: SERIAL, name: 'Living room' }, { host: '127.0.0.2', port: product.port });
  assert.equal(app.attempts.has(SERIAL), false, 'new address: cleared');
});

test('minor 10: starts never run twice at once; those asked meanwhile are merged', async (t) => {
  const { product, app } = await setup(t);
  let running = 0;
  let most = 0;
  let runs = 0;
  const original = app.runStart.bind(app);
  app.runStart = async (...args) => {
    runs += 1;
    running += 1;
    most = Math.max(most, running);
    try {
      await settle(30);
      return await original(...args);
    } finally {
      running -= 1;
    }
  };
  const config = { addresses: `127.0.0.1:${product.port}` };
  const first = app.start(config, { connected: true });
  await settle(10);
  await Promise.all([
    first,
    app.start(config),
    app.start({ ...config, max_volume: 33 }),
    app.start(config),
  ]);
  assert.equal(most, 1, 'never two at once');
  assert.equal(runs, 2, 'the one running, then one for all the others');
  assert.equal(app.config.maxVolume, 70, 'the last configuration wins');
});
