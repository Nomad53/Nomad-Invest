'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.5.0';

const PSX_API_BASE =
  process.env.PSX_API_BASE ||
  'https://psxdata-api.fastapicloud.dev';

const PSX_META_BASE =
  process.env.PSX_META_BASE ||
  'https://psx-rest-api.onrender.com';

const PSX_DPS_BASE =
  process.env.PSX_DPS_BASE ||
  'https://dps.psx.com.pk';

const PSX_ELIGIBLE_SCRIPS_URL =
  `${PSX_DPS_BASE}/eligible-scrips`;

const PYPSX_API_KEY_ID =
  process.env.PYPSX_API_KEY_ID ||
  '';

const PYPSX_API_SECRET_KEY =
  process.env.PYPSX_API_SECRET_KEY ||
  '';

function getPyPSXBase() {
  if (process.env.PYPSX_BASE) {
    return process.env.PYPSX_BASE;
  }

  return PYPSX_API_KEY_ID.startsWith('AK_')
    ? 'https://api.pypsx.com'
    : 'https://paper-api.pypsx.com';
}

let marketCache = null;
let sectorCache = null;
let companyCache = null;
const companyPageCache = new Map();

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

  const normalized = String(value)
    .replace(/,/g, '')
    .replace(/%/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .trim();

  if (
    !normalized ||
    normalized === '-' ||
    /^n\/?a$/i.test(normalized)
  ) {
    return null;
  }

  const parsed = Number(normalized);

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

function absoluteURL(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return null;
  }

  try {
    return new URL(raw, PSX_DPS_BASE).toString();
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    );
}

function cleanHtmlCell(value) {
  return decodeHtml(
    String(value || '')
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        ''
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        ''
      )
      .replace(
        /<[^>]+>/g,
        ' '
      )
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToLines(html) {
  return decodeHtml(
    String(html || '')
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        ''
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        ''
      )
      .replace(
        /<br\s*\/?\s*>/gi,
        '\n'
      )
      .replace(
        /<\/(?:div|p|td|th|tr|li|h1|h2|h3|h4|h5|section|article)>/gi,
        '\n'
      )
      .replace(
        /<[^>]+>/g,
        ' '
      )
  )
    .split(/\r?\n/)
    .map(value =>
      value
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

function findLineValue(
  lines,
  label,
  occurrence = 0
) {
  const target =
    String(label || '')
      .toLowerCase();

  let seen = 0;

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const line =
      String(
        lines[index] || ''
      )
        .toLowerCase();

    if (
      !line.includes(target)
    ) {
      continue;
    }

    if (
      seen < occurrence
    ) {
      seen += 1;
      continue;
    }

    const sameLine =
      lines[index]
        .replace(
          new RegExp(
            escapeRegExp(label),
            'i'
          ),
          ''
        )
        .replace(
          /^[:\s-]+/,
          ''
        )
        .trim();

    if (sameLine) {
      return sameLine;
    }

    for (
      let candidateIndex =
        index + 1;

      candidateIndex <
        Math.min(
          lines.length,
          index + 5
        );

      candidateIndex += 1
    ) {
      const candidate =
        lines[candidateIndex];

      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function findNumericAfterLabel(
  lines,
  label,
  occurrence = 0
) {
  const value =
    findLineValue(
      lines,
      label,
      occurrence
    );

  if (!value) {
    return null;
  }

  const match =
    String(value)
      .match(
        /\(?-?[\d,.]+(?:\.\d+)?\)?/
      );

  return match
    ? safeNumber(match[0])
    : null;
}

function dateLike(value) {
  return (
    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i
      .test(
        String(value || '')
          .trim()
      ) ||
    /^\d{4}-\d{2}-\d{2}$/
      .test(
        String(value || '')
          .trim()
      )
  );
}

function parseHTMLTables(html) {
  const tables = [];

  const tableRegex =
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  let tableMatch;

  while (
    (
      tableMatch =
        tableRegex.exec(
          String(html || '')
        )
    ) !== null
  ) {
    const tableHtml =
      tableMatch[1];

    const rows = [];

    const rowRegex =
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

    let rowMatch;

    while (
      (
        rowMatch =
          rowRegex.exec(
            tableHtml
          )
      ) !== null
    ) {
      const rowHtml =
        rowMatch[1];

      const cells = [];

      const cellRegex =
        /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;

      let cellMatch;

      while (
        (
          cellMatch =
            cellRegex.exec(
              rowHtml
            )
        ) !== null
      ) {
        cells.push(
          cleanHtmlCell(
            cellMatch[1]
          )
        );
      }

      if (cells.length) {
        const anchorMatch =
          rowHtml.match(
            /<a\b[^>]*href=["']([^"']+)["'][^>]*>/i
          );

        rows.push({
          cells,

          href:
            anchorMatch
              ? absoluteURL(
                  anchorMatch[1]
                )
              : null
        });
      }
    }

    if (rows.length) {
      tables.push({
        rows,
        start:
          tableMatch.index
      });
    }
  }

  return tables;
}

function tableToMatrix(table) {
  return table.rows
    .map(
      row =>
        row.cells
    );
}

function classifyCompanyTable(
  table
) {
  const matrix =
    tableToMatrix(table);

  const flattened =
    matrix
      .flat()
      .join(' | ')
      .toLowerCase();

  if (
    flattened.includes(
      'profit after taxation'
    ) &&
    flattened.includes(
      'eps'
    )
  ) {
    const header =
      matrix[0] || [];

    const headerText =
      header.join(' ');

    return /^.*\bq[1-4]\b/i
      .test(headerText)
        ? 'financial-quarterly'
        : 'financial-annual';
  }

  if (
    flattened.includes(
      'net profit margin'
    ) ||
    flattened.includes(
      'eps growth'
    ) ||
    flattened.includes(
      'return on equity'
    ) ||
    flattened.includes(
      'roe'
    ) ||
    flattened.includes(
      'price/book'
    ) ||
    flattened.includes(
      'p/b'
    ) ||
    flattened.includes(
      'peg'
    )
  ) {
    return 'ratios';
  }

  const dateRows =
    table.rows
      .filter(
        row =>
          dateLike(
            row.cells[0]
          )
      );

  if (
    dateRows.length >= 1
  ) {
    return 'announcements';
  }

  return 'other';
}

function normalizeFinancialTable(
  table
) {
  const matrix =
    tableToMatrix(
      table
    );

  if (!matrix.length) {
    return null;
  }

  const header =
    matrix[0];

  const periods =
    header
      .slice(1)
      .filter(Boolean);

  if (!periods.length) {
    return null;
  }

  const rows = [];

  for (
    const row
    of matrix.slice(1)
  ) {
    const label =
      String(
        row[0] || ''
      ).trim();

    if (!label) {
      continue;
    }

    const values =
      periods.map(
        (
          period,
          index
        ) => ({
          period,

          raw:
            row[
              index + 1
            ] ?? '',

          value:
            safeNumber(
              row[
                index + 1
              ]
            )
        })
      );

    rows.push({
      label,
      values
    });
  }

  return {
    periods,
    rows
  };
}

function normalizeRatioTable(
  table
) {
  return normalizeFinancialTable(
    table
  );
}

function inferAnnouncementType(
  title
) {
  const text =
    String(
      title || ''
    )
      .toLowerCase();

  if (
    text.includes(
      'board meeting'
    ) ||
    text.includes(
      'annual general meeting'
    ) ||
    text.includes(
      'extraordinary general meeting'
    ) ||
    text.includes(
      'eogm'
    ) ||
    text.includes(
      'agm'
    )
  ) {
    return 'Meeting';
  }

  if (
    text.includes(
      'financial result'
    ) ||
    text.includes(
      'quarterly'
    ) ||
    text.includes(
      'half year'
    ) ||
    text.includes(
      'annual report'
    ) ||
    text.includes(
      'financial statement'
    ) ||
    text.includes(
      'transmission of'
    )
  ) {
    return 'Financial';
  }

  if (
    text.includes(
      'dividend'
    ) ||
    text.includes(
      'bonus'
    ) ||
    text.includes(
      'right issue'
    ) ||
    text.includes(
      'book closure'
    )
  ) {
    return 'Payout';
  }

  return 'Corporate';
}

function normalizeAnnouncementRows(
  tables
) {
  const announcements = [];

  for (
    const table
    of tables
  ) {
    if (
      classifyCompanyTable(
        table
      ) !==
      'announcements'
    ) {
      continue;
    }

    for (
      const row
      of table.rows
    ) {
      if (
        !dateLike(
          row.cells[0]
        )
      ) {
        continue;
      }

      const date =
        row.cells[0] || '';

      const title =
        row.cells[1] ||
        row.cells[2] ||
        '';

      if (!title) {
        continue;
      }

      announcements.push({
        date,

        type:
          inferAnnouncementType(
            title
          ),

        title,

        documentUrl:
          row.href
      });
    }
  }

  announcements.sort(
    (
      a,
      b
    ) => {
      const aTime =
        Date.parse(
          a.date
        ) || 0;

      const bTime =
        Date.parse(
          b.date
        ) || 0;

      return (
        bTime -
        aTime
      );
    }
  );

  const seen =
    new Set();

  return announcements
    .filter(
      item => {
        const key =
          `${item.date}|${item.title}`;

        if (
          seen.has(key)
        ) {
          return false;
        }

        seen.add(key);

        return true;
      }
    );
}

function parsePSXCompanyPage(
  html,
  symbol
) {
  const lines =
    htmlToLines(html);

  const tables =
    parseHTMLTables(
      html
    );

  const titleMatch =
    String(
      html || ''
    ).match(
      /<title>\s*[^<]*?Stock quote for\s+(.+?)\s+-\s+Pakistan Stock Exchange/i
    );

  const companyName =
    titleMatch
      ? cleanHtmlCell(
          titleMatch[1]
        )
      : null;

  let sectorName =
    null;

  if (companyName) {
    const companyLineIndex =
      lines.findIndex(
        line =>
          String(
            line || ''
          )
            .trim()
            .toLowerCase() ===
          companyName
            .toLowerCase()
      );

    if (
      companyLineIndex >= 0
    ) {
      for (
        let index =
          companyLineIndex +
          1;

        index <
          Math.min(
            lines.length,
            companyLineIndex +
              8
          );

        index += 1
      ) {
        const candidate =
          String(
            lines[index] || ''
          ).trim();

        if (
          candidate &&
          candidate !==
            symbol &&
          candidate.length <=
            120 &&
          candidate ===
            candidate
              .toUpperCase() &&
          !/^(QUOTE|PROFILE|EQUITY|ANNOUNCEMENTS|FINANCIALS|RATIOS|PAYOUTS|REPORTS|REG|DFC|CSF|ODL)$/i
            .test(
              candidate
            ) &&
          !/^RS\.?/i
            .test(
              candidate
            ) &&
          !/^PKR\b/i
            .test(
              candidate
            ) &&
          !/^\d/
            .test(
              candidate
            )
        ) {
          sectorName =
            candidate;

          break;
        }
      }
    }
  }

  let annual =
    null;

  let quarterly =
    null;

  let ratios =
    null;

  for (
    const table
    of tables
  ) {
    const type =
      classifyCompanyTable(
        table
      );

    if (
      type ===
        'financial-annual' &&
      !annual
    ) {
      annual =
        normalizeFinancialTable(
          table
        );
    }

    if (
      type ===
        'financial-quarterly' &&
      !quarterly
    ) {
      quarterly =
        normalizeFinancialTable(
          table
        );
    }

    if (
      type ===
        'ratios' &&
      !ratios
    ) {
      ratios =
        normalizeRatioTable(
          table
        );
    }
  }

  const marketCapThousands =
    findNumericAfterLabel(
      lines,
      "Market Cap (000's)"
    ) ??
    findNumericAfterLabel(
      lines,
      'Market Cap'
    );

  const shares =
    findNumericAfterLabel(
      lines,
      'Shares'
    );

  const firstFreeFloat =
    findNumericAfterLabel(
      lines,
      'Free Float',
      0
    );

  const secondFreeFloat =
    findNumericAfterLabel(
      lines,
      'Free Float',
      1
    );

  let freeFloatShares =
    firstFreeFloat;

  let freeFloatPercent =
    secondFreeFloat;

  if (
    freeFloatShares !==
      null &&
    freeFloatShares <=
      100 &&
    freeFloatPercent !==
      null &&
    freeFloatPercent >
      100
  ) {
    const swap =
      freeFloatShares;

    freeFloatShares =
      freeFloatPercent;

    freeFloatPercent =
      swap;
  }

  if (
    freeFloatPercent ===
      null &&
    freeFloatShares !==
      null &&
    freeFloatShares <=
      100
  ) {
    freeFloatPercent =
      freeFloatShares;

    freeFloatShares =
      null;
  }

  return {
    symbol,
    companyName,
    sectorName,

    sourceUrl:
      `${PSX_DPS_BASE}/company/${encodeURIComponent(
        symbol
      )}`,

    fetchedAt:
      new Date()
        .toISOString(),

    equity: {
      marketCapThousands,

      marketCapPkr:
        marketCapThousands !==
          null
          ? marketCapThousands *
            1000
          : null,

      shares,
      freeFloatShares,
      freeFloatPercent
    },

    annual,
    quarterly,
    ratios,

    announcements:
      normalizeAnnouncementRows(
        tables
      ).slice(
        0,
        25
      )
  };
}

function rangeStartDate(
  range
) {
  const now =
    new Date();

  const date =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
      )
    );

  switch (
    String(
      range || ''
    ).toUpperCase()
  ) {
    case '1M':
      date.setUTCMonth(
        date.getUTCMonth() -
          1
      );
      break;

    case '6M':
      date.setUTCMonth(
        date.getUTCMonth() -
          6
      );
      break;

    case '1Y':
      date.setUTCFullYear(
        date.getUTCFullYear() -
          1
      );
      break;

    case '2Y':
      date.setUTCFullYear(
        date.getUTCFullYear() -
          2
      );
      break;

    case 'ALL':
      return null;

    default:
      date.setUTCFullYear(
        date.getUTCFullYear() -
          1
      );
  }

  return date
    .toISOString()
    .slice(
      0,
      10
    );
}

/* --------------------------------------------------
   HTTP
-------------------------------------------------- */

async function fetchJSON(
  url,
  timeout = 20000,
  headers = {}
) {
  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            'application/json',

          ...headers
        },

        signal:
          AbortSignal
            .timeout(
              timeout
            )
      }
    );

  if (!response.ok) {
    let message =
      `Data service returned HTTP ${response.status}.`;

    try {
      const body =
        await response
          .json();

      if (
        body?.error
          ?.message
      ) {
        message =
          body.error
            .message;
      }

      if (
        body?.detail
      ) {
        message =
          String(
            body.detail
          );
      }
    } catch {}

    bad(
      message,
      response.status
    );
  }

  return response
    .json();
}

