/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  CONTROL_NAMES, createRequestGate, createRequestQueue, fetchWithRetry, issuerFrequency, issuerPricesUrl, parseIssuerCatalog,
  parseIssuerDistributions, parseIssuerFacts, parseIssuerFlight, parseIssuerHoldings, parseIssuerPrices, parseIssuerReturns,
  readConfig, resolveControls, installSystemCa, isCertError, retainUnavailable, samePublishedContent, sourceDate, sourceNumber, unzipIssuerWorkbook,
  withRequestLane, workbookRows, writePages, removeStalePages,
  runUpdater, setApiRoot, writeFileAtomic, writeIfChanged, mergeHistoryRows, ageGuardReturns, isoStamp, readCursorScopes, writeCursorScope,
  loadFundTickerMap, resetSecTableCaches, RUN_SOFT_DEADLINE_MS,
  formatIssuerDate, normalizeNumberText, numberOrNull, formatEdgarDate, toIsoDate, isoToEpoch, parseRange, parseAumRange, HISTORY_HEADERS, YAHOO_HISTORY_HEADERS, navTotalReturnDays, normalizeHoldingName, normalizeHoldingNameCore, cleanHoldingTicker, nportUrlFor, parseNportAccessions, parseFundTickerMap, parseCompanyTickerMap, edgarSeriesFilingsUrl, parseEdgarAtomFilings, parseNport, pickEftsCik, parseChart, annualizedToTotal, totalToAnnualized, indicatedYield, inferDistributionFrequency, priceReturns, lastCompletedQuarterEnd, deriveCatalogMetrics, returnsBasisLabel, performanceAsOf,
} from './update-data';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Inline samples (small, representative shapes of the issuer payloads)
// ---------------------------------------------------------------------------

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Minimal ZIP writer (stored or deflated entries) so workbooks can be built inline. */
function zip(files: Record<string, string>, deflate = false): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [name, xml] of Object.entries(files)) {
    const path = Buffer.from(name), raw = Buffer.from(xml), data = deflate ? deflateRawSync(raw) : raw, crc = crc32(raw), method = deflate ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, path, data); directory.push(central, path); offset += local.length + path.length + data.length;
  }
  const end = Buffer.alloc(22), dir = Buffer.concat(directory), count = Object.keys(files).length; end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const HOLDINGS_HEADER = ['Security Name', 'Ticker', 'ISIN', 'CUSIP', 'Asset Type', 'Market Value', 'Shares or Principal Amount', 'Percent of Net Assets'];
function holdingsWorkbook(ticker: string, rows: string[][]): Buffer {
  const line = (r: number, values: string[]) => `<row r="${r}">${values.map((v, i) => cell(`${String.fromCharCode(65 + i)}${r}`, v)).join('')}</row>`;
  const sheet = `<worksheet><sheetData>${line(1, [`${ticker} - Capital Group Core Equity ETF Holdings As Of 9/24/2026`])}${line(2, HOLDINGS_HEADER)}${rows.map((row, i) => line(3 + i, row)).join('')}</sheetData></worksheet>`;
  return zip({ 'xl/worksheets/sheet1.xml': sheet }, true);
}
const HOLDINGS_ROWS = [
  ['Microsoft Corp', 'MSFT', 'US5949181045', '594918104', 'Equity', '1000', '10', '0.05'],
  ['Amazon.com Inc', 'AMZN', 'US0231351067', '023135106', 'Equity', '2000', '20', '0.0762'],
  ['Cash', '--', '--', '--', 'Cash', '10', '10', '0.01'],
];
const factsSample = (ticker = 'CGUS') => ({
  details: {
    abbreviatedName: ticker, name: 'Capital Group Core Equity ETF', assetClass: 'Equity', subAssetClass: 'U.S.', cikNumber: '1870102',
    inceptionDate: '2/22/22', cusip: '14020V108', benchmarkName: 'S&P 500 Index',
    expenseRatio: { grossExpenseRatio: '0.33', netExpenseRatio: '0.33' },
    yield: { asOfDate: '8/31/26', grossSecYield: '0.77', netSecYield: '0.77', navDistributionRate: '0.82' },
    fundFacts: { primaryExchange: 'NYSE Arca, Inc.', regularDividendsPaid: 'Mar., Jun., Sep., Dec.' },
    monthlyReturns: { asOfDate: '8/31/26', navMonth1: '0.83', navYtdMonthly: '12.54', navYear1: '17.81', navYear3: '21.02', navYear5: null, navYear10: null, navLifetime: '10.1', marketPriceYear1: '17.77' },
    quarterlyReturns: { asOfDate: '8/31/26', navYear1: '17.81' },
  },
  dailyDetails: {
    fundFacts: { assetsInMillionDate: '9/24/26', assetsInMillions: '11925.5' },
    priceDistribution: { navPrice: '44.89', marketPrice: '44.91', premiumDiscount: '0.06', asOfDate: '9/25/26' },
  },
});
const pricesSample = (ticker = 'CGUS') => ({
  inceptionDate: '02/22/2022', quotron: ticker,
  premiumDiscountDetails: [
    { asOfDate: '02/22/2022', period: 'daily', values: { nav: '24.63', marketPrice: '24.63', premiumDiscount: null } },
    { asOfDate: '02/23/2022', period: 'daily', values: { nav: '24.25', marketPrice: '24.26', premiumDiscount: '0.04' } },
    { asOfDate: '02/24/2022', period: 'daily', values: { nav: null, marketPrice: null, premiumDiscount: null } },
  ],
});
const distributionsSample = {
  asOfDate: '09/25/2026',
  distributions: [
    { exDate: '06/29/2022', recordDate: '06/30/2022', payDate: '07/01/2022', reinvestNav: null, totalDistributions: '0.0475' },
    { exDate: '03/30/2022', recordDate: '03/31/2022', payDate: '04/01/2022', reinvestNav: null, totalDistributions: '0.0287' },
  ],
};
const flightHtml = (data: unknown, split = 40) => {
  const stream = `6:[["$","$L",null,{"data":${JSON.stringify(data)}}]]`;
  return [stream.slice(0, split), stream.slice(split)].map((text) => `<script>self.__next_f.push(${JSON.stringify([1, text])})</script>`).join('');
};

