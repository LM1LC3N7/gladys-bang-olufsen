// -----------------------------------------------------------------------------
// Known products -> Gladys devices and states (pure). One device per Mozart
// product, keyed by its serial number (from its Beolink id): the address may
// change, the serial number does not.
//
// The categories and types are the ones of the Gladys core: `music` like the
// core Sonos service (volume, play, pause, next, previous, playback state),
// `television/volume-mute` for the mute press (music has no mute type),
// `text` for the source and the title, `button/push` for the standby, and the
// power state read only (`unknown/binary`): no switch, nothing an "everything
// on / off" (voice assistants, scenes) could turn into a command. No unit:
// the core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS, NOTHING } from './constants.js';
import { cleanText, isSafeId } from './mozart/client.js';

/** The feature definitions, by frozen key. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.PLAY]: { name: 'Play', category: C.MUSIC, type: T.MUSIC.PLAY, min: 1, max: 1 },
  [FEATURES.PAUSE]: { name: 'Pause', category: C.MUSIC, type: T.MUSIC.PAUSE, min: 1, max: 1 },
  [FEATURES.NEXT]: { name: 'Next', category: C.MUSIC, type: T.MUSIC.NEXT, min: 1, max: 1 },
  [FEATURES.PREVIOUS]: {
    name: 'Previous',
    category: C.MUSIC,
    type: T.MUSIC.PREVIOUS,
    min: 1,
    max: 1,
  },
  [FEATURES.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.TITLE]: {
    name: 'Now playing',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

/**
 * Merges `added` ({ id, name }) into the known sources of a product: a source
 * seen once keeps its option (the dropdown only grows), its label follows the
 * product. At most LIMITS.sources, sorted by id.
 */
export function mergeSources(known = [], added = []) {
  const byId = new Map();
  for (const source of [...known, ...added]) {
    if (isSafeId(source?.id)) {
      byId.set(source.id, cleanText(source.name, LIMITS.name) ?? source.id);
    }
  }
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, LIMITS.sources)
    .map(([id, name]) => ({ id, name }));
}

/** The options of the "Source" dropdown: every source this product has shown. */
export function sourceOptions(product) {
  return mergeSources(product.sources).map(({ id, name }) => ({ value: id, label: name }));
}

export function deviceName(product) {
  return product.name || `Bang & Olufsen ${product.serial}`;
}

export function buildDevice(gladys, product) {
  const ids = gladys.externalIds(DEVICE_TYPE, product.serial);
  return {
    name: deviceName(product),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: product.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(product) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/** "Artist - Title", the title alone, or NOTHING. */
export function nowPlaying(reading) {
  if (!reading.title && !reading.artist) {
    return NOTHING;
  }
  return [reading.artist, reading.title].filter(Boolean).join(' - ');
}

/**
 * The states of a reading. `on` true (the product answers), false (nothing
 * accepts the connection: power 0 only), undefined (something answered, but
 * not as expected: nothing published).
 */
export function stateList(gladys, product, reading) {
  if (reading.on !== true && reading.on !== false) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, product.serial);
  const id = (key) => ids.feature(key);
  if (!reading.on) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  if (typeof reading.power === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: reading.power ? 1 : 0 });
  }
  if (Number.isInteger(reading.volume)) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: reading.volume });
  }
  if (typeof reading.muted === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: reading.muted ? 1 : 0 });
  }
  if (typeof reading.playing === 'boolean') {
    states.push({
      device_feature_external_id: id(FEATURES.PLAYBACK),
      state: reading.playing ? 1 : 0,
    });
  }
  if (reading.metadata) {
    states.push({ device_feature_external_id: id(FEATURES.TITLE), text: nowPlaying(reading) });
  }
  if (
    typeof reading.source === 'string' &&
    sourceOptions(product).some((o) => o.value === reading.source)
  ) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: reading.source });
  }
  return states;
}
