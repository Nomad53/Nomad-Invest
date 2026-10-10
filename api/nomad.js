'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.2.5';

const PSX_API_BASE =
  process.env.PSX_API_BASE ||
  'https://psxdata-api.fastapicloud.dev';

let marketCache = null;
let sectorCache = null;

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const parsed = Number(
    String(value)
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim()
  );

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function normalizeSymbol(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(value);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date().toISOString();
}

/* --------------------------------------------------
   HTTP
-------------------------------------------------- */

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    let message =
      `Data service returned HTTP ${response.status}.`;

    try {
      const body = await response.json();

      if (body?.error?.message) {
        message = body.error.message;
      }

      if (body?.detail) {
        message = String(body.detail);
      }
    } catch {}

    bad(message, response.status);
  }

  return response.json();
}

/* --------------------------------------------------
   Sector mapping
-------------------------------------------------- */

async function loadSectorMap() {
  if (
    sectorCache &&
    Date.now() - sectorCache.fetchedAt < 3600000
  ) {
    return sectorCache.data;
  }

  const response =
    await fetchJSON(
      `${PSX_API_BASE}/sectors`
    );

  const map = new Map();

  if (!Array.isArray(response.data)) {
    return map;
  }

  for (const sectorRow of response.data) {
    const sectorName =
      String(
        sectorRow.sector ||
        sectorRow.name ||
        sectorRow.sector_name ||
        sectorRow.sectorName ||
        ''
      ).trim();

    if (!sectorName) {
      continue;
    }

    try {
      const stocksResponse =
        await fetchJSON(
          `${PSX_API_BASE}/sectors/${encodeURIComponent(sectorName)}/stocks`
        );

      if (!Array.isArray(stocksResponse.data)) {
        continue;
      }

      for (const item of stocksResponse.data) {
        const symbol =
          typeof item === 'string'
            ? normalizeSymbol(item)
            : normalizeSymbol(
                item.symbol ||
                item.SYMBOL ||
                item.ticker
              );

        if (symbol) {
          map.set(
            symbol,
            sectorName
          );
        }
      }
    } catch {
      continue;
    }
  }

  sectorCache = {
    fetchedAt: Date.now(),
    data: map
  };

  return map;
}

/* --------------------------------------------------
   Screener mapping
-------------------------------------------------- */

function normalizeScreenerRow(
  row,
  sectorMap,
  timestamp
) {
  const symbol =
    normalizeSymbol(
      row.symbol
    );

  if (!symbol) {
    return null;
  }

  const price =
    safeNumber(
      row.price
    );

  if (
    price === null ||
    price <= 0
  ) {
    return null;
  }

  return {
    symbol,

    sector:
      sectorMap.get(symbol) ||
      'Unknown',

    sectorCode:
      safeNumber(
        row.sector
      ),

    listedIn:
      String(
        row.listed_in || ''
      ).trim(),

    price,

    peRatio:
      safeNumber(
        row.pe_ratio
      ),

    dividendYield:
      safeNumber(
        row.dividend_yield
      ),

    marketCap:
      safeNumber(
        row.market_cap
      ),

    freeFloat:
      safeNumber(
        row.free_float
      ),

    averageVolume30d:
      safeNumber(
        row.volume_avg_30d
      ),

    change1yPct:
      safeNumber(
        row.change_1y_pct
      ),

    asOf:
      timestamp
  };
}

/* --------------------------------------------------
   Market universe
-------------------------------------------------- */

async function loadPSXMarket() {
  if (
    marketCache &&
    Date.now() - marketCache.fetchedAt < 60000
  ) {
    return marketCache.data;
  }

  const [
    screener,
    sectorMap
  ] = await Promise.all([
    fetchJSON(
      `${PSX_API_BASE}/screener`
    ),
    loadSectorMap()
  ]);

  if (
    !screener ||
    !Array.isArray(screener.data)
  ) {
    bad(
      'PSX screener returned an unexpected format.',
      502
    );
  }

  const timestamp =
    normalizeTimestamp(
      screener?.meta?.timestamp
    );

  const stocks =
    screener.data
      .map(
        row =>
          normalizeScreenerRow(
            row,
            sectorMap,
            timestamp
          )
      )
      .filter(Boolean);

  if (!stocks.length) {
    bad(
      'No usable PSX market records were returned.',
      502
    );
  }

  const result = {
    sourceName:
      'psxdata-api',

    asOf:
      timestamp,

    totalStocks:
      stocks.length,

    stocks
  };

  marketCache = {
    fetchedAt: Date.now(),
    data: result
  };

  return result;
}

