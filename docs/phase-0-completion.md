# Phase 0 Completion Record — Precision Contract & Benchmark

**Contract:** `precision-contract-v1.2`  
**Model baseline:** `radar-v1.2.0`  
**Status:** Completed for the current Phase 0 scope

## Locked decisions

- Target precision: `>= 70%` lower-confidence-bound target
- Minimum outcome sample: `30` labeled outcomes per horizon before a precision claim
- Coverage target: `5%` minimum alert coverage target, always reported beside precision
- Alert budget: maximum `3` High Priority alerts per hour
- Minimum token age: `30` minutes
- Minimum buy sample: `10` transactions
- Minimum cohort size: `30`
- Freshness limit: `120` seconds
- Active score weights: Momentum `0.5455`, Holder Health `0.4545`
- HYPE outcome thresholds:
  - 1 hour: `+30%`, maximum drawdown `20%`
  - 6 hours: `+50%`, maximum drawdown `30%`
  - 24 hours: `+75%`, maximum drawdown `40%`
- Liquidity floor: `40%` of alert-time liquidity
- A liquidity collapse takes precedence over a price hit and produces `RISK_EVENT`
- Missing, stale, failed, or conflicting evidence remains `unknown`/`pending`

## Benchmark coverage

The versioned fixture contains all required Phase 0 categories:

1. organic hype
2. spike then crash
3. rugpull
4. bot/wash
5. clone/copycat
6. low liquidity
7. slow mover
8. source failure
9. stale data
10. source conflict

Each scenario stores the alert-time event/features separately from post-alert snapshots, so the outcome is not encoded only as a final result.

## Baseline result on the locked fixture

The benchmark command is:

```bash
npm run benchmark
```

The current fixture run is deterministic and has zero expected-label mismatches:

| Baseline | Precision | Coverage | False-positive rate |
|---|---:|---:|---:|
| Volume-only | 16.7% | 70.0% | 83.3% |
| VLR-only | 14.3% | 80.0% | 85.7% |
| Top-volume | 20.0% | 60.0% | 80.0% |
| Deterministic control | 16.7% | 60.0% | 83.3% |

These numbers validate the benchmark contract and baseline wiring. They are **not** live-market performance claims.

## Automated acceptance

- `npm run check` validates source syntax, including the contract and benchmark runner.
- `npm test` validates gate safety, outcome pending behavior, Wilson bound behavior, contract weight sum, category coverage, and baseline consistency.
- `npm run benchmark` fails on missing categories, invalid timestamps, invalid labels, contract mismatch, or expected outcome mismatch.
- Runtime endpoints:
  - `/api/contract`
  - `/api/benchmark`

## Scope boundary

Phase 0 does not claim provider feasibility, wallet/indexer coverage, replay, walk-forward validation, calibration, or live precision. Those are later phases and remain blocked until the required data exists.