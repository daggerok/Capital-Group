# Capital Group

One of the app's features lets you select Capital Group ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/capital-group` static feed (Capital Group ETF catalog, per-fund server-rendered JSON, daily holdings XLSX and price/distribution JSON — official NAV returns, expenses, yields, complete daily holdings and whole-life NAV history — with SEC EDGAR N-PORT-P and Yahoo Finance as fallbacks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Capital-Group#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The intended application URL is <https://daggerok.github.io/Capital-Group/>. Deployment is pending: this implementation is on a feature branch and its PR must not be merged without approval.

## Updating the static Capital Group data

Run the updater with Bun:

```bash
bun test
./scripts/update-data.ts
```

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples.

The **Update Capital Group ETF data** GitHub Actions workflow exposes the same settings as manual inputs. All supplied filters use **AND** logic.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US Capital Group ETFs) | [Official ETF catalog](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html), currently 25 fund links |
| Fund facts | Server-rendered Next.js JSON in each [fund page](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds/details/cgus) (no browser execution) |
| Holdings per fund | `/api/investments/investment-service/v1/etfs/{TICKER}/download/daily-holdings?audience=advisor` on `www.capitalgroup.com` (full XLSX, parsed with built-in zlib) |
| Daily history, distributions | Same API base, `premium-discount-details?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD` and `historical-distributions?include=all` |
| Fallback | SEC EDGAR N-PORT-P for holdings, Yahoo Finance chart API for history; previously published data retained on provider failure |

The initial published seed contains **CGUS, CGCP and CGMU only**, not all 25 catalog funds. Two isolated real CLI runs verified all three and all 28 output JSON files were byte-identical on the repeat; see [acceptance evidence](evidence/live/acceptance.txt). No full refresh was run. SEC/Yahoo fallbacks were not needed in these runs, so their live reachability is not claimed.

The issuer's first HTML request can redirect to a public cookie bootstrap; the updater repeats the request using an in-memory same-origin session. No credentials, cookies or entire HTML documents are stored. Some endpoints mentioned in issuer JavaScript return 404 directly; the implementation uses verified HTML payloads and working public downloads instead. The issuer currently repeats month-end data in `quarterlyReturns`; non-quarter-end dates are not mislabeled as quarter-end returns. Holdings weights are converted from fractions to percent without forcing them to sum to 100%; issuer rounding is preserved. Different funds have different registrant CIKs (CGUS `0001870102`; CGCP/CGMU `0001870117`); the SEC fallback resolves the fund's own series, not an arbitrary latest trust filing.

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` — official YTD and 1-year returns → *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` — published annualized 3Y/5Y/10Y figures → *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` — cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` → *TR 3Y/5Y/10Y*
- `siAnn` — since-inception annualized → *SI Ann.*
- `dividendYield` — indicated yield (latest distribution × frequency ÷ price)
- `secYield` — 30-day SEC yield when published; `—` otherwise

### Update controls

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | all | Batch size: with a positive value the updater continues after the committed cursor in `api/capital-group/update-state.json`; empty or `0` is a full pass — every fund is refreshed in one run. |
| `REQUEST_SLEEP` | `3` | Minimum delay in seconds between outgoing request starts **within each worker**, including retries and issuer redirects. |
| `CONCURRENCY` | `1` | Number of independently paced fund update workers. Different workers can start requests simultaneously; there is no global request-start queue. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large`. |
| `TER` | `:` | Expense ratio range in % (strict `min:max`). |
| `DIVIDEND_YIELD` | `:` | Dividend-yield percentage range. |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `CGUS CGCP CGMU`. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page. |
| `MAX_RETRIES` | `2` | Retries after the initial request. Transient failures are retried with backoff; 403/408/429/5xx are retryable. Other issuer HTTP errors fail promptly. |
| `SEC_UA` | declared UA | Override the SEC User-Agent. SEC policy requires automated tools to declare a contact. |
| `SKIP_YAHOO` | off | Skip Yahoo Finance history updates. |
| `SKIP_ISSUER` | off | Use the published catalog and only fallbacks; never delete cached data. |
| `EDGAR_FALLBACK` | on | Enable fund-specific SEC N-PORT holdings fallback. |
| `SEC_YIELD` | `:` | Published SEC-yield range in %. |
| `PERFORMANCE_YTD`, `PERFORMANCE_1Y`, `PERFORMANCE_3Y`, `PERFORMANCE_5Y`, `PERFORMANCE_10Y` | `:` | NAV return ranges; 3Y/5Y/10Y annualized. |
| `TOTAL_RETURN_YTD`, `TOTAL_RETURN_1Y`, `TOTAL_RETURN_3Y`, `TOTAL_RETURN_5Y`, `TOTAL_RETURN_10Y` | `:` | Cumulative total-return ranges. |
| `HISTORY_RANGE` | `max` | Yahoo fallback chart range; official history covers inception onward. |
| `STORE_RAW_DOWNLOADS` | off | Keep financial JSON snapshots under each selected fund's `raw/`; never cookies/auth headers. |
| `CATALOG_URL` | official catalog URL above | Optional catalog mirror URL. |
| `VERBOSE` | off | Show per-provider fallback/retry diagnostics. |

Catalog discovery/bootstrap runs before fund workers start. Active workers are bounded by the selected fund count and `MAX_FETCHES`, when set. `CONCURRENCY=15 REQUEST_SLEEP=3` permits up to 15 independently paced workers, not one global request every three seconds; actual throughput still depends on network latency and provider throttling.

Defaults are versioned in [`scripts/update-data.config.json`](scripts/update-data.config.json). Explicit CLI environment values (including empty ticker lists and `0`/`false`) override the file; `CAPITAL_GROUP_` aliases take precedence over unprefixed names.

Actions uses the same configuration resolver as [aberdeen](https://github.com/daggerok/aberdeen): **file defaults → advanced JSON → individual nonblank inputs**. The 24 individual fields are optional and blank means inherit. The 25th field, `advanced`, accepts any canonical control (for example `{"TICKERS":"","VERBOSE":true,"SEC_UA":"Your operator/contact"}`). Use explicit empty `TICKERS` in advanced JSON to clear a file allowlist. Unknown keys, non-scalar values, multiline values and invalid controls are rejected before networking. Source-specific controls `CATALOG_URL`, `SKIP_ISSUER`, `STORE_RAW_DOWNLOADS`, `SEC_UA` and `VERBOSE` are available through `advanced`.

Controls also accept the `CAPITAL_GROUP_` prefix. `SEC_UA` should identify your operator/contact for production SEC requests.

`TICKERS` combines with AUM, TER, yield filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Examples

```bash
MAX_FETCHES=10 ./scripts/update-data.ts
TICKERS="CGUS CGCP CGMU" ./scripts/update-data.ts
AUM="1B:" TER=":0.5" ./scripts/update-data.ts
PERFORMANCE_1Y="15:" ./scripts/update-data.ts
```

## TypeScript

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone — no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish: `bun install --frozen-lockfile`, `bun test`, and `git diff --check`.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs (Firestore data feed) | [Amplify](https://github.com/daggerok/Amplify) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |

## License

[MIT — same as all sibling ETF repositories.](./LICENSE)

Capital Group® and American Funds® and the fund names/tickers referenced here are trademarks of The Capital Group Companies, Inc. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Capital Group. All data is reproduced from Capital Group's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
