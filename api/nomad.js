'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.3.1';

const PSX_API_BASE =
  process.env.PSX_API_BASE ||
  'https://psxdata-api.fastapicloud.dev';

const PSX_META_BASE =
  process.env.PSX_META_BASE ||
  'https://psx-rest-api.onrender.com';

const PYPSX_BASE =
  process.env.PYPSX_BASE ||
  'https://paper-api.pypsx.com';

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
   GENERIC HTTP
-------------------------------------------------- */

async function fetchJSON(
  url,
  timeout = 20000,
  headers = {}
) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...headers
    },
    signal: AbortSignal.timeout(timeout)
  });

  let body = null;

  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    const message =
      body?.detail ||
      body?.error?.message ||
      `Data service returned HTTP ${response.status}.`;

    bad(
      String(message),
      response.status
    );
  }

  return body;
}

/* --------------------------------------------------
   PYPSX CONNECTION TEST
-------------------------------------------------- */

async function testPyPSX() {
  const keyId =
    process.env.PYPSX_API_KEY_ID;

  const secret =
    process.env.PYPSX_API_SECRET_KEY;

  if (
    !keyId ||
    !secret
  ) {
    bad(
      'pyPSX credentials are not configured in Vercel.',
      503
    );
  }

  const result =
    await fetchJSON(
      `${PYPSX_BASE}/intraday/HBL`,
      20000,
      {
        'PYPSX-API-KEY-ID':
          keyId,

        'PYPSX-API-SECRET-KEY':
          secret
      }
    );

  return {
    status:
      'CONNECTED',

    provider:
      'pyPSX',

    environment:
      keyId.startsWith('PK_')
        ? 'paper'
        : 'live',

    symbol:
      'HBL',

    response:
      result
  };
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
  } catch {}

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

  const result =
    await fetchJSON(
      `${PSX_API_BASE}/stocks/${encodeURIComponent(
        symbol
      )}/quote`
    );

  return {
    symbol,
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
      `${PSX_API_BASE}/stocks/${encodeURIComponent(
        symbol
      )}/historical`
    );

  return {
    symbol,
    data:
      Array.isArray(
        result.data
      )
        ? result.data
        : [],
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

  const result =
    await fetchJSON(
      `${PSX_API_BASE}/stocks/${encodeURIComponent(
        symbol
      )}/fundamentals`
    );

  return {
    symbol,
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
      action ===
      'pypsx-test'
    ) {
      return sendJSON(
        response,
        await testPyPSX()
      );
    }

    if (
      action ===
      'health'
    ) {
      return sendJSON(
        response,
        {
          version:
            VERSION,

          pyPSXConfigured:
            Boolean(
              process.env
                .PYPSX_API_KEY_ID &&
              process.env
                .PYPSX_API_SECRET_KEY
            )
        }
      );
    }

    if (
      action ===
      'market'
    ) {
      return sendJSON(
        response,
        await loadPSXMarket()
      );
    }

    if (
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
      action ===
      'history'
    ) {
      return sendJSON(
        response,
        await getHistory(
          url.searchParams.get(
            'symbol'
          )
        )
      );
    }

    if (
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

    if (
      action ===
      'app'
    ) {
      response.setHeader(
        'Content-Type',
        'text/html; charset=utf-8'
      );

      return response.end(
        page()
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
   SIMPLE UI
-------------------------------------------------- */

function page() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOMAD Invest</title>
<style>
body{
font-family:system-ui;
background:#f5f7fa;
color:#182c3e;
margin:0;
}
main{
max-width:900px;
margin:auto;
padding:30px;
}
.card{
background:white;
padding:22px;
border-radius:12px;
border:1px solid #dfe6ec;
margin:20px 0;
}
button{
background:#173f58;
color:white;
border:0;
padding:12px 18px;
border-radius:7px;
font:inherit;
cursor:pointer;
}
pre{
background:#f6f8fa;
padding:15px;
border-radius:8px;
overflow:auto;
}
</style>
</head>
<body>

<main>

<h1>NOMAD Invest</h1>

<div class="card">

<h2>pyPSX Live Data Connection Test</h2>

<p>
This only tests market-data access.
It does not place trades or connect a broker.
</p>

<button id="test">
Test pyPSX connection
</button>

<pre id="result"></pre>

</div>

</main>

<script>

const button =
document.getElementById('test');

const result =
document.getElementById('result');

button.onclick =
async () => {

button.disabled = true;

result.textContent =
'Testing pyPSX...';

try {

const url =
new URL(location.href);

url.searchParams.set(
'action',
'pypsx-test'
);

const response =
await fetch(url);

const data =
await response.json();

result.textContent =
JSON.stringify(
data,
null,
2
);

} catch(error) {

result.textContent =
error.message;

} finally {

button.disabled = false;

}

};

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
      '127.0.0.1'
    );
}