/* --------------------------------------------------
   Individual stock research
-------------------------------------------------- */

async function getQuote(stockSymbol) {
  const symbol =
    normalizeSymbol(
      stockSymbol
    );

  if (!symbol) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  const result =
    await fetchJSON(
      `${PSX_API_BASE}/stocks/${encodeURIComponent(symbol)}/quote`
    );

  return {
    symbol,
    data:
      result.data || null,
    meta:
      result.meta || null
  };
}

async function getHistory(
  stockSymbol,
  start,
  end
) {
  const symbol =
    normalizeSymbol(
      stockSymbol
    );

  if (!symbol) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  const params =
    new URLSearchParams();

  if (start) {
    params.set(
      'start',
      start
    );
  }

  if (end) {
    params.set(
      'end',
      end
    );
  }

  const query =
    params.toString();

  const result =
    await fetchJSON(
      `${PSX_API_BASE}/stocks/${encodeURIComponent(symbol)}/historical${
        query
          ? `?${query}`
          : ''
      }`
    );

  return {
    symbol,

    data:
      Array.isArray(result.data)
        ? result.data
        : [],

    meta:
      result.meta || null
  };
}

async function getFundamentals(
  stockSymbol
) {
  const symbol =
    normalizeSymbol(
      stockSymbol
    );

  if (!symbol) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  const result =
    await fetchJSON(
      `${PSX_API_BASE}/stocks/${encodeURIComponent(symbol)}/fundamentals`
    );

  return {
    symbol,

    data:
      result.data || null,

    meta:
      result.meta || null
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

function authorize(
  request,
  response
) {
  const password =
    process.env.NOMAD_PASSWORD;

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
    login =
      Buffer
        .from(
          (
            request.headers.authorization ||
            ''
          ).replace(
            /^Basic /,
            ''
          ),
          'base64'
        )
        .toString();
  } catch {}

  if (
    !safeEqual(
      login,
      `nomad:${password}`
    )
  ) {
    response.writeHead(
      401,
      {
        'WWW-Authenticate':
          'Basic realm="NOMAD Invest"'
      }
    );

    response.end(
      'Sign in with username nomad.'
    );

    return false;
  }

  return true;
}

/* --------------------------------------------------
   Response
-------------------------------------------------- */

function sendJSON(
  response,
  data,
  status = 200
) {
  response.statusCode =
    status;

  response.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  response.end(
    JSON.stringify(data)
  );
}

/* --------------------------------------------------
   Main handler
-------------------------------------------------- */

async function handler(
  request,
  response
) {
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
    if (
      !authorize(
        request,
        response
      )
    ) {
      return;
    }

    const url =
      new URL(
        request.url,
        'http://localhost'
      );

    const action =
      url.searchParams.get(
        'action'
      ) || 'app';

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
      return sendJSON(
        response,
        {
          version:
            VERSION,

          marketProvider:
            'psxdata-api',

          marketFeedConfigured:
            true,

          predictionEngine:
            'NOT_IMPLEMENTED',

          brokerConnection:
            false,

          bankConnection:
            false,

          tradeExecution:
            false
        }
      );
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
      return sendJSON(
        response,
        await getQuote(
          url.searchParams.get(
            'symbol'
          )
        )
      );
    }

    if (
      request.method === 'GET' &&
      action === 'history'
    ) {
      return sendJSON(
        response,
        await getHistory(
          url.searchParams.get(
            'symbol'
          ),

          url.searchParams.get(
            'start'
          ),

          url.searchParams.get(
            'end'
          )
        )
      );
    }

    if (
      request.method === 'GET' &&
      action === 'fundamentals'
    ) {
      return sendJSON(
        response,
        await getFundamentals(
          url.searchParams.get(
            'symbol'
          )
        )
      );
    }

    bad(
      'Unknown endpoint.',
      404
    );
  } catch (error) {
    sendJSON(
      response,
      {
        status:
          'UNAVAILABLE',

        message:
          error.message ||
          'Operation failed.'
      },

      error.status || 500
    );
  }
}

