// -----------------------------------------------------------------------------
// The integration: the Mozart products it knows (typed addresses, optional
// mDNS search through Gladys), the Gladys devices built from them, the
// polling (spaced out for a product that does not answer), the notification
// channel of each created product (WebSocket, port 9339: states published
// as they change, merged to one publication per second at most), the
// commands (validated before anything is sent, serialized per product, each
// within the 5 s Gladys waits for its ack) and the configuration buttons.
// index.js only wires the SDK handlers to it (src/handlers.js).
//
// A reading has `on`: true (the product answers), false (nothing accepts the
// connection: off or unreachable) or undefined (something answered, but not
// as expected): an unknown state is never published.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  DEFAULT_PORT,
  DEVICE_TYPE,
  FEATURES,
  LIMITS,
  TIMINGS,
  WEBSOCKET_PORT,
} from './constants.js';
import { MozartClient, isSafeId } from './mozart/client.js';
import { ERROR_KINDS, ProductError, request as defaultRequest } from './mozart/http.js';
import { parseNotification } from './mozart/notifications.js';
import { openWebSocket as defaultOpenWebSocket } from './mozart/websocket.js';
import { T } from './i18n.js';
import {
  buildDevice,
  deviceName,
  featureKey,
  mergeSources,
  sourceOptions,
  stateList,
} from './model.js';
import { FileStore, emptyData } from './store.js';

/** Timers fire a little early or late: a read due "now" is not skipped for 1 ms. */
const SLACK = 250;

const TRANSPORT = new Map([
  [FEATURES.PLAY, 'play'],
  [FEATURES.PAUSE, 'pause'],
  [FEATURES.NEXT, 'skip'],
  [FEATURES.PREVIOUS, 'prev'],
]);

/** Answers that would come back the same if asked again soon: spaced out like no answer. */
const isSpacedError = (err) => err?.kind === ERROR_KINDS.HTTP || err?.kind === ERROR_KINDS.PROTOCOL;

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const short = (value) => String(value).slice(0, 32);

