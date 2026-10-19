// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™"). And none
// of them claims that something is encrypted: Gladys stores what it keeps in
// clear in its database.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const ENCRYPTED = /chiffr|encrypt|crypté/i;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url));

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = read(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

for (const file of [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'src/i18n.js',
]) {
  test(`${file}: never says "encrypted"`, () => {
    const text = read(file).toString('utf8');
    const line = text.split('\n').findIndex((l) => ENCRYPTED.test(l));
    assert.equal(line, -1, `"encrypted" on line ${line + 1}`);
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
  assert.match('stocké chiffré', ENCRYPTED);
  assert.match('stored encrypted', ENCRYPTED);
});

test('LICENSE names nobody', () => {
  const license = read('LICENSE').toString('utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});