/* --------------------------------------------------
   Browser UI
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

<title>
NOMAD Invest
</title>

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
  max-width: 1200px;
  margin: auto;
  padding: 28px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h1 {
  margin: 0;
}

.sub {
  color: #617487;
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
  padding: 15px 18px;
}

button,
input,
select {
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
  opacity: .5;
  cursor: not-allowed;
}

input,
select {
  width: 100%;
  padding: 11px;
  border: 1px solid #b9c8d5;
  border-radius: 7px;
  box-sizing: border-box;
  background: white;
}

.filters {
  display: grid;
  grid-template-columns:
    minmax(220px, 2fr)
    minmax(180px, 1fr)
    minmax(200px, 1fr);
  gap: 12px;
  margin: 18px 0;
}

table {
  width: 100%;
  border-collapse: collapse;
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

tbody tr {
  cursor: pointer;
}

tbody tr:hover {
  background: #f2f7fb;
}

.scroll {
  overflow-x: auto;
}

.positive {
  color: #11823b;
  font-weight: 600;
}

.negative {
  color: #b52a2a;
  font-weight: 600;
}

.muted {
  color: #66788a;
}

#error {
  color: #b52a2a;
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 16px 0;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
}

.paginationControls {
  display: flex;
  gap: 8px;
}

pre {
  overflow-x: auto;
  background: #f6f8fa;
  padding: 15px;
  border-radius: 8px;
  white-space: pre-wrap;
}

@media(max-width: 800px) {

  main {
    padding: 16px;
  }

  header {
    display: block;
  }

  .filters {
    grid-template-columns: 1fr;
  }

  .pagination {
    align-items: flex-start;
    flex-direction: column;
  }

}

</style>

</head>

<body>

<main>

<header>

<div>

<h1>
NOMAD Invest
</h1>

<div class="sub">
PSX research and personal investment intelligence
</div>

</div>

<strong>
Build ${VERSION}
</strong>

</header>

<p class="notice">

PSX market data is connected.

The recommendation and prediction engines
are still disabled until we build and validate them.

</p>

<p id="status">
Checking connection...
</p>

<p id="error"></p>

<!-- STOCK RESEARCH FIRST -->

<section
  class="card"
  id="researchSection"
>

<h2>
Stock Research
</h2>

<p class="muted">
Search a stock directly or click any row in the PSX table below.
</p>

<input
  id="stockSymbol"
  placeholder="Enter PSX symbol e.g. HBL"
>

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

<!-- MARKET -->

<section class="card">

<h2>
Explore PSX
</h2>

<div class="actions">

<button id="loadMarket">
Load market data
</button>

</div>

<div class="filters">

<div>

<label>
Search
</label>

<input
  id="search"
  type="search"
  placeholder="Symbol or sector"
>

</div>

<div>

<label>
Sector
</label>

<select id="sectorFilter">

<option value="">
All sectors
</option>

</select>

</div>

<div>

<label>
Sort
</label>

<select id="sort">

<option value="symbolAsc">
Symbol A-Z
</option>

<option value="priceAsc">
Lowest price
</option>

<option value="priceDesc">
Highest price
</option>

<option value="changeDesc">
Best 1Y growth
</option>

<option value="changeAsc">
Worst 1Y performance
</option>

<option value="dividendDesc">
Highest dividend yield
</option>

<option value="peAsc">
Lowest P/E
</option>

<option value="volumeDesc">
Highest 30D volume
</option>

</select>

</div>

</div>

<p
  id="coverage"
  class="muted"
></p>

<div
  id="stocks"
  class="scroll"
></div>

<div class="pagination">

<div
  id="pageInfo"
  class="muted"
></div>

<div class="paginationControls">

<button id="previousPage">
Previous
</button>

<button id="nextPage">
Next
</button>

</div>

</div>

</section>

</main>

<script>

const $ =
  id => document.getElementById(id);

let marketRows = [];

let currentPage = 1;

const PAGE_SIZE = 50;

/* ---------------------------------------
   Formatting
--------------------------------------- */

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

function formatNumber(
  value,
  digits = 2
) {
  if (
    value === null ||
    value === undefined
  ) {
    return '-';
  }

  return Number(value)
    .toLocaleString(
      'en-PK',
      {
        maximumFractionDigits:
          digits
      }
    );
}

function formatPercent(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '-';
  }

  return (
    formatNumber(
      value,
      2
    ) + '%'
  );
}

/* ---------------------------------------
   API
--------------------------------------- */

