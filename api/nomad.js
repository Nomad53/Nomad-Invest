'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.3.0';

const PSX_API_BASE =
  process.env.PSX_API_BASE ||
  'https://psxdata-api.fastapicloud.dev';

const PSX_META_BASE =
  process.env.PSX_META_BASE ||
  'https://psx-rest-api.onrender.com';

let marketCache = null;
let sectorCache = null;
let companyCache = null;

/* --------------------------------------------------
   HELPERS
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

async function fetchJSON(
  url,
  timeout = 20000
) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) {
    let message =
      `Data service returned HTTP ${response.status}.`;

    try {
      const body =
        await response.json();

      if (body?.error?.message) {
        message =
          body.error.message;
      }

      if (body?.detail) {
        message =
          String(body.detail);
      }
    } catch {}

    bad(
      message,
      response.status
    );
  }

  return response.json();
}

/* --------------------------------------------------
   COMPANY NAMES
-------------------------------------------------- */

async function loadCompanyMap() {
  if (
    companyCache &&
    Date.now() -
      companyCache.fetchedAt <
      6 * 60 * 60 * 1000
  ) {
    return companyCache.data;
  }

  const map =
    new Map();

  try {
    const response =
      await fetchJSON(
        `${PSX_META_BASE}/symbols`,
        30000
      );

    const rows =
      Array.isArray(response)
        ? response
        : Array.isArray(response?.data)
          ? response.data
          : [];

    for (const row of rows) {
      const symbol =
        normalizeSymbol(
          row.symbol
        );

      if (!symbol) {
        continue;
      }

      map.set(
        symbol,
        {
          name:
            String(
              row.name ||
              symbol
            ).trim(),

          sector:
            String(
              row.sector ||
              ''
            ).trim(),

          isETF:
            Boolean(
              row.is_etf
            ),

          isDebt:
            Boolean(
              row.is_debt
            )
        }
      );
    }
  } catch (error) {
    console.error(
      'Company metadata unavailable:',
      error.message
    );
  }

  companyCache = {
    fetchedAt:
      Date.now(),
    data:
      map
  };

  return map;
}

/* --------------------------------------------------
   SECTOR MAPPING
-------------------------------------------------- */

async function loadSectorMap() {
  if (
    sectorCache &&
    Date.now() -
      sectorCache.fetchedAt <
      3600000
  ) {
    return sectorCache.data;
  }

  const response =
    await fetchJSON(
      `${PSX_API_BASE}/sectors`
    );

  const map =
    new Map();

  if (
    !Array.isArray(
      response.data
    )
  ) {
    return map;
  }

  for (
    const sectorRow
    of response.data
  ) {
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
          `${PSX_API_BASE}/sectors/${encodeURIComponent(
            sectorName
          )}/stocks`
        );

      if (
        !Array.isArray(
          stocksResponse.data
        )
      ) {
        continue;
      }

      for (
        const item
        of stocksResponse.data
      ) {
        const symbol =
          typeof item === 'string'
            ? normalizeSymbol(
                item
              )
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
    } catch {}
  }

  sectorCache = {
    fetchedAt:
      Date.now(),
    data:
      map
  };

  return map;
}

/* --------------------------------------------------
   SCREENER
-------------------------------------------------- */