async function fetchText(
  url,
  timeout = 20000,
  headers = {}
) {
  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml',

          'User-Agent':
            'Mozilla/5.0 NOMAD-Invest/0.5.0',

          ...headers
        },

        signal:
          AbortSignal
            .timeout(
              timeout
            )
      }
    );

  if (!response.ok) {
    bad(
      `Data service returned HTTP ${response.status}.`,
      response.status
    );
  }

  return response
    .text();
}

async function getPSXCompanySnapshot(
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

  const cached =
    companyPageCache
      .get(
        symbol
      );

  if (
    cached &&
    Date.now() -
      cached.fetchedAt <
      30 *
      60 *
      1000
  ) {
    return cached.data;
  }

  const html =
    await fetchText(
      `${PSX_DPS_BASE}/company/${encodeURIComponent(
        symbol
      )}`,
      30000,
      {
        Referer:
          `${PSX_DPS_BASE}/`
      }
    );

  const data =
    parsePSXCompanyPage(
      html,
      symbol
    );

  companyPageCache
    .set(
      symbol,
      {
        fetchedAt:
          Date.now(),

        data
      }
    );

  return data;
}

/* --------------------------------------------------
   PYPSX MARKET DATA
-------------------------------------------------- */

function pyPSXHeaders() {
  if (
    !PYPSX_API_KEY_ID ||
    !PYPSX_API_SECRET_KEY
  ) {
    bad(
      'pyPSX credentials are not configured.',
      503
    );
  }

  return {
    'PYPSX-API-KEY-ID':
      PYPSX_API_KEY_ID,

    'PYPSX-API-SECRET-KEY':
      PYPSX_API_SECRET_KEY
  };
}

function extractPyPSXRows(
  result
) {
  if (
    Array.isArray(
      result
    )
  ) {
    return result;
  }

  if (
    Array.isArray(
      result?.data
    )
  ) {
    return result.data;
  }

  if (
    Array.isArray(
      result?.candles
    )
  ) {
    return result.candles;
  }

  if (
    Array.isArray(
      result?.results
    )
  ) {
    const first =
      result.results[0];

    if (
      Array.isArray(
        first?.candles
      )
    ) {
      return first.candles;
    }
  }

  return [];
}

function normalizePyPSXRow(
  row
) {
  if (
    Array.isArray(
      row
    )
  ) {
    return {
      timestamp:
        row[0] || null,

      open:
        safeNumber(
          row[1]
        ),

      high:
        safeNumber(
          row[2]
        ),

      low:
        safeNumber(
          row[3]
        ),

      close:
        safeNumber(
          row[4]
        ),

      volume:
        safeNumber(
          row[5]
        )
    };
  }

  return {
    timestamp:
      row?.datetime ||
      row?.timestamp ||
      row?.ts ||
      row?.time ||
      row?.date ||
      null,

    open:
      safeNumber(
        row?.open ??
        row?.o
      ),

    high:
      safeNumber(
        row?.high ??
        row?.h
      ),

    low:
      safeNumber(
        row?.low ??
        row?.l
      ),

    close:
      safeNumber(
        row?.close ??
        row?.price ??
        row?.last ??
        row?.p
      ),

    volume:
      safeNumber(
        row?.volume ??
        row?.v
      )
  };
}

function pyPSXTimeValue(
  value
) {
  if (
    typeof value ===
      'number' &&
    Number.isFinite(
      value
    )
  ) {
    return value >
      100000000000
        ? value
        : value *
          1000;
  }

  const parsed =
    Date.parse(
      value
    );

  return Number
    .isFinite(
      parsed
    )
      ? parsed
      : 0;
}

function karachiDateKey(
  value
) {
  const timestamp =
    pyPSXTimeValue(
      value
    );

  if (!timestamp) {
    return '';
  }

  const parts =
    new Intl
      .DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Karachi',

          year:
            'numeric',

          month:
            '2-digit',

          day:
            '2-digit'
        }
      )
      .formatToParts(
        new Date(
          timestamp
        )
      );

  const get =
    type =>
      parts.find(
        part =>
          part.type ===
          type
      )?.value || '';

  return (
    get('year') +
    '-' +
    get('month') +
    '-' +
    get('day')
  );
}

async function getPyPSXMarketStatus() {
  try {
    const result =
      await fetchJSON(
        `${getPyPSXBase()}/market/status`,
        12000,
        pyPSXHeaders()
      );

    return {
      known:
        true,

      isOpen:
        result?.is_open ===
        true,

      status:
        String(
          result?.status ||
          ''
        ),

      statusText:
        String(
          result
            ?.status_text ||
          (
            result
              ?.is_open ===
            true
              ? 'Market Open'
              : 'Market Closed'
          )
        ),

      holidayName:
        result
          ?.holiday_name ||
        null
    };
  } catch {
    return {
      known:
        false,

      isOpen:
        false,

      status:
        'UNKNOWN',

      statusText:
        'Market status unavailable',

      holidayName:
        null
    };
  }
}

async function getPyPSXIntraday(
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
    raw,
    marketStatus
  ] =
    await Promise.all([
      fetchJSON(
        `${getPyPSXBase()}/intraday/${encodeURIComponent(
          symbol
        )}`,
        20000,
        pyPSXHeaders()
      ),

      getPyPSXMarketStatus()
    ]);

  const rows =
    extractPyPSXRows(
      raw
    )
      .map(
        normalizePyPSXRow
      )
      .filter(
        row =>
          row.close !==
            null &&
          row.close > 0 &&
          pyPSXTimeValue(
            row.timestamp
          ) > 0
      )
      .sort(
        (
          a,
          b
        ) =>
          pyPSXTimeValue(
            a.timestamp
          ) -
          pyPSXTimeValue(
            b.timestamp
          )
      );

  if (!rows.length) {
    bad(
      `pyPSX returned no intraday price data for ${symbol}.`,
      502
    );
  }

  const latest =
    rows[
      rows.length -
      1
    ];

  const latestSessionKey =
    karachiDateKey(
      latest.timestamp
    );

  const sessionRows =
    rows.filter(
      row =>
        karachiDateKey(
          row.timestamp
        ) ===
        latestSessionKey
    );

  const latestTimestamp =
    pyPSXTimeValue(
      latest.timestamp
    );

  const ageSeconds =
    Math.max(
      0,
      Math.round(
        (
          Date.now() -
          latestTimestamp
        ) /
        1000
      )
    );

  let feedState =
    'LATEST';

  let feedLabel =
    'Latest available';

  if (
    marketStatus.known &&
    marketStatus.isOpen &&
    ageSeconds <=
      180
  ) {
    feedState =
      'LIVE';

    feedLabel =
      'Live';
  } else if (
    marketStatus.known &&
    marketStatus.isOpen
  ) {
    feedState =
      'DELAYED';

    feedLabel =
      'Delayed market data';
  } else if (
    marketStatus.known &&
    !marketStatus.isOpen
  ) {
    feedState =
      'CLOSED';

    feedLabel =
      'Last market price';
  }

  const normalizedSessionRows =
    sessionRows.map(
      row => {
        const close =
          row.close;

        const open =
          row.open ??
          close;

        const high =
          row.high ??
          Math.max(
            open,
            close
          );

        const low =
          row.low ??
          Math.min(
            open,
            close
          );

        return {
          timestamp:
            new Date(
              pyPSXTimeValue(
                row.timestamp
              )
            ).toISOString(),

          open,

          high:
            Math.max(
              high,
              open,
              close
            ),

          low:
            Math.min(
              low,
              open,
              close
            ),

          close,

          volume:
            row.volume ||
            0
        };
      }
    );

  const totalVolume =
    normalizedSessionRows
      .map(
        row =>
          row.volume ||
          0
      )
      .reduce(
        (
          sum,
          value
        ) =>
          sum +
          value,
        0
      );

  return {
    symbol,

    provider:
      'pyPSX',

    sourceType:
      '1-minute intraday candles',

    marketStatus,
    feedState,
    feedLabel,

    price:
      latest.close,

    timestamp:
      new Date(
        latestTimestamp
      ).toISOString(),

    ageSeconds,

    sessionDate:
      latestSessionKey,

    session: {
      open:
        normalizedSessionRows[
          0
        ]?.open ??
        normalizedSessionRows[
          0
        ]?.close ??
        null,

      high:
        normalizedSessionRows
          .length
          ? Math.max(
              ...normalizedSessionRows
                .map(
                  row =>
                    row.high
                )
            )
          : null,

      low:
        normalizedSessionRows
          .length
          ? Math.min(
              ...normalizedSessionRows
                .map(
                  row =>
                    row.low
                )
            )
          : null,

      close:
        latest.close,

      volume:
        totalVolume,

      candles:
        normalizedSessionRows
          .length
    },

    data:
      normalizedSessionRows
  };
}

/* --------------------------------------------------
   COMPANY / SECTOR METADATA
-------------------------------------------------- */

async function loadOfficialSymbolsMap() {
  const map =
    new Map();

  try {
    const response =
      await fetchJSON(
        `${PSX_DPS_BASE}/symbols`,
        30000,
        {
          'User-Agent':
            'Mozilla/5.0 NOMAD-Invest/0.5.0',

          Referer:
            `${PSX_DPS_BASE}/`,

          'X-Requested-With':
            'XMLHttpRequest'
        }
      );

    const rows =
      Array.isArray(
        response
      )
        ? response
        : Array.isArray(
            response?.data
          )
          ? response.data
          : [];

    for (
      const row
      of rows
    ) {
      const symbol =
        normalizeSymbol(
          row?.symbol ||
          row?.SYMBOL ||
          row?.ticker ||
          row?.code
        );

      const name =
        String(
          row?.name ||
          row?.companyName ||
          row?.company_name ||
          ''
        ).trim();

      const sector =
        String(
          row?.sectorName ||
          row?.sector_name ||
          row?.sector ||
          ''
        ).trim();

      if (!symbol) {
        continue;
      }

      map.set(
        symbol,
        {
          name:
            name ||
            symbol,

          sector,

          source:
            'PSX symbols'
        }
      );
    }
  } catch {}

  return map;
}

