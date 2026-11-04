// -----------------------------------------------------------------------------
// The rules Gladys applies to a device feature (t_device_feature, see
// server/models/device_feature.js of the core) and to its supported_options.
// The SDK's fake Gladys does not check them; the real one answers HTTP 422
// (a null min or max on a text/select feature, toshiba-ac, November 2026).
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

const values = (map) => new Set(Object.values(map).flatMap((v) => Object.values(v)));
const CATEGORIES = new Set(Object.values(C));
const TYPES = values(T);
const UNITS = new Set(Object.values(U));

/** Asserts one feature has every non-null field of the Gladys model, with a valid value. */
export function assertCoreFeature(f, where) {
  for (const key of ['name', 'external_id']) {
    assert.equal(typeof f[key], 'string', `${where}: ${key}`);
    assert.ok(f[key].trim().length > 0, `${where}: ${key} not empty`);
  }
  assert.ok(CATEGORIES.has(f.category), `${where}: category ${f.category}`);
  assert.ok(TYPES.has(f.type), `${where}: type ${f.type}`);
  for (const key of ['read_only', 'has_feedback']) {
    assert.equal(typeof f[key], 'boolean', `${where}: ${key} is a boolean`);
  }
  if (f.keep_history !== undefined) {
    assert.equal(typeof f.keep_history, 'boolean', `${where}: keep_history is a boolean`);
  }
  for (const key of ['min', 'max']) {
    assert.ok(Number.isFinite(f[key]), `${where}: ${key} is a number (not null), got ${f[key]}`);
  }
  assert.ok(f.min <= f.max, `${where}: min <= max`);
  if (f.unit !== undefined && f.unit !== null) {
    assert.ok(UNITS.has(f.unit), `${where}: unit ${f.unit}`);
  }
  if (f.step !== undefined && f.step !== null) {
    assert.ok(Number.isFinite(f.step) && f.step > 0, `${where}: step > 0`);
  }
  if (f.supported_options !== undefined) {
    const select = f.category === C.TEXT && f.type === T.TEXT.SELECT;
    // The core accepts an empty list (normalizeSupportedOptions): a dynamic
    // select whose options only grow (the sources seen) starts empty.
    assert.ok(f.supported_options.length > 0 || select, `${where}: options`);
    const seen = new Set();
    for (const o of f.supported_options) {
      assert.equal(typeof o.label, 'string', `${where}: label is a string`);
      assert.ok(o.label.length > 0 && o.label === o.label.trim(), `${where}: label "${o.label}"`);
      assert.ok(
        Number.isInteger(o.value) || (select && typeof o.value === 'string' && o.value.trim()),
        `${where}: value ${o.value}`,
      );
      assert.ok(!seen.has(String(o.value)), `${where}: value ${o.value} unique`);
      seen.add(String(o.value));
    }
  }
}

/** Asserts every feature of a device, and that their external ids are unique. */
export function assertCoreDevice(device, where) {
  assert.equal(typeof device.name, 'string', `${where}: device name`);
  assert.equal(typeof device.external_id, 'string', `${where}: device external_id`);
  assert.ok(Array.isArray(device.features), `${where}: features`);
  const ids = new Set();
  for (const f of device.features) {
    const at = `${where} ${f.external_id}`;
    assert.ok(!ids.has(f.external_id), `${at}: unique external id`);
    ids.add(f.external_id);
    assertCoreFeature(f, at);
  }
  return device.features.length;
}
