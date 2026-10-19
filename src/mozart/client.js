// -----------------------------------------------------------------------------
// The Mozart REST API of one Bang & Olufsen product (`http://<ip>/api/v1/...`):
// only the endpoints this integration needs, from the OpenAPI document and
// the mozart-api client published by Bang & Olufsen (MIT, see
// THIRD_PARTY_NOTICES.md). The generated client itself is not ported.
//
// Every answer is untrusted: bounded in size (http.js), parsed once, and only
// the expected fields of the expected types are kept, strings cut and cleaned.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { ERROR_KINDS, ProductError, request as defaultRequest } from './http.js';

const BASE = '/api/v1';
export const PATHS = Object.freeze({
  SELF: `${BASE}/beolink/self`,
  STATE: `${BASE}/state`,
  SOURCES: `${BASE}/playback/sources`,
  VOLUME: `${BASE}/sound/volume`,
  VOLUME_LEVEL: `${BASE}/sound/volume/level`,
  MUTE: `${BASE}/sound/volume/mute`,
  STANDBY: `${BASE}/state/standby`,
  command: (name) => `${BASE}/playback/command/${name}`,
  activeSource: (sourceId) => `${BASE}/playback/sources/active/${encodeURIComponent(sourceId)}`,
});

/** The playback commands of `POST /playback/command/{command}` this integration sends. */
export const COMMANDS = Object.freeze(['play', 'pause', 'skip', 'prev']);

// Control characters (C0, DEL, C1), the bidirectional marks, embeddings,
// overrides and isolates (U+061C, U+200E, U+200F, U+202A-U+202E,
// U+2066-U+2069) and the line/paragraph separators (U+2028, U+2029) are
// removed from what is shown in Gladys. Written as code point ranges on
// purpose: the characters themselves are invisible in an editor.
const UNPRINTABLE = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];
const isUnprintable = (char) => {
  const code = char.codePointAt(0);
  return UNPRINTABLE.some(([from, to]) => code >= from && code <= to);
};

/** A printable string of at most `max` characters, or undefined. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = [...value.slice(0, max * 4)]
    .map((char) => (isUnprintable(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : [...text].slice(0, max).join('');
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** Names that would reach Object.prototype when used as a key: never an id. */
export const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const isSafeId = (value) =>
  typeof value === 'string' && SAFE_ID.test(value) && !RESERVED_KEYS.has(value);
const safeId = (value) => (isSafeId(value) ? value : undefined);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The Beolink id of a Mozart product, `<type>.<item>.<serial>@products.bang-olufsen.com`
 * (the check of the mozart-api client): the serial number is its third part.
 */
const JID = /^(\d{4})\.(\d{7})\.(\d{8})@products\.bang-olufsen\.com$/;

/** `GET /beolink/self` -> who the product is. Throws without a usable Beolink id. */
export function parseSelf(json) {
  const match = typeof json?.jid === 'string' ? json.jid.match(JID) : null;
  if (!match) {
    throw new ProductError(ERROR_KINDS.PROTOCOL, 'Not a Mozart product (no Beolink id)');
  }
  return {
    serial: match[3],
    typeNumber: match[1],
    itemNumber: match[2],
    name: cleanText(json.friendlyName, LIMITS.name),
  };
}

const POWER_ON = new Set(['on']);
const POWER_OFF = new Set(['standby', 'networkStandby', 'shutdown', 'storage']);

/** `PowerStateEnum` -> true (on), false (a standby), undefined (not said). */
export function parsePower(json) {
  const value = json?.value;
  return POWER_ON.has(value) ? true : POWER_OFF.has(value) ? false : undefined;
}

const PLAYING = new Set(['started']);
const NOT_PLAYING = new Set(['paused', 'stopped', 'idle', 'ended']);

/** `RenderingState` -> true (playing), false (paused, stopped, idle), undefined. */
export function parseRendering(json) {
  const value = json?.value;
  return PLAYING.has(value) ? true : NOT_PLAYING.has(value) ? false : undefined;
}

/** `PlaybackContentMetadata` -> { artist, title }, each optional. */
export function parseMetadata(json) {
  const metadata = isObject(json) ? json : {};
  return {
    artist: cleanText(metadata.artistName, LIMITS.title),
    title: cleanText(metadata.title, LIMITS.title),
  };
}

/** `VolumeState` -> { level, maximum, muted }, each optional. */
export function parseVolume(json) {
  const level = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? Math.round(value)
      : undefined;
  const muted = json?.muted?.muted;
  return {
    level: level(json?.level?.level),
    maximum: level(json?.maximum?.level),
    muted: typeof muted === 'boolean' ? muted : undefined,
  };
}

