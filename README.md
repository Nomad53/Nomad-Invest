# NOMAD Invest 0.1.0

## What this release is

A runnable, dependency-free Node.js engine foundation and minimal browser interface. It is a separate project from the existing NOMAD real-estate demo. No existing repository, Vercel deployment, Groq key or Supabase database has been modified.

It is **not yet a validated PSX stock recommender**. No live subscription, trained predictive model, automatic news reader, professional charting library, conversational AI, production database or scheduled monitoring service is included. The engine does not manufacture recommendations to make the interface look populated.

## Implemented

- Market-feed validation and independent, searchable market coverage. Portfolio and budget are not prerequisites.
- Explicit provenance, source timestamps, delay labels, snapshot hashes, invalid-row quarantine and duplicate detection.
- An amount-independent integer allocator. Budget accounting uses exact paise arithmetic, whole market lots and fee-inclusive affordability.
- Configurable company, sector and liquidity limits. Risk is separate from investment horizon. No production risk percentages, investment amounts, stock counts or stock lists are supplied.
- Explicit model registry gate: no approved model means no purchase recommendations.
- A deterministic ranked allocator for eligible model outputs. It is a feasible heuristic, not a globally optimal mean-variance solver, and can leave feasible capital unallocated.
- Manual holdings, browser-local storage, JSON backup export/restore, deletion and valuation.
- An existing-holding what-if with any entered amount. It distinguishes new money from existing portfolio cash, estimates acquisition cost, reports cash-inclusive and equity-only allocations, and calculates single-stock and market-wide shocks.
- Configurable commission, minimum charge, per-share charge, commission tax, levies, fixed order charge, slippage reserve and exit-cost estimate. No actual fee rates or personal tax assumptions are bundled.
- Basic password protection for hosted instances; deployment fails closed until a password is configured.
- A self-contained deterministic test suite. Synthetic fixtures only run under `--test`; they are not served as market data.

## Run locally

Use Node.js 22. The application has no npm dependencies.

    node api/nomad.js --test
    node api/nomad.js

Open `http://127.0.0.1:3000`.

With a local `.env` file, use `node --env-file=.env api/nomad.js`. An empty environment starts the interface with honest disconnected/blocked states. It does not need a portfolio or budget to start.

To use the app from other devices, deploy a private HTTPS instance; the local development server intentionally binds to loopback only.

## GitHub / Vercel

1. Create a **new private repository** named `NOMAD-Invest`. Do not edit `Nomad-Demo`.
2. Upload the contents of this folder so `api`, `package.json` and `vercel.json` are at the repository root.
3. Import that new repository into a new Vercel project. Select Other as the framework, with no custom build command or output directory. Node.js 22 is specified in package.json.
4. Set `NOMAD_PASSWORD` to a strong unique password in Vercel environment variables and deploy. Sign in using username `nomad` and that password.
5. The root URL rewrites to `/api/nomad`. The latter also works directly.

The single `api/nomad.js` file is sufficient for the app and its tests. The package/config files are deployment conveniences. Never put passwords or data tokens in GitHub, the client-side code or the chat.

Vercel deployment has **not** been performed or end-to-end tested in this build. Local Node function behavior and browser interaction have been tested; see the test records.

## What you should see initially

The interface opens. You can add manual holdings and export/restore them. The market section reports that its feed is not connected. The purchase planner reports that a validated model is not connected. Valuation and simulation wait for actual prices and applicable configuration.

These are deliberate honest states, not fake demo prices. The numerical engine is exercised by the isolated self-tests.

## Connecting data correctly

`MARKET_DATA_URL` must point to an **authorized normalized JSON service conforming to DATA_CONTRACT.md**. This release contains the generic JSON client, validation and consumption layer, not a completed adapter to a specific PSX vendor's proprietary API. An arbitrary public webpage cannot be pasted into that setting.

The next implementation task is to select a permitted source, implement its precise adapter, and test actual symbols, timestamps, sessions, corporate actions and historical coverage end to end. No fee subscription, permission or data license is acquired by setting an environment variable.

PSX publishes real-time, delayed and historical data services and requires relevant rights for specified uses. Its public portal says data are delayed five minutes unless otherwise indicated:

