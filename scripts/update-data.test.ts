/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { issuerFrequency, issuerPricesUrl, parseIssuerCatalog, parseIssuerDistributions, parseIssuerFacts, parseIssuerFlight, parseIssuerHoldings, parseIssuerPrices, parseIssuerReturns, sourceDate, sourceNumber, unzipIssuerWorkbook, workbookRows } from './update-data';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('issuer source parsers', () => {
  test('strict dates and numbers retain zero and negatives, reject missing', () => {
    expect([null, undefined, '', '—', '--', 'abc'].map(sourceNumber)).toEqual([null, null, null, null, null, null]);
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
    const data = fixture('cgus-facts'); data.details.summaryDescription = 'Escaped } ] " \\ text';
    const stream = `6:[["$","$L",null,{"data":${JSON.stringify(data)}}]]`;
    const html = [stream.slice(0, 77), stream.slice(77)].map(text => `<script>self.__next_f.push(${JSON.stringify([1, text])})</script>`).join('');
    expect(parseIssuerFlight(html, 'CGUS')).toEqual(data);
    expect(() => parseIssuerFlight(html, 'CGCP')).toThrow('missing');
    expect(() => parseIssuerFlight('<script>alert(1)</script>', 'CGUS')).toThrow();
  });
  test.each(['cgus', 'cgcp', 'cgmu'])('dated actual %s facts preserve CIK/units', (name) => {
    const result = parseIssuerFacts(fixture(`${name}-facts`), name.toUpperCase());
    expect(result.name).toContain('Capital Group'); expect(result.netAssets).toBeGreaterThan(1e8);
    expect(result.trustCik).toBe(name === 'cgus' ? '0001870102' : '0001870117');
    expect(result.quarterEnd.asOfDate).toBeNull(); // issuer currently duplicates August month-end
    expect(result.frequency.paymentsPerYear).toBe(name === 'cgus' ? 4 : 12);
  });
  test('returns mapping every tenor; reordered, zero, negative, missing and unknown values', () => {
    const row = { navYear10: '-4', unknown: '999', asOfDate: '08/31/2026', navLifetime: '5', navYtdMonthly: '0', navYear1: '1', navMonth1: '-1', navYear5: '3', navYear3: '2' };
    expect(parseIssuerReturns(row)).toEqual({ asOfDate: '2026-08-31', mo1: -1, ytd: 0, yr1: 1, yr3: 2, yr5: 3, yr10: -4, sinceInception: 5 });
    expect(parseIssuerReturns({ navYear3: null, navYear1: '' }).yr1).toBeNull();
    expect(parseIssuerReturns({ marketPriceYear1: '2' }, 'marketPrice').yr1).toBe(2);
    expect(issuerFrequency('Unrecognized')).toEqual({ frequency: 'Unknown', paymentsPerYear: null });
    expect(issuerFrequency(null).paymentsPerYear).toBeNull();
  });
  test('real XLSX holdings: fractions, CUSIP leading zeros, stable sort', () => {
    const b = readFileSync(new URL('fixtures/cgus-holdings.xlsx', import.meta.url));
    const parsed = parseIssuerHoldings(b, 'CGUS');
    expect(parsed.asOfDate).toBe('2026-09-24'); expect(parsed.rows.length).toBeGreaterThan(65);
    expect(parsed.rows[0].Ticker).toBe('NVDA'); expect(parsed.rows[0].Weight).toBe('7.62');
    expect(parsed.rows.find(r => r.Ticker === 'AMZN')?.Identifier).toBe('023135106');
    expect(parsed.rows.find(r => r.Ticker === 'MSFT')?.Identifier).toBe('594918104');
    expect(parseIssuerHoldings(b, 'CGUS')).toEqual(parsed);
    expect(() => parseIssuerHoldings(b, 'CGCP')).toThrow('mismatch');
    expect(() => unzipIssuerWorkbook(b.subarray(0, 100))).toThrow();
  });
  test('OOXML sparse columns, shared strings, inline strings and XML entities', () => {
    const files = new Map([['xl/sharedStrings.xml', '<sst><si><t>A &amp; B</t></si></sst>'], ['xl/worksheets/sheet2.xml', '<worksheet><row r="1"><c r="C1" t="s"><v>0</v></c><c r="E1" t="inlineStr"><is><t>Equity</t></is></c><c r="F1"><v>0</v></c></row></worksheet>']]);
    expect(workbookRows(files)[0][0][2]).toBe('A & B'); expect(workbookRows(files)[0][0][4]).toBe('Equity'); expect(workbookRows(files)[0][0][5]).toBe('0');
  });
  test('daily prices and all distributions from real JSON', () => {
    const points = parseIssuerPrices(fixture('cgus-prices'), 'CGUS');
    expect(points.length).toBe(5); expect(points[0]).toEqual({ date: '2022-02-22', nav: 24.63, marketPrice: 24.63, premiumDiscount: null });
    expect(parseIssuerPrices({ quotron: 'CGUS', premiumDiscountDetails: [{ values: null }] }, 'CGUS')).toEqual([]);
    expect(() => parseIssuerPrices(fixture('cgus-prices'), 'CGCP')).toThrow('mismatch');
    const d = parseIssuerDistributions(fixture('cgus-distributions'));
    expect(d[0].exDate).toBe('2022-03-30'); expect(d[0].amount).toBe(0.0287); expect(d.length).toBeGreaterThan(12);
    expect(parseIssuerDistributions({ distributions: [{ exDate: '1/1/26', totalDistributions: '0' }] })[0].amount).toBe(0);
    expect(() => parseIssuerDistributions({})).toThrow();
    expect(issuerPricesUrl('CGUS', '2022-02-22', '2026-09-27')).toContain('fromDate=2022-02-22');
    expect(() => issuerPricesUrl('CGUS', '', '')).toThrow();
  });
});