async function loadCompanyMap() {
  if (
    companyCache &&
    Date.now() -
      companyCache.fetchedAt <
      6 *
      60 *
      60 *
      1000
  ) {
    return companyCache.data;
  }

  const map =
    await loadOfficialSymbolsMap();

  try {
    const html =
      await fetchText(
        PSX_ELIGIBLE_SCRIPS_URL,
        30000
      );

    const rowRegex =
      /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

    let rowMatch;

    while (
      (
        rowMatch =
          rowRegex.exec(
            html
          )
      ) !== null
    ) {
      const cells = [];

      const cellRegex =
        /<td[^>]*>([\s\S]*?)<\/td>/gi;

      let cellMatch;

      while (
        (
          cellMatch =
            cellRegex.exec(
              rowMatch[1]
            )
        ) !== null
      ) {
        cells.push(
          cleanHtmlCell(
            cellMatch[1]
          )
        );
      }

      if (
        cells.length <
        2
      ) {
        continue;
      }

      const symbol =
        normalizeSymbol(
          cells[0]
        );

      const name =
        String(
          cells[1] ||
          ''
        ).trim();

      if (
        !symbol ||
        !name ||
        symbol ===
          'SYMBOL' ||
        name
          .toLowerCase() ===
          'name'
      ) {
        continue;
      }

      if (
        /^[A-Z0-9.-]{1,20}$/
          .test(
            symbol
          )
      ) {
        const existing =
          map.get(
            symbol
          );

        map.set(
          symbol,
          {
            name:
              existing?.name &&
              existing.name !==
                symbol
                ? existing.name
                : name,

            sector:
              existing
                ?.sector ||
              '',

            source:
              existing
                ?.source ||
              'PSX eligible scrips'
          }
        );
      }
    }
  } catch {}

  try {
    const response =
      await fetchJSON(
        `${getPyPSXBase()}/symbols`,
        20000,
        pyPSXHeaders()
      );

    const rows =
      Array.isArray(
        response
      )
        ? response
        : Array.isArray(
            response?.data
          )
          ? response.data
          : Array.isArray(
              response?.symbols
            )
            ? response.symbols
            : [];

    for (
      const row
      of rows
    ) {
      if (
        !row ||
        typeof row ===
          'string'
      ) {
        continue;
      }

      const symbol =
        normalizeSymbol(
          row.symbol ||
          row.ticker ||
          row.code
        );

      const name =
        String(
          row.name ||
          row.company_name ||
          row.companyName ||
          ''
        ).trim();

      if (
        !symbol ||
        !name
      ) {
        continue;
      }

      const existing =
        map.get(
          symbol
        );

      map.set(
        symbol,
        {
          name:
            existing?.name &&
            existing.name !==
              symbol
              ? existing.name
              : name,

          sector:
            existing
              ?.sector ||
            String(
              row.sector ||
              ''
            ).trim(),

          source:
            existing
              ?.source ||
            'pyPSX symbols'
        }
      );
    }
  } catch {}

  try {
    const response =
      await fetchJSON(
        `${PSX_META_BASE}/symbols?limit=5000`,
        30000
      );

    const rows =
      Array.isArray(
        response
      )
        ? response
        : Array.isArray(
            response?.data
          )
          ? response.data
          : [];

    for (
      const row
      of rows
    ) {
      const symbol =
        normalizeSymbol(
          row.symbol
        );

      if (!symbol) {
        continue;
      }

      const existing =
        map.get(
          symbol
        );

      const fallbackName =
        String(
          row.name ||
          symbol
        ).trim();

      const fallbackSector =
        String(
          row.sector ||
          ''
        ).trim();

      map.set(
        symbol,
        {
          name:
            existing?.name &&
            existing.name !==
              symbol
              ? existing.name
              : fallbackName,

          sector:
            existing
              ?.sector ||
            fallbackSector,

          source:
            existing
              ?.source ||
            'psx-rest-api'
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

async function loadSectorMap() {
  if (
    sectorCache &&
    Date.now() -
      sectorCache.fetchedAt <
      3600000
  ) {
    return sectorCache.data;
  }

  const map =
    new Map();

  try {
    const companyMap =
      await loadCompanyMap();

    for (
      const [
        symbol,
        metadata
      ]
      of companyMap.entries()
    ) {
      if (
        metadata?.sector
      ) {
        map.set(
          symbol,
          metadata.sector
        );
      }
    }
  } catch {}

  try {
    const response =
      await fetchJSON(
        `${PSX_API_BASE}/sectors`
      );

    if (
      Array.isArray(
        response.data
      )
    ) {
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
              typeof item ===
                'string'
                ? normalizeSymbol(
                    item
                  )
                : normalizeSymbol(
                    item.symbol ||
                    item.SYMBOL ||
                    item.ticker
                  );

            if (
              symbol &&
              !map.has(
                symbol
              )
            ) {
              map.set(
                symbol,
                sectorName
              );
            }
          }
        } catch {}
      }
    }
  } catch {}

  sectorCache = {
    fetchedAt:
      Date.now(),

    data:
      map
  };

  return map;
}

/* --------------------------------------------------
   SCREENER / MARKET
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
      screener
        ?.meta
        ?.timestamp
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
      .filter(
        Boolean
      );

  if (!stocks.length) {
    bad(
      'No usable PSX market records were returned.',
      502
    );
  }

  const companyNamesMatched =
    stocks.filter(
      stock =>
        stock.companyName &&
        stock.companyName !==
          stock.symbol
    ).length;

  const sectorsMatched =
    stocks.filter(
      stock =>
        stock.sector &&
        stock.sector !==
          'Unknown'
    ).length;

  const result = {
    sourceName:
      'psxdata-api',

    companyNamesMatched,

    sectorsMatched,

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
   STOCK QUOTE / DECISION OVERVIEW
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

  const now =
    new Date();

  const historyStartDate =
    new Date(
      now.getTime() -
      370 *
      24 *
      60 *
      60 *
      1000
    )
      .toISOString()
      .slice(
        0,
        10
      );

  const historyEndDate =
    now
      .toISOString()
      .slice(
        0,
        10
      );

  const historyURL =
    `${PSX_API_BASE}/stocks/${encodeURIComponent(
      symbol
    )}/historical` +
    `?start=${encodeURIComponent(
      historyStartDate
    )}` +
    `&end=${encodeURIComponent(
      historyEndDate
    )}`;

  const [
    result,
    companyMap,
    sectorMap,
    liveResult,
    historyResult,
    companySnapshot
  ] =
    await Promise.all([
      fetchJSON(
        `${PSX_API_BASE}/stocks/${encodeURIComponent(
          symbol
        )}/quote`
      ),

      loadCompanyMap(),

      loadSectorMap(),

      getPyPSXIntraday(
        symbol
      ).catch(
        () => null
      ),

      fetchJSON(
        historyURL
      ).catch(
        () => null
      ),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      )
    ]);

  const company =
    companyMap.get(
      symbol
    );

  const data =
    result.data ||
    {};

  const quotePrice =
    safeNumber(
      data.price
    );

  const currentPrice =
    safeNumber(
      liveResult?.price
    ) ??
    quotePrice;

  let dayChangePct =
    safeNumber(
      data.change_pct
    );

  let previousClose =
    safeNumber(
      data.ldcp
    );

  if (
    previousClose ===
      null &&
    quotePrice !==
      null &&
    dayChangePct !==
      null
  ) {
    const denominator =
      1 +
      dayChangePct /
      100;

    if (
      Number.isFinite(
        denominator
      ) &&
      Math.abs(
        denominator
      ) >
      0.000001
    ) {
      previousClose =
        quotePrice /
        denominator;
    }
  }

  let dayChange =
    safeNumber(
      data.change
    );

  if (
    dayChange ===
      null &&
    currentPrice !==
      null &&
    previousClose !==
      null
  ) {
    dayChange =
      currentPrice -
      previousClose;
  }

  if (
    dayChangePct ===
      null &&
    dayChange !==
      null &&
    previousClose !==
      null &&
    previousClose !==
      0
  ) {
    dayChangePct =
      (
        dayChange /
        previousClose
      ) *
      100;
  }

  const historicalRows =
    Array.isArray(
      historyResult?.data
    )
      ? historyResult.data
          .map(
            row => ({
              date:
                String(
                  row.date ||
                  ''
                ),

              close:
                safeNumber(
                  row.close
                ),

              high:
                safeNumber(
                  row.high
                ),

              low:
                safeNumber(
                  row.low
                ),

              isAnomaly:
                row.is_anomaly ===
                true
            })
          )
          .filter(
            row =>
              row.date &&
              !row.isAnomaly &&
              row.close !==
                null &&
              row.close > 0 &&
              row.high !==
                null &&
              row.high > 0 &&
              row.low !==
                null &&
              row.low > 0
          )
          .sort(
            (
              a,
              b
            ) =>
              a.date
                .localeCompare(
                  b.date
                )
          )
      : [];

  const ytdStartKey =
    `${now.getUTCFullYear()}-01-01`;

  const ytdRows =
    historicalRows
      .filter(
        row =>
          row.date >=
          ytdStartKey
      );

  const ytdStartClose =
    ytdRows[0]
      ?.close ??
    null;

  const ytdChangePct =
    currentPrice !==
      null &&
    ytdStartClose !==
      null &&
    ytdStartClose !==
      0
      ? (
          (
            currentPrice -
            ytdStartClose
          ) /
          ytdStartClose
        ) *
        100
      : null;

  const range52StartKey =
    new Date(
      now.getTime() -
      365 *
      24 *
      60 *
      60 *
      1000
    )
      .toISOString()
      .slice(
        0,
        10
      );

  const range52Rows =
    historicalRows
      .filter(
        row =>
          row.date >=
          range52StartKey
      );

  const range52High =
    range52Rows.length
      ? Math.max(
          ...range52Rows
            .map(
              row =>
                row.high
            )
        )
      : null;

  const range52Low =
    range52Rows.length
      ? Math.min(
          ...range52Rows
            .map(
              row =>
                row.low
            )
        )
      : null;

  const averageVolume30d =
    safeNumber(
      data.volume_avg_30d
    );

  const sessionVolume =
    safeNumber(
      liveResult
        ?.session
        ?.volume
    );

  const volumeVsAveragePct =
    sessionVolume !==
      null &&
    averageVolume30d !==
      null &&
    averageVolume30d >
      0
      ? (
          sessionVolume /
          averageVolume30d
        ) *
        100
      : null;

  const resolvedName =
    companySnapshot
      ?.companyName ||
    company?.name ||
    symbol;

  const resolvedSector =
    companySnapshot
      ?.sectorName ||
    company?.sector ||
    sectorMap.get(
      symbol
    ) ||
    '';

  return {
    symbol,

    company: {
      ...(company || {}),

      name:
        resolvedName,

      sector:
        resolvedSector
    },

    data,

    meta:
      result.meta ||
      null,

    live:
      liveResult,

    official:
      companySnapshot
        ? {
            equity:
              companySnapshot
                .equity,

            sourceUrl:
              companySnapshot
                .sourceUrl,

            fetchedAt:
              companySnapshot
                .fetchedAt
          }
        : null,

    decision: {
      price:
        currentPrice,

      previousClose,

      dayChange,

      dayChangePct,

      session:
        liveResult
          ?.session ||
        null,

      marketStatus:
        liveResult
          ?.marketStatus ||
        null,

      feedState:
        liveResult
          ?.feedState ||
        null,

      feedLabel:
        liveResult
          ?.feedLabel ||
        null,

      priceTimestamp:
        liveResult
          ?.timestamp ||
        result
          ?.meta
          ?.timestamp ||
        null,

      ytdChangePct,

      change1yPct:
        safeNumber(
          data.change_1y_pct
        ),

      range52: {
        low:
          range52Low,

        high:
          range52High
      },

      peRatio:
        (() => {
          const pe =
            safeNumber(
              data.pe_ratio
            );

          return (
            pe !== null &&
            pe > 0
          )
            ? pe
            : null;
        })(),

      dividendYield:
        data.dividend_yield ===
          null ||
        data.dividend_yield ===
          undefined ||
        data.dividend_yield ===
          ''
          ? null
          : safeNumber(
              data.dividend_yield
            ),

      averageVolume30d,

      sessionVolume,

      volumeVsAveragePct,

      marketCapPkr:
        companySnapshot
          ?.equity
          ?.marketCapPkr ??
        safeNumber(
          data.market_cap
        ),

      shares:
        companySnapshot
          ?.equity
          ?.shares ??
        null,

      freeFloatShares:
        companySnapshot
          ?.equity
          ?.freeFloatShares ??
        null,

      freeFloatPercent:
        companySnapshot
          ?.equity
          ?.freeFloatPercent ??
        safeNumber(
          data.free_float
        )
    }
  };
}

/* --------------------------------------------------
   HISTORY
-------------------------------------------------- */

async function getHistory(
  stockSymbol,
  range = '1Y'
) {
  const symbol =
    normalizeSymbol(
      stockSymbol
    );

  const normalizedRange =
    [
      '1M',
      '6M',
      '1Y',
      '2Y',
      'ALL'
    ]
      .includes(
        String(
          range || ''
        ).toUpperCase()
      )
        ? String(
            range
          ).toUpperCase()
        : '1Y';

  if (!symbol) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  const params =
    new URLSearchParams();

  const start =
    rangeStartDate(
      normalizedRange
    );

  const end =
    new Date()
      .toISOString()
      .slice(
        0,
        10
      );

  if (start) {
    params.set(
      'start',
      start
    );
  }

  params.set(
    'end',
    end
  );

  const query =
    params.toString();

  const [
    result,
    companyMap,
    sectorMap
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

      loadCompanyMap(),

      loadSectorMap()
    ]);

  const rawRows =
    Array.isArray(
      result.data
    )
      ? result.data
      : [];

  const cleaned = [];
  const anomalies = [];

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
      row.is_anomaly ===
        true ||
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
        volume ||
        0,

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
    (
      a,
      b
    ) =>
      String(
        a.date
      )
        .localeCompare(
          String(
            b.date
          )
        )
  );

  let summary =
    null;

  if (
    cleaned.length >=
    1
  ) {
    const first =
      cleaned[0];

    const last =
      cleaned[
        cleaned.length -
        1
      ];

    const highs =
      cleaned.map(
        row =>
          row.high
      );

    const lows =
      cleaned.map(
        row =>
          row.low
      );

    const volumes =
      cleaned.map(
        row =>
          row.volume ||
          0
      );

    const change =
      last.close -
      first.close;

    const changePct =
      first.close !==
      0
        ? (
            change /
            first.close
          ) *
          100
        : null;

    summary = {
      range:
        normalizedRange,

      rangeLabel:
        normalizedRange ===
          'ALL'
          ? 'All-time'
          : normalizedRange,

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
          ...highs
        ),

      low:
        Math.min(
          ...lows
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

  const company =
    companyMap.get(
      symbol
    );

  return {
    symbol,

    company:
      company
        ? {
            ...company,

            sector:
              company.sector ||
              sectorMap.get(
                symbol
              ) ||
              ''
          }
        : null,

    range:
      normalizedRange,

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
   FUNDAMENTALS / EVENTS
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
    companyMap,
    sectorMap,
    snapshot,
    quote
  ] =
    await Promise.all([
      loadCompanyMap(),

      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      ),

      fetchJSON(
        `${PSX_API_BASE}/stocks/${encodeURIComponent(
          symbol
        )}/quote`
      ).catch(
        () => null
      )
    ]);

  const company =
    companyMap.get(
      symbol
    );

  const quoteData =
    quote?.data ||
    {};

  const pe =
    safeNumber(
      quoteData.pe_ratio
    );

  const dividendYield =
    quoteData.dividend_yield ===
      null ||
    quoteData.dividend_yield ===
      undefined ||
    quoteData.dividend_yield ===
      ''
      ? null
      : safeNumber(
          quoteData.dividend_yield
        );

  return {
    symbol,

    company: {
      ...(company || {}),

      name:
        snapshot
          ?.companyName ||
        company?.name ||
        symbol,

      sector:
        snapshot
          ?.sectorName ||
        company?.sector ||
        sectorMap.get(
          symbol
        ) ||
        ''
    },

    source:
      snapshot
        ? 'PSX Data Portal'
        : 'Unavailable',

    sourceUrl:
      snapshot
        ?.sourceUrl ||
      null,

    fetchedAt:
      snapshot
        ?.fetchedAt ||
      new Date()
        .toISOString(),

    valuation: {
      peRatio:
        pe !== null &&
        pe > 0
          ? pe
          : null,

      dividendYield,

      marketCapPkr:
        snapshot
          ?.equity
          ?.marketCapPkr ??
        safeNumber(
          quoteData.market_cap
        ),

      shares:
        snapshot
          ?.equity
          ?.shares ??
        null,

      freeFloatShares:
        snapshot
          ?.equity
          ?.freeFloatShares ??
        null,

      freeFloatPercent:
        snapshot
          ?.equity
          ?.freeFloatPercent ??
        safeNumber(
          quoteData.free_float
        )
    },

    annual:
      snapshot
        ?.annual ||
      null,

    quarterly:
      snapshot
        ?.quarterly ||
      null,

    ratios:
      snapshot
        ?.ratios ||
      null,

    available:
      Boolean(
        snapshot &&
        (
          snapshot.annual ||
          snapshot.quarterly ||
          snapshot.ratios
        )
      )
  };
}

async function getEvents(
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
    companyMap,
    sectorMap,
    snapshot
  ] =
    await Promise.all([
      loadCompanyMap(),

      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      )
    ]);

  const company =
    companyMap.get(
      symbol
    );

  return {
    symbol,

    company: {
      ...(company || {}),

      name:
        snapshot
          ?.companyName ||
        company?.name ||
        symbol,

      sector:
        snapshot
          ?.sectorName ||
        company?.sector ||
        sectorMap.get(
          symbol
        ) ||
        ''
    },

    source:
      snapshot
        ? 'PSX Data Portal'
        : 'Unavailable',

    sourceUrl:
      snapshot
        ?.sourceUrl ||
      null,

    fetchedAt:
      snapshot
        ?.fetchedAt ||
      new Date()
        .toISOString(),

    events:
      snapshot
        ?.announcements ||
      []
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
          String(
            value
          )
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

  let login = '';

  try {
    login =
      Buffer
        .from(
          (
            request
              .headers
              .authorization ||
            ''
          )
            .replace(
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
   RESPONSE / HANDLER
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
      url.searchParams
        .get(
          'action'
        ) ||
      'app';

    if (
      request.method ===
        'GET' &&
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
            'PSX official metadata + fallbacks',

          fundamentalsProvider:
            'PSX Data Portal company page',

          pyPSXConfigured:
            Boolean(
              PYPSX_API_KEY_ID &&
              PYPSX_API_SECRET_KEY
            ),

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
        'live-price'
    ) {
      const result =
        await getPyPSXIntraday(
          url.searchParams
            .get(
              'symbol'
            )
        );

      return sendJSON(
        response,
        {
          symbol:
            result.symbol,

          provider:
            result.provider,

          sourceType:
            result.sourceType,

          marketStatus:
            result.marketStatus,

          feedState:
            result.feedState,

          feedLabel:
            result.feedLabel,

          price:
            result.price,

          timestamp:
            result.timestamp,

          ageSeconds:
            result.ageSeconds,

          sessionDate:
            result.sessionDate,

          session:
            result.session
        }
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'live-chart'
    ) {
      return sendJSON(
        response,
        await getPyPSXIntraday(
          url.searchParams
            .get(
              'symbol'
            )
        )
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
          url.searchParams
            .get(
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
          url.searchParams
            .get(
              'symbol'
            ),

          url.searchParams
            .get(
              'range'
            ) ||
            '1Y'
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
          url.searchParams
            .get(
              'symbol'
            )
        )
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'events'
    ) {
      return sendJSON(
        response,
        await getEvents(
          url.searchParams
            .get(
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
  vertical-align: top;
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

.neutral {
  color: #66788a;
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

.metricSub {
  color: #66788a;
  font-size: 12px;
  margin-top: 5px;
}

.decisionHeader {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  margin: 6px 0 18px;
}

.decisionPrice {
  font-size: 36px;
  line-height: 1.05;
  font-weight: 780;
  letter-spacing: -.5px;
}

.decisionChange {
  font-size: 16px;
  font-weight: 700;
  margin-top: 7px;
}

.decisionTimestamp {
  color: #66788a;
  font-size: 13px;
  margin-top: 5px;
}

.decisionSection {
  margin-top: 22px;
}

.decisionSectionTitle {
  font-size: 14px;
  font-weight: 750;
  margin-bottom: 10px;
  color: #31495d;
}

.rangeCard {
  border: 1px solid #e1e7ec;
  border-radius: 9px;
  padding: 14px 16px;
  background: #fafcfd;
  margin-top: 12px;
}

.rangeHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: #66788a;
  margin-bottom: 10px;
}

.rangeTrack {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: #dbe3e9;
  margin: 13px 4px 9px;
}

.rangeMarker {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #173f58;
  border: 2px solid white;
  box-shadow: 0 0 0 1px #173f58;
  transform: translate(-50%, -50%);
}

.rangeLabels {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: #66788a;
}

.liveStrip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 24px;
  margin: 12px 0 2px;
}

.feedDot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}

.feedDot.live {
  background: #11823b;

  box-shadow:
    0 0 0 4px
    rgba(17,130,59,.10);
}

.feedDot.closed {
  background: #778899;
}

.feedDot.delayed {
  background: #bd8728;
}

.feedPrice {
  font-weight: 700;
}

.feedMeta {
  color: #66788a;
  font-size: 13px;
}

.feedWarning {
  color: #9a6718;
  font-size: 13px;
}

.liveChartHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 15px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.liveChartPrice {
  font-size: 28px;
  font-weight: 750;
}

.chartModeToggle,
.rangeToggle {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid #d9e2e9;
  border-radius: 9px;
  background: #f7f9fb;
  flex-wrap: wrap;
}

.chartModeButton,
.rangeButton {
  background: transparent;
  color: #44596b;
  padding: 7px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.chartModeButton.active,
.rangeButton.active {
  background: #173f58;
  color: white;
}

.chartLegend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  color: #66788a;
  font-size: 12px;
  margin-bottom: 8px;
}

.legendSwatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
  margin-right: 5px;
}

.legendSwatch.up {
  background: #11823b;
}

.legendSwatch.down {
  background: #c73737;
}

.candleChart {
  display: block;
  width: 100%;
  height: 420px;
}

.candleUp {
  fill: #11823b;
  stroke: #11823b;
}

.candleDown {
  fill: #c73737;
  stroke: #c73737;
}

.candleFlat {
  fill: #778899;
  stroke: #778899;
}

.volumeUp {
  fill: rgba(17,130,59,.45);
}

.volumeDown {
  fill: rgba(199,55,55,.45);
}

.volumeFlat {
  fill: rgba(119,136,153,.4);
}

.volumeSeparator {
  stroke: #dfe6ec;
  stroke-width: 1;
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

.warningBox {
  margin-top: 14px;
  padding: 12px;
  border-radius: 8px;
  background: #fff8e8;
  color: #725217;
}

.sourceNote {
  font-size: 12px;
  color: #66788a;
  margin-top: 10px;
}

.emptyState {
  padding: 18px;
  border: 1px dashed #cbd6de;
  border-radius: 9px;
  color: #66788a;
  background: #fafcfd;
}

.dataTable {
  overflow-x: auto;
  border: 1px solid #e1e7ec;
  border-radius: 9px;
}

.dataTable table {
  min-width: 650px;
}

.dataTable tbody tr {
  cursor: default;
}

.dataTable tbody tr:hover {
  background: transparent;
}

.eventList {
  display: grid;
  gap: 10px;
}

.eventItem {
  border: 1px solid #e1e7ec;
  border-radius: 9px;
  padding: 13px 14px;
  background: white;
}

.eventMeta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  color: #66788a;
  font-size: 12px;
  margin-bottom: 5px;
}

.eventTitle {
  font-weight: 650;
}

.eventLink {
  display: inline-block;
  margin-top: 8px;
  font-size: 13px;
  color: #173f58;
  text-decoration: none;
}

.eventLink:hover {
  text-decoration: underline;
}

.pill {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  background: #eef3f6;
  color: #44596b;
  font-size: 11px;
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

  .candleChart {
    height: 340px;
  }

  .decisionPrice {
    font-size: 30px;
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
Market, company metadata and research data are connected.
Predictions and investment recommendations remain disabled
until their models are built and validated.
</p>

<p id="status">
Checking connection...
</p>

<p id="error"></p>

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

<div
  id="liveStatus"
  class="liveStrip"
></div>

<div class="actions">

<button id="loadQuote">
Overview
</button>

<button id="loadLiveChart">
Live Chart
</button>

<button id="loadHistory">
History
</button>

<button id="loadFundamentals">
Fundamentals
</button>

<button id="loadEvents">
Events
</button>

<button id="loadMore">
More
</button>

</div>

<div id="research"></div>

</section>

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

let currentPage = 1;

const PAGE_SIZE = 50;

let liveRefreshTimer = null;
let liveRefreshSymbol = null;
let liveView = null;
let liveChartMode = 'candles';
let lastLiveChartResult = null;
let lastQuoteResult = null;
let selectedHistoryRange = '1Y';

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
    value === undefined ||
    value === ''
  ) {
    return '-';
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return '-';
  }

  return number
    .toLocaleString(
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
    value === undefined ||
    value === ''
  ) {
    return 'N/A';
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return 'N/A';
  }

  return (
    formatNumber(
      number,
      2
    ) +
    '%'
  );
}

function formatDate(value) {
  const date =
    new Date(value);

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
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }
    );
}

function formatDateTime(
  value
) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(
      value || ''
    );
  }

  return date
    .toLocaleString(
      'en-PK',
      {
        timeZone:
          'Asia/Karachi',

        day:
          'numeric',

        month:
          'short',

        year:
          'numeric',

        hour:
          'numeric',

        minute:
          '2-digit',

        second:
          '2-digit'
      }
    );
}

function formatTime(value) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '';
  }

  return date
    .toLocaleTimeString(
      'en-PK',
      {
        timeZone:
          'Asia/Karachi',

        hour:
          'numeric',

        minute:
          '2-digit'
      }
    );
}

function formatCompactPKR(
  value
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return 'N/A';
  }

  const absolute =
    Math.abs(number);

  if (
    absolute >=
    1e12
  ) {
    return (
      'PKR ' +
      formatNumber(
        number / 1e12,
        2
      ) +
      'T'
    );
  }

  if (
    absolute >=
    1e9
  ) {
    return (
      'PKR ' +
      formatNumber(
        number / 1e9,
        2
      ) +
      'B'
    );
  }

  if (
    absolute >=
    1e6
  ) {
    return (
      'PKR ' +
      formatNumber(
        number / 1e6,
        2
      ) +
      'M'
    );
  }

  return (
    'PKR ' +
    formatNumber(
      number,
      0
    )
  );
}

