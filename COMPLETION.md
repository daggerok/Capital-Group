# Capital Group — completion report

## Main pull request

[Capital-Group #1](https://github.com/daggerok/Capital-Group/pull/1) is **open, not merged**. Main is unchanged. Existing Pages still serves the placeholder; the ETF app is available in the workspace preview and feature branch.

## Delivered

- Capital Group updater with official catalog/facts, full XLSX holdings and daily JSON NAV/distributions; SEC/Yahoo/cache fallbacks.
- Configuration and CI mirror **aberdeen@0c390af**: JSON defaults, shared allowlisted resolver, 24 optional fields plus `advanced`.
- UI and common README content copied from **JPMorgan@998cebd9**, with recorded permitted substitutions.
- Initial API seed: **CGUS, CGCP, CGMU only**; no full-catalog run.
- About/homepage/topics updated and verified.

## Validation

- **82 tests pass**, 380 assertions; Bun build and whitespace checks pass.
- Four actual scoped CLI runs: two before config migration, two after; **28 JSON files byte-identical** on repeats and to the published seed.
- **4,129 holdings rows, 3,289 history rows**.
- Actual browser checks cover selection, header/source panel, keyboard/Escape, touch/mobile, blacklist/clear and N-PORT upload.
- No semantic TypeScript compiler/IDE validation claimed. SEC/Yahoo fallbacks were not needed live; offline tests cover them. GitHub scheduled updater execution remains pending deployment.

## Source findings

The apparently empty issuer page is a public cookie bootstrap, not proof that a browser scraper is needed. Repeat ordinary HTTP requests with an in-memory session expose server-rendered data. Some JS-mentioned APIs return 404 directly; the implemented XLSX/JSON endpoints were actually fetched and checked. Non-quarter-end data in the issuer's quarterly block is not mislabeled as quarter-end performance.

## Authorized sibling rollout

All 17 PRs are merged. Each changes only README.md: two additions, zero deletions. No sibling code/data/CI changes.

| Repository | PR | State |
|---|---|---|
| aberdeen | [#4](https://github.com/daggerok/aberdeen/pull/4) | Merged |
| Amplify | [#48](https://github.com/daggerok/Amplify/pull/48) | Merged |
| Fidelity | [#23](https://github.com/daggerok/Fidelity/pull/23) | Merged |
| Franklin | [#22](https://github.com/daggerok/Franklin/pull/22) | Merged |
| Global-X | [#9](https://github.com/daggerok/Global-X/pull/9) | Merged |
| Goldman-Sachs | [#18](https://github.com/daggerok/Goldman-Sachs/pull/18) | Merged |
| Invesco | [#24](https://github.com/daggerok/Invesco/pull/24) | Merged |
| iShares | [#49](https://github.com/daggerok/iShares/pull/49) | Merged |
| JPMorgan | [#21](https://github.com/daggerok/JPMorgan/pull/21) | Merged |
| Neos | [#19](https://github.com/daggerok/Neos/pull/19) | Merged |
| Northern-Trust | [#2](https://github.com/daggerok/Northern-Trust/pull/2) | Merged |
| ProShares | [#21](https://github.com/daggerok/ProShares/pull/21) | Merged |
| Schwab | [#17](https://github.com/daggerok/Schwab/pull/17) | Merged |
| SPDR | [#34](https://github.com/daggerok/SPDR/pull/34) | Merged |
| VanEck | [#20](https://github.com/daggerok/VanEck/pull/20) | Merged |
| Vanguard | [#30](https://github.com/daggerok/Vanguard/pull/30) | Merged |
| WisdomTree | [#30](https://github.com/daggerok/WisdomTree/pull/30) | Merged |

## Recovery

Read `.worklog.txt` completely, restore the public origin URL if the workspace snapshot omitted Git config, fetch, and reconcile remote/PR state before new edits. The full rollout ledger is `evidence/sibling-rollout.json`; tests and live logs are in `evidence/`.

**Do not merge Capital-Group #1 without further approval.** Revoke the credential supplied in chat after work is complete.