function normalizeScreenerRow(
  row,
  sectorMap,
  companyMap,
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

  const company =
    companyMap.get(
      symbol
    );

  return {
    symbol,

    companyName:
      company?.name ||
      symbol,

    sector:
      company?.sector ||
      sectorMap.get(
        symbol
      ) ||
      'Unknown',

    sectorCode:
      safeNumber(
        row.sector
      ),

    listedIn:
      String(
        row.listed_in ||
        ''
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
   MARKET
-------------------------------------------------- */

async function loadPSXMarket() {
  if (
    marketCache &&
    Date.now() -
      marketCache.fetchedAt <
      60000
  ) {
    return marketCache.data;
  }

  const [
    screener,
    sectorMap,
    companyMap
  ] =
    await Promise.all([
      fetchJSON(
        `${PSX_API_BASE}/screener`
      ),

      loadSectorMap(),

      loadCompanyMap()
    ]);

  if (
    !screener ||
    !Array.isArray(
      screener.data
    )
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
            companyMap,
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

    companyMetadata:
      companyMap.size,

    asOf:
      timestamp,

    totalStocks:
      stocks.length,

    stocks
  };

  marketCache = {
    fetchedAt:
      Date.now(),
    data:
      result
  };

  return result;
}

/* --------------------------------------------------
   STOCK QUOTE
-------------------------------------------------- */

async function getQuote(
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

  const [
    result,
    companyMap
  ] =
    await Promise.all([
      fetchJSON(
        `${PSX_API_BASE}/stocks/${encodeURIComponent(
          symbol
        )}/quote`
      ),

      loadCompanyMap()
    ]);

  return {
    symbol,

    company:
      companyMap.get(
        symbol
      ) || null,

    data:
      result.data ||
      null,

    meta:
      result.meta ||
      null
  };
}

/* --------------------------------------------------
   HISTORY
-------------------------------------------------- */

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

  const [
    result,
    companyMap
  ] =
    await Promise.all([
      fetchJSON(
        `${PSX_API_BASE}/stocks/${encodeURIComponent(
          symbol
        )}/historical${
          query
            ? `?${query}`
            : ''
        }`
      ),

      loadCompanyMap()
    ]);

  const rawRows =
    Array.isArray(
      result.data
    )
      ? result.data
      : [];

  const cleaned =
    [];

  const anomalies =
    [];

  for (
    const row
    of rawRows
  ) {
    const date =
      row.date;

    const open =
      safeNumber(
        row.open
      );

    const high =
      safeNumber(
        row.high
      );

    const low =
      safeNumber(
        row.low
      );

    const close =
      safeNumber(
        row.close
      );

    const volume =
      safeNumber(
        row.volume
      );

    const suspicious =
      row.is_anomaly === true ||
      !date ||
      close === null ||
      close <= 0 ||
      open === null ||
      high === null ||
      low === null ||
      open <= 0 ||
      high <= 0 ||
      low <= 0;

    const normalized = {
      date,
      open,
      high,
      low,
      close,
      volume:
        volume || 0,
      isAnomaly:
        suspicious
    };

    if (suspicious) {
      anomalies.push(
        normalized
      );
    } else {
      cleaned.push(
        normalized
      );
    }
  }

  cleaned.sort(
    (a, b) =>
      String(a.date)
        .localeCompare(
          String(b.date)
        )
  );

  let summary =
    null;

  if (
    cleaned.length >= 1
  ) {
    const first =
      cleaned[0];

    const last =
      cleaned[
        cleaned.length - 1
      ];

    const prices =
      cleaned.map(
        row =>
          row.close
      );

    const volumes =
      cleaned.map(
        row =>
          row.volume || 0
      );

    const change =
      last.close -
      first.close;

    const changePct =
      first.close !== 0
        ? (
            change /
            first.close
          ) * 100
        : null;

    summary = {
      startDate:
        first.date,

      endDate:
        last.date,

      startPrice:
        first.close,

      endPrice:
        last.close,

      change,

      changePct,

      high:
        Math.max(
          ...prices
        ),

      low:
        Math.min(
          ...prices
        ),

      averageVolume:
        volumes.length
          ? Math.round(
              volumes.reduce(
                (
                  sum,
                  value
                ) =>
                  sum +
                  value,
                0
              ) /
              volumes.length
            )
          : 0,

      validSessions:
        cleaned.length,

      excludedAnomalies:
        anomalies.length
    };
  }

  return {
    symbol,

    company:
      companyMap.get(
        symbol
      ) || null,

    summary,

    data:
      cleaned,

    anomalies,

    meta:
      result.meta ||
      null
  };
}

/* --------------------------------------------------
   FUNDAMENTALS
-------------------------------------------------- */

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

  const [
    result,
    companyMap
  ] =
    await Promise.all([
      fetchJSON(
        `${PSX_API_BASE}/stocks/${encodeURIComponent(
          symbol
        )}/fundamentals`
      ),

      loadCompanyMap()
    ]);

  return {
    symbol,

    company:
      companyMap.get(
        symbol
      ) || null,

    data:
      result.data ||
      null,

    meta:
      result.meta ||
      null
  };
}

/* --------------------------------------------------
   AUTH
-------------------------------------------------- */

function safeEqual(
  a,
  b
) {
  const hash =
    value =>
      crypto
        .createHash(
          'sha256'
        )
        .update(
          String(value)
        )
        .digest();

  return crypto
    .timingSafeEqual(
      hash(a),
      hash(b)
    );
}

function authorize(
  request,
  response
) {
  const password =
    process.env
      .NOMAD_PASSWORD;

  if (!password) {
    if (
      process.env.VERCEL
    ) {
      bad(
        'NOMAD_PASSWORD is not configured.',
        503
      );
    }

    return true;
  }

  let login =
    '';

  try {
    login =
      Buffer
        .from(
          (
            request.headers
              .authorization ||
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
   RESPONSE
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
    JSON.stringify(
      data
    )
  );
}

/* --------------------------------------------------
   HANDLER
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
      request.method ===
        'GET' &&
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
      request.method ===
        'GET' &&
      action ===
        'health'
    ) {
      return sendJSON(
        response,
        {
          version:
            VERSION,

          marketProvider:
            'psxdata-api',

          companyMetadata:
            'psx-rest-api',

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
      request.method ===
        'GET' &&
      action ===
        'market'
    ) {
      return sendJSON(
        response,
        await loadPSXMarket()
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'quote'
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
      request.method ===
        'GET' &&
      action ===
        'history'
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
      request.method ===
        'GET' &&
      action ===
        'fundamentals'
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

      error.status ||
        500
    );
  }
}

/* --------------------------------------------------
   UI
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
  max-width: 1250px;
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

h2 {
  margin-top: 0;
}

.sub,
.muted {
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
    minmax(240px,2fr)
    minmax(180px,1fr)
    minmax(210px,1fr);
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
}

th {
  background: #f7f9fb;
  white-space: nowrap;
}

tbody tr {
  cursor: pointer;
}

tbody tr:hover {
  background: #f2f7fb;
}

.symbol {
  font-weight: 700;
  white-space: nowrap;
}

.company {
  min-width: 230px;
}

.scroll {
  overflow-x: auto;
}

.positive {
  color: #11823b;
  font-weight: 700;
}

.negative {
  color: #b52a2a;
  font-weight: 700;
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

.companyHeader {
  margin-top: 18px;
}

.companyHeader strong {
  font-size: 22px;
  display: block;
}

.companyHeader span {
  color: #66788a;
}

.summaryGrid {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(150px,1fr)
    );
  gap: 12px;
  margin: 18px 0;
}

.metric {
  border: 1px solid #e1e7ec;
  border-radius: 9px;
  padding: 14px;
  background: #fafcfd;
}

.metricLabel {
  color: #66788a;
  font-size: 12px;
  margin-bottom: 5px;
}

.metricValue {
  font-size: 19px;
  font-weight: 700;
}

.chartBox {
  border: 1px solid #e1e7ec;
  border-radius: 10px;
  padding: 14px;
  margin-top: 16px;
  overflow: hidden;
}

.chartTitle {
  font-size: 14px;
  color: #66788a;
  margin-bottom: 12px;
}

.priceChart {
  display: block;
  width: 100%;
  height: 340px;
}

.chartAxis {
  stroke: #ccd7df;
  stroke-width: 1;
}

.chartLine {
  fill: none;
  stroke: #173f58;
  stroke-width: 2.5;
}

.chartArea {
  fill: rgba(23,63,88,.08);
}

.chartLabel {
  font-size: 11px;
  fill: #66788a;
}

.chartPoint {
  fill: #173f58;
}

.chartPoint:hover {
  r: 5;
}

details {
  margin-top: 18px;
}

details summary {
  cursor: pointer;
  font-weight: 600;
}

pre {
  overflow-x: auto;
  background: #f6f8fa;
  padding: 15px;
  border-radius: 8px;
  white-space: pre-wrap;
  max-height: 400px;
}

.warningBox {
  margin-top: 14px;
  padding: 12px;
  border-radius: 8px;
  background: #fff8e8;
  color: #725217;
}

@media(max-width:800px) {

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
    flex-direction: column;
    align-items: flex-start;
  }

  .priceChart {
    height: 260px;
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

Market and company metadata are connected.

Predictions and investment recommendations
remain disabled until their models are built
and validated.

</p>

<p id="status">
Checking connection...
</p>

<p id="error"></p>

<!-- RESEARCH -->

<section
  class="card"
  id="researchSection"
>

<h2>
Stock Research
</h2>

<p class="muted">
Enter a symbol or click any company below.
</p>

<input
  id="stockSymbol"
  placeholder="Example: HBL"
>

<div
  id="selectedCompany"
  class="companyHeader"
></div>

<div class="actions">

<button id="loadQuote">
Overview
</button>

<button id="loadHistory">
History Chart
</button>

<button id="loadFundamentals">
Fundamentals
</button>

</div>

<div id="research"></div>

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
  placeholder="Company, symbol or sector"
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
  id =>
    document.getElementById(
      id
    );

let marketRows = [];

let currentPage =
  1;

const PAGE_SIZE =
  50;

/* ---------------------------------------
   HELPERS
--------------------------------------- */

function escapeHtml(value) {
  return String(
    value ?? ''
  ).replace(
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

  return Number(
    value
  ).toLocaleString(
    'en-PK',
    {
      maximumFractionDigits:
        digits
    }
  );
}

function formatPercent(
  value
) {
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
    ) +
    '%'
  );
}

function formatDate(
  value
) {
  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }

  return date
    .toLocaleDateString(
      'en-PK',
      {
        day:
          'numeric',
        month:
          'short',
        year:
          'numeric'
      }
    );
}

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
    const [key,value]
    of Object.entries(
      params
    )
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
    await fetch(
      url
    );

  const result =
    await response.json();

  if (
    !response.ok
  ) {
    throw new Error(
      result.message ||
      'Request failed.'
    );
  }

  return result;
}