function finiteNumber(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const numeric =
    Number(value);

  return Number
    .isFinite(
      numeric
    )
      ? numeric
      : null;
}

async function api(
  action,
  params = {}
) {
  const url =
    new URL(
      location.href
    );

  url.searchParams
    .set(
      'action',
      action
    );

  for (
    const [
      key,
      value
    ]
    of Object.entries(
      params
    )
  ) {
    if (
      value !== null &&
      value !== undefined &&
      value !== ''
    ) {
      url.searchParams
        .set(
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

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );
}

function rangePosition(
  value,
  low,
  high
) {
  const numericValue =
    Number(value);

  const numericLow =
    Number(low);

  const numericHigh =
    Number(high);

  if (
    !Number.isFinite(
      numericValue
    ) ||
    !Number.isFinite(
      numericLow
    ) ||
    !Number.isFinite(
      numericHigh
    ) ||
    numericHigh <=
      numericLow
  ) {
    return 50;
  }

  return clamp(
    (
      (
        numericValue -
        numericLow
      ) /
      (
        numericHigh -
        numericLow
      )
    ) *
    100,
    0,
    100
  );
}

function buildRangeCard(
  title,
  low,
  high,
  current
) {
  if (
    [
      low,
      high,
      current
    ].some(
      value =>
        value === null ||
        value === undefined
    )
  ) {
    return '';
  }

  const position =
    rangePosition(
      current,
      low,
      high
    );

  return (
    '<div class="rangeCard">' +

    '<div class="rangeHeader">' +

    '<strong>' +
    escapeHtml(title) +
    '</strong>' +

    '<span>PKR ' +
    formatNumber(
      current
    ) +
    '</span>' +

    '</div>' +

    '<div class="rangeTrack">' +

    '<span class="rangeMarker" style="left:' +
    position +
    '%"></span>' +

    '</div>' +

    '<div class="rangeLabels">' +

    '<span>Low PKR ' +
    formatNumber(low) +
    '</span>' +

    '<span>High PKR ' +
    formatNumber(high) +
    '</span>' +

    '</div>' +

    '</div>'
  );
}

function percentClass(
  value
) {
  const number =
    Number(value);

  return number > 0
    ? 'positive'
    : number < 0
      ? 'negative'
      : 'neutral';
}

function metricCard(
  label,
  value,
  sub = ''
) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return '';
  }

  return (
    '<div class="metric">' +

    '<div class="metricLabel">' +
    escapeHtml(label) +
    '</div>' +

    '<div class="metricValue">' +
    value +
    '</div>' +

    (
      sub
        ? '<div class="metricSub">' +
          escapeHtml(sub) +
          '</div>'
        : ''
    ) +

    '</div>'
  );
}

