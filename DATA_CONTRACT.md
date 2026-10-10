# Data contracts for the first engine

These are NOMAD's internal interfaces, **not a claim that PSX or any particular vendor already exposes these endpoints**. The specific provider adapter must translate the permitted vendor data into these forms. No operational prices or production model signals are supplied in this release.

## Market snapshot

`MARKET_DATA_URL` is a server-controlled HTTPS URL. Use `MARKET_DATA_TOKEN` for a bearer token only if the provider uses that authentication. Do not include secrets in public source/evidence URLs. Requests do not follow redirects and time out after 15 seconds; responses are limited to 8 MB.

The response is a JSON object with these fields:

| Field | Required type/meaning |
|---|---|
| schemaVersion | Integer 1 |
| currency | String PKR |
| sourceName | Actual permitted data supplier |
| sourceUrl | Public HTTPS provenance page, no secrets |
| coverage | Actual coverage description, not an unverified claim of the entire PSX |
| mode | realtime, delayed or eod |
| delaySeconds | Nonnegative integer, positive for a delayed feed |
| asOf | Source snapshot ISO timestamp with Z or timezone offset |
| quotes | Array, without duplicate symbols |

Each quote contains:

| Field | Required type/meaning |
|---|---|
| symbol | Canonical uppercase symbol, not a preselected demo stock |
| name | Company name |
| sector | Consistent, sourced sector classification |
| instrumentType | equity, etf, bond, future, right or other |
| market | Market identifier; initial purchase allocation permits REG equities only |
| price | Positive decimal PKR string with two or fewer decimal places |
| asOf | Individual source quote timestamp with timezone, not time of retrieval |
| lotSize | Actual integer market lot, at least 1 |
| averageDailyVolume20 | Conservative whole-share daily mean, rounded down across the most recent 20 trading sessions |
| status | active, halted, suspended or unknown |
| sourceUrl | HTTPS source reference, no credentials |

The current quote contract does not imply that the price is an executable ask. Plans label it referencePrice. Bid/ask spread, depth, holidays and exchange-session calendars require a later richer adapter. Do not label an EOD quote as live or use a download timestamp as its quote timestamp.

## Fee policy

`FEE_MODEL_JSON` is a JSON object. Every field below is required, including intentional zeros:

- `source`: actual fee-schedule name, URL or manual verification reference.
- `effectiveDate`: ISO calendar date.
- `brokerageBps`: commission on notional, in basis points.
- `perShare`: per-share commission in decimal PKR.
- `minimumBrokerage`: per-order minimum commission in decimal PKR.
- `taxOnBrokerageBps`: tax applied to commission, not the entire purchase principal.
- `leviesBps`: supplied combined applicable notional levies.
- `fixedOrder`: supplied fixed charge in decimal PKR.
- `slippageBps`: explicit planning buffer, not known execution cost.
- `exitCostBps`: explicit estimated eventual selling-cost buffer for opportunity screening. It is not charged to the purchase cash balance and does not include a fabricated capital-gains-tax assumption.

One basis point is 0.01%. Do not use the synthetic test fee schedule in a real investment plan. Verify that the maximum-of-three commission structure matches the actual schedule. Source/date metadata are recorded, but verification of the legal/current rates remains a required administrative step.

## Risk policies

`RISK_POLICIES_JSON` maps `conservative`, `balanced` and `aggressive` to reviewed policy objects. Each object needs:

- `version`: explicit policy version.
- `maxStockBps`: maximum one-stock weight in total post-cost portfolio value.
- `maxSectorBps`: maximum one-sector weight on the same basis.
- `maxParticipationBps`: maximum intended share quantity as a fraction of average daily volume.
- `maxQuoteAgeSeconds`: maximum tolerated individual quote age. Conservative fail-closed freshness only; a full exchange-calendar implementation is still pending.
- `maxSignalRisk`: maximum model-classified risk level, integer 1 to 3.

These are safety LIMITS, not target portfolio weights. The distribution is derived from supplied signals, money, holdings and feasible market lots. No production policies are included because unvalidated test numbers must not silently become investment policy.

## Future model service

`SIGNAL_DATA_URL` points to NOMAD's future reviewed model-output service, not a free-form LLM text response. Its JSON response contains `signals`, an array with:

- `symbol`, matching the quote universe.
- `modelId`, an explicitly approved model version.
- `horizon`: long or short.
- `generatedAt`, `evidenceAsOf`, `expiresAt`: ISO timestamps with timezone. Evidence must have been available by generation. An unexpired signal is not automatically a valid prediction.
- `riskLevel`: integer 1 to 3, calibrated by a documented methodology outside this foundation.
- `conservativeReturnBps`: a model estimate for its documented horizon. This is not a claimed probability or an assumed guaranteed return.
- `stressLossBps`: a scenario loss magnitude for the same horizon, not a maximum-loss promise.
- `minimumEntry`, `maximumEntry`: decimal PKR entry conditions.
- `validationReport`: HTTPS link to the reviewed model-validation report.
- `evidence`: nonempty array of source HTTPS references.

`APPROVED_MODEL_IDS` is a comma-separated registry allowlist. It must remain empty until actual out-of-sample validation, transaction-cost analysis and forward paper tests have been reviewed. The foundation checks schema, provenance, dates and registry membership. It does not itself train models or establish scientific validity from the presence of a report URL.

## Application requests

All routes use the same function with query `action`:

- GET `?action=health`: configuration status without a portfolio.
- GET `?action=market`: independent source-universe fetch and validation.
- POST `?action=plan`: budget string, risk, horizon, funding (`new` or `cash`) and optional portfolio.
- POST `?action=portfolio`: selected risk and manually maintained portfolio.
- POST `?action=simulate`: selected risk, existing symbol, arbitrary budget string, funding and portfolio.

A manual portfolio is an object with `cash` as a decimal PKR string and `positions` as an array. Each position has `symbol`, whole `shares`, and decimal `averageCost`. Quantities are strings to preserve large integer precision. One aggregate holding per symbol is required. The code rejects missing prices rather than treating them as zero.

Optional `shocksBps` is an array of nonnegative percentage shocks in basis points, up to 10000. No execution route, broker authentication or bank account access exists.