/* ---------------------------------------
   COMPANY DISPLAY
--------------------------------------- */

function showSelectedCompany(
  symbol
) {
  const stock =
    marketRows.find(
      row =>
        row.symbol ===
        symbol
    );

  if (!stock) {
    $('selectedCompany')
      .innerHTML =
        '<strong>' +
        escapeHtml(
          symbol
        ) +
        '</strong>';

    return;
  }

  $('selectedCompany')
    .innerHTML =
      '<strong>' +
      escapeHtml(
        stock.companyName
      ) +
      '</strong>' +

      '<span>' +
      escapeHtml(
        stock.symbol
      ) +
      ' • ' +
      escapeHtml(
        stock.sector
      ) +
      '</span>';
}

/* ---------------------------------------
   FILTER / SORT
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

        const searchable =
          (
            stock.symbol +
            ' ' +
            stock.companyName +
            ' ' +
            stock.sector
          )
            .toLowerCase();

        const matchesSearch =
          searchable
            .includes(
              query
            );

        const matchesSector =
          !sector ||
          stock.sector ===
            sector;

        return (
          matchesSearch &&
          matchesSector
        );
      }
    );

  rows =
    [...rows];

  switch (
    $('sort').value
  ) {

    case 'priceAsc':

      rows.sort(
        (a,b) =>
          (
            a.price ??
            Infinity
          ) -
          (
            b.price ??
            Infinity
          )
      );

      break;

    case 'priceDesc':

      rows.sort(
        (a,b) =>
          (
            b.price ??
            -Infinity
          ) -
          (
            a.price ??
            -Infinity
          )
      );

      break;

    case 'changeDesc':

      rows.sort(
        (a,b) =>
          (
            b.change1yPct ??
            -Infinity
          ) -
          (
            a.change1yPct ??
            -Infinity
          )
      );

      break;

    case 'changeAsc':

      rows.sort(
        (a,b) =>
          (
            a.change1yPct ??
            Infinity
          ) -
          (
            b.change1yPct ??
            Infinity
          )
      );

      break;

    case 'dividendDesc':

      rows.sort(
        (a,b) =>
          (
            b.dividendYield ??
            -Infinity
          ) -
          (
            a.dividendYield ??
            -Infinity
          )
      );

      break;

    case 'peAsc':

      rows =
        rows
          .filter(
            row =>
              row.peRatio !== null &&
              row.peRatio > 0
          )
          .sort(
            (a,b) =>
              a.peRatio -
              b.peRatio
          );

      break;

    case 'volumeDesc':

      rows.sort(
        (a,b) =>
          (
            b.averageVolume30d ??
            -Infinity
          ) -
          (
            a.averageVolume30d ??
            -Infinity
          )
      );

      break;

    default:

      rows.sort(
        (a,b) =>
          a.symbol
            .localeCompare(
              b.symbol
            )
      );
  }

  return rows;
}

/* ---------------------------------------
   MARKET TABLE
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
      currentPage -
      1
    ) *
    PAGE_SIZE;

  const pageRows =
    rows.slice(
      start,
      start +
      PAGE_SIZE
    );

  if (
    !pageRows.length
  ) {
    $('stocks')
      .innerHTML =
        '<p>No matching stocks.</p>';

    $('pageInfo')
      .textContent =
        '0 results';

    $('previousPage')
      .disabled =
        true;

    $('nextPage')
      .disabled =
        true;

    return;
  }

  $('stocks')
    .innerHTML =
      '<table>' +

      '<thead>' +

      '<tr>' +

      '<th>Symbol</th>' +
      '<th>Company</th>' +
      '<th>Sector</th>' +
      '<th>Price</th>' +
      '<th>P/E</th>' +
      '<th>Dividend Yield</th>' +
      '<th>30D Avg Volume</th>' +
      '<th>1Y Change</th>' +

      '</tr>' +

      '</thead>' +

      '<tbody>' +

      pageRows
        .map(
          stock => {

            const changeClass =
              stock.change1yPct >
              0
                ? 'positive'
                : stock.change1yPct <
                  0
                  ? 'negative'
                  : '';

            return (
              '<tr data-symbol="' +
              escapeHtml(
                stock.symbol
              ) +
              '">' +

              '<td class="symbol">' +
              escapeHtml(
                stock.symbol
              ) +
              '</td>' +

              '<td class="company">' +
              escapeHtml(
                stock.companyName
              ) +
              '</td>' +

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
          }
        )
        .join('') +

      '</tbody>' +

      '</table>';

  const first =
    start + 1;

  const last =
    Math.min(
      start +
      PAGE_SIZE,
      rows.length
    );

  $('pageInfo')
    .textContent =
      first +
      '-' +
      last +
      ' of ' +
      rows.length +
      ' results | Page ' +
      currentPage +
      ' of ' +
      pageCount;

  $('previousPage')
    .disabled =
      currentPage <=
      1;

  $('nextPage')
    .disabled =
      currentPage >=
      pageCount;

  document
    .querySelectorAll(
      '#stocks tbody tr'
    )
    .forEach(
      row => {

        row.onclick =
          () => {

            const symbol =
              row.dataset.symbol;

            $('stockSymbol')
              .value =
                symbol;

            showSelectedCompany(
              symbol
            );

            $('researchSection')
              .scrollIntoView({
                behavior:
                  'smooth',
                block:
                  'start'
              });
          };
      }
    );
}

/* ---------------------------------------
   SECTORS
--------------------------------------- */

