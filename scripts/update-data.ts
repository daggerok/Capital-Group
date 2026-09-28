#!/usr/bin/env bun
/// <reference types="bun" />
import { inflateRawSync } from 'node:zlib';

// Capital Group issuer adapter. CLI integration is the next checkpoint.
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
