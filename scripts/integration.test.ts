/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueRequest, readConfig, retainUnavailable, samePublishedContent, writePages } from './update-data';

test('conservative defaults, aliases and generic queue retain values/rejections', async () => {
  expect(readConfig({}).requestSleep).toBe(3); expect(readConfig({}).concurrency).toBe(1);
  expect(readConfig({ CAPITAL_GROUP_TICKERS: 'CGUS, CGCP', MAX_FETCHES: '2' }).tickers).toEqual(['CGUS', 'CGCP']);
  const order: number[] = [];
  const one = enqueueRequest(async () => { order.push(1); return 42; });
  const bad = enqueueRequest(async () => { order.push(2); throw new Error('expected'); });
  const three = enqueueRequest(async () => { order.push(3); return 'ok'; });
  expect(await one).toBe(42); await expect(bad).rejects.toThrow('expected'); expect(await three).toBe('ok'); expect(order).toEqual([1,2,3]);
});
test('recursive retention keeps missing financial fields but accepts real zero', () => {
  expect(retainUnavailable({ yields: { secYield: null, dividendYield: 0 }, name: '—' }, { yields: { secYield: 3, dividendYield: 4 }, name: 'Fund' })).toEqual({ yields: { secYield: 3, dividendYield: 0 }, name: 'Fund' });
  expect(samePublishedContent(JSON.stringify({ generatedAt: 'old', source: { catalogReadAt: 'old', value: 0 } }), { generatedAt: 'new', source: { catalogReadAt: 'new', value: 0 } })).toBe(true);
});
test('pagination, stable writes, stale-page cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-pages-')); const url = new URL(`file://${dir}/`);
  try {
    const manifest = await writePages(url, 'CGUS', 'holdings', ['Name'], [{Name:'a'},{Name:'b'},{Name:'c'}], 2);
    expect(manifest.pages).toEqual(['holdings/001.json', 'holdings/002.json']); expect(manifest.totalRows).toBe(3);
    const before = await readFile(join(dir, 'holdings/001.json'), 'utf8');
    await writePages(url, 'CGUS', 'holdings', ['Name'], [{Name:'a'},{Name:'b'},{Name:'c'}], 2);
    expect(await readFile(join(dir, 'holdings/001.json'), 'utf8')).toBe(before);
    await writePages(url, 'CGUS', 'holdings', ['Name'], [{Name:'a'}], 2);
    expect(await readdir(join(dir, 'holdings'))).toEqual(['001.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline real CLI: ticker bound, unrequested retention, repeat stability, failure preservation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-cli-'));
  try {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await cp(new URL('update-data.ts', import.meta.url), join(dir, 'scripts/update-data.ts'));
    await cp(new URL('fixtures', import.meta.url), join(dir, 'scripts/fixtures'), { recursive: true });
    await mkdir(join(dir, 'api/capital-group/funds/KEEP'), { recursive: true });
    const unrelated = { ticker: 'KEEP', name: 'Existing published sentinel', holdings: 0, history: 0, dataFile: './funds/KEEP/meta.json' };
    await writeFile(join(dir, 'api/capital-group/funds/KEEP/meta.json'), JSON.stringify(unrelated));
    await writeFile(join(dir, 'api/capital-group/index.json'), JSON.stringify({ funds: [unrelated] }));
    const preload = `
const path = (name) => new URL('./scripts/fixtures/' + name, import.meta.url);
globalThis.fetch = async (input, init) => {
 const url = String(input);
 if (process.env.MOCK_FAIL) throw new Error('offline simulated provider failure');
 if (url.endsWith('exchange-traded-funds.html')) return new Response('<a href="/advisor/investments/exchange-traded-funds/details/cgus">CGUS</a><a href="/advisor/investments/exchange-traded-funds/details/cgcp">CGCP</a>');
 if (url.includes('/details/cgus')) {
   const data = await Bun.file(path('cgus-facts.json')).json();
   return new Response('<script>self.__next_f.push(' + JSON.stringify([1, '6:{"data":' + JSON.stringify(data) + '}']) + ')</script>');
 }
 if (url.includes('/CGUS/download/')) return new Response(await Bun.file(path('cgus-holdings.xlsx')).arrayBuffer());
 if (url.includes('/CGUS/historical-distributions')) return new Response(await Bun.file(path('cgus-distributions.json')).text());
 if (url.includes('/CGUS/premium-discount-details')) return new Response(await Bun.file(path('cgus-prices.json')).text());
 throw new Error('Unexpected request outside CGUS: ' + url);
};`;
    await writeFile(join(dir, 'preload.ts'), preload);
    const run = async (extra: Record<string,string> = {}) => {
      const env = { PATH: process.env.PATH, TICKERS:'CGUS', REQUEST_SLEEP:'0', MAX_RETRIES:'1', VERBOSE:'1', ...extra };
      const child = Bun.spawn([process.execPath, '--preload', './preload.ts', 'scripts/update-data.ts'], { cwd: dir, env, stdout:'pipe', stderr:'pipe' });
      const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      return { out,err,code };
    };
    const first = await run(); if (first.code) throw new Error(first.out + first.err);
    expect(first.out).toContain('1 of 3 funds');
    const indexPath = join(dir, 'api/capital-group/index.json');
    const index = JSON.parse(await readFile(indexPath,'utf8'));
    expect(index.funds.map((f: {ticker:string}) => f.ticker)).toEqual(['CGUS','KEEP']);
    expect(index.funds[1]).toEqual(unrelated);
    const metaPath = join(dir,'api/capital-group/funds/CGUS/meta.json');
    const before = await readFile(metaPath,'utf8'), indexBefore = await readFile(indexPath,'utf8');
    expect(JSON.parse(before).holdings.totalRows).toBeGreaterThan(65);
    const second = await run(); expect(second.code).toBe(0); expect(second.out).toContain('unchanged');
    expect(await readFile(metaPath,'utf8')).toBe(before); expect(await readFile(indexPath,'utf8')).toBe(indexBefore);
    const filtered = await run({ AUM:'999T:' }); expect(filtered.code).toBe(0); expect(filtered.out).toContain('skipped');
    expect(await readFile(metaPath,'utf8')).toBe(before); expect(await readFile(indexPath,'utf8')).toBe(indexBefore);
    // All provider skips are offline retention regression only, NEVER live acceptance.
    const failed = await run({ SKIP_ISSUER:'1', SKIP_YAHOO:'1', EDGAR_FALLBACK:'0' });
    expect(failed.code).toBe(1); expect(failed.out).toContain('left untouched');
    expect(await readFile(metaPath,'utf8')).toBe(before); expect(await readFile(indexPath,'utf8')).toBe(indexBefore);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);