async function api(
  action,
  params = {}
) {
  const url =
    new URL(
      location.href
    );

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

/* ---------------------------------------
   Filter / sort
--------------------------------------- */

function getFilteredRows() {
  const query =
    $('search')
      .value
      .trim()
      .toLowerCase();

  const sector =
    $('sectorFilter')
      .value;

  let rows =
    marketRows.filter(
      stock => {

        const matchesSearch =
          (
            stock.symbol +
            ' ' +
            stock.sector
          )
            .toLowerCase()
            .includes(query);

        const matchesSector =
          !sector ||
          stock.sector === sector;

        return (
          matchesSearch &&
          matchesSector
        );
      }
    );

  const sort =
    $('sort').value;

  rows =
    [...rows];

  switch (sort) {

    case 'priceAsc':

      rows.sort(
        (a, b) =>
          (a.price ?? Infinity) -
          (b.price ?? Infinity)
      );

      break;

    case 'priceDesc':

      rows.sort(
        (a, b) =>
          (b.price ?? -Infinity) -
          (a.price ?? -Infinity)
      );

      break;

    case 'changeDesc':

      rows.sort(
        (a, b) =>
          (b.change1yPct ?? -Infinity) -
          (a.change1yPct ?? -Infinity)
      );

      break;

    case 'changeAsc':

      rows.sort(
        (a, b) =>
          (a.change1yPct ?? Infinity) -
          (b.change1yPct ?? Infinity)
      );

      break;

    case 'dividendDesc':

      rows.sort(
        (a, b) =>
          (b.dividendYield ?? -Infinity) -
          (a.dividendYield ?? -Infinity)
      );

      break;

    case 'peAsc':

      rows =
        rows
          .filter(
            stock =>
              stock.peRatio !== null &&
              stock.peRatio > 0
          )
          .sort(
            (a, b) =>
              a.peRatio -
              b.peRatio
          );

      break;

    case 'volumeDesc':

      rows.sort(
        (a, b) =>
          (b.averageVolume30d ?? -Infinity) -
          (a.averageVolume30d ?? -Infinity)
      );

      break;

    default:

      rows.sort(
        (a, b) =>
          a.symbol.localeCompare(
            b.symbol
          )
      );

  }

  return rows;
}

/* ---------------------------------------
   Render table
--------------------------------------- */

function renderStocks() {
  const rows =
    getFilteredRows();

  const pageCount =
    Math.max(
      1,
      Math.ceil(
        rows.length /
        PAGE_SIZE
      )
    );

  if (
    currentPage >
    pageCount
  ) {
    currentPage =
      pageCount;
  }

  const start =
    (
      currentPage - 1
    ) * PAGE_SIZE;

  const pageRows =
    rows.slice(
      start,
      start + PAGE_SIZE
    );

  if (!pageRows.length) {
    $('stocks').innerHTML =
      '<p>No matching stocks.</p>';

    $('pageInfo').textContent =
      '0 results';

    $('previousPage').disabled =
      true;

    $('nextPage').disabled =
      true;

    return;
  }

  $('stocks').innerHTML =
    '<table>' +

    '<thead>' +

    '<tr>' +

    '<th>Symbol</th>' +
    '<th>Sector</th>' +
    '<th>Price</th>' +
    '<th>P/E</th>' +
    '<th>Dividend Yield</th>' +
    '<th>30D Avg Volume</th>' +
    '<th>1Y Change</th>' +

    '</tr>' +

    '</thead>' +

    '<tbody>' +

    pageRows.map(stock => {

      const changeClass =
        stock.change1yPct > 0
          ? 'positive'
          : stock.change1yPct < 0
            ? 'negative'
            : '';

      return (
        '<tr data-symbol="' +
        escapeHtml(
          stock.symbol
        ) +
        '">' +

        '<td><strong>' +
        escapeHtml(
          stock.symbol
        ) +
        '</strong></td>' +

        '<td>' +
        escapeHtml(
          stock.sector
        ) +
        '</td>' +

        '<td>' +
        formatNumber(
          stock.price
        ) +
        '</td>' +

        '<td>' +
        formatNumber(
          stock.peRatio
        ) +
        '</td>' +

        '<td>' +
        formatPercent(
          stock.dividendYield
        ) +
        '</td>' +

        '<td>' +
        formatNumber(
          stock.averageVolume30d,
          0
        ) +
        '</td>' +

        '<td class="' +
        changeClass +
        '">' +
        formatPercent(
          stock.change1yPct
        ) +
        '</td>' +

        '</tr>'
      );

    }).join('') +

    '</tbody>' +

    '</table>';

  const firstResult =
    start + 1;

  const lastResult =
    Math.min(
      start + PAGE_SIZE,
      rows.length
    );

  $('pageInfo').textContent =
    firstResult +
    '-' +
    lastResult +
    ' of ' +
    rows.length +
    ' results | Page ' +
    currentPage +
    ' of ' +
    pageCount;

  $('previousPage').disabled =
    currentPage <= 1;

  $('nextPage').disabled =
    currentPage >= pageCount;

  document
    .querySelectorAll(
      '#stocks tbody tr'
    )
    .forEach(
      row => {

        row.addEventListener(
          'click',
          () => {

            const symbol =
              row.dataset.symbol;

            $('stockSymbol').value =
              symbol;

            $('researchSection')
              .scrollIntoView({
                behavior: 'smooth',
                block: 'start'
              });

          }
        );

      }
    );
}

/* ---------------------------------------
   Sectors
--------------------------------------- */

function populateSectors() {
  const sectors =
    [
      ...new Set(
        marketRows
          .map(
            stock =>
              stock.sector
          )
          .filter(
            sector =>
              sector &&
              sector !== 'Unknown'
          )
      )
    ]
      .sort();

  $('sectorFilter').innerHTML =
    '<option value="">All sectors</option>' +

    sectors
      .map(
        sector =>
          '<option value="' +
          escapeHtml(
            sector
          ) +
          '">' +
          escapeHtml(
            sector
          ) +
          '</option>'
      )
      .join('');
}

/* ---------------------------------------
   Market load
--------------------------------------- */

$('loadMarket').onclick =
  async () => {

    $('error').textContent =
      '';

    $('loadMarket').disabled =
      true;

    try {
      const result =
        await api(
          'market'
        );

      marketRows =
        result.stocks || [];

      currentPage =
        1;

      $('coverage').textContent =
        result.totalStocks +
        ' usable stocks | Updated ' +
        result.asOf;

      populateSectors();

      renderStocks();

    } catch (error) {

      $('error').textContent =
        error.message;

    } finally {

      $('loadMarket').disabled =
        false;

    }
  };

/* ---------------------------------------
   Filters
--------------------------------------- */

$('search').oninput =
  () => {

    currentPage =
      1;

    renderStocks();

  };

$('sectorFilter').onchange =
  () => {

    currentPage =
      1;

    renderStocks();

  };

$('sort').onchange =
  () => {

    currentPage =
      1;

    renderStocks();

  };

/* ---------------------------------------
   Pagination
--------------------------------------- */

$('previousPage').onclick =
  () => {

    if (
      currentPage > 1
    ) {
      currentPage--;

      renderStocks();

      document
        .querySelector(
          '#stocks'
        )
        .scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
    }

  };

$('nextPage').onclick =
  () => {

    const rows =
      getFilteredRows();

    const pageCount =
      Math.ceil(
        rows.length /
        PAGE_SIZE
      );

    if (
      currentPage <
      pageCount
    ) {
      currentPage++;

      renderStocks();

      document
        .querySelector(
          '#stocks'
        )
        .scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
    }

  };

/* ---------------------------------------
   Research
--------------------------------------- */

$('loadQuote').onclick =
  async () => {

    $('error').textContent =
      '';

    try {
      const result =
        await api(
          'quote',
          {
            symbol:
              $('stockSymbol')
                .value
                .trim()
                .toUpperCase()
          }
        );

      $('research').textContent =
        JSON.stringify(
          result,
          null,
          2
        );

    } catch (error) {

      $('error').textContent =
        error.message;

    }
  };

$('loadHistory').onclick =
  async () => {

    $('error').textContent =
      '';

    try {
      const result =
        await api(
          'history',
          {
            symbol:
              $('stockSymbol')
                .value
                .trim()
                .toUpperCase()
          }
        );

      $('research').textContent =
        JSON.stringify(
          result,
          null,
          2
        );

    } catch (error) {

      $('error').textContent =
        error.message;

    }
  };

$('loadFundamentals').onclick =
  async () => {

    $('error').textContent =
      '';

    try {
      const result =
        await api(
          'fundamentals',
          {
            symbol:
              $('stockSymbol')
                .value
                .trim()
                .toUpperCase()
          }
        );

      $('research').textContent =
        JSON.stringify(
          result,
          null,
          2
        );

    } catch (error) {

      $('error').textContent =
        error.message;

    }
  };

/* ---------------------------------------
   Health
--------------------------------------- */

api('health')
  .then(
    result => {

      $('status').textContent =
        'Market: connected | Prediction engine: ' +
        result.predictionEngine;

    }
  )
  .catch(
    error => {

      $('status').textContent =
        error.message;

    }
  );

</script>

</body>

</html>`;
}

module.exports =
  handler;

if (require.main === module) {
  const port =
    Number(
      process.env.PORT || 3000
    );

  http
    .createServer(
      handler
    )
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
