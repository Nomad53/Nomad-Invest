'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.2.0';

const PSX_API_BASE =
  process.env.PSX_API_BASE ||
  'https://psxdata-api.fastapicloud.dev';

let cache = null;

/* --------------------------------------------------
   Basic helpers
-------------------------------------------------- */

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(
    String(value)
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim()
  );

  return Number.isFinite(number) ? number : null;
}

function findValue(object, keys) {
  if (!object || typeof object !== 'object') {
    return null;
  }

  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) {
      return object[key];
    }
  }

  return null;
}

function pickText(object, keys, fallback = '') {
  const value = findValue(object, keys);

  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim();
}

function pickNumber(object, keys) {
  return safeNumber(findValue(object, keys));
}

function symbol(value) {
  const text = String(value || '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(text)) {
    bad('Invalid stock symbol.');
  }

  return text;
}

function normalizeTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    return new Date().toISOString();
  }

  return new Date(parsed).toISOString();
}

/* --------------------------------------------------
   External HTTP
-------------------------------------------------- */

async function fetchJSON(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    let message = `PSX data service returned HTTP ${response.status}.`;

    try {
      const errorBody = await response.json();

      if (errorBody?.error?.message) {
        message = errorBody.error.message;
      }

      if (errorBody?.detail) {
        message = String(errorBody.detail);
      }
    } catch {}

    bad(message, response.status);
  }

  const contentType =
    response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    bad(
      'PSX data service returned an unexpected response.',
      502
    );
  }

  return response.json();
}

/* --------------------------------------------------
   PSX data adapter
-------------------------------------------------- */

function normalizeScreenerRow(row, timestamp) {
  const rawSymbol = pickText(row, [
    'symbol',
    'ticker',
    'scrip',
    'code',
    'company_code'
  ]);

  if (!rawSymbol) {
    return null;
  }

  let normalizedSymbol;

  try {
    normalizedSymbol = symbol(rawSymbol);
  } catch {
    return null;
  }

  const name = pickText(
    row,
    [
      'name',
      'company',
      'company_name',
      'companyName',
      'security_name'
    ],
    normalizedSymbol
  );

  const sector = pickText(
    row,
    [
      'sector',
      'sector_name',
      'sectorName',
      'industry'
    ],
    'Unknown'
  );

  const price = pickNumber(row, [
    'price',
    'close',
    'current',
    'current_price',
    'currentPrice',
    'last',
    'last_price',
    'lastPrice',
    'ldcp'
  ]);

  const volume = pickNumber(row, [
    'volume',
    'vol',
    'current_volume',
    'currentVolume',
    'turnover'
  ]);

  const change = pickNumber(row, [
    'change',
    'net_change',
    'netChange'
  ]);

  const changePercent = pickNumber(row, [
    'change_percent',
    'changePercent',
    'change_pct',
    'percentage_change',
    'percent_change'
  ]);

  const open = pickNumber(row, [
    'open',
    'open_price',
    'openPrice'
  ]);

  const high = pickNumber(row, [
    'high',
    'high_price',
    'highPrice'
  ]);

  const low = pickNumber(row, [
    'low',
    'low_price',
    'lowPrice'
  ]);

  if (price === null || price <= 0) {
    return null;
  }

  return {
    symbol: normalizedSymbol,
    name,
    sector,
    price,
    open,
    high,
    low,
    volume,
    change,
    changePercent,
    asOf: timestamp,
    source: 'psxdata-api'
  };
}

async function loadPSXMarket() {
  if (
    cache &&
    Date.now() - cache.fetchedAt < 60000
  ) {
    return cache.data;
  }

  const payload = await fetchJSON(
    `${PSX_API_BASE}/screener`
  );

  if (!payload || !Array.isArray(payload.data)) {
    bad(
      'PSX screener response format is not supported.',
      502
    );
  }

  const timestamp = normalizeTimestamp(
    payload?.meta?.timestamp
  );

  const stocks = payload.data
    .map(row => normalizeScreenerRow(row, timestamp))
    .filter(Boolean);

  if (!stocks.length) {
    bad(
      'PSX data service returned no usable stock prices.',
      502
    );
  }

  const result = {
    sourceName: 'psxdata-api',
    sourceUrl: PSX_API_BASE,
    mode: 'public PSX data',
    asOf: timestamp,
    totalStocks: stocks.length,
    stocks
  };

  cache = {
    fetchedAt: Date.now(),
    data: result
  };

  return result;
}

/* --------------------------------------------------
   Individual stock endpoints
-------------------------------------------------- */