function populateSectors() {
  const sectors =
    [
      ...new Set(
        marketRows
          .map(
            row =>
              row.sector
          )
          .filter(
            value =>
              value &&
              value !==
                'Unknown'
          )
      )
    ]
      .sort();

  $('sectorFilter')
    .innerHTML =
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
   MARKET LOAD
--------------------------------------- */

$('loadMarket')
  .onclick =
    async () => {

      $('error')
        .textContent =
          '';

      $('loadMarket')
        .disabled =
          true;

      try {
        const result =
          await api(
            'market'
          );

        marketRows =
          result.stocks ||
          [];

        currentPage =
          1;

        $('coverage')
          .textContent =
            result.totalStocks +
            ' usable stocks | ' +
            result.companyMetadata +
            ' company names loaded | Updated ' +
            result.asOf;

        populateSectors();

        renderStocks();

      } catch (error) {

        $('error')
          .textContent =
            error.message;

      } finally {

        $('loadMarket')
          .disabled =
            false;
      }
    };

/* ---------------------------------------
   FILTER EVENTS
--------------------------------------- */

$('search')
  .oninput =
    () => {
      currentPage =
        1;

      renderStocks();
    };

$('sectorFilter')
  .onchange =
    () => {
      currentPage =
        1;

      renderStocks();
    };

$('sort')
  .onchange =
    () => {
      currentPage =
        1;

      renderStocks();
    };

/* ---------------------------------------
   PAGINATION
--------------------------------------- */

$('previousPage')
  .onclick =
    () => {

      if (
        currentPage >
        1
      ) {
        currentPage--;

        renderStocks();
      }
    };

$('nextPage')
  .onclick =
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
      }
    };

