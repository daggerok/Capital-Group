/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('evidence/ui-parity.json'));
for (const name of ['app.tsx','index.html']) test(`${name}: exact pinned sibling copy after allowed substitutions`, () => {
  const source = read(`evidence/ui-reference/${name}`);
  expect(createHash('sha256').update(source).digest('hex')).toBe(manifest.files[name].referenceSha256);
  const expected = manifest.substitutions.reduce((text: string, sub: {from:string;to:string}) => text.split(sub.from).join(sub.to), source);
  expect(read(name)).toBe(expected);
});
test('Frequency display rule: none/unknown/dashes and unchanged cadence labels', () => {
  const source = read('app.tsx');
  const body = source.slice(source.indexOf('function formatDividendFrequency'), source.indexOf('\n}',source.indexOf('function formatDividendFrequency'))+2);
  const js = new Bun.Transpiler({ loader:'ts' }).transformSync(body);
  const format = new Function(`${js}; return formatDividendFrequency`)();
  for (const value of [null,undefined,'','   ','-','—','–','‐','None']) expect(format(value)).toBe('00 - None');
  expect(format('Unknown')).toBe('00 - Unknown'); expect(format('Monthly')).toBe('01 - Monthly'); expect(format('Quarterly')).toBe('04 - Quarterly');
});
test('published initial seed is exactly the verified three-fund smoke output', () => {
  const hashes = JSON.parse(read('evidence/live/hashes-2.json'));
  for (const [file,hash] of Object.entries(hashes)) expect(createHash('sha256').update(read(`api/capital-group/${file}`)).digest('hex')).toBe(hash);
});