/** `Source` -> { id, name, enabled, playable }, or undefined without a usable id. */
export function parseSource(json) {
  const id = safeId(json?.id);
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: cleanText(json.name, LIMITS.name) ?? id,
    enabled: json.isEnabled !== false,
    playable: json.isPlayable !== false,
  };
}

/** `SourceArray` -> at most `LIMITS.sources` sources, each id once. */
export function parseSources(json) {
  const items = Array.isArray(json?.items) ? json.items.slice(0, LIMITS.sources * 4) : [];
  const seen = new Set();
  const list = [];
  for (const item of items) {
    const source = parseSource(item);
    if (source && !seen.has(source.id) && list.length < LIMITS.sources) {
      seen.add(source.id);
      list.push(source);
    }
  }
  return list;
}

/**
 * `GET /state` (ProductState) -> one reading. Every field is optional:
 * undefined means "not said", never a guess.
 */
export function parseState(json) {
  if (!isObject(json)) {
    throw new ProductError(ERROR_KINDS.PROTOCOL, 'Unexpected state answer');
  }
  const playback = isObject(json.playback) ? json.playback : {};
  const volume = parseVolume(json.volume);
  return {
    power: parsePower(json.powerState),
    volume: volume.level,
    maximum: volume.maximum,
    muted: volume.muted,
    playing: parseRendering(playback.state),
    ...parseMetadata(playback.metadata),
    source: parseSource(isObject(json.source) ? json.source : playback.source)?.id,
  };
}

export class MozartClient {
  constructor({ host, port, request = defaultRequest, timeoutMs = 2000, deadline, now }) {
    this.host = host;
    this.port = port;
    this.request = request;
    this.timeoutMs = timeoutMs;
    /** Wall-clock end of the budget of a command (withBudget), or undefined. */
    this.deadline = deadline;
    this.now = now ?? Date.now;
  }

  /** A copy of this client whose requests all end within `ms` from now. */
  withBudget(ms) {
    return new MozartClient({
      host: this.host,
      port: this.port,
      request: this.request,
      timeoutMs: this.timeoutMs,
      deadline: this.now() + Math.max(0, ms),
      now: this.now,
    });
  }

  timeout() {
    if (this.deadline === undefined) {
      return this.timeoutMs;
    }
    const left = this.deadline - this.now();
    if (left < 50) {
      throw new ProductError(ERROR_KINDS.BUDGET, 'No time left for this request');
    }
    return Math.min(this.timeoutMs, left);
  }

  /** One exchange; the parsed JSON of a 2xx answer, a ProductError otherwise. */
  async call(method, path, body) {
    const timeoutMs = this.timeout();
    const answer = await this.request({
      host: this.host,
      port: this.port,
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    if (answer.status < 200 || answer.status > 299) {
      // The ErrorModel of the answer is not shown: only the status is kept.
      throw new ProductError(ERROR_KINDS.HTTP, `HTTP ${answer.status}`, { status: answer.status });
    }
    const text = answer.body.trim();
    if (text === '') {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProductError(ERROR_KINDS.PROTOCOL, 'Unexpected answer (not JSON)');
    }
  }

  async describe() {
    return parseSelf(await this.call('GET', PATHS.SELF));
  }

  async state() {
    return parseState(await this.call('GET', PATHS.STATE));
  }

  async sources() {
    return parseSources(await this.call('GET', PATHS.SOURCES));
  }

  async volume() {
    return parseVolume(await this.call('GET', PATHS.VOLUME));
  }

  /** `level` must already be validated and capped (an integer 0..100). */
  setVolume(level) {
    return this.call('PUT', PATHS.VOLUME_LEVEL, { level });
  }

  setMute(muted) {
    return this.call('PUT', PATHS.MUTE, { muted: muted === true });
  }

  command(name) {
    if (!COMMANDS.includes(name)) {
      throw new ProductError(ERROR_KINDS.PROTOCOL, 'Unknown playback command');
    }
    return this.call('POST', PATHS.command(name));
  }

  setSource(sourceId) {
    if (!isSafeId(sourceId)) {
      throw new ProductError(ERROR_KINDS.PROTOCOL, 'Invalid source id');
    }
    return this.call('POST', PATHS.activeSource(sourceId));
  }

  standby() {
    return this.call('PUT', PATHS.STANDBY);
  }
}
