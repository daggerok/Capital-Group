# Independent worker pacing — verification

The implementation replaces the shared request-start queue with a per-worker
monotonic timer and small reservation queue. Built-in `AsyncLocalStorage` carries
that lane through issuer requests, retries, redirects and fallback calls. Lanes
persist across funds. Discovery/bootstrap remains sequential. No extra runtime
dependency, sleep-default reduction or financial-data/UI change.

## Real issuer comparison

Only CGUS, CGCP and CGMU were selected. These runs used independent workspace
copies, never the tracked production API directory. Baseline code: `cef1922`;
fixed code: `bf67ced`. Same seed, config and command:

```sh
TICKERS="CGUS CGCP CGMU" CONCURRENCY=15 REQUEST_SLEEP=3 VERBOSE=1 \
  bun --preload /absolute/path/to/measurement-preload.ts scripts/update-data.ts
```

The attached preload forwards real fetch unchanged; it only captures starts,
active-fetch counts, URLs, response statuses and timestamps. It never records
cookies, headers or bodies. It is **not** the offline synthetic test preload.

| Measurement | Before | After 1 | After 2 |
| --- | ---: | ---: | ---: |
| Total seconds | 43.2682 | 16.6235 | 16.9322 |
| First completed fund, seconds | 37.0910 | 16.3418 | 16.5000 |
| First fund request spread, milliseconds | 6003.266 | 16.567 | 16.516 |
| Peak in-flight fetches | 1 | 3 | 3 |
| Minimum same-fund gap, approximately | 9 seconds | 3 seconds | 3 seconds |
| Successful exit | 0 | 0 | 0 |
| Unchanged JSON files | 28/28 | 28/28 | 28/28 |

Each run issued 15 requests: 3 catalog/bootstrap requests, then 4 per fund.
HTTP statuses: one ordinary bootstrap 302 and fourteen 200s. No fallbacks were
needed. All file hashes match the seed and each other. No production refresh.

Measured speedup: **2.60× / 2.56×** with only **three active workers**, despite the
configured ceiling of 15. This is not a 25-fund benchmark or a promise of 15×
speedup. Provider throttling and network latency still affect runtime.

Raw records: `live-before.*`, `live-after-1.*`, `live-after-2.*`.
Each JSON contains elapsed time, timestamped stdout and SHA-256 before/after
manifests. `*.requests.jsonl` contains sanitized request-level measurements.
Derived measurements are in `summary.json`.

## Regressions

`bun test`: **88 pass, 0 fail, 678 assertions** (`final-tests.log`).

- Deterministic early/late timers, same-lane reservations, zero sleep, failure recovery.
- 45 real loopback HTTP requests with 1, 3 and 15 independently paced workers.
  Peak in-flight requests equals worker count; throughput increases. Exact timings
  vary by run and are printed in the test log.
- Nonretryable 404 and retryable 429 do not stall unrelated lanes.
- Offline CLI: three synthetic fund fixtures, one issuer redirect, one 429 retry;
  concurrent starts and same-worker request spacing asserted. Its fixture rewriting
  is test-only and is never used for live verification or published API output.
- Isolated mutation replaces lanes with one global gate: throughput test fails
  as expected (`global-gate-mutation.log`). The production test suite is green.
- Frozen install, Bun build, whitespace check; manual type review, no tsc invoked.

The worklog records two test-development failures and their corrections,
including an unintended isolated three-fund real request run caused by importing
the CLI from a preload. That run is not counted as planned acceptance or offline
coverage. The final offline preload imports only `node:fs`; fixtures are prepared
in the parent test before starting the child CLI.

PR #1 remains open and unmerged. Target main and all sibling repositories were
left unchanged by this follow-up.