export class BangOlufsenApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'bang-olufsen' }),
    store = new FileStore(),
    request = defaultRequest,
    openWebSocket = defaultOpenWebSocket,
    websocketPort = WEBSOCKET_PORT,
    scanPort = DEFAULT_PORT,
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.request = request;
    this.openWebSocket = openWebSocket;
    this.websocketPort = websocketPort;
    /** The REST port asked for a product found by mDNS (80; another one in the tests). */
    this.scanPort = scanPort;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    /** serial -> MozartClient */
    this.clients = new Map();
    /** serial -> last reading { on, power?, volume?, muted?, playing?, artist?, title?, source? } */
    this.readings = new Map();
    /** serial -> { list, at }: the live source list */
    this.sourceLists = new Map();
    /** serial or "addr:<address>" -> { count, last, nextAt }: when to ask again */
    this.attempts = new Map();
    /** serial -> tail of the command queue */
    this.queues = new Map();
    /** serial -> the notification channel { socket, host, port, open, failures, retryAt, ... } */
    this.channels = new Map();
    /** serial -> pending publication of notified states */
    this.publishTimers = new Map();
    /** Typed addresses where something answers, but not the Mozart API. */
    this.notMozart = new Set();
    /** serials of the devices created in Gladys */
    this.created = new Set();
    this.createdStale = false;
    this.scanning = undefined;
    this.lastAutoScan = -Infinity;
    /** serial -> when the identity (`beolink/self`) was last read */
    this.identityReadAt = new Map();
    this.backgroundTimers = new Set();
    this.generation = 0;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.polling = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. On a (re)connection the core has forgotten the
   * states and the status: everything this app remembered as "already
   * published" is forgotten too. The spacing of the reads is kept.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    // The timer first: whatever fails below, the next round tries again.
    this.schedule();
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/bang-olufsen.json moved to bang-olufsen.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('probe the addresses', () => this.probeAddresses(true));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the last states', () => this.republishReadings());
    await this.step('poll', () => this.poll(true));
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handle of this.backgroundTimers) {
      this.timers.clearTimeout(handle);
    }
    this.backgroundTimers.clear();
    this.publishTimers.clear();
    for (const serial of [...this.channels.keys()]) {
      this.closeChannel(serial);
    }
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  schedule() {
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = this.timers.setInterval(() => this.tick(), this.config.pollInterval * 1000);
  }

  /** One timer round: the typed addresses not answering yet, the polling, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() =>
        this.createdStale
          ? this.refreshCreated().catch((err) =>
              this.logger.warn(`Could not read the Gladys devices: ${err.message}`),
            )
          : undefined,
      )
      .then(() => this.autoScan())
      .then(() => this.probeAddresses(false))
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.poll(false))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
    return handle;
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  enqueue(serial, task) {
    const previous = this.queues.get(serial) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      serial,
      run.catch(() => {}),
    );
    return run;
  }

  // --- Spacing of the reads ----------------------------------------------------

  intervalMs() {
    return this.config.pollInterval * 1000;
  }

  /**
   * Whether `key` may be asked now. Never more often than the interval; after
   * failures, the interval doubled each time up to `maxBackoff`. `force` (a
   * start, a configuration save) only skips the backoff, not the interval.
   */
  isDue(key, force) {
    const record = this.attempts.get(key);
    if (!record) {
      return true;
    }
    if (this.now() - record.last < this.intervalMs() - SLACK) {
      return false;
    }
    return force || this.now() >= record.nextAt - SLACK;
  }

  /**
   * Records an attempt: `ok` true, false (no answer) or undefined (unexpected
   * answer). `backoff`: an unexpected answer that is spaced out too (HTTP
   * error, unreadable answer: asking again soon would get the same).
   */
  recordAttempt(key, ok, { backoff = false } = {}) {
    const record = this.attempts.get(key) ?? { count: 0 };
    record.last = this.now();
    if (ok === false || backoff) {
      record.count += 1;
      const delay = Math.min(
        this.timings.maxBackoff,
        this.intervalMs() * 2 ** Math.min(record.count - 1, 16),
      );
      record.nextAt = record.last + delay;
    } else {
      if (ok === true) {
        record.count = 0;
      }
      record.nextAt = record.last + this.intervalMs();
    }
    this.attempts.set(key, record);
    return record;
  }

  // --- Known products ----------------------------------------------------------

  get products() {
    return Object.values(this.data?.products ?? {});
  }

  client(product) {
    let client = this.clients.get(product.serial);
    if (!client || client.host !== product.host || client.port !== product.port) {
      client = new MozartClient({
        host: product.host,
        port: product.port ?? DEFAULT_PORT,
        request: this.request,
        timeoutMs: this.timings.httpTimeout,
        now: this.now,
      });
      this.clients.set(product.serial, client);
    }
    return client;
  }

  productOfDevice(device) {
    return this.products.find(
      (p) => this.gladys.externalIds(DEVICE_TYPE, p.serial).device === device?.external_id,
    );
  }

  /**
   * The products created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works.
   */
  async refreshCreated() {
    let devices;
    try {
      devices = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      devices = this.gladys.devices;
    }
    const bySerial = new Map(
      this.products.map((p) => [this.gladys.externalIds(DEVICE_TYPE, p.serial).device, p.serial]),
    );
    this.created = new Set(
      (Array.isArray(devices) ? devices : [])
        .map((d) => bySerial.get(d.external_id))
        .filter(Boolean),
    );
    this.syncChannels();
  }

  /**
   * Asks the product at `address` who it is and remembers it by serial
   * number. Throws a ProductError when nothing answers or it is not a Mozart
   * product.
   */
  async identify(address) {
    const probe = new MozartClient({
      host: address.host,
      port: address.port,
      request: this.request,
      timeoutMs: this.timings.httpTimeout,
      now: this.now,
    });
    const description = await probe.describe();
    const product = this.remember(description, address);
    if (product) {
      // The "Source" dropdown is filled before the device is created.
      await this.sourceList(product, probe, { fresh: true, publish: false }).catch(() => {});
    }
    return product;
  }

  remember(description, address) {
    const products = this.data.products;
    if (!isSafeId(description.serial)) {
      return undefined;
    }
    let product = Object.hasOwn(products, description.serial)
      ? products[description.serial]
      : undefined;
    if (!product) {
      if (Object.keys(products).length >= LIMITS.products) {
        this.warnOnce(
          'products',
          `More than ${LIMITS.products} products: the next ones are ignored`,
        );
        return undefined;
      }
      product = { serial: description.serial, sources: [] };
      products[description.serial] = product;
    }
    // Another product that had this address lost it (DHCP): it is found again
    // at its new address, never commanded at one that is no longer its own.
    for (const other of this.products) {
      if (
        other.serial !== product.serial &&
        other.host === address.host &&
        other.port === address.port
      ) {
        this.logger.warn(`${deviceName(other)} no longer answers at ${addressKey(address)}`);
        other.host = '';
        this.clients.delete(other.serial);
        this.closeChannel(other.serial);
        this.readings.set(other.serial, { on: false });
      }
    }
    const before = JSON.stringify(product);
    if (!product.host && product.host !== address.host) {
      // Found again after its address was lost: its spaced-out "no answer"
      // was about no address at all, not about this one.
      this.attempts.delete(product.serial);
    }
    Object.assign(product, { host: address.host, port: address.port });
    if (description.name !== undefined) {
      product.name = description.name;
    }
    if (JSON.stringify(product) !== before) {
      this.persist();
    }
    return product;
  }

  /** The typed addresses that no known product answers at: asked again, spaced out. */
  async probeAddresses(force) {
    let changed = false;
    await Promise.all(
      this.config.addresses.map(async (address) => {
        const known = this.products.find((p) => p.host === address.host && p.port === address.port);
        const key = `addr:${addressKey(address)}`;
        if (known) {
          this.notMozart.delete(key);
          return;
        }
        if (!this.isDue(key, force)) {
          return;
        }
        try {
          const product = await this.identify(address);
          this.recordAttempt(key, true);
          this.notMozart.delete(key);
          changed = changed || Boolean(product);
        } catch (err) {
          this.recordAttempt(key, err.kind === ERROR_KINDS.UNREACHABLE ? false : undefined, {
            backoff: isSpacedError(err),
          });
          // An HTTP error or another answer at /api/v1/beolink/self: not a
          // Mozart product (an older BeoLink one answers 404 there).
          if (isSpacedError(err)) {
            this.notMozart.add(key);
          } else {
            this.notMozart.delete(key);
          }
          this.logger.debug?.(`${addressKey(address)}: ${err.message}`);
        }
      }),
    );
    return changed;
  }

  /** The typed addresses that still have no product, and never answered like one. */
  silentAddresses() {
    return this.config.addresses
      .filter((a) => !this.products.some((p) => p.host === a.host && p.port === a.port))
      .filter((a) => this.attempts.has(`addr:${addressKey(a)}`))
      .filter((a) => !this.notMozart.has(`addr:${addressKey(a)}`))
      .map(addressKey);
  }

  notMozartAddresses() {
    return this.config.addresses
      .filter((a) => this.notMozart.has(`addr:${addressKey(a)}`))
      .map(addressKey);
  }

  /**
   * The optional mDNS search through Gladys, then the typed addresses. One
   * search at a time (a second request joins the running one); the answers
   * are asked `scanConcurrency` at a time, none started after `scanBudget`.
   * The REST API is always asked on port 80: the port announced by mDNS is
   * not the one of the API.
   */
  scan() {
    if (!this.scanning) {
      this.scanning = this.runScan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async runScan() {
    const deadline = this.now() + this.timings.scanBudget;
    const generation = this.generation;
    const stopped = () => generation !== this.generation;
    let results = [];
    try {
      results = await this.gladys.scanNetwork('mdns', {
        timeoutSeconds: this.timings.scanSeconds,
      });
    } catch (err) {
      // Optional: the typed addresses work without it.
      this.logger.warn(`mDNS search failed: ${err.message}`);
    }
    const seen = new Set();
    const candidates = [];
    for (const result of (Array.isArray(results) ? results : []).slice(0, 50)) {
      const hosts = (Array.isArray(result?.addresses) ? result.addresses : [])
        .filter((h) => typeof h === 'string' && isIP(h) === 4)
        .map((host) => ({ host, port: this.scanPort }))
        .filter((a) => !seen.has(addressKey(a)))
        .slice(0, 4);
      hosts.forEach((a) => seen.add(addressKey(a)));
      if (hosts.length > 0) {
        candidates.push(hosts);
      }
    }
    await mapLimit(candidates, this.timings.scanConcurrency, async (hosts) => {
      for (const address of hosts) {
        if (this.now() >= deadline || stopped()) {
          return;
        }
        try {
          await this.identify(address);
          return;
        } catch (err) {
          this.logger.debug?.(`${addressKey(address)} is not a Mozart product: ${err.message}`);
        }
      }
    });
    if (stopped()) {
      return this.products;
    }
    await this.probeAddresses(true);
    if (!stopped()) {
      await this.publishDevices();
      this.syncChannels();
    }
    return this.products;
  }

  /** The created products whose address is unknown (lost to another product). */
  lostProducts() {
    return this.products.filter((p) => this.created.has(p.serial) && !p.host);
  }

  /** While a created product has no address: a search every `autoScanInterval`. */
  autoScan() {
    if (this.lostProducts().length === 0 || !this.started) {
      return;
    }
    if (this.now() - this.lastAutoScan < this.timings.autoScanInterval) {
      return;
    }
    this.lastAutoScan = this.now();
    const generation = this.generation;
    this.scan()
      .then(() => (generation === this.generation ? this.updateStatus() : undefined))
      .catch((err) => this.logger.warn(`Automatic search failed: ${err.message}`));
  }

  /**
   * The source options of the device created in Gladys (`gladys.devices`,
   * kept up to date by the SDK), merged into the product: options seen before
   * a reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(product) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, product.serial).device;
    const device = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(device?.features) ? device.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.SOURCE}`,
    );
    const options = Array.isArray(feature?.supported_options) ? feature.supported_options : [];
    const merged = mergeSources(
      options.map((o) => ({ id: o?.value, name: o?.label })),
      product.sources,
    );
    if (JSON.stringify(merged) !== JSON.stringify(product.sources ?? [])) {
      product.sources = merged;
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const products = this.products;
    products.forEach((product) => this.mergeCreatedOptions(product));
    await this.gladys.publishDiscoveredDevices(
      products.map((product) => buildDevice(this.gladys, product)),
    );
  }

  // --- Polling -------------------------------------------------------------------

  poll(force = false) {
    if (!this.polling) {
      this.polling = Promise.all(
        this.products
          // A created product without an address is "read" too: its power is
          // published at 0 (no request is made).
          .filter((p) => this.created.has(p.serial) && this.isDue(p.serial, force))
          .map((p) => this.readState(p)),
      ).finally(() => {
        this.polling = undefined;
        this.syncChannels();
      });
    }
    return this.polling;
  }

  /** After a (re)connection: the last known states, for the products not read right away. */
  async republishReadings() {
    for (const product of this.products) {
      const reading = this.readings.get(product.serial);
      if (reading && this.created.has(product.serial)) {
        await this.publishStates(product, reading);
      }
    }
  }

  /** The live source list of a product, read again after `sourcesRefresh`. */
  async sourceList(product, client, { fresh = false, publish = true } = {}) {
    const cached = this.sourceLists.get(product.serial);
    if (!fresh && cached && this.now() - cached.at < this.timings.sourcesRefresh) {
      return cached.list;
    }
    let list;
    try {
      list = await client.sources();
    } catch (err) {
      if (err.kind === ERROR_KINDS.HTTP) {
        return cached?.list ?? [];
      }
      throw err;
    }
    this.sourceLists.set(product.serial, { list, at: this.now() });
    // The dropdown only grows: a source disabled for a while keeps its option.
    const usable = list.filter((s) => s.enabled && s.playable);
    const merged = mergeSources(product.sources, usable);
    if (JSON.stringify(merged) !== JSON.stringify(product.sources ?? [])) {
      product.sources = merged;
      this.persist();
      if (publish) {
        await this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
      }
    }
    return list;
  }

  /**
   * One reading. `verify`: the product was not known to answer, so who
   * answers at its address is asked first (its address may now be another
   * product's).
   */
  async read(product, { verify = false, client = this.client(product) } = {}) {
    if (!product.host) {
      return { on: false };
    }
    try {
      const identityAt = this.identityReadAt.get(product.serial);
      if (
        verify ||
        identityAt === undefined ||
        this.now() - identityAt >= this.timings.sourcesRefresh
      ) {
        const description = await client.describe();
        if (description.serial !== product.serial) {
          this.logger.warn(
            `${deviceName(product)}: another product answers at ${product.host}, run a search`,
          );
          const address = { host: product.host, port: product.port };
          product.host = '';
          this.clients.delete(product.serial);
          this.closeChannel(product.serial);
          this.persist();
          this.remember(description, address);
          return { on: false };
        }
        this.identityReadAt.set(product.serial, this.now());
        const before = deviceName(product);
        this.remember(description, { host: product.host, port: product.port });
        if (deviceName(product) !== before) {
          await this.publishDevices().catch((err) =>
            this.logger.warn(`Could not publish the devices: ${err.message}`),
          );
        }
      }
      const state = await client.state();
      await this.sourceList(product, client).catch(() => {});
      return { on: true, ...state, metadata: true };
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        return { on: false };
      }
      this.warnOnce(`read:${product.serial}`, `${deviceName(product)}: ${err.message}`);
      return { on: undefined, spaced: isSpacedError(err) };
    }
  }

  async readState(product) {
    const wasOn = this.readings.get(product.serial)?.on;
    const reading = await this.read(product, { verify: wasOn !== true });
    const record = this.recordAttempt(product.serial, reading.on, {
      backoff: reading.spaced === true,
    });
    if (reading.on === false && record.count === 1) {
      this.logger.info(`${deviceName(product)} does not answer (off or unreachable)`);
    }
    if (reading.on === true && wasOn === false) {
      this.logger.info(`${deviceName(product)} answers again`);
    }
    if (reading.on !== undefined) {
      this.readings.set(product.serial, reading);
    }
    await this.publishStates(product, reading);
    return reading;
  }

  async publishStates(product, reading) {
    const states = stateList(this.gladys, product, reading);
    if (!this.created.has(product.serial) || states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${deviceName(product)}: ${err.message}`);
    }
  }

  /** Merges a partial reading into the last one and publishes it (after a command). */
  async publishPartial(product, partial) {
    const reading = { ...(this.readings.get(product.serial) ?? {}), on: true, ...partial };
    this.readings.set(product.serial, reading);
    await this.publishStates(product, { on: true, ...partial });
  }

  recheck(product) {
    this.later(() => this.readState(product), this.timings.recheckDelay);
  }

  // --- Notification channel (WebSocket) -------------------------------------------

  /**
   * One channel per created product that answers, closed for the others.
   * Called after every polling round and when the created set changes.
   */
  syncChannels() {
    if (!this.started) {
      return;
    }
    for (const serial of [...this.channels.keys()]) {
      const product = Object.hasOwn(this.data?.products ?? {}, serial)
        ? this.data.products[serial]
        : undefined;
      const channel = this.channels.get(serial);
      if (!product || !this.created.has(serial) || !product.host || channel.host !== product.host) {
        this.closeChannel(serial);
      }
    }
    for (const product of this.products) {
      if (
        this.created.has(product.serial) &&
        product.host &&
        this.readings.get(product.serial)?.on === true &&
        !this.channels.has(product.serial)
      ) {
        this.openChannel(product, 0);
      }
    }
  }

  openChannel(product, failures) {
    const serial = product.serial;
    const channel = {
      host: product.host,
      open: false,
      failures,
      retry: undefined,
      window: { at: 0, count: 0 },
    };
    this.channels.set(serial, channel);
    channel.socket = this.openWebSocket({
      host: product.host,
      port: this.websocketPort,
      path: '/',
      connectTimeout: this.timings.wsConnectTimeout,
      pingInterval: this.timings.wsPingInterval,
      idleTimeout: this.timings.wsIdleTimeout,
      maxMessage: LIMITS.message,
      onOpen: () => {
        if (this.channels.get(serial) !== channel) {
          return;
        }
        channel.open = true;
        channel.openedAt = this.now();
        this.logger.info(`${deviceName(product)}: notifications connected`);
      },
      onMessage: (text) => this.onNotification(product, channel, text),
      onClose: (reason) => this.onChannelClosed(product, channel, reason),
    });
  }

  closeChannel(serial) {
    const channel = this.channels.get(serial);
    if (!channel) {
      return;
    }
    this.channels.delete(serial);
    if (channel.retry !== undefined) {
      this.timers.clearTimeout(channel.retry);
      this.backgroundTimers.delete(channel.retry);
    }
    channel.socket?.close();
  }

  onChannelClosed(product, channel, reason) {
    if (this.channels.get(product.serial) !== channel || !this.started) {
      return;
    }
    // A channel that stayed open a while was healthy: its next retry starts low.
    const healthy = channel.open && this.now() - channel.openedAt >= this.timings.wsRetryMax;
    const failures = healthy ? 0 : channel.failures + 1;
    const delay = Math.min(
      this.timings.wsRetryMax,
      this.timings.wsRetryMin * 2 ** Math.min(failures - 1, 16),
    );
    if (channel.open) {
      this.logger.info(`${deviceName(product)}: notifications lost (${short(reason)})`);
    } else {
      this.logger.debug?.(`${deviceName(product)}: notifications unavailable (${short(reason)})`);
    }
    channel.open = false;
    channel.socket = undefined;
    channel.failures = failures;
    channel.retry = this.later(() => {
      if (this.channels.get(product.serial) !== channel) {
        return;
      }
      this.channels.delete(product.serial);
      if (
        this.created.has(product.serial) &&
        product.host === channel.host &&
        this.readings.get(product.serial)?.on === true
      ) {
        this.openChannel(product, failures);
      }
    }, delay);
  }

  onNotification(product, channel, text) {
    if (this.channels.get(product.serial) !== channel || !this.created.has(product.serial)) {
      return;
    }
    // At most `messagesPerSecond` per product: a flood is dropped, the
    // polling still reads the state.
    const second = Math.floor(this.now() / 1000);
    if (channel.window.at !== second) {
      channel.window = { at: second, count: 0 };
    }
    channel.window.count += 1;
    if (channel.window.count > LIMITS.messagesPerSecond) {
      if (channel.window.count === LIMITS.messagesPerSecond + 1) {
        this.warnOnce(`flood:${product.serial}`, `${deviceName(product)}: too many notifications`);
      }
      return;
    }
    const partial = parseNotification(text);
    if (!partial) {
      return;
    }
    const reading = { ...(this.readings.get(product.serial) ?? {}), on: true, ...partial };
    this.readings.set(product.serial, reading);
    if (
      partial.source !== undefined &&
      !sourceOptions(product).some((o) => o.value === partial.source)
    ) {
      // A source not in the dropdown yet: the list is read again at the next round.
      this.sourceLists.delete(product.serial);
    }
    this.publishSoon(product);
  }

  /** Notified states are merged: one publication per product per `wsPublishDelay`. */
  publishSoon(product) {
    if (this.publishTimers.has(product.serial)) {
      return;
    }
    const handle = this.later(() => {
      this.publishTimers.delete(product.serial);
      const reading = this.readings.get(product.serial);
      return reading ? this.publishStates(product, reading) : undefined;
    }, this.timings.wsPublishDelay);
    this.publishTimers.set(product.serial, handle);
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(product, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      if (typeof value !== 'string' || !sourceOptions(product).some((o) => o.value === value)) {
        throw new Error(`Unknown source "${short(value)}"`);
      }
      return value;
    }
    if (key === FEATURES.MUTE || key === FEATURES.STANDBY || TRANSPORT.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(device, feature, value) {
    const product = this.productOfDevice(device);
    if (!product) {
      throw new Error(`Unknown product ${short(device?.external_id)}`);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    const checked = this.validate(product, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    // Set just before a command request leaves: from then on, the command may
    // have reached the product, whatever happens next.
    const context = { mayHaveSent: false };
    const run = this.enqueue(product.serial, async () => {
      if (late || this.remaining(started) < 50) {
        // Gladys stopped waiting while this command was queued: dropped, never sent late.
        late = true;
        throw new ProductError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
      }
      return this.command(product, key, checked, started, context);
    });
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          if (context.mayHaveSent) {
            this.recheck(product);
            reject(
              new ProductError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the product', {
                sent: true,
              }),
            );
            return;
          }
          reject(
            new ProductError(
              ERROR_KINDS.BUDGET,
              'No time left for this command (product busy), nothing sent',
            ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /**
   * Sends one command request. A request that may have reached the product
   * (connected, then silent) is never reported as "not sent": "sent, without
   * confirmation", and the state is read again shortly after.
   */
  async send(product, task, context) {
    if (context) {
      context.mayHaveSent = true;
    }
    try {
      return await task();
    } catch (err) {
      if (err.kind === ERROR_KINDS.TIMEOUT) {
        this.recheck(product);
        throw new ProductError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the product', {
          sent: true,
        });
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.BUDGET) {
        // The connection was never accepted (or never opened): nothing left.
        if (context) {
          context.mayHaveSent = false;
        }
        throw new ProductError(
          err.kind,
          err.kind === ERROR_KINDS.BUDGET
            ? 'No time left for this command, nothing sent'
            : `${deviceName(product)} does not answer (off or unreachable): nothing sent`,
        );
      }
      if (err.kind === ERROR_KINDS.HTTP) {
        throw new ProductError(
          err.kind,
          `${deviceName(product)} refused the command (${err.message})`,
        );
      }
      throw err;
    }
  }

  /**
   * A read made before a command request (mute state, source list): whatever
   * goes wrong, nothing was sent, and no recheck is needed.
   */
  async readBefore(product, what, task) {
    try {
      return await task();
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new ProductError(
          ERROR_KINDS.UNREACHABLE,
          `${deviceName(product)} does not answer (off or unreachable): nothing sent`,
        );
      }
      if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.BUDGET) {
        throw new ProductError(err.kind, `${what} not read in time: nothing sent`);
      }
      throw new ProductError(err.kind, `${what} unreadable (${err.message}): nothing sent`);
    }
  }

  /**
   * Runs one command. The states it implies are published in the background
   * (never awaited here): a slow Gladys never turns a command the product
   * accepted into a failed ack.
   */
  async command(product, key, value, started, context = { mayHaveSent: false }) {
    if (!product.host) {
      throw new ProductError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(product)}: address unknown, run "Find the products"`,
      );
    }
    const client = () => this.client(product).withBudget(this.remaining(started));
    const publish = (partial) => {
      this.publishPartial(product, partial).catch(() => {});
    };
    if (key === FEATURES.VOLUME) {
      // The cap is read from the configuration now, just before the request:
      // a cap lowered while this command waited applies to it.
      const cap = this.config.maxVolume;
      const level = Math.min(value, cap);
      if (level !== value) {
        this.logger.info(`${deviceName(product)}: volume ${value} lowered to the cap ${cap}`);
      }
      await this.send(product, () => client().setVolume(level), context);
      publish({ volume: level });
      return undefined;
    }
    if (key === FEATURES.MUTE) {
      // Gladys sends a press, not a target: the mute is read from the product
      // just before, and the opposite is set (an explicit value, no toggle).
      const budget = Math.min(this.timings.preRead, this.remaining(started));
      const volume = await this.readBefore(product, 'Mute state', () =>
        this.client(product).withBudget(budget).volume(),
      );
      if (typeof volume.muted !== 'boolean') {
        throw new Error(`${deviceName(product)}: mute state unknown, nothing sent`);
      }
      const muted = !volume.muted;
      await this.send(product, () => client().setMute(muted), context);
      publish({ muted });
      return undefined;
    }
    if (TRANSPORT.has(key)) {
      await this.send(product, () => client().command(TRANSPORT.get(key)), context);
      this.recheck(product);
      return undefined;
    }
    if (key === FEATURES.STANDBY) {
      try {
        await this.send(product, () => client().standby(), context);
      } catch (err) {
        if (err.kind !== ERROR_KINDS.UNREACHABLE) {
          throw err;
        }
        // Nothing answers: off the network. Nothing was sent, and nothing
        // else is wanted from a standby button.
        this.logger.info(`${deviceName(product)} does not answer: nothing to put in standby`);
      }
      this.recheck(product);
      return undefined;
    }
    if (key === FEATURES.SOURCE) {
      // The source list is read again: a source must be enabled and playable now.
      const list = await this.readBefore(product, 'Source list', () => client().sources());
      this.sourceLists.set(product.serial, { list, at: this.now() });
      const source = list.find((s) => s.id === value);
      if (!source || !source.enabled || !source.playable) {
        throw new Error(
          `${deviceName(product)}: source "${value}" not available now, nothing sent`,
        );
      }
      await this.send(product, () => client().setSource(source.id), context);
      publish({ source: source.id });
      this.recheck(product);
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(device) {
    const product = this.productOfDevice(device);
    if (!product) {
      return;
    }
    this.created.add(product.serial);
    this.readings.delete(product.serial);
    await this.readState(product);
    this.syncChannels();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    const product = this.productOfDevice(device);
    if (product) {
      this.created.delete(product.serial);
      this.readings.delete(product.serial);
      this.closeChannel(product.serial);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findProducts() {
    const products = await this.scan();
    await this.updateStatus();
    return T.found(products.map((p) => `${deviceName(p)} (${p.host || '?'})`));
  }

  async checkProducts() {
    const products = this.products;
    if (products.length === 0) {
      return T.noProduct;
    }
    const lines = await mapLimit(products, this.timings.checkConcurrency, async (product) =>
      T.checkLine(`${deviceName(product)} (${product.host || '?'})`, await this.read(product)),
    );
    return T.check(lines);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const other = this.notMozartAddresses();
    if (other.length > 0) {
      notes.push(T.notMozart(other));
    }
    const lost = this.lostProducts();
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost.map(deviceName)));
    }
    const off = this.products
      .filter(
        (p) => this.created.has(p.serial) && p.host && this.readings.get(p.serial)?.on === false,
      )
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