/* ---------------------------------------
   PRICE CHART
--------------------------------------- */

function buildPriceChart(
  rows
) {
  if (
    !rows ||
    rows.length <
      2
  ) {
    return (
      '<p class="muted">' +
      'Not enough valid history to draw a chart.' +
      '</p>'
    );
  }

  const width =
    1000;

  const height =
    330;

  const paddingLeft =
    65;

  const paddingRight =
    20;

  const paddingTop =
    20;

  const paddingBottom =
    42;

  const usableWidth =
    width -
    paddingLeft -
    paddingRight;

  const usableHeight =
    height -
    paddingTop -
    paddingBottom;

  const closes =
    rows.map(
      row =>
        Number(
          row.close
        )
    );

  let min =
    Math.min(
      ...closes
    );

  let max =
    Math.max(
      ...closes
    );

  if (
    min === max
  ) {
    min *=
      .98;

    max *=
      1.02;
  }

  const range =
    max - min;

  const margin =
    range *
    .08;

  min -=
    margin;

  max +=
    margin;

  const x =
    index =>
      paddingLeft +
      (
        index /
        (
          rows.length -
          1
        )
      ) *
      usableWidth;

  const y =
    price =>
      paddingTop +
      (
        1 -
        (
          (
            price -
            min
          ) /
          (
            max -
            min
          )
        )
      ) *
      usableHeight;

  const points =
    rows
      .map(
        (
          row,
          index
        ) =>
          x(index) +
          ',' +
          y(
            row.close
          )
      )
      .join(' ');

  const firstX =
    x(0);

  const lastX =
    x(
      rows.length -
      1
    );

  const bottomY =
    paddingTop +
    usableHeight;

  const areaPoints =
    firstX +
    ',' +
    bottomY +
    ' ' +
    points +
    ' ' +
    lastX +
    ',' +
    bottomY;

  let horizontalLines =
    '';

  for (
    let index =
      0;
    index <
      5;
    index++
  ) {
    const fraction =
      index /
      4;

    const price =
      max -
      fraction *
      (
        max -
        min
      );

    const lineY =
      paddingTop +
      fraction *
      usableHeight;

    horizontalLines +=
      '<line ' +
      'x1="' +
      paddingLeft +
      '" ' +
      'x2="' +
      (
        width -
        paddingRight
      ) +
      '" ' +
      'y1="' +
      lineY +
      '" ' +
      'y2="' +
      lineY +
      '" ' +
      'class="chartAxis" />' +

      '<text ' +
      'x="5" ' +
      'y="' +
      (
        lineY +
        4
      ) +
      '" ' +
      'class="chartLabel">' +
      formatNumber(
        price,
        2
      ) +
      '</text>';
  }

  const firstDate =
    rows[0]
      .date;

  const middleDate =
    rows[
      Math.floor(
        rows.length /
        2
      )
    ].date;

  const lastDate =
    rows[
      rows.length -
      1
    ].date;

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Closing price history (PKR)' +
    '</div>' +

    '<svg ' +
    'class="priceChart" ' +
    'viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" ' +
    'preserveAspectRatio="none">' +

    horizontalLines +

    '<polygon ' +
    'points="' +
    areaPoints +
    '" ' +
    'class="chartArea" />' +

    '<polyline ' +
    'points="' +
    points +
    '" ' +
    'class="chartLine" />' +

    '<text ' +
    'x="' +
    paddingLeft +
    '" ' +
    'y="' +
    (
      height -
      8
    ) +
    '" ' +
    'class="chartLabel">' +
    escapeHtml(
      formatDate(
        firstDate
      )
    ) +
    '</text>' +

    '<text ' +
    'x="' +
    (
      width /
      2
    ) +
    '" ' +
    'y="' +
    (
      height -
      8
    ) +
    '" ' +
    'text-anchor="middle" ' +
    'class="chartLabel">' +
    escapeHtml(
      formatDate(
        middleDate
      )
    ) +
    '</text>' +

    '<text ' +
    'x="' +
    (
      width -
      paddingRight
    ) +
    '" ' +
    'y="' +
    (
      height -
      8
    ) +
    '" ' +
    'text-anchor="end" ' +
    'class="chartLabel">' +
    escapeHtml(
      formatDate(
        lastDate
      )
    ) +
    '</text>' +

    '</svg>' +

    '</div>'
  );
}

