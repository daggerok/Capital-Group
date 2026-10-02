#!/usr/bin/env bun
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}

import { mkdir, readFile, writeFile, readdir, rm, appendFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

type JsonRecord = Record<string, any>;
const ISSUER_SITE = 'https://www.capitalgroup.com';
const ISSUER_CATALOG = `${ISSUER_SITE}/advisor/investments/exchange-traded-funds.html`;
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const SEC_DATA_HOST = 'https://data.sec.gov';
const SEC_EFTS_HOST = 'https://efts.sec.gov/LATEST';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
// Official SEC lookup tables (public, no key): ETF/mutual-fund ticker ->
// registrant CIK + series/class ids, and operating company name -> ticker.
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

const API_ROOT = new URL('../api/capital-group/', import.meta.url);
const INDEX_FILE = new URL('index.json', API_ROOT);
const STATE_FILE = new URL('update-state.json', API_ROOT);

const HOLDINGS_PAGE_SIZE_FALLBACK = 250;
const HISTORY_PAGE_SIZE_FALLBACK = 1000;
const CONCURRENCY_FALLBACK = 1;
const REQUEST_SLEEP_FALLBACK = 3;
const MAX_RETRIES_FALLBACK = 2;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u00ae/g, '') // ®
    .replace(/\u2122/g, '') // ™
    .replace(/&#174;|&reg;/gi, '')
    .replace(/&#8482;|&trade;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// "2.97057744E8" -> "297057744"; keeps non-numeric text untouched (same as SPDR).
export function normalizeNumberText(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return text;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number) || Math.abs(number) >= 1e21) return text;
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === '—' || text === '-' || text === '--' || /^n\/?a$/i.test(text)) return null;
  // Percent first, then plain numbers: "0.40%" -> 0.4, "$1,234.56" -> 1234.56.
  const parsed = Number(text.replace(/[$,\s]/g, '').replace(/%$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// capitalgroup.com publishes yields and returns as fractions (0.0536 = 5.36%);
// expense ratios and premium/discount figures arrive in percent already.
export function fractionToPercent(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? null : round(number * 100, 4);
}

// "2026-06-30" -> "Jun 30 2026" (the display style shared with the sibling apps).
export function formatEdgarDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${day} ${year}`;
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatEpochDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()}`;
}

export function formatUsDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// "08/21/2026" / "2026-08-21T00:00:00Z" -> "2026-08-21"; anything else passes
// through untouched so an unexpected source format never silently corrupts a
// date column.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return text;
}

// "2026-08-21" -> "08/21/2026" (how capitalgroup.com renders dates in its
// workbooks and CSV reports).
export function formatIssuerDate(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toIsoDate(raw));
  if (!match) return String(raw ?? '');
  return `${match[2]}/${match[3]}/${match[1]}`;
}

// ISO date -> epoch seconds (UTC midnight), NaN-safe.
export function isoToEpoch(iso: string): number | null {
  const value = Date.parse(`${toIsoDate(iso)}T00:00:00Z`);
  return Number.isFinite(value) ? Math.floor(value / 1000) : null;
}

export function formatAumDisplay(value: number): string {
  return `$${(value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
}

// ---------------------------------------------------------------------------
// Updater configuration (environment variables, iShares/SPDR/Fidelity-style)
// ---------------------------------------------------------------------------

type Range = { min?: number; max?: number };
type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  catalogUrl: string;
  secUa: string;
  skipYahoo: boolean;
  skipIssuer: boolean;
  edgarFallback: boolean;
  useSystemCa: string;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [`CAPITAL_GROUP_${name}`, name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

function parseIntegerControl(raw: string, label: string, min: number, fallback: number): number {
  const text = String(raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min) throw new Error(`${label}: expected integer >= ${min}, got "${text}"`);
  return value;
}

function parseSeconds(raw: string, label: string, fallback: number): number {
  const text = String(raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}: expected nonnegative seconds, got "${text}"`);
  return value;
}

function parseBoolean(raw: string, label: string, fallback = false): boolean {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  throw new Error(`${label}: expected boolean, got "${text}"`);
}

function parseSystemCaMode(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return 'auto';
  if (['auto', 'true', 'false'].includes(text)) return text;
  throw new Error(`USE_SYSTEM_CA: expected auto, true or false, got "${text}"`);
}

function parseHistoryRange(raw: string): string {
  const text = String(raw ?? '').trim();
  if (text === '') return 'max';
  if (!/^(max|[1-9]\d*y)$/i.test(text)) throw new Error(`HISTORY_RANGE: use max or Ny (e.g. 5y), got "${text}"`);
  return text.toLowerCase();
}

// Strict "min:max" ranges (same parser and errors as the sibling repos).
export function parseRange(raw: string, label: string): Range | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  if (!text.includes(':')) {
    throw new Error(`${label}: "${text}" must use the "min:max" range syntax (a colon is required)`);
  }
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`${label}: "${text}" must contain exactly one colon`);
  const [rawMin, rawMax] = parts;
  const parseBound = (bound: string): number | undefined => {
    const cleaned = bound.trim().replace(/%$/, '').replace(/[$,]/g, '');
    if (cleaned === '') return undefined;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) throw new Error(`${label}: "${bound.trim()}" is not a number`);
    return value;
  };
  const min = parseBound(rawMin);
  const max = parseBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${label}: min (${min}) must not exceed max (${max})`);
  }
  return { min, max };
}

function parseAumBound(bound: string): number | undefined {
  const cleaned = bound.trim().replace(/[$,]/g, '');
  if (cleaned === '') return undefined;
  const suffixMatch = /^([\d.]+)([KMBT])$/i.exec(cleaned);
  if (suffixMatch) return Number(suffixMatch[1]) * (AMOUNT_SUFFIXES[suffixMatch[2].toUpperCase()] ?? 1);
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

export function parseAumRange(raw: string): (Range & { source?: string }) | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  const lower = text.toLowerCase();
  for (const preset of Object.keys(AUM_PRESET_BOUNDS) as AumPreset[]) {
    if (lower === preset) return { ...AUM_PRESET_BOUNDS[preset] } as Range & { source?: string };
  }
  if (!text.includes(':')) {
    throw new Error(`AUM: "${text}" must use the "min:max" range syntax (a colon is required)`);
  }
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`AUM: "${text}" must contain exactly one colon`);
  const [rawMin, rawMax] = parts;
  const min = parseAumBound(rawMin);
  const max = parseAumBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`AUM: min (${min}) must not exceed max (${max})`);
  }
  return { min, max };
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const parsed = parseRange(envValue(env, `${prefix}_${period}`), `${prefix}_${period}`);
    if (parsed) ranges[period] = parsed;
  }
  return ranges;
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parseIntegerControl(envValue(env, 'CONCURRENCY'), 'CONCURRENCY', 1, CONCURRENCY_FALLBACK),
    requestSleep: parseSeconds(envValue(env, 'REQUEST_SLEEP'), 'REQUEST_SLEEP', REQUEST_SLEEP_FALLBACK),
    maxFetches: parseIntegerControl(envValue(env, 'MAX_FETCHES', ['CAPITAL_GROUP_LIMIT']), 'MAX_FETCHES', 0, 0),
    holdingsPageSize: parseIntegerControl(envValue(env, 'HOLDINGS_PAGE_SIZE'), 'HOLDINGS_PAGE_SIZE', 1, HOLDINGS_PAGE_SIZE_FALLBACK),
    historyPageSize: parseIntegerControl(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), 'HISTORY_PAGE_SIZE', 1, HISTORY_PAGE_SIZE_FALLBACK),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS', ['CAPITAL_GROUP_STORE_RAW_DOWNLOADS']), 'STORE_RAW_DOWNLOADS'),
    maxRetries: parseIntegerControl(envValue(env, 'MAX_RETRIES'), 'MAX_RETRIES', 1, MAX_RETRIES_FALLBACK),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .map(sanitizeTicker)
      .filter(Boolean),
    historyRange: parseHistoryRange(envValue(env, 'HISTORY_RANGE')),
    catalogUrl: envValue(env, 'CATALOG_URL') || ISSUER_CATALOG,
    secUa: envValue(env, 'SEC_UA') || SEC_UA_DEFAULT,
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO'), 'SKIP_YAHOO'),
    skipIssuer: parseBoolean(envValue(env, 'SKIP_ISSUER'), 'SKIP_ISSUER'),
    edgarFallback: parseBoolean(envValue(env, 'EDGAR_FALLBACK'), 'EDGAR_FALLBACK', true),
    useSystemCa: parseSystemCaMode(envValue(env, 'USE_SYSTEM_CA')),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
}

const USAGE = `Capital Group ETF static data updater (Bun, no dependencies).
Usage: bun scripts/update-data.ts [-h|--help]
Defaults: CONCURRENCY=1 REQUEST_SLEEP=3 MAX_RETRIES=2 MAX_FETCHES=0 (all)
MAX_RETRIES is an integer >= 1 (retries after the first request).
TICKERS="CGUS CGCP CGMU" selects exact funds before network work or MAX_FETCHES.
HOLDINGS_PAGE_SIZE=250 HISTORY_PAGE_SIZE=1000 HISTORY_RANGE=max (Yahoo fallback history window: max or Ny)
STORE_RAW_DOWNLOADS=0 SKIP_ISSUER=0 SKIP_YAHOO=0 EDGAR_FALLBACK=1 VERBOSE=0
USE_SYSTEM_CA=auto (auto: restart once with Bun --use-system-ca on an untrusted-certificate error; true: always; false: never)
CATALOG_URL=${ISSUER_CATALOG}
SEC_UA=<contact string for SEC requests; default in scripts/update-data.config.json>
AUM=min:max or nano/micro/small/mid/large (bounds accept K/M/B/T)
TER=min:max DIVIDEND_YIELD=min:max SEC_YIELD=min:max
PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}=min:max (annualized for 3Y+)
TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}=min:max (cumulative)
All canonical controls accept a CAPITAL_GROUP_ prefix at runtime (including VERBOSE).
Precedence: scripts/update-data.config.json < advanced JSON < nonblank inputs < environment.
An explicitly set environment variable wins even when empty; invalid values are errors.
Examples:
  TICKERS="CGUS CGCP CGMU" VERBOSE=1 bun scripts/update-data.ts
  MAX_FETCHES=3 AUM="1B:" TER=":0.5" bun scripts/update-data.ts
CONCURRENCY independent workers; REQUEST_SLEEP spaces starts within each worker.
Full runs clear update-state.json. No provider data is deleted on fetch failure.
`;

// Only a lane's timer reservations are queued, never network operations. Each
// worker keeps its lane across funds, retries, redirects and fallback providers.
export function createRequestQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function enqueueRequest<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
type RequestClock = { now: () => number; sleep: (ms: number) => Promise<void> };
export function createRequestGate(
  delayMs: number,
  clock: RequestClock = { now: () => performance.now(), sleep },
): () => Promise<void> {
  const enqueue = createRequestQueue();
  let nextStart = 0;
  return () => enqueue(async () => {
    // Recheck early timer wakeups; after a late wakeup do not "catch up" in a
    // burst. Reserve this SAME lane from the actual wakeup, not the old deadline.
    let wait: number;
    while ((wait = nextStart - clock.now()) > 0) await clock.sleep(wait);
    nextStart = clock.now() + Math.max(0, delayMs);
  });
}
const requestLane = new AsyncLocalStorage<() => Promise<void>>();
let discoveryGate = createRequestGate(REQUEST_SLEEP_FALLBACK * 1000);
export function withRequestLane<T>(delayMs: number, work: () => Promise<T>): Promise<T> {
  return requestLane.run(createRequestGate(delayMs), work);
}
async function paceRequests(): Promise<void> {
  await (requestLane.getStore() ?? discoveryGate)();
}
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** `fetchWithRetry` already prefixes its messages with the fetch label, so a
    caller that prints its own tag must not repeat the label. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\[[^\]]*\] ?/, '');
}

export async function fetchWithRetry(
  url: string,
  label: string,
  init: RequestInit = {},
  maxRetries = 2,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceRequests();
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45000), ...init });
      if (response.ok) return response;
      const retryable = [403, 408, 425, 429].includes(response.status) || response.status >= 500;
      if (!retryable) throw new HttpError(`${label}: HTTP ${response.status} ${response.statusText}`, response.status, false);
      lastError = new HttpError(`${label}: HTTP ${response.status} (attempt ${attempt + 1} of ${maxRetries + 1})`, response.status, true);
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;
      lastError = error instanceof HttpError ? error : new Error(`${label}: network error (${String(error)})`);
    }
    if (attempt < maxRetries) await sleep(Math.min(30_000, 1_000 * 2 ** attempt) + 250);
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: failed`);
}

