'use strict';
/**
 * NOMAD Invest - engine foundation 0.1.0. No dependencies, no trading access.
 * Save as api/nomad.js for Vercel. Run locally: node api/nomad.js
 * Run deterministic tests: node api/nomad.js --test
 * No prices, fees, risk policies or approved prediction models are preloaded.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const VERSION = '0.1.0';
const BPS = 10000n;
const bad = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const ceil = (a, b) => (a + b - 1n) / b;
function money(value, name = 'Amount') {
  if (typeof value !== 'string' && typeof value !== 'number') bad(name + ' is required.');
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || s.length > 32) bad(name + ' must be nonnegative PKR, with at most two decimal places.');
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
const rupees = n => (n < 0n ? '-' : '') + (n < 0n ? -n : n) / 100n + '.' + ((n < 0n ? -n : n) % 100n).toString().padStart(2, '0');
const pct = (part, total) => total > 0n ? Number(part * 10000n / total) / 100 : 0;
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(name + ' is invalid.');
  return value;
}
function shares(value, name = 'Shares') {
  if (!/^\d+$/.test(String(value)) || String(value).length > 26) bad(name + ' must be a whole number.');
  return BigInt(value);
}
function timestamp(value, name, now = Date.now()) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) bad(name + ' needs an explicit timezone.');
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t > now + 300000) bad(name + ' is invalid or in the future.');
  return t;
}
function httpsUrl(value, name) {
  let u; try { u = new URL(value); } catch { bad(name + ' must be an HTTPS URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password) bad(name + ' must be an HTTPS URL without embedded credentials.');
  return u.href;
}
function symbol(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(value)) bad('Invalid security symbol.');
  return value;
}
function feePolicy(raw) {
  if (!raw) bad('Purchase planning is blocked: a verified fee schedule has not been configured.', 503);
  if (!raw.source || !/^\d{4}-\d{2}-\d{2}$/.test(raw.effectiveDate || '')) bad('Fee source and effective date are required.');
  const out = { source: String(raw.source), effectiveDate: raw.effectiveDate };
  for (const k of ['brokerageBps', 'taxOnBrokerageBps', 'leviesBps', 'slippageBps', 'exitCostBps']) out[k] = integer(raw[k], k, 0, 10000);
  for (const k of ['perShare', 'minimumBrokerage', 'fixedOrder']) out[k] = money(raw[k], k);
  return out;
}
function purchase(price, quantity, f) {
  const principal = price * quantity;
  if (!quantity) return { principal: 0n, brokerage: 0n, tax: 0n, levies: 0n, fixed: 0n, slippage: 0n, fees: 0n, total: 0n };
  const brokerage = [ceil(principal * BigInt(f.brokerageBps), BPS), quantity * f.perShare, f.minimumBrokerage].reduce((a, b) => a > b ? a : b);
  const tax = ceil(brokerage * BigInt(f.taxOnBrokerageBps), BPS);
  const levies = ceil(principal * BigInt(f.leviesBps), BPS);
  const slippage = ceil(principal * BigInt(f.slippageBps), BPS);
  const fees = brokerage + tax + levies + f.fixedOrder + slippage;
  return { principal, brokerage, tax, levies, fixed: f.fixedOrder, slippage, fees, total: principal + fees };
}
function maxQuantity(maxLots, lot, condition) {
  let low = 0n, high = maxLots;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (condition(middle * lot)) low = middle; else high = middle - 1n;
  }
  return low * lot;
}
function normalize(raw, now = Date.now()) {
  if (!raw || raw.schemaVersion !== 1 || raw.currency !== 'PKR' || !Array.isArray(raw.quotes)) bad('Unsupported market-feed schema.', 502);
  if (!raw.sourceName || !raw.coverage || !['realtime', 'delayed', 'eod'].includes(raw.mode)) bad('Missing feed provenance, coverage or delay classification.', 502);
  const fetchedSource = httpsUrl(raw.sourceUrl, 'Feed source');
  const asOf = timestamp(raw.asOf, 'Feed timestamp', now);
  const delaySeconds = integer(raw.delaySeconds, 'Feed delay', 0);
  if (raw.mode === 'delayed' && delaySeconds === 0) bad('A delayed feed must declare its delay.', 502);
  const seen = new Set(), quotes = [], rejected = [];
  for (const row of raw.quotes) {
    try {
      const s = symbol(row.symbol);
      if (seen.has(s)) bad('Duplicate symbol in feed: ' + s, 502);
      seen.add(s);
      const p = money(row.price, s + ' price');
      if (p <= 0n) bad('Price must be positive.');
      const qt = timestamp(row.asOf, s + ' quote timestamp', now);
      if (qt > asOf + 300000) bad('Quote is newer than its containing snapshot.');
      if (!row.name || !row.sector) bad('Missing company name or sector.');
      if (!['equity', 'etf', 'bond', 'future', 'right', 'other'].includes(row.instrumentType) || typeof row.market !== 'string' || !row.market) bad('Missing instrument type or market.');
      if (!['active', 'halted', 'suspended', 'unknown'].includes(row.status)) bad('Missing trading status.');
      const lot = integer(row.lotSize, 'Market lot', 1);
      const volume = integer(row.averageDailyVolume20, '20-session average volume', 0);
      const sourceUrl = httpsUrl(row.sourceUrl, s + ' source');
      quotes.push({ symbol: s, name: String(row.name), sector: String(row.sector), instrumentType: row.instrumentType, market: row.market, price: rupees(p), asOf: row.asOf, lotSize: lot, averageDailyVolume20: volume, status: row.status, sourceUrl });
    } catch (e) {
      if (e.message.startsWith('Duplicate symbol')) bad(e.message, 502);
      rejected.push({ symbol: String(row?.symbol || '?'), reason: e.message });
    }
  }
  if (raw.quotes.length && !quotes.length) bad('All quote rows failed validation.', 502);
  return { snapshotId: crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex'), schemaVersion: 1, currency: 'PKR', sourceName: String(raw.sourceName), sourceUrl: fetchedSource, coverage: String(raw.coverage), mode: raw.mode, delaySeconds, asOf: raw.asOf, quotes, rejected, fetchedAt: new Date(now).toISOString() };
}
function riskPolicy(p) {
  if (!p) bad('This risk mode has no reviewed risk policy yet.', 503);
  const out = {};
  for (const k of ['maxStockBps', 'maxSectorBps', 'maxParticipationBps']) out[k] = integer(p[k], k, 1, 10000);
  out.maxQuoteAgeSeconds = integer(p.maxQuoteAgeSeconds, 'Maximum quote age', 1);
  out.maxSignalRisk = integer(p.maxSignalRisk, 'Maximum signal risk', 1, 3);
  if (!p.version) bad('Risk policy version is required.');
  out.version = String(p.version);
  return out;
}
function book(input, snapshot, ageLimit, now = Date.now()) {
  const cash = money(input?.cash ?? '0', 'Portfolio cash');
  const positions = input?.positions ?? [];
  if (!Array.isArray(positions)) bad('Portfolio positions must be an array.');
  const quotes = new Map(snapshot.quotes.map(q => [q.symbol, q])), used = new Set(), holdings = [];
  for (const p of positions) {
    const s = symbol(p.symbol);
    if (used.has(s)) bad('Enter one aggregated position per symbol: ' + s);
    used.add(s);
    const quantity = shares(p.shares), averageCost = money(p.averageCost, 'Average acquisition cost');
    if (!quantity) continue;
    const q = quotes.get(s);
    if (!q) bad('Cannot value ' + s + ': a verified quote is missing.', 422);
    if (!['equity', 'etf'].includes(q.instrumentType)) bad('This foundation supports cash equity/ETF holdings, not derivative valuation.', 422);
    if (now - Date.parse(q.asOf) > ageLimit * 1000) bad('Cannot value ' + s + ': its quote is stale.', 422);
    holdings.push({ symbol: s, sector: q.sector, quantity, averageCost, price: money(q.price), value: quantity * money(q.price) });
  }
  return { cash, holdings, total: cash + holdings.reduce((s, h) => s + h.value, 0n) };
}
function sectors(holdings) {
  const result = Object.create(null);
  for (const h of holdings) result[h.sector] = (result[h.sector] || 0n) + h.value;
  return result;
}
function concentration(holdings, total) {
  const sec = sectors(holdings), equity = holdings.reduce((s, h) => s + h.value, 0n);
  return {
    equity: rupees(equity), equityPercent: pct(equity, total),
    holdings: holdings.map(h => ({ symbol: h.symbol, value: rupees(h.value), totalPortfolioPercent: pct(h.value, total), equityOnlyPercent: pct(h.value, equity) })),
    sectors: Object.entries(sec).map(([sector, v]) => ({ sector, value: rupees(v), totalPortfolioPercent: pct(v, total), equityOnlyPercent: pct(v, equity) }))
  };
}
function limitsOK(holdings, total, p) {
  if (total < 0n) return false;
  return holdings.every(h => h.value * BPS <= total * BigInt(p.maxStockBps)) &&
    Object.values(sectors(holdings)).every(v => v * BPS <= total * BigInt(p.maxSectorBps));
}
function add(holdings, quote, quantity) {
  const result = holdings.map(h => ({ ...h }));
  let target = result.find(h => h.symbol === quote.symbol);
  if (!target) { target = { symbol: quote.symbol, sector: quote.sector, quantity: 0n, averageCost: 0n, price: money(quote.price), value: 0n }; result.push(target); }
  target.quantity += quantity; target.value += money(quote.price) * quantity;
  return result;
}
function scenarios(before, after, fees, totalBefore, totalAfter, shocks = [500, 1000, 2000]) {
  return shocks.map(bps => {
    integer(bps, 'Stress decline in basis points', 0, 10000);
    const priorLoss = ceil(before * BigInt(bps), BPS), afterLoss = ceil(after * BigInt(bps), BPS);
    return { declinePercent: bps / 100, previousMarketLoss: rupees(priorLoss), newMarketLoss: rupees(afterLoss), incrementalMarketLoss: rupees(afterLoss - priorLoss), entryCostsAndBuffer: rupees(fees), lossIncludingEntryCosts: rupees(afterLoss + fees), remainingPortfolioValue: rupees(totalAfter - afterLoss), lossPercentOfPreTradeCapital: pct(afterLoss + fees, totalBefore) };
  });
}
function eligibleSignals(snapshot, rawSignals, approved, policy, horizon, now) {
  const quoteMap = new Map(snapshot.quotes.map(q => [q.symbol, q])), result = [], exclusions = [], seen = new Set();
  for (const s of rawSignals || []) {
    try {
      if (!s || !approved.includes(s.modelId)) bad('Model is not in the reviewed registry.');
      if (s.horizon !== horizon) continue;
      const sym = symbol(s.symbol), q = quoteMap.get(sym);
      if (!q || q.status !== 'active') bad('No active, validated quote.');
      if (q.instrumentType !== 'equity' || q.market !== 'REG') bad('This purchase engine currently covers regular-market cash equities only.');
      if (seen.has(sym)) bad('Duplicate signal for this horizon.');
      seen.add(sym);
      if (now - Date.parse(q.asOf) > policy.maxQuoteAgeSeconds * 1000) bad('Quote too old for this risk policy.');
      const generated = timestamp(s.generatedAt, 'Signal generation', now);
      if (typeof s.expiresAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(s.expiresAt) || Date.parse(s.expiresAt) <= now || !Number.isFinite(Date.parse(s.expiresAt))) bad('Signal expired or expiry missing.');
      if (timestamp(s.evidenceAsOf, 'Evidence timestamp', now) > generated) bad('Evidence was not available when the signal was generated.');
      const risk = integer(s.riskLevel, 'Signal risk', 1, 3);
      if (risk > policy.maxSignalRisk) bad('Above selected risk limit.');
      const lower = integer(s.conservativeReturnBps, 'Conservative return', -10000, 1000000);
      const downside = integer(s.stressLossBps, 'Scenario loss', 1, 10000);
      if (lower <= 0) bad('No positive conservative return estimate.');
      const price = money(q.price);
      if (price < money(s.minimumEntry) || price > money(s.maximumEntry)) bad('Price outside model entry conditions.');
      const validationReport = httpsUrl(s.validationReport, 'Validation report');
      if (!Array.isArray(s.evidence) || !s.evidence.length) bad('Missing evidence references.');
      const evidence = s.evidence.map(x => httpsUrl(x, 'Evidence source'));
      result.push({ ...s, evidence, validationReport, q, conservativeReturnBps: lower, stressLossBps: downside, rank: lower / downside });
    } catch (e) { exclusions.push({ symbol: String(s?.symbol || '?'), reason: e.message }); }
  }
  result.sort((a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol));
  return { candidates: result, exclusions };
}
function allocate(snapshot, rawSignals, approved, input, fees, policy, now = Date.now()) {
  const budget = money(input.budget, 'Investment budget');
  if (!['long', 'short'].includes(input.horizon) || !['conservative', 'balanced', 'aggressive'].includes(input.risk)) bad('Select a valid horizon and risk mode.');
  const empty = reason => ({ status: 'NO_PURCHASE', reason, budget: rupees(budget), purchases: [], cashLeftFromBudget: rupees(budget), forecasts: 'No return is guaranteed.' });
  if (!budget) return empty('Zero investment budget. Market research remains available.');
  if (!approved.length) return empty('No prediction model is approved. Do not treat research data as a buy recommendation.');
  if (!fees || !policy) bad('Verified fees and a reviewed risk policy are required.', 503);
  const before = book(input.portfolio, snapshot, policy.maxQuoteAgeSeconds, now);
  const funding = input.funding ?? 'new';
  if (!['new', 'cash'].includes(funding)) bad('Funding must be new or cash.');
  if (funding === 'cash' && budget > before.cash) bad('Budget exceeds manually recorded portfolio cash.');
  const capital = before.total + (funding === 'new' ? budget : 0n);
  if (!limitsOK(before.holdings, capital, policy)) return empty('Existing concentration breaches this policy. A buy-only plan cannot repair it without adequate new capital.');
  const { candidates, exclusions } = eligibleSignals(snapshot, rawSignals, approved, policy, input.horizon, now);
  let remaining = budget, charged = 0n, holdings = before.holdings;
  const purchases = [];
  for (const s of candidates) {
    const q = s.q, price = money(q.price), lot = BigInt(q.lotSize);
    const volumeCap = BigInt(q.averageDailyVolume20) * BigInt(policy.maxParticipationBps) / BPS;
    const affordableLots = remaining / price / lot;
    const maxLots = affordableLots < volumeCap / lot ? affordableLots : volumeCap / lot;
    const quantity = maxQuantity(maxLots, lot, n => {
      const c = purchase(price, n, fees);
      return c.total <= remaining && limitsOK(add(holdings, q, n), capital - charged - c.fees, policy);
    });
    if (!quantity) { exclusions.push({ symbol: q.symbol, reason: 'No whole lot fits budget, liquidity and concentration limits.' }); continue; }
    const c = purchase(price, quantity, fees);
    const grossBenefit = c.principal * BigInt(s.conservativeReturnBps) / BPS;
    const exitBuffer = ceil(c.principal * BigInt(fees.exitCostBps), BPS);
    if (grossBenefit <= c.fees + exitBuffer) { exclusions.push({ symbol: q.symbol, reason: 'Conservative modeled benefit does not clear estimated entry and exit costs.' }); continue; }
    remaining -= c.total; charged += c.fees; holdings = add(holdings, q, quantity);
    purchases.push({ symbol: q.symbol, sector: q.sector, shares: quantity.toString(), referencePrice: q.price, priceAsOf: q.asOf, marketDataMode: snapshot.mode, principal: rupees(c.principal), budgetPercent: pct(c.principal, budget), costs: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, rupees(v)])), modeledExitCost: rupees(exitBuffer), modelId: s.modelId, signalExpiresAt: s.expiresAt, validationReport: s.validationReport, evidence: s.evidence });
  }
  const totalAfter = capital - charged, beforeEquity = before.holdings.reduce((s, h) => s + h.value, 0n), afterEquity = holdings.reduce((s, h) => s + h.value, 0n);
  for (const p of purchases) p.postTradePortfolioPercent = pct(holdings.find(h => h.symbol === p.symbol).value, totalAfter);
  return { generatedAt: new Date(now).toISOString(), snapshotId: snapshot.snapshotId, feeSource: fees.source, feeEffectiveDate: fees.effectiveDate, status: purchases.length ? 'CANDIDATE_PLAN' : 'NO_PURCHASE', reason: purchases.length ? 'A constrained candidate plan for review, not an execution instruction.' : 'No evidence-backed purchase satisfies the configured constraints.', method: 'Deterministic ranked allocation, not a globally optimal portfolio solver.', risk: input.risk, horizon: input.horizon, policyVersion: policy.version, budget: rupees(budget), purchases, estimatedEntryCosts: rupees(charged), cashLeftFromBudget: rupees(remaining), totalPortfolioCashAfter: rupees(before.cash + (funding === 'new' ? budget : 0n) - (budget - remaining)), before: concentration(before.holdings, before.total), after: concentration(holdings, totalAfter), downside: scenarios(beforeEquity, afterEquity, charged, capital, totalAfter, input.shocksBps), exclusions, caveats: ['Percentages are cash-inclusive unless explicitly labeled equity-only.', 'Shock scenarios are not forecasts, probabilities, maximum losses or stop guarantees.', 'Fees include a reserved slippage estimate; actual execution may differ.', 'Capital-gains tax, future dividends and personal taxes are not computed.', 'Cash may remain because of constraints, weak evidence or this heuristic.'] };
}
function simulate(snapshot, input, fees, policy, now = Date.now()) {
  if (!fees || !policy) bad('Verified fees and a risk policy are required.', 503);
  const before = book(input.portfolio, snapshot, policy.maxQuoteAgeSeconds, now);
  const budget = money(input.budget, 'Additional amount'), sym = symbol(input.symbol);
  const existing = before.holdings.find(h => h.symbol === sym), q = snapshot.quotes.find(x => x.symbol === sym);
  if (!existing || !q) bad('Choose an existing holding for this simulation.');
  if (q.status !== 'active') bad('This security is not currently marked active.');
  if (q.instrumentType !== 'equity' || q.market !== 'REG') bad('This simulator currently supports regular-market cash equities.');
  const funding = input.funding ?? 'new';
  if (!['new', 'cash'].includes(funding)) bad('Funding must be new or cash.');
  if (funding === 'cash' && budget > before.cash) bad('Insufficient recorded portfolio cash.');
  const price = money(q.price), lot = BigInt(q.lotSize);
  const quantity = maxQuantity(budget / price / lot, lot, n => purchase(price, n, fees).total <= budget);
  const c = purchase(price, quantity, fees), afterHoldings = add(before.holdings, q, quantity);
  const capital = before.total + (funding === 'new' ? budget : 0n), totalAfter = capital - c.fees;
  const target = afterHoldings.find(h => h.symbol === sym);
  const weightedCost = (existing.averageCost * existing.quantity + c.principal + c.fees + target.quantity / 2n) / target.quantity;
  return { generatedAt: new Date(now).toISOString(), snapshotId: snapshot.snapshotId, feeSource: fees.source, feeEffectiveDate: fees.effectiveDate, status: 'SIMULATION_ONLY', symbol: sym, funding, budget: rupees(budget), addedShares: quantity.toString(), referencePrice: q.price, priceAsOf: q.asOf, costs: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, rupees(v)])), cashLeftFromBudget: rupees(budget - c.total), totalCashAfter: rupees(before.cash + (funding === 'new' ? budget : 0n) - c.total), estimatedAverageCostIncludingCostsAndBuffer: rupees(weightedCost), before: concentration(before.holdings, before.total), after: concentration(afterHoldings, totalAfter), policyWithinLimits: limitsOK(afterHoldings, totalAfter, policy), singleStockDownside: scenarios(existing.value, target.value, c.fees, capital, totalAfter, input.shocksBps), marketWideDownside: scenarios(before.holdings.reduce((s, h) => s + h.value, 0n), afterHoldings.reduce((s, h) => s + h.value, 0n), c.fees, capital, totalAfter, input.shocksBps), warnings: ['This is an arithmetic what-if, not a recommendation.', 'No holdings have been modified.', 'Cash is included in total-portfolio weights. Equity-only weights are also shown.', 'Shocks are assumptions, not forecasts or maximum losses.', 'Quoted prices do not guarantee an available fill. Execution capacity is not proven.', 'Cost basis is a planning estimate, not a tax calculation.'] };
}
let cache = null;
function environmentJSON(name) {
  if (!process.env[name]) return null;
  try { return JSON.parse(process.env[name]); } catch { bad(name + ' contains invalid JSON.', 503); }
}
async function getJSON(url, token) {
  const target = httpsUrl(url, 'Configured data endpoint');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  if (!response.ok) bad('The configured data service returned HTTP ' + response.status + '.', 502);
  if (!(response.headers.get('content-type') || '').includes('application/json')) bad('Data service did not return JSON.', 502);
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 8000000) { await reader.cancel(); bad('Data response exceeds the 8 MB safety limit.', 502); } chunks.push(Buffer.from(part.value)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad('Data service returned invalid JSON.', 502); }
}
async function market() {
  if (process.env.MARKET_DATA_AUTHORIZED !== 'true' || !process.env.MARKET_DATA_URL) bad('Market feed not connected. Configure an authorized normalized PSX feed; this build does not scrape or invent prices.', 503);
  if (cache && Date.now() - cache.fetched < 60000) return cache.snapshot;
  const snapshot = normalize(await getJSON(process.env.MARKET_DATA_URL, process.env.MARKET_DATA_TOKEN));
  cache = { fetched: Date.now(), snapshot }; return snapshot;
}
async function signalFeed() {
  if (!process.env.SIGNAL_DATA_URL) return [];
  const result = await getJSON(process.env.SIGNAL_DATA_URL, process.env.SIGNAL_DATA_TOKEN);
  if (!Array.isArray(result.signals)) bad('Invalid model-signal feed.', 502);
  return result.signals;
}
const approvedModels = () => (process.env.APPROVED_MODEL_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
function safeEqual(a, b) { const h = x => crypto.createHash('sha256').update(x).digest(); return crypto.timingSafeEqual(h(a), h(b)); }
function authorize(req, res) {
  const password = process.env.NOMAD_PASSWORD;
  if (!password) { if (process.env.VERCEL) bad('Set NOMAD_PASSWORD before using a public deployment.', 503); return true; }
  let login = ''; try { login = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString(); } catch {}
  if (!safeEqual(login, 'nomad:' + password)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NOMAD Invest"' }); res.end('Sign in with username nomad.'); return false; }
  return true;
}
async function body(req) {
  if (req.body) { const t = typeof req.body === 'string' ? req.body : JSON.stringify(req.body); if (t.length > 200000) bad('Request too large.', 413); try { return JSON.parse(t); } catch { bad('Invalid request JSON.'); } }
  let text = ''; for await (const part of req) { text += part; if (text.length > 200000) bad('Request too large.', 413); }
  try { return JSON.parse(text || '{}'); } catch { bad('Invalid request JSON.'); }
}
async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (!authorize(req, res)) return;
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) bad('Cross-origin request denied.', 403);
    const action = new URL(req.url, 'http://localhost').searchParams.get('action') || 'app';
    if (req.method === 'GET' && action === 'app') {
      const nonce = crypto.randomBytes(18).toString('base64');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      return res.end(page(nonce));
    }
    let result;
    if (req.method === 'GET' && action === 'health') result = { version: VERSION, marketFeedConfigured: !!process.env.MARKET_DATA_URL && process.env.MARKET_DATA_AUTHORIZED === 'true', feesConfigured: !!process.env.FEE_MODEL_JSON, riskPoliciesConfigured: !!process.env.RISK_POLICIES_JSON, approvedModels: approvedModels(), forecastStatus: approvedModels().length ? 'EXTERNAL_REVIEWED_MODELS_CONFIGURED' : 'NOT_VALIDATED', persistence: 'Manual portfolio: this browser only. No broker or bank connection.', monitoring: 'On demand only in this release. No scheduled or background alerts.' };
    else if (req.method === 'GET' && action === 'market') result = await market();
    else if (req.method === 'POST' && ['plan', 'simulate', 'portfolio'].includes(action)) {
      const input = await body(req);
      if (action === 'plan' && !approvedModels().length) result = { status: 'BLOCKED_MODEL_VALIDATION', budget: rupees(money(input.budget, 'Investment budget')), purchases: [], reason: 'No validated prediction model is connected. The engine will not invent a purchase plan.' };
      else {
        const snapshot = await market();
        const policy = riskPolicy(environmentJSON('RISK_POLICIES_JSON')?.[input.risk]);
        const fee = action === 'portfolio' ? null : feePolicy(environmentJSON('FEE_MODEL_JSON'));
        if (action === 'plan') result = allocate(snapshot, await signalFeed(), approvedModels(), input, fee, policy);
        if (action === 'simulate') result = simulate(snapshot, input, fee, policy);
        if (action === 'portfolio') { const b = book(input.portfolio, snapshot, policy.maxQuoteAgeSeconds); result = { cash: rupees(b.cash), value: rupees(b.total), allocation: concentration(b.holdings, b.total), holdings: b.holdings.map(h => ({ symbol: h.symbol, shares: h.quantity.toString(), recordedCost: rupees(h.quantity * h.averageCost), marketValue: rupees(h.value), unrealizedDifference: rupees(h.value - h.quantity * h.averageCost) })) }; }
      }
    } else bad('Unknown endpoint or HTTP method.', 404);
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error.status || 500; res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'UNAVAILABLE', message: error.status ? error.message : 'Operation failed. No recommendation has been generated.' }));
  }
}
function page(nonce) { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NOMAD Invest</title>
<style>body{margin:0;background:#f5f7fa;color:#182c3e;font:16px system-ui}main{max-width:1060px;margin:auto;padding:28px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin-bottom:3px}h2{font-size:22px}p{line-height:1.6}.sub,small{color:#546779}.card{background:white;border:1px solid #dce3ea;border-radius:12px;padding:22px;margin:18px 0}.row{display:flex;gap:14px;flex-wrap:wrap}.row>label{flex:1;min-width:180px}label{display:block;font-size:14px;margin:10px 0}input,select,button{font:inherit;padding:11px;border:1px solid #b8c7d5;border-radius:7px;box-sizing:border-box}input,select{display:block;width:100%;margin-top:6px}button{background:#153d55;color:white;cursor:pointer}button:disabled{opacity:.55;cursor:wait}nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px}nav button{background:white;color:#153d55}nav button[aria-selected=true]{background:#153d55;color:white}[hidden]{display:none!important}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6f9;padding:16px;border-radius:8px;font:14px/1.6 ui-monospace,monospace}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e3e9ee}th{white-space:nowrap}.notice{border-left:4px solid #bd8728;padding:12px 16px;background:#fff8e8}a{color:#164e73}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.empty{color:#546779;padding:20px 0}details{margin-top:16px}summary{cursor:pointer}#status{font-size:14px}#error{color:#9e2626}footer{font-size:13px;margin-top:28px}@media(max-width:600px){main{padding:16px}.card{padding:16px}header{display:block}}</style>
<main><header><div><h1>NOMAD Invest</h1><div class="sub">PSX research and personal investment intelligence</div></div><strong>Engine build ${VERSION}</strong></header>
<p class="notice">Foundation release. No live feed or validated forecasting model is bundled. Missing evidence blocks recommendations instead of producing sample stocks.</p>
<div id="status" role="status">Checking configuration...</div><nav aria-label="Workspace"><button data-tab="market" aria-selected="true">Explore PSX</button><button data-tab="planner">Plan an investment</button><button data-tab="portfolio">My portfolio</button><button data-tab="simulator">What-if</button></nav><p id="error" role="alert"></p>
<section id="market" class="card"><h2>Research first. No portfolio required.</h2><p>Search the securities supplied by your authorized market-data feed. This release displays source data, not AI buy ratings.</p><div class="actions"><button id="refresh">Load market data</button></div><label>Company, symbol or sector<input id="search" type="search" placeholder="Search the connected universe"></label><div id="coverage" class="sub"></div><div id="quotes" class="scroll"><p class="empty">No market data loaded. No sample prices are displayed.</p></div></section>
<section id="planner" class="card" hidden><h2>Make a plan for any amount</h2><div class="row"><label>Amount to invest, PKR<input id="budget" type="number" min="0" step="0.01" placeholder="Enter your amount"></label><label>Horizon<select id="horizon"><option value="long">Long-term investing</option><option value="short">Selected short-term opportunities</option></select></label><label>Risk mode<select id="risk"><option value="balanced">Balanced</option><option value="conservative">Conservative</option><option value="aggressive">Aggressive</option></select></label></div><label>Funding<select id="funding"><option value="new">New money</option><option value="cash">From my recorded portfolio cash</option></select></label><label><input id="usePortfolio" type="checkbox" style="display:inline;width:auto"> Consider my manually saved portfolio</label><button id="plan">Analyze this amount</button><p class="sub">The planner requires a connected market feed, reviewed risk limits, a verified fee schedule and approved model signals. There is no preset capital or stock list.</p><div id="planResult" aria-live="polite"></div></section>
<section id="portfolio" class="card" hidden><h2>Your portfolio, entered by you</h2><p>Holdings stay in this browser's local storage. This is not encrypted storage. No broker connection is used. Export a backup before clearing browser data.</p><label>Uninvested portfolio cash, PKR<input id="cash" type="number" min="0" step="0.01" placeholder="Enter recorded cash"></label><div class="row"><label>Symbol<input id="holdingSymbol" placeholder="PSX symbol"></label><label>Whole shares<input id="holdingShares" type="number" min="1" step="1"></label><label>Average acquisition cost per share, PKR<input id="holdingCost" type="number" min="0" step="0.01"></label></div><p class="sub">Include recorded historical charges in your average cost. Saving a symbol replaces that symbol's aggregate holding; it does not record a trade.</p><div class="actions"><button id="saveHolding">Save or replace holding</button><button id="saveCash">Save cash</button><button id="export">Export backup</button><button id="value">Analyze portfolio</button></div><label>Restore a previously exported NOMAD portfolio<input id="import" type="file" accept="application/json,.json"></label><div id="holdings" class="scroll"></div><div id="portfolioResult"></div></section>
<section id="simulator" class="card" hidden><h2>Before adding to a holding</h2><p>Change the amount freely. This simulation never changes your saved holdings.</p><div class="row"><label>Existing holding<select id="simSymbol"></select></label><label>Additional amount, PKR<input id="simBudget" type="number" min="0" step="0.01" placeholder="Any amount"></label><label>Funding<select id="simFunding"><option value="new">New money</option><option value="cash">Existing portfolio cash</option></select></label></div><button id="simulate">Compare before and after</button><div id="simResult" aria-live="polite"></div></section>
<details class="card"><summary>Engine status and release limitations</summary><pre id="health"></pre><p>Advanced charts, trained predictions, news ingestion, scheduled alerts and the conversational AI are not implemented in this release. No backtest or predictive-accuracy claim is being made.</p></details><footer>Research and decision support only. Forecasts are uncertain. This application has no order-execution endpoints.</footer></main>
<script nonce="${nonce}">
const $=id=>document.getElementById(id), escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data=[],portfolio={cash:'0',positions:[]};try{const saved=JSON.parse(localStorage.getItem('nomad-invest-portfolio-v1'));if(saved&&Array.isArray(saved.positions))portfolio=saved;}catch{}
async function api(action,payload){const u=new URL(location.href);u.searchParams.set('action',action);const r=await fetch(u,{method:payload?'POST':'GET',headers:payload?{'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined});const j=await r.json();if(!r.ok)throw Error(j.message||'Request failed');return j;}
async function run(button,work){$('error').textContent='';button.disabled=true;try{await work();}catch(e){$('error').textContent=e.message;}finally{button.disabled=false;}}
function display(id,value){const pre=document.createElement('pre');pre.textContent=JSON.stringify(value,null,2);$(id).replaceChildren(pre);}
function table(headers,rows){return '<table><thead><tr>'+headers.map(x=>'<th>'+escapeHtml(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+escapeHtml(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';}
function renderQuotes(){const search=$('search').value.toLowerCase(),rows=data.filter(q=>(q.symbol+' '+q.name+' '+q.sector).toLowerCase().includes(search));$('quotes').innerHTML=rows.length?table(['Symbol','Company','Sector','PKR price','Quote time','Status'],rows.map(q=>[q.symbol,q.name,q.sector,q.price,q.asOf,q.status])):'<p class="empty">No matching verified quotes.</p>';}
function renderPortfolio(){$('cash').value=portfolio.cash;$('holdings').innerHTML=portfolio.positions.length?table(['Symbol','Shares','Average cost'],portfolio.positions.map(p=>[p.symbol,p.shares,p.averageCost])):'<p class="empty">No holdings. Market research still works independently.</p>';portfolio.positions.forEach((p,i)=>{const b=document.createElement('button');b.textContent='Remove '+p.symbol;b.onclick=()=>{if(confirm('Remove '+p.symbol+' from your recorded holdings?')){portfolio.positions.splice(i,1);save();}};$('holdings').append(b);});$('simSymbol').innerHTML=portfolio.positions.map(p=>'<option>'+escapeHtml(p.symbol)+'</option>').join('');}
function save(){localStorage.setItem('nomad-invest-portfolio-v1',JSON.stringify(portfolio));renderPortfolio();}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));document.querySelectorAll('main>section').forEach(x=>x.hidden=x.id!==b.dataset.tab);});
$('refresh').onclick=()=>run($('refresh'),async()=>{const s=await api('market');data=s.quotes;$('coverage').textContent=s.sourceName+' | '+s.coverage+' | '+s.mode+' | delay '+s.delaySeconds+' seconds | snapshot '+s.asOf+' | accepted '+s.quotes.length+' | rejected '+s.rejected.length;renderQuotes();});$('search').oninput=renderQuotes;
$('plan').onclick=()=>run($('plan'),async()=>display('planResult',await api('plan',{budget:$('budget').value,horizon:$('horizon').value,risk:$('risk').value,funding:$('funding').value,portfolio:$('usePortfolio').checked?portfolio:undefined})));
$('saveHolding').onclick=()=>run($('saveHolding'),async()=>{const p={symbol:$('holdingSymbol').value.trim().toUpperCase(),shares:$('holdingShares').value,averageCost:$('holdingCost').value};if(!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(p.symbol)||!/^\\d+$/.test(p.shares)||BigInt(p.shares)<1n||!/^\\d+(\\.\\d{1,2})?$/.test(p.averageCost))throw Error('Enter a valid symbol, positive whole-share quantity and average cost.');portfolio.positions=portfolio.positions.filter(x=>x.symbol!==p.symbol).concat(p);save();});
$('saveCash').onclick=()=>run($('saveCash'),async()=>{if(!/^\\d+(\\.\\d{1,2})?$/.test($('cash').value))throw Error('Enter nonnegative cash.');portfolio.cash=$('cash').value;save();});
$('export').onclick=()=>{const a=document.createElement('a'),u=URL.createObjectURL(new Blob([JSON.stringify(portfolio,null,2)],{type:'application/json'}));a.href=u;a.download='nomad-invest-portfolio.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
$('import').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>200000)throw Error('Backup too large.');const x=JSON.parse(await f.text());if(!x||!Array.isArray(x.positions)||!/^\\d+(\\.\\d{1,2})?$/.test(String(x.cash)))throw Error('Invalid NOMAD backup.');const seen=new Set();for(const p of x.positions){if(!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(p.symbol)||!/^\\d+$/.test(String(p.shares))||!/^\\d+(\\.\\d{1,2})?$/.test(String(p.averageCost))||seen.has(p.symbol))throw Error('Invalid or duplicate holding.');seen.add(p.symbol);}if(!confirm('Replace the current locally saved portfolio with this backup?'))return;portfolio={cash:String(x.cash),positions:x.positions.map(p=>({symbol:p.symbol,shares:String(p.shares),averageCost:String(p.averageCost)}))};save();}catch(e){$('error').textContent=e.message;}};
$('value').onclick=()=>run($('value'),async()=>display('portfolioResult',await api('portfolio',{portfolio,risk:$('risk').value})));
$('simulate').onclick=()=>run($('simulate'),async()=>display('simResult',await api('simulate',{portfolio,risk:$('risk').value,symbol:$('simSymbol').value,budget:$('simBudget').value,funding:$('simFunding').value})));
renderPortfolio();api('health').then(h=>{$('health').textContent=JSON.stringify(h,null,2);$('status').textContent='Market feed: '+(h.marketFeedConfigured?'configured, connection not yet verified':'not connected')+' | Approved prediction models: '+h.approvedModels.length;}).catch(e=>$('status').textContent=e.message);
</script></html>`; }
module.exports = handler;
module.exports.engine = { money, rupees, feePolicy, purchase, normalize, riskPolicy, book, allocate, simulate, page };
if (require.main === module) {
  if (process.argv.includes('--test')) runSelfTests();
  else http.createServer(handler).listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log('NOMAD Invest: http://127.0.0.1:' + (process.env.PORT || 3000)));
}

// Test fixtures run only with --test. They are never served by the application.
function runSelfTests() {
// Never contact a real service or reuse credentials during self-tests.
const isolatedNames = ['VERCEL','NOMAD_PASSWORD','MARKET_DATA_AUTHORIZED','MARKET_DATA_URL','MARKET_DATA_TOKEN','SIGNAL_DATA_URL','SIGNAL_DATA_TOKEN','APPROVED_MODEL_IDS','FEE_MODEL_JSON','RISK_POLICIES_JSON'];
const priorEnvironment = Object.fromEntries(isolatedNames.map(k => [k, process.env[k]]));
for (const k of isolatedNames) delete process.env[k];
require('node:test').after(() => { for (const k of isolatedNames) { if (priorEnvironment[k] === undefined) delete process.env[k]; else process.env[k] = priorEnvironment[k]; } });
const assert = require('node:assert/strict');
const test = require('node:test');
const NOW = Date.parse('2026-10-09T10:00:00Z');
const ISO = new Date(NOW).toISOString();
// Synthetic fixtures ONLY. These names are not stock recommendations.
const raw = () => ({ schemaVersion: 1, currency: 'PKR', sourceName: 'SYNTHETIC UNIT TEST', sourceUrl: 'https://test.invalid/market', coverage: 'Synthetic fixtures, not PSX', mode: 'delayed', delaySeconds: 300, asOf: ISO,
  quotes: Array.from({ length: 8 }, (_, i) => ({ symbol: 'TEST' + i, name: 'Synthetic ' + i, sector: 'SECTOR' + Math.floor(i / 2), instrumentType:'equity', market:'REG', price: String(11 + i * 7) + '.25', asOf: ISO, lotSize: i === 7 ? 5 : 1, averageDailyVolume20: 1000000000000, status: 'active', sourceUrl: 'https://test.invalid/quote/' + i })) });
const snapshot = () => normalize(raw(), NOW);
const rawFees = () => ({ source: 'SYNTHETIC TEST FEE SCHEDULE, NOT REAL FEES', effectiveDate: '2026-10-01', brokerageBps: 15, taxOnBrokerageBps: 1500, leviesBps: 2, slippageBps: 5, exitCostBps: 30, perShare: '0.01', minimumBrokerage: '2.00', fixedOrder: '0.50' });
const fee = () => feePolicy(rawFees());
const policy = (overrides = {}) => riskPolicy({ version: 'TEST-ONLY', maxStockBps: 2500, maxSectorBps: 4000, maxParticipationBps: 100, maxQuoteAgeSeconds: 3600, maxSignalRisk: 2, ...overrides });
const signals = () => snapshot().quotes.map((q, i) => ({ symbol: q.symbol, modelId: 'SYNTHETIC-MODEL', horizon: 'long', generatedAt: ISO, expiresAt: new Date(NOW + 3600000).toISOString(), evidenceAsOf: ISO, riskLevel: 2, conservativeReturnBps: 1200 - i * 10, stressLossBps: 2000, minimumEntry: '1.00', maximumEntry: '10000.00', evidence: ['https://test.invalid/evidence'], validationReport: 'https://test.invalid/validation' }));
const plan = (budget, extra = {}, p = policy()) => allocate(snapshot(), signals(), ['SYNTHETIC-MODEL'], { budget, horizon: 'long', risk: 'balanced', ...extra }, fee(), p, NOW);
const holdings = { cash: '10000.00', positions: [{ symbol: 'TEST0', shares: '100', averageCost: '10.00' }, { symbol: 'TEST2', shares: '50', averageCost: '20.00' }] };

test('Exact paise parsing and formatting', () => {
  assert.equal(money('0'), 0n); assert.equal(money('0.01'), 1n); assert.equal(money('1'), 100n);
  assert.equal(money('100000000000000000000.99'), 10000000000000000000099n);
  assert.equal(rupees(-123n), '-1.23'); assert.equal(rupees(money('12.30')), '12.30');
});
test('Reject malformed or negative money rather than inventing a budget', () => {
  for (const v of [undefined, null, true, '', '1e3', '-1', 'NaN', '25K', '1.001', '1,00', Infinity]) assert.throws(() => money(v));
});
test('Fees must be explicitly supplied', () => {
  assert.throws(() => feePolicy(null)); assert.throws(() => feePolicy({ ...rawFees(), brokerageBps: undefined }));
});
test('Fees include minimum commission, tax, fixed charge and buffer with conservative rounding', () => {
  const c = purchase(1125n, 1n, fee());
  assert.equal(c.brokerage, 200n); assert.equal(c.tax, 30n); assert.equal(c.levies, 1n); assert.equal(c.slippage, 1n); assert.equal(c.fixed, 50n);
  assert.equal(c.total, 1407n); assert.equal(purchase(1125n, 0n, fee()).total, 0n);
});
test('Explicit zero-fee model is allowed; missing fees are not assumed zero', () => {
  const f = rawFees(); for (const k of ['brokerageBps','taxOnBrokerageBps','leviesBps','slippageBps','exitCostBps']) f[k] = 0;
  for (const k of ['perShare','minimumBrokerage','fixedOrder']) f[k] = '0';
  assert.equal(purchase(1125n, 5n, feePolicy(f)).total, 5625n);
});
test('No portfolio is required and there is no preset budget', () => {
  for (const amount of ['0','0.01','1','1000','10000','50000','10000000','1000000000000000.00']) {
    const r = plan(amount); assert.equal(r.budget, rupees(money(amount))); assert.ok(money(r.cashLeftFromBudget) >= 0n);
    assert.equal(r.purchases.reduce((s, o) => s + money(o.costs.total), 0n) + money(r.cashLeftFromBudget), money(amount));
  }
});
test('An insufficient amount keeps cash rather than forcing a cheap stock', () => {
  const r = plan('1'); assert.equal(r.purchases.length, 0); assert.equal(r.cashLeftFromBudget, '1.00');
});
test('Whole-share quantities, market lots and fee-inclusive budgets are respected', () => {
  const r = plan('100000'); assert.ok(r.purchases.length > 0);
  for (const o of r.purchases) { assert.match(o.shares, /^\d+$/); const q = snapshot().quotes.find(q => q.symbol === o.symbol); assert.equal(BigInt(o.shares) % BigInt(q.lotSize), 0n); }
});
test('Final company and sector exposure obey cash-inclusive caps after costs', () => {
  const r = plan('10000'); for (const h of r.after.holdings) assert.ok(h.totalPortfolioPercent <= 25);
  for (const s of r.after.sectors) assert.ok(s.totalPortfolioPercent <= 40);
});
test('No approved model means no recommendations, regardless of budget', () => {
  const r = allocate(snapshot(), signals(), [], { budget: '10000', risk: 'balanced', horizon: 'long' }, null, null, NOW);
  assert.equal(r.purchases.length, 0); assert.match(r.reason, /No prediction model/);
});
test('Horizon and risk filters do not quietly substitute other signals', () => {
  assert.equal(plan('10000', { horizon: 'short' }).purchases.length, 0);
  assert.equal(plan('10000', {}, policy({ maxSignalRisk: 1 })).purchases.length, 0);
});
test('Risk policies can switch without changing the investment amount', () => {
  const a = plan('10000', { risk: 'aggressive' }, policy({ maxStockBps: 4500, maxSectorBps: 6500, maxSignalRisk: 3 }));
  const b = plan('10000'); assert.equal(a.budget, b.budget); assert.equal(a.risk, 'aggressive');
});
test('Stale quotes cannot be used for a candidate purchase plan', () => {
  const s = snapshot(); s.quotes.forEach(q => q.asOf = new Date(NOW - 7200000).toISOString());
  const r = allocate(s, signals(), ['SYNTHETIC-MODEL'], { budget:'10000', risk:'balanced', horizon:'long' }, fee(), policy(), NOW);
  assert.equal(r.purchases.length, 0);
});
test('Missing portfolio quotes never silently become zero valuations', () => {
  assert.throws(() => book({ cash:'0', positions:[{symbol:'MISSING',shares:'1',averageCost:'1'}] }, snapshot(), 3600, NOW), /missing/);
});
test('Malformed and future-dated quote rows are quarantined', () => {
  const r = raw(); r.quotes[0].price = '-1'; r.quotes[1].asOf = new Date(NOW + 86400000).toISOString();
  const n = normalize(r, NOW); assert.equal(n.rejected.length, 2); assert.equal(n.quotes.length, 6);
});
test('Duplicate symbols fail the snapshot rather than double-counting stocks', () => {
  const r = raw(); r.quotes.push({ ...r.quotes[0] }); assert.throws(() => normalize(r, NOW), /Duplicate/);
});
test('Quote metadata must include status, lot and liquidity', () => {
  const r = raw(); delete r.quotes[0].lotSize; delete r.quotes[1].averageDailyVolume20;
  assert.equal(normalize(r, NOW).rejected.length, 2);
});
test('Expired, unreviewed and out-of-entry-range signals are excluded', () => {
  const s = signals(); s[0].expiresAt = new Date(NOW - 1).toISOString(); s[1].modelId = 'UNREVIEWED'; s[2].maximumEntry = '1';
  const r = allocate(snapshot(), s, ['SYNTHETIC-MODEL'], { budget:'10000',risk:'balanced',horizon:'long' }, fee(), policy(), NOW);
  for (const symbol of ['TEST0','TEST1','TEST2']) assert.equal(r.purchases.some(p=>p.symbol===symbol), false);
});
test('Signals cannot cite evidence that only became available later', () => {
  const s = signals(); s.forEach(x => x.evidenceAsOf = new Date(NOW + 60000).toISOString());
  const r = allocate(snapshot(), s, ['SYNTHETIC-MODEL'], {budget:'10000',risk:'balanced',horizon:'long'}, fee(), policy(), NOW);
  assert.equal(r.purchases.length, 0);
});
test('Funding from existing cash cannot exceed recorded cash', () => {
  assert.throws(() => plan('20000', {portfolio:holdings, funding:'cash'}), /exceeds/);
});
test('PKR 5000 existing-holding what-if: external versus existing cash', () => {
  const input = {portfolio:holdings,symbol:'TEST0',budget:'5000',funding:'new'};
  const external = simulate(snapshot(), input, fee(), policy(), NOW);
  const internal = simulate(snapshot(), {...input,funding:'cash'}, fee(), policy(), NOW);
  assert.equal(external.addedShares, internal.addedShares);
  assert.equal(money(external.totalCashAfter) - money(internal.totalCashAfter), 500000n);
  assert.ok(external.after.holdings[0].totalPortfolioPercent < internal.after.holdings[0].totalPortfolioPercent);
  assert.equal(money(external.cashLeftFromBudget) + money(external.costs.total), 500000n);
});
test('What-if never mutates stored holdings and uses additional cost in basis', () => {
  const original = JSON.stringify(holdings), r = simulate(snapshot(), {portfolio:holdings,symbol:'TEST0',budget:'5000',funding:'new'}, fee(), policy(), NOW);
  assert.equal(JSON.stringify(holdings), original); assert.ok(money(r.estimatedAverageCostIncludingCostsAndBuffer)>1000n);
});
test('Single-stock downside differs from whole-market downside', () => {
  const r = simulate(snapshot(), {portfolio:holdings,symbol:'TEST0',budget:'5000',funding:'new'}, fee(), policy(), NOW);
  assert.ok(money(r.marketWideDownside[1].newMarketLoss) > money(r.singleStockDownside[1].newMarketLoss));
  assert.equal(r.singleStockDownside[1].declinePercent, 10);
});
test('A zero-budget what-if has no purchase charges', () => {
  const r = simulate(snapshot(), {portfolio:holdings,symbol:'TEST0',budget:'0',funding:'new'}, fee(), policy(), NOW);
  assert.equal(r.addedShares,'0'); assert.equal(r.costs.total,'0.00'); assert.equal(r.costs.fees,'0.00');
});
test('Randomized budget invariants hold across 250 distinct inputs', () => {
  let seed=171;
  for(let i=0;i<250;i++) {
    seed=(seed*48271)%2147483647; const budget=(seed%100000000).toString()+'.37', r=plan(budget);
    const spent=r.purchases.reduce((s,o)=>s+money(o.costs.total),0n);
    assert.ok(spent<=money(budget)); assert.equal(spent+money(r.cashLeftFromBudget),money(budget));
    for(const h of r.after.holdings) assert.ok(h.totalPortfolioPercent<=25);
    for(const s of r.after.sectors) assert.ok(s.totalPortfolioPercent<=40);
  }
});
test('UI is truthful about missing forecast and market connections', () => {
  const html=page('TEST_NONCE'); assert.match(html,/No live feed or validated forecasting model is bundled/); assert.match(html,/No sample prices/);
  const js=html.match(/<script nonce="TEST_NONCE">([\s\S]*)<\/script>/)[1]; new Function(js);
});


test('A derivatives quote is never treated as an ordinary cash-equity purchase', () => {
  const r = raw(); r.quotes.forEach(q => { q.instrumentType='future'; q.market='DFC'; });
  const n = normalize(r, NOW), result = allocate(n, signals(), ['SYNTHETIC-MODEL'], {budget:'10000',risk:'balanced',horizon:'long'}, fee(), policy(), NOW);
  assert.equal(result.purchases.length,0);
  assert.throws(()=>book(holdings,n,3600,NOW),/derivative/);
});

test('Zero liquidity and suspended stocks are not purchasable', () => {
  const r=raw();r.quotes.forEach((q,i)=>{if(i%2)q.status='suspended';else q.averageDailyVolume20=0;});
  const result=allocate(normalize(r,NOW),signals(),['SYNTHETIC-MODEL'],{budget:'10000',risk:'balanced',horizon:'long'},fee(),policy(),NOW);
  assert.equal(result.purchases.length,0);
});

async function invoke(action, payload, headers = {}) {
  return new Promise((resolve,reject)=>{
    const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(c,h){this.statusCode=c;Object.assign(this.headers,h);},end(x){resolve({status:this.statusCode,headers:this.headers,text:String(x)});}};
    handler({url:'/?action='+action,method:payload?'POST':'GET',body:payload,headers},res).catch(reject);
  });
}
test('Health accurately reports disconnected services without requiring a portfolio',async()=>{
  const r=await invoke('health');assert.equal(r.status,200);const j=JSON.parse(r.text);assert.equal(j.forecastStatus,'NOT_VALIDATED');assert.equal(j.marketFeedConfigured,false);
});
test('No provider configured returns an explicit service-unavailable response',async()=>{
  const r=await invoke('market');assert.equal(r.status,503);assert.match(r.text,/not connected/);
});
test('API never fabricates a plan when no model is registered',async()=>{
  const r=await invoke('plan',{budget:'1',risk:'balanced',horizon:'long'});assert.equal(r.status,200);assert.equal(JSON.parse(r.text).purchases.length,0);
});
test('The API rejects malformed money',async()=>{
  const r=await invoke('plan',{budget:'banana',risk:'balanced',horizon:'long'});assert.equal(r.status,400);
});
test('There is no order-execution endpoint',async()=>{
  const r=await invoke('order',{symbol:'TEST0',shares:'1'});assert.equal(r.status,404);
});
test('Unexpected origins cannot invoke the API',async()=>{
  const r=await invoke('health',null,{origin:'https://other.invalid',host:'nomad.invalid'});assert.equal(r.status,403);
});
test('App response has CSP, no-store and no embedded model credentials',async()=>{
  const r=await invoke('app');assert.equal(r.status,200);assert.match(r.headers['Content-Security-Policy'],/frame-ancestors 'none'/);assert.equal(r.headers['Cache-Control'],'no-store');assert.ok(!r.text.includes('MARKET_DATA_TOKEN='));
});
test('A Vercel deployment refuses access until a private password is set',async()=>{
  const previous=process.env.VERCEL;process.env.VERCEL='1';
  try{const r=await invoke('health');assert.equal(r.status,503);assert.match(r.text,/NOMAD_PASSWORD/);}finally{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;}
});

}