/* ---------------------------------------
   HISTORY VIEW
--------------------------------------- */

function renderHistory(
  result
) {
  const summary =
    result.summary;

  const companyName =
    result.company?.name ||
    result.symbol;

  $('selectedCompany')
    .innerHTML =
      '<strong>' +
      escapeHtml(
        companyName
      ) +
      '</strong>' +

      '<span>' +
      escapeHtml(
        result.symbol
      ) +
      (
        result.company?.sector
          ? ' • ' +
            escapeHtml(
              result.company.sector
            )
          : ''
      ) +
      '</span>';

  if (!summary) {
    $('research')
      .innerHTML =
        '<p>No valid historical price data was available.</p>';

    return;
  }

  const changeClass =
    summary.changePct >
      0
      ? 'positive'
      : summary.changePct <
        0
        ? 'negative'
        : '';

  $('research')
    .innerHTML =

      '<div class="summaryGrid">' +

      '<div class="metric">' +
      '<div class="metricLabel">Latest historical close</div>' +
      '<div class="metricValue">PKR ' +
      formatNumber(
        summary.endPrice
      ) +
      '</div>' +
      '</div>' +

      '<div class="metric">' +
      '<div class="metricLabel">Period change</div>' +
      '<div class="metricValue ' +
      changeClass +
      '">' +
      formatPercent(
        summary.changePct
      ) +
      '</div>' +
      '</div>' +

      '<div class="metric">' +
      '<div class="metricLabel">Period high</div>' +
      '<div class="metricValue">PKR ' +
      formatNumber(
        summary.high
      ) +
      '</div>' +
      '</div>' +

      '<div class="metric">' +
      '<div class="metricLabel">Period low</div>' +
      '<div class="metricValue">PKR ' +
      formatNumber(
        summary.low
      ) +
      '</div>' +
      '</div>' +

      '<div class="metric">' +
      '<div class="metricLabel">Average volume</div>' +
      '<div class="metricValue">' +
      formatNumber(
        summary.averageVolume,
        0
      ) +
      '</div>' +
      '</div>' +

      '</div>' +

      buildPriceChart(
        result.data
      ) +

      (
        summary.excludedAnomalies >
        0
          ? '<div class="warningBox">' +
            summary.excludedAnomalies +
            ' suspicious historical rows were excluded from this chart.' +
            '</div>'
          : ''
      ) +

      '<details>' +

      '<summary>' +
      'View raw historical data' +
      '</summary>' +

      '<pre>' +
      escapeHtml(
        JSON.stringify(
          result.data,
          null,
          2
        )
      ) +
      '</pre>' +

      '</details>';
}