describe('issuer source parsers', () => {
  test('strict dates and numbers retain zero and negatives, reject missing', () => {
    expect([null, undefined, '', '\u2014', '--', 'abc'].map(sourceNumber)).toEqual([null, null, null, null, null, null]);
    expect(sourceNumber('0')).toBe(0); expect(sourceNumber('-1.5%')).toBe(-1.5);
    expect(sourceNumber('5.94918104E8')).toBe(594918104);
    expect(sourceDate('9/24/26')).toBe('2026-09-24'); expect(sourceDate('02/30/2026')).toBeNull();
    expect(sourceDate('2024-02-29')).toBe('2024-02-29'); expect(sourceDate('2026-13-01')).toBeNull();
  });
  test('catalog is sorted, deduplicated, never silently accepts a challenge', () => {
    expect(parseIssuerCatalog('<a href="/advisor/investments/exchange-traded-funds/details/cgus">CGUS</a><a href="/advisor/investments/exchange-traded-funds/details/cgcp">CGCP</a><a href="/advisor/investments/exchange-traded-funds/details/cgus">again</a>')).toEqual(['CGCP', 'CGUS']);
    expect(() => parseIssuerCatalog('<title>American Funds</title>')).toThrow('no fund links');
  });
  test('Flight accepts arbitrary chunk boundaries, JSON escapes and rejects other funds', () => {
    const data = factsSample(); (data.details as any).summaryDescription = 'Escaped } ] " \\ text';
    for (const split of [5, 40, 77]) expect(parseIssuerFlight(flightHtml(data, split), 'CGUS')).toEqual(data as any);
    expect(() => parseIssuerFlight(flightHtml(data), 'CGCP')).toThrow('missing');
    expect(() => parseIssuerFlight('<script>alert(1)</script>', 'CGUS')).toThrow();
  });
  test('facts preserve CIK padding, units, frequency and ignore a non-quarter-end quarterly block', () => {
    const result = parseIssuerFacts(factsSample(), 'CGUS');
    expect(result.name).toContain('Capital Group'); expect(result.netAssets).toBe(11925.5e6);
    expect(result.trustCik).toBe('0001870102'); expect(result.inception).toBe('2022-02-22');
    expect(result.netExpense).toBe(0.33); expect(result.secYield).toBe(0.77);
    expect(result.quarterEnd.asOfDate).toBeNull();
    expect(result.frequency).toEqual({ frequency: 'Quarterly', paymentsPerYear: 4 });
    expect(() => parseIssuerFacts(factsSample('CGCP'), 'CGUS')).toThrow('mismatch');
  });
  test('returns mapping every tenor; reordered, zero, negative, missing and unknown values', () => {
    const row = { navYear10: '-4', unknown: '999', asOfDate: '08/31/2026', navLifetime: '5', navYtdMonthly: '0', navYear1: '1', navMonth1: '-1', navYear5: '3', navYear3: '2' };
    expect(parseIssuerReturns(row)).toEqual({ asOfDate: '2026-08-31', mo1: -1, ytd: 0, yr1: 1, yr3: 2, yr5: 3, yr10: -4, sinceInception: 5 });
    expect(parseIssuerReturns({ navYear3: null, navYear1: '' }).yr1).toBeNull();
    expect(parseIssuerReturns({ marketPriceYear1: '2' }, 'marketPrice').yr1).toBe(2);
    expect(issuerFrequency('Unrecognized')).toEqual({ frequency: 'Unknown', paymentsPerYear: null });
    expect(issuerFrequency(null).paymentsPerYear).toBeNull();
  });
  test('XLSX holdings: fractions to percent, CUSIP leading zeros, stable sort, ticker check', () => {
    const book = holdingsWorkbook('CGUS', HOLDINGS_ROWS);
    const parsed = parseIssuerHoldings(book, 'CGUS');
    expect(parsed.asOfDate).toBe('2026-09-24'); expect(parsed.rows.length).toBe(3);
    expect(parsed.rows[0].Ticker).toBe('AMZN'); expect(parsed.rows[0].Weight).toBe('7.62');
    expect(parsed.rows[0].Identifier).toBe('023135106');
    expect(parsed.rows.find((r) => r.Ticker === 'MSFT')?.Identifier).toBe('594918104');
    expect(parsed.rows.find((r) => r.Name === 'Cash')?.Ticker).toBe('');
    expect(parseIssuerHoldings(book, 'CGUS')).toEqual(parsed);
    expect(() => parseIssuerHoldings(book, 'CGCP')).toThrow('mismatch');
    expect(() => unzipIssuerWorkbook(book.subarray(0, 100))).toThrow();
    expect(unzipIssuerWorkbook(zip({ 'xl/a.xml': '<a/>' })).get('xl/a.xml')).toBe('<a/>');
  });
  test('OOXML sparse columns, shared strings, inline strings and XML entities', () => {
    const files = new Map([['xl/sharedStrings.xml', '<sst><si><t>A &amp; B</t></si></sst>'], ['xl/worksheets/sheet2.xml', '<worksheet><row r="1"><c r="C1" t="s"><v>0</v></c><c r="E1" t="inlineStr"><is><t>Equity</t></is></c><c r="F1"><v>0</v></c></row></worksheet>']]);
    expect(workbookRows(files)[0][0][2]).toBe('A & B'); expect(workbookRows(files)[0][0][4]).toBe('Equity'); expect(workbookRows(files)[0][0][5]).toBe('0');
  });
  test('daily prices and all distributions from JSON samples', () => {
    const points = parseIssuerPrices(pricesSample(), 'CGUS');
    expect(points.length).toBe(2); expect(points[0]).toEqual({ date: '2022-02-22', nav: 24.63, marketPrice: 24.63, premiumDiscount: null });
    expect(parseIssuerPrices({ quotron: 'CGUS', premiumDiscountDetails: [{ values: null }] }, 'CGUS')).toEqual([]);
    expect(() => parseIssuerPrices(pricesSample(), 'CGCP')).toThrow('mismatch');
    const d = parseIssuerDistributions(distributionsSample);
    expect(d[0].exDate).toBe('2022-03-30'); expect(d[0].amount).toBe(0.0287); expect(d.length).toBe(2);
    expect(parseIssuerDistributions({ distributions: [{ exDate: '1/1/26', totalDistributions: '0' }] })[0].amount).toBe(0);
    expect(() => parseIssuerDistributions({})).toThrow();
    expect(issuerPricesUrl('CGUS', '2022-02-22', '2026-09-27')).toContain('fromDate=2022-02-22');
    expect(() => issuerPricesUrl('CGUS', '', '')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Controls: resolver, defaults, README, --help and workflow stay in sync
// ---------------------------------------------------------------------------

const configFile = () => JSON.parse(read('scripts/update-data.config.json'));

describe('controls', () => {
  test('precedence: file < advanced < nonblank input < environment, with brand aliases', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'CGUS' }, { CONCURRENCY: 3, TICKERS: 'CGCP' }, { CONCURRENCY: '4', TICKERS: '' }, { CAPITAL_GROUP_CONCURRENCY: '5', CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('CGCP');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolveControls({ TICKERS: 'CGUS' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({ TICKERS: 'CGUS' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { CAPITAL_GROUP_LIMIT: '7' }).MAX_FETCHES).toBe('7');
    expect(resolveControls({ HISTORY_PAGE_SIZE: 10 }, {}, {}, { HISTORICAL_PAGE_SIZE: '20' }).HISTORY_PAGE_SIZE).toBe('20');
    expect(resolveControls({}, {}, {}, { UNRELATED: 'x' })).toEqual({});
  });

  test('invalid layers, unknown keys, non-scalars, newlines and invalid values are rejected', () => {
    for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_RETRIES: 1.5 }, { MAX_FETCHES: 1.5 },
      { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { HISTORY_RANGE: '5 years' }, { AUM: '1:2:3' }, { AUM: '42' }, { TER: '5:1' }, { TER: '1' },
      { PERFORMANCE_1Y: 'x:y' }, { TOTAL_RETURN_10Y: '9:1' }, { TICKERS: ['CGUS'] }, null, []]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { CAPITAL_GROUP_SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow('integer >= 1');
    expect(() => resolveControls(configFile(), 'x')).toThrow();
    expect(() => resolveControls(configFile(), {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => readConfig({ MAX_RETRIES: 'abc' })).toThrow();
  });

  test('config file holds every control, defaults resolve to the documented values, MAX_RETRIES >= 1', () => {
    const file = configFile();
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
    const scheduled = resolveControls(file, {}, {}, {});
    expect(scheduled).toEqual(file);
    const config = readConfig(scheduled);
    expect(config.tickers).toEqual([]); expect(config.maxFetches).toBe(0); expect(config.requestSleep).toBe(3); expect(config.concurrency).toBe(1);
    expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000); expect(config.maxRetries).toBe(2);
    expect(config.historyRange).toBe('max'); expect(config.edgarFallback).toBe(true); expect(config.skipYahoo).toBe(false);
    expect(config.skipIssuer).toBe(false); expect(config.storeRawDownloads).toBe(false);
    expect(config.catalogUrl).toBe('https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html');
    expect(readConfig({}).maxRetries).toBe(2);
  });

  test('filters and presets reach the parsed config', () => {
    const config = readConfig(resolveControls({ AUM: 'small', TER: ':0.5', DIVIDEND_YIELD: '1:', SEC_YIELD: '2:3', PERFORMANCE_3Y: '5:', TOTAL_RETURN_YTD: ':10', TICKERS: 'cgus, CGCP;cgmu' }));
    expect(config.aumRange).toEqual({ min: 300_000_000, max: 2_000_000_000 }); expect(config.terRange).toEqual({ min: undefined, max: 0.5 });
    expect(config.dividendYieldRange?.min).toBe(1); expect(config.secYieldRange).toEqual({ min: 2, max: 3 });
    expect(config.performanceRanges['3Y']?.min).toBe(5); expect(config.totalReturnRanges.YTD?.max).toBe(10);
    expect(config.tickers).toEqual(['CGUS', 'CGCP', 'CGMU']);
    expect(readConfig(resolveControls({ HISTORY_RANGE: '5Y' })).historyRange).toBe('5y');
  });

  test('SEC contact: default is the owner descriptor and a protected value wins only when nonblank', () => {
    const file = configFile();
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig(resolveControls(file)).secUa).toBe(file.SEC_UA);
    expect(readConfig({}).secUa).toBe(file.SEC_UA);
    expect(read('scripts/update-data.ts')).not.toMatch(/example\.com/);
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  });

  test('README controls table, --help and CONTROL_NAMES are in sync', async () => {
    const doc = read('README.md');
    for (const name of CONTROL_NAMES) expect(doc).toContain('`' + name + '`');
    expect(doc).toContain('scripts/update-data.config.json');
    const child = Bun.spawn([process.execPath, 'scripts/update-data.ts', '--help'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
    const [help, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
      expect(help).toContain(tenor ? `${tenor[1]}_{YTD,1Y,3Y,5Y,10Y}` : name);
    }
    expect(help).not.toContain('daggerok@gmail.com');
  });

  test('README keeps the standard structure and no repository-process leftovers', () => {
    const doc = read('README.md');
    const order = ['## Using Bun', '## Updating the static Capital Group data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
    let last = -1;
    for (const heading of order) { const at = doc.indexOf(`\n${heading}\n`); expect(at).toBeGreaterThan(last); last = at; }
    expect(doc).not.toMatch(/worklog|evidence|fixtures|config-docs|\.prompt/i);
    expect(doc).toContain('bun install --frozen-lockfile'); expect(doc).toContain('bun build --target=bun scripts/update-data.ts --outfile=/dev/null'); expect(doc).toContain('git diff --check');
  });

  test('workflow: <= 25 inputs, advanced JSON, shared resolver, fixed output, protected SEC_UA, no input interpolation', () => {
    const actual = read('.github/workflows/update-data.yml');
    const names = [...actual.slice(actual.indexOf('    inputs:'), actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
    for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as any);
    expect(actual).toContain("default: '{}'");
    expect(actual).toContain("cron: '0 0 * * 0'"); expect(actual).not.toMatch(/^  push:/m);
    expect(actual).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(actual).toContain('resolveControls(file, advanced, individual, protectedVars)');
    expect(actual).toContain('toJSON(inputs)'); expect(actual).not.toMatch(/\$\{\{\s*inputs\./);
    expect(actual).not.toMatch(/OUTPUT_DIR|output_dir/i);
    expect(actual.match(/git add (\S+)/g)).toEqual(['git add api/capital-group']);
    expect(actual.match(/api\/[\w-]+/g)!.every((p) => p === 'api/capital-group')).toBe(true);
    expect(actual).toContain('persist-credentials: false'); expect(actual).toContain('timeout-minutes: 30');
    expect(actual).toContain('if: ${{ !cancelled() }}');
    // Controls not exposed as individual inputs stay reachable through advanced and the config file.
    const hidden = CONTROL_NAMES.filter((name) => !names.includes(name.toLowerCase()));
    expect(hidden.sort()).toEqual(['CATALOG_URL', 'SEC_UA', 'SKIP_ISSUER', 'STORE_RAW_DOWNLOADS', 'USE_SYSTEM_CA', 'VERBOSE']);
    expect(resolveControls(configFile(), Object.fromEntries(hidden.map((name) => [name, configFile()[name]])))).toEqual(configFile());
  });
});

// ---------------------------------------------------------------------------
// Request pacing, retention and page writing
// ---------------------------------------------------------------------------

test('generic queue retains values, rejections and order', async () => {
  const enqueueRequest = createRequestQueue();
  const order: number[] = [];
  const one = enqueueRequest(async () => { order.push(1); return 42; });
  const bad = enqueueRequest(async () => { order.push(2); throw new Error('expected'); });
  const three = enqueueRequest(async () => { order.push(3); return 'ok'; });
  expect(await one).toBe(42); await expect(bad).rejects.toThrow('expected'); expect(await three).toBe('ok'); expect(order).toEqual([1, 2, 3]);
});

// Virtual time proves reservations use the SAME lane after early/late wakeups.
test('lane queue spaces simultaneous callers and never catches up after a late timer', async () => {
  let now = 0;
  const waits: number[] = [], starts: number[] = [];
  const gate = createRequestGate(100, {
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms + (waits.length === 1 ? 250 : 0); },
  });
  await Promise.all(Array.from({ length: 4 }, async () => { await gate(); starts.push(now); }));
  expect(starts).toEqual([0, 350, 450, 550]);
  expect(waits).toEqual([100, 100, 100]);
});

test('early timers are rechecked, zero sleep is immediate, independent gates have no shared tail', async () => {
  let now = 0, sleeps = 0;
  const gate = createRequestGate(100, {
    now: () => now,
    sleep: async (ms) => { now += ++sleeps === 1 ? ms - 10 : ms; },
  });
  await gate(); await gate();
  expect(now).toBe(100); expect(sleeps).toBe(2);
  const zero = createRequestGate(0, { now: () => now, sleep: async () => { throw new Error('unexpected sleep'); } });
  await zero(); await zero();
  let release!: () => void;
  const blocked = createRequestGate(100, { now: () => now, sleep: async (ms) => { await new Promise<void>((r) => { release = r; }); now += ms; } });
  await blocked(); const pending = blocked();
  await Promise.resolve();
  await zero(); // Another lane does not join the blocked lane's queue.
  expect(typeof release).toBe('function'); release(); await pending;
});

test('failed timer does not poison its lane queue', async () => {
  let now = 0, fail = true;
  const gate = createRequestGate(100, { now: () => now, sleep: async (ms) => {
    if (fail) { fail = false; throw new Error('timer failure'); }
    now += ms;
  } });
  await gate(); await expect(gate()).rejects.toThrow('timer failure'); await gate();
  expect(now).toBe(100);
});

test('real HTTP: 1, 3 and 15 worker lanes overlap requests, retain spacing across funds, and improve throughput', async () => {
  const starts = new Map<string, number[]>();
  let active = 0, peak = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const lane = new URL(request.url).pathname.split('/')[1]!;
    const times = starts.get(lane) ?? []; times.push(performance.now()); starts.set(lane, times);
    peak = Math.max(peak, ++active);
    await Bun.sleep(20); active--;
    return new Response('ok');
  } });
  try {
    const durations: number[] = [];
    for (const concurrency of [1, 3, 15]) {
      starts.clear(); peak = 0;
      const funds = Array.from({ length: 15 }, (_, i) => i);
      const before = performance.now();
      await Promise.all(Array.from({ length: concurrency }, (_, lane) => withRequestLane(60, async () => {
        while (funds.length) {
          const fund = funds.shift()!;
          for (let request = 0; request < 3; request++) {
            const response = await fetchWithRetry(`${server.url}${lane}/${fund}/${request}`, 'local pacing regression', {}, 0);
            expect(await response.text()).toBe('ok');
          }
        }
      })));
      durations.push(performance.now() - before);
      expect(starts.size).toBe(concurrency);
      expect(peak).toBe(concurrency);
      expect([...starts.values()].reduce((n, times) => n + times.length, 0)).toBe(45);
      // These are server ARRIVALS, not client starts: allow connection jitter.
      for (const times of starts.values()) {
        for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(40);
      }
    }
    // Wide ratio tolerance for busy CI; a global request gate cannot pass.
    expect(durations[1]!).toBeLessThan(durations[0]! * 0.65);
    expect(durations[2]!).toBeLessThan(durations[0]! * 0.3);
  } finally { server.stop(true); }
}, 15000);

test('retry and non-retryable failures stay in their own lane without stalling other workers', async () => {
  const starts = new Map<string, number[]>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const lane = new URL(request.url).pathname.slice(1);
    const times = starts.get(lane) ?? []; times.push(performance.now()); starts.set(lane, times);
    return new Response('sample', { status: lane === 'retry' && times.length === 1 ? 429 : lane === 'terminal' ? 404 : 200 });
  } });
  try {
    await Promise.all([
      withRequestLane(60, async () => {
        const result = await fetchWithRequestRetry(`${server.url}retry`);
        expect(result.status).toBe(200); await result.text();
      }),
      withRequestLane(60, async () => {
        await expect(fetchWithRetry(`${server.url}terminal`, 'terminal sample', {}, 2)).rejects.toThrow('HTTP 404');
        const result = await fetchWithRetry(`${server.url}healthy`, 'healthy sample', {}, 0); await result.text();
      }),
    ]);
    expect(starts.get('terminal')!.length).toBe(1);
    expect(starts.get('retry')!.length).toBe(2);
    expect(starts.get('retry')![1]! - starts.get('retry')![0]!).toBeGreaterThanOrEqual(60);
    expect(starts.get('healthy')![0]! - starts.get('terminal')![0]!).toBeGreaterThanOrEqual(40);
    expect(starts.get('healthy')![0]!).toBeLessThan(starts.get('retry')![1]!);
  } finally { server.stop(true); }
}, 5000);
const fetchWithRequestRetry = (url: string) => fetchWithRetry(url, 'retry sample', {}, 1);

test('recursive retention keeps missing financial fields but accepts real zero', () => {
  expect(retainUnavailable({ yields: { secYield: null, dividendYield: 0 }, name: '\u2014' }, { yields: { secYield: 3, dividendYield: 4 }, name: 'Fund' })).toEqual({ yields: { secYield: 3, dividendYield: 0 }, name: 'Fund' });
  expect(samePublishedContent(JSON.stringify({ generatedAt: 'old', source: { catalogReadAt: 'old', value: 0 } }), { generatedAt: 'new', source: { catalogReadAt: 'new', value: 0 } })).toBe(true);
});

test('pagination, stable writes, stale-page cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-pages-')); const url = new URL(`file://${dir}/`);
  try {
    const manifest = await writePages(url, 'CGUS', 'holdings', ['Name'], [{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }], 2);
    expect(manifest.pages).toEqual(['holdings/001.json', 'holdings/002.json']); expect(manifest.totalRows).toBe(3);
    const before = await readFile(join(dir, 'holdings/001.json'), 'utf8');
    await writePages(url, 'CGUS', 'holdings', ['Name'], [{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }], 2);
    expect(await readFile(join(dir, 'holdings/001.json'), 'utf8')).toBe(before);
    const shrunk = await writePages(url, 'CGUS', 'holdings', ['Name'], [{ Name: 'a' }], 2);
    // pages are written first; stale pages go only after meta.json (removeStalePages is the later step)
    expect((await readdir(join(dir, 'holdings'))).sort()).toEqual(['001.json', '002.json']);
    await removeStalePages(url, 'holdings', new Set(shrunk.pages));
    expect(await readdir(join(dir, 'holdings'))).toEqual(['001.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Offline CLI regression with inline provider responses (never live acceptance)
// ---------------------------------------------------------------------------

test('offline CLI: ticker bound, unrequested retention, repeat stability, filters, failure preservation, strict controls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-cli-'));
  try {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await cp(new URL('update-data.ts', import.meta.url), join(dir, 'scripts/update-data.ts'));
    await cp(new URL('update-data.config.json', import.meta.url), join(dir, 'scripts/update-data.config.json'));
    await mkdir(join(dir, 'api/capital-group/funds/KEEP'), { recursive: true });
    const unrelated = { ticker: 'KEEP', name: 'Existing published sentinel', holdings: 0, history: 0, dataFile: './funds/KEEP/meta.json' };
    await writeFile(join(dir, 'api/capital-group/funds/KEEP/meta.json'), JSON.stringify(unrelated));
    await writeFile(join(dir, 'api/capital-group/index.json'), JSON.stringify({ funds: [unrelated] }));
    await writeFile(join(dir, 'holdings.xlsx'), holdingsWorkbook('CGUS', HOLDINGS_ROWS));
    await writeFile(join(dir, 'prices.json'), JSON.stringify(pricesSample()));
    await writeFile(join(dir, 'distributions.json'), JSON.stringify(distributionsSample));
    await writeFile(join(dir, 'facts.html'), flightHtml(factsSample()));
    const preload = `
globalThis.fetch = async (input) => {
 const url = String(input);
 if (process.env.MOCK_FAIL) throw new Error('offline simulated provider failure');
 const file = (name) => Bun.file(new URL('./' + name, import.meta.url));
 if (url.endsWith('exchange-traded-funds.html')) return new Response('<a href="/advisor/investments/exchange-traded-funds/details/cgus">CGUS</a><a href="/advisor/investments/exchange-traded-funds/details/cgcp">CGCP</a>');
 if (url.includes('/details/cgus')) return new Response(await file('facts.html').text());
 if (url.includes('/CGUS/download/')) return new Response(await file('holdings.xlsx').arrayBuffer());
 if (url.includes('/CGUS/historical-distributions')) return new Response(await file('distributions.json').text());
 if (url.includes('/CGUS/premium-discount-details')) return new Response(await file('prices.json').text());
 throw new Error('Unexpected request outside CGUS: ' + url);
};`;
    await writeFile(join(dir, 'preload.ts'), preload);
    const run = async (extra: Record<string, string> = {}) => {
      const env = { PATH: process.env.PATH, TICKERS: 'CGUS', REQUEST_SLEEP: '0', MAX_RETRIES: '1', VERBOSE: '1', ...extra };
      const child = Bun.spawn([process.execPath, '--preload', './preload.ts', 'scripts/update-data.ts'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };
    const first = await run(); if (first.code) throw new Error(first.out + first.err);
    expect(first.out).toContain('1 of 3 funds');
    expect(first.out).not.toContain('daggerok@gmail.com'); // SEC_UA is redacted in config logs
    const indexPath = join(dir, 'api/capital-group/index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    // CGCP is listed by the catalog but not requested: it gets a seed row (dataFile null), KEEP is untouched
    expect(index.funds.map((f: { ticker: string }) => f.ticker)).toEqual(['CGCP', 'CGUS', 'KEEP']);
    expect(index.funds[0]).toMatchObject({ ticker: 'CGCP', dataFile: null, holdings: 0 });
    expect(index.funds[2]).toEqual(unrelated);
    expect(first.out).toContain('NEW FUNDS: CGCP, CGUS');
    const metaPath = join(dir, 'api/capital-group/funds/CGUS/meta.json');
    const before = await readFile(metaPath, 'utf8'), indexBefore = await readFile(indexPath, 'utf8');
    expect(JSON.parse(before).holdings.totalRows).toBe(3);
    const second = await run(); expect(second.code).toBe(0); expect(second.out).toContain('unchanged');
    expect(await readFile(metaPath, 'utf8')).toBe(before); expect(await readFile(indexPath, 'utf8')).toBe(indexBefore);
    const filtered = await run({ AUM: '999T:' }); expect(filtered.code).toBe(0); expect(filtered.out).toContain('skipped');
    expect(await readFile(metaPath, 'utf8')).toBe(before); expect(await readFile(indexPath, 'utf8')).toBe(indexBefore);
    // All provider skips are offline retention regression only, NEVER live acceptance.
    const failed = await run({ SKIP_ISSUER: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0' });
    expect(failed.code).toBe(1); expect(failed.out).toContain('left untouched');
    expect(await readFile(metaPath, 'utf8')).toBe(before); expect(await readFile(indexPath, 'utf8')).toBe(indexBefore);
    // Strict controls: invalid values fail before any request or write.
    for (const bad of [{ MAX_RETRIES: '0' }, { CONCURRENCY: 'many' }, { HISTORY_RANGE: 'forever' }, { MOCK_FAIL: '1', SKIP_YAHOO: 'maybe' }]) {
      const rejected = await run(bad); expect(rejected.code).toBe(1); expect(rejected.err).toMatch(/MAX_RETRIES|CONCURRENCY|HISTORY_RANGE|SKIP_YAHOO/);
    }
    expect(await readFile(metaPath, 'utf8')).toBe(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);

// ---------------------------------------------------------------------------
// Shared helpers: numbers, dates, SEC/EDGAR, Yahoo charts, derived metrics
// ---------------------------------------------------------------------------
describe('parseRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseRange('', 'X')).toBeUndefined();
    expect(parseRange(':', 'X')).toBeUndefined();
  });

  test('inclusive bounds', () => {
    expect(parseRange('1:5', 'X')).toEqual({ min: 1, max: 5 });
    expect(parseRange('2:', 'X')).toEqual({ min: 2, max: undefined });
    expect(parseRange(':3', 'X')).toEqual({ min: undefined, max: 3 });
  });

  test('percent signs and $ signs are optional', () => {
    expect(parseRange('0.1%:0.5%', 'X')).toEqual({ min: 0.1, max: 0.5 });
    expect(parseRange('$1:$2', 'X')).toEqual({ min: 1, max: 2 });
  });

  test('colonless values are rejected', () => {
    expect(() => parseRange('15', 'X')).toThrow(/colon is required/);
  });

  test('min greater than max is rejected', () => {
    expect(() => parseRange('5:1', 'X')).toThrow(/must not exceed/);
  });
});

describe('parseAumRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange(':')).toBeUndefined();
  });

  test('numeric bounds with K/M/B/T suffixes', () => {
    expect(parseAumRange('10M:2B')).toEqual({ min: 10_000_000, max: 2_000_000_000 });
    expect(parseAumRange('1B:')).toEqual({ min: 1_000_000_000, max: undefined });
  });

  test('preset bounds', () => {
    expect(parseAumRange('nano')).toEqual({ min: 0, max: 10_000_000 });
    expect(parseAumRange('micro')).toEqual({ min: 10_000_000, max: 300_000_000 });
    expect(parseAumRange('small')).toEqual({ min: 300_000_000, max: 2_000_000_000 });
    expect(parseAumRange('mid')).toEqual({ min: 2_000_000_000, max: 10_000_000_000 });
    expect(parseAumRange('large')).toEqual({ min: 10_000_000_000, max: undefined });
  });

  test('colonless values are rejected', () => {
    expect(() => parseAumRange('42')).toThrow(/colon is required/);
  });
});

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

describe('normalizeNumberText', () => {
  test('expands scientific notation', () => {
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744');
    expect(normalizeNumberText('1.5e-3')).toBe('0.0015');
  });

  test('keeps plain numbers and text untouched', () => {
    expect(normalizeNumberText('1,234.56')).toBe('1234.56');
    expect(normalizeNumberText('Apple Inc')).toBe('Apple Inc');
    expect(normalizeNumberText('')).toBe('');
    expect(normalizeNumberText('-')).toBe('-');
  });
});

describe('numberOrNull', () => {
  test('maps capitalgroup.com placeholders (--, em dash, N/A) to null and reads plain, currency and percent numbers', () => {
    expect(numberOrNull('--')).toBeNull();
    expect(numberOrNull('—')).toBeNull();
    expect(numberOrNull('N/A')).toBeNull();
    expect(numberOrNull('4.56')).toBe(4.56);
    expect(numberOrNull('$1,234.56')).toBe(1234.56);
    expect(numberOrNull('0.40%')).toBe(0.4);
  });
});

describe('toIsoDate / formatIssuerDate / formatEdgarDate', () => {
  test('US and ISO dates both normalize to ISO', () => {
    expect(toIsoDate('08/21/2026')).toBe('2026-08-21');
    expect(toIsoDate('2026-08-21')).toBe('2026-08-21');
    expect(toIsoDate('2026-8-1')).toBe('2026-08-01');
    expect(toIsoDate('n/a')).toBe('n/a');
  });

  test('capitalgroup.com workbooks render MM/DD/YYYY, the feed renders "Mon D YYYY"', () => {
    expect(formatIssuerDate('2026-08-21')).toBe('08/21/2026');
    expect(formatEdgarDate('2026-06-30')).toBe('Jun 30 2026');
  });

  test('epoch days convert to ISO', () => {
    expect(isoToEpoch('2026-01-15')).toBe(Date.UTC(2026, 0, 15) / 1000);
    expect(isoToEpoch('nope')).toBeNull();
  });
});

describe('navTotalReturnDays', () => {
  test('reinvests each published distribution at its reinvestment NAV', () => {
    const points = [
      { date: '2026-08-29', nav: 56.3, marketPrice: 56.31, premiumDiscount: 0.0178 },
      { date: '2026-09-01', nav: 55.9, marketPrice: 55.92, premiumDiscount: 0.0358 },
      { date: '2026-09-17', nav: 56.4101, marketPrice: 56.43, premiumDiscount: 0.0353 },
    ];
    const dividends = [{ epoch: isoToEpoch('2026-09-01')!, amount: 0.37421, exDate: '2026-09-01', payDate: '', recordDate: '', reinvestNav: 55.9, type: 'DVDYLD' }];
    const days = navTotalReturnDays(points, dividends);
    expect(days.map((day) => day.date)).toEqual(['2026-08-29', '2026-09-01', '2026-09-17']);
    expect(days[0]).toEqual({ date: '2026-08-29', close: 56.3, adjClose: 56.3, volume: 0 });
    const factor = 1 + 0.37421 / 55.9;
    expect(days[1].adjClose).toBeCloseTo(55.9 * factor, 6);
    expect(days[2].adjClose).toBeCloseTo(56.4101 * factor, 6);
    // Total return over the window = price return plus the reinvested payout.
    expect(days[2].adjClose / days[0].adjClose - 1).toBeCloseTo((56.4101 * factor) / 56.3 - 1, 6);
  });

  test('uses the ex-date NAV when no reinvestment NAV is published and skips pre-history payouts', () => {
    const points = [
      { date: '2026-09-01', nav: 50, marketPrice: 50, premiumDiscount: 0 },
      { date: '2026-09-02', nav: 51, marketPrice: 51, premiumDiscount: 0 },
    ];
    const dividends = [
      { epoch: isoToEpoch('2026-08-01')!, amount: 1, exDate: '2026-08-01', payDate: '', recordDate: '', reinvestNav: null, type: '' },
      { epoch: isoToEpoch('2026-09-01')!, amount: 0.5, exDate: '2026-09-01', payDate: '', recordDate: '', reinvestNav: null, type: '' },
    ];
    const days = navTotalReturnDays(points, dividends);
    expect(days[0].adjClose).toBeCloseTo(50 * 1.01, 6);
    expect(days[1].adjClose).toBeCloseTo(51 * 1.01, 6);
    expect(navTotalReturnDays([], dividends)).toEqual([]);
  });
});

describe('sheet headers', () => {
  test('official history rows carry NAV, market price and premium/discount; Yahoo fallback keeps the sibling layout', () => {
    expect(HISTORY_HEADERS).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(YAHOO_HISTORY_HEADERS).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
  });
});

describe('nport fixtures', () => {
  test('parses positions, identifiers and the report period', () => {
    const xml = `
      <nportRegDoc><genInfo><regName>Capital Group Exchange-Traded Fund Trust</regName><regCik>0001870102</regCik>
      <seriesName>Capital Group Core Equity ETF</seriesName><seriesId>S000068402</seriesId>
      <repPdDate>2026-06-30</repPdDate></genInfo>
      <invstOrSec><name>Apple Inc</name><cusip>037833100</cusip><balance>124827810</balance>
      <valUSD>26312454069.90</valUSD><pctVal>8.24</pctVal><assetCat>EC</assetCat></invstOrSec>
      <invstOrSec><title>US TREASURY 4.125% 05/15/2028</title>
      <identifiers><cusip value="912810H80"/></identifiers><balance>5000000</balance>
      <valUSD>5100000</valUSD><pctVal>2.5</pctVal><assetCat>OB</assetCat></invstOrSec>
      </nportRegDoc>`;
    const parsed = parseNport(xml);
    expect(parsed.seriesName).toBe('Capital Group Core Equity ETF');
    expect(parsed.regCik).toBe('0001870102');
    expect(parsed.repPdDate).toBe('2026-06-30');
    expect(parsed.holdings.length).toBe(2);
    expect(parsed.holdings[0].Identifier).toBe('037833100');
    expect(parsed.holdings[0].Ticker).toBe('-');
    expect(parsed.holdings[1].Identifier).toBe('912810H80');
    expect(parsed.holdings[1].Name).toBe('US TREASURY 4.125% 05/15/2028');
    expect(parsed.totalValue).toBeCloseTo(26317554069.9, 1);
    expect(parsed.netAssets).toBeNull();
  });

  test('reads the reported net assets when the filing carries a fundInfo block', () => {
    const parsed = parseNport(
      '<genInfo><seriesName>Capital Group Dividend Value ETF</seriesName><repPdDate>2026-04-30</repPdDate></genInfo>' +
        '<fundInfo><totAssets>88500000000.00</totAssets><netAssets>87850000000.00</netAssets></fundInfo>' +
        '<invstOrSec><name>MGM Resorts International</name><cusip>552953101</cusip><valUSD>180990316.32</valUSD><pctVal>0.2059893365</pctVal></invstOrSec>',
    );
    expect(parsed.netAssets).toBe(87850000000);
    expect(parsed.holdings.length).toBe(1);
  });

  test('falls back to other identifiers when the CUSIP is N/A', () => {
    const parsed = parseNport(
      '<invstOrSec><name>FUND X</name><cusip>N/A</cusip><identifiers><other value="XSCUSIP1"/></identifiers><valUSD>10</valUSD></invstOrSec>',
    );
    expect(parsed.holdings[0].Identifier).toBe('XSCUSIP1');
  });

  test('tolerates empty bodies and missing values', () => {
    expect(() => parseNport('')).not.toThrow();
    const parsed = parseNport('<genInfo><seriesName>Empty</seriesName></genInfo>');
    expect(parsed.holdings).toEqual([]);
    expect(parsed.totalValue).toBe(0);
  });

  test('submissions parser keeps only NPORT-P forms and builds the archive URL', () => {
    const accessions = parseNportAccessions({
      cik: '913760',
      filings: {
        recent: {
          form: ['NPORT-P', '13F-HR', 'NPORT-P'],
          accessionNumber: ['0000913760-26-000111', '0000913760-26-000112', '0000913760-26-000113'],
          filingDate: ['2026-07-21', '2026-08-10', '2026-04-21'],
          reportDate: ['2026-06-30', '2026-06-30', '2026-03-31'],
        },
      },
    });
    expect(accessions.map((entry) => entry.accession)).toEqual(['0000913760-26-000111', '0000913760-26-000113']);
    expect(accessions[0].url).toBe(nportUrlFor('0000913760', '0000913760-26-000111'));
    expect(accessions[0].url).toContain('/Archives/edgar/data/913760/000091376026000111/primary_doc.xml');
  });
});

describe('pickEftsCik', () => {
  const payload = {
    hits: [
      { _source: { display_names: { cik: 12345, names: ['Some Other Trust'] } } },
      { _source: { display_names: { cik: 1870102, names: ['Capital Group Core Equity ETF', 'CAPITAL GROUP EXCHANGE-TRADED FUND TRUST'] } } },
    ],
  };
  test('chooses the registrant whose name matches the fund', () => {
    expect(pickEftsCik(payload, 'Capital Group Core Equity ETF')).toBe('0001870102');
  });

  test('returns null when nothing matches', () => {
    expect(pickEftsCik(payload, 'Unknown Fund')).toBeNull();
  });

  test('reads the real EDGAR full-text search payload shape', () => {
    const real = {
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          { _source: { ciks: ['0001667919'], display_names: ['FIRST TRUST EXCHANGE-TRADED FUND VIII  (CIK 0001667919)'] } },
          { _source: { ciks: ['0001870102'], display_names: ['CAPITAL GROUP EXCHANGE-TRADED FUND TRUST  (CIK 0001870102)'] } },
        ],
      },
    };
    expect(pickEftsCik(real, 'Capital Group Exchange-Traded Fund Trust')).toBe('0001870102');
    expect(pickEftsCik(real, '')).toBe('0001667919');
  });
});

describe('SEC lookup tables', () => {
  const fundTickers = {
    fields: ['cik', 'seriesId', 'classId', 'symbol'],
    data: [
      [1870102, 'S000068402', 'C000218810', 'CGUS'],
      [1870102, 'S000054790', 'C000172198', 'CGCP'],
      [1870102, 'S000061995', 'C000200806', 'cgmu'],
      [0, 'S000000000', 'C000000000', 'ZZZ'],
    ],
  };

  test('maps every ticker to its registrant CIK and series', () => {
    const map = parseFundTickerMap(fundTickers);
    expect(map.get('CGUS')).toEqual({ cik: '0001870102', seriesId: 'S000068402', classId: 'C000218810' });
    expect(map.get('CGCP')?.cik).toBe('0001870102');
    expect(map.get('CGMU')?.seriesId).toBe('S000061995');
    expect(map.has('ZZZ')).toBe(false);
  });

  test('tolerates an unusable payload', () => {
    expect(parseFundTickerMap({}).size).toBe(0);
    expect(parseFundTickerMap({ fields: ['cik'], data: ['nope'] }).size).toBe(0);
  });

  test('maps issuer names back to exchange tickers', () => {
    const map = parseCompanyTickerMap({
      '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
      '1': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '2': { cik_str: 1, ticker: '', title: 'No Ticker Inc' },
    });
    expect(map.get(normalizeHoldingName('NVIDIA Corp'))).toBe('NVDA');
    expect(map.get(normalizeHoldingName('Apple Inc.'))).toBe('AAPL');
    expect(map.get(normalizeHoldingName('No Ticker Inc'))).toBeUndefined();
  });
});

describe('EDGAR series filings', () => {
  const atom = `<?xml version="1.0" encoding="ISO-8859-1"?>
    <feed>
      <entry>
        <accession-number>0001209466-26-000952</accession-number>
        <filing-date>2026-06-29</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/0001209466-26-000952-index.htm</filing-href>
        <filing-type>NPORT-P</filing-type>
      </entry>
      <entry>
        <accession-number>0001209466-26-000514</accession-number>
        <filing-date>2026-04-01</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000514/0001209466-26-000514-index.htm</filing-href>
        <filing-type>NPORT-P</filing-type>
      </entry>
      <entry>
        <accession-number>0001209466-26-000001</accession-number>
        <filing-date>2026-01-05</filing-date>
        <filing-type>N-CEN</filing-type>
      </entry>
    </feed>`;

  test('builds the browse-edgar Atom URL for one series', () => {
    const url = edgarSeriesFilingsUrl('S000060812', 5);
    expect(url).toContain('https://www.sec.gov/cgi-bin/browse-edgar?');
    expect(url).toContain('CIK=S000060812');
    expect(url).toContain('type=NPORT-P');
    expect(url).toContain('output=atom');
    expect(url).toContain('count=5');
  });

  test('keeps N-PORT-P entries newest first and builds the primary document URL', () => {
    const filings = parseEdgarAtomFilings(atom);
    expect(filings.map((entry) => entry.accession)).toEqual(['0001209466-26-000952', '0001209466-26-000514']);
    expect(filings[0].filed).toBe('2026-06-29');
    expect(filings[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/primary_doc.xml');
  });

  test('tolerates an empty or unrelated feed', () => {
    expect(parseEdgarAtomFilings('')).toEqual([]);
    expect(parseEdgarAtomFilings('<feed><entry><filing-type>10-K</filing-type></entry></feed>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// History fallback layer (Yahoo chart)
// ---------------------------------------------------------------------------

function chartFixture(options: { closes?: (number | null)[]; adj?: (number | null)[]; dividends?: Record<string, { date: number; amount: number }> } = {}) {
  const start = Date.UTC(2020, 0, 2) / 1000;
  const closes = options.closes ?? [100, 105, 110, 111, 120];
  const adj = options.adj ?? closes;
  const timestamps = closes.map((_, index) => start + index * 86_400);
  return {
    chart: {
      result: [
        {
          meta: {
            fullExchangeName: 'NasdaqGS',
            longName: 'Capital Group Core Equity ETF',
            navPrice: 706.3,
            regularMarketPrice: 706.32,
            regularMarketTime: Date.UTC(2026, 7, 21, 20, 0) / 1000,
            firstTradeDate: start,
          },
          timestamp: timestamps,
          indicators: { quote: [{ close: closes, volume: timestamps.map(() => 1000) }], adjclose: [{ adjclose: adj }] },
          events: { dividends: options.dividends ?? {} },
        },
      ],
    },
  };
}

describe('chart fixtures', () => {
  test('builds trading days, skips null closes, keeps adjusted closes', () => {
    const chart = parseChart(chartFixture({ closes: [100, null, 110], adj: [90, null, 99] }));
    expect(chart.days.map((day) => day.close)).toEqual([100, 110]);
    expect(chart.days.map((day) => day.adjClose)).toEqual([90, 99]);
    expect(chart.navPrice).toBe(706.3);
    expect(chart.exchangeName).toBe('NasdaqGS');
  });

  test('falls back to raw closes when adjclose is absent', () => {
    const payload = chartFixture({ closes: [100, 101] }) as any;
    delete payload.chart.result[0].indicators.adjclose;
    const chart = parseChart(payload);
    expect(chart.days.map((day) => day.adjClose)).toEqual([100, 101]);
  });

  test('sorts dividends chronologically and drops non-positive amounts', () => {
    const chart = parseChart(
      chartFixture({
        dividends: {
          '2': { date: Date.UTC(2026, 5, 15) / 1000, amount: 0.7 },
          '1': { date: Date.UTC(2026, 2, 15) / 1000, amount: 0.65 },
          '0': { date: Date.UTC(2025, 11, 15) / 1000, amount: -1 },
        },
      }),
    );
    expect(chart.dividends.map((entry) => entry.amount)).toEqual([0.65, 0.7]);
  });

  test('throws on an empty result', () => {
    expect(() => parseChart({ chart: { result: [] } })).toThrow(/empty result/);
  });
});

describe('priceReturns', () => {
  const days = [
    { date: '2015-01-02', close: 100, adjClose: 100, volume: 1 },
    { date: '2022-01-03', close: 200, adjClose: 195, volume: 1 },
    { date: '2023-01-03', close: 220, adjClose: 214, volume: 1 },
    { date: '2026-01-02', close: 300, adjClose: 290, volume: 1 },
    { date: '2026-06-30', close: 320, adjClose: 310, volume: 1 },
    { date: '2026-07-01', close: 322, adjClose: 312, volume: 1 },
    { date: '2026-08-21', close: 340, adjClose: 330, volume: 1 },
  ];
  const now = new Date(Date.UTC(2026, 7, 21));

  test('derives YTD, 1Y, CAGRs and SI anchored to the last close', () => {
    const returns = priceReturns(days, now);
    expect(returns.asOfDate).toBe('2026-08-21');
    // Each anchor is the last trading day at or before the period start, so a
    // thin fixture keeps falling back to the newest day that is early enough.
    expect(returns.ytd).toBeCloseTo(54.21, 2); // 2023-01-03 (the 2026-01-01 anchor)
    expect(returns.yr1).toBeCloseTo(54.21, 2); // 2023-01-03 (nothing between 2025 and 2023)
    expect(returns.cagr3y).toBeCloseTo(15.53, 2); // 2026-01-02 (3y before 2026-08-21)
    expect(returns.mo1).toBeCloseTo(5.77, 2); // 2026-07-01 (the 2026-07-21 anchor)
    expect(returns.siAnn).toBeGreaterThan(0);
  });

  test('young funds produce nulls instead of made-up returns', () => {
    const young = priceReturns([{ date: '2026-08-20', close: 10, adjClose: 10, volume: 1 }], now);
    expect(young.asOfDate).toBe('2026-08-20');
    expect(young.ytd).toBeNull();
    expect(young.cagr3y).toBeNull();
    expect(young.siAnn).toBeNull();
  });

  test('empty history yields an empty returns block', () => {
    expect(priceReturns([], now).asOfDate).toBe('');
  });

  test('windows that start before the reinvestment coverage are not derived', () => {
    // A weekly payer whose schedule only covers the last 12 payments: the
    // since-inception, YTD and 1Y windows would miss reinvestments and must
    // stay null, while the quarter-to-date and 1-month windows are derived.
    const covered = priceReturns(days, now, '2026-06-29');
    expect(covered.siAnn).toBeNull();
    expect(covered.ytd).toBeNull();
    expect(covered.yr1).toBeNull();
    expect(covered.cagr3y).toBeNull();
    expect(covered.qtd).toBeCloseTo(pctChangeOf(312, 330), 2); // anchored at 2026-07-01 (quarter start)
    expect(covered.mo1).toBeCloseTo(pctChangeOf(312, 330), 2); // anchored at 2026-07-01 (the 2026-07-21 anchor)
    // Coverage from the first day changes nothing.
    expect(priceReturns(days, now, '2015-01-02')).toEqual(priceReturns(days, now));
  });
});

function pctChangeOf(start: number, end: number): number {
  return ((end - start) / start) * 100;
}

describe('lastCompletedQuarterEnd', () => {
  test('anchors to the last completed quarter', () => {
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 7, 21))).toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 0, 15))).toISOString().slice(0, 10)).toBe('2025-12-31');
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 4, 1))).toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 10, 1))).toISOString().slice(0, 10)).toBe('2026-09-30');
  });
});

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

