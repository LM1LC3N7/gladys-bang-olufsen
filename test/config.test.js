// -----------------------------------------------------------------------------
// The configuration typed by the user, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { MAX_VOLUME, POLL_INTERVAL } from '../src/constants.js';

test('addresses: IPv4 or host name, optional port, pasted URLs reduced', () => {
  assert.deepEqual(parseAddress('192.168.1.30'), { host: '192.168.1.30', port: 80 });
  assert.deepEqual(parseAddress(' http://192.168.1.30:8080/api/v1 '), {
    host: '192.168.1.30',
    port: 8080,
  });
  assert.deepEqual(parseAddress('Beosound-Level.local'), {
    host: 'beosound-level.local',
    port: 80,
  });
  for (const bad of ['', '999.1.1.1', '1.2.3', 'a_b', 'host:0', 'host:70000', '-x.local', null]) {
    assert.equal(parseAddress(bad), undefined, String(bad));
  }
});

test('the list of addresses: separators, duplicates, invalid entries reported', () => {
  const config = normalizeConfig({ addresses: '192.168.1.30, 192.168.1.30;192.168.1.31 bad_one' });
  assert.deepEqual(
    config.addresses.map((a) => a.host),
    ['192.168.1.30', '192.168.1.31'],
  );
  assert.deepEqual(config.invalid, ['bad_one']);
});

test('the refresh interval and the volume cap are bounded', () => {
  assert.equal(normalizeConfig().pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, POLL_INTERVAL.min);
  assert.equal(normalizeConfig({ poll_interval: '9999' }).pollInterval, POLL_INTERVAL.max);
  assert.equal(normalizeConfig().maxVolume, MAX_VOLUME.default);
  assert.equal(normalizeConfig({ max_volume: 0 }).maxVolume, MAX_VOLUME.min);
  assert.equal(normalizeConfig({ max_volume: 150 }).maxVolume, 100);
  assert.equal(normalizeConfig({ max_volume: '45' }).maxVolume, 45);
  for (const bad of ['', 'loud', NaN, {}]) {
    assert.equal(normalizeConfig({ max_volume: bad }).maxVolume, MAX_VOLUME.default, String(bad));
  }
});