async function getStockQuote(stockSymbol) {
  const sym = symbol(stockSymbol);

  const payload = await fetchJSON(
    `${PSX_API_BASE}/stocks/${encodeURIComponent(sym)}/quote`
  );

  return {
    symbol: sym,
    data: payload.data || null,
    meta: payload.meta || null
  };
}

async function getStockHistory(
  stockSymbol,
  start = null,
  end = null
) {
  const sym = symbol(stockSymbol);

  const params = new URLSearchParams();

  if (start) {
    params.set('start', start);
  }

  if (end) {
    params.set('end', end);
  }

  const query = params.toString();

  const payload = await fetchJSON(
    `${PSX_API_BASE}/stocks/${encodeURIComponent(sym)}/historical${
      query ? `?${query}` : ''
    }`
  );

  return {
    symbol: sym,
    data: Array.isArray(payload.data)
      ? payload.data
      : [],
    meta: payload.meta || null
  };
}

async function getStockFundamentals(stockSymbol) {
  const sym = symbol(stockSymbol);

  const payload = await fetchJSON(
    `${PSX_API_BASE}/stocks/${encodeURIComponent(sym)}/fundamentals`
  );

  return {
    symbol: sym,
    data: Array.isArray(payload.data)
      ? payload.data
      : [],
    meta: payload.meta || null
  };
}

/* --------------------------------------------------
   Authentication
-------------------------------------------------- */

function safeEqual(a, b) {
  const hash = value =>
    crypto
      .createHash('sha256')
      .update(String(value))
      .digest();

  return crypto.timingSafeEqual(
    hash(a),
    hash(b)
  );
}

function authorize(request, response) {
  const password = process.env.NOMAD_PASSWORD;

  if (!password) {
    if (process.env.VERCEL) {
      bad(
        'NOMAD_PASSWORD is not configured.',
        503
      );
    }

    return true;
  }

  let login = '';

  try {
    login = Buffer.from(
      (request.headers.authorization || '')
        .replace(/^Basic /, ''),
      'base64'
    ).toString();
  } catch {
    login = '';
  }

  if (!safeEqual(login, `nomad:${password}`)) {
    response.writeHead(401, {
      'WWW-Authenticate':
        'Basic realm="NOMAD Invest"'
    });

    response.end(
      'Sign in with username nomad.'
    );

    return false;
  }

  return true;
}

/* --------------------------------------------------
   Request helpers
-------------------------------------------------- */

async function readBody(request) {
  let text = '';

  for await (const chunk of request) {
    text += chunk;

    if (text.length > 200000) {
      bad('Request too large.', 413);
    }
  }

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    bad('Invalid JSON request.');
  }
}

function sendJSON(response, data, status = 200) {
  response.statusCode = status;

  response.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  response.end(
    JSON.stringify(data)
  );
}

/* --------------------------------------------------
   HTTP handler
-------------------------------------------------- */

async function handler(request, response) {
  response.setHeader(
    'Cache-Control',
    'no-store'
  );

  response.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  response.setHeader(
    'Referrer-Policy',
    'no-referrer'
  );

  try {
    if (!authorize(request, response)) {
      return;
    }

    const url = new URL(
      request.url,
      'http://localhost'
    );

    const action =
      url.searchParams.get('action') || 'app';

    if (
      request.method === 'GET' &&
      action === 'app'
    ) {
      response.setHeader(
        'Content-Type',
        'text/html; charset=utf-8'
      );

      return response.end(
        page()
      );
    }

    if (
      request.method === 'GET' &&
      action === 'health'
    ) {
      return sendJSON(response, {
        version: VERSION,
        marketDataProvider:
          'psxdata-api',
        providerBaseUrl:
          PSX_API_BASE,
        marketFeedConfigured: true,
        approvedModels: [],
        predictionEngine:
          'NOT_IMPLEMENTED',
        portfolioMode:
          'manual only',
        brokerConnection: false,
        bankConnection: false,
        tradeExecution: false
      });
    }

    if (
      request.method === 'GET' &&
      action === 'market'
    ) {
      return sendJSON(
        response,
        await loadPSXMarket()
      );
    }

    if (
      request.method === 'GET' &&
      action === 'quote'
    ) {
      const stockSymbol =
        url.searchParams.get('symbol');

      return sendJSON(
        response,
        await getStockQuote(stockSymbol)
      );
    }

    if (
      request.method === 'GET' &&
      action === 'history'
    ) {
      const stockSymbol =
        url.searchParams.get('symbol');

      const start =
        url.searchParams.get('start');

      const end =
        url.searchParams.get('end');

      return sendJSON(
        response,
        await getStockHistory(
          stockSymbol,
          start,
          end
        )
      );
    }

    if (
      request.method === 'GET' &&
      action === 'fundamentals'
    ) {
      const stockSymbol =
        url.searchParams.get('symbol');

      return sendJSON(
        response,
        await getStockFundamentals(
          stockSymbol
        )
      );
    }

    if (
      request.method === 'POST' &&
      action === 'portfolio'
    ) {
      const body =
        await readBody(request);

      return sendJSON(response, {
        status: 'PORTFOLIO_RECEIVED',
        portfolio: body.portfolio || null,
        note:
          'Portfolio intelligence will be added after market-data validation.'
      });
    }

    if (
      request.method === 'POST' &&
      action === 'plan'
    ) {
      const body =
        await readBody(request);

      return sendJSON(response, {
        status:
          'BLOCKED_MODEL_VALIDATION',

        input: {
          budget:
            body.budget ?? null,
          horizon:
            body.horizon ?? null,
          risk:
            body.risk ?? null
        },

        purchases: [],

        reason:
          'Market data is connected, but the prediction and allocation models are not validated yet. NOMAD Invest will not invent stock recommendations.'
      });
    }

    bad(
      'Unknown endpoint.',
      404
    );
  } catch (error) {
    sendJSON(
      response,
      {
        status: 'UNAVAILABLE',
        message:
          error.message ||
          'Operation failed.'
      },
      error.status || 500
    );
  }
}