describe('annualizedToTotal / totalToAnnualized', () => {
  test('annualizedToTotal inverts annualization exactly', () => {
    expect(annualizedToTotal(20.15, 3)).toBeCloseTo(73.45, 2);
    expect(annualizedToTotal(null, 3)).toBeNull();
    expect(annualizedToTotal(10, 0)).toBeNull();
  });

  test('round-trips through totalToAnnualized', () => {
    expect(totalToAnnualized(annualizedToTotal(12.5, 5), 5)).toBeCloseTo(12.5, 1);
  });

  test('guards bad input', () => {
    expect(totalToAnnualized('n/a' as any, 5)).toBeNull();
  });
});

describe('indicatedYield', () => {
  test('computes latest distribution x frequency / price', () => {
    expect(indicatedYield(0.7, 4, 706.32)).toBeCloseTo(0.4, 1);
    expect(indicatedYield(0.65, 12, 41.72)).toBe(18.7);
  });

  test('guards missing pieces', () => {
    expect(indicatedYield(null, 4, 10)).toBeNull();
    expect(indicatedYield(0.5, 0, 10)).toBeNull();
    expect(indicatedYield(0.5, 4, 0)).toBeNull();
  });
});

describe('inferDistributionFrequency', () => {
  test('detects quarterly and monthly cadences', () => {
    const quarterly = [0, 1, 2, 3].map((i) => ({ epoch: Date.UTC(2026, 0 + i * 3, 15) / 1000, amount: 1 }));
    expect(inferDistributionFrequency(quarterly).frequency).toBe('Quarterly');
    const monthly = Array.from({ length: 6 }, (_, i) => ({ epoch: Date.UTC(2026, i, 15) / 1000, amount: 1 }));
    expect(inferDistributionFrequency(monthly)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
  });

  test('no distributions means None (commodity / crypto style funds)', () => {
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
  });
});

describe('deriveCatalogMetrics', () => {
  test('official Capital Group returns win over the derived ones', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 15.97, yr1: 18.34, yr3: 20.15, yr5: 17.42, yr10: 16.88, sinceInception: 19.44 },
      { asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99, cagr5y: 12, cagr10y: 11, siAnn: 10, mo1: 1, qtd: 2 },
      0.44,
      null,
      null,
      null,
      706.32,
    );
    expect(metrics.ytd).toBe(15.97);
    expect(metrics.tr1y).toBe(18.34);
    expect(metrics.cagr3y).toBe(20.15);
    expect(metrics.tr3y).toBe(annualizedToTotal(20.15, 3));
    expect(metrics.dividendYield).toBe(0.44);
    expect(metrics.secYield).toBeNull();
    expect(metrics.returnsBasis).toContain('official Capital Group NAV total returns');
    expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
  });

  test('performanceAsOf is the performance table date, not the NAV date', () => {
    const official = { ytd: 1, yr1: 2, yr3: null, yr5: null, yr10: null, sinceInception: null };
    const derived = { asOfDate: '2026-09-25', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null };
    expect(deriveCatalogMetrics(official, derived, null, null, null, null, null, null, '2026-08-31').performanceAsOf).toBe('2026-08-31');
    expect(performanceAsOf(false, '2026-08-31', '2026-09-25')).toBe('2026-09-25');
    expect(performanceAsOf(true, null, '2026-09-25')).toBe('2026-09-25');
    expect(performanceAsOf(false, null, '')).toBeNull();
    expect(performanceAsOf(true, 'Aug 31 2026', null)).toBeNull();
  });

  test('returnsBasis is always a non-empty honest label', () => {
    for (const official of [true, false]) for (const yahoo of [true, false]) {
      const label = returnsBasisLabel(official, yahoo);
      expect(label.length).toBeGreaterThan(10);
      expect(label).not.toBe('-');
      expect(label.includes('Yahoo')).toBe(yahoo);
    }
  });

  test('falls back to derived returns and the indicated yield', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null },
      null,
      null,
      0.65,
      12,
      41.72,
    );
    expect(metrics.ytd).toBe(13.79);
    expect(metrics.tr1y).toBe(54.21);
    expect(metrics.cagr5y).toBeNull();
    expect(metrics.dividendYield).toBe(18.7);
    expect(metrics.dividendYieldText).toBe('18.70%');
    expect(metrics.returnsBasis).toContain('not official NAV returns');
    expect(metrics.performanceAsOf).toBe('2026-08-21');
  });

  test('official cumulative figures replace the annualized-to-total approximation', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 5.36, yr1: 9.05, yr3: 9.51, yr5: 10.02, yr10: null, sinceInception: 11.25 },
      { asOfDate: '2026-09-18', ytd: 3.7, yr1: 9, cagr3y: 9.4, cagr5y: 10, cagr10y: null, siAnn: 11, mo1: 1, qtd: 2 },
      8.42,
      7.59,
      0.37421,
      12,
      56.24,
      { yr1: 9.05, yr3: 31.33, yr5: 61.17, yr10: null, sinceInception: 95.24 },
    );
    expect(metrics.tr3y).toBe(31.33);
    expect(metrics.tr5y).toBe(61.17);
    expect(metrics.tr10y).toBeNull();
    expect(metrics.cagr3y).toBe(9.51);
    expect(metrics.secYield).toBe(7.59);
    expect(metrics.secYieldText).toBe('7.59%');
  });
});