function yahooHeaders(): Record<string, string> {
  return { 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json' };
}

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,*/*' };
}

function issuerHeaders(): Record<string, string> {
  return { 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json,text/html,*/*' };
}
// In-memory bootstrap cookies only; never log or persist them. Scope them to
// issuer origin and never forward to SEC, Yahoo or a rendering proxy.
const issuerCookies = new Map<string, string>();
async function issuerResponse(url: string, config: UpdaterConfig): Promise<Response> {
  const original = new URL(url);
  if (original.origin !== ISSUER_SITE) return fetchWithRetry(url, '[ issuer   ] catalog mirror', { headers: issuerHeaders() }, config.maxRetries);
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const headers = issuerHeaders();
    if (issuerCookies.size) headers.Cookie = [...issuerCookies].map(([k,v]) => `${k}=${v}`).join('; ');
    // Redirects handled here so Set-Cookie from the bootstrap is not lost.
    await paceRequests();
    const response = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(45000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], split = pair.indexOf('=');
      if (split > 0) issuerCookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get('location') || '', current);
      if (next.origin !== ISSUER_SITE) throw new Error('Unexpected cross-origin issuer redirect');
      await response.body?.cancel(); current = next.href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(`issuer HTTP ${response.status}`, response.status, [403,408,429].includes(response.status) || response.status >= 500); }
    if (current.includes('/public/authentication-0.htm')) { await response.body?.cancel(); current = url; continue; }
    return response;
  }
  throw new Error('Issuer bootstrap did not resolve after six requests');
}
async function issuerFetch(url: string, config: UpdaterConfig): Promise<Response> {
  let failure: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try { return await issuerResponse(url, config); }
    catch (e) { failure = e; if (e instanceof HttpError && !e.retryable) break; if (attempt < config.maxRetries) await sleep(1000 * 2 ** attempt); }
  }
  throw failure;
}
async function fetchText(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<string> {
  const response = await fetchWithRetry(url, label, { headers }, config.maxRetries);
  return await response.text();
}

async function fetchJson(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<JsonRecord> {
  const text = await fetchText(url, label, headers, config);
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error(`${label}: response is not valid JSON`);
  }
}

export type CatalogReturns = {
  ytd: number | null;
  yr1: number | null;
  yr3: number | null;
  yr5: number | null;
  yr10: number | null;
  sinceInception: number | null;
};

// Cumulative multi-year figures as published (the exact inverse of the
// annualized ones is only an approximation once rounding gets involved).
export type CumulativeReturns = { yr1: number | null; yr3: number | null; yr5: number | null; yr10: number | null; sinceInception: number | null };

export type OfficialReturns = CatalogReturns & {
  asOfDate: string | null;
  mo1: number | null;
  mo3: number | null;
};

export type CatalogFund = {
  ticker: string;
  name: string;
  category: string;
  categoryPath: string;
  inception: string | null;
  exchange: string;
  cusip: string;
  isin: string;
  benchmark: string;
  ter: number | null;
  nav: number | null;
  close: number | null;
  premiumDiscount: number | null;
  netAssets: number | null;
  dividendYield: number | null;
  secYield: number | null;
  distributionRate: number | null;
  asOfDate: string | null;
  returns: CatalogReturns;
  returnsAsOfDate: string | null;
  mo1: number | null;
  marketReturns: CatalogReturns;
  quarterEnd: CatalogReturns;
  quarterEndAsOfDate: string | null;
  fundPage: string;
  trustCik: string | null;
  source: 'capital-group' | 'previous index' | 'seed';
};

const EMPTY_RETURNS: CatalogReturns = { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
const EMPTY_CUMULATIVE: CumulativeReturns = { yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };

export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
export const BOND_SHEET_HEADERS = [...HOLDINGS_HEADERS, 'Coupon', 'Maturity'];

export type ParsedHoldings = {
  asOfDate: string | null;
  container?: string;
  headers: string[];
  rows: JsonRecord[];
};

// Shared cadence codes. The issuer adapter maps its human-readable schedule
// into these codes; they are not literal Capital Group API values.
export const DIVIDEND_FREQUENCY_CODES: Record<string, { frequency: string; paymentsPerYear: number | null }> = {
  M: { frequency: 'Monthly', paymentsPerYear: 12 },
  Q: { frequency: 'Quarterly', paymentsPerYear: 4 },
  S: { frequency: 'Semi-annually', paymentsPerYear: 2 },
  H: { frequency: 'Semi-annually', paymentsPerYear: 2 },
  Y: { frequency: 'Annually', paymentsPerYear: 1 },
  A: { frequency: 'Annually', paymentsPerYear: 1 },
  W: { frequency: 'Weekly', paymentsPerYear: 52 },
  D: { frequency: 'Daily', paymentsPerYear: null },
};

export function decodeDividendFrequency(code: unknown): { frequency: string; paymentsPerYear: number | null } | null {
  const text = String(code ?? '').trim().toUpperCase();
  if (!text) return null;
  return DIVIDEND_FREQUENCY_CODES[text[0]] ?? null;
}

// Security types whose "securityTicker" is an exchange symbol. Bonds, money
// market paper, repos, currencies and derivatives carry issuer codes instead
// ("T", "COF", "SPX"), which would collide across funds in the Watchlist.
const EQUITY_LIKE_SECURITY_TYPE = /(COMMON|PREFERRED|STOCK|REIT|ADR|GDR|EQUITY|SHARE|UNIT|FUND|ETF|TRUST|MONEY MARKET|WARRANT|RIGHT|MLP|PARTNERSHIP)/i;
const NON_EQUITY_SECURITY_TYPE = /(FUTURE|OPTION|SWAP|FORWARD|NOTE|BOND|BILL|PAPER|REPURCHASE|REPO|CURRENC|SPOT|LINKED|DEBT|LOAN|MORTGAGE|ASSET BACKED|CERTIFICATE OF DEPOSIT|TIME DEPOSIT|CASH|TREASUR|MUNICIPAL|SOVEREIGN|AGENCY|\bCMO\b|\bABS\b|\bMBS\b|\bTBA\b|\bCDO\b|\bCLO\b|WHEN ISSUED)/i;

export function holdingTickerFor(securityType: unknown, rawTicker: unknown): string {
  const ticker = cleanHoldingTicker(rawTicker);
  if (!ticker) return '';
  const type = cleanText(securityType);
  if (!type) return ticker;
  if (NON_EQUITY_SECURITY_TYPE.test(type)) return '';
  return EQUITY_LIKE_SECURITY_TYPE.test(type) ? ticker : '';
}

export type ProductData = {
  ticker: string;
  name: string;
  cusip: string;
  isin: string;
  exchange: string;
  assetClass: string;
  benchmark: string;
  inception: string | null;
  listingDate: string | null;
  grossExpense: number | null;
  netExpense: number | null;
  nav: number | null;
  navDate: string | null;
  marketPrice: number | null;
  marketPriceDate: string | null;
  premiumDiscount: number | null;
  netAssets: number | null;
  netAssetsDate: string | null;
  sharesOutstanding: number | null;
  numberOfHoldings: number | null;
  dividendYield: number | null;
  dividendYieldDate: string | null;
  dividendYieldKind: string;
  secYield: number | null;
  secYieldDate: string | null;
  secYieldKind: string;
  unsubsidizedSecYield: number | null;
  frequencyCode: string;
  latestDividend: { exDate: string; amount: number; payDate: string; recordDate: string } | null;
  monthEnd: OfficialReturns;
  monthEndMarket: OfficialReturns;
  cumulative: CumulativeReturns;
  cumulativeAsOfDate: string | null;
  holdings: ParsedHoldings | null;
};

export const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount'];
export const YAHOO_HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'];

export type HistoryPoint = { date: string; nav: number | null; marketPrice: number | null; premiumDiscount: number | null };

export type OfficialDividend = { epoch: number; amount: number; exDate: string; payDate: string; recordDate: string; reinvestNav: number | null; type: string };

export type ParsedHistoricalData = {
  points: HistoryPoint[]; // ascending by date
  dividends: OfficialDividend[]; // ascending by ex-date
  quarterEnd: OfficialReturns;
  quarterEndMarket: OfficialReturns;
  monthlyReturns: Array<{ date: string; value: number }>;
};

export function navTotalReturnDays(points: HistoryPoint[], dividends: OfficialDividend[]): ChartDay[] {
  const navPoints = points.filter((point) => point.nav !== null && point.nav > 0);
  if (!navPoints.length) return [];
  const sortedDividends = [...dividends].sort((a, b) => a.epoch - b.epoch);
  let factor = 1;
  let next = 0;
  const days: ChartDay[] = [];
  for (let i = 0; i < navPoints.length; i++) {
    const point = navPoints[i];
    while (next < sortedDividends.length && sortedDividends[next].exDate <= point.date) {
      const dividend = sortedDividends[next];
      const reinvestNav = dividend.reinvestNav && dividend.reinvestNav > 0 ? dividend.reinvestNav : point.nav;
      if (reinvestNav && reinvestNav > 0 && dividend.exDate >= navPoints[0].date) factor *= 1 + dividend.amount / reinvestNav;
      next += 1;
    }
    days.push({
      date: point.date,
      close: round(point.nav as number, 6),
      adjClose: round((point.nav as number) * factor, 6),
      volume: 0,
    });
  }
  return days;
}

const HOLDING_NAME_SUFFIXES = new Set([
  'STOCK', 'COMMON', 'PREFERRED', 'PFD', 'SHARES', 'ORDINARY', 'DEPOSITARY', 'ADS', 'ADR',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC',
  'PUBLIC', 'SA', 'SAS', 'SARL', 'SRL', 'SL', 'KG', 'AG', 'BA', 'BV', 'NV', 'OY', 'SE',
  'AS', 'AB', 'AD', 'KK', 'KABUSHIKI', 'KAISHA', 'PTY', 'PT', 'SFC', 'ANONIMA', 'GMBH',
  'HOLDINGS', 'HLDGS', 'DEL', 'NEW', 'DELISTED', 'REPR', 'GROUP', 'TR', 'TRUST', 'NOTE',
  'NL', 'SPA', 'LP', 'LC', 'LLC', 'CAP', 'STK', 'SHS',
  'NOTES', 'BOND', 'BONDS', 'SER', 'SERIES',
]);
const HOLDING_NAME_PHRASES = new Set([
  'COMMON STOCK', 'PREFERRED STOCK', 'DEPOSITARY SHARES', 'AMERICAN DEPOSITARY SHARES',
  'ORDINARY SHARES', 'LIABILITY CO', 'S A', 'N V', 'B V', 'PRIVATE LTD', 'PUBLIC LTD',
]);
// Words that carry no identity at all: dropped wherever they sit at the edge
// of a filed name, so "The Coca-Cola Co" and "Coca CO" meet.
const HOLDING_NAME_FILLERS = new Set([
  'THE', 'OF', 'AND', 'FOR', 'DE', 'LA', 'LE', 'VAN', 'VON', 'DER', 'DEN', 'DI', 'Y',
  'E', 'DU', 'DA', 'LOS', 'LAS', 'EL', 'AL', 'DEL', 'NPV', 'PAR', 'VAL', 'USD', 'EUR',
  'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'HKD', 'CNY', 'SEK', 'NOK', 'NZD', 'MXN', 'INR',
]);

// Trailing share-class / security-type designations. The class letter is kept
// and canonicalized ("... Class C Capital Stock" -> "... Cl C") rather than
// dropped, so GOOG vs GOOGL — like BF/A vs BF/B — never collide.
const SHARE_CLASS_RE = /(?:\s+(?:CLASS|CL))\s+([A-Z])\b\s*$/;
// Words that only describe the security, never the issuer; safe to peel off the
// end of a filed name (and, once a share class is known, from behind it).
const SECURITY_TYPE_WORDS = new Set([
  'STOCK', 'STK', 'SHARES', 'SHS', 'SH', 'SHARE', 'CAPITAL', 'CAP', 'COMMON', 'ORDINARY',
  'GENERAL', 'VOTING', 'NON', 'NONVOTING', 'NVOTING', 'CONVERTIBLE', 'DEPOSITARY', 'PAID',
  'SUBORDINATED', 'NOTES', 'NOTE', 'SER', 'SERIES', 'LIABILITY', 'NEW', 'REP', 'REPR',
]);

export function normalizeHoldingName(raw: unknown): string {
  const text = String(raw ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let tokens = text.split(' ').filter(Boolean);
  let classLetter = '';
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const withClass = tokens.join(' ').match(SHARE_CLASS_RE);
    if (withClass) {
      classLetter = withClass[1];
      tokens = tokens.slice(0, tokens.length - 2); // drop "Class C" (or "Cl C")
      changed = true;
    }
    const last = tokens[tokens.length - 1];
    if (SECURITY_TYPE_WORDS.has(last) && tokens.length > 1) {
      tokens.pop(); // "... Capital Stock" -> "... Capital"
      changed = true;
      continue;
    }
    if (tokens.length >= 2 && HOLDING_NAME_PHRASES.has(`${tokens[tokens.length - 2]} ${last}`)) {
      tokens = tokens.slice(0, -2);
      changed = true;
      continue;
    }
    if (HOLDING_NAME_SUFFIXES.has(last)) {
      tokens.pop();
      changed = true;
      continue;
    }
    while (tokens.length > 2 && HOLDING_NAME_FILLERS.has(tokens[tokens.length - 1])) {
      tokens.pop(); // keep peeling: a filler may hide the next legal-form suffix
      changed = true;
    }
  }
  while (tokens.length > 1 && HOLDING_NAME_FILLERS.has(tokens[0])) tokens.shift();
  const body = tokens.join(' ').trim();
  return classLetter ? `${body} CL ${classLetter}`.replace(/\s+/g, ' ').trim() : body;
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

export function yahooSearchUrl(name: string): string {
  return `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(name)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`;
}

// Strict matcher for Yahoo search payloads: the quote's long name must
// normalize to the same name (or token-core) as the filed holding name. Only
// EQUITY/ETF quotes are accepted, and single/two-word holdings may additionally
// match by token containment (e.g. "BULLISH" -> "Bullish BLCM Inc").
export function pickSearchTicker(name: string, payload: JsonRecord): string | null {
  const matches: unknown[] = Array.isArray(payload?.quoteMatches) ? payload.quoteMatches : [];
  const norm = normalizeHoldingName(name);
  if (!norm) return null;
  const core = norm.replace(/ /g, '');
  const tokens = norm.split(' ');
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const record = match as JsonRecord;
    const quoteType = String(record.quoteType || '').toUpperCase();
    if (quoteType !== 'EQUITY' && quoteType !== 'ETF') continue;
    const symbol = cleanHoldingTicker(record.symbol);
    if (!symbol) continue;
    const longName = String(record.longname || record.shortname || '');
    const candidate = normalizeHoldingName(longName);
    if (!candidate) continue;
    if (candidate === norm || candidate.replace(/ /g, '') === core) return symbol;
    if (tokens.length <= 2 && tokens.every((token) => candidate.includes(token))) return symbol;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SEC EDGAR fallback layer: N-PORT-P positions for funds capitalgroup.com does
// not publish holdings for, resolved through the EDGAR full-text search API.
// ---------------------------------------------------------------------------

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

export function nportUrlFor(cik: string, accession: string): string {
  return `${EDGAR_ARCHIVES}/${Number(String(cik).replace(/^0+/, '') || 0)}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(submissions: JsonRecord): NportAccession[] {
  const recent = submissions?.filings?.recent;
  const result: NportAccession[] = [];
  if (!recent || !Array.isArray(recent.form)) return result;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== 'NPORT-P') continue;
    const accession: string = String(recent.accessionNumber?.[i] || '');
    if (!accession) continue;
    result.push({
      accession,
      filed: String(recent.filingDate?.[i] || ''),
      reportDate: String(recent.reportDate?.[i] || ''),
      url: nportUrlFor(String(submissions.cik || '0'), accession),
    });
  }
  return result;
}

// EDGAR publishes the authoritative "ticker -> registrant CIK + series id"
// table for every ETF and mutual fund class; it is the reliable way to reach a
// fund's own N-PORT-P filing (the full-text search is only a last resort).
export type SecSeriesRef = { cik: string; seriesId: string; classId: string };

export function parseFundTickerMap(payload: JsonRecord): Map<string, SecSeriesRef> {
  const map = new Map<string, SecSeriesRef>();
  const fields: string[] = Array.isArray(payload?.fields) ? payload.fields.map((field: unknown) => String(field)) : [];
  const rows: unknown[] = Array.isArray(payload?.data) ? payload.data : [];
  const at = (row: unknown[], field: string): string => {
    const index = fields.indexOf(field);
    return index >= 0 ? String(row[index] ?? '') : '';
  };
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const ticker = sanitizeTicker(at(raw, 'symbol'));
    if (!ticker || map.has(ticker)) continue;
    const cik = at(raw, 'cik').replace(/\D/g, '');
    if (!cik || Number(cik) === 0) continue;
    map.set(ticker, {
      cik: cik.padStart(10, '0'),
      seriesId: at(raw, 'seriesId').toUpperCase(),
      classId: at(raw, 'classId').toUpperCase(),
    });
  }
  return map;
}

// Operating-company name -> exchange ticker, so N-PORT positions (which carry
// CUSIP/ISIN but never a ticker) still land in the watchlist with a symbol.
export function parseCompanyTickerMap(payload: JsonRecord): Map<string, string> {
  const map = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.values(payload as JsonRecord) : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as JsonRecord;
    const ticker = cleanHoldingTicker(record.ticker);
    const title = String(record.title ?? '');
    if (!ticker || !title) continue;
    for (const key of [normalizeHoldingName(title), normalizeHoldingNameCore(title)]) {
      if (key && !map.has(key)) map.set(key, ticker);
    }
  }
  return map;
}

export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  const params = new URLSearchParams({
    action: 'getcompany',
    CIK: String(seriesId || '').toUpperCase(),
    type: 'NPORT-P',
    dateb: '',
    owner: 'include',
    count: String(count),
    output: 'atom',
  });
  return `${EDGAR_BROWSE_URL}?${params.toString()}`;
}

// browse-edgar's Atom feed for one series: the newest N-PORT-P accessions of
// exactly that fund, newest first.
export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1];
    const form = tagValue(body, 'filing-type') || tagValue(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = tagValue(body, 'accession-number') || tagValue(body, 'accession-nunber');
    if (!accession) continue;
    const hrefMatch = /<filing-href>([\s\S]*?)<\/filing-href>/i.exec(body);
    const cikMatch = hrefMatch ? /\/edgar\/data\/(\d+)\//.exec(cleanText(hrefMatch[1])) : null;
    result.push({
      accession,
      filed: tagValue(body, 'filing-date'),
      reportDate: tagValue(body, 'period') || '',
      url: nportUrlFor(cikMatch ? cikMatch[1] : accession.slice(0, 10), accession),
    });
  }
  return result;
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(match[1]) : '';
}

export type NportHolding = JsonRecord;

export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string;
  holdings: NportHolding[];
  totalValue: number;
  netAssets: number | null;
};

// Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only),
// in the same spirit as SPDR's hand-rolled ZIP/OOXML workbook reader.
export function parseNport(xml: string): ParsedNport {
  const genInfoMatch = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(xml);
  const genInfo = genInfoMatch ? genInfoMatch[1] : String(xml || '').slice(0, 4000);
  const fundInfoMatch = /<fundInfo>([\s\S]*?)<\/fundInfo>/i.exec(xml);
  const fundInfo = fundInfoMatch ? fundInfoMatch[1] : '';
  const holdings: NportHolding[] = [];
  const blockRe = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let block: RegExpExecArray | null;
  let totalValue = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    const body = block[1];
    const name = tagValue(body, 'name') || tagValue(body, 'title') || '-';
    const cusip = tagValue(body, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      // Real EDGAR schema: <identifiers><isin value="..."/><other value="..."/></identifiers>
      for (const tagMatch of body.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(tagMatch[2]);
        if (identifier) break;
      }
    }
    const weight = normalizeNumberText(tagValue(body, 'pctVal'));
    const valueMatch = /<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(body);
    const value = Number(valueMatch ? valueMatch[1].replace(/[,\s]/g, '') : tagValue(body, 'curVal'));
    const balance = normalizeNumberText(tagValue(body, 'balance'));
    holdings.push({
      Name: name,
      Ticker: '-',
      Identifier: identifier || '-',
      Weight: weight === '' ? '0' : weight,
      'Market Value': Number.isFinite(value) ? String(value) : '0',
      'Shares Held': balance === '' ? '-' : balance,
      'Asset Category': tagValue(body, 'assetCat') || '-',
    });
    if (Number.isFinite(value)) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    regCik: tagValue(genInfo, 'regCik'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId'),
    repPdDate: toIsoDate(tagValue(genInfo, 'repPdDate')),
    holdings,
    totalValue,
    netAssets: numberOrNull(normalizeNumberText(tagValue(fundInfo, 'netAssets'))),
  };
}

// EDGAR full-text search maps a fund ticker to the registrant that filed its
// N-PORT-P, so the fallback works for every Capital Group ETF without a hand-kept
// CIK table.
export function eftsSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: `"${query}"`,
    forms: 'NPORT-P',
    dateRange: 'custom',
    start: '0',
    end: String(25),
  });
  return `${SEC_EFTS_HOST}/search-index?${params.toString()}`;
}

export function pickEftsCik(payload: JsonRecord, fundName: string): string | null {
  // EDGAR returns { hits: { hits: [...] } }; older/simplified payloads (and the
  // unit-test fixtures) use a flat { hits: [...] } array.
  const hits: unknown[] = Array.isArray(payload?.hits)
    ? (payload.hits as unknown[])
    : Array.isArray((payload?.hits as JsonRecord)?.hits)
      ? ((payload.hits as JsonRecord).hits as unknown[])
      : [];
  const wanted = normalizeHoldingName(fundName);
  for (const raw of hits) {
    if (!raw || typeof raw !== 'object') continue;
    const hit = raw as JsonRecord;
    const source = (hit._source || {}) as JsonRecord;
    const display = source.display_names;
    // Real payload: display_names is ["NAME  (CIK 0001209466)", ...].
    const names: string[] = Array.isArray(display)
      ? display.map((entry: unknown) => String(entry))
      : Array.isArray((display as JsonRecord)?.names)
        ? ((display as JsonRecord).names as unknown[]).map((entry) => String(entry))
        : [];
    const fromDisplay = names.map((name) => /\(CIK\s*(\d{4,10})\)/i.exec(name)).find(Boolean);
    const ciks: string[] = Array.isArray(source.ciks) ? source.ciks.map((entry: unknown) => String(entry)) : [];
    const rawCik = String((display as JsonRecord)?.cik || fromDisplay?.[1] || ciks[0] || '');
    const cik = rawCik.replace(/\D/g, '').padStart(10, '0');
    if (!cik || cik === '0000000000') continue;
    if (wanted && names.length) {
      const matched = names.some((name) => {
        const normalized = normalizeHoldingName(name.replace(/\(CIK\s*\d+\)/i, ''));
        return normalized && (wanted.includes(normalized) || normalized.includes(wanted));
      });
      if (!matched) continue;
    }
    return cik;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Yahoo chart layer: daily history, distributions, quote meta
// ---------------------------------------------------------------------------

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };

export type ParsedChart = {
  exchangeName: string;
  longName: string;
  navPrice: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  firstTradeDate: number | null;
  days: ChartDay[];
  dividends: Array<{ epoch: number; amount: number }>;
};

export function parseChart(payload: JsonRecord): ParsedChart {
  const result = (payload?.chart?.result || [])[0] as JsonRecord | undefined;
  if (!result) throw new Error('chart: empty result');
  const meta = (result.meta || {}) as JsonRecord;
  const timestamps: number[] = result.timestamp || [];
  const quote = ((result.indicators || {}).quote || [])[0] as JsonRecord | undefined;
  const adj = ((result.indicators || {}).adjclose || [])[0] as JsonRecord | undefined;
  const closes: unknown[] = (quote && quote.close) || [];
  const volumes: unknown[] = (quote && quote.volume) || [];
  const adjCloses: unknown[] = (adj && adj.adjclose) || closes;
  const days: ChartDay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    const adjClose = typeof adjCloses[i] === 'number' && Number.isFinite(adjCloses[i] as number) ? (adjCloses[i] as number) : close;
    days.push({
      date: epochToIsoDate(timestamps[i]),
      close: round(close, 6),
      // Yahoo recomputes the split/dividend-adjusted close on every request;
      // at 6 decimals the last digit or two jitters between otherwise
      // identical requests, making every history row (and the fund) look
      // "updated" on every single run. 2 decimals is well past any
      // meaningful precision for a price and absorbs that jitter.
      adjClose: round(adjClose, 2),
      volume: typeof volumes[i] === 'number' ? (volumes[i] as number) : 0,
    });
  }
  const events = ((result.events || {}) as JsonRecord).dividends as Record<string, JsonRecord> | undefined;
  const dividends = Object.values(events || {})
    .map((event) => ({ epoch: Number(event.date), amount: Number(event.amount) }))
    .filter((event) => Number.isFinite(event.epoch) && Number.isFinite(event.amount) && event.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
  return {
    exchangeName: String(meta.fullExchangeName || meta.exchangeName || ''),
    longName: String(meta.longName || meta.shortName || ''),
    navPrice: numberOrNull(meta.navPrice),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days,
    dividends,
  };
}

function chartUrl(ticker: string, config: UpdaterConfig): string {
  // Explicit period1/period2: `range=max` silently downgrades to monthly bars.
  const period2 = Math.floor(Date.now() / 1000);
  let period1 = 0; // "max"
  const yearsMatch = /^(\d+)y$/i.exec(config.historyRange);
  if (yearsMatch) period1 = Math.floor(period2 - Number(yearsMatch[1]) * 365.25 * 86_400);
  return `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`;
}

// ---------------------------------------------------------------------------
// Derived catalog metrics (unit-tested helpers, sibling parity)
// ---------------------------------------------------------------------------

// (1 + CAGR)^n - 1 — the exact inverse of annualizing (same helper as SPDR).
export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + annualizedPercent / 100) ** years - 1) * 100, 2);
}

export function totalToAnnualized(totalPercent: number | null | undefined, years: number): number | null {
  if (typeof totalPercent !== 'number' || !Number.isFinite(totalPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + totalPercent / 100) ** (1 / years) - 1) * 100, 2);
}

// Indicated yield: latest distribution x payments per year / price — used only
// when the product list publishes no trailing-12-month yield for the fund.
export function indicatedYield(
  latestDistribution: number | null | undefined,
  paymentsPerYear: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (typeof latestDistribution !== 'number' || typeof paymentsPerYear !== 'number' || typeof price !== 'number') return null;
  if (!Number.isFinite(latestDistribution) || !Number.isFinite(paymentsPerYear) || !Number.isFinite(price) || price <= 0) return null;
  if (paymentsPerYear <= 0 || latestDistribution <= 0) return null;
  return round(((latestDistribution * paymentsPerYear) / price) * 100, 2);
}

export function inferDistributionFrequency(
  dividends: Array<{ epoch: number; amount: number }>,
): { frequency: string; paymentsPerYear: number | null } {
  if (!dividends.length) return { frequency: 'None', paymentsPerYear: null };
  const recent = dividends.slice(-9);
  if (recent.length < 2) return { frequency: 'Unknown', paymentsPerYear: null };
  const gapsDays: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = (recent[i].epoch - recent[i - 1].epoch) / 86_400;
    if (gap > 14 && gap < 400) gapsDays.push(gap);
  }
  if (!gapsDays.length) return { frequency: 'Unknown', paymentsPerYear: null };
  gapsDays.sort((a, b) => a - b);
  const medianGap = gapsDays[Math.floor(gapsDays.length / 2)];
  if (medianGap >= 300) return { frequency: 'Annually', paymentsPerYear: 1 };
  if (medianGap >= 150) return { frequency: 'Semi-annually', paymentsPerYear: 2 };
  if (medianGap >= 75) return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (medianGap >= 25) return { frequency: 'Monthly', paymentsPerYear: 12 };
  return { frequency: 'Irregular', paymentsPerYear: null };
}

export type PriceReturns = {
  asOfDate: string;
  ytd: number | null;
  yr1: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  cagr10y: number | null;
  siAnn: number | null;
  mo1: number | null;
  qtd: number | null;
};

const EMPTY_PRICE_RETURNS: PriceReturns = {
  asOfDate: '', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null,
};

function pctChange(start: number, end: number): number {
  return round(((end - start) / start) * 100, 2);
}

function annualized(start: number, end: number, years: number): number | null {
  if (start <= 0 || years <= 0) return null;
  return round(((end / start) ** (1 / years) - 1) * 100, 2);
}

// Total returns from an adjusted daily series anchored to the last trading day
// at or before `now`. The series is the official Capital Group NAV with published
// distributions reinvested (or Yahoo adjusted closes in the fallback path).
// Capital Group publishes official returns for every fund, so these only fill the
// gaps (young funds, quarter-to-date) and drive the History-derived blocks.
export function priceReturns(days: ChartDay[], now = new Date(), coveredFrom: string | null = null): PriceReturns {
  const empty: PriceReturns = { ...EMPTY_PRICE_RETURNS };
  if (!days.length) return empty;
  const last = days[days.length - 1];
  // A window is derivable only when its anchor day lies inside the span the
  // adjusted series covers (complete issuer distribution coverage is required).
  const anchored = (day: ChartDay | null): day is ChartDay => day !== null && day.date < last.date && (coveredFrom === null || day.date >= coveredFrom);
  const lastEpoch = Date.parse(`${last.date}T00:00:00Z`) / 1000;
  const atOrBefore = (iso: string): ChartDay | null => {
    const target = Date.parse(`${iso}T00:00:00Z`) / 1000;
    if (Number.isNaN(target)) return null;
    let found: ChartDay | null = null;
    for (const day of days) {
      if (Date.parse(`${day.date}T00:00:00Z`) / 1000 <= target) found = day;
      else break;
    }
    return found;
  };
  const yearsAgo = (years: number): ChartDay | null => {
    const date = new Date(now.getTime());
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return atOrBefore(date.toISOString().slice(0, 10));
  };
  const ytdStart = atOrBefore(`${now.getUTCFullYear()}-01-01`);
  const mo1Start = new Date(now.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const quarterStart = `${now.getUTCFullYear()}-${String(Math.floor(now.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  const year1 = yearsAgo(1);
  const year3 = yearsAgo(3);
  const year5 = yearsAgo(5);
  const year10 = yearsAgo(10);
  const first = days[0];
  const siYears = (lastEpoch - Date.parse(`${first.date}T00:00:00Z`) / 1000) / (365.25 * 86_400);
  const mo1StartDay = atOrBefore(mo1Start);
  const qtdStartDay = atOrBefore(quarterStart);
  return {
    asOfDate: last.date,
    ytd: anchored(ytdStart) && ytdStart.adjClose > 0 ? pctChange(ytdStart.adjClose, last.adjClose) : null,
    yr1: anchored(year1) ? pctChange(year1.adjClose, last.adjClose) : null,
    cagr3y: anchored(year3) ? annualized(year3.adjClose, last.adjClose, 3) : null,
    cagr5y: anchored(year5) ? annualized(year5.adjClose, last.adjClose, 5) : null,
    cagr10y: anchored(year10) ? annualized(year10.adjClose, last.adjClose, 10) : null,
    siAnn: siYears >= 0.75 && anchored(first) ? annualized(first.adjClose, last.adjClose, siYears) : null,
    mo1: anchored(mo1StartDay) ? pctChange(mo1StartDay.adjClose, last.adjClose) : null,
    qtd: anchored(qtdStartDay) ? pctChange(qtdStartDay.adjClose, last.adjClose) : null,
  };
}

export function lastCompletedQuarterEnd(now = new Date()): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  if (month <= 2) return new Date(Date.UTC(year - 1, 11, 31)); // Jan-Mar -> Dec 31
  if (month <= 5) return new Date(Date.UTC(year, 2, 31)); // Apr-Jun -> Mar 31
  if (month <= 8) return new Date(Date.UTC(year, 5, 30)); // Jul-Sep -> Jun 30
  return new Date(Date.UTC(year, 8, 30)); // Oct-Dec -> Sep 30
}

/**
 * Merges the official Capital Group returns with the ones derived from the adjusted
 * daily series. Official figures win wherever they exist (they are NAV total
 * returns — the same basis the sibling apps publish); derived figures fill
 * the gaps for young funds and for funds Capital Group lists without returns.
 */
export function deriveCatalogMetrics(
  official: CatalogReturns,
  derived: PriceReturns,
  publishedDividendYield: number | null,
  publishedSecYield: number | null,
  latestDistribution: number | null,
  paymentsPerYear: number | null,
  price: number | null,
  officialCumulative: CumulativeReturns | null = null,
): JsonRecord {
  const coalesce = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const ytd = coalesce(official.ytd) ?? coalesce(derived.ytd);
  const tr1y = coalesce(official.yr1) ?? coalesce(derived.yr1);
  const cagr3y = coalesce(official.yr3) ?? coalesce(derived.cagr3y);
  const cagr5y = coalesce(official.yr5) ?? coalesce(derived.cagr5y);
  const cagr10y = coalesce(official.yr10) ?? coalesce(derived.cagr10y);
  const siAnn = coalesce(official.sinceInception) ?? coalesce(derived.siAnn);
  const dividendYield = coalesce(publishedDividendYield) ?? indicatedYield(latestDistribution, paymentsPerYear, price);
  const text = (value: number | null): string | null => (value === null ? null : `${value.toFixed(2)}%`);
  return {
    ytd,
    tr1y,
    tr3y: coalesce(officialCumulative?.yr3) ?? annualizedToTotal(cagr3y, 3),
    tr5y: coalesce(officialCumulative?.yr5) ?? annualizedToTotal(cagr5y, 5),
    tr10y: coalesce(officialCumulative?.yr10) ?? annualizedToTotal(cagr10y, 10),
    cagr3y,
    cagr5y,
    cagr10y,
    siAnn,
    dividendYield,
    dividendYieldText: text(dividendYield) ?? '—',
    secYield: coalesce(publishedSecYield),
    secYieldText: text(coalesce(publishedSecYield)) ?? '—',
    returnsBasis: Object.values(official).some((value) => value !== null)
      ? 'official Capital Group NAV total returns (fund-detail JSON)'
      : 'derived from the daily NAV history with published distributions reinvested (or Yahoo adjusted closes), not official NAV returns',
  };
}

// ---------------------------------------------------------------------------
// Eligibility filters (AND logic, iShares semantics)
// ---------------------------------------------------------------------------

function inRange(value: number | null | undefined, range?: Range): boolean {
  if (!range) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

function annualizedValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  if (period === 'YTD') return numberOrNull(metrics.ytd);
  if (period === '1Y') return numberOrNull(metrics.tr1y);
  return numberOrNull(metrics[`cagr${period.toLowerCase()}`]);
}

function cumulativeValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  const key = period === 'YTD' ? 'ytd' : period === '1Y' ? 'tr1y' : `tr${period.toLowerCase()}`;
  return numberOrNull(metrics[key]);
}

export function fundFilterReasons(
  candidate: { ticker: string; aumValue?: number | null; terValue?: number | null; metrics: JsonRecord },
  config: UpdaterConfig,
): string[] {
  const reasons: string[] = [];
  if (config.tickers.length && !config.tickers.includes(candidate.ticker)) reasons.push('TICKERS');
  if (config.aumRange && !inRange(candidate.aumValue ?? null, config.aumRange)) reasons.push('AUM');
  if (config.terRange && !inRange(candidate.terValue ?? null, config.terRange)) reasons.push('TER');
  if (config.dividendYieldRange && !inRange(numberOrNull(candidate.metrics.dividendYield), config.dividendYieldRange)) {
    reasons.push('DIVIDEND_YIELD');
  }
  for (const period of RETURN_PERIODS) {
    const performance = config.performanceRanges[period];
    if (performance && !inRange(annualizedValue(candidate.metrics, period), performance)) reasons.push(`PERFORMANCE_${period}`);
    const total = config.totalReturnRanges[period];
    if (total && !inRange(cumulativeValue(candidate.metrics, period), total)) reasons.push(`TOTAL_RETURN_${period}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Deterministic writers (iShares/SPDR/Fidelity-style)
// ---------------------------------------------------------------------------

// Comparing raw text would treat a run that only refreshed generatedAt (with
// every fund's actual data unchanged) as a real change and rewrite the file
// every time. Compare with both timestamps stripped instead.
export function samePublishedContent(previous: string, value: unknown): boolean {
  const withoutRunTimestamp = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(withoutRunTimestamp);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !['generatedAt', 'catalogReadAt', 'savedAt'].includes(key)).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => [key, withoutRunTimestamp(value)]));
  };
  try {
    return JSON.stringify(withoutRunTimestamp(JSON.parse(previous))) === JSON.stringify(withoutRunTimestamp(value));
  } catch { return false; }
}

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const next = `${JSON.stringify(value, null, 1)}\n`;
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    // First write.
  }
  if (previous === next || (previous !== null && samePublishedContent(previous, value))) return false;
  await writeFile(file, next, 'utf8');
  return true;
}

export async function writePages(
  dir: URL,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: JsonRecord[],
  pageSize: number,
): Promise<{ pages: string[]; pageSize: number; totalRows: number }> {
  await mkdir(new URL(`${kind}/`, dir), { recursive: true });
  const pages: string[] = [];
  if (rows.length) {
    const pageCount = Math.ceil(rows.length / pageSize);
    for (let page = 1; page <= pageCount; page++) {
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      const name = `${kind}/${pad3(page)}.json`;
      await writeIfChanged(new URL(name, dir), {
        ticker,
        page,
        pageSize,
        totalRows: rows.length,
        headers,
        rows: slice,
      });
      pages.push(name);
    }
  }
  await removeStalePages(dir, kind, new Set(pages));
  return { pages, pageSize, totalRows: rows.length };
}

async function removeStalePages(fundDir: URL, kind: 'holdings' | 'history', kept: Set<string>): Promise<void> {
  const kindDir = new URL(`${kind}/`, fundDir);
  let entries: string[] = [];
  try {
    entries = await readdir(kindDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith('.json') && !kept.has(`${kind}/${entry}`)) {
      await rm(new URL(entry, kindDir), { force: true });
    }
  }
}

type UpdateState = { cursor: string | null; savedAt: string };

async function readUpdateState(): Promise<UpdateState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

async function writeUpdateState(lastProcessedTicker: string | null): Promise<void> {
  if (!lastProcessedTicker) { await rm(STATE_FILE, { force: true }); return; }
  let previous: UpdateState | null = await readUpdateState();
  if (previous?.cursor === lastProcessedTicker) return;
  await writeIfChanged(STATE_FILE, { cursor: lastProcessedTicker, savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
}

async function readPreviousIndex(): Promise<Map<string, JsonRecord>> {
  const map = new Map<string, JsonRecord>();
  try {
    const payload = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as JsonRecord;
    for (const fund of payload.funds || []) {
      if (fund && typeof fund.ticker === 'string') map.set(fund.ticker, fund);
    }
  } catch {
    // First run.
  }
  return map;
}

async function readPreviousSheet(ticker: string, kind: 'holdings' | 'history'): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  let page = 1;
  for (;;) {
    let payload: JsonRecord;
    try {
      payload = JSON.parse(await readFile(new URL(`funds/${ticker}/${kind}/${pad3(page)}.json`, API_ROOT), 'utf8')) as JsonRecord;
    } catch {
      return rows;
    }
    rows.push(...(payload.rows || []));
    const totalRows = numberOrNull(payload.totalRows);
    if (totalRows !== null && rows.length >= totalRows) return rows;
    if (!(payload.rows || []).length) return rows;
    page += 1;
  }
}

async function readPreviousSheetHeaders(ticker: string, kind: 'holdings' | 'history'): Promise<string[]> {
  try {
    const payload = JSON.parse(await readFile(new URL(`funds/${ticker}/${kind}/${pad3(1)}.json`, API_ROOT), 'utf8')) as JsonRecord;
    return Array.isArray(payload.headers) ? (payload.headers as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fund assembly
// ---------------------------------------------------------------------------

// Official history rows (newest last, like the sibling Yahoo-based sheets):
// the NAV, the closing market price and the premium/discount Capital Group
// publishes for every business day since inception.
function officialHistoryRows(points: HistoryPoint[]): JsonRecord[] {
  return points.map((point) => ({
    Date: formatEdgarDate(point.date),
    NAV: point.nav === null ? '' : String(point.nav),
    'Market Price': point.marketPrice === null ? '' : String(point.marketPrice),
    'Premium/Discount': point.premiumDiscount === null ? '' : String(point.premiumDiscount),
  }));
}

// Yahoo fallback rows, identical to the sibling feeds.
function historyRows(days: ChartDay[]): JsonRecord[] {
  return days.map((day) => ({
    Date: formatEdgarDate(day.date),
    Close: String(day.close),
    'Adj Close': String(day.adjClose),
    Volume: String(day.volume),
  }));
}

// Array rows (not objects): meta.distributions feeds renderDistributionsTable
// directly, same as the sibling worksheet shape.
function distributionRows(dividends: Array<{ epoch: number; amount: number }>): string[][] {
  return dividends.map((dividend) => [formatUsDate(dividend.epoch), String(round(dividend.amount, 6))]);
}

// Capital Group annualizes returns beyond one year only; a since-inception figure
// of a fund younger than one year is cumulative and must not be published in
// the "SI Ann." column (the derived, >= 0.75-year annualization fills in).
export function annualizedSinceInception(value: number | null, inception: string | null, asOfDate: string | null): number | null {
  if (value === null) return null;
  const start = inception ? isoToEpoch(inception) : null;
  const end = asOfDate ? isoToEpoch(asOfDate) : null;
  if (start === null || end === null) return value;
  return (end - start) / 86_400 >= 365 ? value : null;
}

function mergeOfficial(primary: CatalogReturns | null, secondary: CatalogReturns | null): CatalogReturns {
  const pick = (key: keyof CatalogReturns): number | null => primary?.[key] ?? secondary?.[key] ?? null;
  return { ytd: pick('ytd'), yr1: pick('yr1'), yr3: pick('yr3'), yr5: pick('yr5'), yr10: pick('yr10'), sinceInception: pick('sinceInception') };
}

function returnsBlock(
  derived: PriceReturns,
  official: CatalogReturns,
  officialMo1: number | null,
  asOfDate: string | null,
  quarterEnd: CatalogReturns,
  quarterEndAsOfDate: string | null,
  previous: JsonRecord,
): JsonRecord | null {
  const hasOfficial = Object.values(official).some((value) => value !== null);
  const hasDerived = Boolean(derived.asOfDate);
  if (!hasOfficial && !hasDerived) return (previous.returns as JsonRecord) ?? null;
  const text = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : `${value.toFixed(2)}%`);
  const asOf = asOfDate || derived.asOfDate;
  const mo1 = officialMo1 ?? derived.mo1;
  const hasQuarterEnd = Object.values(quarterEnd).some((value) => value !== null);
  const quarterAnchor = quarterEndAsOfDate || lastCompletedQuarterEnd().toISOString().slice(0, 10);
  return {
    derivedFrom: hasOfficial
      ? `official Capital Group NAV total returns (fund-detail JSON); ${officialMo1 === null ? 'mo1/qtd' : 'qtd'} derived from the daily NAV history with published distributions reinvested`
      : hasDerived && derived.asOfDate
        ? 'derived from the official daily NAV history with published distributions reinvested (NAV total return), not official published returns'
        : 'adjusted market-price closes (Yahoo chart API), not official NAV returns',
    monthEnd: {
      asOfDate: asOf ? formatEdgarDate(asOf) : '—',
      mo1,
      mo1Text: text(mo1),
      qtd: derived.qtd,
      qtdText: text(derived.qtd),
      ytd: official.ytd ?? derived.ytd,
      ytdText: text(official.ytd ?? derived.ytd),
      yr1: official.yr1 ?? derived.yr1,
      yr1Text: text(official.yr1 ?? derived.yr1),
      yr3: official.yr3 ?? derived.cagr3y,
      yr3Text: text(official.yr3 ?? derived.cagr3y),
      yr5: official.yr5 ?? derived.cagr5y,
      yr5Text: text(official.yr5 ?? derived.cagr5y),
      yr10: official.yr10 ?? derived.cagr10y,
      yr10Text: text(official.yr10 ?? derived.cagr10y),
      sinceInception: official.sinceInception ?? derived.siAnn,
      sinceInceptionText: text(official.sinceInception ?? derived.siAnn),
    },
    quarterEnd: hasQuarterEnd
      ? {
          asOfDate: formatEdgarDate(quarterAnchor),
          ytd: quarterEnd.ytd,
          yr1: quarterEnd.yr1,
          yr3: quarterEnd.yr3,
          yr5: quarterEnd.yr5,
          yr10: quarterEnd.yr10,
          sinceInception: quarterEnd.sinceInception,
        }
      : { asOfDate: formatEdgarDate(quarterAnchor), ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
  };
}

async function storeRaw(ticker: string, name: string, payload: unknown): Promise<void> {
  const rawDir = new URL(`raw/${ticker}/`, API_ROOT);
  await mkdir(rawDir, { recursive: true });
  await writeFile(new URL(name, rawDir), `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
}


export type SourceObject = Record<string, unknown>;
export function sourceObject(value: unknown): SourceObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SourceObject : {};
}
function sourceArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function sourceText(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
export function sourceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = sourceText(value).replace(/[$,%\s,]/g, '');
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}
export function sourceDate(value: unknown): string | null {
  const text = sourceText(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (!iso && !us) return null;
  const year = iso ? Number(iso[1]) : Number(us![3]) + (us![3].length === 2 ? 2000 : 0);
  const month = Number(iso ? iso[2] : us![1]);
  const day = Number(iso ? iso[3] : us![2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null;
}
export function issuerFundUrl(ticker: string): string {
  if (!/^[A-Z0-9]{1,10}$/i.test(ticker)) throw new Error('Invalid fund ticker');
  return `https://www.capitalgroup.com/advisor/investments/exchange-traded-funds/details/${ticker.toLowerCase()}`;
}
export const ISSUER_API = 'https://www.capitalgroup.com/api/investments/investment-service/v1/etfs';
export function issuerHoldingsUrl(ticker: string): string { return `${ISSUER_API}/${encodeURIComponent(ticker)}/download/daily-holdings?audience=advisor`; }
export function issuerDistributionsUrl(ticker: string): string { return `${ISSUER_API}/${encodeURIComponent(ticker)}/historical-distributions?include=all`; }
export function issuerPricesUrl(ticker: string, from: string, to: string): string {
  if (!sourceDate(from) || !sourceDate(to) || from > to) throw new Error('Invalid price date range');
  return `${ISSUER_API}/${encodeURIComponent(ticker)}/premium-discount-details?fromDate=${from}&toDate=${to}`;
}
export function parseIssuerCatalog(html: string): string[] {
  const tickers = new Set<string>();
  for (const match of html.matchAll(/(?:href=["'])[^"']*\/exchange-traded-funds\/details\/([a-z0-9]{1,10})(?:["'?#/])/gi)) tickers.add(match[1].toUpperCase());
  if (!tickers.size) throw new Error('Issuer catalog has no fund links (possibly a bootstrap/challenge page)');
  return [...tickers].sort();
}

// Decode JSON only; never eval the issuer's JavaScript. Flight chunks can split
// an object anywhere, so concatenate strings before parsing complete records.
export function parseIssuerFlight(html: string, ticker: string): SourceObject {
  let stream = '';
  for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    const chunk: unknown = JSON.parse(match[1]);
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') stream += chunk[1];
  }
  const marker = '"data":';
  let start = 0;
  while ((start = stream.indexOf(marker, start)) >= 0) {
    start += marker.length;
    if (stream[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < stream.length; i++) {
      const c = stream[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) {
        const data = sourceObject(JSON.parse(stream.slice(start, i + 1)));
        if (sourceText(sourceObject(data.details).abbreviatedName).toUpperCase() === ticker.toUpperCase()) return data;
        break;
      }
    }
  }
  throw new Error(`${ticker}: matching issuer facts missing from Flight payload`);
}

export type IssuerReturns = { asOfDate: string | null; mo1: number | null; ytd: number | null; yr1: number | null; yr3: number | null; yr5: number | null; yr10: number | null; sinceInception: number | null };
type NumericReturnKey = Exclude<keyof IssuerReturns, 'asOfDate'>;
const RETURN_SLOTS: Record<string, NumericReturnKey> = { Month1: 'mo1', YtdMonthly: 'ytd', Year1: 'yr1', Year3: 'yr3', Year5: 'yr5', Year10: 'yr10', Lifetime: 'sinceInception' };
export function parseIssuerReturns(value: unknown, prefix = 'nav'): IssuerReturns {
  const row = sourceObject(value);
  const result: IssuerReturns = { asOfDate: sourceDate(row.asOfDate), mo1: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
  for (const [tenor, key] of Object.entries(RETURN_SLOTS)) result[key] = sourceNumber(row[`${prefix}${tenor}`]);
  return result;
}
export function issuerFrequency(value: unknown): { frequency: string; paymentsPerYear: number | null } {
  const text = sourceText(value).toLowerCase();
  if (text === 'monthly') return { frequency: 'Monthly', paymentsPerYear: 12 };
  if (text === 'quarterly' || text === 'mar., jun., sep., dec.') return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (text === 'annually' || text === 'dec.') return { frequency: 'Annually', paymentsPerYear: 1 };
  if (text === 'semi-annually' || text === 'jun., dec.') return { frequency: 'Semi-annually', paymentsPerYear: 2 };
  return { frequency: text ? 'Unknown' : '—', paymentsPerYear: null };
}
export function parseIssuerFacts(payload: unknown, ticker: string) {
  const data = sourceObject(payload), d = sourceObject(data.details), daily = sourceObject(data.dailyDetails);
  if (sourceText(d.abbreviatedName).toUpperCase() !== ticker.toUpperCase()) throw new Error(`${ticker}: issuer facts ticker mismatch`);
  const facts = sourceObject(d.fundFacts), price = sourceObject(daily.priceDistribution), assets = sourceObject(daily.fundFacts);
  const expense = sourceObject(d.expenseRatio), yieldData = sourceObject(d.yield);
  const millions = sourceNumber(assets.assetsInMillions);
  const cik = sourceText(d.cikNumber);
  return {
    ticker: ticker.toUpperCase(), name: sourceText(d.name), category: sourceText(d.assetClass), subCategory: sourceText(d.subAssetClass),
    trustCik: /^\d{1,10}$/.test(cik) ? cik.padStart(10, '0') : null,
    inception: sourceDate(d.inceptionDate), cusip: sourceText(d.cusip), exchange: sourceText(facts.primaryExchange), benchmark: sourceText(d.benchmarkName),
    grossExpense: sourceNumber(expense.grossExpenseRatio), netExpense: sourceNumber(expense.netExpenseRatio),
    nav: sourceNumber(price.navPrice), close: sourceNumber(price.marketPrice), premiumDiscount: sourceNumber(price.premiumDiscount), priceDate: sourceDate(price.asOfDate),
    netAssets: millions === null ? null : millions * 1e6, assetsDate: sourceDate(assets.assetsInMillionDate),
    secYield: sourceNumber(yieldData.netSecYield), unsubsidizedSecYield: sourceNumber(yieldData.grossSecYield),
    distributionRate: sourceNumber(yieldData.navDistributionRate), yieldDate: sourceDate(yieldData.asOfDate),
    frequency: issuerFrequency(facts.regularDividendsPaid),
    monthEnd: parseIssuerReturns(d.monthlyReturns), marketMonthEnd: parseIssuerReturns(d.monthlyReturns, 'marketPrice'),
    // The observed quarterlyReturns duplicated month-end August data. Do not
    // mislabel a non-quarter-end date as quarter-end performance.
    quarterEnd: /-(03-31|06-30|09-30|12-31)$/.test(sourceDate(sourceObject(d.quarterlyReturns).asOfDate) || '') ? parseIssuerReturns(d.quarterlyReturns) : parseIssuerReturns(null),
  };
}

function xmlText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
// Minimal read-only OOXML reader using Node's built-in inflate; no XLSX package.
// Use central directory sizes (the issuer uses ZIP data descriptors). Bound
// archive/expanded size; reject encryption, ZIP64 and unsupported compression.
export function unzipIssuerWorkbook(input: Uint8Array): Map<string, string> {
  const b = Buffer.from(input);
  if (b.length > 32 * 1024 * 1024) throw new Error('Workbook too large');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Not an XLSX ZIP archive');
  const count = b.readUInt16LE(end + 10), offset = b.readUInt32LE(end + 16);
  if (count === 65535 || offset === 0xffffffff || b.readUInt16LE(end + 4) !== 0) throw new Error('Unsupported ZIP layout');
  let pos = offset, expanded = 0;
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > b.length || b.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const flags = b.readUInt16LE(pos + 8), method = b.readUInt16LE(pos + 10), size = b.readUInt32LE(pos + 20), rawSize = b.readUInt32LE(pos + 24);
    const nameLength = b.readUInt16LE(pos + 28), extraLength = b.readUInt16LE(pos + 30), commentLength = b.readUInt16LE(pos + 32), local = b.readUInt32LE(pos + 42);
    const name = b.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    pos += 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || ![0, 8].includes(method) || rawSize > 32 * 1024 * 1024 || (expanded += rawSize) > 64 * 1024 * 1024) throw new Error('Unsupported or oversized workbook entry');
    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP entry');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + size > b.length) throw new Error('Truncated ZIP entry');
    if (!name.endsWith('.xml')) continue;
    const compressed = b.subarray(start, start + size);
    const raw = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
    if (raw.length !== rawSize) throw new Error('Workbook size mismatch');
    files.set(name, raw.toString('utf8'));
  }
  return files;
}
export function workbookRows(files: Map<string, string>): string[][][] {
  const strings = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1]));
  return [...files].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([, xml]) => {
    return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(match => {
      const row: string[] = [];
      for (const cell of match[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const coordinate = /\br="([A-Z]+)\d+"/.exec(cell[1]);
        if (!coordinate) continue;
        let col = 0; for (const c of coordinate[1]) col = col * 26 + c.charCodeAt(0) - 64;
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2] || '')?.[1] || '';
        row[col - 1] = type === 's' ? strings[Number(value)] ?? '' : type === 'inlineStr' ? xmlText(cell[2] || '') : xmlText(value);
      }
      return row;
    });
  });
}
export function parseIssuerHoldings(input: Uint8Array, ticker: string) {
  const sheets = workbookRows(unzipIssuerWorkbook(input));
  const sheet = sheets.find(rows => rows.some(row => row.includes('Security Name') && row.includes('Percent of Net Assets')));
  if (!sheet) throw new Error(`${ticker}: holdings worksheet missing`);
  const title = sheet.flat().join(' ');
  if (!new RegExp(`\\b${ticker}\\s*-`, 'i').test(title)) throw new Error(`${ticker}: holdings workbook ticker mismatch`);
  const asOfDate = sourceDate(/As Of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(title)?.[1]);
  if (!asOfDate) throw new Error(`${ticker}: holdings date missing`);
  const headerIndex = sheet.findIndex(row => row.includes('Security Name'));
  const headers = sheet[headerIndex];
  const rows: Record<string, string>[] = [];
  for (const cells of sheet.slice(headerIndex + 1)) {
    const get = (key: string) => cells[headers.indexOf(key)] || '';
    const name = get('Security Name'), weight = sourceNumber(get('Percent of Net Assets'));
    if (!name || weight === null) continue;
    const asset = get('Asset Type'), rawTicker = get('Ticker');
    const isin = get('ISIN');
    const rawCusip = get('CUSIP');
    const cusip = /^US[A-Z0-9]{10}$/.test(isin) ? isin.slice(2, 11) : sourceNumber(rawCusip) !== null ? String(sourceNumber(rawCusip)).padStart(9, '0') : rawCusip;
    // Bond/cash tickers are issuer codes, not exchange-listed equity symbols.
    const symbol = /equity|fund/i.test(asset) && /^[A-Z0-9][A-Z0-9.\/-]*$/i.test(rawTicker) && !['NA', 'N/A'].includes(rawTicker) ? rawTicker : '';
    rows.push({ Name: name, Ticker: symbol, Identifier: cusip && cusip !== '--' ? cusip : isin === '--' ? '' : isin,
      Weight: String(Math.round(weight * 100 * 1e6) / 1e6), 'Market Value': String(sourceNumber(get('Market Value')) ?? ''),
      'Shares Held': String(sourceNumber(get('Shares or Principal Amount')) ?? ''), 'Asset Category': asset });
  }
  if (!rows.length) throw new Error(`${ticker}: empty holdings workbook`);
  rows.sort((a, b) => Number(b.Weight) - Number(a.Weight) || a.Identifier.localeCompare(b.Identifier) || a.Name.localeCompare(b.Name));
  return { asOfDate, headers: ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'], rows };
}
export function parseIssuerPrices(payload: unknown, ticker: string) {
  const data = sourceObject(payload);
  if (sourceText(data.quotron).toUpperCase() !== ticker.toUpperCase()) throw new Error(`${ticker}: price ticker mismatch`);
  const byDate = new Map<string, { date: string; nav: number | null; marketPrice: number | null; premiumDiscount: number | null }>();
  for (const value of sourceArray(data.premiumDiscountDetails)) {
    const row = sourceObject(value), values = sourceObject(row.values), date = sourceDate(row.asOfDate);
    const nav = sourceNumber(values.nav), marketPrice = sourceNumber(values.marketPrice);
    if (date && (nav !== null || marketPrice !== null)) byDate.set(date, { date, nav, marketPrice, premiumDiscount: sourceNumber(values.premiumDiscount) });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function parseIssuerDistributions(payload: unknown) {
  const data = sourceObject(payload);
  if (!Array.isArray(data.distributions)) throw new Error('Distribution response missing array');
  return data.distributions.flatMap(value => {
    const row = sourceObject(value), exDate = sourceDate(row.exDate), amount = sourceNumber(row.totalDistributions);
    if (!exDate || amount === null || amount < 0) return [];
    return [{ epoch: Date.parse(exDate + 'T00:00:00Z') / 1000, amount, exDate, payDate: sourceDate(row.payDate) || '', recordDate: sourceDate(row.recordDate) || '', reinvestNav: sourceNumber(row.reinvestNav), type: 'Total distribution (including capital gains)' }];
  }).sort((a, b) => a.epoch - b.epoch);
}

export function productFromIssuer(facts: ReturnType<typeof parseIssuerFacts>): ProductData {
  return { ticker: facts.ticker, name: facts.name, cusip: facts.cusip, isin: '', exchange: facts.exchange,
    assetClass: facts.category, benchmark: facts.benchmark, inception: facts.inception, listingDate: null,
    grossExpense: facts.grossExpense, netExpense: facts.netExpense, nav: facts.nav, navDate: facts.priceDate,
    marketPrice: facts.close, marketPriceDate: facts.priceDate, premiumDiscount: facts.premiumDiscount,
    netAssets: facts.netAssets, netAssetsDate: facts.assetsDate, sharesOutstanding: null, numberOfHoldings: null,
    dividendYield: null, dividendYieldDate: null, dividendYieldKind: '', secYield: facts.secYield,
    secYieldDate: facts.yieldDate, secYieldKind: 'official 30-day SEC yield', unsubsidizedSecYield: facts.unsubsidizedSecYield,
    frequencyCode: ({ Monthly:'M', Quarterly:'Q', 'Semi-annually':'S', Annually:'A' } as Record<string,string>)[facts.frequency.frequency] || '',
    latestDividend: null, monthEnd: { ...facts.monthEnd, mo3: null }, monthEndMarket: { ...facts.marketMonthEnd, mo3: null },
    cumulative: { ...EMPTY_CUMULATIVE }, cumulativeAsOfDate: null, holdings: null };
}
async function loadIssuerProduct(fund: CatalogFund, config: UpdaterConfig): Promise<ProductData> {
  const html = await (await issuerFetch(issuerFundUrl(fund.ticker), config)).text();
  const payload = parseIssuerFlight(html, fund.ticker), facts = parseIssuerFacts(payload, fund.ticker);
  Object.assign(fund, { name: facts.name, category: facts.category, categoryPath: [facts.category, facts.subCategory].filter(Boolean).join(' / '), inception: facts.inception,
    cusip: facts.cusip, exchange: facts.exchange, benchmark: facts.benchmark, trustCik: facts.trustCik,
    quarterEnd: facts.quarterEnd, quarterEndAsOfDate: facts.quarterEnd.asOfDate, distributionRate: facts.distributionRate, source: 'capital-group' });
  if (config.storeRawDownloads) await storeRaw(fund.ticker, 'facts.json', { details: { ...sourceObject(payload.details), professionalRelationship: undefined }, dailyDetails: payload.dailyDetails });
  return productFromIssuer(facts);
}
async function loadIssuerHistory(fund: CatalogFund, config: UpdaterConfig): Promise<ParsedHistoricalData> {
  const empty: OfficialReturns = { ...EMPTY_RETURNS, mo1: null, mo3: null, asOfDate: null };
  const result: ParsedHistoricalData = { points: [], dividends: [], quarterEnd: empty, quarterEndMarket: empty, monthlyReturns: [] };
  // Reinvestment-derived returns must never be calculated from an incomplete
  // distribution fetch. Throw to Yahoo/cache rather than assume zero payouts.
  const dividends = await (await issuerFetch(issuerDistributionsUrl(fund.ticker), config)).json();
  result.dividends = parseIssuerDistributions(dividends);
  if (!fund.inception) throw new Error('No verified inception date for official history');
  const prices = await (await issuerFetch(issuerPricesUrl(fund.ticker, fund.inception, new Date().toISOString().slice(0,10)), config)).json();
  result.points = parseIssuerPrices(prices, fund.ticker);
  if (config.storeRawDownloads) { await storeRaw(fund.ticker,'prices.json',prices); await storeRaw(fund.ticker,'distributions.json',dividends); }
  return result;
}
export function retainUnavailable(candidate: unknown, previous: unknown): unknown {
  if (candidate === null || candidate === undefined || candidate === '' || candidate === '—') return previous ?? candidate;
  if (Array.isArray(candidate)) return candidate;
  if (typeof candidate !== 'object') return candidate;
  const prior = sourceObject(previous);
  return Object.fromEntries(Object.entries(candidate).map(([key,value]) => [key, retainUnavailable(value, prior[key])]));
}
async function processFund(
  fund: CatalogFund,
  config: UpdaterConfig,
  previous: JsonRecord,
): Promise<JsonRecord | null> {
  const ticker = fund.ticker;

  // Ticker selection has already happened before queueing or any fund request.
  const fundDir = new URL(`funds/${ticker}/`, API_ROOT);
  let previousMeta: JsonRecord = {};
  try { previousMeta = JSON.parse(await readFile(new URL('meta.json', fundDir), 'utf8')); } catch { /* first run */ }
  previous = { ...previous, ...previousMeta };
  fund.inception ??= previousMeta.inception?.fundInceptionDate ?? null;
  let product: ProductData | null = null;
  if (!config.skipIssuer) {
    try { product = await loadIssuerProduct(fund, config); }
    catch (error) { outputNote(`[ product  ] ${ticker}: ${errorMessage(error)} — trying holdings fallbacks`); }
    try {
      const response = await issuerFetch(issuerHoldingsUrl(ticker), config);
      const holdings = parseIssuerHoldings(new Uint8Array(await response.arrayBuffer()), ticker);
      if (!product) product = productFromIssuer(parseIssuerFacts({ details: { abbreviatedName: ticker }, dailyDetails: {} }, ticker));
      product.holdings = holdings;
    } catch (error) { outputNote(`[ holdings ] ${ticker}: ${errorMessage(error)} — trying SEC/cached holdings`); }
  }
  const cusip = product?.cusip || fund.cusip || String(previous.identifiers?.cusip || '');

  let holdings: ParsedHoldings | null = product?.holdings ?? null;
  let holdingsSource = holdings ? 'Capital Group daily holdings XLSX' : String(previous.holdings?.source || 'previous run');
  let holdingsEdgar: ParsedNport | null = null;
  if (!holdings && config.edgarFallback) {
    try {
      const filing = await resolveNportFiling(fund, config);
      if (filing) {
        const parsed = parseNport(await fetchText(filing.accession.url, `[ nport    ] ${ticker}`, secHeaders(config), config));
        // A registrant files one N-PORT-P per series: only accept the document
        // that really belongs to this fund, never the trust's newest filing.
        const filedSeries = normalizeHoldingName(parsed.seriesName);
        const wantedSeries = normalizeHoldingName(fund.name);
        const belongsToFund = filing.seriesId
          ? parsed.seriesId.toUpperCase() === filing.seriesId.toUpperCase()
          : Boolean(filedSeries && wantedSeries && (filedSeries === wantedSeries || filedSeries.includes(wantedSeries) || wantedSeries.includes(filedSeries)));
        if (!belongsToFund) {
          outputNote(`[ edgar    ] ${ticker}: ${filing.accession.accession} reports "${parsed.seriesName || 'unknown series'}" — skipped`);
        } else if (parsed.holdings.length) {
          holdingsEdgar = parsed;
          holdings = {
            asOfDate: parsed.repPdDate || null,
            headers: HOLDINGS_HEADERS,
            rows: fillNportTickers(parsed.holdings, await loadCompanyTickerMap(config)),
          };
          holdingsSource = `SEC EDGAR Form N-PORT-P (accession ${filing.accession.accession}, report period ${parsed.repPdDate || 'n/a'})`;
        }
      }
    } catch (error) {
      outputNote(`[ edgar    ] ${ticker}: ${errorMessage(error)} — keeping previous holdings`);
    }
  }

  const holdingsRows: JsonRecord[] = holdings ? holdings.rows : await readPreviousSheet(ticker, 'holdings');
  const holdingsHeaders = holdings?.headers.length
    ? holdings.headers
    : (await readPreviousSheetHeaders(ticker, 'holdings')) || HOLDINGS_HEADERS;
  const holdingsAsOf = holdings?.asOfDate || (((previous.holdings as JsonRecord)?.asOfDate as string) ?? null);

  let historical: ParsedHistoricalData | null = null;
  if (!config.skipIssuer) {
    try { historical = await loadIssuerHistory(fund, config); }
    catch (error) { outputNote(`[ history  ] ${ticker}: ${errorMessage(error)} — trying Yahoo/cache`); }
  }

  let chartDays: ChartDay[] = [];
  let history: JsonRecord[] = [];
  let historyHeaders: string[] = HISTORY_HEADERS;
  let dividends: Array<{ epoch: number; amount: number }> = historical?.dividends ?? [];
  let exchangeName = '';
  let navFromChart: number | null = null;
  let priceFromChart: number | null = null;
  let marketTime: number | null = null;
  let firstTradeDate: number | null = null;
  let historySource = 'capitalgroup.com daily price API (NAV, market price and premium/discount since inception)';

  let coveredFrom: string | null = null;
  if (historical?.points.length) {
    chartDays = navTotalReturnDays(historical.points, historical.dividends);
    coveredFrom = historical.points.find(point => point.nav !== null && point.nav > 0)?.date ?? null;
    history = officialHistoryRows(historical.points);
  } else if (!config.skipYahoo) {
    try {
      const chart = parseChart(await fetchJson(chartUrl(ticker, config), `[ chart    ] ${ticker}`, yahooHeaders(), config));
      exchangeName = chart.exchangeName;
      navFromChart = chart.navPrice;
      priceFromChart = chart.regularMarketPrice;
      marketTime = chart.regularMarketTime;
      firstTradeDate = chart.firstTradeDate;
      if (!dividends.length) dividends = chart.dividends;
      chartDays = chart.days;
      history = historyRows(chart.days);
      historyHeaders = YAHOO_HISTORY_HEADERS;
      historySource = 'Yahoo Finance public chart API (adjusted close)';
    } catch (error) {
      outputNote(`[ chart    ] ${ticker}: ${errorMessage(error)} — keeping previous history`);
    }
  }

  const haveFreshHistory = history.length > 0;
  if (!haveFreshHistory) {
    history = await readPreviousSheet(ticker, 'history');
    const previousHeaders = await readPreviousSheetHeaders(ticker, 'history');
    historyHeaders = previousHeaders.length ? previousHeaders : HISTORY_HEADERS;
  }
  const derived = chartDays.length ? priceReturns(chartDays, new Date(), coveredFrom) : EMPTY_PRICE_RETURNS;

  // The dividend schedule lists the last payments; the fund-detail JSON "latest
  // dividend" backs it up when the schedule is empty.
  if (!dividends.length && product?.latestDividend) {
    const epoch = isoToEpoch(product.latestDividend.exDate);
    if (epoch !== null) dividends = [{ epoch, amount: product.latestDividend.amount }];
  }
  const latestDividend = dividends.length ? dividends[dividends.length - 1] : null;
  const decodedFrequency = decodeDividendFrequency(product?.frequencyCode);
  const inferredFrequency = dividends.length >= 2 ? inferDistributionFrequency(dividends) : null;
  const frequency =
    decodedFrequency && decodedFrequency.paymentsPerYear !== null
      ? decodedFrequency
      : inferredFrequency && inferredFrequency.paymentsPerYear !== null
        ? inferredFrequency
        : decodedFrequency
          ? decodedFrequency
          : dividends.length
            ? inferDistributionFrequency(dividends)
            : { frequency: String((previous.distributions as JsonRecord)?.frequency || '—'), paymentsPerYear: null };

  // Official returns: fund-detail JSON month-end "At NAV" (also carries 1-month)
  // backed by the fund explorer block; quarter-end from historicalData.
  const inception = product?.inception ?? fund.inception ?? null;
  const returnsAsOfDate = product?.monthEnd.asOfDate ?? fund.returnsAsOfDate ?? null;
  const official = mergeOfficial(product?.monthEnd ?? null, fund.returns);
  const quarterEndSource = historical?.quarterEnd.asOfDate ? historical.quarterEnd : fund.quarterEnd;
  const quarterEndAsOfDate = historical?.quarterEnd.asOfDate ?? fund.quarterEndAsOfDate ?? null;
  const quarterEnd: CatalogReturns = mergeOfficial(quarterEndSource, EMPTY_RETURNS);

  const ter = product?.grossExpense ?? product?.netExpense ?? fund.ter ?? numberOrNull(previous.terValue);
  const nav = product?.nav ?? fund.nav ?? navFromChart ?? numberOrNull(previous.navValue);
  const price = product?.marketPrice ?? fund.close ?? priceFromChart ?? numberOrNull(previous.closePriceValue);
  const dividendYield = product?.dividendYield ?? fund.dividendYield;
  const secYield = product?.secYield ?? fund.secYield;

  const metrics = deriveCatalogMetrics(
    official,
    derived,
    dividendYield,
    secYield,
    latestDividend ? latestDividend.amount : null,
    frequency.paymentsPerYear,
    price,
    product?.cumulative ?? null,
  );

  const filterReasons = fundFilterReasons({ ticker, aumValue: product?.netAssets ?? holdingsEdgar?.netAssets ?? fund.netAssets, terValue: ter, metrics }, config);
  if (filterReasons.length) { outputNote(`[ filter   ] ${ticker}: ${filterReasons.join('; ')}`); return null; }
  if (!product && !holdings && !haveFreshHistory) {
    throw new Error('All providers unavailable; previously published fund left untouched');
  }
  if (!holdingsRows.length && !history.length) throw new Error('No holdings or history available; fund not published');
  const holdingsManifest = await writePages(fundDir, ticker, 'holdings', holdingsHeaders, holdingsRows, config.holdingsPageSize);
  const historyManifest = await writePages(fundDir, ticker, 'history', historyHeaders, history, config.historyPageSize);
  const distributions = dividends.length ? distributionRows(dividends) : (((previous.distributions?.rows as JsonRecord[]) || []) as string[][]);

  // Without a fresh capitalgroup.com catalog the filed N-PORT-P series name is
  // the most authoritative fund name available.
  const name =
    product?.name || (fund.source !== 'capital-group' && holdingsEdgar?.seriesName) || fund.name || String(previous.name ?? '') || ticker;
  const premiumDiscount =
    product?.premiumDiscount ?? fund.premiumDiscount ?? (nav && price ? round(((price - nav) / nav) * 100, 2) : null);
  // Fresh capitalgroup.com net assets win; when the catalog row only comes from
  // the previously published index (capitalgroup.com unavailable), the N-PORT-P
  // net assets of the filing we just parsed are the authoritative number.
  const nportNetAssets = holdingsEdgar
    ? holdingsEdgar.netAssets ?? (holdingsEdgar.totalValue ? round(holdingsEdgar.totalValue, 2) : null)
    : null;
  const catalogNetAssets = product?.netAssets ?? (fund.source === 'capital-group' ? fund.netAssets : null);
  const netAssets = catalogNetAssets ?? nportNetAssets ?? fund.netAssets ?? numberOrNull(previous.aumValue);
  const navAsOfDate = product?.navDate ?? fund.asOfDate ?? null;
  const returnsData = returnsBlock(derived, official, product?.monthEnd.mo1 ?? fund.mo1 ?? null, returnsAsOfDate, quarterEnd, quarterEndAsOfDate, previous);
  if (returnsData && haveFreshHistory && historySource.startsWith('Yahoo')) returnsData.derivedFrom = 'Official Capital Group returns where available; missing periods derived from Yahoo adjusted market-price closes, not official NAV returns';
  const asOfLabel = navAsOfDate ? formatEdgarDate(navAsOfDate) : marketTime ? formatEpochDate(marketTime) : String(previous.asOfDate ?? '—');
  const category = product?.assetClass && product.assetClass !== 'ETF' ? product.assetClass : fund.category;
  const benchmark = product?.benchmark || fund.benchmark;
  const exchange = product?.exchange || fund.exchange || exchangeName || String(previous.exchange ?? '');
  const fundPage = cusip ? issuerFundUrl(ticker) : fund.fundPage;

  const meta: JsonRecord = {
    ticker,
    name,
    category,
    categoryPath: benchmark ? `${category} / ${benchmark}` : category,
    source: {
      fundPage,
      productData: issuerFundUrl(ticker),
      historicalData: `${ISSUER_API}/${ticker}/premium-discount-details`,
      holdingsDownload: issuerHoldingsUrl(ticker),
      pricesDownload: `${ISSUER_API}/${ticker}/premium-discount-details`,
      yahooChart: `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}`,
      holdingsSource,
      historySource: haveFreshHistory ? historySource : (((previous.source as JsonRecord)?.historySource as string) ?? 'previous run'),
      provider: 'Capital Group public fund facts and daily downloads + SEC EDGAR Form N-PORT-P (fallback) + Yahoo Finance public chart API (fallback)',
    },
    identifiers: { cusip: cusip || null, isin: product?.isin || fund.isin || null, indexTicker: benchmark || null },
    inception: {
      fundInceptionDate: inception,
      shareClassInceptionDate: product?.listingDate ?? null,
      exchange: exchange || null,
    },
    expenseRatio: {
      display: ter === null ? '—' : `${ter}%`,
      value: ter,
      gross: product?.grossExpense ?? null,
      net: product?.netExpense ?? null,
    },
    nav: { display: nav === null ? '—' : `$${nav.toFixed(2)}`, value: nav, asOfDate: asOfLabel },
    marketPrice: {
      display: price === null ? '—' : `$${price.toFixed(2)}`,
      value: price,
      asOfDate: product?.marketPriceDate ? formatEdgarDate(product.marketPriceDate) : asOfLabel,
    },
    premiumDiscount: { display: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`, value: premiumDiscount },
    aum: {
      display: netAssets === null ? '—' : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate:
        catalogNetAssets !== null && (product?.netAssetsDate || navAsOfDate)
          ? formatEdgarDate((product?.netAssetsDate || navAsOfDate) as string)
          : nportNetAssets !== null && holdingsEdgar?.repPdDate
            ? formatEdgarDate(holdingsEdgar.repPdDate)
            : (((previous.aum as JsonRecord)?.asOfDate as string) ?? '—'),
      source:
        catalogNetAssets !== null
          ? product?.netAssets !== null && product?.netAssets !== undefined
            ? 'capitalgroup.com daily fund facts net assets'
            : 'capitalgroup.com previous catalog net assets'
          : nportNetAssets !== null
            ? `SEC Form N-PORT-P net assets (report period ${holdingsEdgar?.repPdDate || 'n/a'})`
            : 'previous run',
    },
    yields: {
      dividendYield: metrics.dividendYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldKind:
        product?.dividendYield !== null && product?.dividendYield !== undefined
          ? `${product.dividendYieldKind}${product.dividendYieldDate ? `, as of ${formatEdgarDate(product.dividendYieldDate)}` : ''}`
          : metrics.dividendYield !== null
            ? 'indicated (latest distribution x payments per year / market price)'
            : 'not published: no distributions yet',
      distributionRate: fund.distributionRate,
      secYield: metrics.secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind:
        product?.secYield !== null && product?.secYield !== undefined
          ? `${product.secYieldKind}${product.secYieldDate ? `, as of ${formatEdgarDate(product.secYieldDate)}` : ''}`
          : secYield !== null
            ? '30-day SEC yield (month-end, capitalgroup.com fund explorer)'
            : 'not published by Capital Group for this fund',
      unsubsidizedSecYield: product?.unsubsidizedSecYield ?? null,
    },
    returns: returnsData,
    distributions: {
      frequency: frequency.frequency,
      paymentsPerYear: frequency.paymentsPerYear,
      frequencyCode: product?.frequencyCode || null,
      headers: ['Ex-Date', 'Amount'],
      rows: distributions,
    },
    holdings: {
      ...holdingsManifest,
      asOfDate: holdingsAsOf,
      asOf: holdingsAsOf ? formatEdgarDate(holdingsAsOf) : '—',
      source: holdingsSource,
    },
    history: {
      ...historyManifest,
      asOf: haveFreshHistory && derived.asOfDate ? formatEdgarDate(derived.asOfDate) : (((previous.history as JsonRecord)?.asOf as string) ?? '—'),
      source: haveFreshHistory ? historySource : 'previous run',
    },
  };
  await writeIfChanged(new URL('meta.json', fundDir), retainUnavailable(meta, previousMeta));

  const monthEnd = ((returnsData as JsonRecord)?.monthEnd as JsonRecord) || {};
  return {
    ticker,
    name,
    category,
    fundPage,
    dataFile: `./funds/${ticker}/meta.json`,
    cusip: cusip || null,
    isin: product?.isin || fund.isin || null,
    ter: ter === null ? '—' : `${ter}%`,
    terValue: ter,
    nav: nav === null ? '—' : `$${nav.toFixed(2)}`,
    navValue: nav,
    aum: netAssets === null ? '—' : formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate: asOfLabel,
    inceptionDate: inception
      ? formatEdgarDate(inception)
      : firstTradeDate
        ? formatEpochDate(firstTradeDate)
        : (previous.inceptionDate || '—'),
    exchange,
    closePrice: price === null ? '—' : `$${price.toFixed(2)}`,
    closePriceValue: price,
    premiumDiscount: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`,
    premiumDiscountValue: premiumDiscount,
    distributions: {
      frequency: frequency.frequency,
      exDate: latestDividend ? formatUsDate(latestDividend.epoch) : '—',
      dividend: latestDividend ? String(round(latestDividend.amount, 6)) : '—',
    },
    returns: { monthEnd, quarterEnd: ((returnsData as JsonRecord)?.quarterEnd as JsonRecord) || null },
    metrics,
    holdings: holdingsRows.length,
    history: history.length,
  };
}

const cikByTicker = new Map<string, string | null>();

// Lazily fetched, cached-per-run SEC lookup tables.
let fundTickerMap: Map<string, SecSeriesRef> | null = null;
let companyTickerMap: Map<string, string> | null = null;

async function loadFundTickerMap(config: UpdaterConfig): Promise<Map<string, SecSeriesRef>> {
  if (fundTickerMap) return fundTickerMap;
  try {
    const payload = await fetchJson(SEC_FUND_TICKERS_URL, '[edgar   ] fund ticker table', secHeaders(config), config);
    fundTickerMap = parseFundTickerMap(payload);
    outputNote(`[ edgar    ] SEC fund ticker table: ${fundTickerMap.size} ETF / mutual-fund share classes`);
  } catch (error) {
    console.warn(`[ edgar    ] fund ticker table: ${errorMessage(error)} — falling back to full-text search`);
    fundTickerMap = new Map<string, SecSeriesRef>();
  }
  return fundTickerMap;
}

async function loadCompanyTickerMap(config: UpdaterConfig): Promise<Map<string, string>> {
  if (companyTickerMap) return companyTickerMap;
  try {
    const payload = await fetchJson(SEC_COMPANY_TICKERS_URL, '[ edgar    ] company ticker table', secHeaders(config), config);
    companyTickerMap = parseCompanyTickerMap(payload);
    outputNote(`[ edgar    ] SEC company ticker table: ${companyTickerMap.size} issuer names`);
  } catch (error) {
    console.warn(`[ edgar    ] company ticker table: ${errorMessage(error)} — N-PORT tickers stay "-"`);
    companyTickerMap = new Map<string, string>();
  }
  return companyTickerMap;
}

// N-PORT positions carry CUSIP/ISIN but never a ticker; the SEC company table
// turns the filed issuer name back into an exchange symbol so the watchlist
// export stays usable, exactly like the sibling Fidelity updater.
function fillNportTickers(rows: NportHolding[], names: Map<string, string>): NportHolding[] {
  if (!names.size) return rows;
  return rows.map((row) => {
    if (cleanHoldingTicker(row.Ticker)) return row;
    const name = String(row.Name ?? '');
    const ticker = names.get(normalizeHoldingName(name)) || names.get(normalizeHoldingNameCore(name)) || '';
    return ticker ? { ...row, Ticker: ticker } : row;
  });
}

async function resolveRegistrantCik(fund: CatalogFund, config: UpdaterConfig): Promise<string | null> {
  if (cikByTicker.has(fund.ticker)) return cikByTicker.get(fund.ticker) as string | null;
  let cik: string | null = fund.trustCik || null;
  if (!cik) {
    const table = await loadFundTickerMap(config);
    cik = table.get(fund.ticker)?.cik || null;
  }
  if (!cik) {
    try {
      const payload = await fetchJson(eftsSearchUrl(fund.ticker), `[edgar   ] search ${fund.ticker}`, secHeaders(config), config);
      cik = pickEftsCik(payload, fund.name);
    } catch (error) {
      outputNote(`[ edgar    ] search ${fund.ticker}: ${errorMessage(error)}`);
    }
  }
  cikByTicker.set(fund.ticker, cik);
  return cik;
}

// The fund's own newest N-PORT-P filing. The SEC series id gives an exact,
// one-request answer (browse-edgar Atom, filtered to that series); scanning the
// whole registrant's submissions is the fallback when the series is unknown.
async function resolveNportFiling(
  fund: CatalogFund,
  config: UpdaterConfig,
): Promise<{ accession: NportAccession; cik: string; seriesId: string } | null> {
  const table = await loadFundTickerMap(config);
  const ref = table.get(fund.ticker) || null;
  if (ref?.seriesId) {
    try {
      const atom = await fetchText(edgarSeriesFilingsUrl(ref.seriesId), `[edgar   ] ${fund.ticker} series ${ref.seriesId}`, secHeaders(config), config);
      const [newest] = parseEdgarAtomFilings(atom);
      if (newest) return { accession: newest, cik: ref.cik, seriesId: ref.seriesId };
    } catch (error) {
      outputNote(`[ edgar    ] ${fund.ticker} series ${ref.seriesId}: ${errorMessage(error)} — scanning registrant submissions`);
    }
  }
  const cik = ref?.cik || (await resolveRegistrantCik(fund, config));
  if (!cik) return null;
  try {
    const submissions = await fetchJson(`${SEC_DATA_HOST}/submissions/CIK${cik.padStart(10, '0')}.json`, `[edgar   ] ${cik} submissions`, secHeaders(config), config);
    const [newest] = parseNportAccessions(submissions);
    if (newest) return { accession: newest, cik, seriesId: ref?.seriesId || '' };
  } catch (error) {
    outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(error)}`);
  }
  return null;
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// File defaults and explicit overrides. Allowlisted scalar values only: the
// same resolver is used by Actions without interpolating user input into bash.
// Precedence: config file < advanced JSON < nonblank inputs < environment (an
// explicitly set variable wins even when empty and clears the control).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'TICKERS',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'HISTORY_RANGE', 'STORE_RAW_DOWNLOADS',
  'CATALOG_URL', 'SEC_UA', 'SKIP_YAHOO', 'SKIP_ISSUER', 'EDGAR_FALLBACK', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
// Brand aliases kept from earlier releases; CAPITAL_GROUP_<NAME> is accepted for every control.
const ENV_ALIASES: Partial<Record<ControlName, string[]>> = { MAX_FETCHES: ['CAPITAL_GROUP_LIMIT'], HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'] };

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const name = [`CAPITAL_GROUP_${key}`, key, ...(ENV_ALIASES[key] ?? [])].find((candidate) => env[candidate] !== undefined);
    if (name !== undefined) apply({ [key]: env[name] });
  }
  parseBoolean(result.VERBOSE ?? '', 'VERBOSE');
  readConfig(result); // strict validation of every control before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

async function main(): Promise<void> {
  const controls = await runtimeControls(process.env);
  if (controls.VERBOSE !== undefined) process.env.VERBOSE = controls.VERBOSE;
  const config = readConfig(controls);
  installSystemCa(config.useSystemCa);
  await mkdir(API_ROOT, { recursive: true });
  const requestSleepMs = Math.max(0, config.requestSleep) * 1000;
  discoveryGate = createRequestGate(requestSleepMs);
  outputPrintConfig('Capital Group', config);
  console.log('');
  const catalog = new Map<string, CatalogFund>();
  const previousIndex = await readPreviousIndex();
  for (const [ticker, row] of previousIndex) catalog.set(ticker, catalogFundFromIndex(ticker, row));
  let catalogSource = 'previous published index';
  if (!config.skipIssuer) {
    try {
      const html = await (await issuerFetch(config.catalogUrl, config)).text();
      for (const ticker of parseIssuerCatalog(html)) {
        const fund = catalogFundFromIndex(ticker, previousIndex.get(ticker) || {});
        fund.fundPage = issuerFundUrl(ticker);
        catalog.set(ticker, fund);
      }
      catalogSource = 'Capital Group official ETF catalog HTML';
    } catch (error) { console.warn(`[ catalog  ] ${errorMessage(error)} — retained published catalog`); }
  }
  const unknown = config.tickers.filter(ticker => !catalog.has(ticker));
  if (unknown.length) throw new Error(`Requested tickers absent from catalog: ${unknown.join(' ')}`);
  const universe = [...catalog.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  if (!universe.length) throw new Error('No verified issuer catalog or published seed available');
  console.log(`[ catalog  ] ${universe.length} Capital Group ETFs (${catalogSource})`);

  // 2) Bounded, resumable batch run over the catalog (iShares/SPDR cursor).
  const state = await readUpdateState();
  // A plain `bun ./scripts/update-data.ts` (no MAX_FETCHES) always walks the
  // whole catalog from the top and clears the cursor afterwards; the saved
  // cursor only rotates the queue for explicitly bounded batch runs, exactly
  // like the sibling SPDR / iShares updaters.
  const cursor = config.maxFetches > 0 ? state?.cursor || null : null;
  const cursorIndex = cursor ? universe.findIndex((fund) => fund.ticker === cursor) : -1;
  const ordered =
    cursorIndex >= 0
      ? universe.slice(cursorIndex + 1).concat(universe.slice(0, cursorIndex + 1))
      : universe.slice();

  const selected = ordered.filter(fund => !config.tickers.length || config.tickers.includes(fund.ticker));
  const queue = selected.map((fund) => ({ fund }));
  const results: JsonRecord[] = [];
  let processed = 0;
  let lastProcessedTicker: string | null = cursor;
  let failures = 0;

  outputPrintFilter(selected.length, universe.length, outputHasOutputFilters(config));
  const output = outputCreateReporter(API_ROOT, config.maxFetches > 0 ? Math.min(config.maxFetches, selected.length) : selected.length);
  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (config.maxFetches > 0 && processed >= config.maxFetches) return;
      processed += 1;
      const before = await output.before(item.fund.ticker);
      try {
        const row = await processFund(item.fund, config, previousIndex.get(item.fund.ticker) || {});
        if (row) {
          results.push(sourceObject(retainUnavailable(row, previousIndex.get(item.fund.ticker))));
          lastProcessedTicker = item.fund.ticker;
        }
        await output.result(item.fund.ticker, before, row ? undefined : 'skipped');
      } catch (error) {
        failures += 1;
        await output.result(item.fund.ticker, before, 'failed', String(error));
      }
      if (config.maxFetches > 0 && processed >= config.maxFetches) {
        console.log(`[ cursor   ] batch of ${config.maxFetches} reached — rerun to continue after ${lastProcessedTicker}`);
        return;
      }
    }
  }

  const workerCount = Math.min(config.concurrency, selected.length, config.maxFetches || selected.length);
  await Promise.all(Array.from({ length: workerCount }, () => withRequestLane(requestSleepMs, worker)));

  // Funds not selected for a successful update keep their previously published rows.
  const keptFromPrevious = universe
    .filter((fund) => !results.some((row) => row.ticker === fund.ticker))
    .map((fund) => previousIndex.get(fund.ticker))
    .filter(Boolean) as JsonRecord[];
  const funds = [...results, ...keptFromPrevious].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + (numberOrNull(fund.holdings) || 0), 0),
    history: funds.reduce((sum, fund) => sum + (numberOrNull(fund.history) || 0), 0),
  };

  if (results.length || !previousIndex.size) await writeIfChanged(INDEX_FILE, {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { provider: 'Capital Group official ETF catalog, fund facts, daily holdings XLSX and daily NAV/distributions JSON; SEC EDGAR and Yahoo fallbacks',
      site: ISSUER_SITE, catalog: ISSUER_CATALOG, catalogDownload: config.catalogUrl },
    counts,
    funds,
  });

  // Full passes reset the cursor: the next run starts from the top again.
  await writeUpdateState(config.maxFetches > 0 ? lastProcessedTicker : null);

  console.log('');
  console.log(`[ done     ] ${results.length} funds updated, ${keptFromPrevious.length} kept from previous runs, ${failures} failures`);
  console.log(`[ done     ] counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows`);
  console.log(
    `[ cursor   ] ${config.maxFetches > 0 && lastProcessedTicker ? `next run continues after ${lastProcessedTicker}` : 'full pass complete (cursor reset)'}`,
  );

  if (failures) process.exitCode = 1;
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Capital Group data update\n\n- updated: ${results.length}\n- kept from previous runs: ${keptFromPrevious.length}\n- failed: ${failures}\n- counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows\n`,
      'utf8',
    );
  }
}

async function yahooSearchForTicker(name: string, config: UpdaterConfig): Promise<string | null> {
  const payload = await fetchJson(yahooSearchUrl(name), `[ticker  ] ${name}`, yahooHeaders(), config);
  return pickSearchTicker(name, payload);
}

function catalogFundFromIndex(ticker: string, row: JsonRecord): CatalogFund {
  const metrics = (row.metrics as JsonRecord) || {};
  const monthEnd = ((row.returns as JsonRecord)?.monthEnd as JsonRecord) || {};
  const quarterEnd = ((row.returns as JsonRecord)?.quarterEnd as JsonRecord) || {};
  const cusip = String(row.cusip ?? '').toUpperCase();
  const name = String(row.name ?? ticker);
  return {
    ticker,
    name,
    category: String(row.category ?? 'ETF'),
    categoryPath: String(row.category ?? 'ETF'),
    inception: null,
    exchange: String(row.exchange ?? ''),
    cusip,
    isin: String(row.isin ?? '').toUpperCase(),
    benchmark: '',
    ter: numberOrNull(row.terValue),
    nav: numberOrNull(row.navValue),
    close: numberOrNull(row.closePriceValue),
    premiumDiscount: numberOrNull(row.premiumDiscountValue),
    netAssets: numberOrNull(row.aumValue),
    dividendYield: numberOrNull(metrics.dividendYield),
    secYield: numberOrNull(metrics.secYield),
    distributionRate: null,
    asOfDate: null,
    returns: {
      ytd: numberOrNull(monthEnd.ytd),
      yr1: numberOrNull(monthEnd.yr1),
      yr3: numberOrNull(monthEnd.yr3),
      yr5: numberOrNull(monthEnd.yr5),
      yr10: numberOrNull(monthEnd.yr10),
      sinceInception: numberOrNull(monthEnd.sinceInception),
    },
    returnsAsOfDate: null,
    mo1: numberOrNull(monthEnd.mo1),
    marketReturns: { ...EMPTY_RETURNS },
    quarterEnd: {
      ytd: numberOrNull(quarterEnd.ytd),
      yr1: numberOrNull(quarterEnd.yr1),
      yr3: numberOrNull(quarterEnd.yr3),
      yr5: numberOrNull(quarterEnd.yr5),
      yr10: numberOrNull(quarterEnd.yr10),
      sinceInception: numberOrNull(quarterEnd.sinceInception),
    },
    quarterEndAsOfDate: null,
    fundPage: String(row.fundPage ?? issuerFundUrl(ticker)),
    trustCik: null,
    source: 'previous index',
  };
}

// ---------------------------------------------------------------------------
// Entry point (kept at the end: main() relies on the let bindings above)
// ---------------------------------------------------------------------------

if ((import.meta as { main?: boolean }).main) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(USAGE.trim());
    outputPrintConfig('Capital Group effective configuration', readConfig(await runtimeControls(process.env)));
  } else {
    await main().catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  }
}
