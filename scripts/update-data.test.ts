/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  formatIssuerDate, normalizeNumberText, numberOrNull, formatEdgarDate, toIsoDate, isoToEpoch, parseRange, parseAumRange, HISTORY_HEADERS, YAHOO_HISTORY_HEADERS, navTotalReturnDays, normalizeHoldingName, normalizeHoldingNameCore, cleanHoldingTicker, nportUrlFor, parseNportAccessions, parseFundTickerMap, parseCompanyTickerMap, edgarSeriesFilingsUrl, parseEdgarAtomFilings, parseNport, pickEftsCik, parseChart, annualizedToTotal, totalToAnnualized, indicatedYield, inferDistributionFrequency, priceReturns, lastCompletedQuarterEnd, deriveCatalogMetrics, returnsBasisLabel, performanceAsOf, dividendYieldBasisFromKind, normalizeYieldBasis, DIVIDEND_YIELD_BASES,
} from './update-data';

// ---------------------------------------------------------------------------
// Clean, portable environment: no exported control variable leaks in, the time zone is pinned,
// fetch / process.exitCode / env are restored after every test.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if ((CONTROL_NAMES as readonly string[]).includes(key) || key.startsWith('CAPITAL_GROUP_') || key === 'HISTORICAL_PAGE_SIZE' || key === 'GITHUB_STEP_SUMMARY' || key === 'MOCK_FAIL') delete process.env[key];
  }
  process.env.TZ = 'UTC';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exitCode = 0;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

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

const pctChangeOf = (start: number, end: number): number => ((end - start) / start) * 100;
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
const mockUrls: string[] = [];

function installIssuerMock(knobs: Knobs = {}): () => void {
  const original = globalThis.fetch;
  mockCounts.clear(); mockUrls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); mockUrls.push(url);
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

// ---------------------------------------------------------------------------
// controls: resolver, strict validation, defaults, docs and workflow stay in sync (no network)
// ---------------------------------------------------------------------------

const configFile = () => JSON.parse(read('scripts/update-data.config.json'));