function decisionChangeValues(
  decision,
  live
) {
  const livePrice =
    finiteNumber(
      live?.price
    );

  const decisionPrice =
    finiteNumber(
      decision?.price
    );

  const price =
    livePrice ??
    decisionPrice;

  const previousClose =
    finiteNumber(
      decision
        ?.previousClose
    );

  let change =
    finiteNumber(
      decision
        ?.dayChange
    );

  let pct =
    finiteNumber(
      decision
        ?.dayChangePct
    );

  if (
    Number.isFinite(
      price
    ) &&
    Number.isFinite(
      previousClose
    ) &&
    previousClose !==
      0
  ) {
    change =
      price -
      previousClose;

    pct =
      (
        change /
        previousClose
      ) *
      100;
  }

  return {
    price:
      Number.isFinite(
        price
      )
        ? price
        : null,

    change:
      Number.isFinite(
        change
      )
        ? change
        : null,

    pct:
      Number.isFinite(
        pct
      )
        ? pct
        : null
  };
}

function renderDecisionOverview(
  result
) {
  const decision =
    result?.decision ||
    {};

  const live =
    result?.live ||
    null;

  const session =
    live?.session ||
    decision.session ||
    {};

  const values =
    decisionChangeValues(
      decision,
      live
    );

  const changeClass =
    percentClass(
      values.pct
    );

  const arrow =
    values.pct > 0
      ? '▲'
      : values.pct < 0
        ? '▼'
        : '•';

  const sessionLabel =
    live?.marketStatus
      ?.known
      ? live
          .marketStatus
          .isOpen
        ? 'Today'
        : 'Last session'
      : 'Session';

  const changeText =
    values.change !==
      null &&
    values.pct !==
      null
      ? (
          arrow +
          ' PKR ' +
          formatNumber(
            Math.abs(
              values.change
            )
          ) +
          ' (' +
          formatPercent(
            Math.abs(
              values.pct
            )
          ) +
          ') ' +
          sessionLabel
        )
      : 'Session change unavailable';

  const averageVolume =
    decision
      .averageVolume30d;

  const sessionVolume =
    session.volume ??
    decision.sessionVolume;

  const volumeVsAverage =
    sessionVolume !==
      null &&
    sessionVolume !==
      undefined &&
    averageVolume !==
      null &&
    averageVolume !==
      undefined &&
    Number(
      averageVolume
    ) > 0
      ? (
          Number(
            sessionVolume
          ) /
          Number(
            averageVolume
          )
        ) *
        100
      : decision
          .volumeVsAveragePct;

  const volumeSub =
    Number.isFinite(
      Number(
        volumeVsAverage
      )
    )
      ? (
          formatNumber(
            volumeVsAverage,
            0
          ) +
          '% of 30D avg'
        )
      : averageVolume !==
          null &&
        averageVolume !==
          undefined
        ? (
            '30D avg ' +
            formatNumber(
              averageVolume,
              0
            )
          )
        : '';

  let html =
    '<div class="decisionHeader">' +

    '<div>' +

    '<div class="decisionPrice">' +
    'PKR ' +
    formatNumber(
      values.price
    ) +
    '</div>' +

    '<div class="decisionChange ' +
    changeClass +
    '">' +
    escapeHtml(
      changeText
    ) +
    '</div>' +

    '<div class="decisionTimestamp">' +
    escapeHtml(
      live?.feedLabel ||
      decision.feedLabel ||
      'Latest available price'
    ) +

    (
      live?.timestamp ||
      decision
        .priceTimestamp
        ? (
            ' &bull; ' +
            escapeHtml(
              formatDateTime(
                live
                  ?.timestamp ||
                decision
                  .priceTimestamp
              )
            )
          )
        : ''
    ) +

    '</div>' +

    '</div>' +

    '</div>';

  html +=
    '<div class="decisionSection">' +

    '<div class="decisionSectionTitle">' +
    'Market context' +
    '</div>' +

    '<div class="summaryGrid">' +

    metricCard(
      'Open',
      'PKR ' +
      formatNumber(
        session.open
      )
    ) +

    metricCard(
      'High',
      'PKR ' +
      formatNumber(
        session.high
      )
    ) +

    metricCard(
      'Low',
      'PKR ' +
      formatNumber(
        session.low
      )
    ) +

    metricCard(
      'Volume',
      formatNumber(
        sessionVolume,
        0
      ),
      volumeSub
    ) +

    '</div>' +

    buildRangeCard(
      'Day range',
      session.low,
      session.high,
      values.price
    ) +

    '</div>';

  html +=
    '<div class="decisionSection">' +

    '<div class="decisionSectionTitle">' +
    'Performance' +
    '</div>' +

    '<div class="summaryGrid">' +

    '<div class="metric">' +
    '<div class="metricLabel">' +
    'YTD change' +
    '</div>' +
    '<div class="metricValue ' +
    percentClass(
      decision.ytdChangePct
    ) +
    '">' +
    formatPercent(
      decision.ytdChangePct
    ) +
    '</div>' +
    '</div>' +

    '<div class="metric">' +
    '<div class="metricLabel">' +
    '1Y change' +
    '</div>' +
    '<div class="metricValue ' +
    percentClass(
      decision.change1yPct
    ) +
    '">' +
    formatPercent(
      decision.change1yPct
    ) +
    '</div>' +
    '</div>' +

    '</div>' +

    buildRangeCard(
      '52-week range',
      decision
        .range52
        ?.low,
      decision
        .range52
        ?.high,
      values.price
    ) +

    '</div>';

  html +=
    '<div class="decisionSection">' +

    '<div class="decisionSectionTitle">' +
    'Valuation & income' +
    '</div>' +

    '<div class="summaryGrid">' +

    metricCard(
      'P/E',
      decision.peRatio ===
        null ||
      decision.peRatio ===
        undefined
        ? 'N/A'
        : formatNumber(
            decision.peRatio
          )
    ) +

    metricCard(
      'Dividend yield',
      decision.dividendYield ===
        null ||
      decision.dividendYield ===
        undefined
        ? 'N/A'
        : formatPercent(
            decision.dividendYield
          )
    ) +

    '</div>' +

    '</div>';

  $('research')
    .innerHTML =
      html;
}

function renderMoreData(
  result
) {
  const decision =
    result?.decision ||
    {};

  const cards = [];

  if (
    decision.previousClose !==
      null &&
    decision.previousClose !==
      undefined
  ) {
    cards.push(
      metricCard(
        'Previous close',
        'PKR ' +
        formatNumber(
          decision.previousClose
        )
      )
    );
  }

  if (
    decision.averageVolume30d !==
      null &&
    decision.averageVolume30d !==
      undefined
  ) {
    cards.push(
      metricCard(
        '30D avg volume',
        formatNumber(
          decision
            .averageVolume30d,
          0
        )
      )
    );
  }

  if (
    decision.marketCapPkr !==
      null &&
    decision.marketCapPkr !==
      undefined
  ) {
    cards.push(
      metricCard(
        'Market cap',
        formatCompactPKR(
          decision
            .marketCapPkr
        )
      )
    );
  }

  if (
    decision.shares !==
      null &&
    decision.shares !==
      undefined
  ) {
    cards.push(
      metricCard(
        'Shares outstanding',
        formatNumber(
          decision.shares,
          0
        )
      )
    );
  }

  if (
    decision.freeFloatShares !==
      null &&
    decision.freeFloatShares !==
      undefined
  ) {
    cards.push(
      metricCard(
        'Free float shares',
        formatNumber(
          decision
            .freeFloatShares,
          0
        )
      )
    );
  }

  if (
    decision.freeFloatPercent !==
      null &&
    decision.freeFloatPercent !==
      undefined
  ) {
    cards.push(
      metricCard(
        'Free float',
        formatPercent(
          decision
            .freeFloatPercent
        )
      )
    );
  }

  let html =
    '<div class="decisionSectionTitle">' +
    'Advanced market data' +
    '</div>';

  html +=
    cards.length
      ? (
          '<div class="summaryGrid">' +
          cards.join('') +
          '</div>'
        )
      : (
          '<div class="emptyState">' +
          'No additional reliable market fields are available from the connected sources for this symbol.' +
          '</div>'
        );

  html +=
    '<details>' +

    '<summary>' +
    'Data & Sources' +
    '</summary>' +

    '<pre>' +
    escapeHtml(
      JSON.stringify(
        {
          quoteProvider:
            'psxdata-api',

          intradayProvider:
            result.live
              ? 'pyPSX'
              : null,

          companyProvider:
            result.official
              ? 'PSX Data Portal'
              : null,

          quoteTimestamp:
            result
              .meta
              ?.timestamp ||
            null,

          liveTimestamp:
            result
              .live
              ?.timestamp ||
            null,

          companyFetchedAt:
            result
              .official
              ?.fetchedAt ||
            null,

          companySourceUrl:
            result
              .official
              ?.sourceUrl ||
            null
        },
        null,
        2
      )
    ) +
    '</pre>' +

    '<pre>' +
    escapeHtml(
      JSON.stringify(
        result.data ||
        {},
        null,
        2
      )
    ) +
    '</pre>' +

    '</details>';

  $('research')
    .innerHTML =
      html;
}

