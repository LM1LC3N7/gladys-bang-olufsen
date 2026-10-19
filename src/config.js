// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, MAX_VOLUME, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  max_volume: MAX_VOLUME.default,
  poll_interval: POLL_INTERVAL.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of a product typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted URL is reduced to its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** A whole number within [min, max], or `fallback` when it is not a number. */
function bounded(value, { min, max }, fallback) {
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.slice(0, 100));
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  return {
    addresses,
    invalid,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL, POLL_INTERVAL.default),
    // An unreadable cap falls back to the default cap, never to "no cap".
    maxVolume: bounded(c.max_volume, MAX_VOLUME, MAX_VOLUME.default),
  };
}