- https://www.psx.com.pk/psx/product-and-services/data-services-vending
- https://dps.psx.com.pk/

## Data/model readiness gates

A regular-market cash-equity candidate plan requires all of the following:

- A reachable, permitted feed and individually valid, fresh quotes.
- Instrument type, market, lot size, trade status and a conservative 20-session average-volume figure.
- An explicit fee schedule and selected versioned risk policy.
- A model version explicitly registered in `APPROVED_MODEL_IDS` after independent validation.
- Signals for the requested horizon with contemporaneously available evidence, an unexpired timestamp and an entry price range that still contains the quote.
- Positive conservative modeled benefit after the stated entry costs and exit reserve.
- A whole-lot purchase that respects remaining capital and concentration/liquidity limits.

The current code validates these **contracts**, not the actual scientific validity of a model. Adding an ID to the registry is not proof of predictive accuracy. Training, point-in-time historical data, walk-forward validation, calibration, corporate-action handling, transaction-cost backtesting and forward paper testing still need to be implemented and reviewed before approval.

## Calculation conventions

Amounts are nonnegative decimal PKR values with up to two decimal places. Money calculations use BigInt paise, not floating-point wallet balances. Parsing has a generous technical text-length limit for abuse protection; it is not a minimum capital requirement or an investment tier.

Commission uses the maximum of ad-valorem commission, per-share commission and minimum brokerage. Commission tax, levies, fixed charge and a slippage buffer are added. All modeled charges round upward to the next paisa. The actual selected fee schedule must match that structure or the fee adapter must be extended.

Slippage is a reserve, not a known invoice charge. Portfolio post-trade valuations conservatively deduct the full reserve. A simulated average cost including that reserve is not an actual or tax cost basis. Capital-gains taxes, corporate-action adjustments, dividend withholding and eventual selling charges are not silently invented.

Total-portfolio weights include recorded cash. Equity-only weights are separately labeled, so a tiny position plus large cash balance is not presented as a diversified equity portfolio. Limits are applied to total post-cost portfolio value. Existing exposure can block a buy-only plan; it never generates silent sell orders.

For new-money funding, entered cash is added to the portfolio before simulating the purchase. For existing-cash funding, cash is transferred into the purchase and the entered amount cannot exceed recorded cash. No scenario modifies real or saved holdings.

Default stress examples are declines of 5%, 10% and 20%; the engine API accepts other explicitly entered shocks. These are assumptions, not return forecasts, probabilities, maximum losses or stop-loss guarantees. A full loss remains possible. The simulator's liquidity warning does not prove that its hypothetical quantity can actually be filled.

## Privacy and operation

The manual portfolio is stored in this browser's localStorage, not a database, and is not encrypted at rest. Browser clearing or moving devices loses that copy unless a backup is restored. Analyze/simulate sends the selected portfolio to this app's own server for arithmetic. No third-party LLM is called and no bank or broker is connected.

The initial password is a single-user deployment gate, not a multi-user authentication system. Do not share one deployment with multiple users while implying isolated accounts. A shared product needs proper user accounts, per-user storage, authorization, monitoring and data/advisory-use review.

Refresh is currently **on demand** with a short per-instance memory cache. There is no autonomous scheduler, persistent prediction history, push notification service or background process after closing the app. These remain backend work, not visual polish.

## Test evidence

Run `node api/nomad.js --test`. The included result records 36 passing tests, including 250 randomized budgets within one invariant test. Tests cover zero/tiny/large amounts, exact money, fee floors, whole lots, risk and sector caps, stale/missing data, model gating, independent market use, derivative exclusion, liquidity, cash funding, the PKR 5,000 what-if, data mutation protection and HTTP handler safety.

Browser smoke checks used Chromium with an offline JavaScript bridge to the real Node handler because direct localhost navigation was blocked by the environment. LocalStorage was stubbed for the smoke test. No JavaScript errors or horizontal mobile overflow were found. These checks are not a live-vendor connection test or a Vercel production test.

## Next backend work

First implement and verify the selected authorized market-data adapter and point-in-time historical store. Then build descriptive fundamental/technical research and versioned model validation, not free-form LLM stock picking. Add grounded conversational tools, audited signal storage and scheduled monitoring after those foundations work. Advanced charts and final visual refinement remain on the product roadmap.