/* ---------------------------------------
   LIVE PRICE / LIVE CHART
--------------------------------------- */

function stopLiveRefresh() {
  if (
    liveRefreshTimer
  ) {
    clearInterval(
      liveRefreshTimer
    );
  }

  liveRefreshTimer =
    null;

  liveRefreshSymbol =
    null;

  liveView =
    null;

  lastLiveChartResult =
    null;
}

function renderFeedStatus(
  result
) {
  const state =
    result.feedState ||
    'LATEST';

  const dotClass =
    state === 'LIVE'
      ? 'live'
      : state === 'DELAYED'
        ? 'delayed'
        : 'closed';

  const marketNote =
    result
      .marketStatus
      ?.holidayName
      ? (
          ' &bull; ' +
          result
            .marketStatus
            .holidayName
        )
      : '';

  $('liveStatus')
    .innerHTML =
      '<span class="feedDot ' +
      dotClass +
      '"></span>' +

      '<span class="feedPrice">' +
      escapeHtml(
        result.feedLabel ||
        'Latest available'
      ) +
      ': PKR ' +
      formatNumber(
        result.price
      ) +
      '</span>' +

      '<span class="feedMeta">' +
      'Updated ' +
      escapeHtml(
        formatDateTime(
          result.timestamp
        )
      ) +
      marketNote +
      '</span>';
}

function shouldAutoRefresh(
  result
) {
  return Boolean(
    result
      ?.marketStatus
      ?.known &&
    result
      ?.marketStatus
      ?.isOpen
  );
}

function scheduleLiveRefresh(
  callback,
  result
) {
  if (
    liveRefreshTimer
  ) {
    clearInterval(
      liveRefreshTimer
    );

    liveRefreshTimer =
      null;
  }

  if (
    !shouldAutoRefresh(
      result
    )
  ) {
    return;
  }

  liveRefreshTimer =
    setInterval(
      callback,
      15000
    );
}

async function refreshLiveOverview(
  symbol,
  silent = false
) {
  try {
    const result =
      await api(
        'live-price',
        {
          symbol
        }
      );

    if (
      liveRefreshSymbol ===
        symbol &&
      liveView ===
        'overview'
    ) {
      renderFeedStatus(
        result
      );

      if (
        lastQuoteResult &&
        lastQuoteResult.symbol ===
          symbol
      ) {
        lastQuoteResult.live =
          result;

        renderDecisionOverview(
          lastQuoteResult
        );
      }

      if (
        liveRefreshTimer &&
        !shouldAutoRefresh(
          result
        )
      ) {
        clearInterval(
          liveRefreshTimer
        );

        liveRefreshTimer =
          null;
      }
    }

    return result;
  } catch (error) {
    if (!silent) {
      $('liveStatus')
        .innerHTML =
          '<span class="feedWarning">' +
          'Latest pyPSX price unavailable: ' +
          escapeHtml(
            error.message
          ) +
          '</span>';
    }

    return null;
  }
}

async function startLiveOverview(
  symbol,
  initialResult = null
) {
  stopLiveRefresh();

  if (!symbol) {
    return;
  }

  liveRefreshSymbol =
    symbol;

  liveView =
    'overview';

  let result =
    initialResult;

  if (result) {
    renderFeedStatus(
      result
    );
  } else {
    $('liveStatus')
      .innerHTML =
        '<span class="feedMeta">' +
        'Loading latest pyPSX price...' +
        '</span>';

    result =
      await refreshLiveOverview(
        symbol
      );
  }

  if (
    result &&
    liveRefreshSymbol ===
      symbol &&
    liveView ===
      'overview'
  ) {
    scheduleLiveRefresh(
      () =>
        refreshLiveOverview(
          symbol,
          true
        ),
      result
    );
  }
}

function chartDirectionClass(
  row,
  prefix
) {
  const open =
    Number(
      row.open
    );

  const close =
    Number(
      row.close
    );

  if (
    close > open
  ) {
    return prefix +
      'Up';
  }

  if (
    close < open
  ) {
    return prefix +
      'Down';
  }

  return prefix +
    'Flat';
}

function buildPriceGrid(
  min,
  max,
  width,
  paddingLeft,
  paddingRight,
  paddingTop,
  priceHeight
) {
  let lines = '';

  for (
    let index = 0;
    index < 5;
    index++
  ) {
    const fraction =
      index / 4;

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
      priceHeight;

    lines +=
      '<line x1="' +
      paddingLeft +
      '" x2="' +
      (
        width -
        paddingRight
      ) +
      '" y1="' +
      lineY +
      '" y2="' +
      lineY +
      '" class="chartAxis" />' +

      '<text x="5" y="' +
      (
        lineY +
        4
      ) +
      '" class="chartLabel">' +

      formatNumber(
        price,
        2
      ) +

      '</text>';
  }

  return lines;
}

function buildIntradayLineChart(
  rows
) {
  if (
    !rows ||
    rows.length < 2
  ) {
    return (
      '<p class="muted">' +
      'Not enough intraday data to draw the chart.' +
      '</p>'
    );
  }

  const width = 1000;
  const height = 410;
  const paddingLeft = 65;
  const paddingRight = 20;
  const paddingTop = 20;
  const priceHeight = 265;
  const volumeTop = 310;
  const volumeHeight = 58;

  const usableWidth =
    width -
    paddingLeft -
    paddingRight;

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
    min *= .995;
    max *= 1.005;
  }

  const range =
    max - min;

  const margin =
    Math.max(
      range * .08,
      max * .002
    );

  min -= margin;
  max += margin;

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
      priceHeight;

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

  const bottomY =
    paddingTop +
    priceHeight;

  const areaPoints =
    x(0) +
    ',' +
    bottomY +
    ' ' +
    points +
    ' ' +
    x(
      rows.length -
      1
    ) +
    ',' +
    bottomY;

  const maxVolume =
    Math.max(
      1,
      ...rows.map(
        row =>
          Number(
            row.volume ||
            0
          )
      )
    );

  const step =
    usableWidth /
    rows.length;

  const barWidth =
    Math.max(
      1,
      Math.min(
        7,
        step * .72
      )
    );

  const volumeBars =
    rows.map(
      (
        row,
        index
      ) => {
        const volume =
          Number(
            row.volume ||
            0
          );

        const barHeight =
          maxVolume > 0
            ? (
                volume /
                maxVolume
              ) *
              volumeHeight
            : 0;

        const barX =
          paddingLeft +
          index *
          step +
          (
            step -
            barWidth
          ) /
          2;

        const barY =
          volumeTop +
          volumeHeight -
          barHeight;

        return (
          '<rect x="' +
          barX +
          '" y="' +
          barY +
          '" width="' +
          barWidth +
          '" height="' +
          Math.max(
            .5,
            barHeight
          ) +
          '" class="' +
          chartDirectionClass(
            row,
            'volume'
          ) +
          '">' +

          '<title>' +
          escapeHtml(
            formatTime(
              row.timestamp
            ) +
            ' - Volume ' +
            formatNumber(
              volume,
              0
            )
          ) +
          '</title>' +

          '</rect>'
        );
      }
    )
    .join('');

  const firstTime =
    formatTime(
      rows[0]
        .timestamp
    );

  const middleTime =
    formatTime(
      rows[
        Math.floor(
          rows.length /
          2
        )
      ].timestamp
    );

  const lastTime =
    formatTime(
      rows[
        rows.length -
        1
      ].timestamp
    );

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Intraday line + volume - 1-minute candles' +
    '</div>' +

    '<svg class="candleChart" ' +
    'viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    buildPriceGrid(
      min,
      max,
      width,
      paddingLeft,
      paddingRight,
      paddingTop,
      priceHeight
    ) +

    '<polygon points="' +
    areaPoints +
    '" class="chartArea" />' +

    '<polyline points="' +
    points +
    '" class="chartLine" />' +

    '<line x1="' +
    paddingLeft +
    '" x2="' +
    (
      width -
      paddingRight
    ) +
    '" y1="' +
    (
      volumeTop -
      10
    ) +
    '" y2="' +
    (
      volumeTop -
      10
    ) +
    '" class="volumeSeparator" />' +

    volumeBars +

    '<text x="5" y="' +
    (
      volumeTop +
      12
    ) +
    '" class="chartLabel">' +
    'Vol' +
    '</text>' +

    '<text x="' +
    paddingLeft +
    '" y="' +
    (
      height -
      8
    ) +
    '" class="chartLabel">' +
    escapeHtml(
      firstTime
    ) +
    '</text>' +

    '<text x="' +
    (
      width /
      2
    ) +
    '" y="' +
    (
      height -
      8
    ) +
    '" text-anchor="middle" ' +
    'class="chartLabel">' +
    escapeHtml(
      middleTime
    ) +
    '</text>' +

    '<text x="' +
    (
      width -
      paddingRight
    ) +
    '" y="' +
    (
      height -
      8
    ) +
    '" text-anchor="end" ' +
    'class="chartLabel">' +
    escapeHtml(
      lastTime
    ) +
    '</text>' +

    '</svg>' +

    '</div>'
  );
}

function buildIntradayCandlestickChart(
  rows
) {
  if (
    !rows ||
    rows.length < 2
  ) {
    return (
      '<p class="muted">' +
      'Not enough intraday data to draw candlesticks.' +
      '</p>'
    );
  }

  const width = 1000;
  const height = 430;
  const paddingLeft = 65;
  const paddingRight = 20;
  const paddingTop = 20;
  const priceHeight = 275;
  const volumeTop = 322;
  const volumeHeight = 64;

  const usableWidth =
    width -
    paddingLeft -
    paddingRight;

  const normalized =
    rows.map(
      row => {
        const close =
          Number(
            row.close
          );

        const open =
          Number.isFinite(
            Number(
              row.open
            )
          )
            ? Number(
                row.open
              )
            : close;

        const rawHigh =
          Number.isFinite(
            Number(
              row.high
            )
          )
            ? Number(
                row.high
              )
            : Math.max(
                open,
                close
              );

        const rawLow =
          Number.isFinite(
            Number(
              row.low
            )
          )
            ? Number(
                row.low
              )
            : Math.min(
                open,
                close
              );

        return {
          ...row,

          open,

          high:
            Math.max(
              rawHigh,
              open,
              close
            ),

          low:
            Math.min(
              rawLow,
              open,
              close
            ),

          close,

          volume:
            Number(
              row.volume ||
              0
            )
        };
      }
    );

  let min =
    Math.min(
      ...normalized.map(
        row =>
          row.low
      )
    );

  let max =
    Math.max(
      ...normalized.map(
        row =>
          row.high
      )
    );

  if (
    min === max
  ) {
    min *= .995;
    max *= 1.005;
  }

  const range =
    max - min;

  const margin =
    Math.max(
      range * .06,
      max * .0015
    );

  min -= margin;
  max += margin;

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
      priceHeight;

  const step =
    usableWidth /
    normalized.length;

  const bodyWidth =
    Math.max(
      .8,
      Math.min(
        7,
        step * .68
      )
    );

  const maxVolume =
    Math.max(
      1,
      ...normalized.map(
        row =>
          row.volume
      )
    );

  const candleSvg =
    normalized.map(
      (
        row,
        index
      ) => {
        const centerX =
          paddingLeft +
          index *
          step +
          step /
          2;

        const openY =
          y(
            row.open
          );

        const closeY =
          y(
            row.close
          );

        const highY =
          y(
            row.high
          );

        const lowY =
          y(
            row.low
          );

        const bodyY =
          Math.min(
            openY,
            closeY
          );

        const bodyHeight =
          Math.max(
            1,
            Math.abs(
              closeY -
              openY
            )
          );

        const directionClass =
          chartDirectionClass(
            row,
            'candle'
          );

        const volumeClass =
          chartDirectionClass(
            row,
            'volume'
          );

        const volumeHeightPx =
          (
            row.volume /
            maxVolume
          ) *
          volumeHeight;

        const volumeY =
          volumeTop +
          volumeHeight -
          volumeHeightPx;

        const title =
          formatTime(
            row.timestamp
          ) +
          ' - O ' +
          formatNumber(
            row.open
          ) +
          ' H ' +
          formatNumber(
            row.high
          ) +
          ' L ' +
          formatNumber(
            row.low
          ) +
          ' C ' +
          formatNumber(
            row.close
          ) +
          ' - Vol ' +
          formatNumber(
            row.volume,
            0
          );

        return (
          '<g>' +

          '<title>' +
          escapeHtml(
            title
          ) +
          '</title>' +

          '<line x1="' +
          centerX +
          '" x2="' +
          centerX +
          '" y1="' +
          highY +
          '" y2="' +
          lowY +
          '" class="' +
          directionClass +
          '" />' +

          '<rect x="' +
          (
            centerX -
            bodyWidth /
            2
          ) +
          '" y="' +
          bodyY +
          '" width="' +
          bodyWidth +
          '" height="' +
          bodyHeight +
          '" class="' +
          directionClass +
          '" />' +

          '<rect x="' +
          (
            centerX -
            bodyWidth /
            2
          ) +
          '" y="' +
          volumeY +
          '" width="' +
          bodyWidth +
          '" height="' +
          Math.max(
            .5,
            volumeHeightPx
          ) +
          '" class="' +
          volumeClass +
          '" />' +

          '</g>'
        );
      }
    )
    .join('');

  const firstTime =
    formatTime(
      normalized[0]
        .timestamp
    );

  const middleTime =
    formatTime(
      normalized[
        Math.floor(
          normalized.length /
          2
        )
      ].timestamp
    );

  const lastTime =
    formatTime(
      normalized[
        normalized.length -
        1
      ].timestamp
    );

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Intraday candlesticks + volume - 1-minute candles' +
    '</div>' +

    '<div class="chartLegend">' +

    '<span>' +
    '<span class="legendSwatch up"></span>' +
    'Close >= open' +
    '</span>' +

    '<span>' +
    '<span class="legendSwatch down"></span>' +
    'Close < open' +
    '</span>' +

    '<span>' +
    'Hover a candle for OHLCV' +
    '</span>' +

    '</div>' +

    '<svg class="candleChart" ' +
    'viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    buildPriceGrid(
      min,
      max,
      width,
      paddingLeft,
      paddingRight,
      paddingTop,
      priceHeight
    ) +

    '<line x1="' +
    paddingLeft +
    '" x2="' +
    (
      width -
      paddingRight
    ) +
    '" y1="' +
    (
      volumeTop -
      10
    ) +
    '" y2="' +
    (
      volumeTop -
      10
    ) +
    '" class="volumeSeparator" />' +

    candleSvg +

    '<text x="5" y="' +
    (
      volumeTop +
      12
    ) +
    '" class="chartLabel">' +
    'Vol' +
    '</text>' +

    '<text x="' +
    paddingLeft +
    '" y="' +
    (
      height -
      8
    ) +
    '" class="chartLabel">' +
    escapeHtml(
      firstTime
    ) +
    '</text>' +

    '<text x="' +
    (
      width /
      2
    ) +
    '" y="' +
    (
      height -
      8
    ) +
    '" text-anchor="middle" ' +
    'class="chartLabel">' +
    escapeHtml(
      middleTime
    ) +
    '</text>' +

    '<text x="' +
    (
      width -
      paddingRight
    ) +
    '" y="' +
    (
      height -
      8
    ) +
    '" text-anchor="end" ' +
    'class="chartLabel">' +
    escapeHtml(
      lastTime
    ) +
    '</text>' +

    '</svg>' +

    '</div>'
  );
}