/* ---------------------------------------
   OVERVIEW
--------------------------------------- */

$('loadQuote')
  .onclick =
    async () => {

      $('error')
        .textContent =
          '';

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      showSelectedCompany(
        symbol
      );

      try {
        const result =
          await api(
            'quote',
            {
              symbol
            }
          );

        const data =
          result.data ||
          {};

        const company =
          result.company;

        if (
          company?.name
        ) {
          $('selectedCompany')
            .innerHTML =
              '<strong>' +
              escapeHtml(
                company.name
              ) +
              '</strong>' +

              '<span>' +
              escapeHtml(
                result.symbol
              ) +
              (
                company.sector
                  ? ' • ' +
                    escapeHtml(
                      company.sector
                    )
                  : ''
              ) +
              '</span>';
        }

        $('research')
          .innerHTML =

            '<div class="summaryGrid">' +

            '<div class="metric">' +
            '<div class="metricLabel">Price</div>' +
            '<div class="metricValue">PKR ' +
            formatNumber(
              data.price
            ) +
            '</div>' +
            '</div>' +

            '<div class="metric">' +
            '<div class="metricLabel">P/E</div>' +
            '<div class="metricValue">' +
            formatNumber(
              data.pe_ratio
            ) +
            '</div>' +
            '</div>' +

            '<div class="metric">' +
            '<div class="metricLabel">Dividend yield</div>' +
            '<div class="metricValue">' +
            formatPercent(
              data.dividend_yield
            ) +
            '</div>' +
            '</div>' +

            '<div class="metric">' +
            '<div class="metricLabel">30D avg volume</div>' +
            '<div class="metricValue">' +
            formatNumber(
              data.volume_avg_30d,
              0
            ) +
            '</div>' +
            '</div>' +

            '<div class="metric">' +
            '<div class="metricLabel">1Y change</div>' +
            '<div class="metricValue ' +
            (
              data.change_1y_pct >
              0
                ? 'positive'
                : data.change_1y_pct <
                  0
                  ? 'negative'
                  : ''
            ) +
            '">' +
            formatPercent(
              data.change_1y_pct
            ) +
            '</div>' +
            '</div>' +

            '</div>' +

            '<details>' +
            '<summary>View raw quote data</summary>' +
            '<pre>' +
            escapeHtml(
              JSON.stringify(
                result,
                null,
                2
              )
            ) +
            '</pre>' +
            '</details>';

      } catch (error) {

        $('error')
          .textContent =
            error.message;
      }
    };

