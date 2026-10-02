# Capital Group

One of the app's features lets you select Capital Group ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/capital-group` static feed (Capital Group ETF catalog, per-fund server-rendered JSON, daily holdings XLSX and price/distribution JSON - official NAV returns, expenses, yields, complete daily holdings and whole-life NAV history - with SEC EDGAR N-PORT-P and Yahoo Finance as fallbacks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Capital-Group#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The application is live at <https://daggerok.github.io/Capital-Group/>

## Updating the static Capital Group data

Run the updater with Bun:

```bash
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts --help` to print every control with its default and usage examples.

Defaults live in [`scripts/update-data.config.json`](scripts/update-data.config.json) and every control accepts a `CAPITAL_GROUP_` prefix. Precedence, lowest to highest: file defaults < advanced JSON < nonblank workflow inputs < protected Actions variable (`SEC_UA`) or environment. An explicitly set environment variable wins even when empty and clears the control. Invalid values (unknown keys, non-scalars, multiline text, bad integers, booleans or ranges) are rejected before any request or write

The **Update Capital Group ETF data** GitHub Actions workflow runs weekly and exposes 24 individual inputs plus `advanced`, a JSON object for any other control. Blank inputs inherit the file defaults. All supplied filters use **AND** logic

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US Capital Group ETFs) | [Official ETF catalog](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html), currently 25 fund links |
| Fund facts | Server-rendered Next.js JSON in each [fund page](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds/details/cgus) (no browser execution) |
| Holdings per fund | `/api/investments/investment-service/v1/etfs/{TICKER}/download/daily-holdings?audience=advisor` on `www.capitalgroup.com` (full XLSX, parsed with built-in zlib) |
| Daily history, distributions | Same API base, `premium-discount-details?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD` and `historical-distributions?include=all` |
| Fallback | SEC EDGAR N-PORT-P for holdings, Yahoo Finance chart API for history; previously published data retained on provider failure |

The published feed covers all 25 catalog funds. SEC and Yahoo fallbacks are used only when the issuer data is unavailable

### Metrics and caveats

Official figures come from Capital Group: NAV returns, expense ratios, 30-day SEC yield, net assets and the daily NAV and market price history. Yahoo Finance data is used only as a fallback and is an estimate (adjusted close based), not an official NAV. Unavailable values are published as unavailable (`null` or `—`), never as `0`; a real zero is kept as zero. No tickers are excluded from the catalog

The issuer's first HTML request can redirect to a public cookie bootstrap; the updater repeats the request using an in-memory same-origin session. No credentials, cookies or entire HTML documents are stored. Some endpoints mentioned in issuer JavaScript return 404 directly; the implementation uses verified HTML payloads and working public downloads instead. The issuer currently repeats month-end data in `quarterlyReturns`; non-quarter-end dates are not mislabeled as quarter-end returns. Holdings weights are converted from fractions to percent without forcing them to sum to 100%; issuer rounding is preserved. Different funds have different registrant CIKs (CGUS `0001870102`; CGCP/CGMU `0001870117`); the SEC fallback resolves the fund's own series, not an arbitrary latest trust filing.

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - official YTD and 1-year returns -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - published annualized 3Y/5Y/10Y figures -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized -> *SI Ann.*
- `dividendYield` - indicated yield (latest distribution × frequency ÷ price)
- `secYield` - 30-day SEC yield when published; `—` otherwise
- `returnsBasis` - mandatory non-empty label of how the returns are computed: official Capital Group NAV total returns, or derived from the daily NAV history, or an estimate from Yahoo adjusted closes (mixed cases say which periods are estimates); never empty or `-`
- `performanceAsOf` - mandatory ISO `YYYY-MM-DD` date the returns are as of: the issuer performance table (month-end) date for official returns, the last price date of the derived series otherwise; it is not the NAV date, and is `null` only when truly unknown

### Update controls

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | Batch size: a positive value continues after the committed cursor in `api/capital-group/update-state.json`; `0` is a full pass over every selected fund |
| `REQUEST_SLEEP` | `3` | Minimum delay in seconds between outgoing request starts within each worker, including retries and issuer redirects |
| `CONCURRENCY` | `1` | Number of independently paced fund workers; there is no global request-start queue |
| `AUM` | `:` | Net assets range; each bound is a USD amount, a `K`/`M`/`B`/`T` amount or one of `nano`, `micro`, `small`, `mid`, `large` |
| `TER` | `:` | Expense ratio range in percent (`min:max`) |
| `DIVIDEND_YIELD` | `:` | Indicated dividend yield range in percent |
| `SEC_YIELD` | `:` | Published 30-day SEC yield range in percent |
| `TICKERS` | empty | Space, comma or semicolon separated ticker allowlist, for example `CGUS CGCP CGMU`; empty means all |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated holdings JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated history JSON page |
| `MAX_RETRIES` | `2` | Retries after the first request, integer of at least 1; 403, 408, 425, 429 and 5xx are retried with backoff, other issuer HTTP errors fail promptly |
| `HISTORY_RANGE` | `max` | Yahoo fallback chart window, `max` or `Ny` (for example `5y`); official history always covers inception onward |
| `PERFORMANCE_YTD`, `PERFORMANCE_1Y`, `PERFORMANCE_3Y`, `PERFORMANCE_5Y`, `PERFORMANCE_10Y` | `:` | NAV return ranges in percent, annualized for 3Y and longer |
| `TOTAL_RETURN_YTD`, `TOTAL_RETURN_1Y`, `TOTAL_RETURN_3Y`, `TOTAL_RETURN_5Y`, `TOTAL_RETURN_10Y` | `:` | Cumulative total return ranges in percent |
| `STORE_RAW_DOWNLOADS` | `false` | Keep financial JSON snapshots under each selected fund's `raw/`; never cookies or auth headers |
| `CATALOG_URL` | official catalog URL | Optional catalog mirror URL |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | User-Agent for SEC requests; redacted in config logs; the repository Actions variable `SEC_UA` overrides it when nonblank |
| `SKIP_YAHOO` | `false` | Skip Yahoo Finance history and dividends; keep published data |
| `SKIP_ISSUER` | `false` | Use the published catalog and only fallbacks; never delete cached data |
| `EDGAR_FALLBACK` | `true` | Enable the fund-specific SEC N-PORT holdings fallback |
| `VERBOSE` | `false` | Show per-provider fallback and retry diagnostics |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |

Catalog discovery runs before fund workers start. `CONCURRENCY=15 REQUEST_SLEEP=3` permits up to 15 independently paced workers, not one global request every three seconds; actual throughput still depends on network latency and provider throttling. Not individually exposed as workflow inputs, but reachable through `advanced` JSON: `CATALOG_URL`, `SEC_UA`, `SKIP_ISSUER`, `STORE_RAW_DOWNLOADS`, `VERBOSE` and `USE_SYSTEM_CA`

`TICKERS` combines with the other filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files

### Examples

```bash
MAX_FETCHES=10 bun scripts/update-data.ts
TICKERS="CGUS CGCP CGMU" bun scripts/update-data.ts
AUM="1B:" TER=":0.5" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
```

Workflow `advanced` input example: `{"TICKERS":"","VERBOSE":true}`

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` also covers the parsers, the control resolver, README and `--help` parity and the workflow shape

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT](./LICENSE) - same as all sibling ETF repositories

Capital Group® and American Funds® and the fund names/tickers referenced here are trademarks of The Capital Group Companies, Inc. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Capital Group. All data is reproduced from Capital Group's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