/* --------------------------------------------------
   Browser interface
-------------------------------------------------- */

function page() {
  return `<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>NOMAD Invest</title>

<style>

body {
  margin: 0;
  background: #f5f7fa;
  color: #182c3e;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

main {
  max-width: 1100px;
  margin: auto;
  padding: 28px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
}

h1 {
  margin: 0;
}

h2 {
  margin-top: 0;
}

.sub {
  color: #627487;
}

.card {
  background: white;
  border: 1px solid #dfe6ec;
  border-radius: 12px;
  padding: 22px;
  margin: 18px 0;
}

.notice {
  background: #fff8e8;
  border-left: 4px solid #bd8728;
  padding: 14px 18px;
  border-radius: 4px;
}

button,
input {
  font: inherit;
}

button {
  background: #173f58;
  color: white;
  border: none;
  border-radius: 7px;
  padding: 11px 16px;
  cursor: pointer;
}

button:disabled {
  opacity: .6;
  cursor: wait;
}

input {
  width: 100%;
  max-width: 420px;
  padding: 11px;
  border: 1px solid #b9c8d5;
  border-radius: 7px;
  box-sizing: border-box;
  margin-top: 8px;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 16px 0;
}

table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
}

th,
td {
  padding: 11px;
  border-bottom: 1px solid #e5ebf0;
  text-align: left;
  white-space: nowrap;
}

th {
  background: #f7f9fb;
}

.scroll {
  overflow-x: auto;
}

#error {
  color: #a32626;
  font-weight: 600;
}

#status {
  font-size: 14px;
  margin: 16px 0;
}

.small {
  font-size: 13px;
  color: #66788a;
}

@media(max-width: 650px) {

  main {
    padding: 16px;
  }

  header {
    display: block;
  }

}

</style>
</head>

<body>

<main>

<header>

<div>

<h1>NOMAD Invest</h1>

<div class="sub">
PSX research and personal investment intelligence
</div>

</div>

<strong>
Build ${VERSION}
</strong>

</header>

<p class="notice">

PSX market data is now connected through the public
psxdata-api service.

Stock recommendations remain disabled until the
analysis and prediction engines are validated.

</p>

<div id="status">
Checking PSX connection...
</div>

<p id="error"></p>

<section class="card">

<h2>
Explore PSX
</h2>

<p>

Load the available PSX stock universe and search by
company, symbol or sector.

</p>

<div class="actions">

<button id="loadMarket">
Load market data
</button>

</div>

<label>

Search

<input
  id="search"
  type="search"
  placeholder="HBL, ENGRO, Cement..."
>

</label>

<p
  id="coverage"
  class="small"
></p>

<div
  id="stocks"
  class="scroll"
></div>

</section>

<section class="card">

<h2>
Stock research
</h2>

<p>

Enter a PSX symbol to retrieve the latest available
quote and historical data.

</p>

<label>

PSX symbol

<input
  id="stockSymbol"
  placeholder="Example: HBL"
>

</label>

<div class="actions">

<button id="loadQuote">
Quote
</button>

<button id="loadHistory">
History
</button>

<button id="loadFundamentals">
Fundamentals
</button>

</div>

<pre id="research"></pre>

</section>

<footer class="small">

No broker connection. No bank connection.
No automated trading.

</footer>

</main>

<script>

const $ =
  id => document.getElementById(id);

let marketRows = [];

function escapeHtml(value) {

  return String(value).replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character])
  );

}

async function api(action, params = {}) {

  const url =
    new URL(location.href);

  url.searchParams.set(
    'action',
    action
  );

  for (
    const [key, value]
    of Object.entries(params)
  ) {

    if (
      value !== null &&
      value !== undefined &&
      value !== ''
    ) {

      url.searchParams.set(
        key,
        value
      );

    }

  }

  const response =
    await fetch(url);

  const result =
    await response.json();

  if (!response.ok) {

    throw new Error(
      result.message ||
      'Request failed.'
    );

  }

  return result;

}

function showError(message = '') {

  $('error').textContent =
    message;

}

function renderStocks() {

  const query =
    $('search')
      .value
      .trim()
      .toLowerCase();

  const rows =
    marketRows.filter(
      stock =>
        (
          stock.symbol +
          ' ' +
          stock.name +
          ' ' +
          stock.sector
        )
          .toLowerCase()
          .includes(query)
    );

  if (!rows.length) {

    $('stocks').innerHTML =
      '<p>No matching stocks.</p>';

    return;

  }

  $('stocks').innerHTML =
    \`
    <table>

    <thead>

    <tr>

    <th>Symbol</th>
    <th>Company</th>
    <th>Sector</th>
    <th>Price</th>
    <th>Change %</th>
    <th>Volume</th>

    </tr>

    </thead>

    <tbody>

    \${rows.map(stock => \`

      <tr>

      <td>
      \${escapeHtml(stock.symbol)}
      </td>

      <td>
      \${escapeHtml(stock.name)}
      </td>

      <td>
      \${escapeHtml(stock.sector)}
      </td>

      <td>
      \${stock.price ?? ''}
      </td>

      <td>
      \${stock.changePercent ?? ''}
      </td>

      <td>
      \${stock.volume ?? ''}
      </td>

      </tr>

    \`).join('')}

    </tbody>

    </table>
    \`;

}

$('loadMarket').onclick =
  async () => {

    showError();

    $('loadMarket').disabled =
      true;

    try {

      const market =
        await api('market');

      marketRows =
        market.stocks || [];

      $('coverage').textContent =
        market.sourceName +
        ' | ' +
        market.totalStocks +
        ' usable stocks | Updated ' +
        market.asOf;

      renderStocks();

    } catch (error) {

      showError(
        error.message
      );

    } finally {

      $('loadMarket').disabled =
        false;

    }

  };

$('search').oninput =
  renderStocks;

$('loadQuote').onclick =
  async () => {

    showError();

    try {

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      const result =
        await api(
          'quote',
          { symbol }
        );

      $('research').textContent =
        JSON.stringify(
          result,
          null,
          2
        );

    } catch (error) {

      showError(
        error.message
      );

    }

  };

$('loadHistory').onclick =
  async () => {

    showError();

    try {

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      const result =
        await api(
          'history',
          { symbol }
        );

      $('research').textContent =
        JSON.stringify(
          result,
          null,
          2
        );

    } catch (error) {

      showError(
        error.message
      );

    }

  };

$('loadFundamentals').onclick =
  async () => {

    showError();

    try {

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      const result =
        await api(
          'fundamentals',
          { symbol }
        );

      $('research').textContent =
        JSON.stringify(
          result,
          null,
          2
        );

    } catch (error) {

      showError(
        error.message
      );

    }

  };

api('health')
  .then(result => {

    $('status').textContent =
      'Market provider: ' +
      result.marketDataProvider +
      ' | Prediction engine: ' +
      result.predictionEngine;

  })
  .catch(error => {

    $('status').textContent =
      error.message;

  });

</script>

</body>
</html>`;
}

/* --------------------------------------------------
   Exports
-------------------------------------------------- */

module.exports =
  handler;

if (require.main === module) {

  const port =
    Number(
      process.env.PORT || 3000
    );

  http
    .createServer(handler)
    .listen(
      port,
      '127.0.0.1',
      () => {

        console.log(
          `NOMAD Invest running at http://127.0.0.1:${port}`
        );

      }
    );

}