/* ---------------------------------------
   HISTORY BUTTON
--------------------------------------- */

$('loadHistory')
  .onclick =
    async () => {

      $('error')
        .textContent =
          '';

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      showSelectedCompany(
        symbol
      );

      $('research')
        .innerHTML =
          '<p class="muted">Loading historical chart...</p>';

      try {
        const result =
          await api(
            'history',
            {
              symbol
            }
          );

        renderHistory(
          result
        );

      } catch (error) {

        $('research')
          .innerHTML =
            '';

        $('error')
          .textContent =
            error.message;
      }
    };

/* ---------------------------------------
   FUNDAMENTALS
--------------------------------------- */

$('loadFundamentals')
  .onclick =
    async () => {

      $('error')
        .textContent =
          '';

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      showSelectedCompany(
        symbol
      );

      try {
        const result =
          await api(
            'fundamentals',
            {
              symbol
            }
          );

        if (
          result.company?.name
        ) {
          $('selectedCompany')
            .innerHTML =
              '<strong>' +
              escapeHtml(
                result.company.name
              ) +
              '</strong>' +

              '<span>' +
              escapeHtml(
                result.symbol
              ) +
              (
                result.company.sector
                  ? ' • ' +
                    escapeHtml(
                      result.company.sector
                    )
                  : ''
              ) +
              '</span>';
        }

        $('research')
          .innerHTML =
            '<details open>' +

            '<summary>' +
            'Fundamental information' +
            '</summary>' +

            '<pre>' +
            escapeHtml(
              JSON.stringify(
                result.data,
                null,
                2
              )
            ) +
            '</pre>' +

            '</details>';

      } catch (error) {

        $('error')
          .textContent =
            error.message;
      }
    };

/* ---------------------------------------
   HEALTH
--------------------------------------- */

api(
  'health'
)
  .then(
    result => {

      $('status')
        .textContent =
          'Market: connected | Company names: connected | Prediction engine: ' +
          result.predictionEngine;
    }
  )
  .catch(
    error => {

      $('status')
        .textContent =
          error.message;
    }
  );

</script>

</body>

</html>`;
}

module.exports =
  handler;

if (
  require.main ===
  module
) {
  const port =
    Number(
      process.env.PORT ||
      3000
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