describe('controls', () => {
  test('precedence is file < advanced < nonblank inputs < env/protected, with brand aliases', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'CGUS' }, { CONCURRENCY: 3, TICKERS: 'CGCP' }, { CONCURRENCY: '4', TICKERS: '' }, { CAPITAL_GROUP_CONCURRENCY: '5', CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('CGCP');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2'); // blank input does not override
    expect(resolveControls({ TICKERS: 'CGUS' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe(''); // explicit empty advanced does
    expect(resolveControls({ TICKERS: 'CGUS' }, {}, {}, { TICKERS: '' }).TICKERS).toBe(''); // explicit empty env wins
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { CAPITAL_GROUP_LIMIT: '7' }).MAX_FETCHES).toBe('7');
    expect(resolveControls({ HISTORY_PAGE_SIZE: 10 }, {}, {}, { HISTORICAL_PAGE_SIZE: '20' }).HISTORY_PAGE_SIZE).toBe('20');
    expect(resolveControls({}, {}, {}, { UNRELATED: 'x' })).toEqual({});
    const file = configFile();
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  });

  test('strict validation: bad values, unknown keys, non-scalars, CR/LF/NUL and bad ranges are errors', () => {
    for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_RETRIES: 1.5 }, { MAX_FETCHES: 1.5 },
      { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { HISTORY_RANGE: '5 years' }, { HISTORY_RANGE: 'forever' },
      { AUM: '1:2:3' }, { AUM: '42' }, { TER: '5:1' }, { TER: '1' }, { PERFORMANCE_1Y: 'x:y' }, { TOTAL_RETURN_10Y: '9:1' }, { TICKERS: ['CGUS'] }, null, []]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { CAPITAL_GROUP_SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow('integer >= 1');
    expect(() => resolveControls(configFile(), 'x')).toThrow();
    expect(() => resolveControls(configFile(), {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => readConfig({ MAX_RETRIES: 'abc' })).toThrow();
    // ranges: colon is required, min must not exceed max, a non-numeric AUM bound is never a dropped bound
    expect(() => parseRange('15', 'X')).toThrow(/colon is required/);
    expect(() => parseRange('5:1', 'X')).toThrow(/must not exceed/);
    expect(() => parseAumRange('42')).toThrow(/colon is required/);
    for (const bad of ['abc:5B', '5X:10B', '1.2.3B:', ':1.2.3B', 'Infinity:']) expect(() => parseAumRange(bad)).toThrow('AUM');
    expect(() => readConfig({ AUM: 'abc:5B' })).toThrow('AUM');
    // valid forms
    expect(parseRange('', 'X')).toBeUndefined(); expect(parseRange(':', 'X')).toBeUndefined();
    expect(parseRange('2:', 'X')).toEqual({ min: 2, max: undefined }); expect(parseRange(':3', 'X')).toEqual({ min: undefined, max: 3 });
    expect(parseRange('0.1%:0.5%', 'X')).toEqual({ min: 0.1, max: 0.5 }); expect(parseRange('$1:$2', 'X')).toEqual({ min: 1, max: 2 });
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange('10M:2B')).toEqual({ min: 10_000_000, max: 2_000_000_000 });
    expect(parseAumRange('$1,000,000:')).toEqual({ min: 1e6, max: undefined });
    expect(parseAumRange('nano')).toEqual({ min: 0, max: 10_000_000 });
    expect(parseAumRange('large')).toEqual({ min: 10_000_000_000, max: undefined });
  });

  test('defaults resolve to the documented values; filters, presets, SEC contact and USE_SYSTEM_CA reach the config', () => {
    const file = configFile();
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
    const scheduled = resolveControls(file, {}, {}, {});
    expect(scheduled).toEqual(file);
    const config = readConfig(scheduled);
    expect(config).toMatchObject({ maxFetches: 0, requestSleep: 3, concurrency: 1, holdingsPageSize: 250, historyPageSize: 1000, maxRetries: 2, historyRange: 'max', edgarFallback: true, skipYahoo: false, skipIssuer: false, storeRawDownloads: false, useSystemCa: 'auto' });
    expect(config.tickers).toEqual([]);
    expect(config.catalogUrl).toBe('https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html');
    expect(readConfig({}).maxRetries).toBe(2);
    const filtered = readConfig(resolveControls({ AUM: 'small', TER: ':0.5', DIVIDEND_YIELD: '1:', SEC_YIELD: '2:3', PERFORMANCE_3Y: '5:', TOTAL_RETURN_YTD: ':10', TICKERS: 'cgus, CGCP;cgmu' }));
    expect(filtered.aumRange).toEqual({ min: 300_000_000, max: 2_000_000_000 }); expect(filtered.terRange).toEqual({ min: undefined, max: 0.5 });
    expect(filtered.dividendYieldRange?.min).toBe(1); expect(filtered.secYieldRange).toEqual({ min: 2, max: 3 });
    expect(filtered.performanceRanges['3Y']?.min).toBe(5); expect(filtered.totalReturnRanges.YTD?.max).toBe(10);
    expect(filtered.tickers).toEqual(['CGUS', 'CGCP', 'CGMU']);
    expect(readConfig(resolveControls({ HISTORY_RANGE: '5Y' })).historyRange).toBe('5y');
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig({}).secUa).toBe(file.SEC_UA);
    expect(read('scripts/update-data.ts')).not.toMatch(/example\.com/);
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(readConfig(resolveControls(file, {}, {}, { USE_SYSTEM_CA: mode })).useSystemCa).toBe(mode.toLowerCase());
    expect(() => resolveControls(file, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
  });

  test('README, --help, config file and workflow expose the same controls', async () => {
    const doc = read('README.md');
    for (const name of CONTROL_NAMES) expect(doc).toContain('`' + name + '`');
    const child = Bun.spawn([process.execPath, 'scripts/update-data.ts', '--help'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH!, TZ: 'UTC' }, stdout: 'pipe', stderr: 'pipe' });
    const [help, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
      expect(help).toContain(tenor ? `${tenor[1]}_{YTD,1Y,3Y,5Y,10Y}` : name);
    }
    expect(help).not.toContain('daggerok@gmail.com');
    const workflow = read('.github/workflows/update-data.yml');
    const names = [...workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
    for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as any);
    expect(workflow).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(workflow).toContain('resolveControls(file, advanced, individual, protectedVars)');
    expect(workflow).not.toMatch(/\$\{\{\s*inputs\./); expect(workflow).not.toMatch(/OUTPUT_DIR|output_dir/i);
    expect(workflow.match(/git add (\S+)/g)).toEqual(['git add api/capital-group']);
    expect(workflow).toContain('persist-credentials: false'); expect(workflow).toContain('timeout-minutes: 30');
    // controls without an individual input stay reachable through advanced and the config file
    const hidden = CONTROL_NAMES.filter((name) => !names.includes(name.toLowerCase()));
    expect(hidden.sort()).toEqual(['CATALOG_URL', 'SEC_UA', 'SKIP_ISSUER', 'STORE_RAW_DOWNLOADS', 'USE_SYSTEM_CA', 'VERBOSE']);
    expect(resolveControls(configFile(), Object.fromEntries(hidden.map((name) => [name, configFile()[name]])))).toEqual(configFile());
  });

  test('USE_SYSTEM_CA: certificate errors are detected and only auto/true re-exec the script', async () => {
    const certError = Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: certError }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
    let calls = 0; const reexec = (() => { calls++; return undefined as never; });
    const stub = (impl: () => Promise<Response>) => { globalThis.fetch = impl as unknown as typeof fetch; return globalThis.fetch; };
    const original = stub(async () => new Response('ok'));
    installSystemCa('false', reexec, false); expect(globalThis.fetch).toBe(original);
    installSystemCa('auto', reexec, true); expect(globalThis.fetch).toBe(original);
    installSystemCa('true', reexec, true); expect(globalThis.fetch).toBe(original);
    expect(calls).toBe(0);
    installSystemCa('true', reexec, false); expect(calls).toBe(1);
    // auto wraps fetch: a cert error re-execs once, other errors and successes pass through
    stub(async () => { throw new Error('fetch failed', { cause: certError }); });
    installSystemCa('auto', reexec, false);
    await globalThis.fetch('https://example.invalid/'); expect(calls).toBe(2);
    stub(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
    installSystemCa('auto', reexec, false);
    await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('socket hang up'); expect(calls).toBe(2);
    stub(async () => new Response('fine'));
    installSystemCa('auto', reexec, false);
    expect(await (await globalThis.fetch('https://example.invalid/')).text()).toBe('fine'); expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parsing: one tiny inline sample per provider payload; missing values become null, never 0
// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('numbers and dates: zero and negatives are kept, placeholders and junk are null, never 0', () => {
    expect([null, undefined, '', '—', '--', 'abc'].map(sourceNumber)).toEqual([null, null, null, null, null, null]);
    expect(sourceNumber('0')).toBe(0); expect(sourceNumber('-1.5%')).toBe(-1.5); expect(sourceNumber('5.94918104E8')).toBe(594918104);
    expect(sourceDate('9/24/26')).toBe('2026-09-24'); expect(sourceDate('02/30/2026')).toBeNull();
    expect(sourceDate('2024-02-29')).toBe('2024-02-29'); expect(sourceDate('2026-13-01')).toBeNull();
    for (const text of ['--', '—', 'N/A', '$', '%', ',', '$,%', ' $ ']) expect(numberOrNull(text)).toBeNull();
    expect(numberOrNull('$0')).toBe(0); expect(numberOrNull('0.00%')).toBe(0);
    expect(numberOrNull('4.56')).toBe(4.56); expect(numberOrNull('$1,234.56')).toBe(1234.56); expect(numberOrNull('0.40%')).toBe(0.4);
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744'); expect(normalizeNumberText('1.5e-3')).toBe('0.0015');
    expect(normalizeNumberText('1,234.56')).toBe('1234.56'); expect(normalizeNumberText('Apple Inc')).toBe('Apple Inc');
    expect(toIsoDate('08/21/2026')).toBe('2026-08-21'); expect(toIsoDate('2026-8-1')).toBe('2026-08-01'); expect(toIsoDate('n/a')).toBe('n/a');
    expect(formatIssuerDate('2026-08-21')).toBe('08/21/2026'); expect(formatEdgarDate('2026-06-30')).toBe('Jun 30 2026');
    expect(isoToEpoch('2026-01-15')).toBe(Date.UTC(2026, 0, 15) / 1000); expect(isoToEpoch('nope')).toBeNull();
    expect(isoStamp(new Date('2026-10-03T04:05:06.789Z'))).toBe('2026-10-03T04:05:06Z');
  });

  test('issuer catalog, Flight payload, fund facts and returns', () => {
    expect(parseIssuerCatalog('<a href="/advisor/investments/exchange-traded-funds/details/cgus">CGUS</a><a href="/advisor/investments/exchange-traded-funds/details/cgcp">CGCP</a><a href="/advisor/investments/exchange-traded-funds/details/cgus">again</a>')).toEqual(['CGCP', 'CGUS']);
    expect(() => parseIssuerCatalog('<title>American Funds</title>')).toThrow('no fund links');
    const data = factsSample(); (data.details as any).summaryDescription = 'Escaped } ] " \\ text';
    for (const split of [5, 40, 77]) expect(parseIssuerFlight(flightHtml(data, split), 'CGUS')).toEqual(data as any);
    expect(() => parseIssuerFlight(flightHtml(data), 'CGCP')).toThrow('missing');
    expect(() => parseIssuerFlight('<script>alert(1)</script>', 'CGUS')).toThrow();
    const facts = parseIssuerFacts(factsSample(), 'CGUS');
    expect(facts.name).toContain('Capital Group'); expect(facts.netAssets).toBe(11925.5e6);
    expect(facts.trustCik).toBe('0001870102'); expect(facts.inception).toBe('2022-02-22');
    expect(facts.netExpense).toBe(0.33); expect(facts.secYield).toBe(0.77);
    expect(facts.quarterEnd.asOfDate).toBeNull();
    expect(facts.frequency).toEqual({ frequency: 'Quarterly', paymentsPerYear: 4 });
    expect(() => parseIssuerFacts(factsSample('CGCP'), 'CGUS')).toThrow('mismatch');
    const row = { navYear10: '-4', unknown: '999', asOfDate: '08/31/2026', navLifetime: '5', navYtdMonthly: '0', navYear1: '1', navMonth1: '-1', navYear5: '3', navYear3: '2' };
    expect(parseIssuerReturns(row)).toEqual({ asOfDate: '2026-08-31', mo1: -1, ytd: 0, yr1: 1, yr3: 2, yr5: 3, yr10: -4, sinceInception: 5 });
    expect(parseIssuerReturns({ navYear3: null, navYear1: '' }).yr1).toBeNull();
    expect(parseIssuerReturns({ marketPriceYear1: '2' }, 'marketPrice').yr1).toBe(2);
    expect(issuerFrequency('Unrecognized')).toEqual({ frequency: 'Unknown', paymentsPerYear: null });
    expect(issuerFrequency(null).paymentsPerYear).toBeNull();
  });

  test('XLSX holdings, OOXML cells, daily prices and distributions', () => {
    const book = holdingsWorkbook('CGUS', HOLDINGS_ROWS);
    const parsed = parseIssuerHoldings(book, 'CGUS');
    expect(parsed.asOfDate).toBe('2026-09-24'); expect(parsed.rows.length).toBe(3);
    expect(parsed.rows[0].Ticker).toBe('AMZN'); expect(parsed.rows[0].Weight).toBe('7.62'); expect(parsed.rows[0].Identifier).toBe('023135106');
    expect(parsed.rows.find((r) => r.Ticker === 'MSFT')?.Identifier).toBe('594918104');
    expect(parsed.rows.find((r) => r.Name === 'Cash')?.Ticker).toBe('');
    expect(parseIssuerHoldings(book, 'CGUS')).toEqual(parsed);
    expect(() => parseIssuerHoldings(book, 'CGCP')).toThrow('mismatch');
    expect(() => unzipIssuerWorkbook(book.subarray(0, 100))).toThrow();
    expect(unzipIssuerWorkbook(zip({ 'xl/a.xml': '<a/>' })).get('xl/a.xml')).toBe('<a/>');
    const files = new Map([['xl/sharedStrings.xml', '<sst><si><t>A &amp; B</t></si></sst>'], ['xl/worksheets/sheet2.xml', '<worksheet><row r="1"><c r="C1" t="s"><v>0</v></c><c r="E1" t="inlineStr"><is><t>Equity</t></is></c><c r="F1"><v>0</v></c></row></worksheet>']]);
    expect(workbookRows(files)[0][0][2]).toBe('A & B'); expect(workbookRows(files)[0][0][4]).toBe('Equity'); expect(workbookRows(files)[0][0][5]).toBe('0');
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
    expect(HISTORY_HEADERS).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(YAHOO_HISTORY_HEADERS).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
  });

  test('SEC and EDGAR: N-PORT positions, submissions, EFTS, ticker tables and series feed', () => {
    const parsed = parseNport(`
      <nportRegDoc><genInfo><regName>Capital Group Exchange-Traded Fund Trust</regName><regCik>0001870102</regCik>
      <seriesName>Capital Group Core Equity ETF</seriesName><seriesId>S000068402</seriesId>
      <repPdDate>2026-06-30</repPdDate></genInfo>
      <invstOrSec><name>Apple Inc</name><cusip>037833100</cusip><balance>124827810</balance>
      <valUSD>26312454069.90</valUSD><pctVal>8.24</pctVal><assetCat>EC</assetCat></invstOrSec>
      <invstOrSec><title>US TREASURY 4.125% 05/15/2028</title>
      <identifiers><cusip value="912810H80"/></identifiers><balance>5000000</balance>
      <valUSD>5100000</valUSD><pctVal>2.5</pctVal><assetCat>OB</assetCat></invstOrSec>
      </nportRegDoc>`);
    expect(parsed.seriesName).toBe('Capital Group Core Equity ETF'); expect(parsed.regCik).toBe('0001870102'); expect(parsed.repPdDate).toBe('2026-06-30');
    expect(parsed.holdings.length).toBe(2); expect(parsed.holdings[0].Identifier).toBe('037833100'); expect(parsed.holdings[0].Ticker).toBe('-');
    expect(parsed.holdings[1].Identifier).toBe('912810H80'); expect(parsed.holdings[1].Name).toBe('US TREASURY 4.125% 05/15/2028');
    expect(parsed.totalValue).toBeCloseTo(26317554069.9, 1); expect(parsed.netAssets).toBeNull();
    expect(parseNport('<genInfo><seriesName>X</seriesName></genInfo><fundInfo><totAssets>9</totAssets><netAssets>87850000000.00</netAssets></fundInfo>').netAssets).toBe(87850000000);
    expect(parseNport('<invstOrSec><name>FUND X</name><cusip>N/A</cusip><identifiers><other value="XSCUSIP1"/></identifiers><valUSD>10</valUSD></invstOrSec>').holdings[0].Identifier).toBe('XSCUSIP1');
    expect(parseNport('<genInfo><seriesName>Empty</seriesName></genInfo>')).toMatchObject({ holdings: [], totalValue: 0 });
    const accessions = parseNportAccessions({ cik: '913760', filings: { recent: {
      form: ['NPORT-P', '13F-HR', 'NPORT-P'], accessionNumber: ['0000913760-26-000111', '0000913760-26-000112', '0000913760-26-000113'],
      filingDate: ['2026-07-21', '2026-08-10', '2026-04-21'], reportDate: ['2026-06-30', '2026-06-30', '2026-03-31'] } } });
    expect(accessions.map((entry) => entry.accession)).toEqual(['0000913760-26-000111', '0000913760-26-000113']);
    expect(accessions[0].url).toBe(nportUrlFor('0000913760', '0000913760-26-000111'));
    const efts = { hits: [{ _source: { display_names: { cik: 12345, names: ['Some Other Trust'] } } }, { _source: { display_names: { cik: 1870102, names: ['Capital Group Core Equity ETF', 'CAPITAL GROUP EXCHANGE-TRADED FUND TRUST'] } } }] };
    expect(pickEftsCik(efts, 'Capital Group Core Equity ETF')).toBe('0001870102'); expect(pickEftsCik(efts, 'Unknown Fund')).toBeNull();
    const real = { hits: { total: { value: 2, relation: 'eq' }, hits: [
      { _source: { ciks: ['0001667919'], display_names: ['FIRST TRUST EXCHANGE-TRADED FUND VIII  (CIK 0001667919)'] } },
      { _source: { ciks: ['0001870102'], display_names: ['CAPITAL GROUP EXCHANGE-TRADED FUND TRUST  (CIK 0001870102)'] } }] } };
    expect(pickEftsCik(real, 'Capital Group Exchange-Traded Fund Trust')).toBe('0001870102');
    const map = parseFundTickerMap({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1870102, 'S000068402', 'C000218810', 'CGUS'], [1870102, 'S000061995', 'C000200806', 'cgmu'], [0, 'S000000000', 'C000000000', 'ZZZ']] });
    expect(map.get('CGUS')).toEqual({ cik: '0001870102', seriesId: 'S000068402', classId: 'C000218810' });
    expect(map.get('CGMU')?.seriesId).toBe('S000061995'); expect(map.has('ZZZ')).toBe(false);
    expect(parseFundTickerMap({}).size).toBe(0); expect(parseFundTickerMap({ fields: ['cik'], data: ['nope'] }).size).toBe(0);
    const companies = parseCompanyTickerMap({ '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' }, '2': { cik_str: 1, ticker: '', title: 'No Ticker Inc' } });
    expect(companies.get(normalizeHoldingName('NVIDIA Corp'))).toBe('NVDA'); expect(companies.get(normalizeHoldingName('No Ticker Inc'))).toBeUndefined();
    const url = edgarSeriesFilingsUrl('S000060812', 5);
    for (const part of ['https://www.sec.gov/cgi-bin/browse-edgar?', 'CIK=S000060812', 'type=NPORT-P', 'output=atom', 'count=5']) expect(url).toContain(part);
    const atom = `<feed>
      <entry><accession-number>0001209466-26-000952</accession-number><filing-date>2026-06-29</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/0001209466-26-000952-index.htm</filing-href><filing-type>NPORT-P</filing-type></entry>
      <entry><accession-number>0001209466-26-000514</accession-number><filing-date>2026-04-01</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000514/0001209466-26-000514-index.htm</filing-href><filing-type>NPORT-P</filing-type></entry>
      <entry><accession-number>0001209466-26-000001</accession-number><filing-date>2026-01-05</filing-date><filing-type>N-CEN</filing-type></entry></feed>`;
    const filings = parseEdgarAtomFilings(atom);
    expect(filings.map((entry) => entry.accession)).toEqual(['0001209466-26-000952', '0001209466-26-000514']);
    expect(filings[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/primary_doc.xml');
    expect(parseEdgarAtomFilings('')).toEqual([]); expect(parseEdgarAtomFilings('<feed><entry><filing-type>10-K</filing-type></entry></feed>')).toEqual([]);
  });

  test('Yahoo chart and holding name/ticker normalization', () => {
    const chart = parseChart(chartFixture({ closes: [100, null, 110], adj: [90, null, 99] }));
    expect(chart.days.map((day) => day.close)).toEqual([100, 110]); expect(chart.days.map((day) => day.adjClose)).toEqual([90, 99]);
    expect(chart.navPrice).toBe(706.3); expect(chart.exchangeName).toBe('NasdaqGS');
    const noAdj = chartFixture({ closes: [100, 101] }) as any; delete noAdj.chart.result[0].indicators.adjclose;
    expect(parseChart(noAdj).days.map((day) => day.adjClose)).toEqual([100, 101]);
    const dividends = parseChart(chartFixture({ dividends: { '2': { date: Date.UTC(2026, 5, 15) / 1000, amount: 0.7 }, '1': { date: Date.UTC(2026, 2, 15) / 1000, amount: 0.65 }, '0': { date: Date.UTC(2025, 11, 15) / 1000, amount: -1 } } }));
    expect(dividends.dividends.map((entry) => entry.amount)).toEqual([0.65, 0.7]);
    expect(() => parseChart({ chart: { result: [] } })).toThrow(/empty result/);
    expect(normalizeHoldingName('Apple Inc.')).toBe('APPLE'); expect(normalizeHoldingName('Microsoft Corp Common Stock')).toBe('MICROSOFT'); expect(normalizeHoldingName('THE BOEING CO')).toBe('BOEING');
    expect(normalizeHoldingName('Alphabet Inc. Class C Capital Stock')).toBe('ALPHABET CL C'); expect(normalizeHoldingName('Alphabet Inc Cl C')).toBe('ALPHABET CL C');
    expect(normalizeHoldingName('Alphabet Inc Cl A')).not.toBe(normalizeHoldingName('Alphabet Inc Cl C'));
    expect(normalizeHoldingName('Berkshire Hathaway Inc Del')).toBe('BERKSHIRE HATHAWAY'); expect(normalizeHoldingName('Berkshire Hathaway Inc Cap Stock Class A')).toBe('BERKSHIRE HATHAWAY CL A');
    expect(normalizeHoldingName('')).toBe(''); expect(normalizeHoldingName('---')).toBe(''); expect(normalizeHoldingNameCore('Apple Inc.')).toBe('APPLE');
    expect(cleanHoldingTicker('brk-b')).toBe('BRK-B'); expect(cleanHoldingTicker('SCE^L')).toBe('SCE^L'); expect(cleanHoldingTicker('BF/A')).toBe('BF/A');
    for (const junk of ['', 'N/A', 'see file']) expect(cleanHoldingTicker(junk)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// metrics: derived returns, young-fund horizons, one key set, returnsBasis + performanceAsOf travel together
// ---------------------------------------------------------------------------

describe('metrics', () => {
  const noOfficial = { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
  const noDerived = { asOfDate: '2026-09-25', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null };

  test('price returns are derived from the last close; young funds and thin coverage give null', () => {
    const days = [
      { date: '2015-01-02', close: 100, adjClose: 100, volume: 1 }, { date: '2022-01-03', close: 200, adjClose: 195, volume: 1 },
      { date: '2023-01-03', close: 220, adjClose: 214, volume: 1 }, { date: '2026-01-02', close: 300, adjClose: 290, volume: 1 },
      { date: '2026-06-30', close: 320, adjClose: 310, volume: 1 }, { date: '2026-07-01', close: 322, adjClose: 312, volume: 1 },
      { date: '2026-08-21', close: 340, adjClose: 330, volume: 1 },
    ];
    const now = new Date(Date.UTC(2026, 7, 21));
    const returns = priceReturns(days, now);
    expect(returns.asOfDate).toBe('2026-08-21');
    expect(returns.ytd).toBeCloseTo(54.21, 2); expect(returns.yr1).toBeCloseTo(54.21, 2); // thin fixture falls back to the newest day early enough
    expect(returns.cagr3y).toBeCloseTo(15.53, 2); expect(returns.mo1).toBeCloseTo(5.77, 2); expect(returns.siAnn).toBeGreaterThan(0);
    const young = priceReturns([{ date: '2026-08-20', close: 10, adjClose: 10, volume: 1 }], now);
    expect(young).toMatchObject({ asOfDate: '2026-08-20', ytd: null, cagr3y: null, siAnn: null });
    expect(priceReturns([], now).asOfDate).toBe('');
    // windows that start before the reinvestment coverage are not derived
    const covered = priceReturns(days, now, '2026-06-29');
    expect([covered.siAnn, covered.ytd, covered.yr1, covered.cagr3y]).toEqual([null, null, null, null]);
    expect(covered.qtd).toBeCloseTo(pctChangeOf(312, 330), 2); expect(covered.mo1).toBeCloseTo(pctChangeOf(312, 330), 2);
    expect(priceReturns(days, now, '2015-01-02')).toEqual(priceReturns(days, now));
    // derived since-inception needs at least one year
    const short = Array.from({ length: 300 }, (_, index) => ({ date: new Date(Date.parse('2025-12-01T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10), close: 10 + index * 0.01, adjClose: 10 + index * 0.01, volume: 1 }));
    expect(priceReturns(short, new Date('2026-09-26T00:00:00Z')).siAnn).toBeNull();
    for (const [date, quarter] of [[Date.UTC(2026, 7, 21), '2026-06-30'], [Date.UTC(2026, 0, 15), '2025-12-31'], [Date.UTC(2026, 4, 1), '2026-03-31'], [Date.UTC(2026, 10, 1), '2026-09-30']] as const) {
      expect(lastCompletedQuarterEnd(new Date(date)).toISOString().slice(0, 10)).toBe(quarter);
    }
  });

  test('NAV total return reinvests distributions; annualized, yield and frequency helpers guard bad input', () => {
    const points = [
      { date: '2026-08-29', nav: 56.3, marketPrice: 56.31, premiumDiscount: 0.0178 }, { date: '2026-09-01', nav: 55.9, marketPrice: 55.92, premiumDiscount: 0.0358 },
      { date: '2026-09-17', nav: 56.4101, marketPrice: 56.43, premiumDiscount: 0.0353 },
    ];
    const dividends = [{ epoch: isoToEpoch('2026-09-01')!, amount: 0.37421, exDate: '2026-09-01', payDate: '', recordDate: '', reinvestNav: 55.9, type: 'DVDYLD' }];
    const days = navTotalReturnDays(points, dividends);
    expect(days[0]).toEqual({ date: '2026-08-29', close: 56.3, adjClose: 56.3, volume: 0 });
    const factor = 1 + 0.37421 / 55.9;
    expect(days[1].adjClose).toBeCloseTo(55.9 * factor, 6); expect(days[2].adjClose).toBeCloseTo(56.4101 * factor, 6);
    const exOnly = navTotalReturnDays(points.slice(0, 2).map((p) => ({ ...p, nav: 50 })), [
      { ...dividends[0], exDate: '2026-08-01', epoch: isoToEpoch('2026-08-01')!, amount: 1, reinvestNav: null }, { ...dividends[0], amount: 0.5, reinvestNav: null }]);
    expect(exOnly[1].adjClose).toBeCloseTo(50 * 1.01, 6); // ex-date NAV used, pre-history payout skipped
    expect(navTotalReturnDays([], dividends)).toEqual([]);
    expect(annualizedToTotal(20.15, 3)).toBeCloseTo(73.45, 2); expect(annualizedToTotal(null, 3)).toBeNull(); expect(annualizedToTotal(10, 0)).toBeNull();
    expect(totalToAnnualized(annualizedToTotal(12.5, 5), 5)).toBeCloseTo(12.5, 1); expect(totalToAnnualized('n/a' as any, 5)).toBeNull();
    expect(indicatedYield(0.65, 12, 41.72)).toBe(18.7);
    expect([indicatedYield(null, 4, 10), indicatedYield(0.5, 0, 10), indicatedYield(0.5, 4, 0)]).toEqual([null, null, null]);
    const quarterly = [0, 1, 2, 3].map((i) => ({ epoch: Date.UTC(2026, i * 3, 15) / 1000, amount: 1 }));
    expect(inferDistributionFrequency(quarterly).frequency).toBe('Quarterly');
    expect(inferDistributionFrequency(Array.from({ length: 6 }, (_, i) => ({ epoch: Date.UTC(2026, i, 15) / 1000, amount: 1 })))).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
  });

  test('catalog metrics: official wins, derived fills gaps, returnsBasis and performanceAsOf always travel together', () => {
    const official = deriveCatalogMetrics({ ytd: 15.97, yr1: 18.34, yr3: 20.15, yr5: 17.42, yr10: 16.88, sinceInception: 19.44 },
      { asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99, cagr5y: 12, cagr10y: 11, siAnn: 10, mo1: 1, qtd: 2 }, 0.44, null, null, null, 706.32);
    expect(official).toMatchObject({ ytd: 15.97, tr1y: 18.34, cagr3y: 20.15, tr3y: annualizedToTotal(20.15, 3), dividendYield: 0.44, secYield: null });
    expect(official.returnsBasis).toContain('official Capital Group NAV total returns');
    expect(Object.keys(official).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    const derived = deriveCatalogMetrics(noOfficial, { ...noDerived, asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99 }, null, null, 0.65, 12, 41.72);
    expect(derived).toMatchObject({ ytd: 13.79, tr1y: 54.21, cagr5y: null, dividendYield: 18.7, dividendYieldText: '18.70%', performanceAsOf: '2026-08-21' });
    expect(derived.returnsBasis).toContain('not official NAV returns');
    const cumulative = deriveCatalogMetrics({ ytd: 5.36, yr1: 9.05, yr3: 9.51, yr5: 10.02, yr10: null, sinceInception: 11.25 }, { ...noDerived, asOfDate: '2026-09-18', ytd: 3.7, yr1: 9 },
      8.42, 7.59, 0.37421, 12, 56.24, { yr1: 9.05, yr3: 31.33, yr5: 61.17, yr10: null, sinceInception: 95.24 });
    expect(cumulative).toMatchObject({ tr3y: 31.33, tr5y: 61.17, tr10y: null, cagr3y: 9.51, secYield: 7.59, secYieldText: '7.59%' });
    const mixed = deriveCatalogMetrics({ ...noOfficial, ytd: 5 }, { ...noDerived, ytd: 4, yr1: 9 }, null, null, null, null, null, null, '2026-08-31');
    expect(mixed).toMatchObject({ ytd: 5, tr1y: 9, performanceAsOf: '2026-08-31' }); expect(String(mixed.returnsBasis)).toContain('missing periods are derived');
    const officialOnly = deriveCatalogMetrics({ ...noOfficial, ytd: 5, yr1: 6 }, { ...noDerived, ytd: 4, yr1: 9 }, null, null, null, null, null, null, '2026-08-31');
    expect(officialOnly.returnsBasis).toBe('official Capital Group NAV total returns (fund-detail JSON)');
    expect([officialOnly.dividendYieldText, officialOnly.secYieldText]).toEqual([null, null]);
    expect(performanceAsOf(false, '2026-08-31', '2026-09-25')).toBe('2026-09-25'); expect(performanceAsOf(true, null, '2026-09-25')).toBe('2026-09-25');
    expect(performanceAsOf(false, null, '')).toBeNull(); expect(performanceAsOf(true, 'Aug 31 2026', null)).toBeNull();
    for (const official of [true, false]) for (const yahoo of [true, false]) {
      const label = returnsBasisLabel(official, yahoo);
      expect(label.length).toBeGreaterThan(10); expect(label).not.toBe('-'); expect(label.includes('Yahoo')).toBe(yahoo);
    }
  });

  test('dividendYieldBasis: code per yield source, null with a null yield, one key set on fresh, rebuilt and placeholder rows', () => {
    const none = { ...noDerived };
    // estimate: latest distribution x payments per year / price
    const estimated = deriveCatalogMetrics(noOfficial, none, null, null, 0.65, 12, 41.72);
    expect(estimated).toMatchObject({ dividendYield: 18.7, dividendYieldBasis: 'indicated' });
    // issuer-published yield (kind text -> code); an unknown kind is official-other, never a guess at a definition
    const kinds: Array<[string, string]> = [['trailing 12-month distribution yield', 'official-trailing-12m'], ['12-month trailing yield', 'official-trailing-12m'],
      ['distribution rate', 'official-distribution-rate'], ['', 'official-other'], ['SEC-like yield', 'official-other']];
    for (const [kind, code] of kinds) {
      expect(dividendYieldBasisFromKind(kind)).toBe(code);
      expect(deriveCatalogMetrics(noOfficial, none, 1.5, null, 0.65, 12, 41.72, null, null, false, code).dividendYieldBasis).toBe(code);
    }
    expect(deriveCatalogMetrics(noOfficial, none, 1.5, null, null, null, null).dividendYieldBasis).toBe('official-other'); // retained yield without a stored code
    expect(deriveCatalogMetrics(noOfficial, none, 1.5, null, null, null, null, null, null, false, 'bogus').dividendYieldBasis).toBe('official-other');
    expect(deriveCatalogMetrics(noOfficial, none, 0, null, null, null, null, null, null, false, 'official-trailing-12m')).toMatchObject({ dividendYield: 0, dividendYieldBasis: 'official-trailing-12m' });
    // null yield -> null code, even when a code is passed
    expect(deriveCatalogMetrics(noOfficial, none, null, null, null, null, null, null, null, false, 'official-trailing-12m').dividendYieldBasis).toBeNull();
    expect(DIVIDEND_YIELD_BASES).toHaveLength(5);
    // rows rebuilt from the index: the key is added after dividendYieldText, a stale code never survives a null yield
    const keys = Object.keys(estimated);
    const legacy = Object.fromEntries(Object.entries(estimated).filter(([key]) => key !== 'dividendYieldBasis'));
    expect(Object.keys(normalizeYieldBasis(legacy))).toEqual(keys);
    expect(normalizeYieldBasis(legacy).dividendYieldBasis).toBe('indicated');
    expect(normalizeYieldBasis({ ...estimated, dividendYield: null, dividendYieldText: null, dividendYieldBasis: 'indicated' }).dividendYieldBasis).toBeNull();
    expect(normalizeYieldBasis({ ...estimated, dividendYieldBasis: 'official-trailing-12m' }).dividendYieldBasis).toBe('official-trailing-12m');
    expect(normalizeYieldBasis({ ...estimated, dividendYieldBasis: 'nonsense' }).dividendYieldBasis).toBe('indicated');
    // placeholder (all-null) row has the same key set
    expect(Object.keys(normalizeYieldBasis({ ytd: null, dividendYield: null, dividendYieldText: null, secYield: null }))).toEqual(['ytd', 'dividendYield', 'dividendYieldText', 'dividendYieldBasis', 'secYield']);
  });

  test('young funds: 3Y and longer horizons are null at the returns date, in helper and in the published feed', async () => {
    const returns = { asOfDate: '8/31/26', navMonth1: '0.8', navYtdMonthly: '12.5', navYear1: '17.8', navYear3: '16.48', navYear5: null, navYear10: null, navLifetime: '17.69' };
    await withFeed({ catalog: ['CGBL'], facts: { CGBL: { inception: '9/26/23', returns } } }, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGBL' });
      const published = await row('CGBL');
      expect(published.metrics.cagr3y).toBeNull(); expect(published.metrics.tr3y).toBeNull(); expect(published.returns.monthEnd.yr3).toBeNull();
      expect(published.metrics.tr1y).toBe(17.8);
      expect((await meta('CGBL')).returns.monthEnd.yr3).toBeNull();
    });
    const base = { ytd: 1, yr1: 2, yr3: 3, yr5: 4, yr10: 5, sinceInception: 6 };
    expect(ageGuardReturns(base, '2023-09-26', '2026-08-31')).toMatchObject({ yr1: 2, yr3: null, yr5: null, yr10: null, sinceInception: 6 });
    expect(ageGuardReturns(base, '2026-03-01', '2026-08-31')).toMatchObject({ ytd: 1, yr1: null, sinceInception: null });
    expect(ageGuardReturns(base, '2010-01-01', '2026-08-31')).toEqual(base);
    expect(ageGuardReturns(base, null, '2026-08-31')).toEqual(base);
  });

  test('published rows: TER net/gross, no float artifacts, fresher daily NAV wins, fresh nulls stay null', async () => {
    await withFeed({ facts: { CGUS: { net: '0.33', gross: '0.45', assets: '8399.7' } } }, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const published = await row('CGUS');
      expect(published).toMatchObject({ terValue: 0.33, terGrossValue: 0.45, aumValue: 8399700000 });
      expect((await meta('CGUS')).expenseRatio).toMatchObject({ value: 0.33, net: 0.33, gross: 0.45 });
      expect(published.metrics).toMatchObject({ secYield: 0.77, cagr3y: 21.02 }); expect(published.metrics.dividendYield).not.toBeNull();
      // second run: the issuer now reports nulls - they publish as nulls and never keep the old number or pair with a new date
      const nulled = { asOfDate: '9/30/26', navMonth1: '1', navYtdMonthly: '13', navYear1: null, navYear3: null, navYear5: null, navYear10: null, navLifetime: '11' };
      await run({ TICKERS: 'CGUS' }, { noDistributions: true, facts: { CGUS: { secYield: null, returns: nulled } } });
      const second = await row('CGUS');
      for (const key of ['secYield', 'secYieldText', 'dividendYield', 'cagr3y', 'tr3y']) expect(second.metrics[key]).toBeNull();
      expect(second.metrics.ytd).toBe(13); expect(second.metrics.performanceAsOf <= '2026-09-30').toBe(true);
      const stored = await meta('CGUS');
      expect(stored.yields.secYield).toBeNull(); expect(stored.yields.dividendYield).toBeNull();
    });
    await withFeed({ catalog: ['CGMS'], facts: { CGMS: { nav: '27.01', priceDate: '9/3/26' } } }, async ({ run, row, meta }) => {
      await run({ TICKERS: 'CGMS' }); // a newer daily price API point beats the stale fund-facts NAV
      expect((await row('CGMS')).asOfDate).toBe('Sep 25 2026'); expect((await row('CGMS')).navValue).not.toBe(27.01);
      expect((await meta('CGMS')).nav.asOfDate).toBe('Sep 25 2026');
    });
  });
});

// ---------------------------------------------------------------------------
// pipeline: mocked issuer / Yahoo / SEC in-process runs, plus one offline CLI run
// ---------------------------------------------------------------------------

/** All files under a directory as [path, content, mtime], sorted, so reruns can be compared byte for byte. */
async function snapshot(dir: string): Promise<Array<[string, string, number]>> {
  const out: Array<[string, string, number]> = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full); else out.push([full, await readFile(full, 'utf8'), (await stat(full)).mtimeMs]);
    }
  };
  await walk(dir);
  return out;
}

describe('pipeline', () => {
  test('a one-ticker run keeps every catalog row: seeds get dataFile null and the same metrics key set, new funds are reported', async () => {
    await withFeed({ catalog: ['CGUS', 'CGCP', 'CGMU'] }, async ({ run, dir }) => {
      const summary = join(dir, 'summary.md');
      process.env.GITHUB_STEP_SUMMARY = summary;
      const feed = async () => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).funds;
      await run({ TICKERS: 'CGUS' }); // empty feed: the other catalog funds become seed rows without meta
      const seeded = await feed();
      expect(seeded.map((fund: any) => fund.ticker)).toEqual(['CGCP', 'CGMU', 'CGUS']);
      expect((await readdir(join(dir, 'funds'))).sort()).toEqual(['CGUS']);
      for (const fund of seeded) expect(Object.keys(fund.metrics)).toEqual(Object.keys(seeded[2].metrics));
      expect(seeded[0].metrics.dividendYieldBasis).toBeNull();
      expect(seeded[2].metrics.dividendYieldBasis).toBe(seeded[2].metrics.dividendYield === null ? null : 'indicated');
      expect(seeded.map((fund: any) => fund.dataFile === null)).toEqual([true, true, false]);
      expect(seeded[0].metrics.ytd).toBeNull(); expect(seeded[0].metrics.returnsBasis.length).toBeGreaterThan(10);
      await run({}); // all funds published
      expect((await feed()).every((fund: any) => fund.dataFile !== null)).toBe(true);
      await run({ TICKERS: 'CGUS' }); // a one-ticker run never shrinks the feed
      const rows = await feed();
      expect(rows.map((fund: any) => fund.ticker)).toEqual(['CGCP', 'CGMU', 'CGUS']);
      expect(rows.every((fund: any) => fund.dataFile !== null)).toBe(true);
      expect((await readdir(join(dir, 'funds'))).sort()).toEqual(['CGCP', 'CGMU', 'CGUS']);
      const report = await run({ TICKERS: 'CGUS' }, { catalog: ['CGUS', 'CGCP', 'CGMU', 'CGXU'] });
      expect(report.newFunds).toEqual(['CGXU']);
      expect(await readFile(summary, 'utf8')).toContain('NEW FUNDS: CGXU');
      await expect(run({ TICKERS: 'NOPE' })).rejects.toThrow('absent from catalog');
      expect(await feed()).toHaveLength(4);
    });
  });

  test('a second identical run writes nothing, stamps included', async () => {
    await withFeed({ catalog: ['CGUS', 'CGCP'] }, async ({ run, dir }) => {
      await run({});
      const first = await snapshot(dir);
      await Bun.sleep(20);
      await run({});
      expect(await snapshot(dir)).toEqual(first);
    });
  });

  test('a failed source keeps the fund exactly as published; N-PORT only replaces strictly older holdings', async () => {
    await withFeed({}, async ({ run, dir, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const files = ['funds/CGUS/meta.json', 'funds/CGUS/holdings/001.json', 'funds/CGUS/history/001.json', 'index.json'];
      const read = () => Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
      const before = await read();
      const outage = await run({ TICKERS: 'CGUS' }, { dead: { CGUS: ['facts'] } });
      expect(outage.failed).toEqual(['CGUS']); expect(outage.exitCode).toBe(1);
      expect(await read()).toEqual(before);
      // an N-PORT report not newer than the published holdings never replaces them
      const stale = await run({ TICKERS: 'CGUS', EDGAR_FALLBACK: '1' }, { dead: { CGUS: ['holdings'] }, nport: { repPdDate: '2026-06-30' } });
      expect(stale.failed).toEqual(['CGUS']);
      expect((await meta('CGUS')).holdings).toMatchObject({ source: 'Capital Group daily holdings XLSX', asOfDate: '2026-09-24' });
      expect(await read()).toEqual(before);
    });
    await withFeed({ holdingsDate: '6/1/2026' }, async ({ run, meta }) => {
      await run({ TICKERS: 'CGUS' });
      const report = await run({ TICKERS: 'CGUS', EDGAR_FALLBACK: '1' }, { dead: { CGUS: ['holdings'] }, nport: { repPdDate: '2026-08-31' } });
      expect(report.failed).toEqual([]);
      const stored = await meta('CGUS');
      expect(stored.holdings.source).toContain('SEC EDGAR Form N-PORT-P'); expect(stored.holdings.asOfDate).toBe('2026-08-31');
    });
  });

  test('history is never replaced by a different source or truncated', async () => {
    await withFeed({ historyDays: 900 }, async ({ run, meta, dir }) => {
      await run({ TICKERS: 'CGUS' });
      const before = await readFile(join(dir, 'funds', 'CGUS', 'history', '001.json'), 'utf8');
      const report = await run({ TICKERS: 'CGUS', HISTORY_RANGE: '5y' }, { dead: { CGUS: ['history'] }, yahooDays: 300 });
      expect(report.failed).toEqual(['CGUS']);
      expect(await readFile(join(dir, 'funds', 'CGUS', 'history', '001.json'), 'utf8')).toBe(before);
      const stored = await meta('CGUS');
      expect(stored.history.totalRows).toBe(900); expect(stored.history.source).toContain('capitalgroup.com daily price API');
    });
    await withFeed({ dead: { CGUS: ['history'] }, yahooDays: 900 }, async ({ run, meta }) => {
      await run({ TICKERS: 'CGUS' }); // no previous state: the Yahoo fallback is used
      expect((await meta('CGUS')).history.totalRows).toBe(900);
      await run({ TICKERS: 'CGUS', SKIP_ISSUER: '1', HISTORY_RANGE: '2y' }, { yahooDays: 300 }); // shorter window merges older rows back
      expect((await meta('CGUS')).history.totalRows).toBe(900);
    });
    await withFeed({ historyDays: 50 }, async ({ run, meta, dir }) => {
      await run({ TICKERS: 'CGUS' });
      await run({ TICKERS: 'CGUS', SKIP_ISSUER: '1' }, { yahooDays: 300 }); // official NAV rows are not replaced by Yahoo closes
      expect((await meta('CGUS')).history.totalRows).toBe(50);
      expect(JSON.parse(await readFile(join(dir, 'funds', 'CGUS', 'history', '001.json'), 'utf8')).headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    });
    const previous = [{ Date: 'Jan 02 2026', Close: '1' }, { Date: 'Jun 01 2026', Close: '2' }];
    expect(mergeHistoryRows(previous, ['Date', 'Close'], ['Date', 'Close'], [{ Date: 'Jun 01 2026', Close: '3' }]).map((r) => r.Close)).toEqual(['1', '3']);
    expect(mergeHistoryRows(previous, ['Date', 'Close'], ['Date', 'NAV'], [{ Date: 'Jun 01 2026', NAV: '3' }])).toHaveLength(1);
    expect(mergeHistoryRows([], [], ['Date'], [{ Date: 'Jun 01 2026' }])).toHaveLength(1);
  });

  test('retention helpers and writes: real zero is kept, writes are atomic, stale pages go last', async () => {
    expect(retainUnavailable({ yields: { secYield: null, dividendYield: 0 }, name: '—' }, { yields: { secYield: 3, dividendYield: 4 }, name: 'Fund' })).toEqual({ yields: { secYield: 3, dividendYield: 0 }, name: 'Fund' });
    expect(samePublishedContent(JSON.stringify({ generatedAt: 'old', source: { catalogReadAt: 'old', value: 0 } }), { generatedAt: 'new', source: { catalogReadAt: 'new', value: 0 } })).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'cg-pages-'));
    try {
      const url = new URL(`file://${dir}/`); const rows = [{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }];
      const manifest = await writePages(url, 'CGUS', 'holdings', ['Name'], rows, 2);
      expect(manifest.pages).toEqual(['holdings/001.json', 'holdings/002.json']); expect(manifest.totalRows).toBe(3);
      const before = await readFile(join(dir, 'holdings/001.json'), 'utf8');
      await writePages(url, 'CGUS', 'holdings', ['Name'], rows, 2);
      expect(await readFile(join(dir, 'holdings/001.json'), 'utf8')).toBe(before);
      const shrunk = await writePages(url, 'CGUS', 'holdings', ['Name'], [{ Name: 'a' }], 2);
      expect((await readdir(join(dir, 'holdings'))).sort()).toEqual(['001.json', '002.json']);
      await removeStalePages(url, 'holdings', new Set(shrunk.pages));
      expect((await readdir(join(dir, 'holdings'))).sort()).toEqual(['001.json']);
      const file = new URL(`file://${dir}/x/a.json`);
      await writeFileAtomic(file, '{"a":1}\n');
      expect(await writeIfChanged(file, { a: 1 })).toBe(false); expect(await writeIfChanged(file, { a: 2 })).toBe(true);
      await expect(writeFileAtomic(new URL(`file://${dir}/x/a.json/nested.json`), 'z')).rejects.toBeDefined();
      expect(JSON.parse(await readFile(join(dir, 'x', 'a.json'), 'utf8'))).toEqual({ a: 2 });
      expect((await readdir(join(dir, 'x'))).sort()).toEqual(['a.json']);
    } finally { await rm(dir, { recursive: true, force: true }); }
    await withFeed({ historyDays: 5 }, async ({ run, dir: feed }) => {
      await run({ TICKERS: 'CGUS', HISTORY_PAGE_SIZE: '2' });
      const historyDir = join(feed, 'funds', 'CGUS', 'history');
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      await rm(join(feed, 'funds', 'CGUS', 'meta.json'));
      await mkdir(join(feed, 'funds', 'CGUS', 'meta.json', 'blocker'), { recursive: true }); // meta.json cannot be written
      expect((await run({ TICKERS: 'CGUS', HISTORY_PAGE_SIZE: '5' })).failed).toEqual(['CGUS']);
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']); // stale pages survive
      await rm(join(feed, 'funds', 'CGUS', 'meta.json'), { recursive: true, force: true });
      await run({ TICKERS: 'CGUS', HISTORY_PAGE_SIZE: '5' });
      expect((await readdir(historyDir)).sort()).toEqual(['001.json']);
    });
  });

  test('batch cursor: moves after an all-failing batch, follows queue order, wraps, ignores TICKERS runs and filtered-out funds', async () => {
    await withFeed({ catalog: ['CGCP', 'CGMU', 'CGUS', 'CGXU'], dead: { ALL: ['facts', 'holdings', 'history', 'yahoo'] } }, async ({ run, dir }) => {
      const report = await run({ MAX_FETCHES: '2' });
      expect(report.failed.sort()).toEqual(['CGCP', 'CGMU']);
      expect((await readCursorScopes()).all).toBe('CGMU');
      const concurrent = await run({ MAX_FETCHES: '2', CONCURRENCY: '2' });
      expect(concurrent.selected).toEqual(['CGUS', 'CGXU']);
      expect((await readCursorScopes()).all).toBe('CGXU'); // furthest started fund in queue order, not the last to finish
      expect((await run({ TICKERS: 'CGMU', MAX_FETCHES: '1' })).selected).toEqual(['CGMU']);
      expect(JSON.parse(await readFile(join(dir, 'update-state.json'), 'utf8')).scopes.all).toBe('CGXU');
      await run({ TICKERS: 'CGMU' });
      expect((await readCursorScopes()).all).toBe('CGXU');
      await run({}); // an unfiltered full pass resets it
      expect((await readCursorScopes()).all).toBeUndefined();
      await writeCursorScope('all', 'CGCP');
      expect((await readCursorScopes()).all).toBe('CGCP');
    });
    await withFeed({ catalog: ['CGCP', 'CGMU', 'CGUS'] }, async ({ run, row }) => {
      await run({});
      expect((await row('CGUS')).aumValue).toBeGreaterThan(1e9);
      expect((await run({ MAX_FETCHES: '2' })).selected).toEqual(['CGCP', 'CGMU']);
      expect((await run({ MAX_FETCHES: '2' })).selected).toEqual(['CGUS', 'CGCP']); // wraps instead of a short last batch
      expect((await run({ MAX_FETCHES: '2', AUM: '999T:' })).selected).toEqual([]); // nothing can pass the filter, nothing is requested
    });
  });

  test('a soft deadline stops taking new funds, still writes the index and moves the cursor by started funds only', async () => {
    expect(RUN_SOFT_DEADLINE_MS).toBe(25 * 60_000);
    await withFeed({ catalog: ['CGCP', 'CGMU', 'CGUS'] }, async ({ run, dir }) => {
      let clock = 0;
      const report = await run({ MAX_FETCHES: '3' }, undefined, { deadlineMs: 5_000, now: () => { clock += 4_000; return clock; } });
      expect(report.deadlineReached).toBe(true); expect(report.updated.length).toBeLessThan(3);
      expect(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).funds).toHaveLength(3);
      expect((await readCursorScopes()).all).toBe(report.selected[report.updated.length + report.failed.length + report.skipped.length - 1]);
    });
  });

  test('offline CLI: ticker bound keeps unrequested rows, repeat run is unchanged, failures keep files, bad controls fail before any write', async () => {
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
      await writeFile(join(dir, 'preload.ts'), `
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
};`);
      const run = async (extra: Record<string, string> = {}) => {
        const env = { PATH: process.env.PATH!, TZ: 'UTC', TICKERS: 'CGUS', REQUEST_SLEEP: '0', MAX_RETRIES: '1', VERBOSE: '1', ...extra };
        const child = Bun.spawn([process.execPath, '--preload', './preload.ts', 'scripts/update-data.ts'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { out, err, code };
      };
      const first = await run(); if (first.code) throw new Error(first.out + first.err);
      expect(first.out).not.toContain('daggerok@gmail.com'); // SEC_UA is redacted in logs
      const indexPath = join(dir, 'api/capital-group/index.json'), metaPath = join(dir, 'api/capital-group/funds/CGUS/meta.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      expect(index.funds.map((f: { ticker: string }) => f.ticker)).toEqual(['CGCP', 'CGUS', 'KEEP']);
      expect(index.funds[0]).toMatchObject({ ticker: 'CGCP', dataFile: null, holdings: 0 }); // listed by the catalog, not requested
      expect(index.funds[2]).toEqual(unrelated);
      const before = await readFile(metaPath, 'utf8'), indexBefore = await readFile(indexPath, 'utf8');
      expect(JSON.parse(before).holdings.totalRows).toBe(3);
      const unchanged = async () => { expect(await readFile(metaPath, 'utf8')).toBe(before); expect(await readFile(indexPath, 'utf8')).toBe(indexBefore); };
      expect((await run()).code).toBe(0); await unchanged();
      expect((await run({ AUM: '999T:' })).code).toBe(0); await unchanged();
      expect((await run({ SKIP_ISSUER: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0' })).code).toBe(1); await unchanged(); // every source down: fund kept
      for (const bad of [{ MAX_RETRIES: '0' }, { CONCURRENCY: 'many' }, { HISTORY_RANGE: 'forever' }, { MOCK_FAIL: '1', SKIP_YAHOO: 'maybe' }]) {
        const rejected = await run(bad); expect(rejected.code).toBe(1); expect(rejected.err).toMatch(/MAX_RETRIES|CONCURRENCY|HISTORY_RANGE|SKIP_YAHOO/);
      }
      await unchanged();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);
});

// ---------------------------------------------------------------------------
// network: pacing, timeout, bounded retries, real parallelism, request URLs (all mocked, no sockets)
// ---------------------------------------------------------------------------

describe('network', () => {
  test('request queue keeps order and rejections; lane gates space callers on virtual time and never poison their queue', async () => {
    const enqueueRequest = createRequestQueue(); const order: number[] = [];
    const one = enqueueRequest(async () => { order.push(1); return 42; });
    const bad = enqueueRequest(async () => { order.push(2); throw new Error('expected'); });
    const three = enqueueRequest(async () => { order.push(3); return 'ok'; });
    expect(await one).toBe(42); await expect(bad).rejects.toThrow('expected'); expect(await three).toBe('ok'); expect(order).toEqual([1, 2, 3]);
    // simultaneous callers are spaced by the gate and never catch up after a late timer
    let now = 0; const waits: number[] = [], starts: number[] = [];
    const gate = createRequestGate(100, { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms + (waits.length === 1 ? 250 : 0); } });
    await Promise.all(Array.from({ length: 4 }, async () => { await gate(); starts.push(now); }));
    expect(starts).toEqual([0, 350, 450, 550]); expect(waits).toEqual([100, 100, 100]);
    // early timers are rechecked, zero sleep is immediate, independent gates share no tail
    now = 0; let sleeps = 0;
    const early = createRequestGate(100, { now: () => now, sleep: async (ms) => { now += ++sleeps === 1 ? ms - 10 : ms; } });
    await early(); await early(); expect(now).toBe(100); expect(sleeps).toBe(2);
    const zero = createRequestGate(0, { now: () => now, sleep: async () => { throw new Error('unexpected sleep'); } });
    await zero(); await zero();
    let release!: () => void;
    const blocked = createRequestGate(100, { now: () => now, sleep: async (ms) => { await new Promise<void>((r) => { release = r; }); now += ms; } });
    await blocked(); const pending = blocked();
    await Promise.resolve(); await zero(); // another lane does not join the blocked lane's queue
    release(); await pending;
    // a failed timer does not poison its own lane
    now = 0; let fail = true;
    const flaky = createRequestGate(100, { now: () => now, sleep: async (ms) => { if (fail) { fail = false; throw new Error('timer failure'); } now += ms; } });
    await flaky(); await expect(flaky()).rejects.toThrow('timer failure'); await flaky(); expect(now).toBe(100);
  });

  test('the timeout covers headers and the body; retries are bounded and non-retryable errors are not retried', async () => {
    const realTimeout = AbortSignal.timeout; const asked: number[] = [];
    AbortSignal.timeout = ((ms: number) => { asked.push(ms); return realTimeout.call(AbortSignal, 30); }) as typeof AbortSignal.timeout;
    try {
      globalThis.fetch = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
      await expect(fetchWithRetry('https://example.invalid/headers', 'stuck headers', {}, 0)).rejects.toThrow('network error');
      expect(asked).toEqual([45_000]);
      globalThis.fetch = (async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason)); } }))) as unknown as typeof fetch;
      const response = await fetchWithRetry('https://example.invalid/body', 'stuck body', {}, 0);
      expect(asked).toEqual([45_000, 45_000]);
      await expect(response.text()).rejects.toBeDefined();
    } finally { AbortSignal.timeout = realTimeout; }
    let attempts = 0;
    globalThis.fetch = (async () => { attempts++; return new Response('x', { status: 503 }); }) as unknown as typeof fetch;
    await expect(fetchWithRetry('https://example.invalid/a', 'retry sample', {}, 1)).rejects.toThrow('HTTP 503');
    expect(attempts).toBe(2);
    attempts = 0;
    globalThis.fetch = (async () => { attempts++; return new Response('x', { status: 404 }); }) as unknown as typeof fetch;
    await expect(fetchWithRetry('https://example.invalid/b', 'terminal sample', {}, 2)).rejects.toThrow('HTTP 404');
    expect(attempts).toBe(1);
  });

  test('in-flight requests peak at 1 with one worker lane and at N with N lanes; a failing lane never stalls the others', async () => {
    for (const lanes of [1, 3, 15]) {
      let active = 0, peak = 0, served = 0;
      globalThis.fetch = (async () => { peak = Math.max(peak, ++active); await Bun.sleep(40); active--; served++; return new Response('ok'); }) as unknown as typeof fetch;
      const funds = Array.from({ length: 15 }, (_, i) => i);
      await Promise.all(Array.from({ length: lanes }, () => withRequestLane(10, async () => {
        while (funds.length) {
          funds.shift();
          for (let request = 0; request < 2; request++) expect(await (await fetchWithRetry('https://example.invalid/x', 'pacing sample', {}, 0)).text()).toBe('ok');
        }
      })));
      expect(served).toBe(30); expect(peak).toBe(lanes);
    }
    const events: string[] = [];
    globalThis.fetch = (async (input: string) => {
      const lane = new URL(String(input)).pathname.slice(1);
      events.push(lane);
      return new Response('sample', { status: lane === 'retry' && events.filter((e) => e === 'retry').length === 1 ? 429 : lane === 'terminal' ? 404 : 200 });
    }) as unknown as typeof fetch;
    await Promise.all([
      withRequestLane(10, async () => { expect((await fetchWithRetry('https://example.invalid/retry', 'retry sample', {}, 1)).status).toBe(200); }),
      withRequestLane(10, async () => {
        await expect(fetchWithRetry('https://example.invalid/terminal', 'terminal sample', {}, 2)).rejects.toThrow('HTTP 404');
        await fetchWithRetry('https://example.invalid/healthy', 'healthy sample', {}, 0);
      }),
    ]);
    expect(events.filter((e) => e === 'terminal')).toHaveLength(1); expect(events.filter((e) => e === 'retry')).toHaveLength(2);
    expect(events.indexOf('healthy')).toBeLessThan(events.lastIndexOf('retry')); // the retry backoff stays in its own lane
  });

  test('HISTORY_RANGE reaches the Yahoo request as explicit period1/period2, never as range=', async () => {
    const yahoo = async (range: string): Promise<URL> => {
      let url: URL | undefined;
      await withFeed({ dead: { CGUS: ['history'] } }, async ({ run }) => { // Yahoo is the history source when the issuer API is down
        await run({ TICKERS: 'CGUS', HISTORY_RANGE: range });
        url = mockUrls.map((u) => new URL(u)).find((u) => u.href.includes('finance/chart'));
      });
      return url!;
    };
    const five = await yahoo('5y'); const max = await yahoo('max');
    for (const url of [five, max]) { expect(url.searchParams.has('range')).toBe(false); expect(url.searchParams.has('period1')).toBe(true); expect(url.searchParams.get('interval')).toBe('1d'); }
    const period2 = Number(five.searchParams.get('period2')), period1 = Number(five.searchParams.get('period1'));
    expect(period2).toBeGreaterThan(Date.UTC(2026, 0, 1) / 1000);
    expect(period2 - period1).toBeGreaterThan(5 * 365 * 86_400 - 60); expect(period2 - period1).toBeLessThan(5 * 366 * 86_400);
    expect(max.searchParams.get('period1')).toBe('0'); expect(Number(max.searchParams.get('period2'))).toBeGreaterThan(period1);
  });

  test('concurrent workers share one SEC fund-ticker request', async () => {
    const restore = installIssuerMock({ secDelayMs: 30 });
    try {
      resetSecTableCaches();
      const config = readConfig({ REQUEST_SLEEP: '0' });
      const maps = await Promise.all([loadFundTickerMap(config), loadFundTickerMap(config), loadFundTickerMap(config)]);
      expect(mockCounts.get('company_tickers_mf')).toBe(1); expect(maps[0]).toBe(maps[2]);
    } finally { restore(); resetSecTableCaches(); }
  });
});
