/// <reference types="bun" />
// OFFLINE CLI regression only. Synthetic multi-ticker responses are never live
// acceptance inputs or published API data. Uses only Bun / built-in modules.
import { appendFileSync } from 'node:fs';
const tickers = ['CGUS', 'CGCP', 'CGMU'];
const file = (name: string) => Bun.file(new URL(name, import.meta.url));
let active = 0, retried = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input), ticker = tickers.find(t => url.toUpperCase().includes(t)) ?? 'catalog';
  appendFileSync('offline-trace.jsonl', JSON.stringify({ticker, url, at: performance.now(), active: ++active}) + '\n');
  try {
    await Bun.sleep(25); // In-flight overlap observable without real internet.
    if (url.endsWith('exchange-traded-funds.html')) return new Response(tickers.map(t => `<a href="/advisor/investments/exchange-traded-funds/details/${t.toLowerCase()}">${t}</a>`).join(''));
    if (ticker === 'catalog') throw new Error('Unexpected provider outside offline fixture: ' + url);
    if (url.includes('/details/')) {
      if (ticker === 'CGCP' && !url.includes('?redirected')) return new Response(null, {status:302, headers:{Location:url+'?redirected'}});
      const data = await file(ticker.toLowerCase() + '-facts.json').json();
      return new Response('<script>self.__next_f.push(' + JSON.stringify([1, '6:{"data":' + JSON.stringify(data) + '}']) + ')</script>');
    }
    if (url.includes('/download/')) return new Response(await file(ticker + '-offline-holdings.xlsx').arrayBuffer());
    if (url.includes('/historical-distributions')) {
      if (ticker === 'CGMU' && !retried) { retried = true; return new Response('offline retry fixture', {status:429}); }
      return new Response(await file('cgus-distributions.json').text());
    }
    if (url.includes('/premium-discount-details')) {
      const data = await file('cgus-prices.json').json(); data.quotron = ticker;
      return Response.json(data);
    }
    throw new Error('Unexpected offline request: ' + url);
  } finally { active--; }
}) as typeof fetch;