function bindLiveChartModeButtons() {
  document
    .querySelectorAll(
      '.chartModeButton'
    )
    .forEach(
      button => {
        button.onclick =
          () => {
            const mode =
              button.dataset
                .mode;

            if (
              mode !==
                'candles' &&
              mode !==
                'line'
            ) {
              return;
            }

            liveChartMode =
              mode;

            if (
              lastLiveChartResult &&
              liveView ===
                'chart'
            ) {
              renderLiveChart(
                lastLiveChartResult
              );
            }
          };
      }
    );
}

function renderLiveChart(
  result
) {
  lastLiveChartResult =
    result;

  renderFeedStatus(
    result
  );

  const stateNote =
    result.feedState ===
      'LIVE'
      ? 'Market open - auto-refreshing every 15 seconds'
      : result.feedState ===
        'DELAYED'
        ? 'Market open, but the latest pyPSX candle is delayed'
        : result
            .marketStatus
            ?.known
          ? 'Market closed - showing the latest trading session'
          : 'Showing the latest available trading session';

  const chartMarkup =
    liveChartMode ===
      'candles'
      ? buildIntradayCandlestickChart(
          result.data
        )
      : buildIntradayLineChart(
          result.data
        );

  $('research')
    .innerHTML =
      '<div class="liveChartHeader">' +

      '<div>' +

      '<div class="muted">' +
      escapeHtml(
        stateNote
      ) +
      '</div>' +

      '<div class="liveChartPrice">' +
      'PKR ' +
      formatNumber(
        result.price
      ) +
      '</div>' +

      '<div class="feedMeta">' +
      escapeHtml(
        result.sessionDate ||
        ''
      ) +
      ' &bull; pyPSX' +
      '</div>' +

      '</div>' +

      '<div class="chartModeToggle">' +

      '<button type="button" class="chartModeButton ' +
      (
        liveChartMode ===
          'candles'
          ? 'active'
          : ''
      ) +
      '" data-mode="candles">' +
      'Candles' +
      '</button>' +

      '<button type="button" class="chartModeButton ' +
      (
        liveChartMode ===
          'line'
          ? 'active'
          : ''
      ) +
      '" data-mode="line">' +
      'Line' +
      '</button>' +

      '</div>' +

      '</div>' +

      '<div class="summaryGrid">' +

      metricCard(
        'Session open',
        'PKR ' +
        formatNumber(
          result
            .session
            ?.open
        )
      ) +

      metricCard(
        'Session high',
        'PKR ' +
        formatNumber(
          result
            .session
            ?.high
        )
      ) +

      metricCard(
        'Session low',
        'PKR ' +
        formatNumber(
          result
            .session
            ?.low
        )
      ) +

      metricCard(
        'Session volume',
        formatNumber(
          result
            .session
            ?.volume,
          0
        )
      ) +

      '</div>' +

      chartMarkup;

  bindLiveChartModeButtons();
}

async function refreshLiveChart(
  symbol,
  silent = false
) {
  try {
    const result =
      await api(
        'live-chart',
        {
          symbol
        }
      );

    if (
      liveRefreshSymbol ===
        symbol &&
      liveView ===
        'chart'
    ) {
      renderLiveChart(
        result
      );

      if (
        liveRefreshTimer &&
        !shouldAutoRefresh(
          result
        )
      ) {
        clearInterval(
          liveRefreshTimer
        );

        liveRefreshTimer =
          null;
      }
    }

    return result;
  } catch (error) {
    if (!silent) {
      $('research')
        .innerHTML =
          '';

      $('error')
        .textContent =
          error.message;
    }

    return null;
  }
}

async function startLiveChart(
  symbol
) {
  stopLiveRefresh();

  if (!symbol) {
    return;
  }

  liveRefreshSymbol =
    symbol;

  liveView =
    'chart';

  liveChartMode =
    'candles';

  $('research')
    .innerHTML =
      '<p class="muted">' +
      'Loading intraday chart...' +
      '</p>';

  const result =
    await refreshLiveChart(
      symbol
    );

  if (
    result &&
    liveRefreshSymbol ===
      symbol &&
    liveView ===
      'chart'
  ) {
    scheduleLiveRefresh(
      () =>
        refreshLiveChart(
          symbol,
          true
        ),
      result
    );
  }
}

/* ---------------------------------------
   COMPANY DISPLAY / MARKET TABLE
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
      ' &bull; ' +
      escapeHtml(
        stock.sector
      ) +
      '</span>';
}

function updateSelectedCompany(
  result
) {
  if (!result) {
    return;
  }

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
            ? (
                ' &bull; ' +
                escapeHtml(
                  company.sector
                )
              )
            : ''
        ) +

        '</span>';
  }
}

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

        return (
          searchable
            .includes(
              query
            ) &&
          (
            !sector ||
            stock.sector ===
              sector
          )
        );
      }
    );

  rows = [...rows];

  switch (
    $('sort').value
  ) {

    case 'priceAsc':

      rows.sort(
        (
          a,
          b
        ) =>
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
        (
          a,
          b
        ) =>
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
        (
          a,
          b
        ) =>
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
        (
          a,
          b
        ) =>
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
        (
          a,
          b
        ) =>
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
              row.peRatio !==
                null &&
              row.peRatio >
                0
          )
          .sort(
            (
              a,
              b
            ) =>
              a.peRatio -
              b.peRatio
          );

      break;

    case 'volumeDesc':

      rows.sort(
        (
          a,
          b
        ) =>
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
        (
          a,
          b
        ) =>
          a.symbol
            .localeCompare(
              b.symbol
            )
      );
  }

  return rows;
}

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
          stock =>
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
            (
              stock.peRatio !==
                null &&
              stock.peRatio >
                0
                ? formatNumber(
                    stock.peRatio
                  )
                : 'N/A'
            ) +
            '</td>' +

            '<td>' +
            (
              stock.dividendYield ===
                null ||
              stock.dividendYield ===
                undefined
                ? 'N/A'
                : formatPercent(
                    stock.dividendYield
                  )
            ) +
            '</td>' +

            '<td>' +
            formatNumber(
              stock.averageVolume30d,
              0
            ) +
            '</td>' +

            '<td class="' +
            percentClass(
              stock.change1yPct
            ) +
            '">' +
            formatPercent(
              stock.change1yPct
            ) +
            '</td>' +

            '</tr>'
        )
        .join('') +

      '</tbody>' +

      '</table>';

  const first =
    start +
    1;

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
              row.dataset
                .symbol;

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
      '<option value="">' +
      'All sectors' +
      '</option>' +

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

        currentPage = 1;

        $('coverage')
          .textContent =
            result.totalStocks +
            ' usable stocks | Company names matched ' +
            result.companyNamesMatched +
            '/' +
            result.totalStocks +
            ' | Sectors matched ' +
            result.sectorsMatched +
            '/' +
            result.totalStocks +
            ' | Updated ' +
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

$('search')
  .oninput =
    () => {

      currentPage = 1;

      renderStocks();
    };

$('sectorFilter')
  .onchange =
    () => {

      currentPage = 1;

      renderStocks();
    };

$('sort')
  .onchange =
    () => {

      currentPage = 1;

      renderStocks();
    };

$('previousPage')
  .onclick =
    () => {

      if (
        currentPage > 1
      ) {
        currentPage--;

        renderStocks();
      }
    };

$('nextPage')
  .onclick =
    () => {

      const pageCount =
        Math.ceil(
          getFilteredRows()
            .length /
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
   HISTORY
--------------------------------------- */