// ---------------------------------------------------------------------------
// Holding name normalization and the ticker seed
// ---------------------------------------------------------------------------

describe('normalizeHoldingName', () => {
  test('strips legal-form suffixes and fillers', () => {
    expect(normalizeHoldingName('Apple Inc.')).toBe('APPLE');
    expect(normalizeHoldingName('Microsoft Corp Common Stock')).toBe('MICROSOFT');
    expect(normalizeHoldingName('THE BOEING CO')).toBe('BOEING');
    // share classes are canonicalized, never dropped: GOOG and GOOGL must not collide
    expect(normalizeHoldingName('Alphabet Inc. Class C Capital Stock')).toBe('ALPHABET CL C');
    expect(normalizeHoldingName('Alphabet Inc. Class A Common Stock')).toBe('ALPHABET CL A');
    expect(normalizeHoldingName('Alphabet Inc Cl C')).toBe('ALPHABET CL C');
  });

  test('core form drops the remaining spaces', () => {
    expect(normalizeHoldingNameCore('Apple Inc.')).toBe('APPLE');
  });

  test('share classes stay distinguishable', () => {
    expect(normalizeHoldingName('Alphabet Inc Cl A')).not.toBe(normalizeHoldingName('Alphabet Inc Cl C'));
  });

  test('a trailing security word is peeled, a lone one is not', () => {
    expect(normalizeHoldingName('Berkshire Hathaway Inc Del')).toBe('BERKSHIRE HATHAWAY');
    // "Cap Stk" is not in the filler/suffix vocabulary (it is only normalized,
    // never dropped): the class marker survives, which is what matters.
    expect(normalizeHoldingName('Berkshire Hathaway Inc Cap Stk Cl A')).toBe('BERKSHIRE HATHAWAY CL A');
    expect(normalizeHoldingName('Berkshire Hathaway Inc Cap Stock Class A')).toBe('BERKSHIRE HATHAWAY CL A');
  });

  test('empty and junk names normalize to empty', () => {
    expect(normalizeHoldingName('')).toBe('');
    expect(normalizeHoldingName('---')).toBe('');
  });
});