function buildPriceChart(
  rows
) {
  if (
    !rows ||
    rows.length < 2
  ) {
    return (
      '<p class="muted">' +
      'Not enough valid history to draw a chart.' +
      '</p>'
    );
  }

  const width = 1000;
  const height = 330;
  const paddingLeft = 65;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 42;

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
    min *= .98;
    max *= 1.02;
  }

  const range =
    max - min;

  const margin =
    range * .08;

  min -= margin;
  max += margin;

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
    let index = 0;
    index < 5;
    index++
  ) {
    const fraction =
      index / 4;

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
      '<line x1="' +
      paddingLeft +
      '" x2="' +
      (
        width -
        paddingRight
      ) +
      '" y1="' +
      lineY +
      '" y2="' +
      lineY +
      '" class="chartAxis" />' +

      '<text x="5" y="' +
      (
        lineY +
        4
      ) +
      '" class="chartLabel">' +

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

    '<svg class="priceChart" ' +
    'viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    horizontalLines +

    '<polygon points="' +
    areaPoints +
    '" class="chartArea" />' +

    '<polyline points="' +
    points +
    '" class="chartLine" />' +

    '<text x="' +
    paddingLeft +
    '" y="' +
    (
      height -
      8
    ) +
    '" class="chartLabel">' +

    escapeHtml(
      formatDate(
        firstDate
      )
    ) +

    '</text>' +

    '<text x="' +
    (
      width /
      2
    ) +
    '" y="' +
    (
      height -
      8
    ) +
    '" text-anchor="middle" ' +
    'class="chartLabel">' +

    escapeHtml(
      formatDate(
        middleDate
      )
    ) +

    '</text>' +

    '<text x="' +
    (
      width -
      paddingRight
    ) +
    '" y="' +
    (
      height -
      8
    ) +
    '" text-anchor="end" ' +
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

function historyRangeToggle(
  activeRange
) {
  const ranges =
    [
      '1M',
      '6M',
      '1Y',
      '2Y',
      'ALL'
    ];

  return (
    '<div class="liveChartHeader">' +

    '<div>' +

    '<div class="decisionSectionTitle">' +
    'Price history' +
    '</div>' +

    '<div class="muted">' +
    'Choose a period to recalculate performance and chart statistics.' +
    '</div>' +

    '</div>' +

    '<div class="rangeToggle">' +

    ranges
      .map(
        range =>
          '<button type="button" class="rangeButton ' +
          (
            range ===
              activeRange
              ? 'active'
              : ''
          ) +
          '" data-range="' +
          range +
          '">' +
          range +
          '</button>'
      )
      .join('') +

    '</div>' +

    '</div>'
  );
}

function bindHistoryRangeButtons(
  symbol
) {
  document
    .querySelectorAll(
      '.rangeButton'
    )
    .forEach(
      button => {
        button.onclick =
          () => {

            selectedHistoryRange =
              button.dataset
                .range ||
              '1Y';

            loadHistoryView(
              symbol,
              selectedHistoryRange
            );
          };
      }
    );
}

function renderHistory(
  result
) {
  const summary =
    result.summary;

  updateSelectedCompany(
    result
  );

  if (!summary) {
    $('research')
      .innerHTML =
        historyRangeToggle(
          result.range
        ) +

        '<div class="emptyState">' +
        'No valid historical price data was available for this range.' +
        '</div>';

    bindHistoryRangeButtons(
      result.symbol
    );

    return;
  }

  const changeClass =
    percentClass(
      summary.changePct
    );

  let html =
    historyRangeToggle(
      result.range
    );

  html +=
    '<div class="summaryGrid">' +

    metricCard(
      'Latest daily close',
      'PKR ' +
      formatNumber(
        summary.endPrice
      ),
      summary.endDate
    ) +

    metricCard(
      summary.rangeLabel +
      ' change',

      '<span class="' +
      changeClass +
      '">' +
      formatPercent(
        summary.changePct
      ) +
      '</span>',

      summary.startDate +
      ' to ' +
      summary.endDate
    ) +

    metricCard(
      'Period high',
      'PKR ' +
      formatNumber(
        summary.high
      )
    ) +

    metricCard(
      'Period low',
      'PKR ' +
      formatNumber(
        summary.low
      )
    ) +

    metricCard(
      'Average volume',
      formatNumber(
        summary.averageVolume,
        0
      )
    ) +

    '</div>';

  html +=
    buildPriceChart(
      result.data
    );

  if (
    summary
      .excludedAnomalies >
    0
  ) {
    html +=
      '<div class="warningBox">' +

      summary
        .excludedAnomalies +

      ' suspicious historical row' +

      (
        summary
          .excludedAnomalies ===
        1
          ? ' was'
          : 's were'
      ) +

      ' excluded from this range.' +

      '</div>';
  }

  html +=
    '<div class="sourceNote">' +
    'Historical daily data source: psxdata-api. ' +
    'Latest live/session price is shown separately in Overview and Live Chart.' +
    '</div>';

  html +=
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

  $('research')
    .innerHTML =
      html;

  bindHistoryRangeButtons(
    result.symbol
  );
}

async function loadHistoryView(
  symbol,
  range = '1Y'
) {
  stopLiveRefresh();

  $('liveStatus')
    .innerHTML =
      '';

  showSelectedCompany(
    symbol
  );

  $('research')
    .innerHTML =
      '<p class="muted">' +
      'Loading ' +
      escapeHtml(
        range
      ) +
      ' history...' +
      '</p>';

  try {
    const result =
      await api(
        'history',
        {
          symbol,
          range
        }
      );

    selectedHistoryRange =
      result.range ||
      range;

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
}

/* ---------------------------------------
   FUNDAMENTALS
--------------------------------------- */

function financialMetricFromTable(
  table,
  labelMatcher
) {
  if (
    !table
      ?.rows
      ?.length
  ) {
    return null;
  }

  const row =
    table.rows
      .find(
        item =>
          labelMatcher.test(
            String(
              item.label ||
              ''
            )
          )
      );

  if (
    !row
      ?.values
      ?.length
  ) {
    return null;
  }

  return row.values[0];
}

function renderFinancialTable(
  title,
  table
) {
  if (
    !table
      ?.periods
      ?.length ||
    !table
      ?.rows
      ?.length
  ) {
    return '';
  }

  let html =
    '<div class="decisionSection">' +

    '<div class="decisionSectionTitle">' +
    escapeHtml(
      title
    ) +
    '</div>' +

    '<div class="dataTable">' +

    '<table>' +

    '<thead>' +

    '<tr>' +

    '<th>Metric</th>' +

    table.periods
      .map(
        period =>
          '<th>' +
          escapeHtml(
            period
          ) +
          '</th>'
      )
      .join('') +

    '</tr>' +

    '</thead>' +

    '<tbody>';

  for (
    const row
    of table.rows
  ) {
    html +=
      '<tr>' +

      '<td>' +
      '<strong>' +
      escapeHtml(
        row.label
      ) +
      '</strong>' +
      '</td>' +

      row.values
        .map(
          item =>
            '<td>' +
            escapeHtml(
              item.raw ||
              'N/A'
            ) +
            '</td>'
        )
        .join('') +

      '</tr>';
  }

  html +=
    '</tbody>' +
    '</table>' +
    '</div>' +
    '</div>';

  return html;
}

function renderFundamentals(
  result
) {
  updateSelectedCompany(
    result
  );

  if (
    !result.available
  ) {
    $('research')
      .innerHTML =
        '<div class="emptyState">' +

        '<strong>' +
        'Structured fundamentals are not available for this symbol from the connected PSX source.' +
        '</strong>' +

        '<div class="sourceNote">' +
        'NOMAD will not invent or backfill missing financials.' +
        '</div>' +

        '</div>';

    return;
  }

  const annualEPS =
    financialMetricFromTable(
      result.annual,
      /^EPS$/i
    );

  const annualPAT =
    financialMetricFromTable(
      result.annual,
      /profit after taxation/i
    );

  const annualIncome =
    financialMetricFromTable(
      result.annual,
      /^(sales|total income|mark-up earned)$/i
    );

  const incomeRow =
    result
      .annual
      ?.rows
      ?.find(
        item =>
          /^(sales|total income|mark-up earned)$/i
            .test(
              item.label
            )
      );

  let html =
    '<div class="decisionSectionTitle">' +
    'Fundamental snapshot' +
    '</div>' +

    '<div class="summaryGrid">';

  html +=
    metricCard(
      'P/E',
      result
        .valuation
        ?.peRatio ===
          null ||
      result
        .valuation
        ?.peRatio ===
          undefined
        ? 'N/A'
        : formatNumber(
            result
              .valuation
              .peRatio
          )
    );

  html +=
    metricCard(
      'Dividend yield',
      result
        .valuation
        ?.dividendYield ===
          null ||
      result
        .valuation
        ?.dividendYield ===
          undefined
        ? 'N/A'
        : formatPercent(
            result
              .valuation
              .dividendYield
          )
    );

  if (annualEPS) {
    html +=
      metricCard(
        'Latest annual EPS',
        escapeHtml(
          annualEPS.raw ||
          'N/A'
        ),
        annualEPS.period
      );
  }

  if (annualPAT) {
    html +=
      metricCard(
        'Latest annual PAT',
        escapeHtml(
          annualPAT.raw ||
          'N/A'
        ) +
        ' (000s)',
        annualPAT.period
      );
  }

  if (annualIncome) {
    html +=
      metricCard(
        incomeRow
          ?.label ||
        'Latest annual income',

        escapeHtml(
          annualIncome.raw ||
          'N/A'
        ) +
        ' (000s)',

        annualIncome.period
      );
  }

  if (
    result
      .valuation
      ?.marketCapPkr !==
      null &&
    result
      .valuation
      ?.marketCapPkr !==
      undefined
  ) {
    html +=
      metricCard(
        'Market cap',
        formatCompactPKR(
          result
            .valuation
            .marketCapPkr
        )
      );
  }

  html +=
    '</div>';

  html +=
    renderFinancialTable(
      'Annual financials',
      result.annual
    );

  html +=
    renderFinancialTable(
      'Recent quarterly financials',
      result.quarterly
    );

  html +=
    renderFinancialTable(
      'Ratios',
      result.ratios
    );

  html +=
    '<div class="sourceNote">' +
    'Source: ' +
    escapeHtml(
      result.source
    ) +

    (
      result.fetchedAt
        ? (
            ' &bull; fetched ' +
            escapeHtml(
              formatDateTime(
                result.fetchedAt
              )
            )
          )
        : ''
    ) +

    '. Values are shown as published/standardized by the source; no missing values are invented.' +

    '</div>';

  $('research')
    .innerHTML =
      html;
}

/* ---------------------------------------
   EVENTS
--------------------------------------- */

function renderEvents(
  result
) {
  updateSelectedCompany(
    result
  );

  let html =
    '<div class="decisionSectionTitle">' +
    'Recent company events & announcements' +
    '</div>';

  if (
    !Array.isArray(
      result.events
    ) ||
    !result.events.length
  ) {
    html +=
      '<div class="emptyState">' +
      'No recent structured announcements were available from the connected PSX source for this symbol.' +
      '</div>';
  } else {
    html +=
      '<div class="eventList">' +

      result.events
        .slice(
          0,
          15
        )
        .map(
          item =>
            '<div class="eventItem">' +

            '<div class="eventMeta">' +

            '<span>' +
            escapeHtml(
              item.date
            ) +
            '</span>' +

            '<span class="pill">' +
            escapeHtml(
              item.type ||
              'Corporate'
            ) +
            '</span>' +

            '</div>' +

            '<div class="eventTitle">' +
            escapeHtml(
              item.title
            ) +
            '</div>' +

            (
              item.documentUrl
                ? (
                    '<a class="eventLink" href="' +
                    escapeHtml(
                      item.documentUrl
                    ) +
                    '" target="_blank" rel="noopener noreferrer">' +
                    'Open PSX document' +
                    '</a>'
                  )
                : ''
            ) +

            '</div>'
        )
        .join('') +

      '</div>';
  }

  html +=
    '<div class="sourceNote">' +
    'Source: ' +
    escapeHtml(
      result.source
    ) +

    (
      result.fetchedAt
        ? (
            ' &bull; fetched ' +
            escapeHtml(
              formatDateTime(
                result.fetchedAt
              )
            )
          )
        : ''
    ) +

    '.</div>';

  $('research')
    .innerHTML =
      html;
}

/* ---------------------------------------
   BUTTON ACTIONS
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

      if (!symbol) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      showSelectedCompany(
        symbol
      );

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Loading decision overview...' +
          '</p>';

      try {
        const result =
          await api(
            'quote',
            {
              symbol
            }
          );

        updateSelectedCompany(
          result
        );

        lastQuoteResult =
          result;

        renderDecisionOverview(
          result
        );

        startLiveOverview(
          symbol,
          result.live ||
          null
        );

      } catch (error) {

        $('error')
          .textContent =
            error.message;

        $('research')
          .innerHTML =
            '';
      }
    };

$('loadLiveChart')
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

      if (!symbol) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      showSelectedCompany(
        symbol
      );

      startLiveChart(
        symbol
      );
    };

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

      if (!symbol) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      loadHistoryView(
        symbol,
        selectedHistoryRange ||
        '1Y'
      );
    };

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

      if (!symbol) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      showSelectedCompany(
        symbol
      );

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Loading company fundamentals...' +
          '</p>';

      try {
        const result =
          await api(
            'fundamentals',
            {
              symbol
            }
          );

        renderFundamentals(
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

$('loadEvents')
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

      if (!symbol) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      showSelectedCompany(
        symbol
      );

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Loading recent company events...' +
          '</p>';

      try {
        const result =
          await api(
            'events',
            {
              symbol
            }
          );

        renderEvents(
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

$('loadMore')
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

      if (!symbol) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      showSelectedCompany(
        symbol
      );

      try {
        let result =
          lastQuoteResult &&
          lastQuoteResult.symbol ===
            symbol
            ? lastQuoteResult
            : null;

        if (!result) {
          $('research')
            .innerHTML =
              '<p class="muted">' +
              'Loading additional market data...' +
              '</p>';

          result =
            await api(
              'quote',
              {
                symbol
              }
            );

          lastQuoteResult =
            result;
        }

        updateSelectedCompany(
          result
        );

        renderMoreData(
          result
        );

      } catch (error) {

        $('error')
          .textContent =
            error.message;

        $('research')
          .innerHTML =
            '';
      }
    };

$('stockSymbol')
  .oninput =
    () => {

      stopLiveRefresh();

      lastQuoteResult =
        null;

      selectedHistoryRange =
        '1Y';

      $('liveStatus')
        .innerHTML =
          '';
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
          'Market: connected | ' +
          'Company metadata: connected | ' +
          'pyPSX: ' +
          (
            result.pyPSXConfigured
              ? 'configured'
              : 'not configured'
          ) +
          ' | Fundamentals: PSX company data' +
          ' | Prediction engine: ' +
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