describe('cleanHoldingTicker', () => {
  test('keeps class-share markers', () => {
    expect(cleanHoldingTicker('brk-b')).toBe('BRK-B');
    expect(cleanHoldingTicker('SCE^L')).toBe('SCE^L');
    expect(cleanHoldingTicker('BF/A')).toBe('BF/A');
  });

  test('rejects placeholders', () => {
    expect(cleanHoldingTicker('')).toBe('');
    expect(cleanHoldingTicker('N/A')).toBe('');
    expect(cleanHoldingTicker('see file')).toBe('');
  });
});

describe('system CA', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const certError = Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
  const stub = (impl: () => Promise<Response>) => { globalThis.fetch = impl as unknown as typeof fetch; return globalThis.fetch; };

  test('USE_SYSTEM_CA resolves auto/true/false case-insensitively and rejects other values', () => {
    expect(configFile().USE_SYSTEM_CA).toBe('auto');
    expect(readConfig(resolveControls(configFile())).useSystemCa).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(readConfig(resolveControls(configFile(), {}, {}, { USE_SYSTEM_CA: mode })).useSystemCa).toBe(mode.toLowerCase());
    expect(() => resolveControls(configFile(), {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
  });

  test('isCertError detects certificate failures, including nested causes', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: certError }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa leaves fetch alone for false and when already active, re-execs for true', () => {
    const original = stub(async () => new Response('ok'));
    let calls = 0; const reexec = (() => { calls++; return undefined as never; });
    installSystemCa('false', reexec, false); expect(globalThis.fetch).toBe(original);
    installSystemCa('auto', reexec, true); expect(globalThis.fetch).toBe(original);
    installSystemCa('true', reexec, true); expect(globalThis.fetch).toBe(original);
    expect(calls).toBe(0);
    installSystemCa('true', reexec, false); expect(calls).toBe(1);
  });

  test('auto mode wraps fetch: cert error re-execs once, other errors pass, success passes through', async () => {
    let calls = 0; const reexec = (() => { calls++; return undefined as never; });
    const original = stub(async () => { throw new Error('fetch failed', { cause: certError }); });
    installSystemCa('auto', reexec, false);
    expect(globalThis.fetch).not.toBe(original);
    await globalThis.fetch('https://example.invalid/');
    expect(calls).toBe(1);
    globalThis.fetch = realFetch;
    stub(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
    installSystemCa('auto', reexec, false);
    await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('socket hang up');
    expect(calls).toBe(1);
    globalThis.fetch = realFetch;
    stub(async () => new Response('fine'));
    installSystemCa('auto', reexec, false);
    expect(await (await globalThis.fetch('https://example.invalid/')).text()).toBe('fine');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Robustness and data-contract fixes: in-process runs against a mocked issuer (never live)
// ---------------------------------------------------------------------------

afterEach(() => { process.exitCode = 0; });

type Knobs = {
  catalog?: string[];
  dead?: Record<string, string[]>; // ticker (or ALL) -> sources: facts, holdings, history, yahoo
  facts?: Record<string, { net?: string; gross?: string; secYield?: string | null; inception?: string; returns?: Record<string, string | null>; nav?: string; priceDate?: string; assets?: string }>;
  noDistributions?: boolean;
  historyDays?: number;
  yahooDays?: number;
  holdingsDate?: string;
  nport?: { repPdDate: string } | null;
  secDelayMs?: number;
};
const mockDays = (count: number): string[] => Array.from({ length: count }, (_, index) => new Date(Date.parse('2026-09-25T00:00:00Z') - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
const usDate = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const mockCounts = new Map<string, number>();

function installIssuerMock(knobs: Knobs = {}): () => void {
  const original = globalThis.fetch;
  mockCounts.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const count = (key: string) => mockCounts.set(key, (mockCounts.get(key) ?? 0) + 1);
    const ticker = (/\/details\/([a-z0-9]+)/i.exec(url)?.[1] ?? /\/etfs\/([A-Z0-9]+)\//.exec(url)?.[1] ?? /chart\/([A-Z0-9]+)/.exec(url)?.[1] ?? '').toUpperCase();
    const dead = new Set(knobs.dead?.[ticker] ?? knobs.dead?.ALL ?? []);
    const gone = () => new Response('missing', { status: 404 });
    if (url.endsWith('exchange-traded-funds.html')) {
      return new Response((knobs.catalog ?? ['CGUS']).map((item) => `<a href="/advisor/investments/exchange-traded-funds/details/${item.toLowerCase()}">${item}</a>`).join(''));
    }
    if (url.includes('/details/')) {
      count('facts');
      if (dead.has('facts')) return gone();
      const own = knobs.facts?.[ticker] ?? {};
      const facts = factsSample(ticker) as any;
      facts.details.expenseRatio = { grossExpenseRatio: own.gross ?? '0.45', netExpenseRatio: own.net ?? '0.33' };
      if (own.inception) facts.details.inceptionDate = own.inception;
      if (own.secYield !== undefined) facts.details.yield.netSecYield = own.secYield;
      if (own.returns) facts.details.monthlyReturns = own.returns;
      if (own.nav) facts.dailyDetails.priceDistribution.navPrice = own.nav;
      if (own.priceDate) facts.dailyDetails.priceDistribution.asOfDate = own.priceDate;
      if (own.assets) facts.dailyDetails.fundFacts.assetsInMillions = own.assets;
      return new Response(flightHtml(facts));
    }
    if (url.includes('/download/daily-holdings')) {
      if (dead.has('holdings')) return gone();
      return new Response(new Uint8Array(holdingsWorkbookDated(ticker, knobs.holdingsDate ?? '9/24/2026')));
    }
    if (url.includes('/historical-distributions')) {
      if (dead.has('history')) return gone();
      return Response.json(knobs.noDistributions ? { asOfDate: '09/25/2026', distributions: [] } : distributionsSample);
    }
    if (url.includes('/premium-discount-details')) {
      if (dead.has('history')) return gone();
      const dayList = mockDays(knobs.historyDays ?? 400);
      return Response.json({ inceptionDate: '02/22/2022', quotron: ticker, premiumDiscountDetails: dayList.map((day, index) => ({ asOfDate: usDate(day), period: 'daily', values: { nav: String(24 + index * 0.05), marketPrice: String(24 + index * 0.05), premiumDiscount: '0.05' } })) });
    }
    if (url.includes('query1.finance.yahoo.com/v8/finance/chart')) {
      if (dead.has('yahoo')) return gone();
      const dayList = mockDays(knobs.yahooDays ?? 300);
      return Response.json({ chart: { result: [{ timestamp: dayList.map((day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000)), indicators: { quote: [{ close: dayList.map((_, index) => 40 + index * 0.01), volume: dayList.map(() => 1) }], adjclose: [{ adjclose: dayList.map((_, index) => 40 + index * 0.01) }] }, events: {}, meta: { regularMarketPrice: 44, exchangeName: 'NYSE', firstTradeDate: 1645488000 } }], error: null } });
    }
    if (url.includes('company_tickers_mf.json')) {
      count('company_tickers_mf');
      await Bun.sleep(knobs.secDelayMs ?? 0);
      return Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1870102, 'S000068402', 'C000218810', ticker || 'CGUS']] });
    }
    if (url.includes('company_tickers.json')) return Response.json({});
    if (url.includes('browse-edgar')) {
      return knobs.nport ? new Response(`<feed><entry><accession-number>0001870102-26-000001</accession-number><filing-date>${knobs.nport.repPdDate}</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/1870102/000187010226000001/0001870102-26-000001-index.htm</filing-href><filing-type>NPORT-P</filing-type></entry></feed>`) : gone();
    }
    if (url.endsWith('primary_doc.xml') && knobs.nport) {
      return new Response(`<nportRegDoc><genInfo><regName>Capital Group Exchange-Traded Fund Trust</regName><regCik>0001870102</regCik><seriesName>Capital Group Core Equity ETF</seriesName><seriesId>S000068402</seriesId><repPdDate>${knobs.nport.repPdDate}</repPdDate></genInfo><invstOrSec><name>Apple Inc</name><cusip>037833100</cusip><balance>10</balance><valUSD>1000</valUSD><pctVal>5</pctVal><assetCat>EC</assetCat></invstOrSec></nportRegDoc>`);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
// holdingsWorkbook() hard-codes the 9/24/2026 title date; this variant sets it
function holdingsWorkbookDated(ticker: string, date: string): Buffer {
  const line = (r: number, values: string[]) => `<row r="${r}">${values.map((v, i) => cell(`${String.fromCharCode(65 + i)}${r}`, v)).join('')}</row>`;
  const sheet = `<worksheet><sheetData>${line(1, [`${ticker} - Capital Group Core Equity ETF Holdings As Of ${date}`])}${line(2, HOLDINGS_HEADER)}${HOLDINGS_ROWS.map((row, i) => line(3 + i, row)).join('')}</sheetData></worksheet>`;
  return zip({ 'xl/worksheets/sheet1.xml': sheet }, true);
}

const defaultApiRoot = new URL('../api/capital-group/', import.meta.url);
async function withFeed(knobs: Knobs, work: (feed: { root: URL; dir: string; run: (env?: Record<string, string>, next?: Knobs, extra?: Partial<Parameters<typeof runUpdater>[0]>) => ReturnType<typeof runUpdater>; row: (ticker: string) => Promise<any>; meta: (ticker: string) => Promise<any> }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-fix-'));
  const root = new URL(`file://${dir}/`);
  let restore = installIssuerMock(knobs);
  const quiet = console.log; const quietWarn = console.warn;
  try {
    console.log = () => undefined; console.warn = () => undefined;
    const run = async (env: Record<string, string> = {}, next?: Knobs, extra: Partial<Parameters<typeof runUpdater>[0]> = {}) => {
      if (next) { restore(); restore = installIssuerMock(next); }
      return runUpdater({ config: readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', EDGAR_FALLBACK: '0', SKIP_YAHOO: '0', ...env }), apiRoot: root, ...extra });
    };
    const row = async (ticker: string) => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).funds.find((fund: any) => fund.ticker === ticker);
    const meta = async (ticker: string) => JSON.parse(await readFile(join(dir, 'funds', ticker, 'meta.json'), 'utf8'));
    await work({ root, dir, run, row, meta });
  } finally {
    console.log = quiet; console.warn = quietWarn;
    restore(); setApiRoot(defaultApiRoot);
    await rm(dir, { recursive: true, force: true });
  }
}

describe('fix: strict controls', () => {
  test('an AUM bound that is not a finite number is an error, never a dropped bound', () => {
    for (const bad of ['abc:5B', '5X:10B', '1.2.3B:', ':1.2.3B', 'Infinity:']) expect(() => parseAumRange(bad)).toThrow('AUM');
    expect(() => readConfig({ AUM: 'abc:5B' })).toThrow('AUM');
    expect(parseAumRange('1B:')).toEqual({ min: 1e9, max: undefined });
    expect(parseAumRange('0.5B:2T')).toEqual({ min: 5e8, max: 2e12 });
    expect(parseAumRange('$1,000,000:')).toEqual({ min: 1e6, max: undefined });
  });

  test('numberOrNull maps symbol-only text to null, not 0, and keeps a real zero', () => {
    for (const text of ['$', '%', ',', '$,%', ' $ ']) expect(numberOrNull(text)).toBeNull();
    expect(numberOrNull('$0')).toBe(0);
    expect(numberOrNull('0.00%')).toBe(0);
  });

  test('timestamps carry no milliseconds', () => {
    expect(isoStamp(new Date('2026-10-03T04:05:06.789Z'))).toBe('2026-10-03T04:05:06Z');
  });
});

describe('fix: retention only on an outage', () => {
  test('fresh nulls publish as nulls: yields and returns never keep the previous number or pair with a new date', async () => {
    await withFeed({}, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const first = await row('CGUS');
      expect(first.metrics).toMatchObject({ secYield: 0.77, cagr3y: 21.02 });
      expect(first.metrics.dividendYield).not.toBeNull();
      const nulled = { asOfDate: '9/30/26', navMonth1: '1', navYtdMonthly: '13', navYear1: null, navYear3: null, navYear5: null, navYear10: null, navLifetime: '11' };
      await run({ TICKERS: 'CGUS' }, { noDistributions: true, facts: { CGUS: { secYield: null, returns: nulled } } });
      const second = await row('CGUS');
      expect(second.metrics.secYield).toBeNull();
      expect(second.metrics.secYieldText).toBeNull();
      expect(second.metrics.dividendYield).toBeNull();
      expect(second.metrics.cagr3y).toBeNull();
      expect(second.metrics.tr3y).toBeNull();
      expect(second.metrics.ytd).toBe(13);
      expect(second.metrics.performanceAsOf <= '2026-09-30').toBe(true);
      const stored = await meta('CGUS');
      expect(stored.yields.secYield).toBeNull();
      expect(stored.yields.dividendYield).toBeNull();
    });
  });

  test('an issuer outage keeps the previous complete publication untouched', async () => {
    await withFeed({}, async ({ run, dir }) => {
      await run({ TICKERS: 'CGUS' });
      const files = ['funds/CGUS/meta.json', 'funds/CGUS/holdings/001.json', 'funds/CGUS/history/001.json', 'index.json'];
      const before = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
      const report = await run({ TICKERS: 'CGUS' }, { dead: { CGUS: ['facts'] } });
      expect(report.failed).toEqual(['CGUS']);
      expect(report.exitCode).toBe(1);
      expect(await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))).toEqual(before);
    });
  });
});

describe('fix: history is never replaced by a different source or truncated', () => {
  test('a failed issuer history keeps the official NAV rows even when Yahoo works and HISTORY_RANGE is short', async () => {
    await withFeed({ historyDays: 900 }, async ({ run, meta, dir }) => {
      await run({ TICKERS: 'CGUS' });
      const before = await readFile(join(dir, 'funds', 'CGUS', 'history', '001.json'), 'utf8');
      const report = await run({ TICKERS: 'CGUS', HISTORY_RANGE: '5y' }, { dead: { CGUS: ['history'] }, yahooDays: 300 });
      expect(report.failed).toEqual(['CGUS']);
      expect(await readFile(join(dir, 'funds', 'CGUS', 'history', '001.json'), 'utf8')).toBe(before);
      const stored = await meta('CGUS');
      expect(stored.history.totalRows).toBe(900);
      expect(stored.history.source).toContain('capitalgroup.com daily price API');
    });
  });

  test('a Yahoo-sourced history merges older rows back when HISTORY_RANGE shrinks the window', async () => {
    await withFeed({ dead: { CGUS: ['history'] }, yahooDays: 900 }, async ({ run, meta }) => {
      await run({ TICKERS: 'CGUS' }); // first publication: no previous state, so the Yahoo fallback is used
      expect((await meta('CGUS')).history.totalRows).toBe(900);
      await run({ TICKERS: 'CGUS', SKIP_ISSUER: '1', HISTORY_RANGE: '2y' }, { yahooDays: 300 });
      expect((await meta('CGUS')).history.totalRows).toBe(900);
    });
  });

  test('official NAV rows are not replaced by Yahoo adjusted closes on a later SKIP_ISSUER run', async () => {
    await withFeed({ historyDays: 50 }, async ({ run, meta, dir }) => {
      await run({ TICKERS: 'CGUS' });
      await run({ TICKERS: 'CGUS', SKIP_ISSUER: '1' }, { yahooDays: 300 });
      const stored = await meta('CGUS');
      expect(stored.history.totalRows).toBe(50);
      expect(JSON.parse(await readFile(join(dir, 'funds', 'CGUS', 'history', '001.json'), 'utf8')).headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    });
  });

  test('mergeHistoryRows keeps older published rows and refuses to mix header layouts', () => {
    const previous = [{ Date: 'Jan 02 2026', Close: '1' }, { Date: 'Jun 01 2026', Close: '2' }];
    expect(mergeHistoryRows(previous, ['Date', 'Close'], ['Date', 'Close'], [{ Date: 'Jun 01 2026', Close: '3' }]).map((row) => row.Close)).toEqual(['1', '3']);
    expect(mergeHistoryRows(previous, ['Date', 'Close'], ['Date', 'NAV'], [{ Date: 'Jun 01 2026', NAV: '3' }])).toHaveLength(1);
    expect(mergeHistoryRows([], [], ['Date'], [{ Date: 'Jun 01 2026' }])).toHaveLength(1);
  });
});

describe('fix: data contract', () => {
  test('3Y and longer figures are null for funds younger than the horizon at the returns date', async () => {
    const returns = { asOfDate: '8/31/26', navMonth1: '0.8', navYtdMonthly: '12.5', navYear1: '17.8', navYear3: '16.48', navYear5: null, navYear10: null, navLifetime: '17.69' };
    await withFeed({ catalog: ['CGBL'], facts: { CGBL: { inception: '9/26/23', returns } } }, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGBL' });
      const published = await row('CGBL');
      expect(published.metrics.cagr3y).toBeNull();
      expect(published.metrics.tr3y).toBeNull();
      expect(published.returns.monthEnd.yr3).toBeNull();
      expect(published.metrics.tr1y).toBe(17.8);
      expect((await meta('CGBL')).returns.monthEnd.yr3).toBeNull();
    });
    const base = { ytd: 1, yr1: 2, yr3: 3, yr5: 4, yr10: 5, sinceInception: 6 };
    expect(ageGuardReturns(base, '2023-09-26', '2026-08-31')).toMatchObject({ yr1: 2, yr3: null, yr5: null, yr10: null, sinceInception: 6 });
    expect(ageGuardReturns(base, '2026-03-01', '2026-08-31')).toMatchObject({ ytd: 1, yr1: null, sinceInception: null });
    expect(ageGuardReturns(base, '2010-01-01', '2026-08-31')).toEqual(base);
    expect(ageGuardReturns(base, null, '2026-08-31')).toEqual(base);
  });

  test('terValue is the NET expense ratio and terGrossValue the GROSS one', async () => {
    await withFeed({ facts: { CGUS: { net: '0.33', gross: '0.45' } } }, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const published = await row('CGUS');
      expect(published.terValue).toBe(0.33);
      expect(published.terGrossValue).toBe(0.45);
      expect((await meta('CGUS')).expenseRatio).toMatchObject({ value: 0.33, net: 0.33, gross: 0.45 });
    });
  });

  test('net assets carry no float artifact', async () => {
    await withFeed({ facts: { CGUS: { assets: '8399.7' } } }, async ({ run, row }) => {
      await run({ TICKERS: 'CGUS' });
      expect((await row('CGUS')).aumValue).toBe(8399700000);
    });
  });

  test('a newer daily price API point wins over stale fund-facts NAV (CGMS stood still on Sep 03)', async () => {
    await withFeed({ catalog: ['CGMS'], facts: { CGMS: { nav: '27.01', priceDate: '9/3/26' } } }, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGMS' });
      const published = await row('CGMS');
      expect(published.asOfDate).toBe('Sep 25 2026');
      expect(published.navValue).not.toBe(27.01);
      expect((await meta('CGMS')).nav.asOfDate).toBe('Sep 25 2026');
    });
  });

  test('derived since-inception needs at least one year; mixed official and derived figures are labelled with the oldest date', () => {
    const points = Array.from({ length: 300 }, (_, index) => ({ date: new Date(Date.parse('2025-12-01T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10), close: 10 + index * 0.01, adjClose: 10 + index * 0.01, volume: 1 }));
    expect(priceReturns(points, new Date('2026-09-26T00:00:00Z')).siAnn).toBeNull(); // 0.82 years
    const mixed = deriveCatalogMetrics(
      { ytd: 5, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-09-25', ytd: 4, yr1: 9, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null },
      null, null, null, null, null, null, '2026-08-31',
    );
    expect(mixed.ytd).toBe(5);
    expect(mixed.tr1y).toBe(9);
    expect(String(mixed.returnsBasis)).toContain('missing periods are derived');
    expect(mixed.performanceAsOf).toBe('2026-08-31');
    const officialOnly = deriveCatalogMetrics({ ytd: 5, yr1: 6, yr3: null, yr5: null, yr10: null, sinceInception: null }, { asOfDate: '2026-09-25', ytd: 4, yr1: 9, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null }, null, null, null, null, null, null, '2026-08-31');
    expect(officialOnly.returnsBasis).toBe('official Capital Group NAV total returns (fund-detail JSON)');
    expect(officialOnly.dividendYieldText).toBeNull();
    expect(officialOnly.secYieldText).toBeNull();
  });

  test('catalog funds without published data get dataFile null and a complete metrics object; NEW FUNDS is reported', async () => {
    await withFeed({ catalog: ['CGUS', 'CGCP'] }, async ({ run, dir }) => {
      const summary = join(dir, 'summary.md');
      const previousSummary = process.env.GITHUB_STEP_SUMMARY;
      process.env.GITHUB_STEP_SUMMARY = summary;
      try {
        await run({ TICKERS: 'CGUS' });
        const first = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).funds;
        const seed = first.find((fund: any) => fund.ticker === 'CGCP');
        expect(seed.dataFile).toBeNull();
        expect(Object.keys(seed.metrics)).toEqual(Object.keys(first.find((fund: any) => fund.ticker === 'CGUS').metrics));
        expect(seed.metrics.returnsBasis.length).toBeGreaterThan(10);
        expect(seed.metrics.ytd).toBeNull();
        const report = await run({ TICKERS: 'CGUS' }, { catalog: ['CGUS', 'CGCP', 'CGMU'] });
        expect(report.newFunds).toEqual(['CGMU']);
        expect(await readFile(summary, 'utf8')).toContain('NEW FUNDS: CGMU');
      } finally {
        if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previousSummary;
      }
    });
  });
});

describe('fix: fallback freshness', () => {
  test('an N-PORT report not newer than the published holdings never replaces them; the fund is kept as published', async () => {
    await withFeed({}, async ({ run, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const report = await run({ TICKERS: 'CGUS', EDGAR_FALLBACK: '1' }, { dead: { CGUS: ['holdings'] }, nport: { repPdDate: '2026-06-30' } });
      expect(report.failed).toEqual(['CGUS']);
      const stored = await meta('CGUS');
      expect(stored.holdings.source).toBe('Capital Group daily holdings XLSX');
      expect(stored.holdings.asOfDate).toBe('2026-09-24');
    });
  });

  test('a newer N-PORT report is still used when the holdings download fails', async () => {
    await withFeed({ holdingsDate: '6/1/2026' }, async ({ run, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const report = await run({ TICKERS: 'CGUS', EDGAR_FALLBACK: '1' }, { dead: { CGUS: ['holdings'] }, nport: { repPdDate: '2026-08-31' } });
      expect(report.failed).toEqual([]);
      const stored = await meta('CGUS');
      expect(stored.holdings.source).toContain('SEC EDGAR Form N-PORT-P');
      expect(stored.holdings.asOfDate).toBe('2026-08-31');
    });
  });

  test('concurrent workers share one SEC fund-ticker request', async () => {
    const restore = installIssuerMock({ secDelayMs: 30 });
    try {
      resetSecTableCaches();
      const config = readConfig({ REQUEST_SLEEP: '0' });
      const maps = await Promise.all([loadFundTickerMap(config), loadFundTickerMap(config), loadFundTickerMap(config)]);
      expect(mockCounts.get('company_tickers_mf')).toBe(1);
      expect(maps[0]).toBe(maps[2]);
    } finally { restore(); resetSecTableCaches(); }
  });
});

describe('fix: writes and cursor', () => {
  test('writes are atomic and unchanged content writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-atomic-'));
    try {
      const file = new URL(`file://${dir}/x/a.json`);
      await writeFileAtomic(file, '{"a":1}\n');
      expect(await writeIfChanged(file, { a: 1 })).toBe(false);
      expect(await writeIfChanged(file, { a: 2 })).toBe(true);
      expect(await readdir(join(dir, 'x'))).toEqual(['a.json']);
      await expect(writeFileAtomic(new URL(`file://${dir}/x/a.json/nested.json`), 'z')).rejects.toBeDefined();
      expect(JSON.parse(await readFile(join(dir, 'x', 'a.json'), 'utf8'))).toEqual({ a: 2 });
      expect((await readdir(join(dir, 'x'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('stale pages survive a failed meta.json write (pages, then meta, then stale-page removal)', async () => {
    await withFeed({ historyDays: 5 }, async ({ run, dir }) => {
      await run({ TICKERS: 'CGUS', HISTORY_PAGE_SIZE: '2' });
      const historyDir = join(dir, 'funds', 'CGUS', 'history');
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      await rm(join(dir, 'funds', 'CGUS', 'meta.json'));
      await mkdir(join(dir, 'funds', 'CGUS', 'meta.json', 'blocker'), { recursive: true });
      const report = await run({ TICKERS: 'CGUS', HISTORY_PAGE_SIZE: '5' });
      expect(report.failed).toEqual(['CGUS']);
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      await rm(join(dir, 'funds', 'CGUS', 'meta.json'), { recursive: true, force: true });
      await run({ TICKERS: 'CGUS', HISTORY_PAGE_SIZE: '5' });
      expect((await readdir(historyDir)).sort()).toEqual(['001.json']);
    });
  });

  test('a rerun with identical upstream data writes nothing, stamps included', async () => {
    await withFeed({ catalog: ['CGUS', 'CGCP'] }, async ({ run, dir }) => {
      await run({});
      const snapshot = async (): Promise<Array<[string, string, number]>> => {
        const out: Array<[string, string, number]> = [];
        const walk = async (current: string): Promise<void> => {
          for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) await walk(full); else out.push([full, await readFile(full, 'utf8'), (await stat(full)).mtimeMs]);
          }
        };
        await walk(dir);
        return out.sort((a, b) => a[0].localeCompare(b[0]));
      };
      const first = await snapshot();
      await Bun.sleep(20);
      await run({});
      expect(await snapshot()).toEqual(first);
    });
  });

  test('the cursor moves after an all-failing batch, follows queue order and a TICKERS run leaves it alone', async () => {
    const catalog = ['CGCP', 'CGMU', 'CGUS', 'CGXU'];
    await withFeed({ catalog, dead: { ALL: ['facts', 'holdings', 'history', 'yahoo'] } }, async ({ run, dir }) => {
      const report = await run({ MAX_FETCHES: '2' });
      expect(report.failed.sort()).toEqual(['CGCP', 'CGMU']);
      expect((await readCursorScopes()).all).toBe('CGMU');
      const concurrent = await run({ MAX_FETCHES: '2', CONCURRENCY: '2' });
      expect(concurrent.selected).toEqual(['CGUS', 'CGXU']);
      expect((await readCursorScopes()).all).toBe('CGXU'); // the furthest started fund in queue order, not the last to finish
      const tickers = await run({ TICKERS: 'CGMU', MAX_FETCHES: '1' });
      expect(tickers.selected).toEqual(['CGMU']);
      const state = JSON.parse(await readFile(join(dir, 'update-state.json'), 'utf8'));
      expect(state.scopes.all).toBe('CGXU');
      await run({ TICKERS: 'CGMU' }); // a full TICKERS run never resets the full-feed cursor either
      expect((await readCursorScopes()).all).toBe('CGXU');
      await run({}); // an unfiltered full pass resets it
      expect((await readCursorScopes()).all).toBeUndefined();
      await writeCursorScope('all', 'CGCP');
      expect((await readCursorScopes()).all).toBe('CGCP');
    });
  });

  test('the batch wraps around the catalog and funds failing the data filters do not use up a slot', async () => {
    const catalog = ['CGCP', 'CGMU', 'CGUS'];
    await withFeed({ catalog }, async ({ run, row }) => {
      await run({});
      const rich = await row('CGUS');
      expect(rich.aumValue).toBeGreaterThan(1e9);
      const wrapped = await run({ MAX_FETCHES: '2' });
      expect(wrapped.selected).toEqual(['CGCP', 'CGMU']);
      const next = await run({ MAX_FETCHES: '2' });
      expect(next.selected).toEqual(['CGUS', 'CGCP']); // wraps instead of a short last batch
      // AUM above every published fund: nothing can pass, nothing is requested and the cursor stays
      const none = await run({ MAX_FETCHES: '2', AUM: '999T:' });
      expect(none.selected).toEqual([]);
    });
  });

  test('a soft deadline stops taking new funds, still writes the index and moves the cursor by started funds only', async () => {
    expect(RUN_SOFT_DEADLINE_MS).toBe(25 * 60_000);
    await withFeed({ catalog: ['CGCP', 'CGMU', 'CGUS'] }, async ({ run, dir }) => {
      let clock = 0;
      const report = await run({ MAX_FETCHES: '3' }, undefined, { deadlineMs: 5_000, now: () => { clock += 4_000; return clock; } });
      expect(report.deadlineReached).toBe(true);
      expect(report.updated.length).toBeLessThan(3);
      expect(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).funds).toHaveLength(3);
      expect((await readCursorScopes()).all).toBe(report.selected[report.updated.length + report.failed.length + report.skipped.length - 1]);
    });
  });
});
