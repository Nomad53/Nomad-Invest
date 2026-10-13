'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const PSX_UNIVERSE_MASTER = require('../data/psx-universe.json');

const PSX_UNIVERSE_BY_SYMBOL = new Map(
  (PSX_UNIVERSE_MASTER.entries || []).map(entry => [String(entry.symbol || '').trim().toUpperCase(), entry])
);

const VERSION = '0.9.3.0';


const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL ||
    ''
  )
    .trim()
    .replace(
      /\/rest\/v1\/?$/i,
      ''
    )
    .replace(
      /\/+$/,
      ''
    );

const SUPABASE_SECRET_KEY =
  String(
    process.env.SUPABASE_SECRET_KEY ||
    ''
  ).trim();


const NOMAD_SCANNER_SECRET =
  String(
    process.env.NOMAD_SCANNER_SECRET ||
    ''
  ).trim();

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

const PSX_ALLSHR_URL =
  `${PSX_DPS_BASE}/indices/ALLSHR`;

const PSX_MARKET_WATCH_URL =
  `${PSX_DPS_BASE}/market-watch`;

const PSX_SCREENER_URL =
  `${PSX_DPS_BASE}/screener/`;

const PYPSX_PUBLIC_MARKET_URL =
  process.env.PYPSX_PUBLIC_MARKET_URL ||
  'https://www.pypsx.com/market';

const PSX_CORPORATE_BASE =
  process.env.PSX_CORPORATE_BASE ||
  'https://www.psx.com.pk';

const PSX_ENFORCEMENT_ACTIONS_URL =
  `${PSX_CORPORATE_BASE}/psx/regulations/enforcement-actions`;

const PSX_LISTED_COMPANIES_DATA_URL =
  `${PSX_CORPORATE_BASE}/psx/resources-and-tools/listings/listed-companies-data`;

const PSX_BULK_STATUS_FALLBACK_URLS = {
  suspended:
    `${PSX_CORPORATE_BASE}/psx/themes/psx/uploads/Suspended-companies-updated-22-6-2026.pdf`,

  delisted:
    `${PSX_CORPORATE_BASE}/psx/themes/psx/uploads/Delisted-Report-27-07-26.pdf`,

  merged:
    `${PSX_CORPORATE_BASE}/psx/themes/psx/uploads/Merger-Report-29-06-26.pdf`,

  renamed:
    `${PSX_CORPORATE_BASE}/psx/themes/psx/uploads/Change-of-Name-20-07-26.pdf`
};

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

/* =========================================================
   CACHE
========================================================= */

let marketCache = null;
let rawScreenerCache = null;
let sectorCache = null;
let companyCache = null;
let metadataAuditCache = null;
let bulkStatusCache = null;
let marketWatchCache = null;

const companyPageCache =
  new Map();

/* =========================================================
   CORE HELPERS
========================================================= */

function bad(
  message,
  status = 400
) {
  const error =
    new Error(message);

  error.status =
    status;

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

  const normalized =
    String(value)
      .replace(/,/g, '')
      .replace(/%/g, '')
      .replace(
        /^\((.*)\)$/,
        '-$1'
      )
      .trim();

  if (
    !normalized ||
    normalized === '-' ||
    /^n\/?a$/i.test(
      normalized
    )
  ) {
    return null;
  }

  const parsed =
    Number(normalized);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : null;
}

function normalizeSymbol(value) {
  return String(
    value || ''
  )
    .trim()
    .toUpperCase();
}

function normalizeRawMarketSymbol(
  value
) {
  return String(
    value || ''
  )
    .trim()
    .toUpperCase()
    .replace(
      /\s+/g,
      ' '
    );
}

function primaryMarketToken(
  value
) {
  return normalizeRawMarketSymbol(
    value
  )
    .split(/\s+/)
    .filter(Boolean)[0] ||
    '';
}

function isSecurityStatusToken(
  value
) {
  const token =
    normalizeSymbol(
      value
    );

  return (
    token === 'NC' ||
    /^X[A-Z]$/
      .test(
        token
      )
  );
}

function uniqueStrings(
  values
) {
  return [
    ...new Set(
      values
        .map(
          value =>
            String(
              value || ''
            )
              .trim()
              .toUpperCase()
        )
        .filter(Boolean)
    )
  ];
}

function uniqueTextValues(
  values
) {
  const output = [];
  const seen =
    new Set();

  for (
    const value
    of values
  ) {
    const text =
      String(
        value || ''
      ).trim();

    if (!text) {
      continue;
    }

    const key =
      text.toLowerCase();

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    output.push(text);
  }

  return output;
}

function mergeMetadataEvidence(
  current = {},
  incoming = {}
) {
  return {
    psxSymbols:
      Boolean(
        current.psxSymbols ||
        incoming.psxSymbols
      ),

    eligibleScrips:
      Boolean(
        current.eligibleScrips ||
        incoming.eligibleScrips
      ),

    allShare:
      Boolean(
        current.allShare ||
        incoming.allShare
      ),

    marketWatch:
      Boolean(
        current.marketWatch ||
        incoming.marketWatch
      ),

    pyPSX:
      Boolean(
        current.pyPSX ||
        incoming.pyPSX
      ),

    fallback:
      Boolean(
        current.fallback ||
        incoming.fallback
      )
  };
}

function normalizeTimestamp(
  value
) {
  const parsed =
    Date.parse(value);

  return Number.isFinite(
    parsed
  )
    ? new Date(
        parsed
      ).toISOString()
    : new Date()
        .toISOString();
}

function absoluteURL(value) {
  const raw =
    String(
      value || ''
    ).trim();

  if (!raw) {
    return null;
  }

  try {
    return new URL(
      raw,
      PSX_DPS_BASE
    ).toString();
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value)
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );
}

function decodeHtml(value) {
  return String(
    value || ''
  )
    .replace(
      /&nbsp;/gi,
      ' '
    )
    .replace(
      /&amp;/gi,
      '&'
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&apos;/gi,
      "'"
    )
    .replace(
      /&lt;/gi,
      '<'
    )
    .replace(
      /&gt;/gi,
      '>'
    )
    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCharCode(
          Number(code)
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCharCode(
          parseInt(
            code,
            16
          )
        )
    );
}

function cleanHtmlCell(value) {
  return decodeHtml(
    String(
      value || ''
    )
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
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function htmlToLines(html) {
  return decodeHtml(
    String(
      html || ''
    )
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
    .map(
      value =>
        value
          .replace(
            /\s+/g,
            ' '
          )
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
    String(
      label || ''
    ).toLowerCase();

  let seen = 0;

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const line =
      String(
        lines[index] || ''
      ).toLowerCase();

    if (
      !line.includes(
        target
      )
    ) {
      continue;
    }

    if (
      seen <
      occurrence
    ) {
      seen += 1;
      continue;
    }

    const sameLine =
      lines[index]
        .replace(
          new RegExp(
            escapeRegExp(
              label
            ),
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
      let next =
        index + 1;

      next <
        Math.min(
          lines.length,
          index + 6
        );

      next += 1
    ) {
      const candidate =
        lines[next];

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
    ? safeNumber(
        match[0]
      )
    : null;
}

function findExactNumericAfterLabel(
  lines,
  label
) {
  const target =
    String(label)
      .trim()
      .toUpperCase();

  for (
    let index = 0;
    index < lines.length;
    index++
  ) {
    const current =
      String(
        lines[index] || ''
      )
        .trim()
        .toUpperCase();

    if (
      current !== target
    ) {
      continue;
    }

    for (
      let next =
        index + 1;

      next <
        Math.min(
          lines.length,
          index + 5
        );

      next++
    ) {
      const match =
        String(
          lines[next] || ''
        )
          .match(
            /\(?-?[\d,.]+(?:\.\d+)?\)?/
          );

      if (match) {
        const number =
          safeNumber(
            match[0]
          );

        if (
          number !== null
        ) {
          return number;
        }
      }
    }
  }

  return null;
}

function dateLike(value) {
  return (
    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i
      .test(
        String(
          value || ''
        ).trim()
      ) ||
    /^\d{4}-\d{2}-\d{2}$/
      .test(
        String(
          value || ''
        ).trim()
      )
  );
}

function dateKeyFromDate(
  value
) {
  const time =
    Date.parse(value);

  if (
    !Number.isFinite(
      time
    )
  ) {
    return '';
  }

  return new Date(time)
    .toISOString()
    .slice(
      0,
      10
    );
}

/* =========================================================
   HTML TABLE PARSING
========================================================= */

function parseHTMLTables(html) {
  const tables = [];

  const tableRegex =
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  let tableMatch;

  while (
    (
      tableMatch =
        tableRegex.exec(
          String(
            html || ''
          )
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

      if (
        cells.length
      ) {
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

    if (
      rows.length
    ) {
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
    tableToMatrix(
      table
    );

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
      matrix[0] ||
      [];

    const headerText =
      header.join(' ');

    return /\bq[1-4]\b/i
      .test(
        headerText
      )
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
    table.rows.filter(
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

  if (
    !matrix.length
  ) {
    return null;
  }

  const header =
    matrix[0];

  const periods =
    header
      .slice(1)
      .filter(Boolean);

  if (
    !periods.length
  ) {
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

/* =========================================================
   ANNOUNCEMENTS
========================================================= */

function inferAnnouncementType(
  title
) {
  const text =
    String(
      title || ''
    ).toLowerCase();

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
    ) ||
    text.includes(
      'payout'
    )
  ) {
    return 'Payout';
  }

  if (
    text.includes(
      'financial result'
    ) ||
    text.includes(
      'quarterly'
    ) ||
    text.includes(
      'half yearly'
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

  return announcements.filter(
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

/* =========================================================
   HTTP
========================================================= */

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
          AbortSignal.timeout(
            timeout
          )
      }
    );

  if (
    !response.ok
  ) {
    let message =
      `Data service returned HTTP ${response.status}.`;

    try {
      const body =
        await response.json();

      if (
        body?.error
          ?.message
      ) {
        message =
          body
            .error
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

  return response.json();
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
            `Mozilla/5.0 NOMAD-Invest/${VERSION}`,

          ...headers
        },

        signal:
          AbortSignal.timeout(
            timeout
          )
      }
    );

  if (
    !response.ok
  ) {
    bad(
      `Data service returned HTTP ${response.status}.`,
      response.status
    );
  }

  return response.text();
}

async function fetchBuffer(
  url,
  timeout = 30000,
  headers = {}
) {
  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            'application/pdf,text/html,application/xhtml+xml,*/*',

          'User-Agent':
            `Mozilla/5.0 NOMAD-Invest/${VERSION}`,

          ...headers
        },

        signal:
          AbortSignal.timeout(
            timeout
          )
      }
    );

  if (
    !response.ok
  ) {
    bad(
      `Data service returned HTTP ${response.status}.`,
      response.status
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return {
    buffer:
      Buffer.from(
        arrayBuffer
      ),

    contentType:
      String(
        response.headers.get(
          'content-type'
        ) ||
        ''
      ),

    finalUrl:
      response.url ||
      url
  };
}

function decodePdfHexUnicode(
  hex
) {
  const cleaned =
    String(
      hex ||
      ''
    )
      .replace(
        /\s+/g,
        ''
      )
      .replace(
        /[^0-9a-f]/gi,
        ''
      );

  if (!cleaned) {
    return '';
  }

  const evenHex =
    cleaned.length % 2
      ? cleaned + '0'
      : cleaned;

  const bytes =
    Buffer.from(
      evenHex,
      'hex'
    );

  if (
    bytes.length >= 2 &&
    bytes.length % 2 === 0
  ) {
    let output = '';

    for (
      let index = 0;
      index < bytes.length;
      index += 2
    ) {
      output +=
        String.fromCharCode(
          bytes.readUInt16BE(
            index
          )
        );
    }

    if (
      /[\u0020-\u007e\u00a0-\uffff]/
        .test(
          output
        )
    ) {
      return output;
    }
  }

  return bytes
    .toString(
      'latin1'
    );
}

function incrementPdfHex(
  hex,
  offset
) {
  const width =
    String(
      hex ||
      ''
    ).length;

  try {
    return (
      BigInt(
        '0x' +
        hex
      ) +
      BigInt(
        offset
      )
    )
      .toString(16)
      .toUpperCase()
      .padStart(
        width,
        '0'
      );
  } catch {
    return hex;
  }
}

function buildPdfUnicodeMap(
  streamTexts
) {
  const map =
    new Map();

  for (
    const text
    of streamTexts
  ) {
    const source =
      String(
        text ||
        ''
      );

    const bfcharRegex =
      /beginbfchar([\s\S]*?)endbfchar/gi;

    let blockMatch;

    while (
      (
        blockMatch =
          bfcharRegex.exec(
            source
          )
      )
    ) {
      const pairRegex =
        /<([0-9A-F]+)>\s*<([0-9A-F]+)>/gi;

      let pair;

      while (
        (
          pair =
            pairRegex.exec(
              blockMatch[1]
            )
        )
      ) {
        map.set(
          pair[1]
            .toUpperCase(),
          decodePdfHexUnicode(
            pair[2]
          )
        );
      }
    }

    const bfrangeRegex =
      /beginbfrange([\s\S]*?)endbfrange/gi;

    while (
      (
        blockMatch =
          bfrangeRegex.exec(
            source
          )
      )
    ) {
      const rangeSource =
        blockMatch[1];

      const simpleRangeRegex =
        /<([0-9A-F]+)>\s*<([0-9A-F]+)>\s*<([0-9A-F]+)>/gi;

      let range;

      while (
        (
          range =
            simpleRangeRegex.exec(
              rangeSource
            )
        )
      ) {
        try {
          const start =
            BigInt(
              '0x' +
              range[1]
            );

          const end =
            BigInt(
              '0x' +
              range[2]
            );

          const count =
            Number(
              end -
              start
            );

          if (
            count < 0 ||
            count > 4096
          ) {
            continue;
          }

          for (
            let index = 0;
            index <= count;
            index++
          ) {
            map.set(
              incrementPdfHex(
                range[1],
                index
              ),
              decodePdfHexUnicode(
                incrementPdfHex(
                  range[3],
                  index
                )
              )
            );
          }
        } catch {}
      }

      const arrayRangeRegex =
        /<([0-9A-F]+)>\s*<([0-9A-F]+)>\s*\[([\s\S]*?)\]/gi;

      while (
        (
          range =
            arrayRangeRegex.exec(
              rangeSource
            )
        )
      ) {
        const destinations =
          [
            ...range[3]
              .matchAll(
                /<([0-9A-F]+)>/gi
              )
          ]
            .map(
              match =>
                match[1]
            );

        for (
          let index = 0;
          index < destinations.length;
          index++
        ) {
          map.set(
            incrementPdfHex(
              range[1],
              index
            ),
            decodePdfHexUnicode(
              destinations[index]
            )
          );
        }
      }
    }
  }

  return map;
}

function parsePdfLiteralBytes(
  token
) {
  const source =
    String(
      token ||
      ''
    );

  const output = [];

  for (
    let index = 1;
    index < source.length - 1;
    index++
  ) {
    const character =
      source[index];

    if (
      character !==
      '\\'
    ) {
      output.push(
        source.charCodeAt(
          index
        ) &
        255
      );

      continue;
    }

    index++;

    if (
      index >=
      source.length - 1
    ) {
      break;
    }

    const escaped =
      source[index];

    const simpleEscapes = {
      n: 10,
      r: 13,
      t: 9,
      b: 8,
      f: 12,
      '(': 40,
      ')': 41,
      '\\': 92
    };

    if (
      Object.prototype.hasOwnProperty.call(
        simpleEscapes,
        escaped
      )
    ) {
      output.push(
        simpleEscapes[
          escaped
        ]
      );

      continue;
    }

    if (
      /[0-7]/
        .test(
          escaped
        )
    ) {
      let octal =
        escaped;

      for (
        let count = 0;
        count < 2 &&
        index + 1 <
          source.length - 1 &&
        /[0-7]/
          .test(
            source[
              index + 1
            ]
          );
        count++
      ) {
        index++;
        octal +=
          source[index];
      }

      output.push(
        parseInt(
          octal,
          8
        ) &
        255
      );

      continue;
    }

    if (
      escaped === '\n' ||
      escaped === '\r'
    ) {
      if (
        escaped === '\r' &&
        source[
          index + 1
        ] === '\n'
      ) {
        index++;
      }

      continue;
    }

    output.push(
      escaped.charCodeAt(
        0
      ) &
      255
    );
  }

  return Buffer.from(
    output
  );
}

function decodePdfTextBytes(
  bytes,
  unicodeMap
) {
  if (
    !bytes ||
    !bytes.length
  ) {
    return '';
  }

  if (
    unicodeMap &&
    unicodeMap.size
  ) {
    const hex =
      Buffer.from(
        bytes
      )
        .toString(
          'hex'
        )
        .toUpperCase();

    const keyLengths =
      [
        ...new Set(
          [
            ...unicodeMap.keys()
          ].map(
            key =>
              key.length
          )
        )
      ]
        .sort(
          (
            a,
            b
          ) =>
            b - a
        );

    let cursor = 0;
    let decoded = '';
    let matched = 0;

    while (
      cursor <
      hex.length
    ) {
      let found = false;

      for (
        const length
        of keyLengths
      ) {
        const key =
          hex.slice(
            cursor,
            cursor + length
          );

        if (
          key.length !==
            length ||
          !unicodeMap.has(
            key
          )
        ) {
          continue;
        }

        decoded +=
          unicodeMap.get(
            key
          );

        cursor +=
          length;

        matched++;
        found = true;
        break;
      }

      if (!found) {
        const byteHex =
          hex.slice(
            cursor,
            cursor + 2
          );

        if (
          byteHex.length === 2
        ) {
          decoded +=
            String.fromCharCode(
              parseInt(
                byteHex,
                16
              )
            );
        }

        cursor += 2;
      }
    }

    if (
      matched > 0
    ) {
      return decoded;
    }
  }

  const buffer =
    Buffer.from(
      bytes
    );

  if (
    buffer.length >= 2 &&
    buffer.length % 2 === 0
  ) {
    let nullCount = 0;

    for (
      let index = 0;
      index < buffer.length;
      index += 2
    ) {
      if (
        buffer[index] === 0
      ) {
        nullCount++;
      }
    }

    if (
      nullCount >=
      Math.max(
        2,
        buffer.length /
        6
      )
    ) {
      let unicode = '';

      for (
        let index = 0;
        index < buffer.length;
        index += 2
      ) {
        unicode +=
          String.fromCharCode(
            buffer.readUInt16BE(
              index
            )
          );
      }

      return unicode;
    }
  }

  const utf8 =
    buffer.toString(
      'utf8'
    );

  const replacementCount =
    (
      utf8.match(
        /\uFFFD/g
      ) ||
      []
    ).length;

  return replacementCount <= 1
    ? utf8
    : buffer.toString(
        'latin1'
      );
}

function extractPdfTextFromStream(
  content,
  unicodeMap
) {
  const output = [];

  const pushToken =
    token => {
      if (!token) {
        return;
      }

      let bytes;

      if (
        token.startsWith(
          '('
        )
      ) {
        bytes =
          parsePdfLiteralBytes(
            token
          );
      } else {
        const hex =
          token
            .slice(
              1,
              -1
            )
            .replace(
              /\s+/g,
              ''
            );

        if (!hex) {
          return;
        }

        bytes =
          Buffer.from(
            hex.length % 2
              ? hex + '0'
              : hex,
            'hex'
          );
      }

      const text =
        decodePdfTextBytes(
          bytes,
          unicodeMap
        )
          .replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
            ' '
          )
          .trim();

      if (text) {
        output.push(
          text
        );
      }
    };

  const directRegex =
    /(\((?:\\.|[^\\()])*\)|<[0-9A-F\s]+>)\s*(?:Tj|'|")/gi;

  let match;

  while (
    (
      match =
        directRegex.exec(
          content
        )
    )
  ) {
    pushToken(
      match[1]
    );
  }

  const arrayRegex =
    /\[([\s\S]*?)\]\s*TJ/gi;

  while (
    (
      match =
        arrayRegex.exec(
          content
        )
    )
  ) {
    const tokenRegex =
      /(\((?:\\.|[^\\()])*\)|<[0-9A-F\s]+>)/gi;

    let token;

    while (
      (
        token =
          tokenRegex.exec(
            match[1]
          )
      )
    ) {
      pushToken(
        token[1]
      );
    }
  }

  return output.join(
    ' '
  );
}

function extractPdfText(
  buffer
) {
  const binary =
    Buffer.from(
      buffer
    )
      .toString(
        'latin1'
      );

  const streams = [];
  let cursor = 0;

  while (
    cursor <
    binary.length
  ) {
    const streamIndex =
      binary.indexOf(
        'stream',
        cursor
      );

    if (
      streamIndex < 0
    ) {
      break;
    }

    let dataStart =
      streamIndex + 6;

    if (
      binary[
        dataStart
      ] === '\r' &&
      binary[
        dataStart + 1
      ] === '\n'
    ) {
      dataStart += 2;
    } else if (
      binary[
        dataStart
      ] === '\n' ||
      binary[
        dataStart
      ] === '\r'
    ) {
      dataStart += 1;
    }

    const endIndex =
      binary.indexOf(
        'endstream',
        dataStart
      );

    if (
      endIndex < 0
    ) {
      break;
    }

    const dictionaryStart =
      Math.max(
        0,
        binary.lastIndexOf(
          '<<',
          streamIndex
        )
      );

    const dictionary =
      binary.slice(
        Math.max(
          0,
          dictionaryStart
        ),
        streamIndex
      );

    let data =
      Buffer.from(
        buffer
      ).subarray(
        dataStart,
        endIndex
      );

    try {
      if (
        /\/FlateDecode/i
          .test(
            dictionary
          )
      ) {
        data =
          zlib.inflateSync(
            data
          );
      } else if (
        /\/ASCIIHexDecode/i
          .test(
            dictionary
          )
      ) {
        const hex =
          data
            .toString(
              'latin1'
            )
            .replace(
              />[\s\S]*$/,
              ''
            )
            .replace(
              /\s+/g,
              ''
            );

        data =
          Buffer.from(
            hex.length % 2
              ? hex + '0'
              : hex,
            'hex'
          );
      }
    } catch {
      cursor =
        endIndex + 9;

      continue;
    }

    streams.push(
      data.toString(
        'latin1'
      )
    );

    cursor =
      endIndex + 9;
  }

  const unicodeMap =
    buildPdfUnicodeMap(
      streams
    );

  const output =
    streams
      .map(
        stream =>
          extractPdfTextFromStream(
            stream,
            unicodeMap
          )
      )
      .filter(Boolean)
      .join('\n')
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (
    output.length >= 100
  ) {
    return output;
  }

  // Some simple PDFs expose useful literal strings even outside content
  // streams. This is only a conservative fallback.
  const fallback = [];
  const rawStringRegex =
    /\(([^()]{3,160})\)/g;

  let rawMatch;

  while (
    (
      rawMatch =
        rawStringRegex.exec(
          binary
        )
    )
  ) {
    const candidate =
      rawMatch[1]
        .replace(
          /\\[nrtbf]/g,
          ' '
        )
        .replace(
          /\\([()\\])/g,
          '$1'
        )
        .replace(
          /[^\x20-\x7E]/g,
          ' '
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim();

    if (
      candidate.length >= 3
    ) {
      fallback.push(
        candidate
      );
    }
  }

  return fallback
    .join(' ')
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function absoluteCorporateURL(
  value
) {
  const raw =
    decodeHtml(
      String(
        value ||
        ''
      )
    )
      .trim();

  if (!raw) {
    return null;
  }

  try {
    return new URL(
      raw,
      PSX_CORPORATE_BASE
    ).toString();
  } catch {
    return null;
  }
}

function extractHTMLLinks(
  html
) {
  const links = [];
  const regex =
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (
      match =
        regex.exec(
          String(
            html ||
            ''
          )
        )
    )
  ) {
    const url =
      absoluteCorporateURL(
        match[1]
      );

    if (!url) {
      continue;
    }

    links.push({
      url,
      label:
        cleanHtmlCell(
          match[2]
        )
    });
  }

  return links;
}

function pickLatestPSXReportLink(
  links,
  patterns,
  fallback
) {
  const matches =
    links
      .filter(
        link => {
          const searchable =
            (
              link.url +
              ' ' +
              link.label
            )
              .toLowerCase();

          return patterns.some(
            pattern =>
              pattern.test(
                searchable
              )
          );
        }
      )
      .sort(
        (
          a,
          b
        ) =>
          b.url.localeCompare(
            a.url
          )
      );

  return matches[0]?.url ||
    fallback;
}

async function discoverPSXBulkStatusReports() {
  let links = [];

  const results =
    await Promise.allSettled([
      fetchText(
        PSX_ENFORCEMENT_ACTIONS_URL,
        20000
      ),
      fetchText(
        PSX_LISTED_COMPANIES_DATA_URL,
        20000
      )
    ]);

  for (
    const result
    of results
  ) {
    if (
      result.status ===
      'fulfilled'
    ) {
      links =
        links.concat(
          extractHTMLLinks(
            result.value
          )
        );
    }
  }

  return {
    suspended:
      pickLatestPSXReportLink(
        links,
        [
          /suspended[-_ ]companies/,
          /suspended-companies/
        ],
        PSX_BULK_STATUS_FALLBACK_URLS.suspended
      ),

    delisted:
      pickLatestPSXReportLink(
        links,
        [
          /delisted/
        ],
        PSX_BULK_STATUS_FALLBACK_URLS.delisted
      ),

    merged:
      pickLatestPSXReportLink(
        links,
        [
          /merger[-_ ]report/,
          /scheme[-_ ]of[-_ ]arrangement/,
          /merged[-_ ]companies/
        ],
        PSX_BULK_STATUS_FALLBACK_URLS.merged
      ),

    renamed:
      pickLatestPSXReportLink(
        links,
        [
          /change[-_ ]of[-_ ]name/,
          /renamed[-_ ]companies/
        ],
        PSX_BULK_STATUS_FALLBACK_URLS.renamed
      )
  };
}

function normalizedReportText(
  value
) {
  return (
    ' ' +
    normalizeCompanyIdentityName(
      value
    ) +
    ' '
  )
    .replace(
      /\s+/g,
      ' '
    );
}

function companyStatusNameVariants(
  companyName
) {
  const base =
    normalizeCompanyIdentityName(
      companyName
    );

  if (!base) {
    return [];
  }

  const variants =
    new Set([
      base,
      base
        .replace(
          /\bLTD\b/g,
          'LIMITED'
        ),
      base
        .replace(
          /\bLIMITED\b/g,
          'LTD'
        )
    ]);

  const stripped =
    base
      .replace(
        /\b(?:PRIVATE|PVT|PUBLIC)\b/g,
        ' '
      )
      .replace(
        /\b(?:LIMITED|LTD)\b$/,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (
    stripped.length >= 12 &&
    stripped.split(' ').length >= 2
  ) {
    variants.add(
      stripped
    );
  }

  return [
    ...variants
  ]
    .filter(
      value =>
        value.length >= 6
    );
}

function reportContainsCompany(
  reportText,
  companyName
) {
  if (
    !reportText ||
    !companyName
  ) {
    return false;
  }

  const normalized =
    normalizedReportText(
      reportText
    );

  return companyStatusNameVariants(
    companyName
  )
    .some(
      variant =>
        normalized.includes(
          ' ' +
          variant +
          ' '
        )
    );
}

function reportDateHintFromURL(
  url
) {
  const filename =
    String(
      url ||
      ''
    )
      .split('/')
      .pop() ||
    '';

  const match =
    filename.match(
      /(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})/
    );

  if (!match) {
    return null;
  }

  let year =
    Number(
      match[3]
    );

  if (
    year < 100
  ) {
    year += 2000;
  }

  const month =
    String(
      Number(
        match[2]
      )
    )
      .padStart(
        2,
        '0'
      );

  const day =
    String(
      Number(
        match[1]
      )
    )
      .padStart(
        2,
        '0'
      );

  return (
    year +
    '-' +
    month +
    '-' +
    day
  );
}

async function fetchPSXStatusReport(
  key,
  url
) {
  try {
    const fetched =
      await fetchBuffer(
        url,
        35000,
        {
          Referer:
            `${PSX_CORPORATE_BASE}/`
        }
      );

    let text = '';

    if (
      fetched.contentType
        .toLowerCase()
        .includes(
          'html'
        )
    ) {
      text =
        htmlToLines(
          fetched.buffer
            .toString(
              'utf8'
            )
        )
          .join(' ');
    } else {
      text =
        extractPdfText(
          fetched.buffer
        );
    }

    const usable =
      normalizeCompanyIdentityName(
        text
      ).length >= 80;

    return {
      key,
      url:
        fetched.finalUrl ||
        url,
      reportDate:
        reportDateHintFromURL(
          fetched.finalUrl ||
          url
        ),
      contentType:
        fetched.contentType,
      loaded:
        usable,
      text:
        usable
          ? text
          : '',
      textLength:
        text.length,
      error:
        usable
          ? null
          : 'Report downloaded but text extraction was insufficient.'
    };
  } catch (error) {
    return {
      key,
      url,
      reportDate:
        reportDateHintFromURL(
          url
        ),
      contentType:
        null,
      loaded:
        false,
      text:
        '',
      textLength:
        0,
      error:
        error?.message ||
        'Bulk report request failed.'
    };
  }
}

async function loadPSXBulkStatusEvidence() {
  if (
    bulkStatusCache &&
    Date.now() -
      bulkStatusCache.fetchedAt <
      6 *
      60 *
      60 *
      1000
  ) {
    return bulkStatusCache.data;
  }

  const urls =
    await discoverPSXBulkStatusReports();

  const definitions = [
    {
      key:
        'suspended',
      status:
        'SUSPENDED',
      label:
        'Suspended',
      url:
        urls.suspended
    },
    {
      key:
        'delisted',
      status:
        'DELISTED',
      label:
        'Delisted',
      url:
        urls.delisted
    },
    {
      key:
        'merged',
      status:
        'MERGED',
      label:
        'Merged / amalgamated',
      url:
        urls.merged
    },
    {
      key:
        'renamed',
      status:
        'CHANGED',
      label:
        'Changed / renamed',
      url:
        urls.renamed
    }
  ];

  const reports = [];

  // Corporate PSX bulk documents are intentionally fetched with low
  // concurrency. This replaces the former hundreds of DPS company-page
  // requests used only for universe QA.
  for (
    const definition
    of definitions
  ) {
    reports.push({
      ...definition,
      ...(
        await fetchPSXStatusReport(
          definition.key,
          definition.url
        )
      )
    });
  }

  const data = {
    resolvedAt:
      new Date()
        .toISOString(),
    urls,
    reports,
    loadedReports:
      reports.filter(
        report =>
          report.loaded
      ).length,
    failedReports:
      reports.filter(
        report =>
          !report.loaded
      ).length
  };

  bulkStatusCache = {
    fetchedAt:
      Date.now(),
    data
  };

  return data;
}

function applyBulkStatusEvidenceToRow(
  row,
  bulkStatus
) {
  if (!row) {
    return row;
  }

  const matches =
    (
      bulkStatus?.reports ||
      []
    )
      .filter(
        report =>
          report.loaded &&
          reportContainsCompany(
            report.text,
            row.companyName
          )
      );

  if (
    !matches.length
  ) {
    const base = {
      ...row
    };

    // Once bulk historical/suspension sources have been checked, a row
    // without current evidence is review-required rather than guessed stale.
    if (
      !base.hasOfficialCurrentEvidence &&
      !base.isSpecialSecurity
    ) {
      base.universeClass =
        'REVIEW_REQUIRED';
      base.universeLabel =
        'Review required';
      base.universeReason =
        'No current official-listing evidence and no matching official bulk status record were found. Keep out of the recommendation universe until verified.';
      base.tradingStatus =
        'UNKNOWN';
      base.tradingStatusLabel =
        'Current status unresolved after bulk-list checks';
    }

    const eligibility =
      deriveEligibility(
        base
      );

    const withEligibility = {
      ...base,
      ...eligibility
    };

    return {
      ...withEligibility,
      ...deriveIssueState(
        withEligibility
      )
    };
  }

  const suspended =
    matches.find(
      report =>
        report.key ===
        'suspended'
    );

  let selected =
    suspended ||
    matches.find(
      report =>
        !row.hasOfficialCurrentEvidence &&
        report.key ===
          'delisted'
    ) ||
    matches.find(
      report =>
        !row.hasOfficialCurrentEvidence &&
        report.key ===
          'merged'
    ) ||
    matches.find(
      report =>
        !row.hasOfficialCurrentEvidence &&
        report.key ===
          'renamed'
    ) ||
    null;

  // Historical reports often include a current successor company in a
  // second column. Current official listing evidence therefore wins unless
  // the security is explicitly present on the current Suspended report.
  if (!selected) {
    const base = {
      ...row,
      bulkStatusMatches:
        matches.map(
          report =>
            report.key
        )
    };

    const eligibility =
      deriveEligibility(
        base
      );

    const withEligibility = {
      ...base,
      ...eligibility
    };

    return {
      ...withEligibility,
      ...deriveIssueState(
        withEligibility
      )
    };
  }

  const evidenceLabel =
    'PSX bulk ' +
    selected.key +
    ' report' +
    (
      selected.reportDate
        ? (
            ' (' +
            selected.reportDate +
            ')'
          )
        : ''
    );

  const metadataSources =
    uniqueTextValues([
      ...(
        row.metadataSources ||
        []
      ),
      evidenceLabel
    ]);

  const officialEvidenceSources =
    uniqueTextValues([
      ...(
        row.officialEvidenceSources ||
        []
      ),
      evidenceLabel
    ]);

  let universeClass =
    row.universeClass;

  let universeLabel =
    row.universeLabel;

  let universeReason =
    row.universeReason;

  if (
    selected.status ===
    'SUSPENDED'
  ) {
    universeClass =
      row.isSpecialSecurity
        ? 'SPECIAL_INSTRUMENT'
        : 'SUSPENDED_SECURITY';
    universeLabel =
      row.isSpecialSecurity
        ? 'Special instrument'
        : 'Suspended security';
    universeReason =
      'Official PSX suspended-companies bulk report matches this security identity.';
  } else {
    universeClass =
      'HISTORICAL_OR_INACTIVE';
    universeLabel =
      'Historical / inactive';
    universeReason =
      'Official PSX bulk historical-status report matches this security identity.';
  }

  const enriched = {
    ...row,
    tradingStatus:
      selected.status,
    tradingStatusLabel:
      selected.label,
    statusEvidence:
      evidenceLabel,
    bulkStatusReportKey:
      selected.key,
    bulkStatusReportURL:
      selected.url,
    bulkStatusReportDate:
      selected.reportDate,
    bulkStatusMatches:
      matches.map(
        report =>
          report.key
      ),
    metadataSources,
    officialEvidenceSources,
    universeClass,
    universeLabel,
    universeReason
  };

  const eligibility =
    deriveEligibility(
      enriched
    );

  const withEligibility = {
    ...enriched,
    ...eligibility
  };

  return {
    ...withEligibility,
    ...deriveIssueState(
      withEligibility
    )
  };
}

/* =========================================================
   SYMBOL IDENTITY / NORMALIZATION
========================================================= */

function isOfficialCanonicalEntry(
  metadata
) {
  return Boolean(
    metadata &&
    metadata.isCanonical ===
      true
  );
}

function resolveSymbolIdentity(
  rawValue,
  companyMap
) {
  const rawSymbol =
    normalizeRawMarketSymbol(
      rawValue
    );

  if (!rawSymbol) {
    return {
      rawSymbol: '',
      tradingSymbol: '',
      canonicalSymbol: '',
      statusCodes: [],
      normalized: false,
      reason:
        'empty'
    };
  }

  const tokens =
    rawSymbol
      .split(/\s+/)
      .filter(Boolean);

  const primary =
    tokens[0];

  const standaloneStatuses =
    tokens
      .slice(1)
      .filter(
        isSecurityStatusToken
      );

  const exactMetadata =
    companyMap?.get(
      primary
    );

  if (
    isOfficialCanonicalEntry(
      exactMetadata
    )
  ) {
    return {
      rawSymbol,

      tradingSymbol:
        primary,

      canonicalSymbol:
        primary,

      statusCodes:
        uniqueStrings(
          standaloneStatuses
        ),

      normalized:
        standaloneStatuses.length >
        0,

      reason:
        standaloneStatuses.length
          ? 'standalone-status'
          : 'official-exact'
    };
  }

  let candidate =
    primary;

  const suffixStatuses =
    [];

  while (
    candidate.length >
    2
  ) {
    const suffix =
      candidate.slice(
        -2
      );

    if (
      !isSecurityStatusToken(
        suffix
      )
    ) {
      break;
    }

    const proposedBase =
      candidate.slice(
        0,
        -2
      );

    if (!proposedBase) {
      break;
    }

    suffixStatuses.unshift(
      suffix
    );

    const baseMetadata =
      companyMap?.get(
        proposedBase
      );

    if (
      isOfficialCanonicalEntry(
        baseMetadata
      )
    ) {
      return {
        rawSymbol,

        tradingSymbol:
          primary,

        canonicalSymbol:
          proposedBase,

        statusCodes:
          uniqueStrings([
            ...suffixStatuses,
            ...standaloneStatuses
          ]),

        normalized:
          true,

        reason:
          'validated-status-suffix'
      };
    }

    candidate =
      proposedBase;
  }

  if (
    exactMetadata
  ) {
    return {
      rawSymbol,

      tradingSymbol:
        primary,

      canonicalSymbol:
        primary,

      statusCodes:
        uniqueStrings(
          standaloneStatuses
        ),

      normalized:
        standaloneStatuses.length >
        0,

      reason:
        'fallback-exact'
    };
  }

  return {
    rawSymbol,

    tradingSymbol:
      primary,

    canonicalSymbol:
      primary,

    statusCodes:
      uniqueStrings(
        standaloneStatuses
      ),

    normalized:
      standaloneStatuses.length >
      0,

    reason:
      'unresolved'
  };
}

/* =========================================================
   RAW SCREENER
========================================================= */

async function loadRawScreener() {
  if (
    rawScreenerCache &&
    Date.now() -
      rawScreenerCache.fetchedAt <
      60000
  ) {
    return rawScreenerCache.data;
  }

  const result =
    await fetchJSON(
      `${PSX_API_BASE}/screener`
    );

  if (
    !result ||
    !Array.isArray(
      result.data
    )
  ) {
    bad(
      'PSX screener returned an unexpected format.',
      502
    );
  }

  const data = {
    rows:
      result.data,

    timestamp:
      normalizeTimestamp(
        result?.meta?.timestamp
      )
  };

  rawScreenerCache = {
    fetchedAt:
      Date.now(),

    data
  };

  return data;
}

/* =========================================================
   CANONICAL PSX UNIVERSE MASTER - BUILD 0.7.0
========================================================= */

function getUniverseMasterEntry(symbol) {
  return PSX_UNIVERSE_BY_SYMBOL.get(
    normalizeSymbol(symbol)
  ) || null;
}

function universeSecurityLabel(type) {
  const labels = {
    ORDINARY_EQUITY: 'Ordinary equity',
    RIGHTS_ENTITLEMENT: 'Rights / entitlement',
    MODARABA_CERTIFICATE: 'Modaraba certificate',
    REIT_UNIT: 'REIT unit',
    FUND_UNIT: 'Fund unit',
    PREFERENCE_CLASS: 'Preference / special class',
    SPAC_EQUITY: 'SPAC equity'
  };

  return labels[type] || String(type || 'Unknown').replace(/_/g, ' ');
}

function universeIssuerLabel(type) {
  const labels = {
    COMPANY: 'Company',
    MODARABA: 'Modaraba',
    REIT: 'REIT',
    FUND: 'Fund',
    SPAC: 'SPAC'
  };

  return labels[type] || String(type || 'Unknown').replace(/_/g, ' ');
}

function loadMasterCompanyMap() {
  const map = new Map();

  for (const entry of (PSX_UNIVERSE_MASTER.entries || [])) {
    const symbol = normalizeSymbol(entry.symbol);
    if (!symbol) continue;

    mergeCompanyMetadata(
      map,
      symbol,
      {
        name: entry.companyName || symbol,
        sector: entry.sector && entry.sector !== 'Unknown' ? entry.sector : '',
        source: 'NOMAD universe master',
        sources: ['NOMAD universe master'],
        evidence: {
          universeMaster: true,
          masterCurrentVerified: entry.currentVerified === true
        },
        isCanonical: true
      }
    );
  }

  return map;
}

function masterRowForClient(entry) {
  const nameResolved = Boolean(
    entry.companyName &&
    entry.companyName !== entry.symbol &&
    String(entry.companyName).toUpperCase() !== 'UNRESOLVED'
  );

  const sectorResolved = Boolean(
    entry.sector &&
    String(entry.sector).toUpperCase() !== 'UNKNOWN'
  );

  const isSpecialSecurity =
    entry.universeClass === 'ALTERNATIVE_CURRENT' ||
    entry.securityType !== 'ORDINARY_EQUITY';

  const universeLabels = {
    CORE_EQUITY: 'Core equity',
    GEM_EQUITY: 'GEM equity',
    ALTERNATIVE_CURRENT: 'Alternative / special current',
    REVIEW_REQUIRED: 'Review required'
  };

  const eligibility =
    entry.universeClass === 'CORE_EQUITY'
      ? 'CORE_EQUITY_CANDIDATE'
      : entry.universeClass === 'GEM_EQUITY'
        ? 'GEM_EQUITY_CANDIDATE'
        : entry.universeClass === 'ALTERNATIVE_CURRENT'
          ? 'ALTERNATIVE_LISTED_SECURITY'
          : 'REVIEW_REQUIRED';

  return {
    symbol: entry.symbol,
    marketSymbol: entry.symbol,
    rawSymbol: entry.symbol,
    companyName: entry.companyName || entry.symbol,
    sector: entry.sector || 'Unknown',
    listedIn: entry.listedIn || '',
    statusCodes: [],
    normalizedStatus: false,
    nameResolved,
    sectorResolved,
    issuerType: entry.issuerType || 'UNKNOWN',
    issuerLabel: universeIssuerLabel(entry.issuerType),
    securityType: entry.securityType || 'UNKNOWN',
    securityLabel: universeSecurityLabel(entry.securityType),
    parentSymbol: entry.parentSymbol || null,
    classificationReason: entry.recommendationNote || '',
    classificationConfidence: entry.identityConfidence === 'VERIFIED_CURRENT' ? 'high' : 'review',
    instrumentType: entry.securityType || 'UNKNOWN',
    instrumentLabel: universeSecurityLabel(entry.securityType),
    isSpecialSecurity,
    tradingStatus: entry.masterStatus || 'REVIEW_REQUIRED',
    tradingStatusLabel: entry.currentVerified ? 'Current - canonical universe master' : 'Review required - quarantined',
    boardType: entry.board || null,
    boardLabel: entry.board === 'GEM' ? 'GEM Board' : entry.board === 'MAIN' ? 'Main Board' : null,
    successorName: null,
    successorSymbol: null,
    companyPageUrl: null,
    companyPageQuoteAsOf: null,
    hasOfficialPageEvidence: false,
    universeClass: entry.universeClass,
    universeLabel: universeLabels[entry.universeClass] || entry.universeClass,
    universeReason: entry.recommendationNote || '',
    metadataSources: entry.metadataSources || [],
    officialEvidenceSources: entry.officialEvidenceSources || [],
    supplementalEvidenceSources: [],
    hasOfficialCurrentEvidence: entry.currentVerified === true,
    eligibility,
    eligibilityLabel:
      eligibility === 'CORE_EQUITY_CANDIDATE'
        ? 'Core equity candidate'
        : eligibility === 'GEM_EQUITY_CANDIDATE'
          ? 'GEM equity candidate'
          : eligibility === 'ALTERNATIVE_LISTED_SECURITY'
            ? 'Alternative listed security'
            : 'Review required',
    eligibilityReason: entry.recommendationNote || '',
    recommendationEligible: entry.recommendationEligible === true,
    masterVersion: PSX_UNIVERSE_MASTER.masterVersion,
    issueType:
      !entry.currentVerified
        ? 'REVIEW_REQUIRED'
        : !nameResolved && !sectorResolved
          ? 'MISSING_NAME_AND_SECTOR'
          : !nameResolved
            ? 'MISSING_NAME'
            : !sectorResolved
              ? 'MISSING_SECTOR'
              : null,
    issueLabel:
      !entry.currentVerified
        ? 'Universe review required'
        : !nameResolved && !sectorResolved
          ? 'Name + sector missing'
          : !nameResolved
            ? 'Company name missing'
            : !sectorResolved
              ? 'Sector missing'
              : null,
    bucket: !entry.currentVerified ? 'UNIVERSE_REVIEW_REQUIRED' : null,
    bucketLabel: !entry.currentVerified ? 'Universe review required' : null,
    auditReason: entry.recommendationNote || ''
  };
}

/* =========================================================
   COMPANY METADATA
========================================================= */

function mergeCompanyMetadata(
  map,
  symbol,
  update
) {
  const key =
    normalizeSymbol(
      symbol
    );

  if (!key) {
    return;
  }

  const current =
    map.get(key) ||
    {};

  const currentName =
    String(
      current.name ||
      ''
    ).trim();

  const incomingName =
    String(
      update.name ||
      ''
    ).trim();

  const currentSector =
    String(
      current.sector ||
      ''
    ).trim();

  const incomingSector =
    String(
      update.sector ||
      ''
    ).trim();

  const sources =
    uniqueTextValues([
      ...(
        Array.isArray(
          current.sources
        )
          ? current.sources
          : [
              current.source
            ]
      ),

      ...(
        Array.isArray(
          update.sources
        )
          ? update.sources
          : [
              update.source
            ]
      )
    ]);

  const evidence =
    mergeMetadataEvidence(
      current.evidence || {},
      update.evidence || {}
    );

  map.set(
    key,
    {
      name:
        currentName &&
        currentName !==
          key
          ? currentName
          : (
              incomingName ||
              currentName ||
              key
            ),

      sector:
        currentSector ||
        incomingSector ||
        '',

      source:
        current.source ||
        update.source ||
        '',

      sources,

      evidence,

      isCanonical:
        Boolean(
          current.isCanonical ||
          update.isCanonical
        )
    }
  );
}

async function loadOfficialSymbolsMap() {
  const map =
    new Map();

  let response =
    null;

  try {
    // /symbols is a plain JSON endpoint. Keep the first request simple;
    // some upstream configurations reject AJAX-only headers.
    response =
      await fetchJSON(
        `${PSX_DPS_BASE}/symbols`,
        30000,
        {
          'User-Agent':
            `Mozilla/5.0 NOMAD-Invest/${VERSION}`
        }
      );
  } catch {
    try {
      response =
        await fetchJSON(
          `${PSX_DPS_BASE}/symbols`,
          30000,
          {
            'User-Agent':
              `Mozilla/5.0 NOMAD-Invest/${VERSION}`,

            Referer:
              `${PSX_DPS_BASE}/`
          }
        );
    } catch {}
  }

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

    mergeCompanyMetadata(
      map,
      symbol,
      {
        name:
          name ||
          symbol,

        sector,

        source:
          'PSX symbols',

        evidence: {
          psxSymbols:
            true
        },

        isCanonical:
          true
      }
    );
  }

  return map;
}

async function enrichFromEligibleScrips(
  map
) {
  try {
    const html =
      await fetchText(
        PSX_ELIGIBLE_SCRIPS_URL,
        30000
      );

    const tables =
      parseHTMLTables(
        html
      );

    for (
      const table
      of tables
    ) {
      for (
        const row
        of table.rows
      ) {
        if (
          row.cells.length <
          2
        ) {
          continue;
        }

        const symbol =
          normalizeSymbol(
            row.cells[0]
          );

        const name =
          String(
            row.cells[1] ||
            ''
          ).trim();

        if (
          !symbol ||
          !name ||
          symbol ===
            'SYMBOL' ||
          name.toUpperCase() ===
            'NAME'
        ) {
          continue;
        }

        if (
          !/^[A-Z0-9.-]{1,30}$/
            .test(
              symbol
            )
        ) {
          continue;
        }

        mergeCompanyMetadata(
          map,
          symbol,
          {
            name,

            source:
              'PSX eligible scrips',

            evidence: {
              eligibleScrips:
                true
            },

            isCanonical:
              true
          }
        );
      }
    }
  } catch {}
}

async function enrichFromAllShareIndex(
  map
) {
  try {
    const html =
      await fetchText(
        PSX_ALLSHR_URL,
        30000
      );

    const tables =
      parseHTMLTables(
        html
      );

    for (
      const table
      of tables
    ) {
      for (
        const row
        of table.rows
      ) {
        if (
          row.cells.length <
          2
        ) {
          continue;
        }

        const rawSymbol =
          normalizeRawMarketSymbol(
            row.cells[0]
          );

        const name =
          String(
            row.cells[1] ||
            ''
          ).trim();

        if (
          !rawSymbol ||
          !name ||
          rawSymbol ===
            'SYMBOL'
        ) {
          continue;
        }

        const primary =
          primaryMarketToken(
            rawSymbol
          );

        if (
          !primary
        ) {
          continue;
        }

        mergeCompanyMetadata(
          map,
          primary,
          {
            name,

            source:
              'PSX ALLSHR',

            evidence: {
              allShare:
                true
            },

            isCanonical:
              false
          }
        );
      }
    }
  } catch {}
}

function parseMarketWatchRows(
  html
) {
  const rows = [];

  const rowRegex =
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch;

  while (
    (
      rowMatch =
        rowRegex.exec(
          String(
            html ||
            ''
          )
        )
    ) !== null
  ) {
    const rowHtml =
      rowMatch[1];

    const fields = {};
    const cellTexts = [];

    const cellRegex =
      /<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi;

    let cellMatch;

    while (
      (
        cellMatch =
          cellRegex.exec(
            rowHtml
          )
      ) !== null
    ) {
      const attributes =
        cellMatch[1] ||
        '';

      const text =
        cleanHtmlCell(
          cellMatch[2]
        );

      cellTexts.push(
        text
      );

      const nameMatch =
        attributes.match(
          /data-name=["']([^"']+)["']/i
        );

      if (!nameMatch) {
        continue;
      }

      const key =
        String(
          nameMatch[1] ||
          ''
        )
          .trim()
          .toLowerCase();

      if (!key) {
        continue;
      }

      fields[key] =
        text;
    }

    // PSX has served both data-name cells and ordinary table cells over time.
    // If the attributes are absent, fall back to the documented column order.
    if (
      !fields.symbol &&
      cellTexts.length >= 9
    ) {
      if (cellTexts.length >= 11) {
        fields.symbol = cellTexts[0];
        fields.sector = cellTexts[1];
        fields['listed in'] = cellTexts[2];
        fields.ldcp = cellTexts[3];
        fields.open = cellTexts[4];
        fields.high = cellTexts[5];
        fields.low = cellTexts[6];
        fields.current = cellTexts[7];
        fields.change = cellTexts[8];
        fields['change (%)'] = cellTexts[9];
        fields.volume = cellTexts[10];
      } else {
        fields.symbol = cellTexts[0];
        fields.ldcp = cellTexts[1];
        fields.open = cellTexts[2];
        fields.high = cellTexts[3];
        fields.low = cellTexts[4];
        fields.current = cellTexts[5];
        fields.change = cellTexts[6];
        fields['change (%)'] = cellTexts[7];
        fields.volume = cellTexts[8];
      }
    }

    const symbol =
      normalizeRawMarketSymbol(
        fields.symbol ||
        ''
      );

    if (!symbol) {
      continue;
    }

    rows.push({
      symbol,

      sector:
        String(
          fields.sector ||
          ''
        ).trim(),

      listedIn:
        String(
          fields.listed ||
          fields['listed in'] ||
          ''
        ).trim(),

      ldcp:
        safeNumber(
          fields.ldcp
        ),

      open:
        safeNumber(
          fields.open
        ),

      high:
        safeNumber(
          fields.high
        ),

      low:
        safeNumber(
          fields.low
        ),

      current:
        safeNumber(
          fields.close ??
          fields.current
        ),

      change:
        safeNumber(
          fields.change
        ),

      changePct:
        safeNumber(
          fields.percentchange ??
          fields['change (%)'] ??
          fields['change%'] ??
          fields['change pct'] ??
          fields['change percentage'] ??
          fields['% change']
        ),

      volume:
        safeNumber(
          fields.volume
        )
    });
  }

  return rows;
}

async function enrichFromMarketWatch(
  map
) {
  try {
    const html =
      await fetchText(
        PSX_MARKET_WATCH_URL,
        30000,
        {
          Referer:
            `${PSX_DPS_BASE}/`,

          'X-Requested-With':
            'XMLHttpRequest'
        }
      );

    const rows =
      parseMarketWatchRows(
        html
      );

    for (
      const row
      of rows
    ) {
      const identity =
        resolveSymbolIdentity(
          row.symbol,
          map
        );

      const canonical =
        identity.canonicalSymbol ||
        primaryMarketToken(
          row.symbol
        );

      if (!canonical) {
        continue;
      }

      mergeCompanyMetadata(
        map,
        canonical,
        {
          source:
            'PSX market watch',

          evidence: {
            marketWatch:
              true
          },

          // Market-watch is strong current evidence, but it is not used
          // to invent a canonical identity when the identity layer has not
          // independently validated one.
          isCanonical:
            Boolean(
              map.get(
                canonical
              )?.isCanonical
            )
        }
      );
    }
  } catch {}
}

async function loadMarketWatchSnapshot(
  companyMap
) {
  if (
    marketWatchCache &&
    Date.now() -
      marketWatchCache.fetchedAt <
      30000
  ) {
    return marketWatchCache.data;
  }

  const html =
    await fetchText(
      PSX_MARKET_WATCH_URL,
      30000,
      {
        Referer:
          `${PSX_DPS_BASE}/`,

        'X-Requested-With':
          'XMLHttpRequest'
      }
    );

  const rawRows =
    parseMarketWatchRows(
      html
    );

  const canonicalRows =
    new Map();

  for (
    const row
    of rawRows
  ) {
    const identity =
      resolveSymbolIdentity(
        row.symbol,
        companyMap
      );

    const symbol =
      identity.canonicalSymbol ||
      primaryMarketToken(
        row.symbol
      );

    if (!symbol) {
      continue;
    }

    const master =
      getUniverseMasterEntry(
        symbol
      );

    const company =
      companyMap.get(
        symbol
      ) ||
      {};

    const normalized = {
      symbol,
      tradingSymbol:
        identity.tradingSymbol ||
        row.symbol,
      rawSymbol:
        identity.rawSymbol ||
        row.symbol,
      statusCodes:
        identity.statusCodes ||
        [],
      companyName:
        company.name ||
        master?.companyName ||
        symbol,
      sector:
        company.sector ||
        master?.sector ||
        row.sector ||
        'Unknown',
      listedIn:
        row.listedIn ||
        master?.listedIn ||
        '',
      universeClass:
        master?.universeClass ||
        'UNMAPPED_FEED',
      recommendationEligible:
        master?.recommendationEligible ===
        true,
      ldcp:
        row.ldcp,
      open:
        row.open,
      high:
        row.high,
      low:
        row.low,
      current:
        row.current,
      change:
        row.change,
      changePct:
        row.changePct,
      volume:
        row.volume
    };

    const previous =
      canonicalRows.get(
        symbol
      );

    if (
      !previous ||
      (
        normalized.volume ||
        0
      ) >
      (
        previous.volume ||
        0
      )
    ) {
      canonicalRows.set(
        symbol,
        normalized
      );
    }
  }

  const rows =
    [...canonicalRows.values()];

  const result = {
    asOf:
      new Date()
        .toISOString(),
    total:
      rows.length,
    rows
  };

  marketWatchCache = {
    fetchedAt:
      Date.now(),
    data:
      result
  };

  return result;
}


function normalizeOfficialScreenerHeader(
  value
) {
  return String(
    value || ''
  )
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim()
    .toUpperCase();
}

function officialScreenerColumnIndex(
  headers,
  matcher
) {
  for (
    let index = 0;
    index < headers.length;
    index += 1
  ) {
    if (
      matcher(
        normalizeOfficialScreenerHeader(
          headers[index]
        )
      )
    ) {
      return index;
    }
  }

  return -1;
}

function parseOfficialPSXScreenerRows(
  html
) {
  const tables =
    parseHTMLTables(
      html
    );

  for (
    const table
    of tables
  ) {
    const matrix =
      tableToMatrix(
        table
      );

    if (
      matrix.length < 2
    ) {
      continue;
    }

    const header =
      matrix[0] || [];

    const symbolIndex =
      officialScreenerColumnIndex(
        header,
        value =>
          value === 'SYMBOL'
      );

    const priceIndex =
      officialScreenerColumnIndex(
        header,
        value =>
          value === 'PRICE'
      );

    const changeIndex =
      officialScreenerColumnIndex(
        header,
        value =>
          value === 'CHANGE (%)' ||
          value === 'CHANGE %' ||
          value === '% CHANGE' ||
          value === 'CHANGE'
      );

    if (
      symbolIndex < 0 ||
      priceIndex < 0 ||
      changeIndex < 0
    ) {
      continue;
    }

    const sectorIndex =
      officialScreenerColumnIndex(
        header,
        value =>
          value === 'SECTOR'
      );

    const listedIndex =
      officialScreenerColumnIndex(
        header,
        value =>
          value === 'LISTED IN'
      );

    const rows = [];

    for (
      const sourceRow
      of matrix.slice(1)
    ) {
      const rawSymbol =
        normalizeRawMarketSymbol(
          sourceRow[
            symbolIndex
          ] || ''
        );

      const price =
        safeNumber(
          sourceRow[
            priceIndex
          ]
        );

      const changePct =
        safeNumber(
          sourceRow[
            changeIndex
          ]
        );

      if (
        !rawSymbol ||
        price === null ||
        price <= 0 ||
        changePct === null
      ) {
        continue;
      }

      rows.push({
        symbol:
          rawSymbol,
        price,
        changePct,
        sector:
          sectorIndex >= 0
            ? String(
                sourceRow[
                  sectorIndex
                ] || ''
              ).trim()
            : '',
        listedIn:
          listedIndex >= 0
            ? String(
                sourceRow[
                  listedIndex
                ] || ''
              ).trim()
            : ''
      });
    }

    if (
      rows.length
    ) {
      return rows;
    }
  }

  return [];
}

function parseOfficialPSXScreenerAsOf(
  html
) {
  const text =
    htmlToLines(
      html
    )
      .join(' ');

  const match =
    text.match(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+(?:AM|PM)\b/i
    );

  if (!match) {
    // Do not fabricate freshness. If pyPSX does not expose an explicit
    // market timestamp, preserve the uncertainty instead of pretending
    // the snapshot was observed "now".
    return null;
  }

  const parsed =
    Date.parse(
      `${match[0]} GMT+0500`
    );

  return Number.isFinite(
    parsed
  )
    ? new Date(
        parsed
      ).toISOString()
    : null;
}


function officialPSXMarketFactEligibility(
  symbol
) {
  const master =
    getUniverseMasterEntry(
      symbol
    );

  const eligible =
    Boolean(
      master &&
      master.currentVerified === true &&
      master.securityType ===
        'ORDINARY_EQUITY' &&
      master.board ===
        'MAIN' &&
      master.universeClass ===
        'CORE_EQUITY'
    );

  return {
    eligible,
    currentVerified:
      master?.currentVerified ===
      true,
    securityType:
      master?.securityType ||
      null,
    board:
      master?.board ||
      null,
    universeClass:
      master?.universeClass ||
      null
  };
}


function parseCompactMarketNumber(
  value
) {
  const text =
    String(
      value ?? ''
    )
      .replace(/,/g, '')
      .trim();

  if (!text) {
    return null;
  }

  const match =
    text.match(
      /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([KMBT])?$/i
    );

  if (!match) {
    return safeNumber(
      text
    );
  }

  const base =
    Number(
      match[1]
    );

  if (!Number.isFinite(base)) {
    return null;
  }

  const multiplier = {
    K: 1e3,
    M: 1e6,
    B: 1e9,
    T: 1e12
  }[
    String(
      match[2] || ''
    ).toUpperCase()
  ] || 1;

  return base * multiplier;
}

function pyPSXPublicMarketSymbol(
  row
) {
  const href =
    String(
      row?.href || ''
    );

  if (href) {
    try {
      const parts =
        new URL(
          href
        )
          .pathname
          .split('/')
          .filter(Boolean);

      for (
        let index =
          parts.length - 1;
        index >= 0;
        index -= 1
      ) {
        const candidate =
          normalizeSymbol(
            decodeURIComponent(
              parts[index]
            )
          );

        if (
          /^[A-Z0-9]{1,15}$/.test(
            candidate
          ) &&
          (
            PSX_UNIVERSE_BY_SYMBOL.has(
              candidate
            ) ||
            candidate.length <= 10
          )
        ) {
          return candidate;
        }
      }
    } catch {}
  }

  const cell =
    String(
      row?.cells?.[0] || ''
    )
      .trim();

  const firstToken =
    normalizeSymbol(
      cell.split(/\s+/)[0]
    );

  if (
    firstToken &&
    /^[A-Z0-9]{1,15}$/.test(
      firstToken
    )
  ) {
    return firstToken;
  }

  return '';
}

function parsePyPSXPublicMarketRows(
  html
) {
  const tables =
    parseHTMLTables(
      html
    );

  for (
    const table
    of tables
  ) {
    const matrix =
      tableToMatrix(
        table
      );

    if (matrix.length < 2) {
      continue;
    }

    const header =
      matrix[0] || [];

    const normalized =
      header.map(
        value =>
          normalizeOfficialScreenerHeader(
            value
          )
      );

    const symbolIndex =
      normalized.findIndex(
        value =>
          value === 'SYMBOL'
      );

    const lastIndex =
      normalized.findIndex(
        value =>
          value === 'LAST' ||
          value === 'PRICE'
      );

    const changeIndex =
      normalized.findIndex(
        value =>
          value === 'CHANGE' ||
          value === 'CHANGE (%)' ||
          value === 'CHANGE %'
      );

    if (
      symbolIndex < 0 ||
      lastIndex < 0 ||
      changeIndex < 0
    ) {
      continue;
    }

    const volumeIndex =
      normalized.findIndex(
        value =>
          value === 'VOLUME'
      );

    const marketCapIndex =
      normalized.findIndex(
        value =>
          value === 'MKT CAP' ||
          value === 'MARKET CAP'
      );

    const rows = [];

    for (
      const row
      of table.rows.slice(1)
    ) {
      const symbol =
        pyPSXPublicMarketSymbol(
          row
        );

      const price =
        safeNumber(
          row.cells[
            lastIndex
          ]
        );

      const changePct =
        safeNumber(
          row.cells[
            changeIndex
          ]
        );

      if (
        !symbol ||
        price === null ||
        price <= 0 ||
        changePct === null
      ) {
        continue;
      }

      rows.push({
        symbol,
        price,
        changePct,
        volume:
          volumeIndex >= 0
            ? parseCompactMarketNumber(
                row.cells[
                  volumeIndex
                ]
              )
            : null,
        marketCap:
          marketCapIndex >= 0
            ? parseCompactMarketNumber(
                row.cells[
                  marketCapIndex
                ]
              )
            : null
      });
    }

    if (rows.length >= 50) {
      return rows;
    }
  }

  return [];
}

function parsePyPSXPublicMarketAsOf(
  html
) {
  const text =
    htmlToLines(
      html
    )
      .join(' ');

  const match =
    text.match(
      /\blive\s*[·|\-]?\s*(\d{1,2}:\d{2})\s*PKT\b/i
    );

  if (!match) {
    return new Date()
      .toISOString();
  }

  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          'Asia/Karachi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }
    )
      .formatToParts(
        new Date()
      );

  const dateParts = {};

  for (
    const part
    of parts
  ) {
    if (
      part.type !==
        'literal'
    ) {
      dateParts[
        part.type
      ] =
        part.value;
    }
  }

  const date =
    `${dateParts.year}-${dateParts.month}-${dateParts.day}`;

  const parsed =
    Date.parse(
      `${date}T${match[1]}:00+05:00`
    );

  return Number.isFinite(
    parsed
  )
    ? new Date(
        parsed
      ).toISOString()
    : new Date()
        .toISOString();
}

async function loadPyPSXPublicMarketSnapshot(
  companyMap
) {
  const html =
    await fetchText(
      PYPSX_PUBLIC_MARKET_URL,
      20000,
      {
        Referer:
          'https://www.pypsx.com/'
      }
    );

  const rawRows =
    parsePyPSXPublicMarketRows(
      html
    );

  if (!rawRows.length) {
    bad(
      'pyPSX public market board returned no live rows.',
      502
    );
  }

  const rows = [];

  for (
    const row
    of rawRows
  ) {
    const identity =
      resolveSymbolIdentity(
        row.symbol,
        companyMap
      );

    const symbol =
      identity.canonicalSymbol ||
      primaryMarketToken(
        row.symbol
      );

    if (!symbol) {
      continue;
    }

    rows.push({
      symbol,
      tradingSymbol:
        identity.tradingSymbol ||
        row.symbol,
      price:
        row.price,
      changePct:
        row.changePct,
      volume:
        row.volume,
      marketCap:
        row.marketCap
    });
  }

  if (!rows.length) {
    bad(
      'pyPSX live rows could not be mapped to the NOMAD universe.',
      502
    );
  }

  return {
    asOf:
      parsePyPSXPublicMarketAsOf(
        html
      ),
    source:
      'pyPSX public live market board',
    total:
      rows.length,
    rows
  };
}

async function loadOfficialPSXScreenerSnapshot(
  companyMap
) {
  const html =
    await fetchText(
      PSX_SCREENER_URL,
      30000,
      {
        Referer:
          `${PSX_DPS_BASE}/`
      }
    );

  const rawRows =
    parseOfficialPSXScreenerRows(
      html
    );

  if (
    !rawRows.length
  ) {
    bad(
      'Official PSX screener returned no current-session rows.',
      502
    );
  }

  const canonicalRows =
    new Map();

  for (
    const row
    of rawRows
  ) {
    const identity =
      resolveSymbolIdentity(
        row.symbol,
        companyMap
      );

    const symbol =
      identity.canonicalSymbol ||
      primaryMarketToken(
        row.symbol
      );

    if (!symbol) {
      continue;
    }

    const master =
      getUniverseMasterEntry(
        symbol
      );

    const company =
      companyMap.get(
        symbol
      ) || {};

    const marketFact =
      officialPSXMarketFactEligibility(
        symbol
      );

    canonicalRows.set(
      symbol,
      {
        symbol,
        tradingSymbol:
          identity.tradingSymbol ||
          row.symbol,
        companyName:
          company.name ||
          master?.companyName ||
          symbol,
        sector:
          company.sector ||
          master?.sector ||
          row.sector ||
          'Unknown',
        listedIn:
          row.listedIn ||
          master?.listedIn ||
          '',
        recommendationEligible:
          master?.recommendationEligible ===
          true,
        currentVerified:
          marketFact.currentVerified,
        securityType:
          marketFact.securityType,
        universeBoard:
          marketFact.board,
        universeClass:
          marketFact.universeClass,
        marketFactEligible:
          marketFact.eligible,
        price:
          row.price,
        changePct:
          row.changePct
      }
    );
  }

  const rows =
    [...canonicalRows.values()];

  if (
    !rows.length
  ) {
    bad(
      'Official PSX screener rows could not be mapped to the NOMAD universe.',
      502
    );
  }

  return {
    asOf:
      parseOfficialPSXScreenerAsOf(
        html
      ),
    source:
      'PSX Data Portal screener',
    total:
      rows.length,
    rows
  };
}

async function enrichFromPyPSX(
  map
) {
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

      const sector =
        String(
          row.sector ||
          ''
        ).trim();

      if (
        !symbol
      ) {
        continue;
      }

      mergeCompanyMetadata(
        map,
        symbol,
        {
          name:
            name ||
            symbol,

          sector,

          source:
            'pyPSX symbols',

          evidence: {
            pyPSX:
              true
          },

          isCanonical:
            false
        }
      );
    }
  } catch {}
}

async function enrichFromFallbackMetadata(
  map
) {
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

      mergeCompanyMetadata(
        map,
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

          source:
            'psx-rest-api',

          evidence: {
            fallback:
              true
          },

          isCanonical:
            false
        }
      );
    }
  } catch {}
}

function reconcileStatusMetadata(
  map
) {
  const entries =
    [...map.entries()];

  for (
    const [
      rawSymbol,
      rawMetadata
    ]
    of entries
  ) {
    if (
      rawMetadata?.isCanonical
    ) {
      continue;
    }

    const identity =
      resolveSymbolIdentity(
        rawSymbol,
        map
      );

    if (
      !identity.normalized ||
      identity.canonicalSymbol ===
        rawSymbol
    ) {
      continue;
    }

    const canonical =
      map.get(
        identity.canonicalSymbol
      );

    if (
      !canonical
    ) {
      continue;
    }

    mergeCompanyMetadata(
      map,
      identity.canonicalSymbol,
      {
        name:
          rawMetadata.name,

        sector:
          rawMetadata.sector,

        source:
          canonical.source ||
          rawMetadata.source,

        sources:
          uniqueTextValues([
            ...(canonical.sources || []),
            ...(rawMetadata.sources || [])
          ]),

        evidence:
          mergeMetadataEvidence(
            canonical.evidence || {},
            rawMetadata.evidence || {}
          ),

        isCanonical:
          true
      }
    );
  }
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

  // Build 0.7.0 starts from the frozen canonical identity master.
  // Runtime sources may enrich missing fields, but they no longer define
  // whether a symbol is eligible for NOMAD's recommendation universe.
  const map =
    loadMasterCompanyMap();

  try {
    const officialMap =
      await loadOfficialSymbolsMap();

    for (
      const [
        symbol,
        metadata
      ]
      of officialMap.entries()
    ) {
      mergeCompanyMetadata(
        map,
        symbol,
        metadata
      );
    }
  } catch {}

  await enrichFromEligibleScrips(
    map
  );

  await enrichFromAllShareIndex(
    map
  );

  await enrichFromPyPSX(
    map
  );

  await enrichFromFallbackMetadata(
    map
  );

  reconcileStatusMetadata(
    map
  );

  await enrichFromMarketWatch(
    map
  );

  reconcileStatusMetadata(
    map
  );

  companyCache = {
    fetchedAt:
      Date.now(),

    data:
      map
  };

  return map;
}

/* =========================================================
   SECTOR MAP
========================================================= */

async function loadSectorMap() {
  if (
    sectorCache &&
    Date.now() -
      sectorCache.fetchedAt <
      3600000
  ) {
    return sectorCache.data;
  }

  const companyMap =
    await loadCompanyMap();

  const map =
    new Map();

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
      const identity =
        resolveSymbolIdentity(
          symbol,
          companyMap
        );

      map.set(
        identity.canonicalSymbol,
        metadata.sector
      );
    }
  }

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

        if (
          !sectorName
        ) {
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
            const rawSymbol =
              typeof item ===
                'string'
                ? item
                : (
                    item.symbol ||
                    item.SYMBOL ||
                    item.ticker
                  );

            const identity =
              resolveSymbolIdentity(
                rawSymbol,
                companyMap
              );

            if (
              identity.canonicalSymbol &&
              !map.has(
                identity.canonicalSymbol
              )
            ) {
              map.set(
                identity.canonicalSymbol,
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

/* =========================================================
   SYMBOL CONTEXT
========================================================= */

function rowIdentityScore(
  row,
  identity
) {
  let score = 0;

  const price =
    safeNumber(
      row?.price
    );

  if (
    price !== null &&
    price > 0
  ) {
    score += 100;
  }

  if (
    identity.statusCodes
      .length
  ) {
    score += 20;
  }

  if (
    row?.listed_in
  ) {
    score += 5;
  }

  const volume =
    safeNumber(
      row?.volume_avg_30d
    );

  if (
    volume !== null &&
    volume > 0
  ) {
    score += 2;
  }

  return score;
}

async function resolveSymbolContext(
  inputSymbol
) {
  const companyMap =
    await loadCompanyMap();

  const inputIdentity =
    resolveSymbolIdentity(
      inputSymbol,
      companyMap
    );

  const canonicalSymbol =
    inputIdentity
      .canonicalSymbol;

  if (
    !canonicalSymbol
  ) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  let currentIdentity =
    inputIdentity;

  try {
    const screener =
      await loadRawScreener();

    let best = null;

    for (
      const row
      of screener.rows
    ) {
      const identity =
        resolveSymbolIdentity(
          row.symbol,
          companyMap
        );

      if (
        identity.canonicalSymbol !==
        canonicalSymbol
      ) {
        continue;
      }

      const score =
        rowIdentityScore(
          row,
          identity
        );

      if (
        !best ||
        score >
          best.score
      ) {
        best = {
          identity,
          score,
          row
        };
      }
    }

    if (best) {
      currentIdentity =
        best.identity;
    }
  } catch {}

  const metadata =
    companyMap.get(
      canonicalSymbol
    ) ||
    companyMap.get(
      currentIdentity
        .tradingSymbol
    ) ||
    null;

  return {
    inputSymbol:
      normalizeRawMarketSymbol(
        inputSymbol
      ),

    canonicalSymbol,

    tradingSymbol:
      currentIdentity
        .tradingSymbol ||
      canonicalSymbol,

    rawMarketSymbol:
      currentIdentity
        .rawSymbol ||
      canonicalSymbol,

    statusCodes:
      uniqueStrings([
        ...inputIdentity
          .statusCodes,

        ...currentIdentity
          .statusCodes
      ]),

    normalized:
      inputIdentity.normalized ||
      currentIdentity.normalized,

    companyName:
      metadata?.name ||
      canonicalSymbol,

    sector:
      metadata?.sector ||
      '',

    metadata
  };
}

/* =========================================================
   PSX COMPANY PAGE
========================================================= */

function parseOfficialQuoteStats(
  lines
) {
  const priceLine =
    lines.find(
      line =>
        /^Rs\.\s*[\d,.]+/i
          .test(
            String(line)
          )
    );

  const priceMatch =
    priceLine
      ? priceLine.match(
          /Rs\.\s*([\d,.]+)/i
        )
      : null;

  const asOfLine =
    lines.find(
      line =>
        /\bAs of\b/i
          .test(
            String(line)
          )
    );

  let asOf =
    null;

  let asOfDateKey =
    '';

  if (
    asOfLine
  ) {
    const cleaned =
      String(asOfLine)
        .replace(
          /^.*?\bAs of\b\s*/i,
          ''
        )
        .replace(
          /^\^\s*/,
          ''
        )
        .trim();

    const parsed =
      Date.parse(
        cleaned
      );

    if (
      Number.isFinite(
        parsed
      )
    ) {
      asOf =
        new Date(
          parsed
        )
          .toISOString();

      asOfDateKey =
        dateKeyFromDate(
          asOf
        );
    }
  }

  return {
    price:
      priceMatch
        ? safeNumber(
            priceMatch[1]
          )
        : null,

    open:
      findExactNumericAfterLabel(
        lines,
        'OPEN'
      ),

    high:
      findExactNumericAfterLabel(
        lines,
        'HIGH'
      ),

    low:
      findExactNumericAfterLabel(
        lines,
        'LOW'
      ),

    volume:
      findExactNumericAfterLabel(
        lines,
        'VOLUME'
      ),

    ldcp:
      findExactNumericAfterLabel(
        lines,
        'LDCP'
      ),

    peRatio:
      findNumericAfterLabel(
        lines,
        'P/E RATIO'
      ),

    asOf,

    asOfDateKey
  };
}

function normalizeCompanyIdentityName(
  value
) {
  return String(
    value || ''
  )
    .toUpperCase()
    .replace(
      /\(\s*GEM\s*\)/g,
      ' '
    )
    .replace(
      /&/g,
      ' AND '
    )
    .replace(
      /[^A-Z0-9]+/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function normalizeListingHeaderText(
  value
) {
  return String(
    value || ''
  )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function findCompanyHeaderAnchor(
  lines,
  companyName,
  symbol
) {
  const normalizedSymbol =
    normalizeSymbol(
      symbol
    );

  for (
    let index = 0;
    index < lines.length;
    index++
  ) {
    const candidate =
      normalizeSymbol(
        lines[index]
      );

    if (
      candidate !==
      normalizedSymbol
    ) {
      continue;
    }

    const nearby =
      lines
        .slice(
          index,
          Math.min(
            lines.length,
            index + 14
          )
        )
        .join(' ')
        .toUpperCase();

    if (
      nearby.includes(
        'QUOTE'
      )
    ) {
      return index;
    }
  }

  const normalizedCompany =
    normalizeCompanyIdentityName(
      companyName
    );

  if (
    normalizedCompany
  ) {
    for (
      let index = 0;
      index < lines.length;
      index++
    ) {
      const normalizedLine =
        normalizeCompanyIdentityName(
          lines[index]
        );

      if (
        normalizedLine ===
          normalizedCompany ||
        (
          normalizedLine.includes(
            normalizedCompany
          ) &&
          normalizedLine.length <=
            normalizedCompany.length +
            80
        )
      ) {
        return index;
      }
    }
  }

  return -1;
}

function parseCompanyListingInfo(
  lines,
  companyName,
  symbol
) {
  const info = {
    explicitTradingStatus:
      null,

    tradingStatusLabel:
      null,

    statusEvidence:
      null,

    // Build 0.8.3.2: initialize board fields explicitly.
    // 0.8.3.1 referenced an undefined boardInfo object here, which could
    // break PSX company-page parsing and falsely block fundamental evidence.
    boardType:
      null,

    boardLabel:
      null,

    boardEvidence:
      null,

    sectorName:
      null,

    successorName:
      null,

    successorSymbol:
      null,

    statusCodes: []
  };

  const anchorIndex =
    findCompanyHeaderAnchor(
      lines,
      companyName,
      symbol
    );

  if (
    anchorIndex < 0
  ) {
    if (
      /^GEM[A-Z0-9]/
        .test(
          normalizeSymbol(
            symbol
          )
        ) ||
      /\(\s*GEM\s*\)/i
        .test(
          String(
            companyName || ''
          )
        )
    ) {
      info.boardType =
        'GEM';

      info.boardLabel =
        'GEM Board';

      info.boardEvidence =
        'PSX symbol/name GEM marker';
    }

    return info;
  }

  const headerLines =
    lines.slice(
      anchorIndex,
      Math.min(
        lines.length,
        anchorIndex + 55
      )
    );

  const knownTradingStatuses = [
    {
      pattern:
        /\bDELISTED\b/i,
      status:
        'DELISTED',
      label:
        'Delisted'
    },
    {
      pattern:
        /\bSUSPENDED\b/i,
      status:
        'SUSPENDED',
      label:
        'Suspended'
    },
    {
      pattern:
        /\bCHANGED\b/i,
      status:
        'CHANGED',
      label:
        'Changed / renamed'
    },
    {
      pattern:
        /\bRENAMED\b/i,
      status:
        'CHANGED',
      label:
        'Changed / renamed'
    },
    {
      pattern:
        /\b(?:MERGED|AMALGAMATED)\b/i,
      status:
        'MERGED',
      label:
        'Merged / amalgamated'
    }
  ];

  for (
    const rawLine
    of headerLines
  ) {
    const rawCandidate =
      normalizeListingHeaderText(
        rawLine
      );

    const candidate =
      rawCandidate
        .toUpperCase();

    if (!candidate) {
      continue;
    }

    for (
      const token
      of candidate
        .split(/\s+/)
    ) {
      if (
        isSecurityStatusToken(
          token
        )
      ) {
        info.statusCodes.push(
          token
        );
      }
    }

    const changedTo =
      rawCandidate.match(
        /\bCHANGED\s+TO\s*:\s*(.+)$/i
      );

    if (changedTo) {
      info.successorName =
        normalizeListingHeaderText(
          changedTo[1]
        );
    }

    if (
      !info.explicitTradingStatus
    ) {
      for (
        const statusInfo
        of knownTradingStatuses
      ) {
        if (
          statusInfo.pattern.test(
            rawCandidate
          )
        ) {
          info.explicitTradingStatus =
            statusInfo.status;

          info.tradingStatusLabel =
            statusInfo.label;

          info.statusEvidence =
            'PSX company header: ' +
            statusInfo.status;

          break;
        }
      }
    }

    const gemMatch =
      rawCandidate.match(
        /\bGEM\s+BOARD\s*-\s*(.*)$/i
      );

    if (gemMatch) {
      info.boardType =
        'GEM';

      info.boardLabel =
        'GEM Board';

      info.boardEvidence =
        'PSX company header: GEM BOARD';

      const gemSector =
        normalizeListingHeaderText(
          gemMatch[1]
        );

      if (
        gemSector
      ) {
        info.sectorName =
          gemSector.toUpperCase();
      }

      continue;
    }

    if (
      /\bGEM\s+BOARD\b/i
        .test(
          rawCandidate
        )
    ) {
      info.boardType =
        'GEM';

      info.boardLabel =
        'GEM Board';

      info.boardEvidence =
        'PSX company header: GEM BOARD';

      continue;
    }
  }

  if (
    !info.boardType &&
    (
      /^GEM[A-Z0-9]/
        .test(
          normalizeSymbol(
            symbol
          )
        ) ||
      /\(\s*GEM\s*\)/i
        .test(
          String(
            companyName || ''
          )
        )
    )
  ) {
    info.boardType =
      'GEM';

    info.boardLabel =
      'GEM Board';

    info.boardEvidence =
      'PSX symbol/name GEM marker';
  }

  if (
    !info.sectorName
  ) {
    const normalizedCompany =
      normalizeCompanyIdentityName(
        companyName
      );

    const normalizedSymbol =
      normalizeSymbol(
        symbol
      );

    for (
      const rawLine
      of headerLines
    ) {
      const rawCandidate =
        normalizeListingHeaderText(
          rawLine
        );

      const candidate =
        rawCandidate
          .toUpperCase();

      if (!candidate) {
        continue;
      }

      const normalizedCandidate =
        normalizeCompanyIdentityName(
          rawCandidate
        );

      if (
        candidate ===
          normalizedSymbol ||
        normalizedCandidate ===
          normalizedCompany ||
        candidate.startsWith(
          'CHANGED TO:'
        ) ||
        /\b(?:DELISTED|SUSPENDED|CHANGED|RENAMED|MERGED|AMALGAMATED)\b/i
          .test(
            candidate
          ) ||
        /\bGEM\s+BOARD\b/i
          .test(
            candidate
          ) ||
        /^(QUOTE|PROFILE|EQUITY|ANNOUNCEMENTS|FINANCIALS|RATIOS|PAYOUTS|REPORTS|REG|DFC|CSF|ODL|SELECT)$/i
          .test(
            candidate
          ) ||
        /^RS\.?/i
          .test(
            candidate
          ) ||
        /^PKR\b/i
          .test(
            candidate
          ) ||
        /^\^?\s*AS\s+OF\b/i
          .test(
            candidate
          ) ||
        /^\d/
          .test(
            candidate
          ) ||
        /^[+-]?\d+(?:\.\d+)?%$/
          .test(
            candidate
          )
      ) {
        continue;
      }

      if (
        candidate.length <=
          120 &&
        candidate ===
          candidate.toUpperCase()
      ) {
        info.sectorName =
          candidate;

        break;
      }
    }
  }

  return {
    ...info,

    statusCodes:
      uniqueStrings(
        info.statusCodes
      )
  };
}

function parseSuccessorFromCompanyPageHTML(
  html
) {
  const source =
    String(
      html || ''
    );

  const changedIndex =
    source.search(
      /CHANGED\s+TO/i
    );

  if (
    changedIndex < 0
  ) {
    return {
      successorName:
        null,
      successorSymbol:
        null
    };
  }

  const fragment =
    source.slice(
      changedIndex,
      changedIndex + 1800
    );

  const symbolMatch =
    fragment.match(
      /href=["'][^"']*\/company\/([^"'/?#]+)[^"']*["']/i
    );

  const nameMatch =
    fragment.match(
      /<a\b[^>]*>([\s\S]*?)<\/a>/i
    );

  return {
    successorName:
      nameMatch
        ? cleanHtmlCell(
            nameMatch[1]
          )
        : null,

    successorSymbol:
      symbolMatch
        ? normalizeSymbol(
            symbolMatch[1]
          )
        : null
  };
}

function parsePSXCompanyPage(
  html,
  symbol
) {
  const lines =
    htmlToLines(
      html
    );

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

  const listing =
    parseCompanyListingInfo(
      lines,
      companyName,
      symbol
    );

  const successorFromHTML =
    parseSuccessorFromCompanyPageHTML(
      html
    );

  if (
    successorFromHTML.successorName &&
    !listing.successorName
  ) {
    listing.successorName =
      successorFromHTML.successorName;
  }

  if (
    successorFromHTML.successorSymbol
  ) {
    listing.successorSymbol =
      successorFromHTML.successorSymbol;
  }

  const sectorName =
    listing.sectorName ||
    null;

  const pageStatusCodes =
    listing.statusCodes ||
    [];

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
    freeFloatShares <= 100 &&
    freeFloatPercent !==
      null &&
    freeFloatPercent > 100
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
    freeFloatShares <= 100
  ) {
    freeFloatPercent =
      freeFloatShares;

    freeFloatShares =
      null;
  }

  const quote =
    parseOfficialQuoteStats(
      lines
    );

  return {
    symbol,

    companyName,

    sectorName,

    statusCodes:
      uniqueStrings(
        pageStatusCodes
      ),

    pageIdentityValid:
      Boolean(
        companyName
      ),

    listing: {
      explicitTradingStatus:
        listing.explicitTradingStatus,

      tradingStatusLabel:
        listing.tradingStatusLabel,

      statusEvidence:
        listing.statusEvidence,

      boardType:
        listing.boardType,

      boardLabel:
        listing.boardLabel,

      boardEvidence:
        listing.boardEvidence,

      successorName:
        listing.successorName,

      successorSymbol:
        listing.successorSymbol,

      source:
        'PSX Data Portal company page'
    },

    sourceUrl:
      `${PSX_DPS_BASE}/company/${encodeURIComponent(
        symbol
      )}`,

    fetchedAt:
      new Date()
        .toISOString(),

    quote,

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
        30
      )
  };
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
    companyPageCache.get(
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

  companyPageCache.set(
    symbol,
    {
      fetchedAt:
        Date.now(),

      data
    }
  );

  return data;
}

function waitMilliseconds(
  milliseconds
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

async function mapWithConcurrency(
  items,
  limit,
  mapper
) {
  const list =
    Array.isArray(
      items
    )
      ? items
      : [];

  const output =
    new Array(
      list.length
    );

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >=
        list.length
      ) {
        return;
      }

      output[index] =
        await mapper(
          list[index],
          index
        );

      await waitMilliseconds(
        90
      );
    }
  }

  const workerCount =
    Math.max(
      1,
      Math.min(
        Number(limit) || 1,
        list.length || 1
      )
    );

  await Promise.all(
    Array.from(
      {
        length:
          workerCount
      },
      () =>
        worker()
    )
  );

  return output;
}

async function getPSXCompanySnapshotForAudit(
  stockSymbol
) {
  const symbol =
    normalizeSymbol(
      stockSymbol
    );

  if (!symbol) {
    return {
      snapshot:
        null,
      fetchStatus:
        'INVALID_SYMBOL',
      attempts:
        0,
      retried:
        false,
      httpStatus:
        null,
      error:
        'Invalid symbol.'
    };
  }

  const cached =
    companyPageCache.get(
      symbol
    );

  if (
    cached &&
    Date.now() -
      cached.fetchedAt <
      30 *
      60 *
      1000 &&
    cached.data?.pageIdentityValid
  ) {
    return {
      snapshot:
        cached.data,
      fetchStatus:
        'SUCCESS_CACHE',
      attempts:
        0,
      retried:
        false,
      httpStatus:
        200,
      error:
        null
    };
  }

  let lastError =
    null;

  for (
    let attempt = 1;
    attempt <= 2;
    attempt++
  ) {
    try {
      const html =
        await fetchText(
          `${PSX_DPS_BASE}/company/${encodeURIComponent(
            symbol
          )}`,
          30000,
          {
            Referer:
              `${PSX_DPS_BASE}/`,

            'User-Agent':
              `Mozilla/5.0 NOMAD-Invest/${VERSION}`
          }
        );

      const data =
        parsePSXCompanyPage(
          html,
          symbol
        );

      if (
        !data?.pageIdentityValid
      ) {
        return {
          snapshot:
            null,
          fetchStatus:
            'INVALID_PAGE',
          attempts:
            attempt,
          retried:
            attempt > 1,
          httpStatus:
            200,
          error:
            'PSX returned a page without a recognizable company identity.'
        };
      }

      companyPageCache.set(
        symbol,
        {
          fetchedAt:
            Date.now(),

          data
        }
      );

      return {
        snapshot:
          data,
        fetchStatus:
          'SUCCESS',
        attempts:
          attempt,
        retried:
          attempt > 1,
        httpStatus:
          200,
        error:
          null
      };
    } catch (error) {
      lastError =
        error;

      const status =
        Number(
          error?.status ||
          0
        );

      if (
        status === 404 ||
        status === 410
      ) {
        return {
          snapshot:
            null,
          fetchStatus:
            'NOT_FOUND',
          attempts:
            attempt,
          retried:
            attempt > 1,
          httpStatus:
            status,
          error:
            String(
              error?.message ||
              'PSX company page was not found.'
            )
        };
      }

      if (
        attempt < 2
      ) {
        // Be deliberately gentle with PSX. The audit is not latency-sensitive.
        await waitMilliseconds(
          status === 429 ||
          status === 503 ||
          status === 403
            ? 1800
            : 1100
        );
      }
    }
  }

  const httpStatus =
    Number(
      lastError?.status ||
      0
    ) ||
    null;

  return {
    snapshot:
      null,
    fetchStatus:
      httpStatus === 404 ||
      httpStatus === 410
        ? 'NOT_FOUND'
        : 'FETCH_FAILED',
    attempts:
      2,
    retried:
      true,
    httpStatus,
    error:
      String(
        lastError?.message ||
        'PSX company page request failed.'
      )
  };
}

/* =========================================================
   PYPSX
========================================================= */

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
        : value * 1000;
  }

  const parsed =
    Date.parse(
      value
    );

  return Number.isFinite(
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
    new Intl.DateTimeFormat(
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
      )?.value ||
      '';

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
          result?.status_text ||
          (
            result?.is_open ===
            true
              ? 'Market Open'
              : 'Market Closed'
          )
        ),

      holidayName:
        result?.holiday_name ||
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

async function fetchPyPSXIntradaySymbol(
  symbol
) {
  const raw =
    await fetchJSON(
      `${getPyPSXBase()}/intraday/${encodeURIComponent(
        symbol
      )}`,
      20000,
      pyPSXHeaders()
    );

  const rows =
    extractPyPSXRows(
      raw
    )
      .map(
        normalizePyPSXRow
      )
      .filter(
        row =>
          row.close !== null &&
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

  return rows;
}

async function getPyPSXIntraday(
  symbolCandidates,
  canonicalSymbol = null
) {
  const candidates =
    uniqueStrings(
      Array.isArray(
        symbolCandidates
      )
        ? symbolCandidates
        : [
            symbolCandidates
          ]
    );

  if (
    !candidates.length
  ) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  const marketStatusPromise =
    getPyPSXMarketStatus();

  let rows = [];
  let providerSymbol = null;
  let lastError = null;

  for (
    const candidate
    of candidates
  ) {
    try {
      const candidateRows =
        await fetchPyPSXIntradaySymbol(
          candidate
        );

      if (
        candidateRows.length
      ) {
        rows =
          candidateRows;

        providerSymbol =
          candidate;

        break;
      }
    } catch (error) {
      lastError =
        error;
    }
  }

  const marketStatus =
    await marketStatusPromise;

  if (
    !rows.length
  ) {
    if (
      lastError
    ) {
      throw lastError;
    }

    bad(
      `pyPSX returned no intraday price data for ${canonicalSymbol || candidates[0]}.`,
      502
    );
  }

  const latest =
    rows[
      rows.length - 1
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
    ageSeconds <= 180
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
            )
              .toISOString(),

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
    symbol:
      canonicalSymbol ||
      providerSymbol,

    providerSymbol,

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
      )
        .toISOString(),

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
        normalizedSessionRows.length
          ? Math.max(
              ...normalizedSessionRows.map(
                row =>
                  row.high
              )
            )
          : null,

      low:
        normalizedSessionRows.length
          ? Math.min(
              ...normalizedSessionRows.map(
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
        normalizedSessionRows.length
    },

    data:
      normalizedSessionRows
  };
}

async function getLiveForContext(
  context
) {
  return getPyPSXIntraday(
    [
      context.tradingSymbol,
      context.canonicalSymbol
    ],
    context.canonicalSymbol
  );
}

/* =========================================================
   SCREENER NORMALIZATION
========================================================= */

function normalizeScreenerRow(
  row,
  sectorMap,
  companyMap,
  timestamp
) {
  const identity =
    resolveSymbolIdentity(
      row.symbol,
      companyMap
    );

  const symbol =
    identity.canonicalSymbol;

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
    ) ||
    companyMap.get(
      identity.tradingSymbol
    );

  const pe =
    safeNumber(
      row.pe_ratio
    );

  const master =
    getUniverseMasterEntry(
      symbol
    );

  return {
    symbol,

    canonicalSymbol:
      symbol,

    tradingSymbol:
      identity.tradingSymbol,

    rawSymbol:
      identity.rawSymbol,

    statusCodes:
      identity.statusCodes,

    normalizedSymbol:
      identity.normalized,

    universeMasterVersion:
      PSX_UNIVERSE_MASTER.masterVersion,

    masterStatus:
      master?.masterStatus ||
      'UNMAPPED_FEED',

    universeClass:
      master?.universeClass ||
      'UNMAPPED_FEED',

    recommendationEligible:
      master?.recommendationEligible ===
      true,

    universeBoard:
      master?.board ||
      null,

    securityType:
      master?.securityType ||
      null,

    issuerType:
      master?.issuerType ||
      null,

    metadataSources:
      Array.isArray(
        company?.sources
      )
        ? company.sources
        : (
            company?.source
              ? [
                  company.source
                ]
              : []
          ),

    metadataEvidence:
      company?.evidence ||
      {},

    companyName:
      company?.name &&
      company.name !==
        identity.tradingSymbol
        ? company.name
        : symbol,

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
      pe !== null &&
      pe > 0
        ? pe
        : null,

    dividendYield:
      row.dividend_yield ===
        null ||
      row.dividend_yield ===
        undefined ||
      row.dividend_yield ===
        ''
        ? null
        : safeNumber(
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

    // Current-session change is used as a fallback when the official
    // Market Watch table is temporarily unavailable.
    dayChangePct:
      safeNumber(
        row.change_pct ??
        row.change_percent ??
        row.change_percentage ??
        row['change (%)'] ??
        row['change%']
      ),

    asOf:
      timestamp
  };
}

function chooseBetterMarketRow(
  a,
  b
) {
  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  let scoreA = 0;
  let scoreB = 0;

  if (
    a.price !== null &&
    a.price > 0
  ) {
    scoreA += 100;
  }

  if (
    b.price !== null &&
    b.price > 0
  ) {
    scoreB += 100;
  }

  if (
    a.statusCodes?.length
  ) {
    scoreA += 20;
  }

  if (
    b.statusCodes?.length
  ) {
    scoreB += 20;
  }

  if (
    a.listedIn
  ) {
    scoreA += 5;
  }

  if (
    b.listedIn
  ) {
    scoreB += 5;
  }

  if (
    (
      a.averageVolume30d ||
      0
    ) >
    (
      b.averageVolume30d ||
      0
    )
  ) {
    scoreA += 1;
  } else {
    scoreB += 1;
  }

  return scoreB >
    scoreA
      ? b
      : a;
}

async function loadPSXMarket() {
  if (
    marketCache &&
    Date.now() -
      marketCache.fetchedAt <
      8000
  ) {
    return marketCache.data;
  }

  const [
    screener,
    sectorMap,
    companyMap,
    marketStatus
  ] =
    await Promise.all([
      loadRawScreener(),
      loadSectorMap(),
      loadCompanyMap(),
      getPyPSXMarketStatus()
        .catch(
          () => ({
            known: false,
            isOpen: false,
            status: 'UNKNOWN',
            statusText: 'Market status unavailable',
            holidayName: null
          })
        )
    ]);

  const normalizedRows =
    screener.rows
      .map(
        row =>
          normalizeScreenerRow(
            row,
            sectorMap,
            companyMap,
            screener.timestamp
          )
      )
      .filter(Boolean);

  const canonicalRows =
    new Map();

  for (
    const row
    of normalizedRows
  ) {
    const previous =
      canonicalRows.get(
        row.canonicalSymbol
      );

    canonicalRows.set(
      row.canonicalSymbol,
      chooseBetterMarketRow(
        previous,
        row
      )
    );
  }

  const stocks =
    [...canonicalRows.values()]
      .map(
        stock => {
          const marketFact =
            officialPSXMarketFactEligibility(
              stock.symbol
            );

          return {
            ...stock,
            marketFactEligible:
              marketFact.eligible,
            currentVerified:
              marketFact.currentVerified,
            securityType:
              stock.securityType ||
              marketFact.securityType,
            universeBoard:
              stock.universeBoard ||
              marketFact.board,
            canonicalMarketPrice:
              null,
            canonicalDayChangePct:
              null,
            canonicalMarketAsOf:
              null,
            canonicalMarketSource:
              null,
            secondaryMarketPrice:
              null,
            secondaryDayChangePct:
              null,
            secondaryMarketAsOf:
              null,
            secondaryMarketSource:
              null
          };
        }
      )
      .sort(
        (
          a,
          b
        ) =>
          a.symbol.localeCompare(
            b.symbol
          )
      );

  let officialScreener =
    null;

  let pyPSXPublicMarket =
    null;

  let marketWatch =
    null;

  // CANONICAL MARKET FACTS
  // ---------------------------------------------------------
  // Official PSX is the source of truth for session price and
  // percentage change. Secondary feeds may enrich volume/intraday
  // context, but they are never allowed to overwrite official facts.
  try {
    officialScreener =
      await loadOfficialPSXScreenerSnapshot(
        companyMap
      );

    const officialMap =
      new Map(
        (
          officialScreener.rows ||
          []
        ).map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
      );

    for (
      const stock
      of stocks
    ) {
      const official =
        officialMap.get(
          normalizeSymbol(
            stock.symbol
          )
        );

      if (!official) {
        continue;
      }

      const officialPrice =
        safeNumber(
          official.price
        );

      const officialChange =
        safeNumber(
          official.changePct
        );

      if (
        officialPrice !== null &&
        officialPrice > 0
      ) {
        stock.price =
          officialPrice;
        stock.canonicalMarketPrice =
          officialPrice;
      }

      if (
        officialChange !== null
      ) {
        stock.dayChangePct =
          officialChange;
        stock.canonicalDayChangePct =
          officialChange;
      }

      stock.marketWatchAsOf =
        officialScreener.asOf;
      stock.canonicalMarketAsOf =
        officialScreener.asOf;
      stock.sessionChangeSource =
        officialScreener.source;
      stock.canonicalMarketSource =
        officialScreener.source;
    }
  } catch {}

  // SECONDARY / INTRADAY CROSS-CHECK
  // ---------------------------------------------------------
  // pyPSX can enrich volume and provide a near-live comparison, but
  // Official PSX remains authoritative whenever the values disagree.
  try {
    pyPSXPublicMarket =
      await loadPyPSXPublicMarketSnapshot(
        companyMap
      );

    const pyPSXMap =
      new Map(
        (
          pyPSXPublicMarket.rows ||
          []
        ).map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
      );

    for (
      const stock
      of stocks
    ) {
      const secondary =
        pyPSXMap.get(
          normalizeSymbol(
            stock.symbol
          )
        );

      if (!secondary) {
        continue;
      }

      stock.secondaryMarketPrice =
        safeNumber(
          secondary.price
        );
      stock.secondaryDayChangePct =
        safeNumber(
          secondary.changePct
        );
      stock.secondaryMarketAsOf =
        pyPSXPublicMarket.asOf;
      stock.secondaryMarketSource =
        pyPSXPublicMarket.source;

      if (
        safeNumber(
          secondary.volume
        ) !== null
      ) {
        stock.sessionVolume =
          safeNumber(
            secondary.volume
          );
      }

      if (
        safeNumber(
          secondary.marketCap
        ) !== null &&
        safeNumber(
          stock.marketCap
        ) === null
      ) {
        stock.marketCap =
          safeNumber(
            secondary.marketCap
          );
      }
    }
  } catch {}

  // Official Market Watch, when available, is used only for session
  // OHLCV enrichment. Official screener price/change stays canonical.
  try {
    marketWatch =
      await loadMarketWatchSnapshot(
        companyMap
      );

    const watchMap =
      new Map(
        (
          marketWatch.rows ||
          []
        ).map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
      );

    for (
      const stock
      of stocks
    ) {
      const watch =
        watchMap.get(
          normalizeSymbol(
            stock.symbol
          )
        );

      if (!watch) {
        continue;
      }

      stock.previousClose =
        safeNumber(
          watch.ldcp
        );
      stock.dayChange =
        safeNumber(
          watch.change
        );
      stock.sessionOpen =
        safeNumber(
          watch.open
        );
      stock.sessionHigh =
        safeNumber(
          watch.high
        );
      stock.sessionLow =
        safeNumber(
          watch.low
        );

      if (
        safeNumber(
          watch.volume
        ) !== null
      ) {
        stock.sessionVolume =
          safeNumber(
            watch.volume
          );
      }
    }
  } catch {}

  if (
    !stocks.length
  ) {
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
          stock.symbol &&
        stock.companyName !==
          stock.tradingSymbol
    ).length;

  const sectorsMatched =
    stocks.filter(
      stock =>
        stock.sector &&
        stock.sector !==
          'Unknown'
    ).length;

  const normalizedStatusRows =
    stocks.filter(
      stock =>
        stock.normalizedSymbol
    ).length;

  // OFFICIAL PSX MARKET FACT UNIVERSE
  // ---------------------------------------------------------
  // Home breadth and Top Movers use current, verified Main Board
  // ordinary equities only. Rights, legacy symbols, special instruments,
  // funds and review-required rows are excluded from the default market
  // facts. This filter is about security type, not NOMAD recommendations.
  const officialMarketRows =
    (
      officialScreener?.rows ||
      []
    )
      .filter(
        row =>
          row.marketFactEligible ===
          true
      );

  const stockBySymbol =
    new Map(
      stocks.map(
        stock => [
          normalizeSymbol(
            stock.symbol
          ),
          stock
        ]
      )
    );

  const liveMarketRows =
    officialMarketRows
      .map(
        row => {
          const canonicalSymbol =
            normalizeSymbol(
              row.symbol
            );

          const stock =
            stockBySymbol.get(
              canonicalSymbol
            ) ||
            null;

          return {
            symbol:
              normalizeSymbol(
                row.tradingSymbol ||
                row.symbol
              ) ||
              canonicalSymbol,
            canonicalSymbol,
            companyName:
              row.companyName ||
              stock?.companyName ||
              getUniverseMasterEntry(
                canonicalSymbol
              )?.companyName ||
              canonicalSymbol,
            sector:
              row.sector ||
              stock?.sector ||
              getUniverseMasterEntry(
                canonicalSymbol
              )?.sector ||
              'Unknown',
            price:
              safeNumber(
                row.price
              ),
            changePct:
              safeNumber(
                row.changePct
              ),
            volume:
              safeNumber(
                stock?.sessionVolume
              ),
            marketCap:
              safeNumber(
                stock?.marketCap
              ),
            recommendationEligible:
              stock?.recommendationEligible ===
              true,
            universeClass:
              row.universeClass ||
              stock?.universeClass ||
              null,
            securityType:
              row.securityType ||
              stock?.securityType ||
              null,
            universeBoard:
              row.universeBoard ||
              stock?.universeBoard ||
              null,
            marketFactEligible:
              true,
            source:
              officialScreener?.source ||
              'PSX Data Portal screener'
          };
        }
      )
      .filter(
        row =>
          row.symbol &&
          safeNumber(
            row.price
          ) !== null &&
          safeNumber(
            row.price
          ) > 0 &&
          safeNumber(
            row.changePct
          ) !== null
      );

  // Secondary-source diagnostic. It never changes the official value.
  let marketDataIntegrity = {
    status:
      officialScreener?.rows?.length
        ? (
            pyPSXPublicMarket?.rows?.length
              ? 'CHECKED'
              : 'OFFICIAL_ONLY'
          )
        : 'OFFICIAL_UNAVAILABLE',
    canonicalSource:
      officialScreener?.source ||
      null,
    canonicalAsOf:
      officialScreener?.asOf ||
      null,
    canonicalScope:
      'MAIN_BOARD_ORDINARY_EQUITIES',
    officialTotalRows:
      officialScreener?.rows?.length ||
      0,
    officialMarketFactRows:
      liveMarketRows.length,
    secondarySource:
      pyPSXPublicMarket?.source ||
      null,
    secondaryAsOf:
      pyPSXPublicMarket?.asOf ||
      null,
    overlapCount: 0,
    largePriceDifferences: 0,
    largeChangeDifferences: 0
  };

  if (
    officialScreener?.rows?.length &&
    pyPSXPublicMarket?.rows?.length
  ) {
    const secondaryMap =
      new Map(
        pyPSXPublicMarket.rows.map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
      );

    for (
      const official
      of liveMarketRows
    ) {
      const secondary =
        secondaryMap.get(
          normalizeSymbol(
            official.canonicalSymbol ||
            official.symbol
          )
        );

      if (!secondary) {
        continue;
      }

      const officialPrice =
        safeNumber(
          official.price
        );
      const secondaryPrice =
        safeNumber(
          secondary.price
        );
      const officialChange =
        safeNumber(
          official.changePct
        );
      const secondaryChange =
        safeNumber(
          secondary.changePct
        );

      marketDataIntegrity.overlapCount +=
        1;

      if (
        officialPrice !== null &&
        secondaryPrice !== null &&
        officialPrice > 0 &&
        Math.abs(
          secondaryPrice -
          officialPrice
        ) /
          officialPrice *
          100 > 5
      ) {
        marketDataIntegrity.largePriceDifferences +=
          1;
      }

      if (
        officialChange !== null &&
        secondaryChange !== null &&
        Math.abs(
          secondaryChange -
          officialChange
        ) > 5
      ) {
        marketDataIntegrity.largeChangeDifferences +=
          1;
      }
    }

    const largeDifferences =
      marketDataIntegrity.largePriceDifferences +
      marketDataIntegrity.largeChangeDifferences;

    const warningThreshold =
      Math.max(
        5,
        Math.ceil(
          marketDataIntegrity.overlapCount *
          0.05
        )
      );

    marketDataIntegrity.status =
      largeDifferences >
        warningThreshold
        ? 'WARNING'
        : 'OK';
  }

  const result = {
    sourceName:
      'Official PSX Data Portal',
    companyNamesMatched,
    sectorsMatched,
    normalizedStatusRows,
    rawRows:
      normalizedRows.length,
    asOf:
      officialScreener?.asOf ||
      screener.timestamp ||
      null,
    marketWatchAsOf:
      officialScreener?.asOf ||
      null,
    sessionChangeSource:
      officialScreener?.source ||
      null,
    secondaryMarketSource:
      pyPSXPublicMarket?.source ||
      null,
    liveMarketRows,
    liveMarketUniverse:
      liveMarketRows.length
        ? 'OFFICIAL_PSX_MAIN_BOARD_ORDINARY_EQUITIES'
        : 'UNAVAILABLE',
    marketFactCount:
      liveMarketRows.length,
    officialMarketAvailable:
      Boolean(
        officialScreener?.rows?.length
      ),
    marketDataIntegrity,
    sessionChangeCoverage:
      liveMarketRows.length,
    marketStatus:
      marketStatus ||
      null,
    totalStocks:
      stocks.length,
    universeMasterVersion:
      PSX_UNIVERSE_MASTER.masterVersion,
    coreEquityCount:
      stocks.filter(
        stock =>
          stock.universeClass ===
          'CORE_EQUITY'
      ).length,
    gemEquityCount:
      stocks.filter(
        stock =>
          stock.universeClass ===
          'GEM_EQUITY'
      ).length,
    alternativeCurrentCount:
      stocks.filter(
        stock =>
          stock.universeClass ===
          'ALTERNATIVE_CURRENT'
      ).length,
    reviewRequiredCount:
      stocks.filter(
        stock =>
          stock.universeClass ===
          'REVIEW_REQUIRED'
      ).length,
    unmappedFeedCount:
      stocks.filter(
        stock =>
          stock.universeClass ===
          'UNMAPPED_FEED'
      ).length,
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

/* =========================================================
   METADATA / SECURITY UNIVERSE AUDIT - BUILD 0.6.4
========================================================= */

function metadataNameResolved(
  stock
) {
  const name =
    String(
      stock?.companyName ||
      ''
    ).trim();

  if (!name) {
    return false;
  }

  const symbol =
    normalizeSymbol(
      stock?.symbol
    );

  const trading =
    normalizeSymbol(
      stock?.tradingSymbol
    );

  const normalizedName =
    normalizeSymbol(
      name
    );

  if (
    normalizedName ===
      symbol ||
    normalizedName ===
      trading
  ) {
    return false;
  }

  return true;
}

function metadataSectorResolved(
  stock
) {
  const sector =
    String(
      stock?.sector ||
      ''
    ).trim();

  return Boolean(
    sector &&
    sector.toUpperCase() !==
      'UNKNOWN'
  );
}

function containsAny(
  text,
  expressions
) {
  return expressions.some(
    expression =>
      expression.test(
        text
      )
  );
}

function metadataEvidenceForAudit(
  stock
) {
  const evidence =
    stock?.metadataEvidence ||
    {};

  const sources =
    uniqueTextValues(
      Array.isArray(
        stock?.metadataSources
      )
        ? stock.metadataSources
        : []
    );

  const officialSources = [];

  if (
    evidence.psxSymbols
  ) {
    officialSources.push(
      'PSX symbols'
    );
  }

  if (
    evidence.eligibleScrips
  ) {
    officialSources.push(
      'PSX eligible scrips'
    );
  }

  if (
    evidence.allShare
  ) {
    officialSources.push(
      'PSX ALLSHR'
    );
  }

  if (
    evidence.marketWatch
  ) {
    officialSources.push(
      'PSX market watch'
    );
  }

  const supplementalSources = [];

  if (
    evidence.pyPSX
  ) {
    supplementalSources.push(
      'pyPSX symbols'
    );
  }

  if (
    evidence.fallback
  ) {
    supplementalSources.push(
      'psx-rest-api'
    );
  }

  return {
    sources,

    officialSources:
      uniqueTextValues(
        officialSources
      ),

    supplementalSources:
      uniqueTextValues(
        supplementalSources
      ),

    hasOfficialCurrentEvidence:
      Boolean(
        evidence.psxSymbols ||
        evidence.eligibleScrips ||
        evidence.allShare ||
        evidence.marketWatch
      ),

    hasEligibleScripEvidence:
      Boolean(
        evidence.eligibleScrips
      ),

    hasAllShareEvidence:
      Boolean(
        evidence.allShare
      ),

    hasMarketWatchEvidence:
      Boolean(
        evidence.marketWatch
      ),

    hasPSXSymbolsEvidence:
      Boolean(
        evidence.psxSymbols
      ),

    hasPyPSXEvidence:
      Boolean(
        evidence.pyPSX
      ),

    hasFallbackEvidence:
      Boolean(
        evidence.fallback
      )
  };
}

function inferValidatedRightsParent(
  symbol,
  knownSymbols
) {
  const match =
    normalizeSymbol(
      symbol
    ).match(
      /^(.+?)R\d*$/
    );

  if (!match) {
    return null;
  }

  const candidate =
    normalizeSymbol(
      match[1]
    );

  if (
    candidate &&
    candidate !==
      normalizeSymbol(
        symbol
      ) &&
    knownSymbols.has(
      candidate
    )
  ) {
    return candidate;
  }

  return null;
}

function inferValidatedClassParent(
  symbol,
  knownSymbols
) {
  const normalized =
    normalizeSymbol(
      symbol
    );

  const patterns = [
    /^(.+?)CPS[A-Z0-9]*$/,
    /^(.+?)PREF[A-Z0-9]*$/,
    /^(.+?)PP$/,
    /^(.+?)PVI$/,
    /^(.+?)NV$/
  ];

  for (
    const pattern
    of patterns
  ) {
    const match =
      normalized.match(
        pattern
      );

    if (!match) {
      continue;
    }

    const candidate =
      normalizeSymbol(
        match[1]
      );

    if (
      candidate &&
      candidate !==
        normalized &&
      knownSymbols.has(
        candidate
      )
    ) {
      return candidate;
    }
  }

  return null;
}

function classifyIssuerAndSecurity(
  stock,
  knownSymbols
) {
  const symbol =
    normalizeSymbol(
      stock.symbol
    );

  const marketSymbol =
    normalizeSymbol(
      stock.tradingSymbol ||
      stock.marketSymbol
    );

  const name =
    String(
      stock.companyName ||
      ''
    ).trim();

  const sector =
    String(
      stock.sector ||
      ''
    ).trim();

  const listedIn =
    String(
      stock.listedIn ||
      ''
    ).trim();

  const searchable =
    [
      symbol,
      marketSymbol,
      name,
      sector,
      listedIn
    ]
      .join(' ')
      .toUpperCase();

  const validatedRightsParent =
    inferValidatedRightsParent(
      symbol,
      knownSymbols
    );

  const validatedClassParent =
    inferValidatedClassParent(
      symbol,
      knownSymbols
    );

  let issuerType =
    'COMPANY';

  let issuerLabel =
    'Company';

  if (
    containsAny(
      searchable,
      [
        /\bREAL ESTATE INVESTMENT TRUST\b/,
        /\bREIT\b/
      ]
    )
  ) {
    issuerType =
      'REIT';

    issuerLabel =
      'REIT';
  } else if (
    containsAny(
      searchable,
      [
        /\bEXCHANGE TRADED FUND\b/,
        /\bETF\b/
      ]
    )
  ) {
    issuerType =
      'ETF';

    issuerLabel =
      'ETF';
  } else if (
    containsAny(
      searchable,
      [
        /\bMODARABAS?\b/
      ]
    )
  ) {
    issuerType =
      'MODARABA';

    issuerLabel =
      'Modaraba';
  } else if (
    containsAny(
      searchable,
      [
        /\bMUTUAL FUND\b/,
        /\bCLOSED[ -]END FUND\b/,
        /\bFUND\b/
      ]
    )
  ) {
    issuerType =
      'FUND';

    issuerLabel =
      'Fund';
  } else if (
    containsAny(
      searchable,
      [
        /\bSPAC\b/,
        /\bSPECIAL PURPOSE ACQUISITION\b/
      ]
    )
  ) {
    issuerType =
      'SPAC';

    issuerLabel =
      'SPAC';
  }

  let securityType =
    'ORDINARY_EQUITY';

  let securityLabel =
    'Ordinary equity';

  let parentSymbol =
    null;

  let classificationReason =
    'No strong special-security marker was detected.';

  let classificationConfidence =
    'medium';

  if (
    containsAny(
      searchable,
      [
        /\bRIGHT ISSUE\b/,
        /\bRIGHTS ISSUE\b/,
        /\bRIGHTS?\b/,
        /\bENTITLEMENT\b/
      ]
    ) ||
    validatedRightsParent
  ) {
    securityType =
      'RIGHTS_ENTITLEMENT';

    securityLabel =
      'Rights / entitlement';

    parentSymbol =
      validatedRightsParent;

    classificationReason =
      validatedRightsParent
        ? (
            'Rights-style symbol maps safely to verified parent ticker ' +
            validatedRightsParent +
            '.'
          )
        : 'Name or listing information contains a rights or entitlement marker.';

    classificationConfidence =
      validatedRightsParent
        ? 'high'
        : 'medium';
  } else if (
    containsAny(
      searchable,
      [
        /\bPREFERENCE\b/,
        /\bPREFERRED\b/,
        /\bPREF\b/
      ]
    ) ||
    validatedClassParent
  ) {
    securityType =
      'PREFERENCE_CLASS';

    securityLabel =
      'Preference / special class';

    parentSymbol =
      validatedClassParent;

    classificationReason =
      validatedClassParent
        ? (
            'Special share-class symbol maps safely to verified parent ticker ' +
            validatedClassParent +
            '.'
          )
        : 'Name or listing information contains a preference-security marker.';

    classificationConfidence =
      validatedClassParent
        ? 'high'
        : 'medium';
  } else if (
    containsAny(
      searchable,
      [
        /\bSUKUK\b/,
        /\bTERM FINANCE CERTIFICATE\b/,
        /\bTFC\b/,
        /\bBOND\b/,
        /\bDEBT\b/
      ]
    )
  ) {
    securityType =
      'DEBT_SECURITY';

    securityLabel =
      'Debt / Sukuk';

    classificationReason =
      'Name, sector or listing field contains a debt-security marker.';

    classificationConfidence =
      'high';
  } else if (
    issuerType ===
      'MODARABA'
  ) {
    securityType =
      'MODARABA_CERTIFICATE';

    securityLabel =
      'Modaraba certificate';

    classificationReason =
      'Issuer or sector identifies a Modaraba.';

    classificationConfidence =
      'high';
  } else if (
    issuerType ===
      'REIT'
  ) {
    securityType =
      'REIT_UNIT';

    securityLabel =
      'REIT unit';

    classificationReason =
      'Issuer or sector identifies a REIT.';

    classificationConfidence =
      'high';
  } else if (
    issuerType ===
      'ETF'
  ) {
    securityType =
      'ETF_UNIT';

    securityLabel =
      'ETF unit';

    classificationReason =
      'Issuer or sector identifies an exchange-traded fund.';

    classificationConfidence =
      'high';
  } else if (
    issuerType ===
      'FUND'
  ) {
    securityType =
      'FUND_UNIT';

    securityLabel =
      'Fund unit';

    classificationReason =
      'Issuer or sector identifies a fund.';

    classificationConfidence =
      'medium';
  } else if (
    issuerType ===
      'SPAC'
  ) {
    securityType =
      'SPAC_EQUITY';

    securityLabel =
      'SPAC equity';

    classificationReason =
      'Issuer or symbol identifies a special purpose acquisition company.';

    classificationConfidence =
      'high';
  }

  let instrumentType =
    'ORDINARY_OR_UNCLASSIFIED';

  let instrumentLabel =
    'Ordinary / unclassified';

  if (
    securityType ===
      'RIGHTS_ENTITLEMENT'
  ) {
    instrumentType =
      'RIGHTS_OR_ENTITLEMENT';

    instrumentLabel =
      'Rights / entitlement';
  } else if (
    securityType ===
      'PREFERENCE_CLASS'
  ) {
    instrumentType =
      'PREFERENCE_OR_CLASS';

    instrumentLabel =
      'Preference / special class';
  } else if (
    securityType ===
      'DEBT_SECURITY'
  ) {
    instrumentType =
      'DEBT_OR_SUKUK';

    instrumentLabel =
      'Debt / Sukuk';
  } else if (
    issuerType !==
      'COMPANY'
  ) {
    instrumentType =
      issuerType;

    instrumentLabel =
      issuerLabel;
  }

  return {
    issuerType,
    issuerLabel,
    securityType,
    securityLabel,
    parentSymbol,
    classificationReason,
    classificationConfidence,
    instrumentType,
    instrumentLabel,
    isSpecialSecurity:
      securityType !==
        'ORDINARY_EQUITY'
  };
}

function deriveEligibility(
  row
) {
  const status =
    String(
      row.tradingStatus ||
      'UNKNOWN'
    ).toUpperCase();

  const securityType =
    row.securityType ||
    'ORDINARY_EQUITY';

  const issuerType =
    row.issuerType ||
    'COMPANY';

  const boardType =
    row.boardType ||
    'UNKNOWN';

  if (
    status ===
      'DELISTED'
  ) {
    return {
      eligibility:
        'INELIGIBLE_DELISTED',

      eligibilityLabel:
        'Not eligible - delisted',

      eligibilityReason:
        'PSX identifies this historical security as delisted.'
    };
  }

  if (
    status ===
      'CHANGED' ||
    status ===
      'MERGED' ||
    status ===
      'MIGRATED_OR_SYMBOL_CHANGED'
  ) {
    return {
      eligibility:
        'INELIGIBLE_HISTORICAL_SYMBOL',

      eligibilityLabel:
        'Not eligible - historical symbol',

      eligibilityReason:
        'This symbol has changed, merged or migrated and should not be used as the current trading identity.'
    };
  }

  if (
    status ===
      'SUSPENDED'
  ) {
    return {
      eligibility:
        'HOLD_SUSPENDED',

      eligibilityLabel:
        'Hold - suspended',

      eligibilityReason:
        'Trading is suspended. NOMAD should not use this security for a normal buy recommendation.'
    };
  }

  const currentLike =
    status ===
      'CURRENT' ||
    status ===
      'CURRENT_PAGE_EVIDENCE';

  if (!currentLike) {
    return {
      eligibility:
        'REVIEW_REQUIRED',

      eligibilityLabel:
        'Review required',

      eligibilityReason:
        'Current trading eligibility has not been established strongly enough for the recommendation universe.'
    };
  }

  if (
    securityType ===
      'RIGHTS_ENTITLEMENT' ||
    securityType ===
      'PREFERENCE_CLASS' ||
    securityType ===
      'DEBT_SECURITY'
  ) {
    return {
      eligibility:
        'NON_CORE_SPECIAL_SECURITY',

      eligibilityLabel:
        'Separate special-security universe',

      eligibilityReason:
        'Tradable special security, but not part of NOMAD’s ordinary-equity recommendation universe.'
    };
  }

  if (
    issuerType ===
      'MODARABA' ||
    issuerType ===
      'REIT' ||
    issuerType ===
      'ETF' ||
    issuerType ===
      'FUND'
  ) {
    return {
      eligibility:
        'ALTERNATIVE_LISTED_SECURITY',

      eligibilityLabel:
        'Alternative listed security',

      eligibilityReason:
        'Current listed security that should be evaluated under a separate product-specific framework.'
    };
  }

  if (
    issuerType ===
      'SPAC'
  ) {
    return {
      eligibility:
        'SPECIAL_EQUITY_REVIEW',

      eligibilityLabel:
        'Special equity review',

      eligibilityReason:
        'SPAC equity requires a dedicated risk framework before recommendation use.'
    };
  }

  if (
    boardType ===
      'GEM'
  ) {
    return {
      eligibility:
        'GEM_EQUITY_CANDIDATE',

      eligibilityLabel:
        'GEM equity candidate',

      eligibilityReason:
        'Current GEM Board equity. Keep separate risk/liquidity guardrails from Main Board equities.'
    };
  }

  return {
    eligibility:
      'CORE_EQUITY_CANDIDATE',

    eligibilityLabel:
      'Core equity candidate',

    eligibilityReason:
      'Current ordinary equity candidate for NOMAD’s future investable universe, subject to risk/liquidity filters.'
  };
}

function deriveIssueState(
  row
) {
  const nameResolved =
    Boolean(
      row.nameResolved
    );

  const sectorResolved =
    Boolean(
      row.sectorResolved
    );

  let issueType =
    null;

  let issueLabel =
    null;

  if (
    !nameResolved &&
    !sectorResolved
  ) {
    issueType =
      'MISSING_NAME_AND_SECTOR';

    issueLabel =
      'Name + sector missing';
  } else if (
    !nameResolved
  ) {
    issueType =
      'MISSING_NAME';

    issueLabel =
      'Company name missing';
  } else if (
    !sectorResolved
  ) {
    issueType =
      'MISSING_SECTOR';

    issueLabel =
      'Sector missing';
  }

  let bucket =
    null;

  let bucketLabel =
    null;

  if (issueType) {
    if (
      row.isSpecialSecurity
    ) {
      bucket =
        'LIKELY_SPECIAL_INSTRUMENT';

      bucketLabel =
        'Special-instrument metadata gap';
    } else if (
      row.tradingStatus ===
        'DELISTED' ||
      row.tradingStatus ===
        'CHANGED' ||
      row.tradingStatus ===
        'MERGED' ||
      row.tradingStatus ===
        'MIGRATED_OR_SYMBOL_CHANGED' ||
      row.tradingStatus ===
        'HISTORICAL_OR_INACTIVE'
    ) {
      bucket =
        'HISTORICAL_SECURITY';

      bucketLabel =
        'Historical-security metadata gap';
    } else if (
      row.universeClass ===
        'LEGACY_STALE_CANDIDATE' ||
      row.universeClass ===
        'REVIEW_REQUIRED'
    ) {
      bucket =
        'LEGACY_STALE_CANDIDATE';

      bucketLabel =
        'Legacy / stale candidate';
    } else {
      bucket =
        'LIKELY_NORMAL_COMPANY_MISSING_METADATA';

      bucketLabel =
        'Likely company metadata gap';
    }
  }

  const statusText =
    row.tradingStatusLabel
      ? (
          ' Trading status: ' +
          row.tradingStatusLabel +
          '.'
        )
      : '';

  const successorText =
    row.successorSymbol
      ? (
          ' Current/successor symbol: ' +
          row.successorSymbol +
          '.'
        )
      : '';

  const auditReason =
    issueType
      ? (
          issueLabel +
          '. ' +
          (
            row.universeReason ||
            row.classificationReason ||
            ''
          ) +
          statusText +
          successorText
        ).trim()
      : (
          (
            row.universeReason ||
            row.classificationReason ||
            ''
          ) +
          statusText +
          successorText
        ).trim();

  return {
    issueType,
    issueLabel,
    bucket,
    bucketLabel,
    auditReason
  };
}

function classifyInstrumentForAudit(
  stock,
  knownSymbols
) {
  const symbol =
    normalizeSymbol(
      stock.symbol
    );

  const marketSymbol =
    normalizeSymbol(
      stock.tradingSymbol
    );

  const name =
    String(
      stock.companyName ||
      ''
    ).trim();

  const sector =
    String(
      stock.sector ||
      ''
    ).trim();

  const listedIn =
    String(
      stock.listedIn ||
      ''
    ).trim();

  const nameResolved =
    metadataNameResolved(
      stock
    );

  const sectorResolved =
    metadataSectorResolved(
      stock
    );

  const evidence =
    metadataEvidenceForAudit(
      stock
    );

  const typeInfo =
    classifyIssuerAndSecurity(
      {
        ...stock,
        companyName:
          name,
        sector
      },
      knownSymbols
    );

  const boardInfo =
    inferGemBoard(
      {
        ...stock,
        companyName:
          name,
        sector
      },
      null
    );

  let tradingStatus =
    evidence.hasOfficialCurrentEvidence
      ? 'CURRENT'
      : 'UNKNOWN';

  let tradingStatusLabel =
    evidence.hasOfficialCurrentEvidence
      ? 'Current - official metadata evidence'
      : 'Unresolved current status';

  let universeClass =
    'UNVERIFIED';

  let universeLabel =
    'Unverified';

  let universeReason =
    'NOMAD could not establish current-security status from the official PSX metadata sources used by the fast audit.';

  if (
    typeInfo.isSpecialSecurity
  ) {
    universeClass =
      'SPECIAL_INSTRUMENT';

    universeLabel =
      'Special instrument';

    universeReason =
      evidence.hasOfficialCurrentEvidence
        ? 'Special security type detected and current official PSX metadata evidence is present.'
        : 'Special security type detected. Official company-page status will be resolved in the deep audit.';
  } else if (
    evidence.hasOfficialCurrentEvidence
  ) {
    universeClass =
      'VERIFIED_CURRENT';

    universeLabel =
      'Verified current';

    universeReason =
      'Current identity is supported by one or more official PSX metadata sources.';
  } else if (
    !listedIn
  ) {
    universeClass =
      'LEGACY_STALE_CANDIDATE';

    universeLabel =
      'Legacy / stale candidate';

    universeReason =
      'Fast audit found no current bulk-listing evidence. Official PSX company-page status still needs to be resolved.';
  }

  const base = {
    symbol,

    marketSymbol:
      marketSymbol ||
      symbol,

    rawSymbol:
      stock.rawSymbol ||
      marketSymbol ||
      symbol,

    companyName:
      name,

    sector,

    listedIn,

    statusCodes:
      Array.isArray(
        stock.statusCodes
      )
        ? stock.statusCodes
        : [],

    normalizedStatus:
      Boolean(
        stock.normalizedSymbol
      ),

    nameResolved,
    sectorResolved,

    ...typeInfo,

    tradingStatus,
    tradingStatusLabel,

    ...boardInfo,

    successorName:
      null,

    successorSymbol:
      null,

    companyPageUrl:
      null,

    companyPageQuoteAsOf:
      null,

    hasOfficialPageEvidence:
      false,

    universeClass,
    universeLabel,
    universeReason,

    metadataSources:
      evidence.sources,

    officialEvidenceSources:
      evidence.officialSources,

    supplementalEvidenceSources:
      evidence.supplementalSources,

    hasOfficialCurrentEvidence:
      evidence.hasOfficialCurrentEvidence
  };

  const eligibility =
    deriveEligibility(
      base
    );

  const withEligibility = {
    ...base,
    ...eligibility
  };

  const issue =
    deriveIssueState(
      withEligibility
    );

  return {
    ...withEligibility,
    ...issue
  };
}

function buildCurrentCompanyNameIndex(
  market
) {
  const index =
    new Map();

  for (
    const stock
    of market.stocks
  ) {
    const evidence =
      metadataEvidenceForAudit(
        stock
      );

    if (
      !evidence.hasOfficialCurrentEvidence ||
      !metadataNameResolved(
        stock
      )
    ) {
      continue;
    }

    const key =
      normalizeCompanyIdentityName(
        stock.companyName
      );

    if (!key) {
      continue;
    }

    const values =
      index.get(key) ||
      [];

    values.push({
      symbol:
        normalizeSymbol(
          stock.symbol
        ),

      companyName:
        stock.companyName
    });

    index.set(
      key,
      values
    );
  }

  return index;
}

function matchCurrentSymbolByCompanyName(
  value,
  companyNameIndex,
  excludeSymbol
) {
  const key =
    normalizeCompanyIdentityName(
      value
    );

  if (!key) {
    return null;
  }

  const candidates =
    (
      companyNameIndex.get(
        key
      ) ||
      []
    )
      .filter(
        item =>
          normalizeSymbol(
            item.symbol
          ) !==
          normalizeSymbol(
            excludeSymbol
          )
      );

  if (
    candidates.length ===
    1
  ) {
    return candidates[0]
      .symbol;
  }

  return null;
}

function quoteAgeDays(
  value
) {
  const time =
    Date.parse(
      value
    );

  if (
    !Number.isFinite(
      time
    )
  ) {
    return null;
  }

  return Math.max(
    0,
    (
      Date.now() -
      time
    ) /
    (
      24 *
      60 *
      60 *
      1000
    )
  );
}

function inferGemBoard(
  row,
  snapshot = null
) {
  const listing =
    snapshot?.listing ||
    {};

  if (
    listing.boardType ===
      'GEM'
  ) {
    return {
      boardType:
        'GEM',
      boardLabel:
        listing.boardLabel ||
        'GEM Board',
      boardEvidence:
        listing.boardEvidence ||
        'PSX company page GEM Board marker'
    };
  }

  const symbol =
    normalizeSymbol(
      row?.symbol
    );

  const name =
    String(
      snapshot?.companyName ||
      row?.companyName ||
      ''
    );

  if (
    /^GEM[A-Z0-9]/
      .test(
        symbol
      ) ||
    /\(\s*GEM\s*\)/i
      .test(
        name
      )
  ) {
    return {
      boardType:
        'GEM',
      boardLabel:
        'GEM Board',
      boardEvidence:
        'Verified GEM symbol/name marker'
    };
  }

  return {
    boardType:
      row?.boardType ||
      null,
    boardLabel:
      row?.boardLabel ||
      null,
    boardEvidence:
      row?.boardEvidence ||
      null
  };
}

function enrichAuditRowWithSnapshot(
  row,
  snapshot,
  knownSymbols,
  companyNameIndex,
  fetchDiagnostic = null
) {
  const fetchStatus =
    fetchDiagnostic?.fetchStatus ||
    (
      snapshot
        ? 'SUCCESS'
        : 'UNKNOWN'
    );

  const fetchFields = {
    companyPageFetchStatus:
      fetchStatus,

    companyPageFetchAttempts:
      fetchDiagnostic?.attempts ??
      null,

    companyPageRetried:
      Boolean(
        fetchDiagnostic?.retried
      ),

    companyPageHTTPStatus:
      fetchDiagnostic?.httpStatus ??
      null,

    companyPageFetchError:
      fetchDiagnostic?.error ||
      null
  };

  if (!snapshot) {
    const boardInfo =
      inferGemBoard(
        row,
        null
      );

    let tradingStatus =
      row.tradingStatus ===
        'CURRENT'
        ? 'CURRENT'
        : 'NO_COMPANY_PAGE_EVIDENCE';

    let tradingStatusLabel =
      row.tradingStatus ===
        'CURRENT'
        ? row.tradingStatusLabel
        : 'No PSX company-page evidence found';

    let universeClass =
      row.universeClass;

    let universeLabel =
      row.universeLabel;

    let universeReason =
      row.universeReason;

    if (
      fetchStatus ===
        'FETCH_FAILED' ||
      fetchStatus ===
        'INVALID_PAGE'
    ) {
      if (
        row.tradingStatus !==
          'CURRENT'
      ) {
        tradingStatus =
          fetchStatus ===
            'FETCH_FAILED'
            ? 'PAGE_FETCH_FAILED'
            : 'PAGE_INVALID';

        tradingStatusLabel =
          fetchStatus ===
            'FETCH_FAILED'
            ? 'PSX company-page request failed - retry later'
            : 'PSX page returned but identity could not be verified';

        universeClass =
          row.isSpecialSecurity
            ? 'SPECIAL_INSTRUMENT'
            : 'REVIEW_REQUIRED';

        universeLabel =
          row.isSpecialSecurity
            ? 'Special instrument'
            : 'Review required';

        universeReason =
          'NOMAD could not complete the official PSX company-page status check. This row must not be treated as absent or delisted.';
      }
    } else if (
      row.tradingStatus !==
        'CURRENT'
    ) {
      universeReason =
        'The symbol remains in the feed, but NOMAD could not retrieve a supporting PSX company page for status resolution.';
    }

    const base = {
      ...row,
      ...boardInfo,
      ...fetchFields,

      tradingStatus,
      tradingStatusLabel,
      statusEvidence:
        null,

      universeClass,
      universeLabel,
      universeReason
    };

    const eligibility =
      deriveEligibility(
        base
      );

    const withEligibility = {
      ...base,
      ...eligibility
    };

    const issue =
      deriveIssueState(
        withEligibility
      );

    return {
      ...withEligibility,
      ...issue
    };
  }

  let companyName =
    row.companyName;

  let sector =
    row.sector;

  let nameResolved =
    row.nameResolved;

  let sectorResolved =
    row.sectorResolved;

  if (
    !nameResolved &&
    snapshot.companyName
  ) {
    companyName =
      snapshot.companyName;

    nameResolved =
      Boolean(
        normalizeCompanyIdentityName(
          snapshot.companyName
        )
      );
  }

  if (
    !sectorResolved &&
    snapshot.sectorName
  ) {
    sector =
      snapshot.sectorName;

    sectorResolved =
      true;
  }

  const pageListing =
    snapshot.listing ||
    {};

  const boardInfo =
    inferGemBoard(
      {
        ...row,
        companyName,
        sector
      },
      snapshot
    );

  let tradingStatus =
    pageListing.explicitTradingStatus ||
    row.tradingStatus ||
    'UNKNOWN';

  let tradingStatusLabel =
    pageListing.tradingStatusLabel ||
    row.tradingStatusLabel ||
    'Unresolved current status';

  let successorName =
    pageListing.successorName ||
    null;

  let successorSymbol =
    pageListing.successorSymbol ||
    null;

  if (
    !successorSymbol &&
    successorName
  ) {
    successorSymbol =
      matchCurrentSymbolByCompanyName(
        successorName,
        companyNameIndex,
        row.symbol
      );
  }

  if (
    !successorSymbol &&
    !row.hasOfficialCurrentEvidence &&
    snapshot.companyName
  ) {
    successorSymbol =
      matchCurrentSymbolByCompanyName(
        snapshot.companyName,
        companyNameIndex,
        row.symbol
      );
  }

  if (
    successorSymbol &&
    !pageListing.explicitTradingStatus
  ) {
    tradingStatus =
      'MIGRATED_OR_SYMBOL_CHANGED';

    tradingStatusLabel =
      'Historical symbol - current symbol identified';
  }

  const ageDays =
    quoteAgeDays(
      snapshot.quote?.asOf
    );

  if (
    !pageListing.explicitTradingStatus &&
    !successorSymbol
  ) {
    if (
      row.hasOfficialCurrentEvidence
    ) {
      tradingStatus =
        'CURRENT';

      tradingStatusLabel =
        'Current - official listing evidence';
    } else if (
      ageDays !==
        null &&
      ageDays <= 60
    ) {
      tradingStatus =
        'CURRENT_PAGE_EVIDENCE';

      tradingStatusLabel =
        'Current candidate - recent official company page';
    } else if (
      ageDays !==
        null &&
      ageDays > 365
    ) {
      tradingStatus =
        'HISTORICAL_OR_INACTIVE';

      tradingStatusLabel =
        'Historical / inactive candidate';
    } else {
      tradingStatus =
        'PAGE_STATUS_UNCLEAR';

      tradingStatusLabel =
        'Official page found - current status unclear';
    }
  }

  const pageEvidenceLabel =
    'PSX company page';

  const metadataSources =
    uniqueTextValues([
      ...(
        row.metadataSources ||
        []
      ),
      pageEvidenceLabel
    ]);

  const officialEvidenceSources =
    uniqueTextValues([
      ...(
        row.officialEvidenceSources ||
        []
      ),
      pageEvidenceLabel
    ]);

  const typeInfo =
    classifyIssuerAndSecurity(
      {
        ...row,
        companyName,
        sector
      },
      knownSymbols
    );

  let universeClass =
    row.universeClass;

  let universeLabel =
    row.universeLabel;

  let universeReason =
    row.universeReason;

  if (
    tradingStatus ===
      'DELISTED' ||
    tradingStatus ===
      'CHANGED' ||
    tradingStatus ===
      'MERGED' ||
    tradingStatus ===
      'MIGRATED_OR_SYMBOL_CHANGED' ||
    tradingStatus ===
      'HISTORICAL_OR_INACTIVE'
  ) {
    universeClass =
      'HISTORICAL_OR_INACTIVE';

    universeLabel =
      'Historical / inactive';

    universeReason =
      pageListing.statusEvidence
        ? 'Official PSX company-page header provides an explicit historical trading-status signal.'
        : 'Official company-page evidence indicates that this is not a normal current trading identity.';
  } else if (
    tradingStatus ===
      'SUSPENDED'
  ) {
    universeClass =
      typeInfo.isSpecialSecurity
        ? 'SPECIAL_INSTRUMENT'
        : 'SUSPENDED_SECURITY';

    universeLabel =
      typeInfo.isSpecialSecurity
        ? 'Special instrument'
        : 'Suspended security';

    universeReason =
      'PSX company-page evidence indicates that trading is suspended.';
  } else if (
    tradingStatus ===
      'CURRENT' ||
    tradingStatus ===
      'CURRENT_PAGE_EVIDENCE'
  ) {
    universeClass =
      typeInfo.isSpecialSecurity
        ? 'SPECIAL_INSTRUMENT'
        : 'VERIFIED_CURRENT';

    universeLabel =
      typeInfo.isSpecialSecurity
        ? 'Special instrument'
        : 'Verified current';

    universeReason =
      row.hasOfficialCurrentEvidence
        ? 'Current identity is supported by official PSX listing metadata.'
        : 'Recent PSX company-page evidence supports a current-security candidate classification.';
  } else {
    universeClass =
      'REVIEW_REQUIRED';

    universeLabel =
      'Review required';

    universeReason =
      'Official PSX company-page evidence exists, but current trading status is not strong enough for automatic recommendation-universe inclusion.';
  }

  const enriched = {
    ...row,
    ...fetchFields,

    companyName,
    sector,
    nameResolved,
    sectorResolved,

    ...typeInfo,
    ...boardInfo,

    tradingStatus,
    tradingStatusLabel,

    statusEvidence:
      pageListing.statusEvidence ||
      null,

    successorName,
    successorSymbol,

    companyPageUrl:
      snapshot.sourceUrl ||
      null,

    companyPageQuoteAsOf:
      snapshot.quote?.asOf ||
      null,

    hasOfficialPageEvidence:
      true,

    metadataSources,
    officialEvidenceSources,

    universeClass,
    universeLabel,
    universeReason
  };

  const eligibility =
    deriveEligibility(
      enriched
    );

  const withEligibility = {
    ...enriched,
    ...eligibility
  };

  const issue =
    deriveIssueState(
      withEligibility
    );

  return {
    ...withEligibility,
    ...issue
  };
}

async function getSecurityStatusBatch(
  symbols
) {
  const requested =
    uniqueStrings(
      Array.isArray(
        symbols
      )
        ? symbols
        : String(
            symbols ||
            ''
          ).split(',')
    )
      .slice(
        0,
        8
      );

  if (
    !requested.length
  ) {
    bad(
      'Provide at least one symbol.'
    );
  }

  const market =
    await loadPSXMarket();

  const knownSymbols =
    new Set(
      market.stocks.map(
        stock =>
          normalizeSymbol(
            stock.symbol
          )
      )
    );

  const companyNameIndex =
    buildCurrentCompanyNameIndex(
      market
    );

  const stockMap =
    new Map(
      market.stocks.map(
        stock => [
          normalizeSymbol(
            stock.symbol
          ),
          stock
        ]
      )
    );

  const rows =
    requested
      .map(
        symbol => {
          const stock =
            stockMap.get(
              normalizeSymbol(
                symbol
              )
            );

          if (!stock) {
            return null;
          }

          return classifyInstrumentForAudit(
            stock,
            knownSymbols
          );
        }
      )
      .filter(Boolean);

  const fetchResults =
    await mapWithConcurrency(
      rows,
      1,
      row =>
        getPSXCompanySnapshotForAudit(
          row.symbol
        )
    );

  const diagnostics = {
    requested:
      requested.length,

    attempted:
      rows.length,

    succeeded:
      fetchResults.filter(
        item =>
          item?.snapshot
      ).length,

    retried:
      fetchResults.filter(
        item =>
          item?.retried
      ).length,

    notFound:
      fetchResults.filter(
        item =>
          item?.fetchStatus ===
          'NOT_FOUND'
      ).length,

    fetchFailed:
      fetchResults.filter(
        item =>
          item?.fetchStatus ===
          'FETCH_FAILED'
      ).length,

    invalidPage:
      fetchResults.filter(
        item =>
          item?.fetchStatus ===
          'INVALID_PAGE'
      ).length,

    totalAttempts:
      fetchResults.reduce(
        (
          sum,
          item
        ) =>
          sum +
          Number(
            item?.attempts ||
            0
          ),
        0
      ),

    httpStatusCounts:
      fetchResults.reduce(
        (
          counts,
          item
        ) => {
          const status =
            item?.httpStatus ===
              null ||
            item?.httpStatus ===
              undefined
              ? 'NO_STATUS'
              : String(
                  item.httpStatus
                );

          counts[status] =
            (
              counts[status] ||
              0
            ) +
            1;

          return counts;
        },
        {}
      )
  };

  return {
    version:
      VERSION,

    resolvedAt:
      new Date()
        .toISOString(),

    requested:
      requested.length,

    diagnostics,

    rows:
      rows.map(
        (
          row,
          index
        ) =>
          enrichAuditRowWithSnapshot(
            row,
            fetchResults[index]?.snapshot ||
            null,
            knownSymbols,
            companyNameIndex,
            fetchResults[index] ||
            null
          )
      )
  };
}

function countBy(
  rows,
  key
) {
  const counts = {};

  for (
    const row
    of rows
  ) {
    const value =
      row?.[key];

    if (!value) {
      continue;
    }

    counts[value] =
      (
        counts[value] ||
        0
      ) +
      1;
  }

  return counts;
}

async function getMetadataAudit() {
  if (
    metadataAuditCache &&
    Date.now() -
      metadataAuditCache.fetchedAt <
      10 *
      60 *
      1000
  ) {
    return metadataAuditCache.data;
  }

  const market =
    await loadPSXMarket();

  const rows =
    (PSX_UNIVERSE_MASTER.entries || [])
      .map(
        masterRowForClient
      );

  const liveSymbols =
    new Set(
      market.stocks.map(
        stock =>
          normalizeSymbol(
            stock.symbol
          )
      )
    );

  const feedUnmapped =
    market.stocks.filter(
      stock =>
        !PSX_UNIVERSE_BY_SYMBOL.has(
          normalizeSymbol(
            stock.symbol
          )
        )
    );

  const masterMissingFromFeed =
    rows.filter(
      row =>
        !liveSymbols.has(
          normalizeSymbol(
            row.symbol
          )
        )
    );

  const issues =
    rows.filter(
      row =>
        Boolean(
          row.issueType
        )
    );

  const summary =
    PSX_UNIVERSE_MASTER.summary ||
    {};

  const data = {
    version:
      VERSION,

    generatedAt:
      new Date()
        .toISOString(),

    marketAsOf:
      market.asOf,

    mode:
      'CANONICAL_UNIVERSE_MASTER',

    masterVersion:
      PSX_UNIVERSE_MASTER.masterVersion,

    masterGeneratedAt:
      PSX_UNIVERSE_MASTER.generatedAt,

    policy:
      PSX_UNIVERSE_MASTER.policy,

    summary: {
      totalCanonicalSecurities:
        summary.total ||
        rows.length,

      namesResolved:
        rows.filter(
          row =>
            row.nameResolved
        ).length,

      namesMissing:
        rows.filter(
          row =>
            !row.nameResolved
        ).length,

      sectorsResolved:
        rows.filter(
          row =>
            row.sectorResolved
        ).length,

      sectorsMissing:
        rows.filter(
          row =>
            !row.sectorResolved
        ).length,

      statusSymbolsNormalized:
        market.normalizedStatusRows ||
        0,

      totalMetadataIssues:
        issues.length,

      totalSpecialInstrumentsDetected:
        rows.filter(
          row =>
            row.isSpecialSecurity
        ).length,

      verifiedCurrentSecurities:
        (
          summary.coreEquity ||
          0
        ) +
        (
          summary.gemEquity ||
          0
        ),

      specialInstrumentSecurities:
        summary.alternativeCurrent ||
        0,

      legacyStaleCandidates:
        0,

      historicalOrInactive:
        0,

      suspendedSecurities:
        0,

      delistedSecurities:
        0,

      changedOrMigratedSymbols:
        0,

      statusReviewRequired:
        summary.reviewRequired ||
        0,

      coreEquityCandidates:
        summary.coreEquity ||
        0,

      gemEquityCandidates:
        summary.gemEquity ||
        0,

      alternativeCurrent:
        summary.alternativeCurrent ||
        0,

      defaultRecommendationEligible:
        summary.defaultRecommendationEligible ||
        0,

      feedUnmapped:
        feedUnmapped.length,

      masterMissingFromFeed:
        masterMissingFromFeed.length
    },

    sourceCoverage: {
      canonicalUniverseMaster:
        rows.length,
      currentVerified:
        summary.currentVerified ||
        0,
      feedMapped:
        market.stocks.length -
        feedUnmapped.length,
      feedUnmapped:
        feedUnmapped.length
    },

    bulkStatusDiagnostics: {
      loadedReports: 0,
      failedReports: 0,
      reports: [],
      matchesByReport: {}
    },

    universeClasses:
      countBy(
        rows,
        'universeClass'
      ),

    tradingStatusCounts:
      countBy(
        rows,
        'tradingStatus'
      ),

    eligibilityCounts:
      countBy(
        rows,
        'eligibility'
      ),

    issueBuckets:
      countBy(
        issues,
        'bucket'
      ),

    issueTypes:
      countBy(
        issues,
        'issueType'
      ),

    securityTypes:
      countBy(
        rows,
        'securityType'
      ),

    issuerTypes:
      countBy(
        rows,
        'issuerType'
      ),

    issues,
    universe:
      rows,
    feedUnmapped,
    masterMissingFromFeed
  };

  metadataAuditCache = {
    fetchedAt:
      Date.now(),
    data
  };

  return data;
}

/* =========================================================
   QUOTE FALLBACK
========================================================= */

async function fetchQuoteForSymbols(
  symbols
) {
  const candidates =
    uniqueStrings(
      symbols
    );

  let lastError =
    null;

  for (
    const symbol
    of candidates
  ) {
    try {
      const result =
        await fetchJSON(
          `${PSX_API_BASE}/stocks/${encodeURIComponent(
            symbol
          )}/quote`
        );

      if (
        result &&
        result.data
      ) {
        return {
          ...result,

          providerSymbol:
            symbol
        };
      }
    } catch (error) {
      lastError =
        error;
    }
  }

  if (
    lastError
  ) {
    throw lastError;
  }

  bad(
    'Quote unavailable.',
    502
  );
}

/* =========================================================
   HISTORICAL NORMALIZATION
========================================================= */

function normalizeHistoricalRows(
  rawRows
) {
  const cleaned = [];
  const anomalies = [];

  for (
    const row
    of (
      Array.isArray(
        rawRows
      )
        ? rawRows
        : []
    )
  ) {
    const date =
      String(
        row.date ||
        ''
      );

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

    if (
      suspicious
    ) {
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
      a.date.localeCompare(
        b.date
      )
  );

  return {
    cleaned,
    anomalies
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

async function fetchCanonicalHistory(
  canonicalSymbol,
  start,
  end
) {
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

  return fetchJSON(
    `${PSX_API_BASE}/stocks/${encodeURIComponent(
      canonicalSymbol
    )}/historical${query ? '?' + query : ''}`
  );
}

/* =========================================================
   QUOTE / OVERVIEW
========================================================= */

async function getQuote(
  stockSymbol
) {
  const context =
    await resolveSymbolContext(
      stockSymbol
    );

  const symbol =
    context.canonicalSymbol;

  const now =
    new Date();

  const historyStartDate =
    new Date(
      now.getTime() -
      380 *
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

  const [
    result,
    sectorMap,
    liveResult,
    historyResult,
    companySnapshot
  ] =
    await Promise.all([
      fetchQuoteForSymbols([
        context.tradingSymbol,
        symbol
      ]),

      loadSectorMap(),

      getLiveForContext(
        context
      ).catch(
        () => null
      ),

      fetchCanonicalHistory(
        symbol,
        historyStartDate,
        historyEndDate
      ).catch(
        () => null
      ),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      )
    ]);

  const data =
    result.data ||
    {};

  const officialQuote =
    companySnapshot?.quote ||
    {};

  const historical =
    normalizeHistoricalRows(
      historyResult?.data ||
      []
    ).cleaned;

  const liveSessionDate =
    liveResult?.sessionDate ||
    '';

  const officialSessionDate =
    officialQuote?.asOfDateKey ||
    '';

  const officialMatchesSession =
    Boolean(
      officialSessionDate &&
      (
        !liveSessionDate ||
        officialSessionDate ===
          liveSessionDate
      )
    );

  const marketClosed =
    Boolean(
      liveResult?.marketStatus?.known &&
      !liveResult.marketStatus.isOpen
    );

  const useOfficialSession =
    Boolean(
      marketClosed &&
      officialMatchesSession &&
      (
        officialQuote.open !==
          null ||
        officialQuote.high !==
          null ||
        officialQuote.low !==
          null ||
        officialQuote.volume !==
          null
      )
    );

  const quotePrice =
    safeNumber(
      data.price
    );

  const currentPrice =
    safeNumber(
      liveResult?.price
    ) ??
    safeNumber(
      officialQuote?.price
    ) ??
    quotePrice;

  let historicalPreviousClose =
    null;

  const targetSessionDate =
    liveSessionDate ||
    officialSessionDate;

  if (
    targetSessionDate
  ) {
    const previousRows =
      historical.filter(
        row =>
          row.date <
          targetSessionDate
      );

    if (
      previousRows.length
    ) {
      historicalPreviousClose =
        previousRows[
          previousRows.length -
          1
        ].close;
    }
  }

  let previousClose =
    safeNumber(
      officialQuote.ldcp
    ) ??
    safeNumber(
      data.ldcp
    ) ??
    historicalPreviousClose;

  const sourceChangePct =
    safeNumber(
      data.change_pct
    );

  if (
    previousClose ===
      null &&
    quotePrice !==
      null &&
    sourceChangePct !==
      null
  ) {
    const denominator =
      1 +
      sourceChangePct /
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
    null;

  let dayChangePct =
    null;

  if (
    currentPrice !==
      null &&
    previousClose !==
      null &&
    previousClose !==
      0
  ) {
    dayChange =
      currentPrice -
      previousClose;

    dayChangePct =
      (
        dayChange /
        previousClose
      ) *
      100;
  } else {
    dayChange =
      safeNumber(
        data.change
      );

    dayChangePct =
      sourceChangePct;
  }

  const session =
    useOfficialSession
      ? {
          open:
            officialQuote.open ??
            liveResult?.session?.open ??
            null,

          high:
            officialQuote.high ??
            liveResult?.session?.high ??
            null,

          low:
            officialQuote.low ??
            liveResult?.session?.low ??
            null,

          close:
            currentPrice,

          volume:
            officialQuote.volume ??
            liveResult?.session?.volume ??
            null,

          candles:
            liveResult?.session?.candles ??
            null
        }
      : (
          liveResult?.session ||
          {
            open:
              officialQuote.open ??
              null,

            high:
              officialQuote.high ??
              null,

            low:
              officialQuote.low ??
              null,

            close:
              currentPrice,

            volume:
              officialQuote.volume ??
              null,

            candles:
              null
          }
        );

  const ytdStartKey =
    `${now.getUTCFullYear()}-01-01`;

  const ytdRows =
    historical.filter(
      row =>
        row.date >=
        ytdStartKey
    );

  const ytdStartClose =
    ytdRows[0]?.close ??
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
    historical.filter(
      row =>
        row.date >=
        range52StartKey
    );

  const range52High =
    range52Rows.length
      ? Math.max(
          ...range52Rows.map(
            row =>
              row.high
          )
        )
      : null;

  const range52Low =
    range52Rows.length
      ? Math.min(
          ...range52Rows.map(
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
      session?.volume
    );

  const volumeVsAveragePct =
    sessionVolume !==
      null &&
    averageVolume30d !==
      null &&
    averageVolume30d > 0
      ? (
          sessionVolume /
          averageVolume30d
        ) *
        100
      : null;

  const resolvedName =
    companySnapshot?.companyName ||
    context.companyName ||
    symbol;

  const resolvedSector =
    companySnapshot?.sectorName ||
    context.sector ||
    sectorMap.get(
      symbol
    ) ||
    '';

  const officialMarketCap =
    companySnapshot
      ?.equity
      ?.marketCapPkr ??
    safeNumber(
      data.market_cap
    );

  const shares =
    companySnapshot
      ?.equity
      ?.shares ??
    null;

  const estimatedMarketCap =
    officialMarketCap ===
      null &&
    currentPrice !==
      null &&
    shares !==
      null &&
    shares > 0
      ? currentPrice *
        shares
      : null;

  const marketCapPkr =
    officialMarketCap ??
    estimatedMarketCap;

  const marketCapSource =
    officialMarketCap !==
      null
      ? 'official'
      : estimatedMarketCap !==
        null
        ? 'estimated'
        : null;

  const peRaw =
    safeNumber(
      data.pe_ratio
    ) ??
    safeNumber(
      officialQuote.peRatio
    );

  const combinedStatuses =
    uniqueStrings([
      ...context.statusCodes,
      ...(
        companySnapshot
          ?.statusCodes ||
        []
      )
    ]);

  return {
    symbol,

    identity: {
      canonicalSymbol:
        symbol,

      tradingSymbol:
        context.tradingSymbol,

      rawMarketSymbol:
        context.rawMarketSymbol,

      statusCodes:
        combinedStatuses,

      normalized:
        context.normalized
    },

    company: {
      name:
        resolvedName,

      sector:
        resolvedSector
    },

    data,

    meta:
      result.meta ||
      null,

    quoteProviderSymbol:
      result.providerSymbol ||
      null,

    live:
      liveResult,

    official:
      companySnapshot
        ? {
            equity:
              companySnapshot.equity,

            quote:
              companySnapshot.quote,

            statusCodes:
              companySnapshot.statusCodes,

            sourceUrl:
              companySnapshot.sourceUrl,

            fetchedAt:
              companySnapshot.fetchedAt
          }
        : null,

    decision: {
      price:
        currentPrice,

      previousClose,

      dayChange,

      dayChangePct,

      session,

      sessionSource:
        useOfficialSession
          ? 'PSX Data Portal'
          : liveResult
            ? 'pyPSX'
            : companySnapshot
              ? 'PSX Data Portal'
              : null,

      marketStatus:
        liveResult?.marketStatus ||
        null,

      feedState:
        liveResult?.feedState ||
        null,

      feedLabel:
        liveResult?.feedLabel ||
        null,

      priceTimestamp:
        liveResult?.timestamp ||
        officialQuote?.asOf ||
        result?.meta?.timestamp ||
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
        peRaw !==
          null &&
        peRaw > 0
          ? peRaw
          : null,

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

      marketCapPkr,

      marketCapSource,

      shares,

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

/* =========================================================
   HISTORY
========================================================= */

async function getHistory(
  stockSymbol,
  range = '1Y'
) {
  const context =
    await resolveSymbolContext(
      stockSymbol
    );

  const symbol =
    context.canonicalSymbol;

  const normalizedRange =
    [
      '1M',
      '6M',
      '1Y',
      '2Y',
      'ALL'
    ].includes(
      String(
        range || ''
      ).toUpperCase()
    )
      ? String(
          range
        ).toUpperCase()
      : '1Y';

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

  const [
    result,
    sectorMap,
    snapshot
  ] =
    await Promise.all([
      fetchCanonicalHistory(
        symbol,
        start,
        end
      ),

      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      )
    ]);

  const normalized =
    normalizeHistoricalRows(
      result.data ||
      []
    );

  const cleaned =
    normalized.cleaned;

  const anomalies =
    normalized.anomalies;

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

  return {
    symbol,

    identity: {
      canonicalSymbol:
        symbol,

      tradingSymbol:
        context.tradingSymbol,

      rawMarketSymbol:
        context.rawMarketSymbol,

      statusCodes:
        uniqueStrings([
          ...context.statusCodes,
          ...(
            snapshot?.statusCodes ||
            []
          )
        ]),

      normalized:
        context.normalized
    },

    company: {
      name:
        snapshot?.companyName ||
        context.companyName ||
        symbol,

      sector:
        snapshot?.sectorName ||
        context.sector ||
        sectorMap.get(
          symbol
        ) ||
        ''
    },

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

/* =========================================================
   FUNDAMENTALS
========================================================= */

/* =========================================================
   FINANCIAL ANALYST CORE - BUILD 0.8.4B.1

   IMPORTANT:
   - This layer normalizes and interprets evidence already returned by PSX.
   - It does not fabricate missing fields.
   - It now supplies evidence gates to the Decision Center, while the legacy score remains visible for validation.
   - Sector-specific interpretation is deliberately deferred when a generic
     accounting ratio could be misleading (for example, banks / insurers).
========================================================= */

const ANALYST_FINANCIAL_METRICS = {
  revenue: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(sales|net sales|revenue|net revenue|turnover)$/i,
      /^(total income|mark-up earned|markup earned)$/i
    ]
  },
  grossProfit: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^gross profit$/i
    ]
  },
  operatingProfit: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(operating profit|profit from operations|operating income)$/i
    ]
  },
  financeCost: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(finance cost|finance costs|financial charges|finance charges)$/i
    ]
  },
  profitBeforeTax: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(profit before taxation|profit before tax|pbt)$/i
    ]
  },
  profitAfterTax: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(profit after taxation|profit after tax|pat)$/i
    ]
  },
  eps: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(eps|earnings per share)$/i
    ]
  },
  otherIncome: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^other income$/i
    ]
  },
  exceptionalItems: {
    sources: ['annual', 'quarterly'],
    patterns: [
      /^(exceptional items?|extraordinary items?|one[- ]off items?)$/i
    ]
  },
  totalAssets: {
    sources: ['annual'],
    patterns: [
      /^total assets$/i
    ]
  },
  totalEquity: {
    sources: ['annual'],
    patterns: [
      /^(total equity|shareholders'? equity|share holders'? equity|total shareholders'? equity)$/i
    ]
  },
  borrowings: {
    sources: ['annual'],
    patterns: [
      /^(total borrowings|borrowings|total debt)$/i
    ]
  },
  cash: {
    sources: ['annual'],
    patterns: [
      /^(cash|cash and bank balances|cash & bank balances|cash and cash equivalents|cash & cash equivalents)$/i
    ]
  },
  operatingCashFlow: {
    sources: ['annual'],
    patterns: [
      /^(operating cash flow|cash flow from operating activities|net cash from operating activities|net cash generated from operating activities|cash generated from operations)$/i
    ]
  },
  capex: {
    sources: ['annual'],
    patterns: [
      /^(capex|capital expenditure|capital expenditures|purchase of property plant and equipment|purchase of property, plant and equipment)$/i
    ]
  },
  dividendPerShare: {
    sources: ['annual', 'ratios'],
    patterns: [
      /^(dps|dividend per share|cash dividend per share)$/i
    ]
  },
  roe: {
    sources: ['ratios'],
    patterns: [
      /^(return on equity|roe)$/i
    ]
  },
  netProfitMargin: {
    sources: ['ratios'],
    patterns: [
      /^net profit margin$/i
    ]
  },
  grossMargin: {
    sources: ['ratios'],
    patterns: [
      /^(gross margin|gross profit margin)$/i
    ]
  },
  operatingMargin: {
    sources: ['ratios'],
    patterns: [
      /^(operating margin|operating profit margin)$/i
    ]
  },
  debtToEquity: {
    sources: ['ratios'],
    patterns: [
      /^(debt[ /-]?to[ /-]?equity|debt[ /-]?equity|d\/e)$/i
    ]
  },
  currentRatio: {
    sources: ['ratios'],
    patterns: [
      /^current ratio$/i
    ]
  },
  priceToBook: {
    sources: ['ratios'],
    patterns: [
      /^(price\/book|price to book|p\/b|pb ratio)$/i
    ]
  },
  payoutRatio: {
    sources: ['ratios'],
    patterns: [
      /^(payout ratio|dividend payout ratio)$/i
    ]
  }
};

function analystNormalizeMetricLabel(
  value
) {
  return String(
    value || ''
  )
    .replace(/\u00a0/g, ' ')
    // PSX ratio labels commonly include units, e.g.
    // "Gross Profit Margin (%)". Units are presentation metadata,
    // not part of the metric identity, so strip only trailing unit tokens.
    .replace(/\s*\(\s*%\s*\)\s*$/i, '')
    .replace(/\s*%\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function analystMetricRow(
  table,
  definition
) {
  if (
    !table ||
    !Array.isArray(
      table.rows
    )
  ) {
    return null;
  }

  for (
    const row
    of table.rows
  ) {
    const label =
      analystNormalizeMetricLabel(
        row?.label
      );

    if (!label) {
      continue;
    }

    for (
      let index = 0;
      index < definition.patterns.length;
      index++
    ) {
      if (
        definition.patterns[index]
          .test(label)
      ) {
        return {
          row,
          label,
          mappingConfidence:
            index === 0
              ? 'HIGH'
              : 'MEDIUM'
        };
      }
    }
  }

  return null;
}

function analystMetricSeries(
  table,
  definition,
  sourceType
) {
  const match =
    analystMetricRow(
      table,
      definition
    );

  if (!match) {
    return {
      available: false,
      sourceType,
      sourceLabel: null,
      mappingConfidence: null,
      values: [],
      latest: null,
      previous: null,
      changePct: null,
      multiPeriodDirection:
        'UNAVAILABLE'
    };
  }

  const values =
    (match.row.values || [])
      .map(
        item => ({
          period:
            item?.period ||
            null,
          raw:
            item?.raw ??
            null,
          value:
            safeNumber(
              item?.value
            )
        })
      )
      .filter(
        item =>
          item.value !== null
      );

  const latest =
    values[0] ||
    null;

  const previous =
    values[1] ||
    null;

  let changePct =
    null;

  if (
    latest &&
    previous &&
    previous.value !== 0
  ) {
    changePct =
      (
        latest.value -
        previous.value
      ) /
      Math.abs(
        previous.value
      ) *
      100;
  }

  let positiveMoves = 0;
  let negativeMoves = 0;

  for (
    let index = 0;
    index < Math.min(
      values.length - 1,
      4
    );
    index++
  ) {
    const newer =
      values[index]?.value;

    const older =
      values[index + 1]?.value;

    if (
      newer === null ||
      newer === undefined ||
      older === null ||
      older === undefined
    ) {
      continue;
    }

    if (newer > older) {
      positiveMoves++;
    } else if (newer < older) {
      negativeMoves++;
    }
  }

  let multiPeriodDirection =
    'MIXED';

  if (
    values.length < 2
  ) {
    multiPeriodDirection =
      'INSUFFICIENT_HISTORY';
  } else if (
    positiveMoves > 0 &&
    negativeMoves === 0
  ) {
    multiPeriodDirection =
      'IMPROVING';
  } else if (
    negativeMoves > 0 &&
    positiveMoves === 0
  ) {
    multiPeriodDirection =
      'DETERIORATING';
  } else if (
    positiveMoves === 0 &&
    negativeMoves === 0
  ) {
    multiPeriodDirection =
      'STABLE';
  }

  return {
    available:
      Boolean(latest),
    sourceType,
    sourceLabel:
      match.label,
    mappingConfidence:
      match.mappingConfidence,
    values,
    latest,
    previous,
    changePct:
      decisionRound(
        changePct,
        2
      ),
    multiPeriodDirection
  };
}

function analystResolveMetric(
  fundamentals,
  metricKey
) {
  const definition =
    ANALYST_FINANCIAL_METRICS[
      metricKey
    ];

  if (!definition) {
    return {
      available: false,
      sourceType: null,
      sourceLabel: null,
      mappingConfidence: null,
      values: [],
      latest: null,
      previous: null,
      changePct: null,
      multiPeriodDirection:
        'UNAVAILABLE'
    };
  }

  for (
    const sourceType
    of definition.sources
  ) {
    const table =
      fundamentals?.[
        sourceType
      ] ||
      null;

    const evidence =
      analystMetricSeries(
        table,
        definition,
        sourceType
      );

    if (evidence.available) {
      return evidence;
    }
  }

  return {
    available: false,
    sourceType:
      definition.sources[0] ||
      null,
    sourceLabel: null,
    mappingConfidence: null,
    values: [],
    latest: null,
    previous: null,
    changePct: null,
    multiPeriodDirection:
      'UNAVAILABLE'
  };
}

function analystTrendView(
  evidence,
  options = {}
) {
  if (
    !evidence?.available ||
    !evidence.latest
  ) {
    return {
      state: 'UNRELIABLE',
      reason:
        'Required financial evidence was not available.'
    };
  }

  const latest =
    safeNumber(
      evidence.latest.value
    );

  const changePct =
    safeNumber(
      evidence.changePct
    );

  if (
    options.requirePositive &&
    latest !== null &&
    latest <= 0
  ) {
    return {
      state: 'WEAK',
      reason:
        'Latest reported value is not positive.'
    };
  }

  if (changePct === null) {
    return {
      state: 'UNRELIABLE',
      reason:
        'Only one usable reporting period was available.'
    };
  }

  if (changePct >= 10) {
    return {
      state: 'IMPROVING',
      reason:
        'Latest reported value increased materially versus the preceding period.'
    };
  }

  if (changePct >= -5) {
    return {
      state: 'STABLE',
      reason:
        'Latest reported value is broadly stable versus the preceding period.'
    };
  }

  return {
    state: 'DETERIORATING',
    reason:
      'Latest reported value declined versus the preceding period.'
  };
}

function analystSamePeriodRatio(
  numerator,
  denominator
) {
  const top =
    numerator?.latest ||
    null;

  const bottom =
    denominator?.latest ||
    null;

  if (
    !top ||
    !bottom ||
    safeNumber(
      bottom.value
    ) === null ||
    safeNumber(
      bottom.value
    ) === 0
  ) {
    return null;
  }

  if (
    top.period &&
    bottom.period &&
    String(top.period) !==
      String(bottom.period)
  ) {
    return null;
  }

  return decisionRound(
    safeNumber(
      top.value
    ) /
    Math.abs(
      safeNumber(
        bottom.value
      )
    ),
    4
  );
}

function analystFinancialSector(
  fundamentals
) {
  const sector =
    String(
      fundamentals?.company?.sector ||
      ''
    ).toLowerCase();

  return /bank|insurance|modaraba|investment compan|leasing|mutual fund|reit|financial service/
    .test(sector);
}

function analystBalanceSheetView(
  evidence,
  fundamentals
) {
  if (
    analystFinancialSector(
      fundamentals
    )
  ) {
    return {
      state:
        'SECTOR_MODEL_REQUIRED',
      reason:
        'Generic corporate leverage rules are not reliable for financial-sector companies.',
      debtToEquity:
        evidence.debtToEquity
          ?.latest?.value ??
        null,
      reportedBorrowingsToEquity:
        null
    };
  }

  const reportedBorrowingsToEquity =
    analystSamePeriodRatio(
      evidence.borrowings,
      evidence.totalEquity
    );

  if (
    reportedBorrowingsToEquity !== null
  ) {
    return {
      state:
        'EVIDENCE_AVAILABLE',
      reason:
        'Reported borrowings and equity were both available for the latest matching period. Sector interpretation is still required.',
      debtToEquity:
        evidence.debtToEquity
          ?.latest?.value ??
        null,
      reportedBorrowingsToEquity
    };
  }

  if (
    evidence.debtToEquity?.available
  ) {
    return {
      state:
        'EVIDENCE_AVAILABLE',
      reason:
        'PSX ratio evidence includes a debt-to-equity measure. Sector interpretation is still required.',
      debtToEquity:
        evidence.debtToEquity
          .latest?.value ??
        null,
      reportedBorrowingsToEquity:
        null
    };
  }

  return {
    state: 'UNRELIABLE',
    reason:
      'Borrowings/equity evidence was not sufficient for a leverage conclusion.',
    debtToEquity: null,
    reportedBorrowingsToEquity:
      null
  };
}

function analystCashFlowView(
  evidence,
  fundamentals
) {
  if (
    analystFinancialSector(
      fundamentals
    )
  ) {
    return {
      state:
        'SECTOR_MODEL_REQUIRED',
      reason:
        'Generic operating-cash-flow conversion is not a suitable quality test for financial-sector companies.',
      cashConversion:
        null
    };
  }

  const cashConversion =
    analystSamePeriodRatio(
      evidence.operatingCashFlow,
      evidence.profitAfterTax
    );

  if (cashConversion === null) {
    return {
      state: 'UNRELIABLE',
      reason:
        'Operating cash flow and profit after tax were not both available for the same period.',
      cashConversion:
        null
    };
  }

  const operatingCash =
    safeNumber(
      evidence.operatingCashFlow
        ?.latest?.value
    );

  const pat =
    safeNumber(
      evidence.profitAfterTax
        ?.latest?.value
    );

  if (
    pat !== null &&
    pat > 0 &&
    operatingCash !== null &&
    operatingCash <= 0
  ) {
    return {
      state: 'WEAK',
      reason:
        'Reported profit is positive while operating cash flow is not positive.',
      cashConversion
    };
  }

  if (cashConversion >= 1) {
    return {
      state: 'STRONG',
      reason:
        'Operating cash flow covers or exceeds reported profit for the latest matching period.',
      cashConversion
    };
  }

  if (cashConversion >= 0.6) {
    return {
      state: 'ACCEPTABLE',
      reason:
        'Operating cash flow converts a meaningful portion of reported profit.',
      cashConversion
    };
  }

  return {
    state: 'QUESTIONABLE',
    reason:
      'Operating cash conversion is weak relative to reported profit.',
    cashConversion
  };
}

function analystEarningsQualityView(
  evidence,
  fundamentals
) {
  if (
    analystFinancialSector(
      fundamentals
    )
  ) {
    return {
      state:
        'SECTOR_MODEL_REQUIRED',
      reason:
        'Financial-sector earnings quality requires sector-specific balance-sheet and provisioning analysis.',
      otherIncomeShareOfPat:
        null,
      exceptionalItemShareOfPat:
        null
    };
  }

  const otherIncomeShareOfPat =
    analystSamePeriodRatio(
      evidence.otherIncome,
      evidence.profitAfterTax
    );

  const exceptionalItemShareOfPat =
    analystSamePeriodRatio(
      evidence.exceptionalItems,
      evidence.profitAfterTax
    );

  const cashView =
    analystCashFlowView(
      evidence,
      fundamentals
    );

  if (
    exceptionalItemShareOfPat !== null &&
    Math.abs(
      exceptionalItemShareOfPat
    ) >= 0.25
  ) {
    return {
      state: 'QUESTIONABLE',
      reason:
        'Exceptional/extraordinary items are material relative to reported profit.',
      otherIncomeShareOfPat,
      exceptionalItemShareOfPat
    };
  }

  if (
    otherIncomeShareOfPat !== null &&
    Math.abs(
      otherIncomeShareOfPat
    ) >= 0.5
  ) {
    return {
      state: 'QUESTIONABLE',
      reason:
        'Other income is large relative to reported profit and requires manual/sector review.',
      otherIncomeShareOfPat,
      exceptionalItemShareOfPat
    };
  }

  if (
    cashView.state === 'STRONG' ||
    cashView.state === 'ACCEPTABLE'
  ) {
    return {
      state: 'ACCEPTABLE',
      reason:
        'No material one-off flag was detected in the available rows and cash conversion is supportive.',
      otherIncomeShareOfPat,
      exceptionalItemShareOfPat
    };
  }

  if (
    cashView.state === 'WEAK' ||
    cashView.state === 'QUESTIONABLE'
  ) {
    return {
      state: 'QUESTIONABLE',
      reason:
        'Available cash-flow evidence does not strongly support reported earnings.',
      otherIncomeShareOfPat,
      exceptionalItemShareOfPat
    };
  }

  return {
    state: 'UNRELIABLE',
    reason:
      'The currently parsed PSX rows are insufficient to validate earnings quality.',
    otherIncomeShareOfPat,
    exceptionalItemShareOfPat
  };
}

function analystDividendView(
  evidence,
  fundamentals
) {
  const payout =
    safeNumber(
      evidence.payoutRatio
        ?.latest?.value
    );

  if (payout !== null) {
    return {
      state:
        'EVIDENCE_AVAILABLE',
      reason:
        'A reported payout ratio is available. Sustainability still requires earnings and cash-flow context.',
      payoutRatio:
        decisionRound(
          payout,
          2
        ),
      dividendYield:
        safeNumber(
          fundamentals?.valuation
            ?.dividendYield
        )
    };
  }

  return {
    state: 'UNRELIABLE',
    reason:
      'Dividend yield alone is not sufficient evidence of dividend sustainability.',
    payoutRatio: null,
    dividendYield:
      safeNumber(
        fundamentals?.valuation
          ?.dividendYield
      )
  };
}

function analystOverallFinancialView(
  evidence,
  views,
  coveragePct
) {
  if (coveragePct < 60) {
    return {
      state: 'UNRELIABLE',
      reason:
        'Headline PSX financial evidence coverage is too low for a dependable summary verdict.'
    };
  }

  const pat =
    safeNumber(
      evidence.profitAfterTax
        ?.latest?.value
    );

  const eps =
    safeNumber(
      evidence.eps
        ?.latest?.value
    );

  if (
    pat !== null &&
    pat <= 0
  ) {
    return {
      state: 'WEAK',
      reason:
        'Latest reported profit after tax is not positive.'
    };
  }

  if (
    eps !== null &&
    eps <= 0
  ) {
    return {
      state: 'WEAK',
      reason:
        'Latest reported EPS is not positive.'
    };
  }

  // Explicit negative evidence should still override headline strength.
  // Missing cash-flow/balance-sheet evidence is handled separately as an
  // evidence-tier limitation rather than being treated as a negative fact.
  if (
    views.earningsQuality.state ===
      'QUESTIONABLE' ||
    views.cashFlowQuality.state ===
      'WEAK'
  ) {
    return {
      state: 'MIXED',
      reason:
        'Headline profitability is not fully supported by the available quality evidence.'
    };
  }

  if (
    views.profitTrend.state ===
      'DETERIORATING' ||
    views.epsTrend.state ===
      'DETERIORATING'
  ) {
    return {
      state: 'MIXED',
      reason:
        'Latest earnings trend has deteriorated versus the preceding period.'
    };
  }

  const profitImproving =
    views.profitTrend.state ===
      'IMPROVING';

  const epsImproving =
    views.epsTrend.state ===
      'IMPROVING';

  const marginNotWeak =
    views.marginTrend.state !==
      'DETERIORATING' &&
    views.marginTrend.state !==
      'WEAK';

  if (
    profitImproving &&
    epsImproving &&
    marginNotWeak
  ) {
    return {
      state: 'GOOD',
      reason:
        'Headline PSX evidence shows improving profit and EPS with no deterioration in the available margin trend. Extended statement validation may still be pending.'
    };
  }

  if (
    (profitImproving || epsImproving) &&
    marginNotWeak
  ) {
    return {
      state: 'GOOD',
      reason:
        'Headline PSX evidence is positive overall, although not every trend is equally strong. Extended statement validation may still be pending.'
    };
  }

  return {
    state: 'MIXED',
    reason:
      'Available headline evidence is usable, but does not support a stronger summary conclusion yet.'
  };
}

function buildFinancialAnalystCore(
  fundamentals
) {
  const evidence = {};

  for (
    const metricKey
    of Object.keys(
      ANALYST_FINANCIAL_METRICS
    )
  ) {
    evidence[metricKey] =
      analystResolveMetric(
        fundamentals,
        metricKey
      );
  }

  // PSX company summary pages expose headline financials and ratios,
  // but generally do not expose full balance-sheet/cash-flow statements.
  // Do not grade the source as 33% merely because it lacks fields it never
  // claims to provide. Track headline and extended evidence separately.
  const summaryKeys = [
    'revenue',
    'profitAfterTax',
    'eps',
    'grossMargin',
    'netProfitMargin'
  ];

  const extendedKeys = [
    'totalAssets',
    'totalEquity',
    'financeCost',
    'operatingCashFlow',
    'borrowings',
    'cash'
  ];

  const observedCore =
    summaryKeys.filter(
      key =>
        evidence[key]
          ?.available
    );

  const observedExtended =
    extendedKeys.filter(
      key =>
        evidence[key]
          ?.available
    );

  const coveragePct =
    decisionRound(
      observedCore.length /
      summaryKeys.length *
      100,
      2
    );

  const extendedCoveragePct =
    decisionRound(
      observedExtended.length /
      extendedKeys.length *
      100,
      2
    );

  const views = {
    revenueTrend:
      analystTrendView(
        evidence.revenue
      ),
    profitTrend:
      analystTrendView(
        evidence.profitAfterTax,
        {
          requirePositive: true
        }
      ),
    epsTrend:
      analystTrendView(
        evidence.eps,
        {
          requirePositive: true
        }
      ),
    marginTrend:
      analystTrendView(
        evidence.netProfitMargin
      ),
    balanceSheet:
      analystBalanceSheetView(
        evidence,
        fundamentals
      ),
    cashFlowQuality:
      analystCashFlowView(
        evidence,
        fundamentals
      ),
    earningsQuality:
      analystEarningsQualityView(
        evidence,
        fundamentals
      ),
    dividendSustainability:
      analystDividendView(
        evidence,
        fundamentals
      )
  };

  const overallFinancialView =
    analystOverallFinancialView(
      evidence,
      views,
      coveragePct
    );

  const missingCore =
    summaryKeys.filter(
      key =>
        !evidence[key]
          ?.available
    );

  const missingExtended =
    extendedKeys.filter(
      key =>
        !evidence[key]
          ?.available
    );

  const availableMetricCount =
    Object.values(
      evidence
    )
      .filter(
        item =>
          item?.available
      )
      .length;

  return {
    version:
      'FINANCIAL-ANALYST-0.9.0',
    mode:
      'SHADOW_ONLY',
    affectsDecision:
      false,
    status:
      coveragePct >= 80
        ? (
            extendedCoveragePct >= 67
              ? 'FULL_STATEMENT_READY'
              : 'PSX_SUMMARY_READY'
          )
        : availableMetricCount > 0
          ? 'PARTIAL_EVIDENCE'
          : 'DATA_BLOCKED',
    evidenceTier:
      coveragePct >= 80
        ? (
            extendedCoveragePct >= 67
              ? 'FULL_STATEMENT'
              : 'PSX_SUMMARY'
          )
        : 'PARTIAL',
    company: {
      symbol:
        fundamentals?.symbol ||
        null,
      name:
        fundamentals?.company?.name ||
        null,
      sector:
        fundamentals?.company?.sector ||
        null,
      financialSector:
        analystFinancialSector(
          fundamentals
        )
    },
    coverage: {
      // Keep coreCoveragePct for backwards compatibility with the current UI.
      // In 0.8.4B.1 it means PSX headline-summary coverage, not full-statement coverage.
      coreCoveragePct:
        coveragePct,
      summaryCoveragePct:
        coveragePct,
      extendedCoveragePct,
      coreMetricsObserved:
        observedCore,
      coreMetricsMissing:
        missingCore,
      extendedMetricsObserved:
        observedExtended,
      extendedMetricsMissing:
        missingExtended,
      availableMetricCount,
      totalMetricDefinitions:
        Object.keys(
          ANALYST_FINANCIAL_METRICS
        ).length,
      annualPeriods:
        fundamentals?.annual
          ?.periods ||
        [],
      quarterlyPeriods:
        fundamentals?.quarterly
          ?.periods ||
        [],
      ratioPeriods:
        fundamentals?.ratios
          ?.periods ||
        []
    },
    evidence,
    views,
    overallFinancialView,
    provenance: {
      source:
        fundamentals?.source ||
        null,
      sourceUrl:
        fundamentals?.sourceUrl ||
        null,
      retrievedAt:
        fundamentals?.fetchedAt ||
        null
    },
    limitations: [
      'This build only interprets financial rows that PSX already exposes through NOMAD\'s current company-page parser.',
      'Missing metrics remain missing; NOMAD does not infer zero values or manufacture financial evidence.',
      'Cash-flow, leverage and earnings-quality conclusions are limited when PSX does not expose matching rows.',
      'Sector-specific accounting models are not yet implemented in 0.8.4B.',
      'Headline and extended evidence are tracked separately. Missing extended statements reduce validation tier instead of being treated as negative evidence; the legacy score remains supporting evidence only.'
    ]
  };
}

async function getFundamentals(
  stockSymbol
) {
  const context =
    await resolveSymbolContext(
      stockSymbol
    );

  const symbol =
    context.canonicalSymbol;

  const [
    sectorMap,
    snapshotResult,
    quoteResult
  ] =
    await Promise.all([
      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      )
        .then(
          snapshot => ({
            value:
              snapshot,
            error:
              null
          })
        )
        .catch(
          error => ({
            value:
              null,
            error:
              String(
                error?.message ||
                'PSX company-page request failed.'
              )
          })
        ),

      fetchQuoteForSymbols([
        context.tradingSymbol,
        symbol
      ])
        .then(
          quote => ({
            value:
              quote,
            error:
              null
          })
        )
        .catch(
          error => ({
            value:
              null,
            error:
              String(
                error?.message ||
                'Quote request failed.'
              )
          })
        )
    ]);

  const snapshot =
    snapshotResult?.value ||
    null;

  const quote =
    quoteResult?.value ||
    null;

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

  const hasAnnual =
    Boolean(
      snapshot?.annual
    );

  const hasQuarterly =
    Boolean(
      snapshot?.quarterly
    );

  const hasRatios =
    Boolean(
      snapshot?.ratios
    );

  const structuredAvailable =
    Boolean(
      snapshot &&
      (
        hasAnnual ||
        hasQuarterly ||
        hasRatios
      )
    );

  let evidenceError =
    null;

  if (!snapshot) {
    evidenceError =
      snapshotResult?.error ||
      'PSX company page could not be loaded.';
  } else if (!structuredAvailable) {
    evidenceError =
      'PSX company page loaded, but no structured annual, quarterly or ratio table was parsed.';
  }

  const fundamentalsResult = {
    symbol,

    identity: {
      canonicalSymbol:
        symbol,

      tradingSymbol:
        context.tradingSymbol,

      rawMarketSymbol:
        context.rawMarketSymbol,

      statusCodes:
        uniqueStrings([
          ...context.statusCodes,
          ...(
            snapshot?.statusCodes ||
            []
          )
        ]),

      normalized:
        context.normalized
    },

    company: {
      name:
        snapshot?.companyName ||
        context.companyName ||
        symbol,

      sector:
        snapshot?.sectorName ||
        context.sector ||
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
      snapshot?.sourceUrl ||
      null,

    fetchedAt:
      snapshot?.fetchedAt ||
      new Date()
        .toISOString(),

    valuation: {
      peRatio:
        pe !==
          null &&
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
      snapshot?.annual ||
      null,

    quarterly:
      snapshot?.quarterly ||
      null,

    ratios:
      snapshot?.ratios ||
      null,

    available:
      structuredAvailable,

    evidenceError,

    diagnostics: {
      snapshotState:
        snapshot
          ? 'AVAILABLE'
          : 'UNAVAILABLE',
      snapshotError:
        snapshotResult?.error ||
        null,
      quoteState:
        quote
          ? 'AVAILABLE'
          : 'UNAVAILABLE',
      quoteError:
        quoteResult?.error ||
        null,
      structuredTables: {
        annual:
          hasAnnual,
        quarterly:
          hasQuarterly,
        ratios:
          hasRatios
      },
      pageIdentityValid:
        snapshot?.pageIdentityValid ===
          true,
      sourceFetchedAt:
        snapshot?.fetchedAt ||
        null
    }
  };

  fundamentalsResult.analystCore =
    buildFinancialAnalystCore(
      fundamentalsResult
    );

  return fundamentalsResult;
}

/* =========================================================
   EVENTS
========================================================= */

async function getEvents(
  stockSymbol
) {
  const context =
    await resolveSymbolContext(
      stockSymbol
    );

  const symbol =
    context.canonicalSymbol;

  const [
    sectorMap,
    snapshot
  ] =
    await Promise.all([
      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      )
    ]);

  return {
    symbol,

    identity: {
      canonicalSymbol:
        symbol,

      tradingSymbol:
        context.tradingSymbol,

      rawMarketSymbol:
        context.rawMarketSymbol,

      statusCodes:
        uniqueStrings([
          ...context.statusCodes,
          ...(
            snapshot?.statusCodes ||
            []
          )
        ]),

      normalized:
        context.normalized
    },

    company: {
      name:
        snapshot?.companyName ||
        context.companyName ||
        symbol,

      sector:
        snapshot?.sectorName ||
        context.sector ||
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
      snapshot?.sourceUrl ||
      null,

    fetchedAt:
      snapshot?.fetchedAt ||
      new Date()
        .toISOString(),

    events:
      snapshot?.announcements ||
      []
  };
}

/* =========================================================
   TECHNICAL ANALYSIS HELPERS
========================================================= */

function mean(values) {
  const valid =
    values.filter(
      value =>
        Number.isFinite(
          value
        )
    );

  if (
    !valid.length
  ) {
    return null;
  }

  return valid.reduce(
    (
      sum,
      value
    ) =>
      sum +
      value,
    0
  ) /
  valid.length;
}

function standardDeviation(
  values
) {
  const valid =
    values.filter(
      value =>
        Number.isFinite(
          value
        )
    );

  if (
    !valid.length
  ) {
    return null;
  }

  const average =
    mean(valid);

  const variance =
    valid.reduce(
      (
        sum,
        value
      ) =>
        sum +
        Math.pow(
          value -
          average,
          2
        ),
      0
    ) /
    valid.length;

  return Math.sqrt(
    variance
  );
}

function smaSeries(
  values,
  period
) {
  const output =
    Array(
      values.length
    ).fill(null);

  let rolling = 0;

  for (
    let index = 0;
    index < values.length;
    index++
  ) {
    rolling +=
      values[index];

    if (
      index >=
      period
    ) {
      rolling -=
        values[
          index -
          period
        ];
    }

    if (
      index >=
      period - 1
    ) {
      output[index] =
        rolling /
        period;
    }
  }

  return output;
}

function emaSeries(
  values,
  period
) {
  const output =
    Array(
      values.length
    ).fill(null);

  if (
    values.length <
    period
  ) {
    return output;
  }

  const seed =
    mean(
      values.slice(
        0,
        period
      )
    );

  if (
    seed === null
  ) {
    return output;
  }

  const multiplier =
    2 /
    (
      period +
      1
    );

  let previous =
    seed;

  output[
    period - 1
  ] =
    seed;

  for (
    let index =
      period;

    index <
      values.length;

    index++
  ) {
    previous =
      (
        values[index] -
        previous
      ) *
      multiplier +
      previous;

    output[index] =
      previous;
  }

  return output;
}

function rsiSeries(
  closes,
  period = 14
) {
  const output =
    Array(
      closes.length
    ).fill(null);

  if (
    closes.length <=
    period
  ) {
    return output;
  }

  let gainTotal = 0;
  let lossTotal = 0;

  for (
    let index = 1;
    index <= period;
    index++
  ) {
    const change =
      closes[index] -
      closes[
        index - 1
      ];

    gainTotal +=
      Math.max(
        change,
        0
      );

    lossTotal +=
      Math.max(
        -change,
        0
      );
  }

  let averageGain =
    gainTotal /
    period;

  let averageLoss =
    lossTotal /
    period;

  const calculate =
    () => {
      if (
        averageLoss === 0
      ) {
        return 100;
      }

      const rs =
        averageGain /
        averageLoss;

      return (
        100 -
        (
          100 /
          (
            1 +
            rs
          )
        )
      );
    };

  output[period] =
    calculate();

  for (
    let index =
      period + 1;

    index <
      closes.length;

    index++
  ) {
    const change =
      closes[index] -
      closes[
        index - 1
      ];

    const gain =
      Math.max(
        change,
        0
      );

    const loss =
      Math.max(
        -change,
        0
      );

    averageGain =
      (
        averageGain *
        (
          period -
          1
        ) +
        gain
      ) /
      period;

    averageLoss =
      (
        averageLoss *
        (
          period -
          1
        ) +
        loss
      ) /
      period;

    output[index] =
      calculate();
  }

  return output;
}

function atrSeries(
  rows,
  period = 14
) {
  const output =
    Array(
      rows.length
    ).fill(null);

  if (
    rows.length <
    period
  ) {
    return output;
  }

  const trueRanges =
    rows.map(
      (
        row,
        index
      ) => {
        if (
          index === 0
        ) {
          return (
            row.high -
            row.low
          );
        }

        const previousClose =
          rows[
            index - 1
          ].close;

        return Math.max(
          row.high -
          row.low,

          Math.abs(
            row.high -
            previousClose
          ),

          Math.abs(
            row.low -
            previousClose
          )
        );
      }
    );

  let previousATR =
    mean(
      trueRanges.slice(
        0,
        period
      )
    );

  output[
    period - 1
  ] =
    previousATR;

  for (
    let index =
      period;

    index <
      rows.length;

    index++
  ) {
    previousATR =
      (
        previousATR *
        (
          period -
          1
        ) +
        trueRanges[index]
      ) /
      period;

    output[index] =
      previousATR;
  }

  return output;
}

function macdSeries(
  closes
) {
  const ema12 =
    emaSeries(
      closes,
      12
    );

  const ema26 =
    emaSeries(
      closes,
      26
    );

  const macd =
    Array(
      closes.length
    ).fill(null);

  const validMacd = [];
  const validIndexes = [];

  for (
    let index = 0;
    index < closes.length;
    index++
  ) {
    if (
      ema12[index] !==
        null &&
      ema26[index] !==
        null
    ) {
      macd[index] =
        ema12[index] -
        ema26[index];

      validMacd.push(
        macd[index]
      );

      validIndexes.push(
        index
      );
    }
  }

  const validSignal =
    emaSeries(
      validMacd,
      9
    );

  const signal =
    Array(
      closes.length
    ).fill(null);

  const histogram =
    Array(
      closes.length
    ).fill(null);

  for (
    let index = 0;
    index < validIndexes.length;
    index++
  ) {
    const originalIndex =
      validIndexes[index];

    if (
      validSignal[index] !==
      null
    ) {
      signal[
        originalIndex
      ] =
        validSignal[index];

      histogram[
        originalIndex
      ] =
        macd[
          originalIndex
        ] -
        validSignal[index];
    }
  }

  return {
    ema12,
    ema26,
    macd,
    signal,
    histogram
  };
}

function getTrendLabel(
  close,
  sma20,
  sma50,
  sma200
) {
  if (
    [
      close,
      sma20,
      sma50,
      sma200
    ].every(
      value =>
        Number.isFinite(
          value
        )
    )
  ) {
    if (
      close >
        sma20 &&
      sma20 >
        sma50 &&
      sma50 >
        sma200
    ) {
      return 'Strong uptrend';
    }

    if (
      close <
        sma20 &&
      sma20 <
        sma50 &&
      sma50 <
        sma200
    ) {
      return 'Strong downtrend';
    }
  }

  if (
    Number.isFinite(
      sma20
    ) &&
    Number.isFinite(
      sma50
    )
  ) {
    if (
      close >
        sma20 &&
      sma20 >
        sma50
    ) {
      return 'Uptrend';
    }

    if (
      close <
        sma20 &&
      sma20 <
        sma50
    ) {
      return 'Downtrend';
    }
  }

  return 'Mixed / sideways';
}

function getRSILabel(rsi) {
  if (
    !Number.isFinite(
      rsi
    )
  ) {
    return 'Unavailable';
  }

  if (
    rsi >= 70
  ) {
    return 'Overbought zone';
  }

  if (
    rsi <= 30
  ) {
    return 'Oversold zone';
  }

  if (
    rsi >= 55
  ) {
    return 'Positive momentum';
  }

  if (
    rsi <= 45
  ) {
    return 'Negative momentum';
  }

  return 'Neutral momentum';
}

function getMACDLabel(
  macd,
  signal,
  histogram
) {
  if (
    ![
      macd,
      signal,
      histogram
    ].every(
      value =>
        Number.isFinite(
          value
        )
    )
  ) {
    return 'Unavailable';
  }

  if (
    macd >
      signal &&
    histogram > 0
  ) {
    return 'Positive momentum';
  }

  if (
    macd <
      signal &&
    histogram < 0
  ) {
    return 'Negative momentum';
  }

  return 'Neutral / crossover';
}

function getVolumeLabel(
  ratio
) {
  if (
    !Number.isFinite(
      ratio
    )
  ) {
    return 'Unavailable';
  }

  if (
    ratio >= 1.5
  ) {
    return 'High participation';
  }

  if (
    ratio <= 0.5
  ) {
    return 'Low participation';
  }

  return 'Normal participation';
}

/* =========================================================
   TECHNICAL ANALYSIS
========================================================= */

async function getTechnicalAnalysis(
  stockSymbol
) {
  const context =
    await resolveSymbolContext(
      stockSymbol
    );

  const symbol =
    context.canonicalSymbol;

  const now =
    new Date();

  const start =
    new Date(
      now.getTime() -
      3 *
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

  const end =
    now
      .toISOString()
      .slice(
        0,
        10
      );

  const [
    historyResult,
    sectorMap,
    snapshot
  ] =
    await Promise.all([
      fetchCanonicalHistory(
        symbol,
        start,
        end
      ),

      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      )
    ]);

  const normalized =
    normalizeHistoricalRows(
      historyResult.data ||
      []
    );

  const rows =
    normalized.cleaned;

  const identity = {
    canonicalSymbol:
      symbol,

    tradingSymbol:
      context.tradingSymbol,

    rawMarketSymbol:
      context.rawMarketSymbol,

    statusCodes:
      uniqueStrings([
        ...context.statusCodes,
        ...(
          snapshot?.statusCodes ||
          []
        )
      ]),

    normalized:
      context.normalized
  };

  const company = {
    name:
      snapshot?.companyName ||
      context.companyName ||
      symbol,

    sector:
      snapshot?.sectorName ||
      context.sector ||
      sectorMap.get(
        symbol
      ) ||
      ''
  };

  if (
    rows.length < 30
  ) {
    return {
      symbol,

      identity,

      company,

      available:
        false,

      reason:
        `At least 30 valid trading sessions are required for technical analysis. Canonical history lookup used ${symbol}.`,

      dataQuality: {
        canonicalSymbol:
          symbol,

        validSessions:
          rows.length,

        excludedAnomalies:
          normalized
            .anomalies
            .length
      }
    };
  }

  const closes =
    rows.map(
      row =>
        row.close
    );

  const volumes =
    rows.map(
      row =>
        row.volume ||
        0
    );

  const sma20 =
    smaSeries(
      closes,
      20
    );

  const sma50 =
    smaSeries(
      closes,
      50
    );

  const sma200 =
    smaSeries(
      closes,
      200
    );

  const rsi14 =
    rsiSeries(
      closes,
      14
    );

  const atr14 =
    atrSeries(
      rows,
      14
    );

  const macdResult =
    macdSeries(
      closes
    );

  const latestIndex =
    rows.length -
    1;

  const latest =
    rows[
      latestIndex
    ];

  const latestClose =
    latest.close;

  const latestSMA20 =
    sma20[
      latestIndex
    ];

  const latestSMA50 =
    sma50[
      latestIndex
    ];

  const latestSMA200 =
    sma200[
      latestIndex
    ];

  const latestEMA12 =
    macdResult
      .ema12[
        latestIndex
      ];

  const latestEMA26 =
    macdResult
      .ema26[
        latestIndex
      ];

  const latestMACD =
    macdResult
      .macd[
        latestIndex
      ];

  const latestSignal =
    macdResult
      .signal[
        latestIndex
      ];

  const latestHistogram =
    macdResult
      .histogram[
        latestIndex
      ];

  const latestRSI =
    rsi14[
      latestIndex
    ];

  const latestATR =
    atr14[
      latestIndex
    ];

  const atrPct =
    latestATR !==
      null &&
    latestClose >
      0
      ? (
          latestATR /
          latestClose
        ) *
        100
      : null;

  const recentVolume =
    volumes.slice(
      -20
    );

  const averageVolume20 =
    mean(
      recentVolume
    );

  const latestVolume =
    latest.volume ||
    0;

  const volumeRatio =
    averageVolume20 !==
      null &&
    averageVolume20 > 0
      ? latestVolume /
        averageVolume20
      : null;

  const returns20 = [];

  const returnRows =
    rows.slice(
      -21
    );

  for (
    let index = 1;
    index < returnRows.length;
    index++
  ) {
    const previous =
      returnRows[
        index - 1
      ].close;

    const current =
      returnRows[
        index
      ].close;

    if (
      previous > 0 &&
      current > 0
    ) {
      returns20.push(
        Math.log(
          current /
          previous
        )
      );
    }
  }

  const dailyVolatility =
    standardDeviation(
      returns20
    );

  const annualizedVolatilityPct =
    dailyVolatility !==
      null
      ? dailyVolatility *
        Math.sqrt(
          252
        ) *
        100
      : null;

  const recent20 =
    rows.slice(
      -20
    );

  const support =
    recent20.length
      ? Math.min(
          ...recent20.map(
            row =>
              row.low
          )
        )
      : null;

  const resistance =
    recent20.length
      ? Math.max(
          ...recent20.map(
            row =>
              row.high
          )
        )
      : null;

  const distanceToSupportPct =
    support !==
      null &&
    support > 0
      ? (
          (
            latestClose -
            support
          ) /
          support
        ) *
        100
      : null;

  const distanceToResistancePct =
    resistance !==
      null &&
    latestClose > 0
      ? (
          (
            resistance -
            latestClose
          ) /
          latestClose
        ) *
        100
      : null;

  const momentum20Pct =
    rows.length >
      20
      ? (
          (
            latestClose -
            rows[
              rows.length -
              21
            ].close
          ) /
          rows[
            rows.length -
            21
          ].close
        ) *
        100
      : null;

  const last252 =
    rows.slice(
      -252
    );

  const high52 =
    last252.length
      ? Math.max(
          ...last252.map(
            row =>
              row.high
          )
        )
      : null;

  const low52 =
    last252.length
      ? Math.min(
          ...last252.map(
            row =>
              row.low
          )
        )
      : null;

  const trendLabel =
    getTrendLabel(
      latestClose,
      latestSMA20,
      latestSMA50,
      latestSMA200
    );

  const rsiLabel =
    getRSILabel(
      latestRSI
    );

  const macdLabel =
    getMACDLabel(
      latestMACD,
      latestSignal,
      latestHistogram
    );

  const volumeLabel =
    getVolumeLabel(
      volumeRatio
    );

  const priceAction =
    buildProfessionalPriceAction(
      rows,
      {
        price: latestClose,
        sma20: latestSMA20,
        sma50: latestSMA50,
        sma200: latestSMA200,
        rsi14: latestRSI,
        macdHistogram: latestHistogram,
        volumeRatio20d: volumeRatio,
        return1m: momentum20Pct
      }
    );

  const chartRows =
    rows.slice(
      -260
    );

  const offset =
    rows.length -
    chartRows.length;

  const chartData =
    chartRows.map(
      (
        row,
        index
      ) => {
        const originalIndex =
          index +
          offset;

        return {
          date:
            row.date,

          close:
            row.close,

          volume:
            row.volume,

          sma20:
            sma20[
              originalIndex
            ],

          sma50:
            sma50[
              originalIndex
            ],

          sma200:
            sma200[
              originalIndex
            ]
        };
      }
    );

  return {
    symbol,

    identity,

    company,

    available:
      true,

    asOf:
      latest.date,

    price:
      latestClose,

    trend: {
      label:
        trendLabel,

      sma20:
        latestSMA20,

      sma50:
        latestSMA50,

      sma200:
        latestSMA200,

      ema12:
        latestEMA12,

      ema26:
        latestEMA26
    },

    momentum: {
      rsi14:
        latestRSI,

      rsiLabel,

      macd:
        latestMACD,

      macdSignal:
        latestSignal,

      macdHistogram:
        latestHistogram,

      macdLabel,

      momentum20Pct
    },

    risk: {
      atr14:
        latestATR,

      atrPct,

      annualizedVolatility20dPct:
        annualizedVolatilityPct
    },

    volume: {
      latest:
        latestVolume,

      average20:
        averageVolume20,

      ratio:
        volumeRatio,

      label:
        volumeLabel
    },

    levels: {
      support20:
        support,

      resistance20:
        resistance,

      distanceToSupportPct,

      distanceToResistancePct,

      high52,

      low52
    },

    priceAction,

    dataQuality: {
      canonicalSymbol:
        symbol,

      tradingSymbol:
        context.tradingSymbol,

      validSessions:
        rows.length,

      excludedAnomalies:
        normalized
          .anomalies
          .length,

      latestDate:
        latest.date,

      source:
        'psxdata-api'
    },

    chartData,

    disclaimer:
      'Technical analysis is descriptive market analysis only. It is not a Buy, Sell or Hold recommendation.'
  };
}


/* =========================================================
   CONTINUOUS INTELLIGENCE MEMORY - BUILD 0.8.0
========================================================= */

function continuousMemoryConfigured() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_SECRET_KEY
  );
}

async function supabaseRest(
  resource,
  options = {}
) {
  if (
    !continuousMemoryConfigured()
  ) {
    bad(
      'Supabase continuous-intelligence memory is not configured.',
      503
    );
  }

  const method =
    String(
      options.method ||
      'GET'
    ).toUpperCase();

  const headers = {
    apikey:
      SUPABASE_SECRET_KEY,

    Accept:
      'application/json',

    'User-Agent':
      'NOMAD-Invest-Server/0.8.5A'
  };

  if (
    options.body !== undefined &&
    options.body !== null
  ) {
    headers['Content-Type'] =
      'application/json';
  }

  if (
    options.prefer
  ) {
    headers.Prefer =
      options.prefer;
  }

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${resource}`,
      {
        method,
        headers,
        body:
          options.body !== undefined &&
          options.body !== null
            ? JSON.stringify(
                options.body
              )
            : undefined,
        signal:
          AbortSignal.timeout(
            options.timeout ||
            20000
          )
      }
    );

  const raw =
    await response.text();

  let payload = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    const detail =
      payload?.message ||
      payload?.details ||
      payload?.hint ||
      (
        typeof payload === 'string'
          ? payload
          : ''
      );

    bad(
      'Supabase request failed with HTTP ' +
      response.status +
      (
        detail
          ? ': ' + String(detail)
          : ''
      ),
      502
    );
  }

  return payload;
}

async function readSecurityMemory(symbol) {
  const rows =
    await supabaseRest(
      'security_state?symbol=eq.' +
      encodeURIComponent(symbol) +
      '&select=*'
    );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

async function createIntelligenceRun(
  metadata = {},
  runType = 'manual'
) {
  const rows =
    await supabaseRest(
      'intelligence_runs?select=id,started_at',
      {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          run_type: runType,
          status: 'running',
          universe_version:
            PSX_UNIVERSE_MASTER.masterVersion,
          metadata
        }
      }
    );

  if (!Array.isArray(rows) || !rows[0]?.id) {
    bad(
      'Supabase did not return an intelligence-run ID.',
      502
    );
  }

  return rows[0];
}

async function finishIntelligenceRun(
  runId,
  update
) {
  if (!runId) {
    return;
  }

  await supabaseRest(
    'intelligence_runs?id=eq.' +
    encodeURIComponent(runId),
    {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        ...update,
        completed_at:
          new Date().toISOString()
      }
    }
  );
}

function roundMemoryNumber(
  value,
  digits = 4
) {
  const number = safeNumber(value);

  if (number === null) {
    return null;
  }

  const factor = 10 ** digits;

  return Math.round(number * factor) / factor;
}

function technicalPosition(
  price,
  movingAverage
) {
  const current = safeNumber(price);
  const average = safeNumber(movingAverage);

  if (current === null || average === null) {
    return null;
  }

  if (Math.abs(current - average) < 0.000001) {
    return 'AT';
  }

  return current > average
    ? 'ABOVE'
    : 'BELOW';
}

function buildMemoryState(
  marketRow,
  technical
) {
  const symbol =
    normalizeSymbol(
      marketRow?.symbol
    );

  const master =
    getUniverseMasterEntry(
      symbol
    );

  const technicalAvailable =
    Boolean(
      technical?.available
    );

  const price =
    safeNumber(
      marketRow?.price
    ) ??
    safeNumber(
      technical?.price
    );

  const technicalState =
    technicalAvailable
      ? {
          asOf:
            technical.asOf || null,
          trend:
            technical.trend?.label || null,
          rsi14:
            roundMemoryNumber(
              technical.momentum?.rsi14,
              2
            ),
          rsiLabel:
            technical.momentum?.rsiLabel || null,
          macd:
            roundMemoryNumber(
              technical.momentum?.macd,
              4
            ),
          macdSignal:
            roundMemoryNumber(
              technical.momentum?.macdSignal,
              4
            ),
          momentum20Pct:
            roundMemoryNumber(
              technical.momentum?.momentum20Pct,
              2
            ),
          annualizedVolatility20dPct:
            roundMemoryNumber(
              technical.risk?.annualizedVolatility20dPct,
              2
            ),
          atrPct:
            roundMemoryNumber(
              technical.risk?.atrPct,
              2
            ),
          volumeRatio20d:
            roundMemoryNumber(
              technical.volume?.ratio,
              2
            ),
          sma20:
            roundMemoryNumber(
              technical.trend?.sma20,
              2
            ),
          sma50:
            roundMemoryNumber(
              technical.trend?.sma50,
              2
            ),
          sma200:
            roundMemoryNumber(
              technical.trend?.sma200,
              2
            ),
          priceVsSma20:
            technicalPosition(
              price,
              technical.trend?.sma20
            ),
          priceVsSma50:
            technicalPosition(
              price,
              technical.trend?.sma50
            ),
          priceVsSma200:
            technicalPosition(
              price,
              technical.trend?.sma200
            ),
          support20:
            roundMemoryNumber(
              technical.levels?.support20,
              2
            ),
          resistance20:
            roundMemoryNumber(
              technical.levels?.resistance20,
              2
            ),
          validSessions:
            technical.dataQuality?.validSessions ?? null,
          excludedAnomalies:
            technical.dataQuality?.excludedAnomalies ?? null
        }
      : {
          available: false
        };

  const marketState = {
    asOf:
      marketRow?.asOf || null,
    price:
      roundMemoryNumber(
        price,
        4
      ),
    peRatio:
      roundMemoryNumber(
        marketRow?.peRatio,
        4
      ),
    dividendYield:
      roundMemoryNumber(
        marketRow?.dividendYield,
        4
      ),
    averageVolume30d:
      roundMemoryNumber(
        marketRow?.averageVolume30d,
        2
      ),
    change1yPct:
      roundMemoryNumber(
        marketRow?.change1yPct,
        2
      ),
    statusCodes:
      Array.isArray(
        marketRow?.statusCodes
      )
        ? marketRow.statusCodes
        : []
  };

  const currentView =
    technicalAvailable
      ? (
          technical.trend?.label ||
          'Technical state available'
        )
      : 'Technical state unavailable';

  const currentViewReason =
    technicalAvailable
      ? (
          'Price is ' +
          String(
            technicalState.priceVsSma50 ||
            'not comparable with'
          ) +
          ' SMA50; RSI(14) is ' +
          (
            technicalState.rsi14 ??
            'N/A'
          ) +
          '.'
        )
      : 'NOMAD saved the market state, but technical history was not available for this observation.';

  const hashPayload = {
    symbol,
    marketState,
    technicalState,
    currentView
  };

  const stateHash =
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify(hashPayload)
      )
      .digest('hex');

  return {
    symbol,
    company_name:
      master?.companyName ||
      marketRow?.companyName ||
      symbol,
    sector:
      master?.sector ||
      marketRow?.sector ||
      null,
    universe_class:
      master?.universeClass ||
      marketRow?.universeClass ||
      null,
    eligibility:
      master?.recommendationEligible === true
        ? 'RECOMMENDATION_ELIGIBLE'
        : 'NOT_RECOMMENDATION_ELIGIBLE',
    market_price:
      roundMemoryNumber(
        price,
        4
      ),
    market_change_pct: null,
    volume: null,
    volume_ratio_20d:
      technicalAvailable
        ? technicalState.volumeRatio20d
        : null,
    technical_score: null,
    fundamental_score: null,
    risk_score: null,
    overall_score: null,
    technical_state:
      technicalState,
    fundamental_state: {},
    risk_state: {},
    market_state:
      marketState,
    current_view:
      currentView,
    current_view_reason:
      currentViewReason,
    data_quality_score:
      technicalAvailable
        ? 100
        : 60,
    source_timestamp:
      marketRow?.asOf ||
      technical?.asOf ||
      null,
    state_hash:
      stateHash,
    evaluated_at:
      new Date().toISOString()
  };
}

function memoryChangeSignificance(
  percentageChange
) {
  const absolute =
    Math.abs(
      safeNumber(
        percentageChange
      ) || 0
    );

  if (absolute >= 5) {
    return 'high';
  }

  if (absolute >= 2) {
    return 'medium';
  }

  return 'low';
}

function appendMemoryChange(
  changes,
  fieldName,
  oldValue,
  newValue,
  options = {}
) {
  if (
    oldValue === undefined ||
    oldValue === null ||
    newValue === undefined ||
    newValue === null
  ) {
    return;
  }

  if (String(oldValue) === String(newValue)) {
    return;
  }

  const oldNumber = safeNumber(oldValue);
  const newNumber = safeNumber(newValue);

  const absoluteChange =
    oldNumber !== null &&
    newNumber !== null
      ? newNumber - oldNumber
      : null;

  const percentageChange =
    oldNumber !== null &&
    newNumber !== null &&
    oldNumber !== 0
      ? (
          absoluteChange /
          Math.abs(oldNumber)
        ) * 100
      : null;

  changes.push({
    change_category:
      options.category || 'state',
    field_name:
      fieldName,
    old_value: {
      value: oldValue
    },
    new_value: {
      value: newValue
    },
    absolute_change:
      roundMemoryNumber(
        absoluteChange,
        6
      ),
    percentage_change:
      roundMemoryNumber(
        percentageChange,
        4
      ),
    significance:
      options.significance ||
      memoryChangeSignificance(
        percentageChange
      ),
    summary:
      options.summary ||
      (
        fieldName +
        ' changed from ' +
        String(oldValue) +
        ' to ' +
        String(newValue) +
        '.'
      ),
    evidence: {
      source:
        options.source ||
        'NOMAD state comparison'
    }
  });
}

function detectMemoryChanges(
  previous,
  current
) {
  if (!previous) {
    return [];
  }

  const changes = [];

  appendMemoryChange(
    changes,
    'market_price',
    previous.market_price,
    current.market_price,
    {
      category: 'market',
      source: 'psxdata-api'
    }
  );

  const previousTechnical =
    previous.technical_state || {};

  const currentTechnical =
    current.technical_state || {};

  appendMemoryChange(
    changes,
    'technical_trend',
    previousTechnical.trend,
    currentTechnical.trend,
    {
      category: 'technical',
      significance: 'medium',
      summary:
        'Technical trend changed from ' +
        String(previousTechnical.trend) +
        ' to ' +
        String(currentTechnical.trend) +
        '.'
    }
  );

  appendMemoryChange(
    changes,
    'rsi14',
    previousTechnical.rsi14,
    currentTechnical.rsi14,
    {
      category: 'technical',
      source: 'deterministic technical engine'
    }
  );

  for (
    const field of [
      'priceVsSma20',
      'priceVsSma50',
      'priceVsSma200'
    ]
  ) {
    appendMemoryChange(
      changes,
      field,
      previousTechnical[field],
      currentTechnical[field],
      {
        category: 'technical',
        significance: 'medium',
        summary:
          field +
          ' changed from ' +
          String(previousTechnical[field]) +
          ' to ' +
          String(currentTechnical[field]) +
          '.'
      }
    );
  }

  appendMemoryChange(
    changes,
    'volume_ratio_20d',
    previousTechnical.volumeRatio20d,
    currentTechnical.volumeRatio20d,
    {
      category: 'market',
      source: 'deterministic technical engine'
    }
  );

  return changes;
}

async function upsertSecurityMemory(
  state,
  runId
) {
  const rows =
    await supabaseRest(
      'security_state?on_conflict=symbol&select=*',
      {
        method: 'POST',
        prefer:
          'resolution=merge-duplicates,return=representation',
        body: {
          ...state,
          last_run_id: runId
        }
      }
    );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

async function saveStateChanges(
  symbol,
  runId,
  changes
) {
  if (!Array.isArray(changes) || !changes.length) {
    return [];
  }

  const rows =
    changes.map(
      change => ({
        run_id: runId,
        symbol,
        ...change
      })
    );

  const result =
    await supabaseRest(
      'state_changes?select=id,field_name,significance,summary,detected_at',
      {
        method: 'POST',
        prefer: 'return=representation',
        body: rows
      }
    );

  return Array.isArray(result)
    ? result
    : [];
}

async function runContinuousMemoryTest(
  stockSymbol
) {
  const symbol =
    normalizeSymbol(
      stockSymbol || 'HBL'
    );

  if (!symbol) {
    bad('Enter a PSX symbol.');
  }

  const master =
    getUniverseMasterEntry(symbol);

  if (!master) {
    bad(
      'Symbol is not present in the canonical NOMAD universe.',
      404
    );
  }

  const run =
    await createIntelligenceRun({
      test: 'PERSISTENT_SECURITY_STATE',
      symbol,
      build: VERSION
    });

  try {
    const previous =
      await readSecurityMemory(symbol);

    const [market, technical] =
      await Promise.all([
        loadPSXMarket(),
        getTechnicalAnalysis(symbol).catch(
          error => ({
            available: false,
            message:
              error.message ||
              'Technical analysis unavailable.'
          })
        )
      ]);

    const marketRow =
      market.stocks.find(
        row =>
          normalizeSymbol(row.symbol) === symbol
      );

    if (!marketRow) {
      bad(
        'Current market row is unavailable for ' +
        symbol +
        '.',
        502
      );
    }

    const current =
      buildMemoryState(
        marketRow,
        technical
      );

    const changes =
      detectMemoryChanges(
        previous,
        current
      );

    const savedChanges =
      await saveStateChanges(
        symbol,
        run.id,
        changes
      );

    const savedState =
      await upsertSecurityMemory(
        current,
        run.id
      );

    await finishIntelligenceRun(
      run.id,
      {
        status: 'completed',
        securities_processed: 1,
        changes_detected: changes.length,
        signals_generated: 0,
        alerts_generated: 0,
        predictions_generated: 0
      }
    );

    return {
      status: 'OK',
      memoryConfigured: true,
      symbol,
      companyName:
        master.companyName ||
        marketRow.companyName ||
        symbol,
      universeClass:
        master.universeClass || null,
      runId:
        run.id,
      firstObservation:
        !previous,
      previousStateFound:
        Boolean(previous),
      previousEvaluatedAt:
        previous?.evaluated_at || null,
      previousStateHash:
        previous?.state_hash || null,
      currentEvaluatedAt:
        savedState?.evaluated_at ||
        current.evaluated_at,
      currentStateHash:
        savedState?.state_hash ||
        current.state_hash,
      sameStateHash:
        Boolean(
          previous?.state_hash &&
          previous.state_hash === current.state_hash
        ),
      changesDetected:
        changes.length,
      changes:
        savedChanges,
      current: {
        price:
          current.market_price,
        view:
          current.current_view,
        viewReason:
          current.current_view_reason,
        technical:
          current.technical_state,
        market:
          current.market_state
      },
      proof:
        previous
          ? 'NOMAD read the previously stored state before saving the new observation.'
          : 'This was the first stored observation for this symbol. Run the same test again to prove retrieval of the previous state.'
    };
  } catch (error) {
    await finishIntelligenceRun(
      run.id,
      {
        status: 'failed',
        error_message:
          String(
            error.message ||
            'Memory test failed.'
          ).slice(0, 1000)
      }
    ).catch(() => {});

    throw error;
  }
}


/* =========================================================
   PORTFOLIO + HISTORICAL SITUATION CONTEXT - BUILD 0.8.3
========================================================= */

function sessionReturn(
  rows,
  sessions,
  currentPrice = null
) {
  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  const latest =
    safeNumber(currentPrice) ??
    safeNumber(
      rows[rows.length - 1]?.close
    );

  const index =
    Math.max(
      0,
      rows.length - 1 - sessions
    );

  const base =
    safeNumber(
      rows[index]?.close
    );

  if (
    latest === null ||
    base === null ||
    base === 0
  ) {
    return null;
  }

  return (
    (
      latest -
      base
    ) /
    Math.abs(base)
  ) * 100;
}

function simpleAverageClose(
  rows,
  sessions
) {
  if (
    !Array.isArray(rows) ||
    rows.length < sessions
  ) {
    return null;
  }

  const values =
    rows
      .slice(-sessions)
      .map(
        row =>
          safeNumber(
            row.close
          )
      )
      .filter(
        value =>
          value !== null
      );

  if (values.length < sessions) {
    return null;
  }

  return values.reduce(
    (
      sum,
      value
    ) =>
      sum + value,
    0
  ) / values.length;
}

function historicalConditionLabel(
  return1m,
  trend
) {
  const oneMonth =
    safeNumber(
      return1m
    );

  if (
    oneMonth !== null &&
    oneMonth <= -8
  ) {
    return 'Weak';
  }

  if (
    oneMonth !== null &&
    oneMonth >= 8
  ) {
    return 'Strong';
  }

  if (
    trend === 'Downtrend'
  ) {
    return 'Soft';
  }

  if (
    trend === 'Uptrend'
  ) {
    return 'Positive';
  }

  return 'Mixed';
}


/* =========================================================
   PROFESSIONAL PRICE-ACTION + TRADER TIMING ENGINE - BUILD 0.9.1
   Candlesticks are contextual evidence, never standalone buy signals.
========================================================= */

function professionalCandleSnapshot(row) {
  if (!row) {
    return null;
  }

  const open = safeNumber(row.open);
  const high = safeNumber(row.high);
  const low = safeNumber(row.low);
  const close = safeNumber(row.close);
  const volume = safeNumber(row.volume);

  if (
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    high < low
  ) {
    return null;
  }

  const range = Math.max(0, high - low);
  const body = Math.abs(close - open);
  const upperWick = Math.max(0, high - Math.max(open, close));
  const lowerWick = Math.max(0, Math.min(open, close) - low);

  return {
    date: row.date || null,
    open,
    high,
    low,
    close,
    volume,
    range,
    body,
    bodyPctOfRange:
      range > 0
        ? body / range * 100
        : 0,
    upperWick,
    lowerWick,
    direction:
      close > open
        ? 'BULLISH'
        : close < open
          ? 'BEARISH'
          : 'FLAT'
  };
}

function professionalCandlestickPattern(rows) {
  const clean =
    (Array.isArray(rows) ? rows : [])
      .map(professionalCandleSnapshot)
      .filter(Boolean);

  if (!clean.length) {
    return {
      name: 'UNAVAILABLE',
      polarity: 'NEUTRAL',
      confidence: 'LOW',
      explanation: 'Not enough valid OHLC data for candlestick analysis.'
    };
  }

  const current = clean[clean.length - 1];
  const previous = clean.length >= 2
    ? clean[clean.length - 2]
    : null;

  const tinyBody =
    current.range > 0 &&
    current.bodyPctOfRange <= 10;

  if (tinyBody) {
    return {
      name: 'DOJI',
      polarity: 'NEUTRAL',
      confidence: 'MEDIUM',
      explanation: 'The latest candle shows indecision; context and confirmation matter more than the candle alone.'
    };
  }

  if (
    previous &&
    previous.direction === 'BEARISH' &&
    current.direction === 'BULLISH' &&
    current.open <= previous.close &&
    current.close >= previous.open
  ) {
    return {
      name: 'BULLISH_ENGULFING',
      polarity: 'BULLISH',
      confidence: 'MEDIUM',
      explanation: 'The latest bullish body engulfs the prior bearish body. It is meaningful only when aligned with support, trend and volume.'
    };
  }

  if (
    previous &&
    previous.direction === 'BULLISH' &&
    current.direction === 'BEARISH' &&
    current.open >= previous.close &&
    current.close <= previous.open
  ) {
    return {
      name: 'BEARISH_ENGULFING',
      polarity: 'BEARISH',
      confidence: 'MEDIUM',
      explanation: 'The latest bearish body engulfs the prior bullish body. Confirmation from structure and volume is required.'
    };
  }

  if (
    current.range > 0 &&
    current.lowerWick >= Math.max(current.body * 2, current.range * 0.45) &&
    current.upperWick <= Math.max(current.body, current.range * 0.20)
  ) {
    return {
      name: 'HAMMER_LIKE',
      polarity: 'BULLISH',
      confidence: 'LOW',
      explanation: 'The latest candle rejected lower prices. NOMAD treats this only as supporting evidence near a valid support zone.'
    };
  }

  if (
    current.range > 0 &&
    current.upperWick >= Math.max(current.body * 2, current.range * 0.45) &&
    current.lowerWick <= Math.max(current.body, current.range * 0.20)
  ) {
    return {
      name: 'SHOOTING_STAR_LIKE',
      polarity: 'BEARISH',
      confidence: 'LOW',
      explanation: 'The latest candle rejected higher prices. NOMAD treats this only as supporting evidence near resistance or after an extended rise.'
    };
  }

  return {
    name:
      current.direction === 'BULLISH'
        ? 'BULLISH_CANDLE'
        : current.direction === 'BEARISH'
          ? 'BEARISH_CANDLE'
          : 'NEUTRAL_CANDLE',
    polarity:
      current.direction === 'BULLISH'
        ? 'BULLISH'
        : current.direction === 'BEARISH'
          ? 'BEARISH'
          : 'NEUTRAL',
    confidence: 'LOW',
    explanation: 'No high-information reversal candle was detected. NOMAD relies on the broader price structure.'
  };
}

function professionalSwingPoints(rows, radius = 2) {
  const list = Array.isArray(rows) ? rows : [];
  const highs = [];
  const lows = [];

  for (
    let index = radius;
    index < list.length - radius;
    index++
  ) {
    const currentHigh = safeNumber(list[index]?.high);
    const currentLow = safeNumber(list[index]?.low);

    if (currentHigh !== null) {
      let isHigh = true;
      for (let offset = 1; offset <= radius; offset++) {
        const left = safeNumber(list[index - offset]?.high);
        const right = safeNumber(list[index + offset]?.high);
        if (
          left === null ||
          right === null ||
          currentHigh < left ||
          currentHigh < right
        ) {
          isHigh = false;
          break;
        }
      }
      if (isHigh) {
        highs.push({
          index,
          date: list[index]?.date || null,
          value: currentHigh
        });
      }
    }

    if (currentLow !== null) {
      let isLow = true;
      for (let offset = 1; offset <= radius; offset++) {
        const left = safeNumber(list[index - offset]?.low);
        const right = safeNumber(list[index + offset]?.low);
        if (
          left === null ||
          right === null ||
          currentLow > left ||
          currentLow > right
        ) {
          isLow = false;
          break;
        }
      }
      if (isLow) {
        lows.push({
          index,
          date: list[index]?.date || null,
          value: currentLow
        });
      }
    }
  }

  return { highs, lows };
}

function professionalTrendStructure(swings) {
  const highs = swings?.highs || [];
  const lows = swings?.lows || [];

  const highA = highs.length >= 2 ? highs[highs.length - 2] : null;
  const highB = highs.length >= 1 ? highs[highs.length - 1] : null;
  const lowA = lows.length >= 2 ? lows[lows.length - 2] : null;
  const lowB = lows.length >= 1 ? lows[lows.length - 1] : null;

  if (highA && highB && lowA && lowB) {
    if (
      highB.value > highA.value &&
      lowB.value > lowA.value
    ) {
      return {
        state: 'HIGHER_HIGHS_HIGHER_LOWS',
        bias: 'BULLISH',
        description: 'Recent swing highs and swing lows are both rising.'
      };
    }

    if (
      highB.value < highA.value &&
      lowB.value < lowA.value
    ) {
      return {
        state: 'LOWER_HIGHS_LOWER_LOWS',
        bias: 'BEARISH',
        description: 'Recent swing highs and swing lows are both falling.'
      };
    }
  }

  return {
    state: 'MIXED_STRUCTURE',
    bias: 'NEUTRAL',
    description: 'Recent swing structure is mixed or insufficiently developed.'
  };
}

function professionalNearestLevels(price, swings, fallbackSupport, fallbackResistance) {
  const current = safeNumber(price);
  if (current === null || current <= 0) {
    return {
      support: safeNumber(fallbackSupport),
      resistance: safeNumber(fallbackResistance)
    };
  }

  const supportCandidates =
    (swings?.lows || [])
      .map(item => safeNumber(item.value))
      .filter(value => value !== null && value < current)
      .sort((a, b) => b - a);

  const resistanceCandidates =
    (swings?.highs || [])
      .map(item => safeNumber(item.value))
      .filter(value => value !== null && value > current)
      .sort((a, b) => a - b);

  return {
    support:
      supportCandidates[0] ??
      safeNumber(fallbackSupport),
    resistance:
      resistanceCandidates[0] ??
      safeNumber(fallbackResistance)
  };
}

function buildProfessionalTradePlan(
  setup,
  metrics = {}
) {
  const price = safeNumber(metrics.price);
  const atr = safeNumber(metrics.atr14);
  const support = safeNumber(metrics.support);
  const resistance = safeNumber(metrics.resistance);
  const breakoutLevel = safeNumber(metrics.breakoutLevel);
  const sma20 = safeNumber(metrics.sma20);
  const sma50 = safeNumber(metrics.sma50);

  if (
    price === null ||
    price <= 0 ||
    atr === null ||
    atr <= 0
  ) {
    return {
      complete: false,
      state: 'INCOMPLETE',
      reason: 'A current price and valid ATR are required to define a professional trade plan.'
    };
  }

  if (
    setup === 'BREAKDOWN' ||
    setup === 'DOWNTREND' ||
    setup === 'NO_CLEAR_SETUP'
  ) {
    return {
      complete: false,
      state: 'NO_LONG_SETUP',
      reason: 'No professional long trade plan is created while price structure is bearish or lacks a clear setup.'
    };
  }

  let entryLow = null;
  let entryHigh = null;
  let stop = null;
  let invalidation = null;
  let planStyle = null;

  if (
    setup === 'CONFIRMED_BREAKOUT' ||
    setup === 'UNCONFIRMED_BREAKOUT'
  ) {
    const trigger = breakoutLevel !== null
      ? breakoutLevel
      : price;

    entryLow = Math.max(
      trigger,
      price - atr * 0.15
    );
    entryHigh = Math.max(
      price,
      trigger
    ) + atr * 0.35;

    const structuralStop =
      support !== null && support < entryLow
        ? support - atr * 0.15
        : null;

    const breakoutStop =
      trigger - atr * 1.0;

    stop =
      structuralStop !== null &&
      structuralStop > breakoutStop
        ? structuralStop
        : breakoutStop;

    invalidation =
      'Breakout thesis fails if price closes back below the breakout/stop zone.';
    planStyle =
      setup === 'CONFIRMED_BREAKOUT'
        ? 'BREAKOUT_ENTRY'
        : 'CONDITIONAL_BREAKOUT_ENTRY';
  } else if (setup === 'TREND_PULLBACK') {
    const movingAverageAnchor =
      [sma20, sma50]
        .filter(
          value =>
            value !== null &&
            value > 0 &&
            value <= price * 1.04
        )
        .sort((a, b) => b - a)[0] ||
      null;

    const anchor =
      movingAverageAnchor !== null
        ? movingAverageAnchor
        : price;

    entryLow = Math.min(
      price,
      anchor
    ) - atr * 0.15;
    entryHigh = price + atr * 0.20;

    stop =
      support !== null && support < entryLow
        ? support - atr * 0.30
        : entryLow - atr * 1.20;

    invalidation =
      'Pullback thesis fails if price loses the defined support/stop zone.';
    planStyle = 'PULLBACK_ENTRY';
  } else if (setup === 'UPTREND_CONTINUATION') {
    entryLow = price - atr * 0.25;
    entryHigh = price + atr * 0.20;
    stop =
      support !== null && support < entryLow
        ? support - atr * 0.25
        : entryLow - atr * 1.25;
    invalidation =
      'Continuation thesis fails if price breaks the defined support/stop zone.';
    planStyle = 'CONTINUATION_ENTRY';
  }

  if (
    entryLow === null ||
    entryHigh === null ||
    stop === null ||
    !(stop < entryLow)
  ) {
    return {
      complete: false,
      state: 'INCOMPLETE',
      reason: 'NOMAD could not define a coherent entry and invalidation level from the current structure.'
    };
  }

  const entryReference =
    (entryLow + entryHigh) / 2;

  const riskPerShare =
    entryReference - stop;

  if (
    !Number.isFinite(riskPerShare) ||
    riskPerShare <= 0
  ) {
    return {
      complete: false,
      state: 'INCOMPLETE',
      reason: 'The calculated stop does not create a valid positive per-share risk.'
    };
  }

  let target1 =
    resistance !== null &&
    resistance > entryReference
      ? resistance
      : null;

  let targetSource =
    target1 !== null
      ? 'STRUCTURAL_RESISTANCE'
      : null;

  // A confirmed breakout may legitimately have no nearby overhead swing level.
  // In that case NOMAD may display a 2R planning objective, but labels it as a
  // risk-multiple projection rather than pretending it is observed resistance.
  if (
    target1 === null &&
    setup === 'CONFIRMED_BREAKOUT'
  ) {
    target1 =
      entryReference +
      riskPerShare * 2;
    targetSource = 'R_MULTIPLE_PROJECTION';
  }

  const rewardRisk =
    target1 !== null &&
    target1 > entryReference
      ? (target1 - entryReference) /
        riskPerShare
      : null;

  const target2 =
    target1 !== null &&
    rewardRisk !== null &&
    rewardRisk >= DECISION_TRADER_MIN_REWARD_RISK
      ? Math.max(
          target1 + atr,
          entryReference +
            riskPerShare * 2.5
        )
      : null;

  return {
    complete:
      rewardRisk !== null,
    state:
      rewardRisk === null
        ? 'TARGET_UNRESOLVED'
        : rewardRisk >= DECISION_TRADER_MIN_REWARD_RISK
          ? 'DEFINED'
          : 'POOR_REWARD_RISK',
    style: planStyle,
    entryLow:
      decisionRound(entryLow, 4),
    entryHigh:
      decisionRound(entryHigh, 4),
    entryReference:
      decisionRound(entryReference, 4),
    stop:
      decisionRound(stop, 4),
    invalidation,
    target1:
      decisionRound(target1, 4),
    target2:
      decisionRound(target2, 4),
    targetSource,
    riskPerShare:
      decisionRound(riskPerShare, 4),
    riskPct:
      decisionRound(
        entryReference > 0
          ? riskPerShare /
            entryReference *
            100
          : null,
        2
      ),
    rewardRisk:
      decisionRound(rewardRisk, 2),
    reason:
      rewardRisk === null
        ? 'No defensible target is currently available, so the setup is incomplete.'
        : rewardRisk < DECISION_TRADER_MIN_REWARD_RISK
          ? 'The defined setup does not meet NOMAD\'s minimum reward-to-risk requirement.'
          : 'Entry, invalidation and target are all defined from current price structure and volatility.'
  };
}

function buildProfessionalPriceAction(
  rows,
  metrics = {}
) {
  const list =
    (Array.isArray(rows) ? rows : [])
      .filter(
        row =>
          safeNumber(row?.close) !== null &&
          safeNumber(row?.high) !== null &&
          safeNumber(row?.low) !== null
      );

  if (list.length < 20) {
    return {
      available: false,
      reason: 'At least 20 valid OHLC sessions are required for professional price-action analysis.'
    };
  }

  const latest = professionalCandleSnapshot(list[list.length - 1]);
  const price = safeNumber(metrics.price) ?? latest?.close ?? null;
  const rsi = safeNumber(metrics.rsi14);
  const macdHistogram = safeNumber(metrics.macdHistogram);
  const volumeRatio = safeNumber(metrics.volumeRatio20d);
  const sma20 = safeNumber(metrics.sma20);
  const sma50 = safeNumber(metrics.sma50);
  const sma200 = safeNumber(metrics.sma200);
  const return1m = safeNumber(metrics.return1m);

  const atrValues = atrSeries(list, 14);
  const latestAtr =
    atrValues.length
      ? safeNumber(atrValues[atrValues.length - 1])
      : null;

  const atrPct =
    latestAtr !== null &&
    price !== null &&
    price > 0
      ? latestAtr / price * 100
      : null;

  const recentForSwings = list.slice(-90);
  const swings = professionalSwingPoints(recentForSwings, 2);
  const structure = professionalTrendStructure(swings);
  const pattern = professionalCandlestickPattern(list.slice(-5));

  const prior20 = list.slice(-21, -1);
  const prior20High =
    prior20.length
      ? Math.max(...prior20.map(row => safeNumber(row.high) ?? -Infinity))
      : null;
  const prior20Low =
    prior20.length
      ? Math.min(...prior20.map(row => safeNumber(row.low) ?? Infinity))
      : null;

  const breakout =
    price !== null &&
    prior20High !== null &&
    Number.isFinite(prior20High) &&
    price > prior20High * 1.002;

  const breakdown =
    price !== null &&
    prior20Low !== null &&
    Number.isFinite(prior20Low) &&
    price < prior20Low * 0.998;

  const volumeConfirmed =
    volumeRatio !== null &&
    volumeRatio >= 1.20;

  const uptrend =
    structure.bias === 'BULLISH' ||
    (
      price !== null &&
      sma20 !== null &&
      sma50 !== null &&
      price > sma20 &&
      sma20 >= sma50
    );

  const downtrend =
    structure.bias === 'BEARISH' ||
    (
      price !== null &&
      sma20 !== null &&
      sma50 !== null &&
      price < sma20 &&
      sma20 <= sma50
    );

  const nearAverage =
    price !== null &&
    (
      (
        sma20 !== null &&
        Math.abs(price - sma20) / Math.max(0.000001, price) <= 0.035
      ) ||
      (
        sma50 !== null &&
        Math.abs(price - sma50) / Math.max(0.000001, price) <= 0.045
      )
    );

  const pullback =
    uptrend &&
    nearAverage &&
    !breakdown &&
    (
      return1m === null ||
      return1m > -10
    );

  const extended =
    (
      rsi !== null &&
      rsi >= 72
    ) ||
    (
      price !== null &&
      sma20 !== null &&
      latestAtr !== null &&
      price - sma20 > latestAtr * 2.2
    );

  const fallbackSupport =
    prior20Low !== null && Number.isFinite(prior20Low)
      ? prior20Low
      : null;
  const fallbackResistance =
    prior20High !== null && Number.isFinite(prior20High)
      ? prior20High
      : null;

  const levels = professionalNearestLevels(
    price,
    swings,
    fallbackSupport,
    fallbackResistance
  );

  const riskDistance =
    price !== null &&
    levels.support !== null &&
    levels.support < price
      ? price - levels.support
      : null;

  const rewardDistance =
    price !== null &&
    levels.resistance !== null &&
    levels.resistance > price
      ? levels.resistance - price
      : null;

  const rewardRisk =
    riskDistance !== null &&
    rewardDistance !== null &&
    riskDistance > 0
      ? rewardDistance / riskDistance
      : null;

  let score = 50;
  const positives = [];
  const risks = [];

  if (structure.bias === 'BULLISH') {
    score += 14;
    positives.push('Swing structure is bullish with higher highs and higher lows.');
  } else if (structure.bias === 'BEARISH') {
    score -= 14;
    risks.push('Swing structure is bearish with lower highs and lower lows.');
  }

  if (breakout) {
    score += volumeConfirmed ? 14 : 7;
    positives.push(
      volumeConfirmed
        ? 'Price has broken above the prior 20-session high with volume confirmation.'
        : 'Price has broken above the prior 20-session high, but volume confirmation is limited.'
    );
  }

  if (breakdown) {
    score -= 22;
    risks.push('Price has broken below the prior 20-session low.');
  }

  if (pullback) {
    score += 10;
    positives.push('Price is pulling back toward a key moving-average zone while the broader trend remains constructive.');
  }

  if (pattern.polarity === 'BULLISH') {
    score += 6;
    positives.push('Latest candlestick behavior provides bullish supporting evidence.');
  } else if (pattern.polarity === 'BEARISH') {
    score -= 6;
    risks.push('Latest candlestick behavior provides bearish supporting evidence.');
  }

  if (rsi !== null) {
    if (rsi >= 40 && rsi <= 65) {
      score += 5;
    } else if (rsi >= 72) {
      score -= 9;
      risks.push('RSI indicates the entry may be extended.');
    } else if (rsi <= 28) {
      score -= 3;
      risks.push('Very low RSI is treated as weakness unless price structure confirms a reversal.');
    }
  }

  if (macdHistogram !== null) {
    if (macdHistogram > 0) {
      score += 4;
    } else if (macdHistogram < 0) {
      score -= 4;
    }
  }

  if (volumeConfirmed) {
    score += 4;
    positives.push('Current participation is above the recent 20-session volume average.');
  }

  if (extended) {
    score -= 10;
    risks.push('Price is extended relative to momentum or its short-term moving average.');
  }

  if (
    rewardRisk !== null &&
    rewardRisk >= 2
  ) {
    score += 5;
    positives.push('Nearest technical reward-to-risk is at least 2:1.');
  } else if (
    rewardRisk !== null &&
    rewardRisk < 1
  ) {
    score -= 8;
    risks.push('Nearest technical reward-to-risk is below 1:1.');
  }

  score = decisionClamp(score);

  const timingState =
    score >= 72
      ? 'GOOD'
      : score >= 58
        ? 'FAIR'
        : score >= 42
          ? 'POOR'
          : 'RISKY';

  let setup = 'NO_CLEAR_SETUP';
  if (breakout && volumeConfirmed) {
    setup = 'CONFIRMED_BREAKOUT';
  } else if (breakout) {
    setup = 'UNCONFIRMED_BREAKOUT';
  } else if (pullback) {
    setup = 'TREND_PULLBACK';
  } else if (breakdown) {
    setup = 'BREAKDOWN';
  } else if (uptrend) {
    setup = 'UPTREND_CONTINUATION';
  } else if (downtrend) {
    setup = 'DOWNTREND';
  }

  const tradePlan =
    buildProfessionalTradePlan(
      setup,
      {
        price,
        atr14: latestAtr,
        support: levels.support,
        resistance: levels.resistance,
        breakoutLevel:
          Number.isFinite(prior20High)
            ? prior20High
            : null,
        sma20,
        sma50
      }
    );

  return {
    available: true,
    asOf: latest?.date || null,
    setup,
    structure,
    candlePattern: pattern,
    breakout: {
      active: breakout,
      volumeConfirmed,
      prior20High:
        Number.isFinite(prior20High)
          ? decisionRound(prior20High, 4)
          : null
    },
    breakdown: {
      active: breakdown,
      prior20Low:
        Number.isFinite(prior20Low)
          ? decisionRound(prior20Low, 4)
          : null
    },
    pullback: {
      active: pullback,
      nearMovingAverage: nearAverage
    },
    extended,
    support:
      decisionRound(levels.support, 4),
    resistance:
      decisionRound(levels.resistance, 4),
    atr14:
      decisionRound(latestAtr, 4),
    atrPct:
      decisionRound(atrPct, 2),
    rewardRisk:
      decisionRound(rewardRisk, 2),
    timingScore:
      decisionRound(score, 2),
    timingState,
    tradePlan,
    positives:
      uniqueTextValues(positives),
    risks:
      uniqueTextValues(risks)
  };
}

function buildHistoricalContext(
  symbol,
  rows,
  currentPrice
) {
  if (
    !Array.isArray(rows) ||
    rows.length < 10
  ) {
    return {
      symbol,
      available: false,
      reason:
        'Insufficient valid historical sessions.'
    };
  }

  const price =
    safeNumber(currentPrice) ??
    safeNumber(
      rows[rows.length - 1]?.close
    );

  const closes =
    rows
      .map(
        row =>
          safeNumber(
            row.close
          )
      )
      .filter(
        value =>
          value !== null &&
          value > 0
      );

  const sma20 =
    simpleAverageClose(
      rows,
      20
    );

  const sma50 =
    simpleAverageClose(
      rows,
      50
    );

  const sma200 =
    simpleAverageClose(
      rows,
      200
    );

  let trend =
    'Mixed';

  if (
    price !== null &&
    sma20 !== null &&
    sma50 !== null
  ) {
    if (
      price > sma20 &&
      price > sma50
    ) {
      trend =
        'Uptrend';
    } else if (
      price < sma20 &&
      price < sma50
    ) {
      trend =
        'Downtrend';
    }
  }

  const last252 =
    rows.slice(-252);

  const high52 =
    last252.length
      ? Math.max(
          ...last252.map(
            row =>
              safeNumber(
                row.high
              ) ??
              safeNumber(
                row.close
              ) ??
              0
          )
        )
      : null;

  const lows =
    last252
      .map(
        row =>
          safeNumber(
            row.low
          ) ??
          safeNumber(
            row.close
          )
      )
      .filter(
        value =>
          value !== null
      );

  const low52 =
    lows.length
      ? Math.min(
          ...lows
        )
      : null;

  const return5d =
    sessionReturn(
      rows,
      5,
      price
    );

  const return1m =
    sessionReturn(
      rows,
      21,
      price
    );

  const return3m =
    sessionReturn(
      rows,
      63,
      price
    );

  const return6m =
    sessionReturn(
      rows,
      126,
      price
    );

  const return1y =
    sessionReturn(
      rows,
      Math.min(
        252,
        Math.max(
          1,
          rows.length - 1
        )
      ),
      price
    );

  const rsiValues =
    closes.length >= 15
      ? rsiSeries(
          closes,
          14
        )
      : [];

  const latestRsi =
    rsiValues.length
      ? safeNumber(
          rsiValues[
            rsiValues.length - 1
          ]
        )
      : null;

  const macd =
    closes.length >= 35
      ? macdSeries(
          closes
        )
      : null;

  const latestMacd =
    macd?.macd?.length
      ? safeNumber(
          macd.macd[
            macd.macd.length - 1
          ]
        )
      : null;

  const latestMacdSignal =
    macd?.signal?.length
      ? safeNumber(
          macd.signal[
            macd.signal.length - 1
          ]
        )
      : null;

  const latestMacdHistogram =
    macd?.histogram?.length
      ? safeNumber(
          macd.histogram[
            macd.histogram.length - 1
          ]
        )
      : null;

  const recentReturnRows =
    rows.slice(-21);

  const logReturns = [];

  for (
    let index = 1;
    index < recentReturnRows.length;
    index++
  ) {
    const previous =
      safeNumber(
        recentReturnRows[
          index - 1
        ]?.close
      );

    const current =
      safeNumber(
        recentReturnRows[
          index
        ]?.close
      );

    if (
      previous !== null &&
      current !== null &&
      previous > 0 &&
      current > 0
    ) {
      logReturns.push(
        Math.log(
          current /
          previous
        )
      );
    }
  }

  const dailyVolatility =
    standardDeviation(
      logReturns
    );

  const annualizedVolatility20dPct =
    dailyVolatility !== null
      ? dailyVolatility *
        Math.sqrt(252) *
        100
      : null;

  const recent20 =
    rows.slice(-20);

  const recentVolumes =
    recent20
      .map(
        row =>
          safeNumber(
            row.volume
          ) ??
          0
      );

  const averageVolume20 =
    recentVolumes.length
      ? mean(
          recentVolumes
        )
      : null;

  const latestVolume =
    safeNumber(
      rows[
        rows.length - 1
      ]?.volume
    );

  const volumeRatio20d =
    latestVolume !== null &&
    averageVolume20 !== null &&
    averageVolume20 > 0
      ? latestVolume /
        averageVolume20
      : null;

  const support20 =
    recent20.length
      ? Math.min(
          ...recent20
            .map(
              row =>
                safeNumber(
                  row.low
                ) ??
                safeNumber(
                  row.close
                )
            )
            .filter(
              value =>
                value !== null
            )
        )
      : null;

  const resistance20 =
    recent20.length
      ? Math.max(
          ...recent20
            .map(
              row =>
                safeNumber(
                  row.high
                ) ??
                safeNumber(
                  row.close
                )
            )
            .filter(
              value =>
                value !== null
            )
        )
      : null;

  let runningPeak =
    null;

  let maxDrawdown52wPct =
    0;

  for (
    const row
    of last252
  ) {
    const close =
      safeNumber(
        row.close
      );

    if (
      close === null ||
      close <= 0
    ) {
      continue;
    }

    if (
      runningPeak === null ||
      close > runningPeak
    ) {
      runningPeak =
        close;
    }

    if (
      runningPeak !== null &&
      runningPeak > 0
    ) {
      const drawdown =
        (
          close -
          runningPeak
        ) /
        runningPeak *
        100;

      if (
        drawdown <
        maxDrawdown52wPct
      ) {
        maxDrawdown52wPct =
          drawdown;
      }
    }
  }

  const priceAction =
    buildProfessionalPriceAction(
      rows,
      {
        price,
        sma20,
        sma50,
        sma200,
        rsi14: latestRsi,
        macdHistogram: latestMacdHistogram,
        volumeRatio20d,
        return1m
      }
    );

  const flags = [];

  if (
    return1m !== null &&
    return1m <= -5
  ) {
    flags.push(
      'Weak 1-month performance'
    );
  }

  if (
    return1m !== null &&
    return1m >= 5
  ) {
    flags.push(
      'Strong 1-month performance'
    );
  }

  if (
    trend === 'Downtrend'
  ) {
    flags.push(
      'Price below short/medium moving averages'
    );
  }

  if (
    trend === 'Uptrend'
  ) {
    flags.push(
      'Price above short/medium moving averages'
    );
  }

  const distanceFromHighPct =
    price !== null &&
    high52 !== null &&
    high52 !== 0
      ? (
          (
            price -
            high52
          ) /
          high52
        ) * 100
      : null;

  const distanceFromLowPct =
    price !== null &&
    low52 !== null &&
    low52 !== 0
      ? (
          (
            price -
            low52
          ) /
          low52
        ) * 100
      : null;

  if (
    distanceFromHighPct !== null &&
    distanceFromHighPct <= -20
  ) {
    flags.push(
      'Well below 52-week high'
    );
  }

  if (
    distanceFromLowPct !== null &&
    distanceFromLowPct <= 8
  ) {
    flags.push(
      'Near 52-week low'
    );
  }

  if (
    latestRsi !== null &&
    latestRsi >= 70
  ) {
    flags.push(
      'RSI is in an overbought zone'
    );
  }

  if (
    latestRsi !== null &&
    latestRsi <= 30
  ) {
    flags.push(
      'RSI is in an oversold zone'
    );
  }

  if (
    volumeRatio20d !== null &&
    volumeRatio20d >= 1.5
  ) {
    flags.push(
      'Volume is elevated versus the recent average'
    );
  }

  return {
    symbol,
    available: true,
    contextSchemaVersion:
      DECISION_HISTORICAL_CONTEXT_SCHEMA_VERSION,
    asOf:
      rows[rows.length - 1]?.date ||
      null,
    validSessions:
      rows.length,
    price:
      roundMemoryNumber(
        price,
        4
      ),
    returns: {
      d5:
        roundMemoryNumber(
          return5d,
          2
        ),
      m1:
        roundMemoryNumber(
          return1m,
          2
        ),
      m3:
        roundMemoryNumber(
          return3m,
          2
        ),
      m6:
        roundMemoryNumber(
          return6m,
          2
        ),
      y1:
        roundMemoryNumber(
          return1y,
          2
        )
    },
    movingAverages: {
      sma20:
        roundMemoryNumber(
          sma20,
          2
        ),
      sma50:
        roundMemoryNumber(
          sma50,
          2
        ),
      sma200:
        roundMemoryNumber(
          sma200,
          2
        )
    },
    trend,
    condition:
      historicalConditionLabel(
        return1m,
        trend
      ),
    technical: {
      rsi14:
        roundMemoryNumber(
          latestRsi,
          2
        ),
      macd:
        roundMemoryNumber(
          latestMacd,
          4
        ),
      macdSignal:
        roundMemoryNumber(
          latestMacdSignal,
          4
        ),
      macdHistogram:
        roundMemoryNumber(
          latestMacdHistogram,
          4
        ),
      volumeRatio20d:
        roundMemoryNumber(
          volumeRatio20d,
          2
        ),
      annualizedVolatility20dPct:
        roundMemoryNumber(
          annualizedVolatility20dPct,
          2
        ),
      momentum20Pct:
        roundMemoryNumber(
          return1m,
          2
        ),
      support20:
        roundMemoryNumber(
          support20,
          2
        ),
      resistance20:
        roundMemoryNumber(
          resistance20,
          2
        ),
      maxDrawdown52wPct:
        roundMemoryNumber(
          maxDrawdown52wPct,
          2
        )
    },
    priceAction,
    range52: {
      high:
        roundMemoryNumber(
          high52,
          2
        ),
      low:
        roundMemoryNumber(
          low52,
          2
        ),
      distanceFromHighPct:
        roundMemoryNumber(
          distanceFromHighPct,
          2
        ),
      distanceFromLowPct:
        roundMemoryNumber(
          distanceFromLowPct,
          2
        )
    },
    flags,
    interpretation:
      flags.length
        ? flags.join('. ') + '.'
        : 'No strong historical-condition flag is active from price history alone.',
    source:
      'psxdata-api daily history'
  };
}

async function getHistoricalSituation(
  stockSymbol,
  suppliedPrice = null
) {
  const context =
    await resolveSymbolContext(
      stockSymbol
    );

  const symbol =
    context.canonicalSymbol;

  const end =
    new Date()
      .toISOString()
      .slice(
        0,
        10
      );

  const start =
    new Date(
      Date.now() -
      430 *
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

  const result =
    await fetchCanonicalHistory(
      symbol,
      start,
      end
    );

  const normalized =
    normalizeHistoricalRows(
      result?.data ||
      []
    );

  const currentPrice =
    safeNumber(
      suppliedPrice
    ) ??
    safeNumber(
      normalized.cleaned[
        normalized.cleaned.length - 1
      ]?.close
    );

  return buildHistoricalContext(
    symbol,
    normalized.cleaned,
    currentPrice
  );
}

async function readPortfolioHoldings() {
  try {
    const rows =
      await supabaseRest(
        'portfolio_holdings?select=*&order=created_at.asc'
      );

    return {
      configured: true,
      rows:
        Array.isArray(rows)
          ? rows
          : []
    };
  } catch (error) {
    if (
      String(
        error.message ||
        ''
      )
        .toLowerCase()
        .includes(
          'portfolio_holdings'
        )
    ) {
      return {
        configured: false,
        rows: []
      };
    }

    throw error;
  }
}


async function readPortfolioTransactions() {
  try {
    const rows =
      await supabaseRest(
        'portfolio_transactions?select=*&order=trade_date.asc,created_at.asc'
      );

    return {
      configured: true,
      rows:
        Array.isArray(rows)
          ? rows
          : []
    };
  } catch (error) {
    if (
      String(
        error.message ||
        ''
      )
        .toLowerCase()
        .includes(
          'portfolio_transactions'
        )
    ) {
      return {
        configured: false,
        rows: []
      };
    }

    throw error;
  }
}

function normalizePortfolioTransactionSide(
  value
) {
  const side =
    String(
      value ||
      ''
    )
      .trim()
      .toUpperCase();

  if (
    [
      'BUY',
      'SELL',
      'DIVIDEND',
      'OPENING'
    ].includes(
      side
    )
  ) {
    return side;
  }

  return null;
}

function portfolioTransactionDateValue(
  row
) {
  const primary =
    Date.parse(
      row?.trade_date ||
      ''
    );

  const secondary =
    Date.parse(
      row?.created_at ||
      ''
    );

  return [
    Number.isFinite(primary)
      ? primary
      : 0,
    Number.isFinite(secondary)
      ? secondary
      : 0
  ];
}

function computePortfolioTransactionLedger(
  rows
) {
  const source =
    Array.isArray(rows)
      ? rows
        .slice()
        .sort(
          (
            a,
            b
          ) => {
            const aDate =
              portfolioTransactionDateValue(
                a
              );
            const bDate =
              portfolioTransactionDateValue(
                b
              );

            if (
              aDate[0] !==
              bDate[0]
            ) {
              return aDate[0] -
                bDate[0];
            }

            return aDate[1] -
              bDate[1];
          }
        )
      : [];

  const bySymbol =
    new Map();

  const invalid = [];

  let realizedPnl = 0;
  let dividends = 0;
  let totalFees = 0;

  for (
    const row
    of source
  ) {
    const symbol =
      normalizeSymbol(
        row?.symbol
      );

    const side =
      normalizePortfolioTransactionSide(
        row?.side ||
        row?.type ||
        row?.action
      );

    if (!symbol || !side) {
      continue;
    }

    const quantity =
      Math.max(
        0,
        safeNumber(
          row?.quantity
        ) ||
        0
      );

    const price =
      Math.max(
        0,
        safeNumber(
          row?.price
        ) ||
        0
      );

    const fees =
      Math.max(
        0,
        safeNumber(
          row?.fees
        ) ||
        0
      );

    const cashAmount =
      Math.max(
        0,
        safeNumber(
          row?.cash_amount ??
          row?.cashAmount
        ) ||
        0
      );

    totalFees +=
      fees;

    const state =
      bySymbol.get(
        symbol
      ) || {
        symbol,
        quantity: 0,
        costBasis: 0,
        averageCost: 0,
        realizedPnl: 0,
        dividends: 0,
        fees: 0,
        openDate: null,
        transactionCount: 0
      };

    state.transactionCount +=
      1;

    state.fees +=
      fees;

    if (
      side === 'BUY' ||
      side === 'OPENING'
    ) {
      if (
        quantity <= 0 ||
        price < 0
      ) {
        invalid.push({
          symbol,
          id: row?.id || null,
          reason:
            'Buy/opening transaction requires positive quantity and a non-negative price.'
        });
        continue;
      }

      if (
        state.quantity <=
        0.00000001
      ) {
        state.openDate =
          row?.trade_date ||
          state.openDate ||
          null;
      }

      state.quantity +=
        quantity;

      state.costBasis +=
        quantity *
        price +
        fees;

      state.averageCost =
        state.quantity > 0
          ? state.costBasis /
            state.quantity
          : 0;
    } else if (
      side === 'SELL'
    ) {
      if (
        quantity <= 0 ||
        price < 0
      ) {
        invalid.push({
          symbol,
          id: row?.id || null,
          reason:
            'Sell transaction requires positive quantity and a non-negative price.'
        });
        continue;
      }

      if (
        quantity -
          state.quantity >
        0.00000001
      ) {
        invalid.push({
          symbol,
          id: row?.id || null,
          reason:
            'Sell quantity exceeds the shares available in the NOMAD ledger.'
        });
        continue;
      }

      const averageCost =
        state.quantity > 0
          ? state.costBasis /
            state.quantity
          : 0;

      const realized =
        quantity *
        price -
        quantity *
        averageCost -
        fees;

      state.realizedPnl +=
        realized;

      realizedPnl +=
        realized;

      state.quantity -=
        quantity;

      state.costBasis -=
        averageCost *
        quantity;

      if (
        state.quantity <=
        0.00000001
      ) {
        state.quantity = 0;
        state.costBasis = 0;
        state.averageCost = 0;
        state.openDate = null;
      } else {
        state.averageCost =
          state.costBasis /
          state.quantity;
      }
    } else if (
      side === 'DIVIDEND'
    ) {
      if (
        cashAmount <= 0
      ) {
        invalid.push({
          symbol,
          id: row?.id || null,
          reason:
            'Dividend transaction requires a positive cash amount.'
        });
        continue;
      }

      state.dividends +=
        cashAmount;

      dividends +=
        cashAmount;
    }

    bySymbol.set(
      symbol,
      state
    );
  }

  return {
    bySymbol,
    invalid,
    realizedPnl:
      roundMemoryNumber(
        realizedPnl,
        2
      ) || 0,
    dividends:
      roundMemoryNumber(
        dividends,
        2
      ) || 0,
    totalFees:
      roundMemoryNumber(
        totalFees,
        2
      ) || 0,
    transactionCount:
      source.length
  };
}

async function seedOpeningHoldingIntoTransactionLedger(
  symbol,
  transactionRows
) {
  const normalized =
    normalizeSymbol(
      symbol
    );

  const hasLedgerRows =
    (transactionRows || [])
      .some(
        row =>
          normalizeSymbol(
            row?.symbol
          ) ===
          normalized
      );

  if (hasLedgerRows) {
    return transactionRows;
  }

  const holdings =
    await readPortfolioHoldings();

  if (!holdings.configured) {
    return transactionRows;
  }

  const existing =
    holdings.rows.find(
      row =>
        normalizeSymbol(
          row?.symbol
        ) ===
        normalized
    );

  if (!existing) {
    return transactionRows;
  }

  const quantity =
    safeNumber(
      existing.quantity
    );

  const averageCost =
    safeNumber(
      existing.average_cost
    );

  if (
    quantity === null ||
    quantity <= 0 ||
    averageCost === null ||
    averageCost < 0
  ) {
    return transactionRows;
  }

  const rows =
    await supabaseRest(
      'portfolio_transactions?select=*',
      {
        method: 'POST',
        prefer:
          'return=representation',
        body: {
          symbol:
            normalized,
          side:
            'OPENING',
          quantity,
          price:
            averageCost,
          trade_date:
            existing.purchase_date ||
            new Date()
              .toISOString()
              .slice(0, 10),
          fees:
            Math.max(
              0,
              safeNumber(
                existing.fees
              ) ||
              0
            ),
          cash_amount: 0,
          notes:
            'Opening position migrated from the legacy NOMAD holdings table.'
        }
      }
    );

  return [
    ...(transactionRows || []),
    ...(
      Array.isArray(rows)
        ? rows
        : []
    )
  ];
}

async function rebuildPortfolioHoldingFromTransactions(
  symbol
) {
  const normalized =
    normalizeSymbol(
      symbol
    );

  const transactions =
    await readPortfolioTransactions();

  if (!transactions.configured) {
    return null;
  }

  const ledger =
    computePortfolioTransactionLedger(
      transactions.rows
    );

  const state =
    ledger.bySymbol.get(
      normalized
    ) ||
    null;

  if (
    !state ||
    state.quantity <= 0
  ) {
    try {
      await deletePortfolioHolding(
        normalized
      );
    } catch {}

    return null;
  }

  const rows =
    await supabaseRest(
      'portfolio_holdings?on_conflict=symbol&select=*',
      {
        method: 'POST',
        prefer:
          'resolution=merge-duplicates,return=representation',
        body: {
          symbol:
            normalized,
          quantity:
            roundMemoryNumber(
              state.quantity,
              6
            ),
          average_cost:
            roundMemoryNumber(
              state.averageCost,
              6
            ),
          purchase_date:
            state.openDate ||
            null,
          fees: 0,
          notes:
            'Derived from NOMAD transaction ledger.'
        }
      }
    );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function savePortfolioTransaction(
  input
) {
  const transactionResult =
    await readPortfolioTransactions();

  if (!transactionResult.configured) {
    bad(
      'Portfolio transaction ledger is not configured. Run the 0.8.5A portfolio ledger SQL migration in Supabase first.',
      503
    );
  }

  const symbol =
    normalizeSymbol(
      input?.symbol
    );

  const side =
    normalizePortfolioTransactionSide(
      input?.side ||
      input?.type ||
      input?.action
    );

  if (!symbol) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  if (!getUniverseMasterEntry(symbol)) {
    bad(
      'Symbol is not present in the canonical NOMAD universe.',
      404
    );
  }

  if (
    !side ||
    side === 'OPENING'
  ) {
    bad(
      'Transaction type must be BUY, SELL or DIVIDEND.'
    );
  }

  const quantity =
    Math.max(
      0,
      safeNumber(
        input?.quantity
      ) ||
      0
    );

  const price =
    Math.max(
      0,
      safeNumber(
        input?.price
      ) ||
      0
    );

  const fees =
    Math.max(
      0,
      safeNumber(
        input?.fees
      ) ||
      0
    );

  const cashAmount =
    Math.max(
      0,
      safeNumber(
        input?.cash_amount ??
        input?.cashAmount
      ) ||
      0
    );

  if (
    (
      side === 'BUY' ||
      side === 'SELL'
    ) &&
    (
      quantity <= 0 ||
      price <= 0
    )
  ) {
    bad(
      'BUY and SELL transactions require a positive quantity and price.'
    );
  }

  if (
    side === 'DIVIDEND' &&
    cashAmount <= 0
  ) {
    bad(
      'Dividend transaction requires a positive cash amount.'
    );
  }

  const tradeDate =
    String(
      input?.trade_date ||
      input?.tradeDate ||
      new Date()
        .toISOString()
        .slice(0, 10)
    )
      .trim();

  let transactionRows =
    await seedOpeningHoldingIntoTransactionLedger(
      symbol,
      transactionResult.rows
    );

  const proposed = {
    id: '__PROPOSED__',
    symbol,
    side,
    quantity,
    price,
    trade_date:
      tradeDate,
    fees,
    cash_amount:
      cashAmount,
    created_at:
      new Date()
        .toISOString()
  };

  const validationLedger =
    computePortfolioTransactionLedger([
      ...transactionRows,
      proposed
    ]);

  const proposedInvalid =
    validationLedger.invalid.find(
      item =>
        item.id ===
        '__PROPOSED__'
    );

  if (proposedInvalid) {
    bad(
      proposedInvalid.reason
    );
  }

  const rows =
    await supabaseRest(
      'portfolio_transactions?select=*',
      {
        method: 'POST',
        prefer:
          'return=representation',
        body: {
          symbol,
          side,
          quantity:
            side === 'DIVIDEND'
              ? 0
              : quantity,
          price:
            side === 'DIVIDEND'
              ? 0
              : price,
          trade_date:
            tradeDate,
          fees,
          cash_amount:
            side === 'DIVIDEND'
              ? cashAmount
              : 0,
          notes:
            String(
              input?.notes ||
              ''
            ).trim() ||
            null
        }
      }
    );

  const saved =
    Array.isArray(rows)
      ? rows[0] || null
      : null;

  const holding =
    await rebuildPortfolioHoldingFromTransactions(
      symbol
    );

  return {
    transaction:
      saved,
    holding
  };
}

async function deletePortfolioTransaction(
  transactionId
) {
  const id =
    String(
      transactionId ||
      ''
    ).trim();

  if (!id) {
    bad(
      'Transaction ID is required.'
    );
  }

  const rows =
    await supabaseRest(
      'portfolio_transactions?id=eq.' +
      encodeURIComponent(id) +
      '&select=*'
    );

  const row =
    Array.isArray(rows)
      ? rows[0] || null
      : null;

  if (!row) {
    bad(
      'Portfolio transaction was not found.',
      404
    );
  }

  if (
    normalizePortfolioTransactionSide(
      row.side
    ) === 'OPENING'
  ) {
    bad(
      'Opening-balance transactions cannot be deleted directly. Edit/remove the opening holding instead.'
    );
  }

  await supabaseRest(
    'portfolio_transactions?id=eq.' +
    encodeURIComponent(id),
    {
      method: 'DELETE',
      prefer: 'return=minimal'
    }
  );

  await rebuildPortfolioHoldingFromTransactions(
    row.symbol
  );

  return {
    status: 'OK',
    id,
    symbol:
      normalizeSymbol(
        row.symbol
      )
  };
}

async function readLatestDecisionResult() {
  try {
    const rows =
      await supabaseRest(
        'decision_runs?select=raw_result,created_at&order=created_at.desc&limit=1'
      );

    return Array.isArray(rows) &&
      rows.length
        ? rows[0]
        : null;
  } catch {
    return null;
  }
}

async function savePortfolioHolding(
  input
) {
  const symbol =
    normalizeSymbol(
      input?.symbol
    );

  const quantity =
    safeNumber(
      input?.quantity
    );

  const averageCost =
    safeNumber(
      input?.average_cost ??
      input?.averageCost
    );

  const fees =
    safeNumber(
      input?.fees
    ) ??
    0;

  if (!symbol) {
    bad(
      'Enter a PSX symbol.'
    );
  }

  const master =
    getUniverseMasterEntry(
      symbol
    );

  if (!master) {
    bad(
      'Symbol is not present in the canonical NOMAD universe.',
      404
    );
  }

  if (
    quantity === null ||
    quantity <= 0
  ) {
    bad(
      'Quantity must be greater than zero.'
    );
  }

  if (
    averageCost === null ||
    averageCost < 0
  ) {
    bad(
      'Average cost must be zero or greater.'
    );
  }

  const rows =
    await supabaseRest(
      'portfolio_holdings?on_conflict=symbol&select=*',
      {
        method: 'POST',
        prefer:
          'resolution=merge-duplicates,return=representation',
        body: {
          symbol,
          quantity,
          average_cost:
            averageCost,
          purchase_date:
            input?.purchase_date ||
            input?.purchaseDate ||
            null,
          fees,
          notes:
            String(
              input?.notes ||
              ''
            ).trim() ||
            null
        }
      }
    );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function deletePortfolioHolding(
  symbol
) {
  const normalized =
    normalizeSymbol(
      symbol
    );

  if (!normalized) {
    bad(
      'Enter a symbol to remove.'
    );
  }

  await supabaseRest(
    'portfolio_holdings?symbol=eq.' +
    encodeURIComponent(
      normalized
    ),
    {
      method: 'DELETE',
      prefer: 'return=minimal'
    }
  );

  return {
    status: 'OK',
    symbol: normalized
  };
}

async function saveHistoricalSituationToMemory(
  symbol,
  historicalContext,
  marketRow = null,
  runId = null
) {
  if (
    !historicalContext?.available
  ) {
    return null;
  }

  const previous =
    await readSecurityMemory(
      symbol
    );

  const master =
    getUniverseMasterEntry(
      symbol
    );

  const marketState = {
    ...(
      previous?.market_state ||
      {}
    ),
    historicalContext
  };

  const rows =
    await supabaseRest(
      'security_state?on_conflict=symbol&select=symbol,market_state,evaluated_at',
      {
        method: 'POST',
        prefer:
          'resolution=merge-duplicates,return=representation',
        body: {
          symbol,
          company_name:
            previous?.company_name ||
            master?.companyName ||
            marketRow?.companyName ||
            symbol,
          sector:
            previous?.sector ||
            master?.sector ||
            marketRow?.sector ||
            null,
          universe_class:
            previous?.universe_class ||
            master?.universeClass ||
            marketRow?.universeClass ||
            null,
          eligibility:
            previous?.eligibility ||
            (
              master?.recommendationEligible ===
              true
                ? 'RECOMMENDATION_ELIGIBLE'
                : 'NOT_RECOMMENDATION_ELIGIBLE'
            ),
          market_price:
            safeNumber(
              marketRow?.price
            ) ??
            previous?.market_price ??
            historicalContext.price ??
            null,
          market_state:
            marketState,
          last_run_id:
            runId ||
            previous?.last_run_id ||
            null,
          evaluated_at:
            new Date()
              .toISOString()
        }
      }
    );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function refreshHistoricalSituation(
  symbol,
  marketRow = null,
  runId = null
) {
  const context =
    await getHistoricalSituation(
      symbol,
      marketRow?.price ??
      null
    );

  await saveHistoricalSituationToMemory(
    normalizeSymbol(
      symbol
    ),
    context,
    marketRow,
    runId
  );

  return context;
}

async function getPortfolioSnapshot() {
  const [
    holdingsResult,
    transactionResult,
    latestDecision
  ] =
    await Promise.all([
      readPortfolioHoldings(),
      readPortfolioTransactions(),
      readLatestDecisionResult()
    ]);

  if (!holdingsResult.configured) {
    return {
      configured: false,
      ledgerConfigured:
        transactionResult.configured,
      holdings: [],
      transactions: [],
      summary: null,
      health: null
    };
  }

  const ledger =
    transactionResult.configured
      ? computePortfolioTransactionLedger(
          transactionResult.rows
        )
      : {
          bySymbol:
            new Map(),
          invalid: [],
          realizedPnl: 0,
          dividends: 0,
          totalFees: 0,
          transactionCount: 0
        };

  const holdingMap =
    new Map();

  for (
    const holding
    of holdingsResult.rows
  ) {
    const symbol =
      normalizeSymbol(
        holding.symbol
      );

    if (!symbol) {
      continue;
    }

    holdingMap.set(
      symbol,
      {
        ...holding,
        ledgerBacked: false
      }
    );
  }

  if (transactionResult.configured) {
    for (
      const [
        symbol,
        state
      ]
      of ledger.bySymbol.entries()
    ) {
      if (
        state.quantity <= 0
      ) {
        continue;
      }

      holdingMap.set(
        symbol,
        {
          id:
            holdingMap.get(
              symbol
            )?.id ||
            null,
          symbol,
          quantity:
            state.quantity,
          average_cost:
            state.averageCost,
          purchase_date:
            state.openDate,
          fees: 0,
          notes:
            'Derived from NOMAD transaction ledger.',
          ledgerBacked: true
        }
      );
    }
  }

  const holdings =
    Array.from(
      holdingMap.values()
    );

  if (!holdings.length) {
    return {
      configured: true,
      ledgerConfigured:
        transactionResult.configured,
      ledgerMode:
        transactionResult.configured
          ? 'TRANSACTION_LEDGER'
          : 'HOLDINGS_ONLY',
      holdings: [],
      transactions:
        transactionResult.configured
          ? transactionResult.rows
            .slice()
            .reverse()
            .slice(0, 20)
          : [],
      summary: {
        holdings: 0,
        currentValue: 0,
        investedCost: 0,
        totalPnl: 0,
        totalPnlPct: null,
        dayPnl: 0,
        dayPnlPct: null,
        realizedPnl:
          ledger.realizedPnl || 0,
        dividends:
          ledger.dividends || 0,
        netPnl:
          (
            ledger.realizedPnl ||
            0
          ) +
          (
            ledger.dividends ||
            0
          ),
        transactionCount:
          ledger.transactionCount || 0
      },
      health: {
        state: 'EMPTY',
        concentration: 'N/A',
        largestPositionPct: null,
        largestPositionSymbol: null,
        sectorCount: 0,
        sectors: []
      }
    };
  }

  const [market, memoryRows] =
    await Promise.all([
      loadPSXMarket(),
      readAllSecurityMemory()
    ]);

  const marketMap =
    new Map(
      market.stocks.map(
        row => [
          normalizeSymbol(
            row.symbol
          ),
          row
        ]
      )
    );

  const memoryMap =
    new Map(
      memoryRows.map(
        row => [
          normalizeSymbol(
            row.symbol
          ),
          row
        ]
      )
    );

  const decisionMap =
    new Map();

  const decisionRaw =
    latestDecision?.raw_result ||
    null;

  if (decisionRaw?.opportunityBoard) {
    const groups = [
      [
        'PRIORITY_1',
        decisionRaw.opportunityBoard.priority1 || []
      ],
      [
        'PRIORITY_2',
        decisionRaw.opportunityBoard.priority2 || []
      ],
      [
        'EVIDENCE_RESEARCH',
        decisionRaw.opportunityBoard.evidenceResearch ||
          decisionRaw.opportunityBoard.researchRequired || []
      ],
      [
        'AVOID',
        decisionRaw.opportunityBoard.avoid || []
      ]
    ];

    for (
      const [bucket, rows]
      of groups
    ) {
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

        decisionMap.set(
          symbol,
          {
            bucket,
            view:
              row.decisionCenterView ||
              row.action ||
              (
                bucket === 'PRIORITY_2'
                  ? 'WATCH'
                  : bucket === 'AVOID'
                    ? 'AVOID'
                    : bucket === 'EVIDENCE_RESEARCH'
                      ? 'EVIDENCE_RESEARCH'
                      : 'MONITOR'
              ),
            reason:
              row.reason ||
              null,
            asOf:
              latestDecision.created_at ||
              null
          }
        );
      }
    }
  }

  const enriched = [];

  for (
    const holding
    of holdings
  ) {
    const symbol =
      normalizeSymbol(
        holding.symbol
      );

    const marketRow =
      marketMap.get(
        symbol
      ) ||
      null;

    let memory =
      memoryMap.get(
        symbol
      ) ||
      null;

    let historicalContext =
      memory?.market_state
        ?.historicalContext ||
      null;

    const contextAge =
      Date.parse(
        memory?.evaluated_at ||
        ''
      );

    const contextStale =
      !historicalContext ||
      !Number.isFinite(
        contextAge
      ) ||
      Date.now() -
        contextAge >
        12 *
        60 *
        60 *
        1000;

    if (contextStale) {
      try {
        historicalContext =
          await refreshHistoricalSituation(
            symbol,
            marketRow
          );

        memory =
          await readSecurityMemory(
            symbol
          );
      } catch {}
    }

    const quantity =
      safeNumber(
        holding.quantity
      ) ||
      0;

    const averageCost =
      safeNumber(
        holding.average_cost
      ) ||
      0;

    const fees =
      holding.ledgerBacked
        ? 0
        : safeNumber(
            holding.fees
          ) ||
          0;

    const currentPrice =
      safeNumber(
        marketRow?.price
      );

    const currentValue =
      currentPrice !== null
        ? quantity *
          currentPrice
        : null;

    const investedCost =
      quantity *
      averageCost +
      fees;

    const totalPnl =
      currentValue !== null
        ? currentValue -
          investedCost
        : null;

    const totalPnlPct =
      totalPnl !== null &&
      investedCost > 0
        ? totalPnl /
          investedCost *
          100
        : null;

    const previousClose =
      safeNumber(
        marketRow?.previousClose
      );

    const dayPnl =
      currentPrice !== null &&
      previousClose !== null
        ? (
            currentPrice -
            previousClose
          ) *
          quantity
        : null;

    const dayPnlPct =
      previousClose !== null &&
      previousClose > 0 &&
      currentPrice !== null
        ? (
            currentPrice -
            previousClose
          ) /
          previousClose *
          100
        : null;

    const ledgerState =
      ledger.bySymbol.get(
        symbol
      ) ||
      null;

    const decisionState =
      decisionMap.get(
        symbol
      ) ||
      null;

    enriched.push({
      id:
        holding.id,
      symbol,
      companyName:
        marketRow?.companyName ||
        getUniverseMasterEntry(
          symbol
        )?.companyName ||
        symbol,
      sector:
        marketRow?.sector ||
        getUniverseMasterEntry(
          symbol
        )?.sector ||
        'Unknown',
      quantity:
        roundMemoryNumber(
          quantity,
          6
        ),
      averageCost:
        roundMemoryNumber(
          averageCost,
          4
        ),
      fees:
        roundMemoryNumber(
          fees,
          2
        ),
      purchaseDate:
        holding.purchase_date ||
        ledgerState?.openDate ||
        null,
      currentPrice:
        roundMemoryNumber(
          currentPrice,
          4
        ),
      previousClose:
        roundMemoryNumber(
          previousClose,
          4
        ),
      dayChangePct:
        roundMemoryNumber(
          marketRow?.dayChangePct ??
          dayPnlPct,
          2
        ),
      investedCost:
        roundMemoryNumber(
          investedCost,
          2
        ),
      currentValue:
        roundMemoryNumber(
          currentValue,
          2
        ),
      totalPnl:
        roundMemoryNumber(
          totalPnl,
          2
        ),
      totalPnlPct:
        roundMemoryNumber(
          totalPnlPct,
          2
        ),
      dayPnl:
        roundMemoryNumber(
          dayPnl,
          2
        ),
      dayPnlPct:
        roundMemoryNumber(
          dayPnlPct,
          2
        ),
      historicalContext:
        historicalContext ||
        null,
      currentView:
        memory?.current_view ||
        null,
      ledgerBacked:
        holding.ledgerBacked === true,
      transactionCount:
        ledgerState?.transactionCount ||
        0,
      realizedPnl:
        roundMemoryNumber(
          ledgerState?.realizedPnl,
          2
        ) ||
        0,
      dividends:
        roundMemoryNumber(
          ledgerState?.dividends,
          2
        ) ||
        0,
      nomadView:
        decisionState?.view ||
        'MONITOR',
      nomadBucket:
        decisionState?.bucket ||
        null,
      nomadReason:
        decisionState?.reason ||
        null,
      nomadDecisionAsOf:
        decisionState?.asOf ||
        null
    });
  }

  const summary =
    enriched.reduce(
      (
        output,
        item
      ) => {
        output.investedCost +=
          safeNumber(
            item.investedCost
          ) ||
          0;

        output.currentValue +=
          safeNumber(
            item.currentValue
          ) ||
          0;

        output.totalPnl +=
          safeNumber(
            item.totalPnl
          ) ||
          0;

        output.dayPnl +=
          safeNumber(
            item.dayPnl
          ) ||
          0;

        return output;
      },
      {
        holdings:
          enriched.length,
        investedCost: 0,
        currentValue: 0,
        totalPnl: 0,
        dayPnl: 0,
        realizedPnl:
          ledger.realizedPnl ||
          0,
        dividends:
          ledger.dividends ||
          0,
        transactionCount:
          ledger.transactionCount ||
          0
      }
    );

  summary.totalPnlPct =
    summary.investedCost > 0
      ? summary.totalPnl /
        summary.investedCost *
        100
      : null;

  const previousValue =
    summary.currentValue -
    summary.dayPnl;

  summary.dayPnlPct =
    previousValue > 0
      ? summary.dayPnl /
        previousValue *
        100
      : null;

  summary.netPnl =
    summary.totalPnl +
    summary.realizedPnl +
    summary.dividends;

  for (
    const key
    of [
      'investedCost',
      'currentValue',
      'totalPnl',
      'dayPnl',
      'totalPnlPct',
      'dayPnlPct',
      'realizedPnl',
      'dividends',
      'netPnl'
    ]
  ) {
    summary[key] =
      roundMemoryNumber(
        summary[key],
        2
      );
  }

  const sectorMap =
    new Map();

  for (
    const item
    of enriched
  ) {
    const value =
      safeNumber(
        item.currentValue
      ) ||
      0;

    item.weightPct =
      summary.currentValue > 0
        ? roundMemoryNumber(
            value /
            summary.currentValue *
            100,
            2
          )
        : null;

    sectorMap.set(
      item.sector,
      (
        sectorMap.get(
          item.sector
        ) ||
        0
      ) +
      value
    );
  }

  const sectors =
    Array.from(
      sectorMap.entries()
    )
      .map(
        ([sector, value]) => ({
          sector,
          value:
            roundMemoryNumber(
              value,
              2
            ),
          weightPct:
            summary.currentValue > 0
              ? roundMemoryNumber(
                  value /
                  summary.currentValue *
                  100,
                  2
                )
              : 0
        })
      )
      .sort(
        (
          a,
          b
        ) =>
          b.weightPct -
          a.weightPct
      );

  const largest =
    enriched
      .slice()
      .sort(
        (
          a,
          b
        ) =>
          (
            b.weightPct ||
            0
          ) -
          (
            a.weightPct ||
            0
          )
      )[0] ||
    null;

  const largestSector =
    sectors[0] ||
    null;

  let concentration =
    'GOOD';

  if (
    (
      largest?.weightPct ||
      0
    ) > 45 ||
    (
      largestSector?.weightPct ||
      0
    ) > 60
  ) {
    concentration =
      'HIGH';
  } else if (
    (
      largest?.weightPct ||
      0
    ) > 30 ||
    (
      largestSector?.weightPct ||
      0
    ) > 45
  ) {
    concentration =
      'WATCH';
  }

  const health = {
    state:
      concentration === 'HIGH'
        ? 'MEDIUM-HIGH RISK'
        : concentration === 'WATCH'
          ? 'MEDIUM RISK'
          : 'BALANCED',
    concentration,
    largestPositionPct:
      largest?.weightPct ??
      null,
    largestPositionSymbol:
      largest?.symbol ||
      null,
    largestSector:
      largestSector?.sector ||
      null,
    largestSectorPct:
      largestSector?.weightPct ??
      null,
    sectorCount:
      sectors.length,
    sectors
  };

  const recentTransactions =
    transactionResult.configured
      ? transactionResult.rows
        .slice()
        .sort(
          (
            a,
            b
          ) => {
            const aDate =
              portfolioTransactionDateValue(
                a
              );
            const bDate =
              portfolioTransactionDateValue(
                b
              );

            if (
              aDate[0] !==
              bDate[0]
            ) {
              return bDate[0] -
                aDate[0];
            }

            return bDate[1] -
              aDate[1];
          }
        )
        .slice(0, 25)
      : [];

  return {
    configured: true,
    ledgerConfigured:
      transactionResult.configured,
    ledgerMode:
      transactionResult.configured
        ? 'TRANSACTION_LEDGER'
        : 'HOLDINGS_ONLY',
    ledgerWarnings:
      ledger.invalid ||
      [],
    asOf:
      market.marketWatchAsOf ||
      market.asOf,
    summary,
    health,
    holdings:
      enriched,
    transactions:
      recentTransactions
  };
}

async function readJsonRequestBody(
  request
) {
  const chunks = [];
  let total = 0;

  for await (
    const chunk
    of request
  ) {
    total +=
      chunk.length;

    if (
      total >
      1024 * 1024
    ) {
      bad(
        'Request body is too large.',
        413
      );
    }

    chunks.push(
      chunk
    );
  }

  if (!chunks.length) {
    return {};
  }

  const text =
    Buffer.concat(
      chunks
    )
      .toString(
        'utf8'
      );

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(
      text
    );
  } catch {
    bad(
      'Invalid JSON request body.'
    );
  }
}

/* =========================================================
   DECISION LAB + DECISION CENTER + PORTFOLIO AWARENESS - BUILD 0.8.5A
   Experimental shadow engine. No automatic trading.
========================================================= */

const DECISION_MODELS = {
  long_term: {
    id: 'NOMAD-LT-PRO-0.9.1',
    horizon: 'long_term',
    status: 'SHADOW_UNVALIDATED',
    realMoneyEligible: false,
    weights: {
      fundamental: 0.35,
      valuation: 0.20,
      entry: 0.20,
      risk: 0.15,
      dataQuality: 0.10
    }
  },
  short_term: {
    id: 'NOMAD-ST-PRO-0.9.3',
    horizon: 'short_term',
    status: 'SHADOW_UNVALIDATED',
    realMoneyEligible: false,
    weights: {
      fundamental: 0.15,
      valuation: 0.10,
      entry: 0.40,
      risk: 0.25,
      dataQuality: 0.10
    }
  }
};

const DECISION_RISK_POLICIES = {
  conservative: {
    id: 'RISK-CONSERVATIVE-0.1',
    minAverageVolume30d: 150000,
    maxAnnualizedVolatilityPct: 45,
    minDataQualityScore: 80,
    minOverallScore: 74,
    minRiskScore: 60,
    maxStockPct: 0.35,
    maxSectorPct: 0.45,
    maxAllocations: 3
  },
  balanced: {
    id: 'RISK-BALANCED-0.1',
    minAverageVolume30d: 50000,
    maxAnnualizedVolatilityPct: 65,
    minDataQualityScore: 72,
    minOverallScore: 68,
    minRiskScore: 48,
    maxStockPct: 0.45,
    maxSectorPct: 0.60,
    maxAllocations: 3
  },
  aggressive: {
    id: 'RISK-AGGRESSIVE-0.1',
    minAverageVolume30d: 15000,
    maxAnnualizedVolatilityPct: 85,
    minDataQualityScore: 65,
    minOverallScore: 63,
    minRiskScore: 35,
    maxStockPct: 0.60,
    maxSectorPct: 0.80,
    maxAllocations: 4
  }
};


const DECISION_FUNDAMENTAL_CACHE_FRESH_MS =
  24 * 60 * 60 * 1000;

const DECISION_FUNDAMENTAL_CACHE_FALLBACK_MS =
  14 * 24 * 60 * 60 * 1000;

const DECISION_CENTER_SHORTLIST_LIMIT = 48;
const DECISION_CENTER_COMPARABLE_TARGET = 18;
const DECISION_CENTER_DEEP_ATTEMPT_LIMIT = 42;
const DECISION_CENTER_DEEP_BATCH_SIZE = 6;
const DECISION_CENTER_MAX_SHORTLIST_PER_SECTOR = 4;
const DECISION_CENTER_MIN_ANALYST_COVERAGE = 65;
const DECISION_CENTER_MAX_DEPLOYMENT_PCT = 0.90;
const DECISION_CENTER_MIN_TARGET_POSITIONS = 3;
const DECISION_CENTER_MAX_TARGET_POSITIONS = 8;

// 0.9.3.0 Trader Brain Foundation. Long-term 0.9.2.6 logic is intentionally frozen.
const DECISION_HISTORICAL_CONTEXT_SCHEMA_VERSION = 'HC-0.9.3.0';
const DECISION_TRADER_MIN_VALID_SESSIONS = 60;
const DECISION_TRADER_MIN_REWARD_RISK = 1.5;
const DECISION_TRADER_RISK_BUDGET_PCT = {
  conservative: 0.0075,
  balanced: 0.01,
  aggressive: 0.015
};

function decisionClamp(
  value,
  minimum = 0,
  maximum = 100
) {
  const number =
    safeNumber(value);

  if (number === null) {
    return minimum;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      number
    )
  );
}

function decisionRound(
  value,
  digits = 2
) {
  return roundMemoryNumber(
    value,
    digits
  );
}

function decisionPercentile(
  value,
  values,
  higherIsBetter = true
) {
  const number =
    safeNumber(value);

  const clean =
    (Array.isArray(values)
      ? values
      : [])
      .map(
        item =>
          safeNumber(item)
      )
      .filter(
        item =>
          item !== null
      )
      .sort(
        (
          a,
          b
        ) =>
          a - b
      );

  if (
    number === null ||
    !clean.length
  ) {
    return 40;
  }

  if (clean.length === 1) {
    return 60;
  }

  let belowOrEqual =
    0;

  for (
    const item
    of clean
  ) {
    if (item <= number) {
      belowOrEqual++;
    }
  }

  const percentile =
    (
      belowOrEqual - 1
    ) /
    Math.max(
      1,
      clean.length - 1
    );

  return decisionClamp(
    (
      higherIsBetter
        ? percentile
        : 1 - percentile
    ) *
      100
  );
}

function decisionFinancialRow(
  table,
  matcher
) {
  return table?.rows
    ?.find(
      row =>
        matcher.test(
          String(
            row.label ||
            ''
          )
        )
    ) ||
    null;
}

function decisionFinancialMetric(
  table,
  matcher
) {
  const row =
    decisionFinancialRow(
      table,
      matcher
    );

  const item =
    row?.values?.[0] ||
    null;

  return item
    ? {
        label:
          row.label,
        period:
          item.period ||
          null,
        value:
          safeNumber(
            item.value
          )
      }
    : null;
}

function decisionFinancialYoY(
  table,
  matcher
) {
  const row =
    decisionFinancialRow(
      table,
      matcher
    );

  if (
    !row?.values ||
    row.values.length < 2
  ) {
    return null;
  }

  const latest =
    safeNumber(
      row.values[0]?.value
    );

  const previous =
    safeNumber(
      row.values[1]?.value
    );

  if (
    latest === null ||
    previous === null ||
    previous === 0
  ) {
    return null;
  }

  return (
    latest -
    previous
  ) /
    Math.abs(previous) *
    100;
}

function decisionMetricFromRatios(
  ratios,
  matcher
) {
  return decisionFinancialMetric(
    ratios,
    matcher
  );
}

function scoreDecisionFundamentals(
  fundamentals
) {
  if (!fundamentals?.available) {
    return {
      available: false,
      score: 35,
      coverage: 0,
      metrics: {},
      reasons: [
        'Structured PSX fundamentals were unavailable during this decision run.'
      ],
      risks: [
        'NOMAD will not issue a fully supported long-term buy without sufficient fundamental evidence.'
      ]
    };
  }

  const eps =
    decisionFinancialMetric(
      fundamentals.annual,
      /^EPS$/i
    );

  const pat =
    decisionFinancialMetric(
      fundamentals.annual,
      /profit after taxation/i
    );

  const income =
    decisionFinancialMetric(
      fundamentals.annual,
      /^(sales|total income|mark-up earned|revenue)$/i
    );

  const roe =
    decisionMetricFromRatios(
      fundamentals.ratios,
      /return on equity|\broe\b/i
    );

  const margin =
    decisionMetricFromRatios(
      fundamentals.ratios,
      /net profit margin/i
    );

  const epsYoY =
    decisionFinancialYoY(
      fundamentals.annual,
      /^EPS$/i
    );

  const patYoY =
    decisionFinancialYoY(
      fundamentals.annual,
      /profit after taxation/i
    );

  const incomeYoY =
    decisionFinancialYoY(
      fundamentals.annual,
      /^(sales|total income|mark-up earned|revenue)$/i
    );

  let score = 50;
  let observed = 0;
  const reasons = [];
  const risks = [];

  if (eps?.value !== null && eps?.value !== undefined) {
    observed++;

    if (eps.value > 0) {
      score += 10;
      reasons.push(
        'Latest annual EPS is positive.'
      );
    } else {
      score -= 25;
      risks.push(
        'Latest annual EPS is not positive.'
      );
    }
  }

  if (epsYoY !== null) {
    observed++;

    if (epsYoY >= 15) {
      score += 12;
      reasons.push(
        'Annual EPS growth is strong.'
      );
    } else if (epsYoY >= 0) {
      score += 6;
      reasons.push(
        'Annual EPS is growing.'
      );
    } else if (epsYoY <= -20) {
      score -= 15;
      risks.push(
        'Annual EPS has declined materially.'
      );
    } else {
      score -= 6;
      risks.push(
        'Annual EPS growth is negative.'
      );
    }
  }

  if (pat?.value !== null && pat?.value !== undefined) {
    observed++;

    if (pat.value > 0) {
      score += 8;
      reasons.push(
        'Latest annual profit after tax is positive.'
      );
    } else {
      score -= 20;
      risks.push(
        'Latest annual profit after tax is not positive.'
      );
    }
  }

  if (patYoY !== null) {
    observed++;

    if (patYoY >= 15) {
      score += 10;
      reasons.push(
        'Profit after tax growth is strong.'
      );
    } else if (patYoY >= 0) {
      score += 5;
    } else if (patYoY <= -20) {
      score -= 12;
      risks.push(
        'Profit after tax has declined materially.'
      );
    } else {
      score -= 5;
    }
  }

  if (incomeYoY !== null) {
    observed++;

    if (incomeYoY >= 10) {
      score += 6;
      reasons.push(
        'Top-line/income growth is positive.'
      );
    } else if (incomeYoY < -10) {
      score -= 6;
      risks.push(
        'Top-line/income growth is weak.'
      );
    }
  }

  if (roe?.value !== null && roe?.value !== undefined) {
    observed++;

    if (roe.value >= 20) {
      score += 10;
      reasons.push(
        'Return on equity is strong.'
      );
    } else if (roe.value >= 12) {
      score += 6;
    } else if (roe.value < 0) {
      score -= 12;
      risks.push(
        'Return on equity is negative.'
      );
    }
  }

  if (margin?.value !== null && margin?.value !== undefined) {
    observed++;

    if (margin.value > 0) {
      score += 4;
    } else {
      score -= 8;
    }
  }

  const coverage =
    decisionClamp(
      observed /
        7 *
        100
    );

  if (coverage < 40) {
    risks.push(
      'Fundamental metric coverage is limited.'
    );
  }

  return {
    available: true,
    score:
      decisionRound(
        decisionClamp(score),
        2
      ),
    coverage:
      decisionRound(
        coverage,
        2
      ),
    metrics: {
      eps,
      epsYoY:
        decisionRound(
          epsYoY,
          2
        ),
      profitAfterTax:
        pat,
      profitAfterTaxYoY:
        decisionRound(
          patYoY,
          2
        ),
      income,
      incomeYoY:
        decisionRound(
          incomeYoY,
          2
        ),
      roe,
      netProfitMargin:
        margin
    },
    reasons,
    risks
  };
}

function scoreDecisionValuation(
  row,
  eligibleRows
) {
  const pe =
    safeNumber(
      row?.peRatio
    );

  const dividendYield =
    safeNumber(
      row?.dividendYield
    );

  const sectorRows =
    (eligibleRows || [])
      .filter(
        item =>
          String(
            item.sector ||
            ''
          ) ===
            String(
              row?.sector ||
              ''
            ) &&
          safeNumber(
            item.peRatio
          ) !== null &&
          safeNumber(
            item.peRatio
          ) > 0 &&
          safeNumber(
            item.peRatio
          ) < 100
      );

  const comparisonRows =
    sectorRows.length >= 4
      ? sectorRows
      : (eligibleRows || [])
          .filter(
            item => {
              const value =
                safeNumber(
                  item.peRatio
                );

              return (
                value !== null &&
                value > 0 &&
                value < 100
              );
            }
          );

  const relativePeScore =
    pe !== null &&
    pe > 0
      ? decisionPercentile(
          pe,
          comparisonRows.map(
            item =>
              item.peRatio
          ),
          false
        )
      : 40;

  let absolutePeScore = 40;

  if (
    pe !== null &&
    pe > 0
  ) {
    if (pe < 3) {
      absolutePeScore = 50;
    } else if (pe <= 10) {
      absolutePeScore = 90;
    } else if (pe <= 15) {
      absolutePeScore = 78;
    } else if (pe <= 25) {
      absolutePeScore = 62;
    } else if (pe <= 40) {
      absolutePeScore = 38;
    } else {
      absolutePeScore = 20;
    }
  }

  let dividendScore = 45;

  if (dividendYield !== null) {
    if (dividendYield >= 8 && dividendYield <= 15) {
      dividendScore = 88;
    } else if (dividendYield >= 4) {
      dividendScore = 72;
    } else if (dividendYield > 0) {
      dividendScore = 56;
    } else {
      dividendScore = 40;
    }

    if (dividendYield > 15) {
      dividendScore = 62;
    }
  }

  const score =
    relativePeScore *
      0.55 +
    absolutePeScore *
      0.30 +
    dividendScore *
      0.15;

  const reasons = [];
  const risks = [];

  if (pe !== null) {
    reasons.push(
      'P/E ' +
      decisionRound(
        pe,
        2
      ) +
      ' is compared with the stock\'s sector where sufficient peers exist.'
    );
  } else {
    risks.push(
      'Positive P/E data is unavailable.'
    );
  }

  if (
    dividendYield !== null &&
    dividendYield >= 4
  ) {
    reasons.push(
      'Dividend yield contributes positively to the valuation/income view.'
    );
  }

  return {
    score:
      decisionRound(
        decisionClamp(score),
        2
      ),
    peRatio:
      decisionRound(
        pe,
        2
      ),
    dividendYield:
      decisionRound(
        dividendYield,
        2
      ),
    relativePeScore:
      decisionRound(
        relativePeScore,
        2
      ),
    reasons,
    risks
  };
}

function scoreDecisionEntry(
  context,
  horizon,
  riskPolicy
) {
  if (!context?.available) {
    return {
      score: 20,
      reasons: [],
      risks: [
        'Historical price context is unavailable.'
      ]
    };
  }

  let score = 50;
  const reasons = [];
  const risks = [];
  const returns =
    context.returns ||
    {};
  const technical =
    context.technical ||
    {};
  const averages =
    context.movingAverages ||
    {};
  const price =
    safeNumber(
      context.price
    );

  const rsi =
    safeNumber(
      technical.rsi14
    );

  const macdHistogram =
    safeNumber(
      technical.macdHistogram
    );

  const volumeRatio =
    safeNumber(
      technical.volumeRatio20d
    );

  const volatility =
    safeNumber(
      technical.annualizedVolatility20dPct
    );

  if (horizon === 'short_term') {
    if (context.trend === 'Uptrend') {
      score += 18;
      reasons.push(
        'Short/medium trend is positive.'
      );
    } else if (context.trend === 'Downtrend') {
      score -= 18;
      risks.push(
        'Short/medium trend is negative.'
      );
    }

    const d5 =
      safeNumber(
        returns.d5
      );

    const m1 =
      safeNumber(
        returns.m1
      );

    if (d5 !== null) {
      if (d5 > 0 && d5 <= 8) {
        score += 8;
      } else if (d5 > 8 && d5 <= 15) {
        score += 3;
        risks.push(
          'Recent move is already extended; chase risk is higher.'
        );
      } else if (d5 > 15) {
        score -= 5;
        risks.push(
          'Five-session move is very extended.'
        );
      } else if (d5 < 0) {
        score -= 8;
      }
    }

    if (m1 !== null) {
      if (m1 > 0) {
        score += 10;
      } else {
        score -= 10;
      }
    }

    if (rsi !== null) {
      if (rsi >= 50 && rsi <= 68) {
        score += 8;
        reasons.push(
          'RSI supports positive momentum without being extremely extended.'
        );
      } else if (rsi >= 75) {
        score -= 10;
        risks.push(
          'RSI is highly extended.'
        );
      } else if (rsi < 35) {
        score -= 8;
        risks.push(
          'RSI shows weak momentum.'
        );
      }
    }

    if (macdHistogram !== null) {
      if (macdHistogram > 0) {
        score += 8;
      } else {
        score -= 8;
      }
    }

    if (volumeRatio !== null) {
      if (volumeRatio >= 1.2 && volumeRatio <= 3) {
        score += 8;
        reasons.push(
          'Volume participation is above its recent average.'
        );
      } else if (volumeRatio < 0.5) {
        score -= 5;
      }
    }
  } else {
    if (context.trend === 'Uptrend') {
      score += 15;
      reasons.push(
        'Price is above the short and medium moving averages.'
      );
    } else if (context.trend === 'Downtrend') {
      score -= 12;
      risks.push(
        'Price remains below the short and medium moving averages.'
      );
    }

    const sma200 =
      safeNumber(
        averages.sma200
      );

    if (
      price !== null &&
      sma200 !== null
    ) {
      if (price >= sma200) {
        score += 8;
        reasons.push(
          'Price is above the 200-session moving average.'
        );
      } else {
        score -= 8;
        risks.push(
          'Price is below the 200-session moving average.'
        );
      }
    }

    const m1 =
      safeNumber(
        returns.m1
      );

    const m3 =
      safeNumber(
        returns.m3
      );

    if (m1 !== null) {
      if (m1 >= -5 && m1 <= 10) {
        score += 5;
      } else if (m1 > 10 && m1 <= 20) {
        score += 2;
      } else if (m1 > 20) {
        score -= 4;
        risks.push(
          'One-month price move is extended; entry risk is higher.'
        );
      } else if (m1 < -10) {
        score -= 8;
        risks.push(
          'One-month performance is weak.'
        );
      }
    }

    if (m3 !== null) {
      if (m3 > 0) {
        score += 6;
      } else if (m3 < -15) {
        score -= 8;
      }
    }

    if (rsi !== null) {
      if (rsi >= 40 && rsi <= 65) {
        score += 8;
      } else if (rsi >= 70) {
        score -= 7;
        risks.push(
          'RSI indicates a stretched entry.'
        );
      } else if (rsi <= 25) {
        score -= 4;
        risks.push(
          'Very low RSI is treated as weakness, not an automatic buy signal.'
        );
      }
    }

    if (macdHistogram !== null) {
      if (macdHistogram > 0) {
        score += 6;
      } else {
        score -= 6;
      }
    }

    if (
      volumeRatio !== null &&
      volumeRatio >= 0.8 &&
      volumeRatio <= 2.5
    ) {
      score += 3;
    }
  }

  if (
    volatility !== null &&
    volatility >
      riskPolicy.maxAnnualizedVolatilityPct
  ) {
    score -= 12;
    risks.push(
      'Recent annualized volatility exceeds this risk profile\'s experimental limit.'
    );
  }

  return {
    score:
      decisionRound(
        decisionClamp(score),
        2
      ),
    reasons,
    risks
  };
}

function scoreDecisionRisk(
  row,
  context,
  eligibleRows
) {
  const liquidityScore =
    decisionPercentile(
      row?.averageVolume30d,
      (eligibleRows || []).map(
        item =>
          item.averageVolume30d
      ),
      true
    );

  const sizeScore =
    decisionPercentile(
      row?.marketCap,
      (eligibleRows || []).map(
        item =>
          item.marketCap
      ),
      true
    );

  const volatility =
    safeNumber(
      context?.technical
        ?.annualizedVolatility20dPct
    );

  let volatilityScore = 45;

  if (volatility !== null) {
    if (volatility <= 30) {
      volatilityScore = 90;
    } else if (volatility <= 45) {
      volatilityScore = 76;
    } else if (volatility <= 60) {
      volatilityScore = 58;
    } else if (volatility <= 80) {
      volatilityScore = 38;
    } else {
      volatilityScore = 18;
    }
  }

  const drawdown =
    safeNumber(
      context?.technical
        ?.maxDrawdown52wPct
    );

  let drawdownScore = 45;

  if (drawdown !== null) {
    if (drawdown >= -15) {
      drawdownScore = 88;
    } else if (drawdown >= -30) {
      drawdownScore = 68;
    } else if (drawdown >= -50) {
      drawdownScore = 42;
    } else {
      drawdownScore = 20;
    }
  }

  let score =
    liquidityScore * 0.35 +
    sizeScore * 0.25 +
    volatilityScore * 0.25 +
    drawdownScore * 0.15;

  const statusCodes =
    Array.isArray(
      row?.statusCodes
    )
      ? row.statusCodes
      : [];

  const risks = [];
  const reasons = [];

  if (statusCodes.includes('NC')) {
    score = Math.min(
      score,
      15
    );
    risks.push(
      'PSX non-compliant-segment status is present; NOMAD excludes this from new-buy decisions.'
    );
  }

  if (liquidityScore >= 70) {
    reasons.push(
      '30-day trading liquidity ranks well within the eligible universe.'
    );
  }

  if (
    volatility !== null &&
    volatility <= 45
  ) {
    reasons.push(
      'Recent volatility is moderate relative to the engine\'s current risk scale.'
    );
  }

  return {
    score:
      decisionRound(
        decisionClamp(score),
        2
      ),
    liquidityScore:
      decisionRound(
        liquidityScore,
        2
      ),
    sizeScore:
      decisionRound(
        sizeScore,
        2
      ),
    volatility:
      decisionRound(
        volatility,
        2
      ),
    maxDrawdown52wPct:
      decisionRound(
        drawdown,
        2
      ),
    reasons,
    risks
  };
}

function scoreDecisionDataQuality(
  row,
  context,
  fundamental
) {
  let score = 0;
  const missing = [];

  if (
    safeNumber(
      row?.price
    ) !== null
  ) {
    score += 10;
  } else {
    missing.push('price');
  }

  if (
    safeNumber(
      row?.averageVolume30d
    ) !== null
  ) {
    score += 10;
  } else {
    missing.push('30-day liquidity');
  }

  if (context?.available) {
    score += 25;

    if (
      safeNumber(
        context.validSessions
      ) >= 200
    ) {
      score += 10;
    }
  } else {
    missing.push('price history');
  }

  if (fundamental?.available) {
    score += 25;

    if (
      fundamental.coverage >= 40
    ) {
      score += 10;
    }
  } else {
    missing.push('structured fundamentals');
  }

  if (
    safeNumber(
      row?.peRatio
    ) !== null
  ) {
    score += 5;
  }

  if (
    row?.companyName &&
    row?.sector &&
    row.sector !== 'Unknown'
  ) {
    score += 5;
  }

  return {
    score:
      decisionRound(
        decisionClamp(score),
        2
      ),
    missing
  };
}

function decisionScreeningScore(
  row,
  eligibleRows
) {
  const liquidity =
    decisionPercentile(
      row.averageVolume30d,
      eligibleRows.map(
        item =>
          item.averageVolume30d
      ),
      true
    );

  const size =
    decisionPercentile(
      row.marketCap,
      eligibleRows.map(
        item =>
          item.marketCap
      ),
      true
    );

  const valuation =
    scoreDecisionValuation(
      row,
      eligibleRows
    ).score;

  const oneYear =
    safeNumber(
      row.change1yPct
    );

  let stability = 50;

  if (oneYear !== null) {
    if (
      oneYear >= -20 &&
      oneYear <= 60
    ) {
      stability = 70;
    } else if (
      oneYear < -40 ||
      oneYear > 120
    ) {
      stability = 25;
    } else {
      stability = 48;
    }
  }

  return decisionRound(
    liquidity * 0.35 +
    size * 0.20 +
    valuation * 0.35 +
    stability * 0.10,
    2
  );
}

function decisionTraderScreeningScore(
  row,
  eligibleRows
) {
  const liquidity =
    decisionPercentile(
      row?.averageVolume30d,
      (eligibleRows || []).map(
        item => item.averageVolume30d
      ),
      true
    );

  const size =
    decisionPercentile(
      row?.marketCap,
      (eligibleRows || []).map(
        item => item.marketCap
      ),
      true
    );

  const dayChange =
    safeNumber(row?.dayChangePct);
  const oneYear =
    safeNumber(row?.change1yPct);

  let moveQuality = 55;
  if (dayChange !== null) {
    const absoluteMove = Math.abs(dayChange);
    if (absoluteMove <= 5) {
      moveQuality = 72;
    } else if (absoluteMove <= 10) {
      moveQuality = 62;
    } else if (absoluteMove <= 15) {
      moveQuality = 48;
    } else {
      moveQuality = 30;
    }
  }

  let stability = 55;
  if (oneYear !== null) {
    if (oneYear >= -30 && oneYear <= 120) {
      stability = 68;
    } else if (oneYear < -50 || oneYear > 250) {
      stability = 35;
    }
  }

  return decisionRound(
    liquidity * 0.50 +
    size * 0.20 +
    moveQuality * 0.20 +
    stability * 0.10,
    2
  );
}

function decisionCandidateAction(
  candidate,
  model,
  riskPolicy
) {
  const dataQuality =
    safeNumber(
      candidate.dataQuality?.score
    ) ||
    0;

  const fundamentalScore =
    safeNumber(
      candidate.fundamental?.score
    ) ||
    0;

  const entryScore =
    safeNumber(
      candidate.entry?.score
    ) ||
    0;

  const riskScore =
    safeNumber(
      candidate.risk?.score
    ) ||
    0;

  const overallScore =
    safeNumber(
      candidate.overallScore
    ) ||
    0;

  if (
    candidate.statusCodes
      ?.includes('NC')
  ) {
    return {
      action: 'AVOID',
      reason:
        'Listing-compliance status is present.'
    };
  }

  if (
    dataQuality <
    riskPolicy.minDataQualityScore
  ) {
    return {
      action: 'DATA_BLOCKED',
      reason:
        'Critical evidence coverage is below this risk profile\'s threshold.'
    };
  }

  if (
    !candidate.fundamental?.available
  ) {
    return {
      action: 'DATA_BLOCKED',
      reason:
        'NOMAD will not promote a new-buy candidate without structured company fundamentals.'
    };
  }

  if (fundamentalScore < 45) {
    return {
      action: 'AVOID',
      reason:
        'Current fundamental evidence is too weak for a new position.'
    };
  }

  if (
    riskScore <
    riskPolicy.minRiskScore
  ) {
    return {
      action: 'AVOID',
      reason:
        'Risk/liquidity evidence does not pass the selected profile.'
    };
  }

  if (
    overallScore >=
      riskPolicy.minOverallScore &&
    entryScore >=
      (
        model.horizon ===
          'short_term'
          ? 65
          : 60
      )
  ) {
    return {
      action: 'BUY_NOW',
      reason:
        'The current shadow model passes quality, risk and entry gates.'
    };
  }

  if (
    model.horizon ===
      'long_term' &&
    overallScore >=
      riskPolicy.minOverallScore - 2 &&
    fundamentalScore >= 62 &&
    entryScore >= 46
  ) {
    return {
      action: 'STAGED_BUY',
      reason:
        'Long-term evidence is acceptable, but entry quality is not strong enough for a full allocation.'
    };
  }

  if (
    overallScore >=
      riskPolicy.minOverallScore - 10 &&
    fundamentalScore >= 55
  ) {
    return {
      action: 'WAIT',
      reason:
        'The company remains worth monitoring, but the full decision threshold is not met.'
    };
  }

  return {
    action: 'AVOID',
    reason:
      'The candidate does not pass the current shadow model.'
  };
}

function decisionCenterAnalystGate(
  candidate
) {
  const analyst =
    candidate?.analystCore ||
    null;

  if (!analyst) {
    return {
      state: 'RESEARCHING',
      validationTier: 'NONE',
      reason:
        'NOMAD could not complete the first-pass Financial Analyst evidence. The company remains visible and enters automatic evidence research instead of being silently discarded.'
    };
  }

  const summaryCoverage =
    safeNumber(
      analyst.coverage
        ?.summaryCoveragePct ??
      analyst.coverage
        ?.coreCoveragePct
    ) ||
    0;

  const extendedCoverage =
    safeNumber(
      analyst.coverage
        ?.extendedCoveragePct
    ) ||
    0;

  const overall =
    String(
      analyst.overallFinancialView
        ?.state ||
      'UNRELIABLE'
    );

  const earnings =
    String(
      analyst.views
        ?.earningsQuality
        ?.state ||
      'UNRELIABLE'
    );

  const cash =
    String(
      analyst.views
        ?.cashFlowQuality
        ?.state ||
      'UNRELIABLE'
    );

  const balance =
    String(
      analyst.views
        ?.balanceSheet
        ?.state ||
      'UNRELIABLE'
    );

  if (
    analyst.company
      ?.financialSector ===
        true
  ) {
    return {
      state: 'RESEARCHING',
      validationTier: 'SECTOR_MODEL_REQUIRED',
      reason:
        'This company requires a financial-sector-specific analyst model before NOMAD can validate a new-money thesis. NOMAD keeps it in evidence research rather than applying the wrong generic model.'
    };
  }

  // Explicit negative evidence is different from missing evidence.
  // Missing evidence triggers research; verified weakness can reject a thesis.
  if (
    overall === 'WEAK' ||
    cash === 'WEAK'
  ) {
    return {
      state: 'REJECT',
      validationTier:
        extendedCoverage >= 67
          ? 'FULL_STATEMENT'
          : 'PSX_SUMMARY',
      reason:
        overall === 'WEAK'
          ? 'The available Financial Analyst evidence classifies the current financial view as weak.'
          : 'Verified cash-flow evidence is weak relative to reported earnings.'
    };
  }

  if (
    summaryCoverage < 80 ||
    overall === 'UNRELIABLE'
  ) {
    return {
      state: 'RESEARCHING',
      validationTier: 'INCOMPLETE_SUMMARY',
      reason:
        'Headline financial evidence is incomplete. NOMAD will keep researching the company and continue through the ranked universe instead of letting this missing evidence consume a deep-analysis slot.'
    };
  }

  if (
    earnings === 'QUESTIONABLE' ||
    cash === 'QUESTIONABLE' ||
    overall === 'MIXED'
  ) {
    return {
      state: 'REVIEW',
      validationTier:
        extendedCoverage >= 67
          ? 'FULL_STATEMENT'
          : 'PSX_SUMMARY',
      reason:
        'The evidence is usable, but a quality or trend concern prevents high-conviction validation.'
    };
  }

  const hasExtendedValidation =
    extendedCoverage >= 67 &&
    cash !== 'UNRELIABLE' &&
    balance !== 'UNRELIABLE' &&
    earnings !== 'UNRELIABLE';

  if (
    overall === 'GOOD' &&
    hasExtendedValidation
  ) {
    return {
      state: 'VALIDATED',
      validationTier: 'FULL_STATEMENT',
      reason:
        'Headline and extended financial evidence pass the current analyst gate.'
    };
  }

  if (overall === 'GOOD') {
    return {
      state: 'PARTIALLY_VALIDATED',
      validationTier: 'PSX_SUMMARY',
      reason:
        'Official PSX headline financials support the thesis, but full cash-flow/balance-sheet validation is not yet available. NOMAD can only consider staged exposure with lower confidence.'
    };
  }

  return {
    state: 'REVIEW',
    validationTier: 'PSX_SUMMARY',
    reason:
      'The headline evidence is usable but does not yet support a high-conviction thesis.'
  };
}

function decisionEvidenceProfile(
  candidate,
  analystGate
) {
  const analyst =
    candidate?.analystCore ||
    null;

  const summaryCoverage =
    safeNumber(
      analyst?.coverage
        ?.summaryCoveragePct ??
      analyst?.coverage
        ?.coreCoveragePct
    ) ||
    0;

  const extendedCoverage =
    safeNumber(
      analyst?.coverage
        ?.extendedCoveragePct
    ) ||
    0;

  const dataQuality =
    safeNumber(
      candidate?.dataQuality
        ?.score
    ) ||
    0;

  const evidenceState =
    String(
      candidate?.fundamentalEvidenceState ||
      ''
    );

  let freshnessScore = 85;

  if (
    evidenceState === 'LIVE' ||
    evidenceState === 'CACHE_FRESH'
  ) {
    freshnessScore = 100;
  } else if (
    evidenceState === 'CACHE_FALLBACK'
  ) {
    freshnessScore = 65;
  } else if (!evidenceState) {
    freshnessScore = 50;
  }

  let score =
    summaryCoverage * 0.40 +
    extendedCoverage * 0.25 +
    dataQuality * 0.20 +
    freshnessScore * 0.15;

  if (
    analystGate?.validationTier ===
      'SECTOR_MODEL_REQUIRED'
  ) {
    score = Math.min(
      score,
      45
    );
  }

  if (
    analystGate?.state ===
      'RESEARCHING'
  ) {
    score = Math.min(
      score,
      55
    );
  }

  score =
    decisionRound(
      decisionClamp(score),
      2
    );

  const confidence =
    score >= 82
      ? 'HIGH'
      : score >= 62
        ? 'MEDIUM'
        : score >= 42
          ? 'LOW'
          : 'UNRESOLVED';

  return {
    summaryCoveragePct:
      decisionRound(
        summaryCoverage,
        2
      ),
    extendedCoveragePct:
      decisionRound(
        extendedCoverage,
        2
      ),
    dataQualityPct:
      decisionRound(
        dataQuality,
        2
      ),
    freshnessScore,
    score,
    confidence,
    validationTier:
      analystGate?.validationTier ||
      'NONE',
    state:
      analystGate?.state ||
      'RESEARCHING',
    missingSummary:
      analyst?.coverage
        ?.coreMetricsMissing ||
      [],
    missingExtended:
      analyst?.coverage
        ?.extendedMetricsMissing ||
      []
  };
}


/* =========================================================
   PROFESSIONAL INVESTOR / TRADER DECISION FRAMEWORK - BUILD 0.9.1
   Long-term and short-term are separate analytical frameworks.
========================================================= */

function professionalStateScore(state, mapping) {
  const key = String(state || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(mapping, key)
    ? mapping[key]
    : 50;
}

function professionalFinancialQualityScore(analyst) {
  if (!analyst) {
    return 30;
  }

  const overall = professionalStateScore(
    analyst.overallFinancialView?.state,
    {
      STRONG: 92,
      GOOD: 82,
      ACCEPTABLE: 68,
      MIXED: 52,
      WEAK: 25,
      UNRELIABLE: 55
    }
  );

  const earnings = professionalStateScore(
    analyst.views?.earningsQuality?.state,
    {
      STRONG: 92,
      GOOD: 82,
      ACCEPTABLE: 70,
      IMPROVING: 78,
      QUESTIONABLE: 42,
      WEAK: 25,
      UNRELIABLE: 60
    }
  );

  const cash = professionalStateScore(
    analyst.views?.cashFlowQuality?.state,
    {
      STRONG: 90,
      GOOD: 80,
      ACCEPTABLE: 68,
      EVIDENCE_AVAILABLE: 65,
      QUESTIONABLE: 40,
      WEAK: 22,
      UNRELIABLE: 60
    }
  );

  const balance = professionalStateScore(
    analyst.views?.balanceSheet?.state,
    {
      STRONG: 90,
      GOOD: 80,
      ACCEPTABLE: 68,
      EVIDENCE_AVAILABLE: 65,
      QUESTIONABLE: 42,
      WEAK: 25,
      UNRELIABLE: 60
    }
  );

  return decisionRound(
    decisionClamp(
      overall * 0.40 +
      earnings * 0.25 +
      cash * 0.20 +
      balance * 0.15
    ),
    2
  );
}

function professionalValuationState(score) {
  const value = safeNumber(score) ?? 0;
  if (value >= 78) return 'ATTRACTIVE';
  if (value >= 62) return 'REASONABLE';
  if (value >= 48) return 'FAIR';
  return 'EXPENSIVE_OR_UNCLEAR';
}

function professionalRiskState(score) {
  const value = safeNumber(score) ?? 0;
  if (value >= 72) return 'LOW_TO_MODERATE';
  if (value >= 55) return 'ACCEPTABLE';
  if (value >= 40) return 'ELEVATED';
  return 'HIGH';
}

function professionalLongTermView(
  candidate,
  analystGate,
  evidence
) {
  const analyst = candidate?.analystCore || null;
  const financialScore =
    professionalFinancialQualityScore(analyst);
  const valuationScore =
    safeNumber(candidate?.valuation?.score) || 0;
  const riskScore =
    safeNumber(candidate?.risk?.score) || 0;
  // Long-term 0.9.2.6 behavior is intentionally frozen. The shared
  // historical context now exposes richer priceAction for the Trader brain,
  // but the Investor brain continues to use its pre-existing entry score so
  // short-term plumbing cannot silently change long-term rankings/actions.
  const timingScore =
    safeNumber(candidate?.entry?.score) ??
    50;
  const timingState =
    timingScore >= 72
      ? 'GOOD'
      : timingScore >= 58
        ? 'FAIR'
        : timingScore >= 42
          ? 'POOR'
          : 'RISKY';

  const thesisScore =
    decisionRound(
      decisionClamp(
        financialScore * 0.45 +
        valuationScore * 0.25 +
        riskScore * 0.15 +
        evidence.score * 0.15
      ),
      2
    );

  const rankingScore =
    decisionRound(
      decisionClamp(
        thesisScore * 0.90 +
        timingScore * 0.10
      ),
      2
    );

  let thesisStatus =
    financialScore >= 78
      ? 'STRONG'
      : financialScore >= 64
        ? 'ACCEPTABLE'
        : financialScore >= 48
          ? 'MIXED'
          : 'WEAK';

  let marketAction = 'WATCH';
  let opportunityTier = 'PRIORITY_2';
  let reason = 'The long-term thesis is not yet strong enough for new capital.';

  if (analystGate.state === 'RESEARCHING') {
    thesisStatus = 'UNRESOLVED';
    return {
      framework: 'LONG_TERM_INVESTOR',
      thesisStatus,
      financialScore,
      valuationScore,
      valuationState: professionalValuationState(valuationScore),
      riskScore,
      riskState: professionalRiskState(riskScore),
      timingScore,
      timingState,
      rankingScore,
      marketAction: 'RESEARCHING',
      opportunityTier: 'EVIDENCE_RESEARCH',
      reason: analystGate.reason
    };
  }

  if (
    analystGate.state === 'REJECT' ||
    financialScore < 42 ||
    riskScore < 38
  ) {
    return {
      framework: 'LONG_TERM_INVESTOR',
      thesisStatus: financialScore < 42 ? 'WEAK' : thesisStatus,
      financialScore,
      valuationScore,
      valuationState: professionalValuationState(valuationScore),
      riskScore,
      riskState: professionalRiskState(riskScore),
      timingScore,
      timingState,
      rankingScore,
      marketAction: 'AVOID',
      opportunityTier: 'LOW_PRIORITY',
      reason:
        analystGate.state === 'REJECT'
          ? analystGate.reason
          : financialScore < 42
            ? 'Long-term financial quality is too weak for a new position.'
            : 'Risk and liquidity are too weak for a long-term allocation.'
    };
  }

  const thesisStrong =
    thesisScore >= 68 &&
    financialScore >= 65 &&
    valuationScore >= 55 &&
    riskScore >= 48;

  const highConviction =
    thesisScore >= 76 &&
    financialScore >= 72 &&
    valuationScore >= 62 &&
    evidence.confidence !== 'UNRESOLVED';

  const thesisDescription =
    thesisStatus === 'STRONG'
      ? 'strong'
      : thesisStatus === 'ACCEPTABLE'
        ? 'acceptable'
        : thesisStatus === 'MIXED'
          ? 'mixed'
          : 'weak';

  if (thesisStrong) {
    if (timingState === 'GOOD') {
      marketAction =
        analystGate.state === 'VALIDATED' &&
        highConviction
          ? 'BUY'
          : 'ACCUMULATE';
      opportunityTier = 'PRIORITY_1';
      reason =
        marketAction === 'BUY'
          ? 'The long-term thesis, valuation, risk and current technical timing all support a new position.'
          : 'The long-term thesis is ' + thesisDescription + ', but NOMAD prefers staged exposure because conviction or evidence is not yet complete.';
    } else if (timingState === 'FAIR') {
      marketAction = 'ACCUMULATE';
      opportunityTier = 'PRIORITY_1';
      reason = 'The long-term thesis is ' + thesisDescription + '. Entry timing is acceptable but not strong enough to justify aggressive deployment.';
    } else {
      marketAction = 'WATCH';
      opportunityTier = 'PRIORITY_2';
      reason = 'The long-term thesis remains ' + thesisDescription + ', but current price action is poor or extended. NOMAD prefers to wait for a better entry rather than abandon the thesis.';
    }
  } else if (
    thesisScore >= 58 &&
    financialScore >= 55
  ) {
    marketAction = 'WATCH';
    opportunityTier = 'PRIORITY_2';
    reason = 'The company remains a credible long-term candidate, but expected return, evidence or financial quality is not yet strong enough for new capital.';
  }

  return {
    framework: 'LONG_TERM_INVESTOR',
    thesisStatus,
    financialScore,
    valuationScore,
    valuationState: professionalValuationState(valuationScore),
    riskScore,
    riskState: professionalRiskState(riskScore),
    timingScore,
    timingState,
    rankingScore,
    marketAction,
    opportunityTier,
    reason
  };
}

function decisionTraderEvidenceProfile(
  candidate
) {
  const context =
    candidate?.historicalContext ||
    null;
  const priceAction =
    context?.priceAction ||
    null;
  const technical =
    context?.technical ||
    {};
  const tradePlan =
    priceAction?.tradePlan ||
    null;

  let score = 0;
  const missing = [];

  if (context?.available) {
    score += 15;
  } else {
    missing.push('daily OHLC history');
  }

  if (
    safeNumber(context?.validSessions) >=
      DECISION_TRADER_MIN_VALID_SESSIONS
  ) {
    score += 10;
  } else {
    missing.push('sufficient recent sessions');
  }

  if (priceAction?.available) {
    score += 15;
  } else {
    missing.push('price-action structure');
  }

  if (safeNumber(technical.rsi14) !== null) {
    score += 8;
  } else {
    missing.push('RSI');
  }

  if (safeNumber(technical.macdHistogram) !== null) {
    score += 8;
  } else {
    missing.push('MACD');
  }

  if (safeNumber(technical.volumeRatio20d) !== null) {
    score += 8;
  } else {
    missing.push('volume confirmation');
  }

  if (safeNumber(priceAction?.atr14) !== null) {
    score += 8;
  } else {
    missing.push('ATR');
  }

  if (safeNumber(priceAction?.support) !== null) {
    score += 6;
  } else {
    missing.push('support');
  }

  if (safeNumber(priceAction?.resistance) !== null) {
    score += 6;
  } else {
    missing.push('resistance');
  }

  if (tradePlan?.complete) {
    score += 10;
  } else {
    missing.push('complete entry/stop/target plan');
  }

  const asOfMs =
    Date.parse(context?.asOf || '');
  const ageDays =
    Number.isFinite(asOfMs)
      ? Math.max(
          0,
          (Date.now() - asOfMs) /
            (24 * 60 * 60 * 1000)
        )
      : null;

  if (
    ageDays !== null &&
    ageDays <= 5
  ) {
    score += 6;
  } else {
    missing.push('recent technical session');
  }

  score = decisionRound(
    decisionClamp(score),
    2
  );

  const confidence =
    score >= 85
      ? 'HIGH'
      : score >= 70
        ? 'MEDIUM'
        : score >= 50
          ? 'LOW'
          : 'UNRESOLVED';

  return {
    framework: 'TRADER_TECHNICAL_EVIDENCE',
    confidence,
    score,
    technicalCoveragePct: score,
    tradePlanCoveragePct:
      tradePlan?.complete
        ? 100
        : 0,
    // Generic aliases retained for storage/UI compatibility. In short-term
    // mode these represent technical evidence, not financial-statement depth.
    summaryCoveragePct: score,
    extendedCoveragePct:
      tradePlan?.complete
        ? 100
        : 0,
    validationTier:
      tradePlan?.complete
        ? 'TRADE_PLAN_DEFINED'
        : priceAction?.available
          ? 'TECHNICAL_CONTEXT_ONLY'
          : 'TECHNICAL_DATA_INCOMPLETE',
    setupCompleteness:
      tradePlan?.complete
        ? 'COMPLETE'
        : 'INCOMPLETE',
    missing,
    validSessions:
      safeNumber(context?.validSessions),
    asOf:
      context?.asOf ||
      null,
    ageDays:
      decisionRound(ageDays, 2)
  };
}

function decisionTraderRiskBudgetPct(
  riskPolicy
) {
  if (
    riskPolicy?.id ===
      'RISK-CONSERVATIVE-0.1'
  ) {
    return DECISION_TRADER_RISK_BUDGET_PCT.conservative;
  }

  if (
    riskPolicy?.id ===
      'RISK-AGGRESSIVE-0.1'
  ) {
    return DECISION_TRADER_RISK_BUDGET_PCT.aggressive;
  }

  return DECISION_TRADER_RISK_BUDGET_PCT.balanced;
}

function professionalShortTermView(
  candidate,
  analystGate,
  evidence
) {
  const priceAction =
    candidate?.historicalContext
      ?.priceAction ||
    null;

  const tradePlan =
    priceAction?.tradePlan ||
    null;

  const traderEvidence =
    evidence?.framework ===
      'TRADER_TECHNICAL_EVIDENCE'
      ? evidence
      : decisionTraderEvidenceProfile(
          candidate
        );

  const timingScore =
    safeNumber(priceAction?.timingScore) ??
    safeNumber(candidate?.entry?.score) ??
    0;
  const riskScore =
    safeNumber(candidate?.risk?.score) || 0;
  const liquidityScore =
    safeNumber(candidate?.risk?.liquidityScore) || 0;
  const technicalEvidenceScore =
    safeNumber(traderEvidence?.score) || 0;
  const rewardRisk =
    safeNumber(tradePlan?.rewardRisk);
  const setup =
    priceAction?.setup ||
    'NO_CLEAR_SETUP';

  const setupQuality =
    setup === 'CONFIRMED_BREAKOUT'
      ? 95
      : setup === 'TREND_PULLBACK'
        ? 88
        : setup === 'UPTREND_CONTINUATION'
          ? 76
          : setup === 'UNCONFIRMED_BREAKOUT'
            ? 62
            : setup === 'NO_CLEAR_SETUP'
              ? 45
              : setup === 'DOWNTREND'
                ? 25
                : setup === 'BREAKDOWN'
                  ? 10
                  : 40;

  const rankingScore =
    decisionRound(
      decisionClamp(
        timingScore * 0.38 +
        setupQuality * 0.22 +
        riskScore * 0.15 +
        liquidityScore * 0.10 +
        technicalEvidenceScore * 0.15
      ),
      2
    );

  if (
    !priceAction?.available ||
    traderEvidence.confidence ===
      'UNRESOLVED'
  ) {
    return {
      framework: 'SHORT_TERM_TRADER',
      thesisStatus: 'NO_SETUP_DATA',
      timingScore,
      timingState: 'UNAVAILABLE',
      setup,
      rewardRisk,
      riskScore,
      riskState:
        professionalRiskState(
          riskScore
        ),
      rankingScore,
      technicalEvidence:
        traderEvidence,
      tradePlan,
      marketAction: 'RESEARCHING',
      opportunityTier: 'EVIDENCE_RESEARCH',
      reason:
        'Short-term technical evidence is incomplete. NOMAD is refreshing OHLC, momentum, volume and price-action context before forming a trade view.'
    };
  }

  if (
    setup === 'BREAKDOWN' ||
    setup === 'DOWNTREND' ||
    riskScore < 35
  ) {
    return {
      framework: 'SHORT_TERM_TRADER',
      thesisStatus: 'UNFAVORABLE_SETUP',
      timingScore,
      timingState:
        priceAction.timingState,
      setup,
      rewardRisk,
      riskScore,
      riskState:
        professionalRiskState(
          riskScore
        ),
      rankingScore,
      technicalEvidence:
        traderEvidence,
      tradePlan,
      marketAction: 'AVOID',
      opportunityTier: 'LOW_PRIORITY',
      reason:
        setup === 'BREAKDOWN'
          ? 'Price structure is in a confirmed breakdown state, so NOMAD will not initiate a long trade.'
          : setup === 'DOWNTREND'
            ? 'The current short-term structure is bearish. NOMAD waits for a new bullish setup rather than buying weakness.'
            : 'Short-term market/liquidity risk is below the trader framework minimum.'
    };
  }

  const definedTradePlan =
    tradePlan?.complete === true &&
    rewardRisk !== null;

  const actionableSetup =
    (
      setup === 'CONFIRMED_BREAKOUT' ||
      setup === 'TREND_PULLBACK' ||
      setup === 'UPTREND_CONTINUATION'
    ) &&
    timingScore >= 68 &&
    riskScore >= 45 &&
    technicalEvidenceScore >= 70 &&
    definedTradePlan &&
    rewardRisk >=
      DECISION_TRADER_MIN_REWARD_RISK;

  if (actionableSetup) {
    return {
      framework: 'SHORT_TERM_TRADER',
      thesisStatus: 'ACTIVE_SETUP',
      timingScore,
      timingState:
        priceAction.timingState,
      setup,
      rewardRisk,
      riskScore,
      riskState:
        professionalRiskState(
          riskScore
        ),
      rankingScore,
      technicalEvidence:
        traderEvidence,
      tradePlan,
      marketAction: 'BUY',
      opportunityTier: 'PRIORITY_1',
      reason:
        'A defined short-term setup passes trend/price-action, risk, technical-evidence and reward-to-risk gates. Entry, invalidation and target are explicitly defined.'
    };
  }

  let reason =
    'The stock is technically interesting, but the setup does not yet pass the full short-term trade gate.';

  if (!definedTradePlan) {
    reason =
      'Technical context is available, but NOMAD cannot yet define a complete entry, invalidation and target. No trade is permitted without a complete plan.';
  } else if (
    rewardRisk <
      DECISION_TRADER_MIN_REWARD_RISK
  ) {
    reason =
      'The setup is visible, but the defined reward-to-risk is below NOMAD\'s minimum ' +
      DECISION_TRADER_MIN_REWARD_RISK +
      ':1 trade threshold.';
  } else if (
    setup === 'UNCONFIRMED_BREAKOUT'
  ) {
    reason =
      'Price is attempting a breakout, but confirmation is incomplete. NOMAD waits for confirmation rather than chasing the move.';
  } else if (timingScore < 68) {
    reason =
      'The setup exists, but current momentum/price-action timing is not strong enough for entry.';
  }

  return {
    framework: 'SHORT_TERM_TRADER',
    thesisStatus:
      definedTradePlan
        ? 'WATCH_SETUP'
        : 'SETUP_INCOMPLETE',
    timingScore,
    timingState:
      priceAction.timingState,
    setup,
    rewardRisk,
    riskScore,
    riskState:
      professionalRiskState(
        riskScore
      ),
    rankingScore,
    technicalEvidence:
      traderEvidence,
    tradePlan,
    marketAction: 'WATCH',
    opportunityTier: 'PRIORITY_2',
    reason
  };
}

function professionalDecisionView(
  candidate,
  analystGate,
  evidence
) {
  return String(candidate?.horizon || 'long_term') === 'short_term'
    ? professionalShortTermView(candidate, analystGate, evidence)
    : professionalLongTermView(candidate, analystGate, evidence);
}

function decisionCanonicalCompanyState(
  candidate
) {
  const shortTermMode =
    String(
      candidate?.horizon ||
      'long_term'
    ) === 'short_term';

  const analystGate =
    shortTermMode
      ? {
          state: 'NOT_REQUIRED',
          validationTier: 'TRADER_TECHNICAL',
          reason:
            'Short-term market action is driven by technical setup evidence. Financial evidence remains secondary context and does not block a trade merely because it is incomplete.'
        }
      : decisionCenterAnalystGate(
          candidate
        );

  const evidence =
    shortTermMode
      ? decisionTraderEvidenceProfile(
          candidate
        )
      : decisionEvidenceProfile(
          candidate,
          analystGate
        );

  const professional =
    professionalDecisionView(
      candidate,
      analystGate,
      evidence
    );

  const researchState =
    professional.opportunityTier ===
      'EVIDENCE_RESEARCH'
      ? 'ACTIVE'
      : 'COMPLETE';

  const marketAction =
    professional.marketAction;

  const opportunityTier =
    professional.opportunityTier;

  const allocationAllowed =
    (
      marketAction === 'BUY' ||
      marketAction === 'ACCUMULATE'
    ) &&
    researchState !== 'ACTIVE';

  const allocationReason =
    allocationAllowed
      ? 'The professional framework produced an actionable market state and evidence research is complete.'
      : researchState === 'ACTIVE'
        ? 'Automatic evidence research is still active, so allocation is blocked.'
        : marketAction === 'WATCH'
          ? 'WATCH is never allowed to receive new capital.'
          : 'The professional framework does not permit a new-money allocation.';

  return {
    securityState:
      'ACTIVE_CANDIDATE',
    evidence,
    analystGate,
    professional,
    researchState,
    marketAction,
    opportunityTier,
    reason:
      professional.reason,
    rankingScore:
      professional.rankingScore,
    thesisStatus:
      professional.thesisStatus,
    allocationPermission: {
      allowed:
        allocationAllowed,
      reason:
        allocationReason
    }
  };
}

function decisionCenterCandidateView(
  candidate
) {
  const canonicalState =
    decisionCanonicalCompanyState(
      candidate
    );

  const coverage =
    safeNumber(
      candidate?.analystCore
        ?.coverage
        ?.summaryCoveragePct ??
      candidate?.analystCore
        ?.coverage
        ?.coreCoveragePct
    ) ||
    0;

  const rankScore =
    decisionRound(
      safeNumber(
        canonicalState.rankingScore
      ) ??
      (
        safeNumber(
          candidate?.overallScore
        ) ||
        0
      ),
      2
    );

  return {
    ...candidate,
    canonicalState,
    analystGate:
      canonicalState.analystGate,
    decisionCenterView:
      canonicalState.marketAction,
    decisionCenterBucket:
      canonicalState.opportunityTier,
    decisionCenterReason:
      canonicalState.reason,
    opportunityRankScore:
      rankScore
  };
}

function decisionCenterSummary(
  candidate,
  rank
) {
  const analyst =
    candidate?.analystCore ||
    null;

  const canonical =
    candidate?.canonicalState ||
    decisionCanonicalCompanyState(
      candidate
    );

  return {
    rank,
    symbol:
      candidate.symbol,
    companyName:
      candidate.companyName,
    sector:
      candidate.sector,
    price:
      candidate.price,
    marketAsOf:
      candidate.marketAsOf,
    decisionCenterView:
      canonical.marketAction,
    reason:
      canonical.reason,
    analystGate:
      canonical.analystGate,
    canonicalState:
      canonical,
    professional:
      canonical.professional || null,
    thesisStatus:
      canonical.thesisStatus || null,
    allocationPermission:
      canonical.allocationPermission,
    profileSuitability:
      candidate.profileSuitability ||
      null,
    opportunityRankScore:
      candidate.opportunityRankScore,
    overallScore:
      candidate.overallScore,
    fundamentalScore:
      candidate.fundamental?.score ??
      null,
    valuationScore:
      candidate.valuation?.score ??
      null,
    entryScore:
      candidate.entry?.score ??
      null,
    riskScore:
      candidate.risk?.score ??
      null,
    dataQualityScore:
      candidate.dataQuality?.score ??
      null,
    analyst: {
      status:
        analyst?.status ||
        'UNAVAILABLE',
      financialView:
        analyst?.overallFinancialView
          ?.state ||
        'UNAVAILABLE',
      coveragePct:
        canonical.evidence
          .summaryCoveragePct,
      extendedCoveragePct:
        canonical.evidence
          .extendedCoveragePct,
      evidenceConfidence:
        canonical.evidence
          .confidence,
      evidenceScore:
        canonical.evidence
          .score,
      evidenceTier:
        canonical.evidence
          .validationTier,
      researchState:
        canonical.researchState,
      earningsQuality:
        analyst?.views
          ?.earningsQuality
          ?.state ||
        'UNAVAILABLE',
      cashFlowQuality:
        analyst?.views
          ?.cashFlowQuality
          ?.state ||
        'UNAVAILABLE',
      balanceSheet:
        analyst?.views
          ?.balanceSheet
          ?.state ||
        'UNAVAILABLE'
    },
    positives:
      canonical.professional
        ?.framework ===
        'SHORT_TERM_TRADER'
        ? candidate.historicalContext
            ?.priceAction
            ?.positives ||
          []
        : candidate.narrative
            ?.positives ||
          [],
    risks:
      canonical.professional
        ?.framework ===
        'SHORT_TERM_TRADER'
        ? candidate.historicalContext
            ?.priceAction
            ?.risks ||
          []
        : candidate.narrative
            ?.risks ||
          []
  };
}

function buildDecisionOpportunityBoard(
  candidates
) {
  const enriched =
    (candidates || [])
      .map(
        decisionCenterCandidateView
      );

  const sortGroup =
    list =>
      list.sort(
        (
          a,
          b
        ) =>
          b.opportunityRankScore -
          a.opportunityRankScore
      );

  const priority1 =
    sortGroup(
      enriched.filter(
        item =>
          item.canonicalState
            ?.opportunityTier ===
            'PRIORITY_1'
      )
    )
      .slice(0, 5);

  const priority2 =
    sortGroup(
      enriched.filter(
        item =>
          item.canonicalState
            ?.opportunityTier ===
            'PRIORITY_2'
      )
    )
      .slice(0, 5);

  const evidenceResearch =
    sortGroup(
      enriched.filter(
        item =>
          item.canonicalState
            ?.opportunityTier ===
            'EVIDENCE_RESEARCH'
      )
    )
      .slice(0, 5);

  const avoid =
    sortGroup(
      enriched.filter(
        item =>
          item.canonicalState
            ?.opportunityTier ===
            'LOW_PRIORITY'
      )
    )
      .slice(0, 5);

  const summarize =
    list =>
      list.map(
        (item, index) =>
          decisionCenterSummary(
            item,
            index + 1
          )
      );

  const researchSummaries =
    summarize(
      evidenceResearch
    );

  return {
    priority1:
      summarize(
        priority1
      ),
    priority2:
      summarize(
        priority2
      ),
    evidenceResearch:
      researchSummaries,
    // Backwards-compatible alias for older UI/storage readers.
    researchRequired:
      researchSummaries,
    avoid:
      summarize(
        avoid
      ),
    all:
      enriched
  };
}

async function buildDecisionPortfolioContext(
  market
) {
  try {
    const holdings =
      await readPortfolioHoldings();

    if (
      !holdings.configured ||
      !holdings.rows.length
    ) {
      return {
        configured:
          holdings.configured,
        holdingCount: 0,
        currentValuePkr: 0,
        symbolValues: {},
        sectorValues: {}
      };
    }

    const marketMap =
      new Map(
        (market?.stocks || [])
          .map(
            row => [
              normalizeSymbol(
                row.symbol
              ),
              row
            ]
          )
      );

    const symbolValues = {};
    const sectorValues = {};
    let currentValuePkr = 0;

    for (
      const holding
      of holdings.rows
    ) {
      const symbol =
        normalizeSymbol(
          holding.symbol
        );

      const quantity =
        safeNumber(
          holding.quantity
        ) ||
        0;

      const marketRow =
        marketMap.get(
          symbol
        ) ||
        null;

      const price =
        safeNumber(
          marketRow?.price
        );

      if (
        !symbol ||
        quantity <= 0 ||
        price === null ||
        price <= 0
      ) {
        continue;
      }

      const value =
        quantity *
        price;

      const sector =
        marketRow?.sector ||
        getUniverseMasterEntry(
          symbol
        )?.sector ||
        'Unknown';

      symbolValues[symbol] =
        (
          symbolValues[symbol] ||
          0
        ) +
        value;

      sectorValues[sector] =
        (
          sectorValues[sector] ||
          0
        ) +
        value;

      currentValuePkr +=
        value;
    }

    return {
      configured: true,
      holdingCount:
        Object.keys(
          symbolValues
        ).length,
      currentValuePkr:
        decisionRound(
          currentValuePkr,
          2
        ),
      symbolValues,
      sectorValues
    };
  } catch {
    return {
      configured: false,
      holdingCount: 0,
      currentValuePkr: 0,
      symbolValues: {},
      sectorValues: {}
    };
  }
}

function decisionProfileSuitability(
  candidate,
  riskPolicy
) {
  const issues = [];

  if (
    candidate?.recommendationEligible ===
      false
  ) {
    issues.push(
      'This security is not eligible for NOMAD new-money recommendations.'
    );
  }

  if (
    (candidate?.statusCodes || [])
      .includes('NC')
  ) {
    issues.push(
      'PSX non-compliant-segment status is present.'
    );
  }

  const avgVolume =
    safeNumber(
      candidate?.averageVolume30d
    );

  if (
    avgVolume === null ||
    avgVolume <
      riskPolicy.minAverageVolume30d
  ) {
    issues.push(
      '30-day liquidity is below the selected risk profile minimum.'
    );
  }

  const volatility =
    safeNumber(
      candidate?.historicalContext
        ?.technical
        ?.annualizedVolatility20dPct
    );

  if (
    volatility !== null &&
    volatility >
      riskPolicy.maxAnnualizedVolatilityPct
  ) {
    issues.push(
      'Recent annualized volatility exceeds the selected risk profile limit.'
    );
  }

  const shortTermMode =
    String(
      candidate?.horizon ||
      'long_term'
    ) === 'short_term';

  const applicableDataQualityScore =
    shortTermMode
      ? safeNumber(
          decisionTraderEvidenceProfile(
            candidate
          ).score
        )
      : safeNumber(
          candidate?.dataQuality?.score
        );

  if (
    applicableDataQualityScore <
      riskPolicy.minDataQualityScore
  ) {
    issues.push(
      shortTermMode
        ? 'Technical evidence quality is below the selected risk profile minimum.'
        : 'Data quality is below the selected risk profile minimum.'
    );
  }

  if (
    safeNumber(
      candidate?.risk?.score
    ) <
      riskPolicy.minRiskScore
  ) {
    issues.push(
      'Risk quality is below the selected risk profile minimum.'
    );
  }

  return {
    state:
      issues.length
        ? 'NOT_SUITABLE'
        : 'SUITABLE',
    issues,
    profileId:
      riskPolicy.id,
    thresholds: {
      minAverageVolume30d:
        riskPolicy.minAverageVolume30d,
      maxAnnualizedVolatilityPct:
        riskPolicy.maxAnnualizedVolatilityPct,
      minDataQualityScore:
        riskPolicy.minDataQualityScore,
      minRiskScore:
        riskPolicy.minRiskScore
    },
    observations: {
      averageVolume30d:
        avgVolume,
      annualizedVolatility20dPct:
        volatility,
      dataQualityScore:
        applicableDataQualityScore,
      riskScore:
        safeNumber(
          candidate?.risk?.score
        )
    }
  };
}

function decisionCenterTargetPositionCount(
  totalCapitalPkr,
  riskPolicy
) {
  const capital =
    Math.max(
      0,
      safeNumber(
        totalCapitalPkr
      ) ||
      0
    );

  // Locked professional portfolio-construction policy:
  // 3 is the minimum diversification TARGET, never a forced allocation.
  // The preferred count grows with capital, while the hard design ceiling is 8.
  // If fewer than 3 stocks pass the analyst/evidence/profile/portfolio gates,
  // NOMAD keeps the remainder in cash and reports a diversification exception.
  let target = 3;

  if (capital >= 25000) {
    target = 4;
  }

  if (capital >= 100000) {
    target = 5;
  }

  if (capital >= 300000) {
    target = 6;
  }

  if (capital >= 750000) {
    target = 7;
  }

  if (capital >= 2000000) {
    target = 8;
  }

  if (
    riskPolicy?.id ===
      'RISK-CONSERVATIVE-0.1'
  ) {
    target += 1;
  }

  if (
    riskPolicy?.id ===
      'RISK-AGGRESSIVE-0.1'
  ) {
    target -= 1;
  }

  return Math.max(
    DECISION_CENTER_MIN_TARGET_POSITIONS,
    Math.min(
      DECISION_CENTER_MAX_TARGET_POSITIONS,
      target
    )
  );
}

function decisionCenterDynamicCaps(
  targetPositions,
  riskPolicy
) {
  const count =
    Math.max(
      DECISION_CENTER_MIN_TARGET_POSITIONS,
      Number(
        targetPositions
      ) ||
      DECISION_CENTER_MIN_TARGET_POSITIONS
    );

  let stockMultiplier = 1.35;
  let minimumStockCap = 0.12;
  let sectorMultiplier = 2.1;
  let minimumSectorCap = 0.25;

  if (
    riskPolicy?.id ===
      'RISK-CONSERVATIVE-0.1'
  ) {
    stockMultiplier = 1.20;
    minimumStockCap = 0.10;
    sectorMultiplier = 1.90;
    minimumSectorCap = 0.22;
  }

  if (
    riskPolicy?.id ===
      'RISK-AGGRESSIVE-0.1'
  ) {
    stockMultiplier = 1.60;
    minimumStockCap = 0.15;
    sectorMultiplier = 2.20;
    minimumSectorCap = 0.35;
  }

  const stockCapPct =
    Math.min(
      safeNumber(
        riskPolicy?.maxStockPct
      ) ||
      1,
      Math.max(
        minimumStockCap,
        stockMultiplier /
        count
      )
    );

  const sectorCapPct =
    Math.min(
      safeNumber(
        riskPolicy?.maxSectorPct
      ) ||
      1,
      Math.max(
        minimumSectorCap,
        stockCapPct *
        sectorMultiplier
      )
    );

  return {
    stockCapPct,
    sectorCapPct
  };
}

function decisionCenterCandidateConviction(
  candidate
) {
  const professional =
    candidate?.canonicalState
      ?.professional ||
    candidate?.professional ||
    {};

  const evidenceScore =
    safeNumber(
      candidate?.canonicalState
        ?.evidence?.score
    ) ??
    safeNumber(
      candidate?.analyst?.evidenceScore
    ) ??
    50;

  const rankingScore =
    safeNumber(
      candidate?.opportunityRankScore
    ) ??
    safeNumber(
      professional?.rankingScore
    ) ??
    50;

  const riskScore =
    safeNumber(
      professional?.riskScore
    ) ??
    safeNumber(
      candidate?.risk?.score
    ) ??
    50;

  if (
    professional?.framework ===
      'SHORT_TERM_TRADER'
  ) {
    const timingScore =
      safeNumber(
        professional?.timingScore
      ) ??
      safeNumber(
        candidate?.entry?.score
      ) ??
      50;

    const liquidityScore =
      safeNumber(
        candidate?.risk?.liquidityScore
      ) ??
      50;

    return decisionRound(
      decisionClamp(
        rankingScore * 0.25 +
        timingScore * 0.35 +
        riskScore * 0.20 +
        liquidityScore * 0.10 +
        evidenceScore * 0.10
      ),
      2
    );
  }

  const financialScore =
    safeNumber(
      professional?.financialScore
    ) ??
    safeNumber(
      candidate?.fundamental?.score
    ) ??
    50;

  const valuationScore =
    safeNumber(
      professional?.valuationScore
    ) ??
    safeNumber(
      candidate?.valuation?.score
    ) ??
    50;

  const timingScore =
    safeNumber(
      professional?.timingScore
    ) ??
    safeNumber(
      candidate?.entry?.score
    ) ??
    50;

  return decisionRound(
    decisionClamp(
      rankingScore * 0.30 +
      financialScore * 0.20 +
      valuationScore * 0.15 +
      riskScore * 0.15 +
      timingScore * 0.10 +
      evidenceScore * 0.10
    ),
    2
  );
}

function decisionCenterDeploymentPlan(
  candidates,
  targetPositions,
  riskPolicy
) {
  const list =
    Array.isArray(candidates)
      ? candidates
      : [];

  if (!list.length) {
    return {
      targetDeploymentPct: 0,
      intentionalCashReservePct: 100,
      averageConvictionScore: 0,
      averageExtendedCoveragePct: 0,
      reason:
        'No profile-suitable actionable opportunities passed the professional allocation gate.'
    };
  }

  const averageConvictionScore =
    list.reduce(
      (sum, candidate) =>
        sum +
        (
          safeNumber(
            candidate.allocationConvictionScore
          ) ||
          decisionCenterCandidateConviction(
            candidate
          )
        ),
      0
    ) /
    list.length;

  const averageExtendedCoveragePct =
    list.reduce(
      (sum, candidate) =>
        sum +
        (
          safeNumber(
            candidate?.canonicalState
              ?.evidence
              ?.extendedCoveragePct
          ) ||
          0
        ),
      0
    ) /
    list.length;

  const confidenceValues =
    list.map(
      candidate =>
        String(
          candidate?.canonicalState
            ?.evidence
            ?.confidence ||
          'LOW'
        )
    );

  const mediumOrBetterRatio =
    confidenceValues.filter(
      value =>
        value === 'HIGH' ||
        value === 'MEDIUM'
    ).length /
    list.length;

  let baseDeploymentPct = 0.86;

  if (
    riskPolicy?.id ===
      'RISK-CONSERVATIVE-0.1'
  ) {
    baseDeploymentPct = 0.76;
  } else if (
    riskPolicy?.id ===
      'RISK-AGGRESSIVE-0.1'
  ) {
    baseDeploymentPct = 0.90;
  }

  const target =
    Math.max(
      DECISION_CENTER_MIN_TARGET_POSITIONS,
      Number(targetPositions) ||
      DECISION_CENTER_MIN_TARGET_POSITIONS
    );

  const breadthRatio =
    Math.min(
      1,
      list.length /
      target
    );

  let breadthPenalty = 0;

  if (list.length === 1) {
    breadthPenalty = 0.24;
  } else if (list.length === 2) {
    breadthPenalty = 0.15;
  } else if (breadthRatio < 1) {
    breadthPenalty =
      (1 - breadthRatio) *
      0.10;
  }

  const evidencePenalty =
    mediumOrBetterRatio >= 0.99
      ? 0
      : mediumOrBetterRatio >= 0.66
        ? 0.025
        : 0.08;

  const extendedEvidencePenalty =
    averageExtendedCoveragePct >= 67
      ? 0
      : averageExtendedCoveragePct >= 25
        ? 0.02
        : 0.04;

  const convictionAdjustment =
    Math.max(
      -0.05,
      Math.min(
        0.05,
        (
          averageConvictionScore -
          70
        ) /
        300
      )
    );

  const minimumDeploymentPct =
    list.length >= 3
      ? 0.62
      : list.length === 2
        ? 0.42
        : 0.28;

  const targetDeploymentPct =
    Math.max(
      minimumDeploymentPct,
      Math.min(
        DECISION_CENTER_MAX_DEPLOYMENT_PCT,
        baseDeploymentPct +
        convictionAdjustment -
        breadthPenalty -
        evidencePenalty -
        extendedEvidencePenalty
      )
    );

  const roundedDeploymentPct =
    decisionRound(
      targetDeploymentPct *
      100,
      2
    );

  const reservePct =
    decisionRound(
      100 -
      roundedDeploymentPct,
      2
    );

  const reasons = [];

  if (list.length < target) {
    reasons.push(
      'Only ' +
      list.length +
      ' suitable actionable idea' +
      (list.length === 1 ? '' : 's') +
      ' passed against a target of ' +
      target +
      '.'
    );
  }

  if (averageExtendedCoveragePct < 67) {
    reasons.push(
      'Extended financial validation is incomplete across the funded opportunity set.'
    );
  }

  if (averageConvictionScore < 72) {
    reasons.push(
      'Average conviction is not high enough to justify maximum deployment.'
    );
  }

  if (!reasons.length) {
    reasons.push(
      'Opportunity breadth, conviction and evidence support a high deployment level while preserving a deliberate liquidity reserve.'
    );
  }

  return {
    targetDeploymentPct:
      roundedDeploymentPct,
    intentionalCashReservePct:
      reservePct,
    averageConvictionScore:
      decisionRound(
        averageConvictionScore,
        2
      ),
    averageExtendedCoveragePct:
      decisionRound(
        averageExtendedCoveragePct,
        2
      ),
    reason:
      reasons.join(' ')
  };
}

function decisionCenterFinancialSectorCandidate(
  candidate
) {
  if (
    candidate?.analystCore
      ?.company
      ?.financialSector ===
        true
  ) {
    return true;
  }

  const sector =
    String(
      candidate?.sector ||
      ''
    ).toLowerCase();

  return (
    sector.includes('commercial bank') ||
    sector.includes('bank') ||
    sector.includes('insurance') ||
    sector.includes('leasing') ||
    sector.includes('investment bank') ||
    sector.includes('securities') ||
    sector.includes('modaraba')
  );
}

function decisionCenterAllocationCandidatePool(
  opportunityBoard,
  riskPolicy,
  targetPositions
) {
  const all =
    Array.isArray(
      opportunityBoard?.all
    )
      ? opportunityBoard.all
      : [];

  const eligible =
    all
      .map(
        item => ({
          item,
          profileSuitability:
            item?.profileSuitability ||
            decisionProfileSuitability(
              item,
              riskPolicy
            )
        })
      )
      .filter(
        wrapped =>
          wrapped.item?.canonicalState
            ?.allocationPermission
            ?.allowed === true &&
          wrapped.profileSuitability
            ?.state === 'SUITABLE' &&
          (
            wrapped.item.canonicalState
              ?.marketAction === 'BUY' ||
            wrapped.item.canonicalState
              ?.marketAction === 'ACCUMULATE'
          )
      )
      .map(
        wrapped => {
          const item =
            wrapped.item;

          const profileSuitability =
            wrapped.profileSuitability;
          const action =
            item.canonicalState
              .marketAction;

          const tier =
            item.canonicalState
              .opportunityTier;

          const confidence =
            item.canonicalState
              .evidence
              .confidence;

          const actionMultiplier =
            action === 'BUY'
              ? 1
              : 0.76;

          const tierMultiplier =
            tier === 'PRIORITY_1'
              ? 1
              : 0.72;

          const confidenceMultiplier =
            confidence === 'HIGH'
              ? 1
              : confidence === 'MEDIUM'
                ? 0.86
                : 0.68;

          const riskScore =
            safeNumber(
              item.risk?.score
            ) ||
            50;

          const entryScore =
            safeNumber(
              item.entry?.score
            ) ||
            50;

          const riskMultiplier =
            0.82 +
            decisionClamp(
              riskScore
            ) /
            100 *
            0.24;

          const entryMultiplier =
            0.86 +
            decisionClamp(
              entryScore
            ) /
            100 *
            0.18;

          const allocationConvictionScore =
            decisionCenterCandidateConviction(
              item
            );

          const allocationStrengthMultiplier =
            actionMultiplier *
            tierMultiplier *
            confidenceMultiplier *
            riskMultiplier *
            entryMultiplier;

          let allocationCapMultiplier =
            action === 'BUY'
              ? 1
              : 0.84;

          if (
            tier === 'PRIORITY_2'
          ) {
            allocationCapMultiplier *=
              0.72;
          }

          if (
            confidence === 'LOW'
          ) {
            allocationCapMultiplier *=
              0.75;
          }

          return {
            ...item,
            profileSuitability,
            allocationTier:
              tier,
            allocationConvictionScore,
            allocationStrengthMultiplier,
            allocationCapMultiplier
          };
        }
      )
      .sort(
        (
          a,
          b
        ) => {
          if (
            a.allocationTier !==
            b.allocationTier
          ) {
            return a.allocationTier ===
              'PRIORITY_1'
                ? -1
                : 1;
          }

          return (
            b.opportunityRankScore -
            a.opportunityRankScore
          );
        }
      );

  // Keep a small ranked reserve beyond the preferred funded count so the
  // allocator can backfill when a higher-ranked name cannot fit because of
  // whole-share, stock-cap, sector-cap, or existing-portfolio constraints.
  const reserveLimit =
    Math.min(
      eligible.length,
      Math.max(
        DECISION_CENTER_MIN_TARGET_POSITIONS,
        Math.min(
          12,
          Number(targetPositions || 0) + 4
        )
      )
    );

  return eligible.slice(
    0,
    reserveLimit
  );
}

function allocateDecisionCenterOpportunities(
  opportunityBoard,
  amount,
  riskPolicy,
  portfolioContext = null
) {
  const budgetPaisa =
    Math.max(
      0,
      Math.round(
        Number(amount) *
        100
      )
    );

  const existingPortfolioValuePaisa =
    Math.max(
      0,
      Math.round(
        (
          safeNumber(
            portfolioContext
              ?.currentValuePkr
          ) ||
          0
        ) *
        100
      )
    );

  const postFundingCapitalBasePaisa =
    existingPortfolioValuePaisa +
    budgetPaisa;

  const targetPositionCount =
    decisionCenterTargetPositionCount(
      postFundingCapitalBasePaisa /
      100,
      riskPolicy
    );

  const existingSymbolValues =
    portfolioContext?.symbolValues ||
    {};

  const existingSectorValues =
    portfolioContext?.sectorValues ||
    {};

  const candidates =
    decisionCenterAllocationCandidatePool(
      opportunityBoard,
      riskPolicy,
      targetPositionCount
    );

  const sizingPositionCount =
    Math.max(
      DECISION_CENTER_MIN_TARGET_POSITIONS,
      Math.min(
        targetPositionCount,
        Math.max(
          DECISION_CENTER_MIN_TARGET_POSITIONS,
          candidates.length
        )
      )
    );

  const dynamicCaps =
    decisionCenterDynamicCaps(
      sizingPositionCount,
      riskPolicy
    );

  const deploymentPlan =
    decisionCenterDeploymentPlan(
      candidates,
      targetPositionCount,
      riskPolicy
    );

  const deployCap =
    Math.floor(
      budgetPaisa *
      deploymentPlan.targetDeploymentPct /
      100
    );

  if (!candidates.length) {
    return {
      allocations: [],
      amountInvestedPkr: 0,
      cashRemainingPkr:
        decisionRound(
          amount,
          2
        ),
      investedPct: 0,
      deploymentCapPct:
        deploymentPlan.targetDeploymentPct,
      portfolioAware:
        Boolean(
          portfolioContext?.holdingCount
        ),
      existingPortfolioValuePkr:
        decisionRound(
          existingPortfolioValuePaisa /
          100,
          2
        ),
      targetPositionCount,
      sizingPositionCount,
      targetDeploymentPct:
        deploymentPlan.targetDeploymentPct,
      intentionalCashReservePct:
        deploymentPlan.intentionalCashReservePct,
      averageConvictionScore:
        deploymentPlan.averageConvictionScore,
      cashReserveReason:
        deploymentPlan.reason,
      minimumTargetPositions:
        DECISION_CENTER_MIN_TARGET_POSITIONS,
      maximumTargetPositions:
        DECISION_CENTER_MAX_TARGET_POSITIONS,
      achievedPositionCount: 0,
      diversificationException: {
        triggered: true,
        reason:
          'No profile-suitable actionable stock currently passes the full allocation gate, so NOMAD retains the capital in cash rather than forcing positions.'
      },
      eligibleAllocationCandidates: 0,
      priorityOneAllocationCandidates: 0,
      priorityTwoAllocationCandidates: 0,
      dynamicMaxStockPct:
        decisionRound(
          dynamicCaps.stockCapPct *
          100,
          2
        ),
      dynamicMaxSectorPct:
        decisionRound(
          dynamicCaps.sectorCapPct *
          100,
          2
        ),
      unfundedPriorityOne: [],
      personalActions: []
    };
  }

  const strengthTotal =
    candidates.reduce(
      (
        sum,
        candidate
      ) =>
        sum +
        Math.max(
          1,
          safeNumber(
            candidate.allocationConvictionScore
          ) ||
          decisionCenterCandidateConviction(
            candidate
          )
        ) *
        candidate.allocationStrengthMultiplier,
      0
    );

  let remainingDeploy =
    deployCap;

  const allocations = [];
  const sectorSpent =
    new Map();
  const personalActions = [];

  for (
    const candidate
    of candidates
  ) {
    if (
      allocations.length >=
        targetPositionCount
    ) {
      break;
    }

    const pricePaisa =
      Math.round(
        Number(
          candidate.price
        ) *
        100
      );

    if (
      !Number.isFinite(
        pricePaisa
      ) ||
      pricePaisa <= 0
    ) {
      continue;
    }

    const strength =
      Math.max(
        1,
        safeNumber(
          candidate.allocationConvictionScore
        ) ||
        decisionCenterCandidateConviction(
          candidate
        )
      ) *
      candidate.allocationStrengthMultiplier;

    const proportionalTarget =
      Math.floor(
        deployCap *
        strength /
        strengthTotal
      );

    const existingStockValuePaisa =
      Math.round(
        (
          safeNumber(
            existingSymbolValues[
              candidate.symbol
            ]
          ) ||
          0
        ) *
        100
      );

    const existingStockWeightPct =
      existingPortfolioValuePaisa > 0
        ? existingStockValuePaisa /
          existingPortfolioValuePaisa *
          100
        : 0;

    const stockTotalCap =
      Math.floor(
        postFundingCapitalBasePaisa *
        dynamicCaps.stockCapPct *
        candidate.allocationCapMultiplier
      );

    const stockGap =
      Math.max(
        0,
        stockTotalCap -
        existingStockValuePaisa
      );

    const existingSectorValuePaisa =
      Math.round(
        (
          safeNumber(
            existingSectorValues[
              candidate.sector
            ]
          ) ||
          0
        ) *
        100
      );

    const existingSectorSpent =
      sectorSpent.get(
        candidate.sector
      ) ||
      0;

    const sectorTotalCap =
      Math.floor(
        postFundingCapitalBasePaisa *
        dynamicCaps.sectorCapPct
      );

    const sectorGap =
      Math.max(
        0,
        sectorTotalCap -
        existingSectorValuePaisa -
        existingSectorSpent
      );

    const shortTermCandidate =
      candidate?.canonicalState
        ?.professional
        ?.framework ===
        'SHORT_TERM_TRADER';

    const traderRiskBudgetPct =
      shortTermCandidate
        ? decisionTraderRiskBudgetPct(
            riskPolicy
          )
        : null;

    const traderRiskPerShare =
      shortTermCandidate
        ? safeNumber(
            candidate?.canonicalState
              ?.professional
              ?.tradePlan
              ?.riskPerShare
          )
        : null;

    const traderRiskShareCap =
      shortTermCandidate &&
      traderRiskPerShare !== null &&
      traderRiskPerShare > 0
        ? Math.floor(
            (
              budgetPaisa /
              100 *
              traderRiskBudgetPct
            ) /
            traderRiskPerShare
          )
        : null;

    const traderRiskValueCap =
      shortTermCandidate
        ? Math.max(
            0,
            (
              traderRiskShareCap ||
              0
            ) *
            pricePaisa
          )
        : Number.MAX_SAFE_INTEGER;

    const allowed =
      Math.max(
        0,
        Math.min(
          remainingDeploy,
          proportionalTarget,
          stockGap,
          sectorGap,
          traderRiskValueCap
        )
      );

    const shares =
      Math.floor(
        allowed /
        pricePaisa
      );

    if (shares < 1) {
      let personalAction =
        'NO_ADD';
      let personalReason =
        shortTermCandidate &&
        traderRiskValueCap < pricePaisa
          ? 'One whole share would exceed the selected profile\'s stop-based per-trade risk budget, so NOMAD does not force the trade.'
          : 'The opportunity remains ranked, but this new capital cannot fit one whole share inside the current target-weight and sector limits.';

      if (
        existingStockValuePaisa >=
          stockTotalCap &&
        existingStockValuePaisa > 0
      ) {
        personalAction =
          'HOLD';
        personalReason =
          'NOMAD still likes the opportunity, but your current holding is already at or above its portfolio target. Do not add with this new money.';
      } else if (
        existingSectorValuePaisa >=
          sectorTotalCap &&
        existingSectorValuePaisa > 0
      ) {
        personalAction =
          'DO_NOT_ADD';
        personalReason =
          'The stock remains attractive, but your existing sector exposure is already at the current portfolio cap.';
      }

      personalActions.push({
        symbol:
          candidate.symbol,
        marketView:
          candidate.decisionCenterView,
        portfolioAction:
          personalAction,
        allocationTier:
          candidate.allocationTier,
        existingWeightPct:
          decisionRound(
            existingStockWeightPct,
            2
          ),
        targetWeightPct:
          decisionRound(
            stockTotalCap /
            Math.max(
              1,
              postFundingCapitalBasePaisa
            ) *
            100,
            2
          ),
        reason:
          personalReason
      });

      continue;
    }

    const spent =
      shares *
      pricePaisa;

    remainingDeploy -=
      spent;

    sectorSpent.set(
      candidate.sector,
      existingSectorSpent +
        spent
    );

    const postStockValue =
      existingStockValuePaisa +
      spent;

    allocations.push({
      symbol:
        candidate.symbol,
      companyName:
        candidate.companyName,
      sector:
        candidate.sector,
      action:
        candidate.canonicalState
          ?.marketAction ||
        candidate.decisionCenterView,
      marketView:
        candidate.canonicalState
          ?.marketAction ||
        candidate.decisionCenterView,
      allocationTier:
        candidate.allocationTier,
      shares,
      referencePrice:
        decisionRound(
          candidate.price,
          2
        ),
      traderPlan:
        shortTermCandidate
          ? {
              setup:
                candidate.canonicalState
                  ?.professional
                  ?.setup ||
                null,
              entryLow:
                candidate.canonicalState
                  ?.professional
                  ?.tradePlan
                  ?.entryLow ??
                null,
              entryHigh:
                candidate.canonicalState
                  ?.professional
                  ?.tradePlan
                  ?.entryHigh ??
                null,
              stop:
                candidate.canonicalState
                  ?.professional
                  ?.tradePlan
                  ?.stop ??
                null,
              target1:
                candidate.canonicalState
                  ?.professional
                  ?.tradePlan
                  ?.target1 ??
                null,
              rewardRisk:
                candidate.canonicalState
                  ?.professional
                  ?.tradePlan
                  ?.rewardRisk ??
                null,
              riskPerShare:
                traderRiskPerShare,
              riskBudgetPct:
                decisionRound(
                  traderRiskBudgetPct *
                  100,
                  2
                )
            }
          : null,
      principalPkr:
        decisionRound(
          spent /
          100,
          2
        ),
      targetWeightPct:
        decisionRound(
          stockTotalCap /
          Math.max(
            1,
            postFundingCapitalBasePaisa
          ) *
          100,
          2
        ),
      newMoneyWeightPct:
        decisionRound(
          budgetPaisa > 0
            ? spent /
              budgetPaisa *
              100
            : 0,
          2
        ),
      postPortfolioWeightPct:
        decisionRound(
          postFundingCapitalBasePaisa > 0
            ? postStockValue /
              postFundingCapitalBasePaisa *
              100
            : 0,
          2
        ),
      existingWeightPct:
        decisionRound(
          existingStockWeightPct,
          2
        ),
      actualWeightPct:
        decisionRound(
          budgetPaisa > 0
            ? spent /
              budgetPaisa *
              100
            : 0,
          2
        ),
      overallScore:
        candidate.overallScore,
      opportunityRankScore:
        candidate.opportunityRankScore,
      allocationConvictionScore:
        candidate.allocationConvictionScore,
      evidenceStrength:
        candidate.analystCore
          ?.coverage
          ?.coreCoveragePct ??
        null,
      note:
        shortTermCandidate
          ? 'Short-term shadow trade candidate: position value is capped by the defined stop distance and the selected profile\'s per-trade risk budget. Brokerage, taxes, levies and execution slippage are not included.'
          : candidate.allocationTier ===
              'PRIORITY_2'
            ? 'Actionable Priority 2 position: the canonical market action is ACCUMULATE, evidence passes the allocation gate, and NOMAD deliberately sizes it below Priority 1.'
            : candidate.decisionCenterView ===
                'ACCUMULATE'
              ? 'Staged Priority 1 exposure: the analyst thesis passes, but NOMAD is not sizing this as a full position yet.'
              : 'Priority 1 shadow allocation. Brokerage, taxes, levies and execution slippage are not included.'
    });

    personalActions.push({
      symbol:
        candidate.symbol,
      marketView:
        candidate.canonicalState
          ?.marketAction ||
        candidate.decisionCenterView,
      portfolioAction:
        existingStockValuePaisa > 0
          ? 'ADD'
          : 'BUY',
      allocationTier:
        candidate.allocationTier,
      existingWeightPct:
        decisionRound(
          existingStockWeightPct,
          2
        ),
      targetWeightPct:
        decisionRound(
          stockTotalCap /
          Math.max(
            1,
            postFundingCapitalBasePaisa
          ) *
          100,
          2
        ),
      postPortfolioWeightPct:
        decisionRound(
          postFundingCapitalBasePaisa > 0
            ? postStockValue /
              postFundingCapitalBasePaisa *
              100
            : 0,
          2
        ),
      reason:
        shortTermCandidate
          ? 'The trade setup passes the Trader brain and the position fits the selected profile\'s stop-based risk budget plus portfolio concentration limits.'
          : existingStockValuePaisa > 0
            ? 'The holding is below NOMAD\'s current target exposure, so some of the new capital can be added without breaching stock or sector limits.'
            : candidate.allocationTier ===
                'PRIORITY_2'
              ? 'The canonical market action is actionable, but this is a lower-priority opportunity, so NOMAD limits the position size.'
              : 'The opportunity passes the current allocation gate and fits the portfolio diversification limits.'
    });
  }

  // Whole-share rounding pass. It can add one share at a time only to already
  // selected candidates and never above the dynamic post-portfolio target cap.
  let progressed = true;

  while (
    remainingDeploy > 0 &&
    progressed
  ) {
    progressed = false;

    for (
      const candidate
      of candidates
    ) {
      const pricePaisa =
        Math.round(
          Number(
            candidate.price
          ) *
          100
        );

      if (
        !Number.isFinite(
          pricePaisa
        ) ||
        pricePaisa <= 0 ||
        pricePaisa >
          remainingDeploy
      ) {
        continue;
      }

      const allocation =
        allocations.find(
          item =>
            item.symbol ===
              candidate.symbol
        );

      if (!allocation) {
        continue;
      }

      const currentSpent =
        Math.round(
          allocation.principalPkr *
          100
        );

      const existingStockValuePaisa =
        Math.round(
          (
            safeNumber(
              existingSymbolValues[
                candidate.symbol
              ]
            ) ||
            0
          ) *
          100
        );

      const stockTotalCap =
        Math.floor(
          postFundingCapitalBasePaisa *
          dynamicCaps.stockCapPct *
          candidate.allocationCapMultiplier
        );

      const sectorCurrent =
        sectorSpent.get(
          candidate.sector
        ) ||
        0;

      const existingSectorValuePaisa =
        Math.round(
          (
            safeNumber(
              existingSectorValues[
                candidate.sector
              ]
            ) ||
            0
          ) *
          100
        );

      const sectorTotalCap =
        Math.floor(
          postFundingCapitalBasePaisa *
          dynamicCaps.sectorCapPct
        );

      const shortTermCandidate =
        candidate?.canonicalState
          ?.professional
          ?.framework ===
          'SHORT_TERM_TRADER';

      const traderRiskPerShare =
        shortTermCandidate
          ? safeNumber(
              candidate?.canonicalState
                ?.professional
                ?.tradePlan
                ?.riskPerShare
            )
          : null;

      const traderRiskValueCap =
        shortTermCandidate &&
        traderRiskPerShare !== null &&
        traderRiskPerShare > 0
          ? Math.floor(
              (
                budgetPaisa /
                100 *
                decisionTraderRiskBudgetPct(
                  riskPolicy
                ) /
                traderRiskPerShare
              )
            ) *
            pricePaisa
          : Number.MAX_SAFE_INTEGER;

      if (
        existingStockValuePaisa +
          currentSpent +
          pricePaisa >
            stockTotalCap ||
        existingSectorValuePaisa +
          sectorCurrent +
          pricePaisa >
            sectorTotalCap ||
        currentSpent +
          pricePaisa >
            traderRiskValueCap
      ) {
        continue;
      }

      allocation.shares += 1;
      allocation.principalPkr =
        decisionRound(
          allocation.principalPkr +
            pricePaisa /
            100,
          2
        );
      allocation.newMoneyWeightPct =
        decisionRound(
          allocation.principalPkr /
            amount *
            100,
          2
        );
      allocation.actualWeightPct =
        allocation.newMoneyWeightPct;
      allocation.postPortfolioWeightPct =
        decisionRound(
          (
            existingStockValuePaisa /
              100 +
            allocation.principalPkr
          ) /
          Math.max(
            0.01,
            postFundingCapitalBasePaisa /
              100
          ) *
          100,
          2
        );

      remainingDeploy -=
        pricePaisa;

      sectorSpent.set(
        candidate.sector,
        sectorCurrent +
          pricePaisa
      );

      progressed = true;

      if (remainingDeploy <= 0) {
        break;
      }
    }
  }

  const investedPaisa =
    allocations.reduce(
      (
        sum,
        item
      ) =>
        sum +
        Math.round(
          item.principalPkr *
          100
        ),
      0
    );

  const allocatedSymbols =
    new Set(
      allocations.map(
        item =>
          item.symbol
      )
    );

  const achievedPositionCount =
    allocations.length;

  const diversificationExceptionTriggered =
    achievedPositionCount <
      DECISION_CENTER_MIN_TARGET_POSITIONS;

  let diversificationExceptionReason = null;

  if (diversificationExceptionTriggered) {
    if (
      candidates.length <
        DECISION_CENTER_MIN_TARGET_POSITIONS
    ) {
      diversificationExceptionReason =
        'Only ' +
        candidates.length +
        ' profile-suitable actionable stock' +
        (candidates.length === 1 ? '' : 's') +
        ' passed the professional allocation gate after deeper research. NOMAD will not force a weaker third position; the remainder stays in cash.';
    } else {
      diversificationExceptionReason =
        'At least three actionable stocks passed research, but whole-share affordability, existing holdings, stock caps, or sector caps prevented three prudent funded positions. NOMAD retains the remainder in cash rather than forcing exposure.';
    }
  }

  const unfundedPriorityOne =
    candidates
      .filter(
        candidate =>
          candidate.allocationTier ===
            'PRIORITY_1' &&
          !allocatedSymbols.has(
            candidate.symbol
          )
      )
      .map(
        candidate => ({
          symbol:
            candidate.symbol,
          price:
            candidate.price,
          reason:
            Boolean(portfolioContext?.holdingCount)
              ? 'Priority 1 remains valid, but your existing holding/sector exposure or whole-share feasibility leaves no prudent room to add it with this capital.'
              : 'Priority 1 remains valid, but whole-share feasibility or the dynamic diversification cap prevents a prudent allocation with this amount.'
      }));

  return {
    allocations,
    amountInvestedPkr:
      decisionRound(
        investedPaisa /
        100,
        2
      ),
    cashRemainingPkr:
      decisionRound(
        Math.max(
          0,
          budgetPaisa -
            investedPaisa
        ) /
        100,
        2
      ),
    investedPct:
      decisionRound(
        budgetPaisa > 0
          ? investedPaisa /
            budgetPaisa *
            100
          : 0,
        2
      ),
    deploymentCapPct:
      deploymentPlan.targetDeploymentPct,
    portfolioAware:
      Boolean(
        portfolioContext?.holdingCount
      ),
    existingPortfolioValuePkr:
      decisionRound(
        existingPortfolioValuePaisa /
        100,
        2
      ),
    targetPositionCount,
    sizingPositionCount,
    targetDeploymentPct:
      deploymentPlan.targetDeploymentPct,
    intentionalCashReservePct:
      deploymentPlan.intentionalCashReservePct,
    averageConvictionScore:
      deploymentPlan.averageConvictionScore,
    cashReserveReason:
      deploymentPlan.reason,
    minimumTargetPositions:
      DECISION_CENTER_MIN_TARGET_POSITIONS,
    maximumTargetPositions:
      DECISION_CENTER_MAX_TARGET_POSITIONS,
    achievedPositionCount,
    diversificationException: {
      triggered:
        diversificationExceptionTriggered,
      reason:
        diversificationExceptionReason
    },
    eligibleAllocationCandidates:
      candidates.length,
    priorityOneAllocationCandidates:
      candidates.filter(
        item =>
          item.allocationTier ===
            'PRIORITY_1'
      ).length,
    priorityTwoAllocationCandidates:
      candidates.filter(
        item =>
          item.allocationTier ===
            'PRIORITY_2'
      ).length,
    dynamicMaxStockPct:
      decisionRound(
        dynamicCaps.stockCapPct *
        100,
        2
      ),
    dynamicMaxSectorPct:
      decisionRound(
        dynamicCaps.sectorCapPct *
        100,
        2
      ),
    unfundedPriorityOne,
    personalActions
  };
}

async function decisionMapWithConcurrency(
  items,
  concurrency,
  worker
) {
  const source =
    Array.isArray(items)
      ? items
      : [];

  const results =
    new Array(
      source.length
    );

  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index =
        nextIndex++;

      if (index >= source.length) {
        return;
      }

      try {
        results[index] =
          await worker(
            source[index],
            index
          );
      } catch (error) {
        results[index] = {
          error:
            error.message ||
            'Decision evidence request failed.'
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.max(
            1,
            Math.min(
              concurrency,
              source.length ||
              1
            )
          )
      },
      () =>
        runWorker()
    )
  );

  return results;
}

async function decisionWithTimeout(
  promise,
  milliseconds,
  label
) {
  let timeoutId;

  const timeoutPromise =
    new Promise(
      (
        resolve,
        reject
      ) => {
        timeoutId =
          setTimeout(
            () =>
              reject(
                new Error(
                  label +
                  ' timed out.'
                )
              ),
            milliseconds
          );
      }
    );

  try {
    return await Promise.race([
      promise,
      timeoutPromise
    ]);
  } finally {
    clearTimeout(
      timeoutId
    );
  }
}

async function decisionHistoricalContext(
  row,
  memoryMap
) {
  const symbol =
    normalizeSymbol(
      row.symbol
    );

  const memory =
    memoryMap?.get(
      symbol
    ) ||
    null;

  const cachedContext =
    memory?.market_state
      ?.historicalContext ||
    null;

  const evaluatedAt =
    Date.parse(
      memory?.evaluated_at ||
      ''
    );

  if (
    cachedContext?.available &&
    cachedContext?.contextSchemaVersion ===
      DECISION_HISTORICAL_CONTEXT_SCHEMA_VERSION &&
    cachedContext?.priceAction &&
    Number.isFinite(
      evaluatedAt
    ) &&
    Date.now() -
      evaluatedAt <
      24 *
        60 *
        60 *
        1000
  ) {
    return {
      ...cachedContext,
      cacheState: 'memory'
    };
  }

  const context =
    await decisionWithTimeout(
      getHistoricalSituation(
        symbol,
        row.price
      ),
      7000,
      symbol +
      ' history'
    );

  if (context?.available) {
    saveHistoricalSituationToMemory(
      symbol,
      context,
      row
    ).catch(
      () => {}
    );
  }

  return {
    ...context,
    cacheState: 'fresh'
  };
}

function decisionFundamentalCache(
  memory
) {
  const cache =
    memory?.fundamental_state
      ?.decisionEvidence ||
    null;

  const cachedAt =
    Date.parse(
      cache?.cachedAt ||
      ''
    );

  if (
    !cache?.data?.available ||
    !Number.isFinite(
      cachedAt
    )
  ) {
    return null;
  }

  return {
    data:
      cache.data,
    cachedAt:
      cache.cachedAt,
    ageMs:
      Math.max(
        0,
        Date.now() -
          cachedAt
      )
  };
}

async function saveDecisionFundamentalCache(
  symbol,
  fundamentals,
  memory
) {
  if (
    !continuousMemoryConfigured() ||
    !memory ||
    !fundamentals?.available
  ) {
    return false;
  }

  const fundamentalState = {
    ...(
      memory.fundamental_state ||
      {}
    ),
    decisionEvidence: {
      cachedAt:
        new Date()
          .toISOString(),
      source:
        fundamentals.source ||
        null,
      sourceUrl:
        fundamentals.sourceUrl ||
        null,
      data: {
        symbol:
          fundamentals.symbol ||
          normalizeSymbol(
            symbol
          ),
        company:
          fundamentals.company ||
          null,
        source:
          fundamentals.source ||
          null,
        sourceUrl:
          fundamentals.sourceUrl ||
          null,
        fetchedAt:
          fundamentals.fetchedAt ||
          new Date()
            .toISOString(),
        valuation:
          fundamentals.valuation ||
          null,
        annual:
          fundamentals.annual ||
          null,
        quarterly:
          fundamentals.quarterly ||
          null,
        ratios:
          fundamentals.ratios ||
          null,
        analystCore:
          fundamentals.analystCore ||
          buildFinancialAnalystCore(
            fundamentals
          ),
        available: true
      }
    }
  };

  try {
    await supabaseRest(
      'security_state?symbol=eq.' +
        encodeURIComponent(
          normalizeSymbol(
            symbol
          )
        ),
      {
        method: 'PATCH',
        prefer:
          'return=minimal',
        body: {
          fundamental_state:
            fundamentalState
        }
      }
    );

    memory.fundamental_state =
      fundamentalState;

    return true;
  } catch {
    return false;
  }
}

async function decisionLoadFundamentals(
  row,
  memoryMap
) {
  const symbol =
    normalizeSymbol(
      row.symbol
    );

  const memory =
    memoryMap?.get(
      symbol
    ) ||
    null;

  const cache =
    decisionFundamentalCache(
      memory
    );

  if (
    cache &&
    cache.ageMs <=
      DECISION_FUNDAMENTAL_CACHE_FRESH_MS
  ) {
    const cachedFundamentals = {
      ...cache.data,
      analystCore:
        cache.data?.analystCore ||
        buildFinancialAnalystCore(
          cache.data
        )
    };

    return {
      fundamentals:
        cachedFundamentals,
      evidenceState:
        'CACHE_FRESH',
      cachedAt:
        cache.cachedAt,
      diagnostics: {
        source:
          'CACHE_FRESH',
        cacheAgeMs:
          cache.ageMs,
        liveAttempted:
          false
      },
      error: null
    };
  }

  let fresh = null;
  let freshError = null;

  try {
    fresh =
      await decisionWithTimeout(
        getFundamentals(
          symbol
        ),
        18000,
        symbol +
          ' fundamentals'
      );
  } catch (error) {
    freshError =
      error.message ||
      'Fundamental evidence unavailable.';
  }

  if (
    fresh &&
    !fresh.available &&
    !freshError
  ) {
    freshError =
      fresh.evidenceError ||
      'Structured company fundamentals were not available from the PSX company page.';
  }

  if (fresh?.available) {
    await saveDecisionFundamentalCache(
      symbol,
      fresh,
      memory
    );

    return {
      fundamentals:
        fresh,
      evidenceState:
        'LIVE',
      cachedAt:
        fresh.fetchedAt ||
        new Date()
          .toISOString(),
      diagnostics: {
        source:
          'LIVE',
        cacheAgeMs:
          cache?.ageMs ??
          null,
        liveAttempted:
          true,
        fundamentals:
          fresh.diagnostics ||
          null
      },
      error: null
    };
  }

  if (
    cache &&
    cache.ageMs <=
      DECISION_FUNDAMENTAL_CACHE_FALLBACK_MS
  ) {
    const cachedFundamentals = {
      ...cache.data,
      analystCore:
        cache.data?.analystCore ||
        buildFinancialAnalystCore(
          cache.data
        )
    };

    return {
      fundamentals:
        cachedFundamentals,
      evidenceState:
        'CACHE_FALLBACK',
      cachedAt:
        cache.cachedAt,
      diagnostics: {
        source:
          'CACHE_FALLBACK',
        cacheAgeMs:
          cache.ageMs,
        liveAttempted:
          true,
        liveFailure:
          freshError ||
          null,
        fundamentals:
          fresh?.diagnostics ||
          null
      },
      error:
        freshError ||
        'Live fundamentals were unavailable; NOMAD used recent cached company evidence.'
    };
  }

  return {
    fundamentals:
      fresh,
    evidenceState:
      'BLOCKED',
    cachedAt: null,
    diagnostics: {
      source:
        'BLOCKED',
      cacheAgeMs:
        cache?.ageMs ??
        null,
      liveAttempted:
        true,
      liveFailure:
        freshError ||
        null,
      fundamentals:
        fresh?.diagnostics ||
        null
    },
    error:
      freshError ||
      'Structured company fundamentals are unavailable.'
  };
}

function decisionOverallScore(
  model,
  fundamental,
  valuation,
  entry,
  risk,
  dataQuality
) {
  const weights =
    model.weights;

  return decisionRound(
    decisionClamp(
      (
        safeNumber(
          fundamental?.score
        ) ||
        0
      ) *
        weights.fundamental +
      (
        safeNumber(
          valuation?.score
        ) ||
        0
      ) *
        weights.valuation +
      (
        safeNumber(
          entry?.score
        ) ||
        0
      ) *
        weights.entry +
      (
        safeNumber(
          risk?.score
        ) ||
        0
      ) *
        weights.risk +
      (
        safeNumber(
          dataQuality?.score
        ) ||
        0
      ) *
        weights.dataQuality
    ),
    2
  );
}

function decisionCandidateNarrative(
  candidate
) {
  const positives = [
    ...(
      candidate.fundamental
        ?.reasons ||
      []
    ),
    ...(
      candidate.valuation
        ?.reasons ||
      []
    ),
    ...(
      candidate.entry
        ?.reasons ||
      []
    ),
    ...(
      candidate.risk
        ?.reasons ||
      []
    )
  ];

  const risks = [
    ...(
      candidate.fundamental
        ?.risks ||
      []
    ),
    ...(
      candidate.valuation
        ?.risks ||
      []
    ),
    ...(
      candidate.entry
        ?.risks ||
      []
    ),
    ...(
      candidate.risk
        ?.risks ||
      []
    )
  ];

  return {
    positives:
      uniqueStrings(
        positives
      ).slice(0, 4),
    risks:
      uniqueStrings(
        risks
      ).slice(0, 4)
  };
}

function allocateDecisionCandidates(
  candidates,
  amount,
  riskPolicy
) {
  const budgetPaisa =
    Math.max(
      0,
      Math.round(
        Number(amount) *
        100
      )
    );

  let remaining =
    budgetPaisa;

  const allocations = [];
  const sectorSpent =
    new Map();

  const actionable =
    candidates
      .filter(
        candidate =>
          candidate.action ===
            'BUY_NOW' ||
          candidate.action ===
            'STAGED_BUY'
      )
      .sort(
        (
          a,
          b
        ) =>
          b.overallScore -
          a.overallScore
      )
      .slice(
        0,
        riskPolicy.maxAllocations
      );

  for (
    const candidate
    of actionable
  ) {
    const pricePaisa =
      Math.round(
        Number(
          candidate.price
        ) *
        100
      );

    if (
      !Number.isFinite(
        pricePaisa
      ) ||
      pricePaisa <= 0
    ) {
      continue;
    }

    const stagedMultiplier =
      candidate.action ===
        'STAGED_BUY'
        ? 0.50
        : 1;

    const stockCap =
      Math.floor(
        budgetPaisa *
        riskPolicy.maxStockPct *
        stagedMultiplier
      );

    const existingSectorSpent =
      sectorSpent.get(
        candidate.sector
      ) ||
      0;

    const sectorCap =
      Math.floor(
        budgetPaisa *
        riskPolicy.maxSectorPct
      );

    const allowed =
      Math.max(
        0,
        Math.min(
          remaining,
          stockCap,
          sectorCap -
            existingSectorSpent
        )
      );

    const shares =
      Math.floor(
        allowed /
        pricePaisa
      );

    if (shares < 1) {
      continue;
    }

    const spent =
      shares *
      pricePaisa;

    remaining -=
      spent;

    sectorSpent.set(
      candidate.sector,
      existingSectorSpent +
        spent
    );

    allocations.push({
      symbol:
        candidate.symbol,
      companyName:
        candidate.companyName,
      sector:
        candidate.sector,
      action:
        candidate.action,
      shares,
      referencePrice:
        decisionRound(
          candidate.price,
          2
        ),
      principalPkr:
        decisionRound(
          spent /
          100,
          2
        ),
      budgetPct:
        decisionRound(
          budgetPaisa > 0
            ? spent /
              budgetPaisa *
              100
            : 0,
          2
        ),
      overallScore:
        candidate.overallScore,
      evidenceStrength:
        candidate.dataQuality
          ?.score ||
        null,
      note:
        candidate.action ===
          'STAGED_BUY'
          ? 'Shadow model limits this to a smaller staged allocation because entry quality is not yet strong.'
          : 'Shadow-model allocation before brokerage, levies, taxes and execution slippage.'
    });
  }

  const investedPaisa =
    budgetPaisa -
    remaining;

  return {
    allocations,
    amountInvestedPkr:
      decisionRound(
        investedPaisa /
        100,
        2
      ),
    cashRemainingPkr:
      decisionRound(
        remaining /
        100,
        2
      ),
    investedPct:
      decisionRound(
        budgetPaisa > 0
          ? investedPaisa /
            budgetPaisa *
            100
          : 0,
        2
      ),
    executionCostsIncluded: false
  };
}

async function recordDecisionRun(
  result
) {
  if (!continuousMemoryConfigured()) {
    return {
      recorded: false,
      reason:
        'Supabase is not configured.'
    };
  }

  try {
    const rows =
      await supabaseRest(
        'decision_runs?select=id,created_at',
        {
          method: 'POST',
          prefer:
            'return=representation',
          body: {
            model_id:
              result.model.id,
            engine_mode:
              'shadow',
            validation_status:
              result.validationStatus,
            real_money_eligible:
              false,
            horizon:
              result.input.horizon,
            risk_profile:
              result.input.risk,
            amount_pkr:
              result.input.amount,
            market_as_of:
              result.market.asOf ||
              null,
            decision_action:
              result.decision.action,
            amount_invested_pkr:
              result.decision.amountInvestedPkr,
            cash_remaining_pkr:
              result.decision.cashRemainingPkr,
            evidence_strength:
              result.decision.evidenceStrength,
            data_quality: {
              deepCandidates:
                result.screening.deepAnalyzed,
              eligibleUniverse:
                result.screening.eligibleUniverse,
              affordableUniverse:
                result.screening.affordableUniverse
            },
            allocation:
              result.allocations,
            summary: {
              headline:
                result.decision.headline,
              reason:
                result.decision.reason,
              topCandidates:
                result.candidates
                  .slice(0, 5)
                  .map(
                    candidate => ({
                      symbol:
                        candidate.symbol,
                      action:
                        candidate.action,
                      overallScore:
                        candidate.overallScore
                    })
                  )
            },
            raw_result:
              result
          }
        }
      );

    const run =
      Array.isArray(rows) &&
      rows.length
        ? rows[0]
        : null;

    if (!run?.id) {
      return {
        recorded: false,
        reason:
          'Decision run insert did not return an ID.'
      };
    }

    const candidateRows =
      result.candidates
        .slice(0, 8)
        .map(
          (
            candidate,
            index
          ) => {
            const allocation =
              result.allocations.find(
                item =>
                  item.symbol ===
                  candidate.symbol
              );

            return {
              run_id:
                run.id,
              symbol:
                candidate.symbol,
              company_name:
                candidate.companyName,
              sector:
                candidate.sector,
              candidate_rank:
                index + 1,
              candidate_action:
                candidate.action,
              reference_price:
                candidate.price,
              shares:
                allocation?.shares ||
                0,
              allocated_pkr:
                allocation?.principalPkr ||
                0,
              overall_score:
                candidate.overallScore,
              fundamental_score:
                candidate.fundamental
                  ?.score ||
                null,
              valuation_score:
                candidate.valuation
                  ?.score ||
                null,
              entry_score:
                candidate.entry
                  ?.score ||
                null,
              risk_score:
                candidate.risk
                  ?.score ||
                null,
              data_quality_score:
                candidate.dataQuality
                  ?.score ||
                null,
              evidence: {
                historicalContext:
                  candidate.historicalContext,
                fundamentalMetrics:
                  candidate.fundamental
                    ?.metrics ||
                  {},
                analystCore:
                  candidate.analystCore ||
                  null,
                fundamentalEvidenceState:
                  candidate.fundamentalEvidenceState ||
                  null,
                fundamentalEvidenceDiagnostics:
                  candidate.fundamentalEvidenceDiagnostics ||
                  null,
                narrative:
                  candidate.narrative,
                reason:
                  candidate.actionReason
              }
            };
          }
        );

    if (candidateRows.length) {
      await supabaseRest(
        'decision_candidates?select=id',
        {
          method: 'POST',
          prefer:
            'return=minimal',
          body:
            candidateRows
        }
      );
    }

    return {
      recorded: true,
      runId:
        run.id,
      createdAt:
        run.created_at ||
        null
    };
  } catch (error) {
    return {
      recorded: false,
      reason:
        error.message ||
        'Decision run could not be recorded.'
    };
  }
}

async function runSingleStockStrategy(
  input
) {
  const requestedSymbol =
    normalizeSymbol(
      input?.symbol
    );

  const horizon =
    String(
      input?.horizon ||
      'long_term'
    );

  const risk =
    String(
      input?.risk ||
      'balanced'
    );

  if (!requestedSymbol) {
    bad(
      'Enter a PSX symbol to analyze.'
    );
  }

  const model =
    DECISION_MODELS[
      horizon
    ];

  const riskPolicy =
    DECISION_RISK_POLICIES[
      risk
    ];

  if (!model) {
    bad(
      'Select a valid investment horizon.'
    );
  }

  if (!riskPolicy) {
    bad(
      'Select a valid risk profile.'
    );
  }

  const symbolContext =
    await resolveSymbolContext(
      requestedSymbol
    );

  const canonicalSymbol =
    normalizeSymbol(
      symbolContext?.canonicalSymbol ||
      symbolContext?.tradingSymbol ||
      requestedSymbol
    );

  const [
    market,
    memoryRows
  ] =
    await Promise.all([
      loadPSXMarket(),
      continuousMemoryConfigured()
        ? readAllSecurityMemory()
            .catch(
              () => []
            )
        : Promise.resolve([])
    ]);

  const marketRow =
    (market.stocks || [])
      .find(
        row =>
          normalizeSymbol(
            row.symbol
          ) ===
            canonicalSymbol ||
          normalizeSymbol(
            row.rawMarketSymbol
          ) ===
            canonicalSymbol
      ) ||
    null;

  if (!marketRow) {
    bad(
      canonicalSymbol +
      ' is not available in the current Official PSX market universe.'
    );
  }

  const eligibleRows =
    (market.stocks || [])
      .filter(
        row =>
          row.recommendationEligible ===
            true &&
          safeNumber(
            row.price
          ) !== null &&
          safeNumber(
            row.price
          ) > 0
      );

  const memoryMap =
    new Map(
      (memoryRows || [])
        .map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
    );

  const historicalContext =
    await decisionHistoricalContext(
      marketRow,
      memoryMap
    );

  const valuation =
    scoreDecisionValuation(
      marketRow,
      eligibleRows
    );

  const entry =
    scoreDecisionEntry(
      historicalContext,
      horizon,
      riskPolicy
    );

  const riskScore =
    scoreDecisionRisk(
      marketRow,
      historicalContext,
      eligibleRows
    );

  const fundamentalEvidence =
    await decisionLoadFundamentals(
      marketRow,
      memoryMap
    );

  const fundamentals =
    fundamentalEvidence
      .fundamentals;

  const fundamental =
    scoreDecisionFundamentals(
      fundamentals
    );

  fundamental.evidenceState =
    fundamentalEvidence
      .evidenceState;

  fundamental.cachedAt =
    fundamentalEvidence
      .cachedAt;

  if (
    fundamentalEvidence.error
  ) {
    fundamental.risks =
      uniqueTextValues([
        ...(
          fundamental.risks ||
          []
        ),
        fundamentalEvidence.error
      ]);
  }

  const dataQuality =
    scoreDecisionDataQuality(
      marketRow,
      historicalContext,
      fundamental
    );

  const overallScore =
    decisionOverallScore(
      model,
      fundamental,
      valuation,
      entry,
      riskScore,
      dataQuality
    );

  const candidate = {
    horizon,
    riskProfile:
      risk,
    recommendationEligible:
      marketRow.recommendationEligible ===
        true,
    symbol:
      canonicalSymbol,
    companyName:
      marketRow.companyName ||
      symbolContext?.companyName ||
      canonicalSymbol,
    sector:
      marketRow.sector ||
      symbolContext?.sector ||
      'Unknown',
    statusCodes:
      marketRow.statusCodes ||
      [],
    price:
      decisionRound(
        marketRow.price,
        4
      ),
    marketAsOf:
      marketRow.asOf ||
      market.marketWatchAsOf ||
      market.asOf ||
      null,
    averageVolume30d:
      decisionRound(
        marketRow.averageVolume30d,
        0
      ),
    historicalContext,
    fundamental,
    analystCore:
      fundamentals?.analystCore ||
      null,
    fundamentalEvidenceState:
      fundamentalEvidence
        .evidenceState,
    fundamentalEvidenceDiagnostics:
      fundamentalEvidence
        .diagnostics ||
      null,
    valuation,
    entry,
    risk:
      riskScore,
    dataQuality,
    overallScore
  };

  const legacyAction =
    decisionCandidateAction(
      candidate,
      model,
      riskPolicy
    );

  candidate.action =
    legacyAction.action;

  candidate.actionReason =
    legacyAction.reason;

  candidate.narrative =
    decisionCandidateNarrative(
      candidate
    );

  candidate.canonicalState =
    decisionCanonicalCompanyState(
      candidate
    );

  const profileSuitability =
    decisionProfileSuitability(
      candidate,
      riskPolicy
    );

  candidate.profileSuitability =
    profileSuitability;

  const suitabilityIssues =
    profileSuitability.issues;

  const riskSuitability =
    profileSuitability.state;

  const portfolioContext =
    await buildDecisionPortfolioContext(
      market
    );

  const existingValue =
    safeNumber(
      portfolioContext
        ?.symbolValues
        ?.[canonicalSymbol]
    ) ||
    0;

  const portfolioValue =
    safeNumber(
      portfolioContext
        ?.currentValuePkr
    ) ||
    0;

  const existingWeightPct =
    portfolioValue > 0
      ? existingValue /
        portfolioValue *
        100
      : 0;

  const canonical =
    candidate.canonicalState;

  let personalAction =
    canonical.marketAction;

  let personalReason =
    canonical.reason;

  if (
    canonical.researchState ===
      'ACTIVE'
  ) {
    personalAction =
      existingValue > 0
        ? 'HOLD_RESEARCH'
        : 'NO_ACTION_YET';
    personalReason =
      canonical.reason;
  } else if (
    riskSuitability ===
      'NOT_SUITABLE'
  ) {
    personalAction =
      'DO_NOT_ADD';
    personalReason =
      suitabilityIssues.join(' ');
  } else if (
    horizon === 'short_term' &&
    existingValue <= 0 &&
    canonical.marketAction ===
      'WATCH'
  ) {
    personalAction = 'WAIT';
    personalReason =
      canonical.reason;
  } else if (
    existingValue > 0
  ) {
    if (
      canonical.marketAction ===
        'BUY' ||
      canonical.marketAction ===
        'ACCUMULATE'
    ) {
      if (
        existingWeightPct >=
          riskPolicy.maxStockPct *
          100
      ) {
        personalAction =
          'DO_NOT_ADD';
        personalReason =
          'The market thesis is actionable, but your existing position already reaches the selected profile\'s hard single-stock ceiling.';
      } else {
        personalAction =
          'ADD_CANDIDATE';
        personalReason =
          'You already own this company and the current professional state remains actionable for the selected profile.';
      }
    } else if (
      canonical.marketAction ===
        'WATCH'
    ) {
      personalAction =
        'HOLD';
      personalReason =
        'You already own the stock. The current thesis does not justify adding new capital, but it does not independently trigger an exit.';
    } else if (
      canonical.marketAction ===
        'AVOID'
    ) {
      personalAction =
        'REVIEW_REDUCE';
      personalReason =
        'You already own the stock and the current professional framework is unfavorable. Review the original thesis before deciding whether to reduce or exit.';
    }
  }

  const priceAction =
    historicalContext
      ?.priceAction ||
    null;

  const volatility =
    safeNumber(
      historicalContext
        ?.technical
        ?.annualizedVolatility20dPct
    );

  const avgVolume =
    safeNumber(
      candidate.averageVolume30d
    );

  return {
    status: 'OK',
    build: VERSION,
    engineMode: 'SHADOW',
    realMoneyEligible: false,
    input: {
      requestedSymbol,
      symbol:
        canonicalSymbol,
      horizon,
      risk
    },
    identity: {
      symbol:
        canonicalSymbol,
      companyName:
        candidate.companyName,
      sector:
        candidate.sector,
      statusCodes:
        candidate.statusCodes,
      recommendationEligible:
        marketRow.recommendationEligible ===
        true
    },
    market: {
      price:
        candidate.price,
      dayChangePct:
        decisionRound(
          marketRow.dayChangePct,
          2
        ),
      asOf:
        candidate.marketAsOf,
      source:
        'Official PSX Data Portal screener'
    },
    professional: {
      ...canonical.professional,
      marketAction:
        canonical.marketAction,
      opportunityTier:
        canonical.opportunityTier,
      allocationAllowed:
        canonical.allocationPermission
          ?.allowed === true
    },
    personal: {
      action:
        personalAction,
      reason:
        personalReason,
      hasPosition:
        existingValue > 0,
      currentPositionValuePkr:
        decisionRound(
          existingValue,
          2
        ),
      currentPortfolioWeightPct:
        decisionRound(
          existingWeightPct,
          2
        ),
      portfolioValuePkr:
        decisionRound(
          portfolioValue,
          2
        )
    },
    riskSuitability: {
      ...profileSuitability,
      profile:
        risk
    },
    evidence:
      canonical.evidence,
    financial: {
      analystStatus:
        candidate.analystCore
          ?.status ||
        'UNAVAILABLE',
      overall:
        candidate.analystCore
          ?.overallFinancialView
          ?.state ||
        'UNAVAILABLE',
      headlineView:
        candidate.analystCore
          ?.overallFinancialView
          ?.state ||
        'UNAVAILABLE',
      deepValidation:
        safeNumber(
          candidate.analystCore
            ?.coverage
            ?.extendedCoveragePct
        ) >= 67
          ? 'VALIDATED'
          : safeNumber(
              candidate.analystCore
                ?.coverage
                ?.extendedCoveragePct
            ) > 0
            ? 'PARTIAL'
            : 'INCOMPLETE',
      earningsQuality:
        candidate.analystCore
          ?.views
          ?.earningsQuality
          ?.state ||
        'UNAVAILABLE',
      cashFlowQuality:
        candidate.analystCore
          ?.views
          ?.cashFlowQuality
          ?.state ||
        'UNAVAILABLE',
      balanceSheet:
        candidate.analystCore
          ?.views
          ?.balanceSheet
          ?.state ||
        'UNAVAILABLE',
      fundamentalScore:
        candidate.fundamental
          ?.score ??
        null
    },
    valuation: {
      state:
        canonical.professional
          ?.valuationState ||
        'UNAVAILABLE',
      score:
        candidate.valuation
          ?.score ??
        null,
      peRatio:
        candidate.valuation
          ?.peRatio ??
        null,
      dividendYield:
        candidate.valuation
          ?.dividendYield ??
        null
    },
    risk: {
      state:
        canonical.professional
          ?.riskState ||
        'UNAVAILABLE',
      score:
        candidate.risk
          ?.score ??
        null,
      annualizedVolatility20dPct:
        volatility,
      maxDrawdown52wPct:
        historicalContext
          ?.technical
          ?.maxDrawdown52wPct ??
        null,
      averageVolume30d:
        avgVolume
    },
    performance: {
      todayPct:
        decisionRound(
          marketRow.dayChangePct,
          2
        ),
      d5Pct:
        historicalContext
          ?.returns
          ?.d5 ??
        null,
      m1Pct:
        historicalContext
          ?.returns
          ?.m1 ??
        null,
      m3Pct:
        historicalContext
          ?.returns
          ?.m3 ??
        null,
      m6Pct:
        historicalContext
          ?.returns
          ?.m6 ??
        null,
      y1Pct:
        historicalContext
          ?.returns
          ?.y1 ??
        null
    },
    technical: {
      trend:
        historicalContext
          ?.trend ||
        'UNAVAILABLE',
      timingState:
        canonical.professional
          ?.timingState ||
        priceAction?.timingState ||
        'UNAVAILABLE',
      timingScore:
        canonical.professional
          ?.timingScore ??
        priceAction?.timingScore ??
        null,
      setup:
        priceAction?.setup ||
        'NO_CLEAR_SETUP',
      candlePattern:
        priceAction
          ?.candlePattern
          ?.label ||
        'NONE',
      candlePolarity:
        priceAction
          ?.candlePattern
          ?.polarity ||
        'NEUTRAL',
      support:
        priceAction?.support ??
        null,
      resistance:
        priceAction?.resistance ??
        null,
      rewardRisk:
        priceAction?.tradePlan
          ?.rewardRisk ??
        priceAction?.rewardRisk ??
        null,
      entryLow:
        priceAction?.tradePlan
          ?.entryLow ??
        null,
      entryHigh:
        priceAction?.tradePlan
          ?.entryHigh ??
        null,
      stop:
        priceAction?.tradePlan
          ?.stop ??
        null,
      target1:
        priceAction?.tradePlan
          ?.target1 ??
        null,
      target2:
        priceAction?.tradePlan
          ?.target2 ??
        null,
      riskPerShare:
        priceAction?.tradePlan
          ?.riskPerShare ??
        null,
      riskPct:
        priceAction?.tradePlan
          ?.riskPct ??
        null,
      targetSource:
        priceAction?.tradePlan
          ?.targetSource ||
        null,
      tradePlanState:
        priceAction?.tradePlan
          ?.state ||
        'INCOMPLETE',
      invalidation:
        priceAction?.tradePlan
          ?.invalidation ||
        null,
      structureBias:
        priceAction?.structure
          ?.bias ||
        'UNAVAILABLE',
      atr14:
        priceAction?.atr14 ??
        null,
      atrPct:
        priceAction?.atrPct ??
        null,
      rsi14:
        historicalContext
          ?.technical
          ?.rsi14 ??
        null,
      macdHistogram:
        historicalContext
          ?.technical
          ?.macdHistogram ??
        null,
      volumeRatio20d:
        historicalContext
          ?.technical
          ?.volumeRatio20d ??
        null,
      positives:
        priceAction?.positives ||
        [],
      risks:
        priceAction?.risks ||
        []
    },
    reasons: {
      thesis:
        canonical.reason,
      positives:
        horizon === 'short_term'
          ? priceAction?.positives ||
            []
          : candidate.narrative
              ?.positives ||
            [],
      risks:
        horizon === 'short_term'
          ? priceAction?.risks ||
            []
          : candidate.narrative
              ?.risks ||
            []
    },
    diagnostics: {
      overallScore,
      dataQualityScore:
        dataQuality.score,
      legacyAction:
        candidate.action,
      fundamentalEvidenceState:
        candidate.fundamentalEvidenceState
    },
    warnings: [
      'This is shadow decision intelligence, not a trade instruction.',
      'The single-stock strategy view does not place orders.'
    ]
  };
}

async function runDecisionLab(
  input
) {
  const amount =
    safeNumber(
      input?.amount
    );

  const horizon =
    String(
      input?.horizon ||
      'long_term'
    );

  const risk =
    String(
      input?.risk ||
      'balanced'
    );

  if (
    amount === null ||
    amount <= 0 ||
    amount > 100000000000
  ) {
    bad(
      'Enter a valid positive PKR amount.'
    );
  }

  const model =
    DECISION_MODELS[
      horizon
    ];

  const riskPolicy =
    DECISION_RISK_POLICIES[
      risk
    ];

  if (!model) {
    bad(
      'Select a valid investment horizon.'
    );
  }

  if (!riskPolicy) {
    bad(
      'Select a valid risk profile.'
    );
  }

  const startedAt =
    new Date()
      .toISOString();

  const [
    market,
    memoryRows
  ] =
    await Promise.all([
      loadPSXMarket(),
      continuousMemoryConfigured()
        ? readAllSecurityMemory()
            .catch(
              () => []
            )
        : Promise.resolve([])
    ]);

  const portfolioContext =
    await buildDecisionPortfolioContext(
      market
    );

  const researchCapitalBasePkr =
    amount +
    (
      safeNumber(
        portfolioContext?.currentValuePkr
      ) ||
      0
    );

  // Locked professional-PM behavior: the entered capital never changes the
  // ranking, but it does determine how many suitable actionable ideas NOMAD
  // should try to validate before accepting a large cash remainder.
  const researchActionableTarget =
    Math.min(
      8,
      decisionCenterTargetPositionCount(
        researchCapitalBasePkr,
        riskPolicy
      )
    );

  const eligibleRows =
    market.stocks
      .filter(
        row =>
          row.recommendationEligible ===
            true &&
          safeNumber(
            row.price
          ) !== null &&
          safeNumber(
            row.price
          ) > 0
      );

  const affordableRows =
    eligibleRows
      .filter(
        row =>
          safeNumber(
            row.price
          ) <= amount
      );

  // Opportunity ranking is independent of the entered budget. The amount is
  // applied only by the separate whole-share allocator later.
  const liquidityPassed =
    eligibleRows
      .filter(
        row => {
          const volume =
            safeNumber(
              row.averageVolume30d
            );

          return (
            volume !== null &&
            volume >=
              riskPolicy.minAverageVolume30d &&
            !(
              row.statusCodes ||
              []
            ).includes('NC')
          );
        }
      );

  const preScreened =
    liquidityPassed
      .map(
        row => ({
          row,
          screeningScore:
            horizon === 'short_term'
              ? decisionTraderScreeningScore(
                  row,
                  eligibleRows
                )
              : decisionScreeningScore(
                  row,
                  eligibleRows
                )
        })
      )
      .sort(
        (
          a,
          b
        ) =>
          b.screeningScore -
          a.screeningScore
      );

  const shortList = [];
  const sectorCounts =
    new Map();

  for (
    const item
    of preScreened
  ) {
    const sector =
      item.row.sector ||
      'Unknown';

    const count =
      sectorCounts.get(
        sector
      ) ||
      0;

    if (
      count >=
        DECISION_CENTER_MAX_SHORTLIST_PER_SECTOR
    ) {
      continue;
    }

    shortList.push(
      item
    );

    sectorCounts.set(
      sector,
      count + 1
    );

    if (shortList.length >= DECISION_CENTER_SHORTLIST_LIMIT) {
      break;
    }
  }

  if (!shortList.length) {
    const emptyResult = {
      status: 'OK',
      build: VERSION,
      engineMode: 'SHADOW',
      validationStatus:
        model.status,
      realMoneyEligible: false,
      startedAt,
      completedAt:
        new Date()
          .toISOString(),
      model,
      riskPolicy: {
        id:
          riskPolicy.id
      },
      input: {
        amount:
          decisionRound(
            amount,
            2
          ),
        horizon,
        risk
      },
      market: {
        asOf:
          market.marketWatchAsOf ||
          market.asOf ||
          null,
        source:
          'Official PSX Data Portal screener'
      },
      screening: {
        eligibleUniverse:
          eligibleRows.length,
        affordableUniverse:
          affordableRows.length,
        liquidityPassed:
          liquidityPassed.length,
        historicalAnalyzed: 0,
        deepAnalyzed: 0
      },
      decision: {
        action: 'WAIT',
        headline:
          'No investable candidate passed the first safety gates.',
        reason:
          'The current liquidity policy and eligible universe produced no candidate suitable for deeper analysis. The entered amount did not affect opportunity ranking.',
        amountInvestedPkr: 0,
        cashRemainingPkr:
          decisionRound(
            amount,
            2
          ),
        evidenceStrength: 0
      },
      allocations: [],
      candidates: [],
      exclusions: {
        unaffordable:
          eligibleRows.length -
          affordableRows.length,
        liquidityOrStatus:
          eligibleRows.length -
          liquidityPassed.length
      },
      warnings: [
        'This is an experimental shadow decision, not a real-money instruction.',
        'No order-execution capability exists.'
      ]
    };

    emptyResult.recording =
      await recordDecisionRun(
        emptyResult
      );

    return emptyResult;
  }

  const memoryMap =
    new Map(
      memoryRows.map(
        row => [
          normalizeSymbol(
            row.symbol
          ),
          row
        ]
      )
    );

  const historyResults =
    await decisionMapWithConcurrency(
      shortList,
      4,
      async item => {
        const historicalContext =
          await decisionHistoricalContext(
            item.row,
            memoryMap
          );

        const valuation =
          scoreDecisionValuation(
            item.row,
            eligibleRows
          );

        const entry =
          scoreDecisionEntry(
            historicalContext,
            horizon,
            riskPolicy
          );

        const riskScore =
          scoreDecisionRisk(
            item.row,
            historicalContext,
            eligibleRows
          );

        return {
          ...item,
          historicalContext,
          valuation,
          entry,
          risk:
            riskScore,
          deepProxyScore:
            decisionRound(
              horizon === 'short_term'
                ? (
                    item.screeningScore * 0.20 +
                    (
                      safeNumber(
                        historicalContext
                          ?.priceAction
                          ?.timingScore
                      ) ||
                      entry.score
                    ) * 0.50 +
                    riskScore.score * 0.30
                  )
                : (
                    item.screeningScore * 0.30 +
                    valuation.score * 0.20 +
                    entry.score * 0.30 +
                    riskScore.score * 0.20
                  ),
              2
            )
        };
      }
    );

  const historyReady =
    historyResults
      .filter(
        item =>
          item &&
          !item.error &&
          item.historicalContext
            ?.available
      )
      .sort(
        (
          a,
          b
        ) =>
          b.deepProxyScore -
          a.deepProxyScore
      );

  // 0.9.0 adaptive deep-analysis backfill. Missing evidence no longer consumes
  // the entire comparable set: NOMAD keeps moving through the ranked history-ready
  // universe until it reaches the comparable target or exhausts the bounded research budget.
  const deepResults = [];
  const deepAttemptedItems = [];
  let comparableCount = 0;
  let actionableSuitableCount = 0;
  let deepCursor = 0;

  while (
    deepCursor < historyReady.length &&
    deepAttemptedItems.length <
      DECISION_CENTER_DEEP_ATTEMPT_LIMIT &&
    (
      comparableCount <
        DECISION_CENTER_COMPARABLE_TARGET ||
      actionableSuitableCount <
        researchActionableTarget
    )
  ) {
    const remainingAttempts =
      DECISION_CENTER_DEEP_ATTEMPT_LIMIT -
      deepAttemptedItems.length;

    const batch =
      historyReady.slice(
        deepCursor,
        deepCursor +
          Math.min(
            DECISION_CENTER_DEEP_BATCH_SIZE,
            remainingAttempts
          )
      );

    if (!batch.length) {
      break;
    }

    deepCursor +=
      batch.length;

    deepAttemptedItems.push(
      ...batch
    );

    const batchResults =
      await decisionMapWithConcurrency(
        batch,
        4,
        async item => {
          let fundamentalEvidence;
          let fundamentals;
          let fundamental;

          if (horizon === 'short_term') {
            fundamentalEvidence = {
              evidenceState: 'SECONDARY_NOT_REQUIRED',
              cachedAt: null,
              error: null,
              diagnostics: null,
              fundamentals: null
            };
            fundamentals = null;
            fundamental = {
              available: false,
              score: 50,
              coverage: 0,
              metrics: {},
              reasons: [
                'Short-term market action is not gated by financial-statement completeness.'
              ],
              risks: [],
              evidenceState: 'SECONDARY_NOT_REQUIRED',
              cachedAt: null
            };
          } else {
            fundamentalEvidence =
              await decisionLoadFundamentals(
                item.row,
                memoryMap
              );

            fundamentals =
              fundamentalEvidence
                .fundamentals;

            fundamental =
              scoreDecisionFundamentals(
                fundamentals
              );

            fundamental.evidenceState =
              fundamentalEvidence
                .evidenceState;

            fundamental.cachedAt =
              fundamentalEvidence
                .cachedAt;

            if (
              fundamentalEvidence.error
            ) {
              fundamental.risks =
                uniqueTextValues([
                  ...(
                    fundamental.risks ||
                    []
                  ),
                  fundamentalEvidence.error
                ]);
            }
          }

          const traderEvidence =
            horizon === 'short_term'
              ? decisionTraderEvidenceProfile({
                  horizon,
                  historicalContext:
                    item.historicalContext
                })
              : null;

          const dataQuality =
            horizon === 'short_term'
              ? {
                  score:
                    traderEvidence.score,
                  missing:
                    traderEvidence.missing
                }
              : scoreDecisionDataQuality(
                  item.row,
                  item.historicalContext,
                  fundamental
                );

          const overallScore =
            horizon === 'short_term'
              ? decisionRound(
                  decisionClamp(
                    (
                      safeNumber(
                        item.historicalContext
                          ?.priceAction
                          ?.timingScore
                      ) ||
                      item.entry.score
                    ) * 0.55 +
                    item.risk.score * 0.25 +
                    dataQuality.score * 0.20
                  ),
                  2
                )
              : decisionOverallScore(
                  model,
                  fundamental,
                  item.valuation,
                  item.entry,
                  item.risk,
                  dataQuality
                );

          const candidate = {
            horizon,
            recommendationEligible:
              item.row.recommendationEligible ===
                true,
            symbol:
              item.row.symbol,
            companyName:
              item.row.companyName,
            sector:
              item.row.sector,
            statusCodes:
              item.row.statusCodes ||
              [],
            price:
              decisionRound(
                item.row.price,
                4
              ),
            marketAsOf:
              item.row.asOf ||
              market.asOf ||
              null,
            averageVolume30d:
              decisionRound(
                item.row.averageVolume30d,
                0
              ),
            screeningScore:
              item.screeningScore,
            historicalContext:
              item.historicalContext,
            fundamental,
            analystCore:
              fundamentals?.analystCore ||
              null,
            fundamentalEvidenceState:
              fundamentalEvidence
                .evidenceState,
            fundamentalEvidenceDiagnostics:
              fundamentalEvidence
                .diagnostics ||
              null,
            valuation:
              item.valuation,
            entry:
              item.entry,
            risk:
              item.risk,
            dataQuality,
            overallScore
          };

          const action =
            horizon === 'short_term'
              ? {
                  action: 'WAIT',
                  reason:
                    'Legacy weighted action is bypassed in short-term mode; the dedicated Trader brain is authoritative.'
                }
              : decisionCandidateAction(
                  candidate,
                  model,
                  riskPolicy
                );

          candidate.action =
            action.action;

          candidate.actionReason =
            action.reason;

          candidate.narrative =
            decisionCandidateNarrative(
              candidate
            );

          candidate.canonicalState =
            decisionCanonicalCompanyState(
              candidate
            );

          if (horizon === 'short_term') {
            candidate.action =
              candidate.canonicalState
                .marketAction;
            candidate.actionReason =
              candidate.canonicalState
                .reason;
          }

          candidate.profileSuitability =
            decisionProfileSuitability(
              candidate,
              riskPolicy
            );

          return candidate;
        }
      );

    deepResults.push(
      ...batchResults
    );

    comparableCount =
      deepResults.filter(
        candidate =>
          candidate &&
          !candidate.error &&
          candidate.symbol &&
          candidate.canonicalState
            ?.opportunityTier !==
            'EVIDENCE_RESEARCH'
      ).length;

    actionableSuitableCount =
      deepResults.filter(
        candidate =>
          candidate &&
          !candidate.error &&
          candidate.symbol &&
          candidate.canonicalState
            ?.allocationPermission
            ?.allowed === true &&
          candidate.profileSuitability
            ?.state === 'SUITABLE' &&
          safeNumber(candidate.price) !== null &&
          safeNumber(candidate.price) <= amount &&
          (
            candidate.canonicalState
              ?.marketAction === 'BUY' ||
            candidate.canonicalState
              ?.marketAction === 'ACCUMULATE'
          )
      ).length;
  }

  const deepShortList =
    deepAttemptedItems;

  const candidates =
    deepResults
      .filter(
        candidate =>
          candidate &&
          !candidate.error &&
          candidate.symbol
      )
      .sort(
        (
          a,
          b
        ) =>
          b.overallScore -
          a.overallScore
      );

  const opportunityBoard =
    buildDecisionOpportunityBoard(
      candidates
    );

  const allocation =
    allocateDecisionCenterOpportunities(
      opportunityBoard,
      amount,
      riskPolicy,
      portfolioContext
    );

  let action = 'WATCH';
  let headline =
    'No Priority 1 allocation currently passes the shadow allocation gates.';
  let reason =
    'NOMAD keeps opportunities visible. Only canonical BUY or ACCUMULATE states that pass evidence, profile suitability and portfolio-fit gates may receive capital; WATCH, RESEARCHING and AVOID receive PKR 0.';

  const dataBlockedCount =
    candidates.filter(
      candidate =>
        candidate.action ===
          'DATA_BLOCKED'
    ).length;

  const priorityOneCount =
    opportunityBoard
      .priority1
      .length;

  const priorityTwoCount =
    opportunityBoard
      .priority2
      .length;

  const evidenceResearchCount =
    opportunityBoard
      .evidenceResearch
      .length;

  const researchRequiredCount =
    evidenceResearchCount;

  const decisionBlocked =
    candidates.length === 0 &&
    (
      deepShortList.length > 0 ||
      (
        shortList.length > 0 &&
        historyReady.length === 0
      )
    );

  if (decisionBlocked) {
    action =
      'DATA_BLOCKED';
    headline =
      'Decision blocked — required market evidence could not be completed.';
    reason =
      'This is a data/reliability failure, not an investment view. NOMAD did not substitute a guess.';
  } else if (
    allocation.allocations.length
  ) {
    action =
      allocation.investedPct >= 75
        ? 'INVEST'
        : 'PARTIAL_INVEST';
    headline =
      horizon === 'short_term'
        ? (
            priorityOneCount === 1
              ? 'One active short-term trade setup currently passes the Trader brain gates.'
              : 'Active short-term trade setups currently pass the Trader brain gates.'
          )
        : (
            priorityOneCount === 1
              ? 'One Priority 1 opportunity currently passes the shadow allocation gates.'
              : 'Priority 1 opportunities currently pass the shadow allocation gates.'
          );
    reason =
      horizon === 'short_term'
        ? 'The Trader brain requires a defined setup, technical evidence, profile suitability, entry, invalidation, target and minimum reward-to-risk before capital is permitted. Position size is also capped by the selected profile\'s per-trade risk budget.'
        : 'The capital allocator builds a portfolio-aware target from the strongest opportunities that passed the current shadow allocation gates. Position sizes are conviction-weighted, profile-gated and constrained by stock/sector limits; existing holdings are applied to the combined post-investment portfolio before whole shares are calculated.';
  } else if (
    priorityOneCount > 0
  ) {
    action = 'WATCH';
    headline =
      'Priority 1 opportunities exist, but this amount cannot express them within current risk limits.';
    reason =
      'The opportunity ranking is independent of budget. NOMAD did not replace a better stock with a weaker one simply because the weaker share price fit the entered amount.';
  } else if (
    priorityTwoCount > 0
  ) {
    action = 'WATCH';
    headline =
      horizon === 'short_term'
        ? 'No active short-term setup passes the full trade gate; the best current setups remain on watch.'
        : 'No Priority 1 idea passes the full standard; the best current ideas remain Priority 2.';
    reason =
      horizon === 'short_term'
        ? 'These stocks have technical context worth monitoring, but setup confirmation, timing, reward-to-risk or trade-plan completeness is not yet strong enough for entry.'
        : 'These companies remain worth monitoring, but one or more thesis, evidence, valuation or entry conditions do not pass the current shadow allocation gate.';
  } else if (
    researchRequiredCount > 0
  ) {
    action =
      'EVIDENCE_RESEARCH';
    headline =
      horizon === 'short_term'
        ? 'Potential setups exist and NOMAD is refreshing the missing technical evidence.'
        : 'Interesting candidates exist and NOMAD is automatically researching the missing evidence.';
    reason =
      horizon === 'short_term'
        ? 'Missing OHLC, momentum, volume, level or trade-plan evidence is a research trigger, not a trade signal. Allocation remains blocked until a complete setup is available.'
        : 'Missing evidence is a research trigger, not a final verdict. NOMAD keeps these names visible, backfills additional candidates, and blocks allocation until the evidence state becomes actionable.';
  }

  if (
    allocation.diversificationException
      ?.triggered === true
  ) {
    reason +=
      ' Diversification exception: ' +
      allocation.diversificationException.reason;
  }

  const evidencePool =
    opportunityBoard.priority1.length
      ? opportunityBoard.priority1
      : opportunityBoard.priority2.length
        ? opportunityBoard.priority2
        : opportunityBoard.evidenceResearch;

  const averageMetric =
    (
      list,
      getter
    ) => {
      if (!list.length) {
        return 0;
      }

      return decisionRound(
        list.reduce(
          (
            sum,
            item
          ) =>
            sum +
            (
              safeNumber(
                getter(item)
              ) ||
              0
            ),
          0
        ) /
        list.length,
        2
      );
    };

  const evidenceSample =
    evidencePool.slice(
      0,
      5
    );

  const evidenceProfile = {
    confidenceScore:
      averageMetric(
        evidenceSample,
        item =>
          item.canonicalState
            ?.evidence
            ?.score
      ),
    summaryCoveragePct:
      averageMetric(
        evidenceSample,
        item =>
          item.canonicalState
            ?.evidence
            ?.summaryCoveragePct
      ),
    extendedCoveragePct:
      averageMetric(
        evidenceSample,
        item =>
          item.canonicalState
            ?.evidence
            ?.extendedCoveragePct
      ),
    technicalCoveragePct:
      horizon === 'short_term'
        ? averageMetric(
            evidenceSample,
            item =>
              item.canonicalState
                ?.evidence
                ?.technicalCoveragePct
          )
        : null,
    tradePlanCoveragePct:
      horizon === 'short_term'
        ? averageMetric(
            evidenceSample,
            item =>
              item.canonicalState
                ?.evidence
                ?.tradePlanCoveragePct
          )
        : null,
    dataQualityPct:
      averageMetric(
        evidenceSample,
        item =>
          item.canonicalState
            ?.evidence
            ?.dataQualityPct
      )
  };

  if (horizon === 'short_term') {
    evidenceProfile.setupCompleteness =
      evidenceProfile.tradePlanCoveragePct >= 99
        ? 'COMPLETE'
        : evidenceProfile.tradePlanCoveragePct > 0
          ? 'PARTIAL'
          : 'INCOMPLETE';
  }

  evidenceProfile.confidence =
    evidenceProfile.confidenceScore >= 82
      ? 'HIGH'
      : evidenceProfile.confidenceScore >= 62
        ? 'MEDIUM'
        : evidenceProfile.confidenceScore >= 42
          ? 'LOW'
          : 'UNRESOLVED';

  const evidenceStrength =
    evidenceProfile.confidenceScore;

  const result = {
    status: 'OK',
    build: VERSION,
    engineMode: 'SHADOW',
    validationStatus:
      model.status,
    realMoneyEligible: false,
    startedAt,
    completedAt:
      new Date()
        .toISOString(),
    model: {
      id:
        model.id,
      horizon:
        model.horizon,
      status:
        model.status,
      realMoneyEligible:
        false,
      weights:
        model.weights
    },
    riskPolicy: {
      id:
        riskPolicy.id,
      assumptions: {
        minAverageVolume30d:
          riskPolicy.minAverageVolume30d,
        maxAnnualizedVolatilityPct:
          riskPolicy.maxAnnualizedVolatilityPct,
        minDataQualityScore:
          riskPolicy.minDataQualityScore,
        minOverallScore:
          riskPolicy.minOverallScore,
        minRiskScore:
          riskPolicy.minRiskScore,
        maxStockPct:
          riskPolicy.maxStockPct *
          100,
        maxSectorPct:
          riskPolicy.maxSectorPct *
          100
      }
    },
    input: {
      amount:
        decisionRound(
          amount,
          2
        ),
      horizon,
      risk
    },
    market: {
      asOf:
        market.marketWatchAsOf ||
        market.asOf ||
        null,
      source:
        'Official PSX Data Portal screener',
      canonicalUniverseVersion:
        PSX_UNIVERSE_MASTER.masterVersion
    },
    screening: {
      eligibleUniverse:
        eligibleRows.length,
      affordableUniverse:
        affordableRows.length,
      liquidityPassed:
        liquidityPassed.length,
      shortlisted:
        shortList.length,
      historicalAnalyzed:
        historyReady.length,
      deepAnalyzed:
        deepAttemptedItems.length,
      comparableAnalyzed:
        comparableCount,
      actionableProfileFit:
        actionableSuitableCount,
      actionableResearchTarget:
        researchActionableTarget,
      evidenceResearch:
        evidenceResearchCount,
      deepAttemptLimit:
        DECISION_CENTER_DEEP_ATTEMPT_LIMIT,
      comparableTarget:
        DECISION_CENTER_COMPARABLE_TARGET,
      dataBlocked:
        dataBlockedCount,
      rankingBudgetIndependent:
        true
    },
    decision: {
      action,
      headline,
      reason,
      amountInvestedPkr:
        allocation.amountInvestedPkr,
      cashRemainingPkr:
        allocation.cashRemainingPkr,
      investedPct:
        allocation.investedPct,
      evidenceStrength,
      evidence:
        evidenceProfile,
      probabilityClaim:
        'NONE — evidence strength is not a calibrated probability.'
    },
    allocations:
      allocation.allocations,
    opportunityBoard: {
      priority1:
        opportunityBoard.priority1,
      priority2:
        opportunityBoard.priority2,
      evidenceResearch:
        opportunityBoard.evidenceResearch,
      researchRequired:
        opportunityBoard.evidenceResearch,
      avoid:
        opportunityBoard.avoid
    },
    allocationDiagnostics: {
      deploymentCapPct:
        allocation.deploymentCapPct,
      portfolioAware:
        allocation.portfolioAware ===
          true,
      existingPortfolioValuePkr:
        allocation.existingPortfolioValuePkr ||
        0,
      targetPositionCount:
        allocation.targetPositionCount ||
        0,
      sizingPositionCount:
        allocation.sizingPositionCount ||
        0,
      targetDeploymentPct:
        allocation.targetDeploymentPct ??
        allocation.deploymentCapPct ??
        0,
      intentionalCashReservePct:
        allocation.intentionalCashReservePct ??
        0,
      averageConvictionScore:
        allocation.averageConvictionScore ??
        0,
      cashReserveReason:
        allocation.cashReserveReason ||
        '',
      minimumTargetPositions:
        allocation.minimumTargetPositions ||
        DECISION_CENTER_MIN_TARGET_POSITIONS,
      maximumTargetPositions:
        allocation.maximumTargetPositions ||
        DECISION_CENTER_MAX_TARGET_POSITIONS,
      achievedPositionCount:
        allocation.achievedPositionCount ||
        0,
      diversificationException:
        allocation.diversificationException ||
        { triggered: false, reason: null },
      eligibleAllocationCandidates:
        allocation.eligibleAllocationCandidates ||
        0,
      priorityOneAllocationCandidates:
        allocation.priorityOneAllocationCandidates ||
        0,
      priorityTwoAllocationCandidates:
        allocation.priorityTwoAllocationCandidates ||
        0,
      dynamicMaxStockPct:
        allocation.dynamicMaxStockPct ||
        0,
      dynamicMaxSectorPct:
        allocation.dynamicMaxSectorPct ||
        0,
      personalActions:
        allocation.personalActions ||
        [],
      unfundedPriorityOne:
        allocation.unfundedPriorityOne
    },
    portfolioContext: {
      holdingCount:
        portfolioContext.holdingCount ||
        0,
      currentValuePkr:
        portfolioContext.currentValuePkr ||
        0
    },
    candidates,
    exclusions: {
      unaffordable:
        eligibleRows.length -
        affordableRows.length,
      liquidityOrStatus:
        eligibleRows.length -
        liquidityPassed.length,
      historicalUnavailable:
        shortList.length -
        historyReady.length
    },
    warnings: [
      'SHADOW MODE: this model has not passed historical and forward validation for real-money use.',
      'Allocations are planning principals only. Brokerage, levies, taxes and execution slippage are not yet included.',
      'No order-execution capability exists. The user remains the final decision maker.',
      'Current scoring rules remain supporting evidence only; Priority 1 now also requires the Financial Analyst evidence gate.',
      'Opportunity ranking is independent of the entered budget. Portfolio construction targets at least three funded stocks and scales up to eight, but never forces a weak, unresolved, profile-unsuitable, unaffordable, or portfolio-incompatible name merely to hit the count.',
      ...(
        candidates.some(
          candidate =>
            candidate.fundamentalEvidenceState ===
              'CACHE_FALLBACK'
        )
          ? [
              'At least one candidate used recent cached company fundamentals because the live PSX company evidence request was unavailable.'
            ]
          : []
      )
    ]
  };

  result.recording =
    await recordDecisionRun(
      result
    );

  return result;
}

function runDecisionEngineSelfTests() {
  const assert =
    require(
      'node:assert/strict'
    );

  const plainMarketRows =
    parseMarketWatchRows(
      '<table><tr><td>ABC</td><td>0801</td><td>ALLSHR</td><td>100</td><td>101</td><td>105</td><td>99</td><td>104</td><td>4</td><td>4.00%</td><td>1,250,000</td></tr></table>'
    );

  assert.equal(
    plainMarketRows.length,
    1
  );

  assert.equal(
    plainMarketRows[0]
      .symbol,
    'ABC'
  );

  assert.equal(
    plainMarketRows[0]
      .changePct,
    4
  );

  const listingInfo =
    parseCompanyListingInfo(
      [
        'ABC',
        'ABC LIMITED',
        'QUOTE',
        'COMMERCIAL BANKS'
      ],
      'ABC LIMITED',
      'ABC'
    );

  assert.equal(
    listingInfo.boardType,
    null,
    'ordinary company-page parsing must not depend on an undefined boardInfo object'
  );

  const gemListingInfo =
    parseCompanyListingInfo(
      [
        'GEMABC',
        'ABC LIMITED (GEM)',
        'QUOTE'
      ],
      'ABC LIMITED (GEM)',
      'GEMABC'
    );

  assert.equal(
    gemListingInfo.boardType,
    'GEM',
    'GEM fallback board detection must remain intact'
  );

  const analystSynthetic =
    buildFinancialAnalystCore({
      symbol: 'SYNTH',
      company: {
        name: 'Synthetic Manufacturing',
        sector: 'Engineering'
      },
      source: 'Synthetic test',
      sourceUrl: null,
      fetchedAt:
        new Date()
          .toISOString(),
      valuation: {
        dividendYield: 5
      },
      annual: {
        periods: [
          '2026',
          '2025',
          '2024'
        ],
        rows: [
          {
            label: 'Sales',
            values: [
              { period: '2026', value: 1200 },
              { period: '2025', value: 1000 },
              { period: '2024', value: 900 }
            ]
          },
          {
            label: 'Profit After Taxation',
            values: [
              { period: '2026', value: 150 },
              { period: '2025', value: 120 },
              { period: '2024', value: 100 }
            ]
          },
          {
            label: 'EPS',
            values: [
              { period: '2026', value: 15 },
              { period: '2025', value: 12 },
              { period: '2024', value: 10 }
            ]
          },
          {
            label: 'Total Assets',
            values: [
              { period: '2026', value: 2000 },
              { period: '2025', value: 1800 }
            ]
          },
          {
            label: 'Total Equity',
            values: [
              { period: '2026', value: 1000 },
              { period: '2025', value: 900 }
            ]
          },
          {
            label: 'Borrowings',
            values: [
              { period: '2026', value: 300 },
              { period: '2025', value: 350 }
            ]
          },
          {
            label: 'Finance Cost',
            values: [
              { period: '2026', value: 40 },
              { period: '2025', value: 50 }
            ]
          },
          {
            label: 'Cash Flow From Operating Activities',
            values: [
              { period: '2026', value: 180 },
              { period: '2025', value: 130 }
            ]
          },
          {
            label: 'Other Income',
            values: [
              { period: '2026', value: 10 },
              { period: '2025', value: 8 }
            ]
          }
        ]
      },
      quarterly: null,
      ratios: {
        periods: [
          '2026',
          '2025'
        ],
        rows: [
          {
            label: 'Return on Equity',
            values: [
              { period: '2026', value: 18 },
              { period: '2025', value: 15 }
            ]
          },
          {
            label: 'Net Profit Margin',
            values: [
              { period: '2026', value: 12.5 },
              { period: '2025', value: 12 }
            ]
          }
        ]
      }
    });

  assert.equal(
    analystSynthetic.evidence
      .revenue.latest.value,
    1200
  );

  assert.equal(
    analystSynthetic.views
      .profitTrend.state,
    'IMPROVING'
  );

  assert.equal(
    analystSynthetic.views
      .cashFlowQuality.state,
    'STRONG'
  );

  assert.equal(
    analystSynthetic.affectsDecision,
    false
  );

  const analystMissing =
    buildFinancialAnalystCore({
      symbol: 'EMPTY',
      company: {
        name: 'Empty Evidence',
        sector: 'Engineering'
      },
      annual: null,
      quarterly: null,
      ratios: null,
      valuation: {}
    });

  assert.equal(
    analystMissing.status,
    'DATA_BLOCKED'
  );

  assert.equal(
    analystMissing.evidence
      .operatingCashFlow.available,
    false
  );

  const riskBalanced =
    DECISION_RISK_POLICIES
      .balanced;

  const upContext = {
    available: true,
    price: 100,
    trend: 'Uptrend',
    returns: {
      d5: 2,
      m1: 5,
      m3: 12
    },
    movingAverages: {
      sma20: 96,
      sma50: 92,
      sma200: 85
    },
    technical: {
      rsi14: 56,
      macdHistogram: 1,
      volumeRatio20d: 1.3,
      annualizedVolatility20dPct: 30,
      maxDrawdown52wPct: -12
    },
    validSessions: 260
  };

  const downContext = {
    ...upContext,
    trend: 'Downtrend',
    returns: {
      d5: -4,
      m1: -14,
      m3: -22
    },
    movingAverages: {
      sma20: 110,
      sma50: 115,
      sma200: 120
    },
    technical: {
      ...upContext.technical,
      rsi14: 31,
      macdHistogram: -1
    }
  };

  assert.ok(
    scoreDecisionEntry(
      upContext,
      'long_term',
      riskBalanced
    ).score >
      scoreDecisionEntry(
        downContext,
        'long_term',
        riskBalanced
      ).score,
    'positive entry context must score above negative context'
  );

  const goodCandidate = {
    statusCodes: [],
    overallScore: 80,
    fundamental: {
      available: true,
      score: 78
    },
    entry: {
      score: 70
    },
    risk: {
      score: 70
    },
    dataQuality: {
      score: 90
    }
  };

  assert.equal(
    decisionCandidateAction(
      goodCandidate,
      DECISION_MODELS
        .long_term,
      riskBalanced
    ).action,
    'BUY_NOW'
  );

  assert.equal(
    decisionCandidateAction(
      {
        ...goodCandidate,
        dataQuality: {
          score: 40
        }
      },
      DECISION_MODELS
        .long_term,
      riskBalanced
    ).action,
    'DATA_BLOCKED'
  );

  const allocation =
    allocateDecisionCandidates(
      [
        {
          symbol: 'TESTA',
          companyName: 'Synthetic A',
          sector: 'A',
          action: 'BUY_NOW',
          price: 100,
          overallScore: 85,
          dataQuality: {
            score: 90
          }
        },
        {
          symbol: 'TESTB',
          companyName: 'Synthetic B',
          sector: 'B',
          action: 'BUY_NOW',
          price: 50,
          overallScore: 80,
          dataQuality: {
            score: 90
          }
        }
      ],
      5000,
      riskBalanced
    );

  assert.ok(
    allocation.amountInvestedPkr <=
      5000,
    'allocation must not exceed budget'
  );

  assert.ok(
    allocation.allocations.every(
      item =>
        Number.isInteger(
          item.shares
        ) &&
        item.shares > 0
    ),
    'allocations must use positive whole shares'
  );

  assert.ok(
    DECISION_RISK_POLICIES
      .conservative
      .maxStockPct <
      DECISION_RISK_POLICIES
        .aggressive
        .maxStockPct,
    'conservative position cap must be tighter than aggressive'
  );

  const validatedDecisionCandidate = {
    ...goodCandidate,
    symbol: 'VALID',
    companyName: 'Validated Company',
    sector: 'Engineering',
    price: 100,
    horizon: 'long_term',
    valuation: { score: 78 },
    risk: { score: 72, liquidityScore: 80 },
    dataQuality: { score: 90 },
    historicalContext: {
      available: true,
      priceAction: {
        available: true,
        timingScore: 74,
        timingState: 'GOOD',
        setup: 'TREND_PULLBACK',
        rewardRisk: 2
      }
    },
    analystCore: {
      company: {
        financialSector: false
      },
      coverage: {
        coreCoveragePct: 100,
        summaryCoveragePct: 100,
        extendedCoveragePct: 100
      },
      overallFinancialView: {
        state: 'GOOD'
      },
      views: {
        earningsQuality: {
          state: 'ACCEPTABLE'
        },
        cashFlowQuality: {
          state: 'STRONG'
        },
        balanceSheet: {
          state: 'EVIDENCE_AVAILABLE'
        }
      }
    },
    action: 'BUY_NOW',
    actionReason: 'Synthetic validated buy.',
    narrative: {
      positives: [],
      risks: []
    }
  };

  assert.equal(
    decisionCenterAnalystGate(
      validatedDecisionCandidate
    ).state,
    'VALIDATED',
    'complete analyst evidence must be eligible for Priority 1 validation'
  );

  assert.equal(
    decisionCenterAnalystGate({
      ...validatedDecisionCandidate,
      analystCore: null
    }).state,
    'RESEARCHING',
    'missing analyst evidence must trigger automatic research and cannot become Priority 1'
  );

  const summaryValidatedCandidate = {
    ...validatedDecisionCandidate,
    symbol: 'SUMMARY',
    analystCore: {
      ...validatedDecisionCandidate.analystCore,
      evidenceTier: 'PSX_SUMMARY',
      coverage: {
        coreCoveragePct: 100,
        summaryCoveragePct: 100,
        extendedCoveragePct: 0
      },
      views: {
        ...validatedDecisionCandidate.analystCore.views,
        earningsQuality: { state: 'UNRELIABLE' },
        cashFlowQuality: { state: 'UNRELIABLE' },
        balanceSheet: { state: 'UNRELIABLE' }
      }
    }
  };

  assert.equal(
    decisionCenterAnalystGate(
      summaryValidatedCandidate
    ).state,
    'PARTIALLY_VALIDATED',
    'complete PSX summary evidence must remain partially validated when the source does not provide extended statements'
  );

  assert.equal(
    decisionCenterCandidateView(
      summaryValidatedCandidate
    ).decisionCenterView,
    'ACCUMULATE',
    'summary-only validation must cap a BUY_NOW legacy signal at staged ACCUMULATE'
  );

  const psxSummarySynthetic =
    buildFinancialAnalystCore({
      symbol: 'PSXSUM',
      company: {
        name: 'PSX Summary Synthetic',
        sector: 'REFINERY'
      },
      source: 'Synthetic PSX summary',
      annual: {
        periods: ['2026', '2025', '2024'],
        rows: [
          { label: 'Sales', values: [
            { period: '2026', value: 1200 },
            { period: '2025', value: 1000 },
            { period: '2024', value: 900 }
          ] },
          { label: 'Profit after Taxation', values: [
            { period: '2026', value: 150 },
            { period: '2025', value: 100 },
            { period: '2024', value: 80 }
          ] },
          { label: 'EPS', values: [
            { period: '2026', value: 15 },
            { period: '2025', value: 10 },
            { period: '2024', value: 8 }
          ] }
        ]
      },
      quarterly: null,
      ratios: {
        periods: ['2026', '2025', '2024'],
        rows: [
          { label: 'Gross Profit Margin (%)', values: [
            { period: '2026', value: 12 },
            { period: '2025', value: 10 },
            { period: '2024', value: 9 }
          ] },
          { label: 'Net Profit Margin (%)', values: [
            { period: '2026', value: 8 },
            { period: '2025', value: 6 },
            { period: '2024', value: 5 }
          ] }
        ]
      },
      valuation: {}
    });

  assert.equal(
    psxSummarySynthetic.coverage.summaryCoveragePct,
    100,
    'PSX summary financials and ratio labels with (%) must produce full headline coverage'
  );

  assert.equal(
    psxSummarySynthetic.coverage.extendedCoveragePct,
    0,
    'PSX summary evidence must not pretend full-statement evidence exists'
  );

  const syntheticBoard =
    buildDecisionOpportunityBoard([
      validatedDecisionCandidate,
      {
        ...validatedDecisionCandidate,
        symbol: 'RESEARCH',
        analystCore: null
      }
    ]);

  assert.equal(
    syntheticBoard.priority1[0]
      .symbol,
    'VALID',
    'validated candidate must reach Priority 1'
  );

  assert.equal(
    syntheticBoard.researchRequired[0]
      .symbol,
    'RESEARCH',
    'missing-evidence candidate must remain visible under Evidence Research'
  );

  const strictAllocation =
    allocateDecisionCenterOpportunities(
      syntheticBoard,
      5000,
      riskBalanced
    );

  assert.ok(
    strictAllocation.amountInvestedPkr <=
      5000,
    'Decision Center allocation must not exceed the entered amount'
  );

  assert.ok(
    strictAllocation.allocations.every(
      item =>
        Number.isInteger(
          item.shares
        ) &&
        item.shares > 0
    ),
    'Decision Center allocation must use positive whole shares'
  );

  const profileFitBase = {
    ...validatedDecisionCandidate,
    symbol: 'PROFILEOK',
    sector: 'Synthetic Sector A',
    recommendationEligible: true,
    averageVolume30d: 500000,
    dataQuality: { score: 90 },
    risk: { score: 72, liquidityScore: 80 },
    historicalContext: {
      available: true,
      technical: {
        annualizedVolatility20dPct: 40
      },
      priceAction: {
        available: true,
        timingScore: 74,
        timingState: 'GOOD',
        setup: 'TREND_PULLBACK',
        rewardRisk: 2
      }
    }
  };

  const profileFailVolatility = {
    ...profileFitBase,
    symbol: 'PROFILEFAIL',
    sector: 'Synthetic Sector B',
    historicalContext: {
      ...profileFitBase.historicalContext,
      technical: {
        annualizedVolatility20dPct: 85
      }
    }
  };

  assert.equal(
    decisionProfileSuitability(
      profileFitBase,
      riskBalanced
    ).state,
    'SUITABLE',
    'balanced profile must accept a candidate inside its hard volatility limit'
  );

  assert.equal(
    decisionProfileSuitability(
      profileFailVolatility,
      riskBalanced
    ).state,
    'NOT_SUITABLE',
    'balanced profile must reject a candidate above its hard volatility limit'
  );

  const profileGateBoard =
    buildDecisionOpportunityBoard([
      profileFitBase,
      profileFailVolatility
    ]);

  const profileGateAllocation =
    allocateDecisionCenterOpportunities(
      profileGateBoard,
      500000,
      riskBalanced
    );

  assert.equal(
    profileGateAllocation.allocations.some(
      item =>
        item.symbol === 'PROFILEFAIL'
    ),
    false,
    'profile-unsuitable candidates must receive PKR 0 even when the market thesis is actionable'
  );

  const breadthCandidates =
    Array.from(
      { length: 8 },
      (_, index) => ({
        ...profileFitBase,
        symbol: 'BREADTH' +
          String(index + 1),
        companyName:
          'Breadth Candidate ' +
          String(index + 1),
        sector:
          'Synthetic Sector ' +
          String(index + 1),
        price:
          50 +
          index * 5,
        overallScore:
          84 -
          index * 0.5,
        valuation: {
          score:
            84 -
            index * 3
        }
      })
    );

  const breadthBoard =
    buildDecisionOpportunityBoard(
      breadthCandidates
    );

  const breadthAllocation =
    allocateDecisionCenterOpportunities(
      breadthBoard,
      500000,
      riskBalanced
    );

  assert.equal(
    decisionCenterTargetPositionCount(
      500000,
      riskBalanced
    ),
    6,
    'a PKR 500k balanced portfolio should target six positions under the locked 3-to-8 construction policy'
  );

  assert.ok(
    breadthAllocation.allocations.length >= 6,
    'when enough suitable actionable ideas exist, a PKR 500k balanced plan should reach its six-position target'
  );

  assert.ok(
    breadthAllocation.allocations.length <= 6,
    'a PKR 500k balanced plan must not exceed its preferred six-position target'
  );

  assert.ok(
    breadthAllocation.investedPct >= 75,
    'when enough suitable actionable ideas exist, the allocator should deploy most of a PKR 500k balanced budget within its risk caps'
  );


  assert.ok(
    new Set(
      breadthAllocation.allocations.map(
        item =>
          Math.round(
            item.principalPkr
          )
      )
    ).size > 1,
    'professional position sizing should not default every surviving stock to the same rupee weight when conviction differs'
  );

  assert.equal(
    breadthAllocation.diversificationException.triggered,
    false,
    'the diversification exception must stay off when at least three prudent positions can be funded'
  );

  const twoIdeaBoard =
    buildDecisionOpportunityBoard(
      breadthCandidates.slice(0, 2)
    );

  const twoIdeaAllocation =
    allocateDecisionCenterOpportunities(
      twoIdeaBoard,
      500000,
      riskBalanced
    );

  assert.equal(
    twoIdeaAllocation.allocations.length,
    2,
    'NOMAD must not invent or force a third stock when only two stocks pass the professional gates'
  );

  assert.equal(
    twoIdeaAllocation.diversificationException.triggered,
    true,
    'fewer than three prudent funded positions must produce an explicit diversification exception'
  );

  const watchCandidate = {
    ...validatedDecisionCandidate,
    symbol: 'WATCHONLY',
    action: 'WAIT',
    actionReason: 'Synthetic watch state.',
    historicalContext: {
      available: true,
      priceAction: {
        available: true,
        timingScore: 35,
        timingState: 'RISKY',
        setup: 'NO_CLEAR_SETUP',
        rewardRisk: 0.7
      }
    }
  };

  const watchBoard =
    buildDecisionOpportunityBoard([
      watchCandidate
    ]);

  const watchAllocation =
    allocateDecisionCenterOpportunities(
      watchBoard,
      100000,
      riskBalanced
    );

  assert.equal(
    watchAllocation.allocations.length,
    0,
    'canonical WATCH state must never receive new capital'
  );

  const researchCanonical =
    decisionCanonicalCompanyState({
      ...validatedDecisionCandidate,
      symbol: 'RESEARCH2',
      analystCore: null
    });

  assert.equal(
    researchCanonical.allocationPermission.allowed,
    false,
    'active Evidence Research must always block allocation'
  );


  assert.equal(
    researchCanonical.marketAction,
    'RESEARCHING',
    'missing evidence must be represented as RESEARCHING rather than WATCH'
  );

  assert.ok(
    breadthAllocation.targetDeploymentPct >= 75 &&
    breadthAllocation.targetDeploymentPct <= 90,
    'a broad validated balanced opportunity set should produce an intentional high-but-not-forced deployment target'
  );

  assert.ok(
    twoIdeaAllocation.targetDeploymentPct <
      breadthAllocation.targetDeploymentPct,
    'a thin two-stock opportunity set must retain more intentional cash than a broad validated set'
  );

  assert.ok(
    decisionCanonicalCompanyState(
      summaryValidatedCandidate
    ).evidence.score < 100,
    'summary-only evidence must never masquerade as complete evidence confidence'
  );

  const ledgerSynthetic =
    computePortfolioTransactionLedger([
      { id: 1, symbol: 'VALID', side: 'BUY', quantity: 100, price: 10, fees: 10, trade_date: '2026-01-01' },
      { id: 2, symbol: 'VALID', side: 'BUY', quantity: 50, price: 12, fees: 0, trade_date: '2026-02-01' },
      { id: 3, symbol: 'VALID', side: 'SELL', quantity: 50, price: 15, fees: 5, trade_date: '2026-03-01' },
      { id: 4, symbol: 'VALID', side: 'DIVIDEND', quantity: 0, price: 0, cash_amount: 100, fees: 0, trade_date: '2026-04-01' }
    ]);

  assert.equal(
    Math.round(
      ledgerSynthetic.bySymbol
        .get('VALID')
        .quantity
    ),
    100,
    'portfolio ledger must preserve the correct open share quantity after buys and sells'
  );

  assert.ok(
    ledgerSynthetic.realizedPnl >
      200 &&
    ledgerSynthetic.realizedPnl <
      210,
    'portfolio ledger must calculate average-cost realized P&L after fees'
  );

  assert.equal(
    ledgerSynthetic.dividends,
    100,
    'portfolio ledger must track dividend cash separately from trading P&L'
  );

  const oversellSynthetic =
    computePortfolioTransactionLedger([
      { id: 1, symbol: 'VALID', side: 'BUY', quantity: 10, price: 10, fees: 0, trade_date: '2026-01-01' },
      { id: 2, symbol: 'VALID', side: 'SELL', quantity: 11, price: 12, fees: 0, trade_date: '2026-01-02' }
    ]);

  assert.equal(
    oversellSynthetic.invalid.length,
    1,
    'portfolio ledger must reject a sell that exceeds available shares'
  );

  const portfolioAwareAllocation =
    allocateDecisionCenterOpportunities(
      syntheticBoard,
      5000,
      riskBalanced,
      {
        holdingCount: 1,
        currentValuePkr: 10000,
        symbolValues: { VALID: 7000 },
        sectorValues: { Engineering: 7000 }
      }
    );

  assert.equal(
    portfolioAwareAllocation.portfolioAware,
    true,
    'Decision Center allocator must declare when existing portfolio exposure was considered'
  );

  assert.ok(
    portfolioAwareAllocation.allocations.length === 0 ||
    portfolioAwareAllocation.allocations.every(
      item =>
        item.symbol !== 'VALID'
    ),
    'existing concentration above the balanced stock cap must prevent NOMAD from adding more of the same stock'
  );

  const dynamicSmall =
    decisionCenterTargetPositionCount(
      5000,
      riskBalanced
    );

  const dynamicLarge =
    decisionCenterTargetPositionCount(
      1000000,
      riskBalanced
    );

  assert.equal(
    dynamicSmall,
    3,
    'the locked portfolio-construction policy must never target fewer than three stocks'
  );

  assert.ok(
    dynamicLarge >
      dynamicSmall,
    'larger portfolios must target broader diversification than very small portfolios'
  );

  assert.ok(
    dynamicLarge <=
      DECISION_CENTER_MAX_TARGET_POSITIONS,
    'the locked portfolio-construction policy must never target more than eight stocks'
  );

  const dynamicLargeCaps =
    decisionCenterDynamicCaps(
      dynamicLarge,
      riskBalanced
    );

  assert.ok(
    dynamicLargeCaps.stockCapPct <
      riskBalanced.maxStockPct,
    'dynamic diversification must tighten the legacy per-stock cap for larger portfolios'
  );

  const marketPulseSynthetic =
    buildMarketPulseFromRows([
      { symbol: 'CORE', changePct: 5, price: 100, marketFactEligible: true },
      { symbol: 'RIGHT1', changePct: 90, price: 1, marketFactEligible: false },
      { symbol: 'FLAT', changePct: 0, price: 20, marketFactEligible: true },
      { symbol: 'LOSS', changePct: -8, price: 30, marketFactEligible: true },
      { symbol: 'LEGACY', changePct: -95, price: 2, marketFactEligible: false }
    ]);

  assert.equal(
    marketPulseSynthetic.gainers[0].symbol,
    'CORE',
    'Official PSX Top Gainers must exclude rights, legacy and other non-default market instruments'
  );

  assert.equal(
    marketPulseSynthetic.losers[0].symbol,
    'LOSS',
    'Official PSX Top Losers must exclude rights, legacy and other non-default market instruments'
  );

  assert.deepEqual(
    marketPulseSynthetic.breadth,
    { advancers: 1, decliners: 1, unchanged: 1 },
    'market breadth must use the canonical Official PSX active-equity scope'
  );

  const syntheticPriceRows = [];
  for (let index = 0; index < 80; index++) {
    const base = 100 + index * 0.35;
    syntheticPriceRows.push({
      date: '2026-01-' + String((index % 28) + 1).padStart(2, '0'),
      open: base - 0.5,
      high: base + 1.2,
      low: base - 1.0,
      close: base + 0.4,
      volume: 100000 + index * 1000
    });
  }

  const professionalPA =
    buildProfessionalPriceAction(
      syntheticPriceRows,
      {
        price: syntheticPriceRows[syntheticPriceRows.length - 1].close,
        sma20: 122,
        sma50: 116,
        sma200: 105,
        rsi14: 58,
        macdHistogram: 0.8,
        volumeRatio20d: 1.3,
        return1m: 6
      }
    );

  assert.equal(
    professionalPA.available,
    true,
    'professional price-action engine must analyze valid OHLC history'
  );

  assert.ok(
    ['GOOD', 'FAIR', 'POOR', 'RISKY'].includes(
      professionalPA.timingState
    ),
    'professional price-action engine must return a timing state'
  );

  const historicalContextWithTraderData =
    buildHistoricalContext(
      'SYNTH',
      syntheticPriceRows,
      syntheticPriceRows[
        syntheticPriceRows.length - 1
      ].close
    );

  assert.equal(
    historicalContextWithTraderData
      .contextSchemaVersion,
    DECISION_HISTORICAL_CONTEXT_SCHEMA_VERSION,
    'historical context must carry the Trader-brain schema version so stale pre-0.9.3 caches are refreshed'
  );

  assert.equal(
    historicalContextWithTraderData
      .priceAction
      ?.available,
    true,
    'historical context must return the already-computed professional price-action object to the Trader brain'
  );

  const longTermProfessionalCandidate = {
    ...validatedDecisionCandidate,
    horizon: 'long_term',
    valuation: { score: 78 },
    risk: { score: 72, liquidityScore: 80 },
    dataQuality: { score: 90 },
    historicalContext: {
      available: true,
      priceAction: {
        available: true,
        timingScore: 76,
        timingState: 'GOOD',
        setup: 'TREND_PULLBACK',
        rewardRisk: 2
      }
    }
  };

  const longTermProfessionalState =
    decisionCanonicalCompanyState(
      longTermProfessionalCandidate
    );

  assert.equal(
    longTermProfessionalState.professional.framework,
    'LONG_TERM_INVESTOR',
    'long-term mode must use the dedicated investor framework'
  );

  assert.ok(
    ['BUY', 'ACCUMULATE'].includes(
      longTermProfessionalState.marketAction
    ),
    'strong long-term thesis with good timing must be actionable'
  );

  const poorTimingLongTerm =
    decisionCanonicalCompanyState({
      ...longTermProfessionalCandidate,
      entry: {
        score: 35
      },
      historicalContext: {
        available: true,
        priceAction: {
          available: true,
          timingScore: 90,
          timingState: 'GOOD',
          setup: 'CONFIRMED_BREAKOUT',
          rewardRisk: 3
        }
      }
    });

  assert.equal(
    poorTimingLongTerm.marketAction,
    'WATCH',
    'poor long-term timing should wait for entry rather than destroy a strong thesis'
  );

  const shortTermProfessionalState =
    decisionCanonicalCompanyState({
      ...longTermProfessionalCandidate,
      horizon: 'short_term',
      historicalContext: {
        available: true,
        contextSchemaVersion:
          DECISION_HISTORICAL_CONTEXT_SCHEMA_VERSION,
        asOf:
          new Date()
            .toISOString()
            .slice(0, 10),
        validSessions: 120,
        technical: {
          rsi14: 58,
          macdHistogram: 0.8,
          volumeRatio20d: 1.4,
          annualizedVolatility20dPct: 32
        },
        priceAction: {
          available: true,
          timingScore: 82,
          timingState: 'GOOD',
          setup: 'CONFIRMED_BREAKOUT',
          atr14: 3.2,
          support: 95,
          resistance: 112,
          structure: {
            bias: 'BULLISH'
          },
          tradePlan: {
            complete: true,
            state: 'DEFINED',
            entryLow: 100,
            entryHigh: 101,
            entryReference: 100.5,
            stop: 96,
            target1: 111,
            target2: 114,
            riskPerShare: 4.5,
            riskPct: 4.48,
            rewardRisk: 2.33
          }
        }
      }
    });

  assert.equal(
    shortTermProfessionalState.professional.framework,
    'SHORT_TERM_TRADER',
    'short-term mode must use the dedicated trader framework'
  );

  assert.equal(
    shortTermProfessionalState.marketAction,
    'BUY',
    'confirmed short-term setup with acceptable reward-to-risk must be actionable'
  );

  const shortTermAllocationCandidate = {
    ...longTermProfessionalCandidate,
    symbol: 'TRADER1',
    horizon: 'short_term',
    price: 100,
    averageVolume30d: 500000,
    entry: { score: 82 },
    risk: { score: 72, liquidityScore: 85 },
    dataQuality: { score: 90 },
    historicalContext: {
      available: true,
      contextSchemaVersion:
        DECISION_HISTORICAL_CONTEXT_SCHEMA_VERSION,
      asOf:
        new Date()
          .toISOString()
          .slice(0, 10),
      validSessions: 120,
      technical: {
        rsi14: 58,
        macdHistogram: 0.8,
        volumeRatio20d: 1.4,
        annualizedVolatility20dPct: 32
      },
      priceAction: {
        available: true,
        timingScore: 82,
        timingState: 'GOOD',
        setup: 'CONFIRMED_BREAKOUT',
        atr14: 3.2,
        support: 95,
        resistance: 112,
        structure: { bias: 'BULLISH' },
        tradePlan: {
          complete: true,
          state: 'DEFINED',
          entryLow: 100,
          entryHigh: 101,
          entryReference: 100.5,
          stop: 90.5,
          target1: 120.5,
          riskPerShare: 10,
          riskPct: 9.95,
          rewardRisk: 2
        }
      }
    }
  };

  shortTermAllocationCandidate.canonicalState =
    decisionCanonicalCompanyState(
      shortTermAllocationCandidate
    );
  shortTermAllocationCandidate.profileSuitability =
    decisionProfileSuitability(
      shortTermAllocationCandidate,
      riskBalanced
    );

  const shortTermBoard =
    buildDecisionOpportunityBoard([
      shortTermAllocationCandidate
    ]);

  const shortTermRiskSized =
    allocateDecisionCenterOpportunities(
      shortTermBoard,
      100000,
      riskBalanced
    );

  assert.ok(
    !shortTermRiskSized.allocations.length ||
    shortTermRiskSized.allocations[0].principalPkr <= 10000.01,
    'Balanced short-term sizing must respect the 1% capital-at-risk budget when stop risk is PKR 10 per share at a PKR 100 price'
  );

  const shortTermMissingPlan =
    decisionCanonicalCompanyState({
      ...longTermProfessionalCandidate,
      horizon: 'short_term',
      historicalContext: {
        ...shortTermProfessionalState.professional
          ?.technicalEvidence,
        available: true,
        asOf:
          new Date()
            .toISOString()
            .slice(0, 10),
        validSessions: 120,
        technical: {
          rsi14: 58,
          macdHistogram: 0.8,
          volumeRatio20d: 1.4,
          annualizedVolatility20dPct: 32
        },
        priceAction: {
          available: true,
          timingScore: 82,
          timingState: 'GOOD',
          setup: 'CONFIRMED_BREAKOUT',
          atr14: 3.2,
          support: 95,
          resistance: 112,
          structure: {
            bias: 'BULLISH'
          },
          tradePlan: {
            complete: false,
            state: 'TARGET_UNRESOLVED',
            rewardRisk: null
          }
        }
      }
    });

  assert.notEqual(
    shortTermMissingPlan.marketAction,
    'BUY',
    'short-term mode must never BUY when entry/stop/target reward-to-risk is unresolved'
  );

  console.log(
    'NOMAD Decision Engine self-tests passed.'
  );
}


/* =========================================================
   CONTINUOUS INTELLIGENCE SCANNER - BUILD 0.8.4B.1
========================================================= */

function scannerSecretConfigured() {
  return Boolean(
    NOMAD_SCANNER_SECRET
  );
}

function scannerRequestAuthorized(
  request
) {
  if (!scannerSecretConfigured()) {
    return false;
  }

  const direct =
    String(
      request.headers[
        'x-nomad-scanner-secret'
      ] ||
      ''
    ).trim();

  const authorization =
    String(
      request.headers.authorization ||
      ''
    ).trim();

  const bearer =
    authorization
      .replace(
        /^Bearer\s+/i,
        ''
      )
      .trim();

  const supplied =
    direct ||
    (
      /^Bearer\s+/i.test(
        authorization
      )
        ? bearer
        : ''
    );

  return Boolean(
    supplied &&
    safeEqual(
      supplied,
      NOMAD_SCANNER_SECRET
    )
  );
}

function normalizeStatusArray(
  value
) {
  return (
    Array.isArray(value)
      ? value
      : []
  )
    .map(
      item =>
        String(item || '')
          .trim()
          .toUpperCase()
    )
    .filter(Boolean)
    .sort();
}

function sameStringArray(
  a,
  b
) {
  return (
    JSON.stringify(
      normalizeStatusArray(a)
    ) ===
    JSON.stringify(
      normalizeStatusArray(b)
    )
  );
}

function marketMoveSignificance(
  percentageChange
) {
  const absolute =
    Math.abs(
      safeNumber(
        percentageChange
      ) || 0
    );

  if (absolute >= 8) {
    return 'critical';
  }

  if (absolute >= 4) {
    return 'high';
  }

  if (absolute >= 1.5) {
    return 'medium';
  }

  return 'low';
}

function scannerStateHash(
  marketState,
  previous
) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        marketState,
        technicalState:
          previous?.technical_state ||
          {},
        fundamentalState:
          previous?.fundamental_state ||
          {},
        currentView:
          previous?.current_view ||
          null
      })
    )
    .digest('hex');
}

function buildScannerSecurityState(
  marketRow,
  previous,
  runId,
  evaluatedAt
) {
  const symbol =
    normalizeSymbol(
      marketRow.symbol
    );

  const currentPrice =
    safeNumber(
      marketRow.price
    );

  const previousPrice =
    safeNumber(
      previous?.market_price
    );

  const scanChangePct =
    previousPrice !== null &&
    previousPrice !== 0 &&
    currentPrice !== null
      ? (
          (
            currentPrice -
            previousPrice
          ) /
          Math.abs(
            previousPrice
          )
        ) * 100
      : null;

  const marketState = {
    asOf:
      marketRow.asOf ||
      null,
    price:
      roundMemoryNumber(
        currentPrice,
        4
      ),
    peRatio:
      roundMemoryNumber(
        marketRow.peRatio,
        4
      ),
    dividendYield:
      roundMemoryNumber(
        marketRow.dividendYield,
        4
      ),
    averageVolume30d:
      roundMemoryNumber(
        marketRow.averageVolume30d,
        2
      ),
    change1yPct:
      roundMemoryNumber(
        marketRow.change1yPct,
        2
      ),
    dayChangePct:
      roundMemoryNumber(
        marketRow.dayChangePct,
        2
      ),
    previousClose:
      roundMemoryNumber(
        marketRow.previousClose,
        4
      ),
    sessionOpen:
      roundMemoryNumber(
        marketRow.sessionOpen,
        4
      ),
    sessionHigh:
      roundMemoryNumber(
        marketRow.sessionHigh,
        4
      ),
    sessionLow:
      roundMemoryNumber(
        marketRow.sessionLow,
        4
      ),
    sessionVolume:
      roundMemoryNumber(
        marketRow.sessionVolume,
        2
      ),
    statusCodes:
      normalizeStatusArray(
        marketRow.statusCodes
      ),
    scanChangePct:
      roundMemoryNumber(
        scanChangePct,
        4
      )
  };

  const state = {
    symbol,
    company_name:
      marketRow.companyName ||
      previous?.company_name ||
      symbol,
    sector:
      marketRow.sector ||
      previous?.sector ||
      null,
    universe_class:
      marketRow.universeClass ||
      previous?.universe_class ||
      null,
    eligibility:
      marketRow.recommendationEligible === true
        ? 'RECOMMENDATION_ELIGIBLE'
        : 'NOT_RECOMMENDATION_ELIGIBLE',
    market_price:
      roundMemoryNumber(
        currentPrice,
        4
      ),
    market_change_pct:
      roundMemoryNumber(
        marketRow.dayChangePct,
        4
      ),
    volume:
      roundMemoryNumber(
        marketRow.sessionVolume,
        2
      ) ??
      previous?.volume ??
      null,
    volume_ratio_20d:
      safeNumber(
        marketRow.sessionVolume
      ) !== null &&
      safeNumber(
        marketRow.averageVolume30d
      ) !== null &&
      safeNumber(
        marketRow.averageVolume30d
      ) > 0
        ? roundMemoryNumber(
            safeNumber(
              marketRow.sessionVolume
            ) /
            safeNumber(
              marketRow.averageVolume30d
            ),
            2
          )
        : previous?.volume_ratio_20d ??
          null,
    technical_score:
      previous?.technical_score ??
      null,
    fundamental_score:
      previous?.fundamental_score ??
      null,
    risk_score:
      previous?.risk_score ??
      null,
    overall_score:
      previous?.overall_score ??
      null,
    technical_state:
      previous?.technical_state ||
      {},
    fundamental_state:
      previous?.fundamental_state ||
      {},
    risk_state:
      previous?.risk_state ||
      {},
    market_state:
      marketState,
    current_view:
      previous?.current_view ||
      'Market baseline established',
    current_view_reason:
      previous?.current_view_reason ||
      'NOMAD has a persistent market baseline. Deeper technical and fundamental views are updated by their respective intelligence engines.',
    data_quality_score:
      previous?.data_quality_score ??
      70,
    source_timestamp:
      marketRow.asOf ||
      null,
    last_run_id:
      runId,
    state_hash:
      scannerStateHash(
        marketState,
        previous
      ),
    evaluated_at:
      evaluatedAt,
    created_at:
      previous?.created_at ||
      evaluatedAt
  };

  return {
    state,
    scanChangePct
  };
}

function detectScannerChanges(
  marketRow,
  previous,
  currentState,
  scanChangePct
) {
  if (!previous) {
    return [];
  }

  const changes = [];
  const absoluteMove =
    Math.abs(
      safeNumber(
        scanChangePct
      ) || 0
    );

  if (
    scanChangePct !== null &&
    absoluteMove >= 1.5
  ) {
    const oldPrice =
      safeNumber(
        previous.market_price
      );

    const newPrice =
      safeNumber(
        currentState.market_price
      );

    changes.push({
      symbol:
        currentState.symbol,
      change_category:
        'market',
      field_name:
        'market_price',
      old_value: {
        value: oldPrice
      },
      new_value: {
        value: newPrice
      },
      absolute_change:
        roundMemoryNumber(
          newPrice !== null &&
          oldPrice !== null
            ? newPrice - oldPrice
            : null,
          4
        ),
      percentage_change:
        roundMemoryNumber(
          scanChangePct,
          4
        ),
      significance:
        marketMoveSignificance(
          scanChangePct
        ),
      summary:
        currentState.symbol +
        ' moved ' +
        (
          scanChangePct > 0
            ? '+'
            : ''
        ) +
        roundMemoryNumber(
          scanChangePct,
          2
        ) +
        '% since NOMAD\'s previous market snapshot.',
      evidence: {
        source:
          'psxdata-api',
        previousPrice:
          oldPrice,
        currentPrice:
          newPrice,
        sourceTimestamp:
          marketRow.asOf ||
          null
      }
    });
  }

  const previousStatuses =
    previous.market_state
      ?.statusCodes ||
    [];

  const currentStatuses =
    marketRow.statusCodes ||
    [];

  if (
    !sameStringArray(
      previousStatuses,
      currentStatuses
    )
  ) {
    changes.push({
      symbol:
        currentState.symbol,
      change_category:
        'security_status',
      field_name:
        'status_codes',
      old_value: {
        value:
          normalizeStatusArray(
            previousStatuses
          )
      },
      new_value: {
        value:
          normalizeStatusArray(
            currentStatuses
          )
      },
      absolute_change:
        null,
      percentage_change:
        null,
      significance:
        'high',
      summary:
        currentState.symbol +
        ' market-status code changed from [' +
        normalizeStatusArray(
          previousStatuses
        ).join(', ') +
        '] to [' +
        normalizeStatusArray(
          currentStatuses
        ).join(', ') +
        '].',
      evidence: {
        source:
          'PSX market feed'
      }
    });
  }

  return changes;
}

async function readAllSecurityMemory() {
  const rows =
    await supabaseRest(
      'security_state?select=*'
    );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function upsertSecurityStatesBulk(
  states
) {
  const saved = [];
  const chunkSize = 100;

  for (
    let index = 0;
    index < states.length;
    index += chunkSize
  ) {
    const chunk =
      states.slice(
        index,
        index + chunkSize
      );

    const rows =
      await supabaseRest(
        'security_state?on_conflict=symbol&select=symbol,evaluated_at,market_price',
        {
          method: 'POST',
          prefer:
            'resolution=merge-duplicates,return=representation',
          body:
            chunk
        }
      );

    if (Array.isArray(rows)) {
      saved.push(
        ...rows
      );
    }
  }

  return saved;
}

async function saveScannerChangesBulk(
  runId,
  changes
) {
  if (!changes.length) {
    return [];
  }

  const saved = [];
  const chunkSize = 100;

  for (
    let index = 0;
    index < changes.length;
    index += chunkSize
  ) {
    const chunk =
      changes
        .slice(
          index,
          index + chunkSize
        )
        .map(
          change => ({
            run_id:
              runId,
            ...change
          })
        );

    const rows =
      await supabaseRest(
        'state_changes?select=id,symbol,field_name,percentage_change,significance,summary,detected_at',
        {
          method: 'POST',
          prefer:
            'return=representation',
          body:
            chunk
        }
      );

    if (Array.isArray(rows)) {
      saved.push(
        ...rows
      );
    }
  }

  return saved;
}

async function runMarketSnapshotScan(
  runType = 'manual'
) {
  if (!continuousMemoryConfigured()) {
    bad(
      'Continuous intelligence database is not configured.',
      503
    );
  }

  const run =
    await createIntelligenceRun(
      {
        scanner:
          'CORE_EQUITY_MARKET_SNAPSHOT',
        build:
          VERSION,
        purpose:
          'Detect meaningful market-state changes without waiting for the user to open a stock.'
      },
      runType
    );

  try {
    const [
      market,
      previousRows
    ] =
      await Promise.all([
        loadPSXMarket(),
        readAllSecurityMemory()
      ]);

    const previousMap =
      new Map(
        previousRows.map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
      );

    const coreRows =
      market.stocks.filter(
        row =>
          row.recommendationEligible ===
          true
      );

    const evaluatedAt =
      new Date().toISOString();

    const states = [];
    const changes = [];
    let firstBaselines = 0;

    for (
      const marketRow
      of coreRows
    ) {
      const symbol =
        normalizeSymbol(
          marketRow.symbol
        );

      const previous =
        previousMap.get(
          symbol
        ) ||
        null;

      if (!previous) {
        firstBaselines += 1;
      }

      const built =
        buildScannerSecurityState(
          marketRow,
          previous,
          run.id,
          evaluatedAt
        );

      states.push(
        built.state
      );

      changes.push(
        ...detectScannerChanges(
          marketRow,
          previous,
          built.state,
          built.scanChangePct
        )
      );
    }

    const holdingsResult =
      await readPortfolioHoldings()
        .catch(
          () => ({
            configured: false,
            rows: []
          })
        );

    const prioritySymbols =
      uniqueStrings(
        (
          holdingsResult.rows ||
          []
        ).map(
          row =>
            normalizeSymbol(
              row.symbol
            )
        )
      );

    const contextBatchSize =
      8;

    const rotationStart =
      coreRows.length
        ? (
            Math.floor(
              Date.now() /
              (15 * 60 * 1000)
            ) *
            contextBatchSize
          ) %
          coreRows.length
        : 0;

    const rotationSymbols = [];

    for (
      let offset = 0;
      offset < contextBatchSize &&
      offset < coreRows.length;
      offset++
    ) {
      rotationSymbols.push(
        coreRows[
          (
            rotationStart +
            offset
          ) %
          coreRows.length
        ]?.symbol
      );
    }

    const contextSymbols =
      uniqueStrings([
        ...prioritySymbols,
        ...rotationSymbols
      ])
        .slice(
          0,
          16
        );

    const marketRowMap =
      new Map(
        coreRows.map(
          row => [
            normalizeSymbol(
              row.symbol
            ),
            row
          ]
        )
      );

    const stateMap =
      new Map(
        states.map(
          state => [
            normalizeSymbol(
              state.symbol
            ),
            state
          ]
        )
      );

    let historicalContextsUpdated =
      0;

    const contextResults =
      await mapWithConcurrency(
        contextSymbols,
        2,
        async symbol => {
          const row =
            marketRowMap.get(
              normalizeSymbol(
                symbol
              )
            );

          if (!row) {
            return null;
          }

          try {
            const context =
              await getHistoricalSituation(
                symbol,
                row.price
              );

            return {
              symbol:
                normalizeSymbol(
                  symbol
                ),
              context
            };
          } catch {
            return null;
          }
        }
      );

    for (
      const item
      of contextResults
    ) {
      if (
        !item?.context?.available
      ) {
        continue;
      }

      const state =
        stateMap.get(
          item.symbol
        );

      if (!state) {
        continue;
      }

      state.market_state = {
        ...(
          state.market_state ||
          {}
        ),
        historicalContext:
          item.context
      };

      state.state_hash =
        scannerStateHash(
          state.market_state,
          previousMap.get(
            item.symbol
          ) ||
          null
        );

      historicalContextsUpdated +=
        1;
    }

    await upsertSecurityStatesBulk(
      states
    );

    const savedChanges =
      await saveScannerChangesBulk(
        run.id,
        changes
      );

    await finishIntelligenceRun(
      run.id,
      {
        status:
          'completed',
        securities_processed:
          states.length,
        changes_detected:
          changes.length,
        signals_generated:
          0,
        alerts_generated:
          0,
        predictions_generated:
          0,
        metadata: {
          scanner:
            'CORE_EQUITY_MARKET_SNAPSHOT',
          build:
            VERSION,
          marketAsOf:
            market.asOf,
          firstBaselines,
          historicalContextsUpdated,
          contextSymbols
        }
      }
    );

    const attention =
      [...savedChanges]
        .sort(
          (
            a,
            b
          ) =>
            Math.abs(
              safeNumber(
                b.percentage_change
              ) || 0
            ) -
            Math.abs(
              safeNumber(
                a.percentage_change
              ) || 0
            )
        )
        .slice(0, 10);

    return {
      status:
        'OK',
      runId:
        run.id,
      runType,
      marketAsOf:
        market.asOf,
      coreUniverse:
        coreRows.length,
      securitiesProcessed:
        states.length,
      firstBaselines,
      historicalContextsUpdated,
      contextSymbols,
      changesDetected:
        changes.length,
      meaningfulChanges:
        savedChanges.filter(
          item =>
            item.significance !==
            'low'
        ).length,
      attention
    };
  } catch (error) {
    await finishIntelligenceRun(
      run.id,
      {
        status:
          'failed',
        error_message:
          String(
            error.message ||
            'Scanner failed.'
          ).slice(
            0,
            1000
          )
      }
    ).catch(
      () => {}
    );

    throw error;
  }
}

function buildMarketPulseFromRows(
  rows
) {
  const liveRows =
    (
      Array.isArray(
        rows
      )
        ? rows
        : []
    )
      .filter(
        row =>
          row &&
          row.marketFactEligible !==
            false &&
          safeNumber(
            row.changePct
          ) !== null
      );

  const moverShape =
    row => ({
      symbol:
        row.symbol,
      canonicalSymbol:
        row.canonicalSymbol ||
        row.symbol,
      companyName:
        row.companyName,
      price:
        row.price,
      changePct:
        roundMemoryNumber(
          row.changePct,
          2
        ),
      volume:
        row.volume,
      sector:
        row.sector,
      recommendationEligible:
        row.recommendationEligible ===
        true
    });

  const gainers =
    [...liveRows]
      .filter(
        row =>
          safeNumber(
            row.changePct
          ) > 0
      )
      .sort(
        (
          a,
          b
        ) =>
          safeNumber(
            b.changePct
          ) -
          safeNumber(
            a.changePct
          )
      )
      .slice(0, 5)
      .map(
        moverShape
      );

  const losers =
    [...liveRows]
      .filter(
        row =>
          safeNumber(
            row.changePct
          ) < 0
      )
      .sort(
        (
          a,
          b
        ) =>
          safeNumber(
            a.changePct
          ) -
          safeNumber(
            b.changePct
          )
      )
      .slice(0, 5)
      .map(
        moverShape
      );

  const breadth =
    liveRows.length
      ? {
          advancers:
            liveRows.filter(
              row =>
                safeNumber(
                  row.changePct
                ) > 0
            ).length,
          decliners:
            liveRows.filter(
              row =>
                safeNumber(
                  row.changePct
                ) < 0
            ).length,
          unchanged:
            liveRows.filter(
              row =>
                safeNumber(
                  row.changePct
                ) === 0
            ).length
        }
      : null;

  return {
    gainers,
    losers,
    breadth,
    rowCount:
      liveRows.length
  };
}

async function getIntelligenceFeed() {
  if (!continuousMemoryConfigured()) {
    return {
      configured: false,
      latestRun: null,
      stateCoverage: 0,
      historicalContextCoverage: 0,
      coreUniverse:
        PSX_UNIVERSE_MASTER.summary
          .coreEquity,
      attention: [],
      marketPulse: null,
      portfolioConfigured: false
    };
  }

  const [
    runs,
    states,
    changes,
    holdingsResult,
    market,
    marketStatus
  ] =
    await Promise.all([
      supabaseRest(
        'intelligence_runs?select=id,run_type,status,started_at,completed_at,securities_processed,changes_detected,error_message,metadata&order=started_at.desc&limit=5'
      ),
      supabaseRest(
        'security_state?select=symbol,market_price,market_change_pct,current_view,evaluated_at,market_state&eligibility=eq.RECOMMENDATION_ELIGIBLE'
      ),
      supabaseRest(
        'state_changes?select=id,symbol,change_category,field_name,old_value,new_value,percentage_change,significance,summary,detected_at&order=detected_at.desc&limit=80'
      ),
      readPortfolioHoldings()
        .catch(
          () => ({
            configured: false,
            rows: []
          })
        ),
      loadPSXMarket()
        .catch(
          () => null
        ),
      getPyPSXMarketStatus()
        .catch(
          () => null
        )
    ]);

  const stateRows =
    Array.isArray(states)
      ? states
      : [];

  const historicalContextCoverage =
    stateRows.filter(
      row =>
        row?.market_state
          ?.historicalContext
          ?.available ===
        true
    ).length;

  const recentChanges =
    (
      Array.isArray(changes)
        ? changes
        : []
    )
      .filter(
        item =>
          [
            'medium',
            'high',
            'critical'
          ].includes(
            item.significance
          )
      )
      .slice(0, 20);

  const stateMap =
    new Map(
      stateRows.map(
        row => [
          normalizeSymbol(
            row.symbol
          ),
          row
        ]
      )
    );

  const conditionAttention = [];

  for (
    const holding
    of holdingsResult.rows || []
  ) {
    const symbol =
      normalizeSymbol(
        holding.symbol
      );

    const state =
      stateMap.get(
        symbol
      );

    const context =
      state?.market_state
        ?.historicalContext;

    if (!context?.available) {
      continue;
    }

    const month =
      safeNumber(
        context.returns?.m1
      );

    if (
      month !== null &&
      month <= -5
    ) {
      conditionAttention.push({
        id:
          'condition-' +
          symbol,
        symbol,
        change_category:
          'existing_condition',
        field_name:
          'historical_context',
        percentage_change:
          month,
        significance:
          month <= -10
            ? 'high'
            : 'medium',
        summary:
          symbol +
          ' is down ' +
          Math.abs(
            roundMemoryNumber(
              month,
              2
            )
          ) +
          '% over roughly 1 month' +
          (
            context.trend
              ? ' and is in a ' +
                String(
                  context.trend
                ).toLowerCase()
              : ''
          ) +
          '.',
        detected_at:
          state.evaluated_at ||
          new Date()
            .toISOString(),
        condition:
          context.condition,
        kind:
          'existing_condition'
      });
    }
  }

  const attention = [];
  const attentionKeys =
    new Set();

  for (
    const item
    of [
      ...conditionAttention,
      ...recentChanges
    ]
  ) {
    const key =
      String(
        item.symbol ||
        ''
      ) +
      '|' +
      String(
        item.field_name ||
        item.kind ||
        ''
      );

    if (
      attentionKeys.has(
        key
      )
    ) {
      continue;
    }

    attentionKeys.add(
      key
    );

    attention.push(
      item
    );

    if (
      attention.length >=
      12
    ) {
      break;
    }
  }

  let marketPulse =
    null;

  if (
    market &&
    market.officialMarketAvailable ===
      true &&
    Array.isArray(
      market.liveMarketRows
    ) &&
    market.liveMarketRows.length
  ) {
    // Market breadth and Top Movers are canonical Official PSX facts.
    // The default scope is verified Main Board ordinary equities. Rights,
    // legacy symbols and other special instruments never enter this pulse.
    const liveRows =
      market.liveMarketRows;

    const pulseData =
      buildMarketPulseFromRows(
        liveRows
      );

    marketPulse = {
      asOf:
        market.marketWatchAsOf ||
        market.asOf,
      gainers:
        pulseData.gainers,
      losers:
        pulseData.losers,
      breadth:
        pulseData.breadth,
      sessionChangeRows:
        pulseData.rowCount,
      sessionChangeSource:
        market.sessionChangeSource ||
        null,
      marketUniverse:
        market.liveMarketUniverse ||
        'PRIMARY_LIVE_ROWS',
      marketDataIntegrity:
        market.marketDataIntegrity ||
        null,
      marketStatus:
        marketStatus ||
        null
    };
  }

  return {
    configured: true,
    scannerSecretConfigured:
      scannerSecretConfigured(),
    latestRun:
      Array.isArray(runs) &&
      runs.length
        ? runs[0]
        : null,
    recentRuns:
      Array.isArray(runs)
        ? runs
        : [],
    stateCoverage:
      stateRows.length,
    historicalContextCoverage,
    coreUniverse:
      PSX_UNIVERSE_MASTER.summary
        .coreEquity,
    attention,
    marketPulse,
    portfolioConfigured:
      holdingsResult.configured,
    portfolioHoldingCount:
      holdingsResult.rows?.length ||
      0
  };
}

/* =========================================================
   AUTH
========================================================= */

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
      Buffer.from(
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

/* =========================================================
   RESPONSE
========================================================= */

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

/* =========================================================
   HANDLER
========================================================= */

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
    const url =
      new URL(
        request.url,
        'http://localhost'
      );

    const action =
      url.searchParams.get(
        'action'
      ) ||
      'app';

    const scannerAuthorized =
      action ===
        'intelligence-scan' &&
      scannerRequestAuthorized(
        request
      );

    if (
      !scannerAuthorized &&
      !authorize(
        request,
        response
      )
    ) {
      return;
    }

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

          universeMasterVersion:
            PSX_UNIVERSE_MASTER.masterVersion,

          universeMasterSummary:
            PSX_UNIVERSE_MASTER.summary,

          marketProvider:
            'psxdata-api',

          companyMetadata:
            'NOMAD canonical universe master + runtime research sources',

          symbolNormalization:
            'VALIDATED_CANONICAL_STATUS_SEPARATION',

          metadataAudit:
            'CANONICAL_UNIVERSE_MASTER_LOCKED',

          fundamentalsProvider:
            'PSX Data Portal company page',

          technicalEngine:
            'IMPLEMENTED_DETERMINISTIC',

          continuousIntelligenceMemory:
            continuousMemoryConfigured()
              ? 'CONFIGURED'
              : 'NOT_CONFIGURED',

          intelligenceScanner:
            'MARKET_SNAPSHOT_PLUS_ROTATING_HISTORICAL_CONTEXT',

          scannerSecretConfigured:
            scannerSecretConfigured(),

          supabaseConfigured:
            continuousMemoryConfigured(),

          pyPSXConfigured:
            Boolean(
              PYPSX_API_KEY_ID &&
              PYPSX_API_SECRET_KEY
            ),

          decisionEngine:
            'SHADOW_DECISION_LAB_V0.1',

          decisionModels: {
            longTerm:
              DECISION_MODELS.long_term.id,
            shortTerm:
              DECISION_MODELS.short_term.id,
            realMoneyEligible:
              false
          },

          predictionEngine:
            'SHADOW_UNVALIDATED',

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
        'intelligence-feed'
    ) {
      return sendJSON(
        response,
        await getIntelligenceFeed()
      );
    }

    if (
      (
        request.method ===
          'GET' ||
        request.method ===
          'POST'
      ) &&
      action ===
        'intelligence-scan'
    ) {
      return sendJSON(
        response,
        await runMarketSnapshotScan(
          scannerAuthorized
            ? 'scheduled'
            : 'manual'
        )
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'intelligence-memory-test'
    ) {
      return sendJSON(
        response,
        await runContinuousMemoryTest(
          url.searchParams.get(
            'symbol'
          ) ||
          'HBL'
        )
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'situation'
    ) {
      return sendJSON(
        response,
        await getHistoricalSituation(
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
        'portfolio'
    ) {
      return sendJSON(
        response,
        await getPortfolioSnapshot()
      );
    }

    if (
      request.method ===
        'POST' &&
      action ===
        'portfolio-holding'
    ) {
      const body =
        await readJsonRequestBody(
          request
        );

      const saved =
        await savePortfolioHolding(
          body
        );

      try {
        const market =
          await loadPSXMarket();

        const marketRow =
          market.stocks.find(
            row =>
              normalizeSymbol(
                row.symbol
              ) ===
              normalizeSymbol(
                saved?.symbol ||
                body.symbol
              )
          ) ||
          null;

        await refreshHistoricalSituation(
          saved?.symbol ||
          body.symbol,
          marketRow
        );
      } catch {}

      return sendJSON(
        response,
        {
          status: 'OK',
          holding: saved
        }
      );
    }

    if (
      request.method ===
        'POST' &&
      action ===
        'portfolio-transaction'
    ) {
      const body =
        await readJsonRequestBody(
          request
        );

      const saved =
        await savePortfolioTransaction(
          body
        );

      try {
        const market =
          await loadPSXMarket();

        const marketRow =
          market.stocks.find(
            row =>
              normalizeSymbol(
                row.symbol
              ) ===
              normalizeSymbol(
                body.symbol
              )
          ) ||
          null;

        await refreshHistoricalSituation(
          body.symbol,
          marketRow
        );
      } catch {}

      return sendJSON(
        response,
        {
          status: 'OK',
          ...saved
        }
      );
    }

    if (
      (
        request.method ===
          'POST' ||
        request.method ===
          'DELETE'
      ) &&
      action ===
        'portfolio-transaction-delete'
    ) {
      const body =
        request.method ===
          'POST'
          ? await readJsonRequestBody(
              request
            )
          : {};

      return sendJSON(
        response,
        await deletePortfolioTransaction(
          body.id ||
          url.searchParams.get(
            'id'
          )
        )
      );
    }

    if (
      (
        request.method ===
          'POST' ||
        request.method ===
          'DELETE'
      ) &&
      action ===
        'portfolio-delete'
    ) {
      const body =
        request.method ===
          'POST'
          ? await readJsonRequestBody(
              request
            )
          : {};

      return sendJSON(
        response,
        await deletePortfolioHolding(
          body.symbol ||
          url.searchParams.get(
            'symbol'
          )
        )
      );
    }

    if (
      request.method ===
        'POST' &&
      action ===
        'stock-strategy'
    ) {
      const body =
        await readJsonRequestBody(
          request
        );

      return sendJSON(
        response,
        await runSingleStockStrategy(
          body
        )
      );
    }

    if (
      request.method ===
        'POST' &&
      action ===
        'decision-lab'
    ) {
      const body =
        await readJsonRequestBody(
          request
        );

      return sendJSON(
        response,
        await runDecisionLab(
          body
        )
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'universe-master'
    ) {
      return sendJSON(
        response,
        {
          version: VERSION,
          masterVersion: PSX_UNIVERSE_MASTER.masterVersion,
          generatedAt: PSX_UNIVERSE_MASTER.generatedAt,
          summary: PSX_UNIVERSE_MASTER.summary,
          policy: PSX_UNIVERSE_MASTER.policy,
          entries: PSX_UNIVERSE_MASTER.entries
        }
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'metadata-audit'
    ) {
      return sendJSON(
        response,
        await getMetadataAudit()
      );
    }


    if (
      request.method ===
        'GET' &&
      action ===
        'security-status-batch'
    ) {
      return sendJSON(
        response,
        await getSecurityStatusBatch(
          url.searchParams.get(
            'symbols'
          ) ||
          ''
        )
      );
    }

    if (
      request.method ===
        'GET' &&
      action ===
        'resolve-symbol'
    ) {
      return sendJSON(
        response,
        await resolveSymbolContext(
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
        'live-price'
    ) {
      const context =
        await resolveSymbolContext(
          url.searchParams.get(
            'symbol'
          )
        );

      const result =
        await getLiveForContext(
          context
        );

      return sendJSON(
        response,
        {
          symbol:
            context.canonicalSymbol,

          identity: {
            canonicalSymbol:
              context.canonicalSymbol,

            tradingSymbol:
              context.tradingSymbol,

            rawMarketSymbol:
              context.rawMarketSymbol,

            statusCodes:
              context.statusCodes,

            normalized:
              context.normalized
          },

          provider:
            result.provider,

          providerSymbol:
            result.providerSymbol,

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
      const context =
        await resolveSymbolContext(
          url.searchParams.get(
            'symbol'
          )
        );

      const result =
        await getLiveForContext(
          context
        );

      return sendJSON(
        response,
        {
          ...result,

          symbol:
            context.canonicalSymbol,

          identity: {
            canonicalSymbol:
              context.canonicalSymbol,

            tradingSymbol:
              context.tradingSymbol,

            rawMarketSymbol:
              context.rawMarketSymbol,

            statusCodes:
              context.statusCodes,

            normalized:
              context.normalized
          }
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
        'events'
    ) {
      return sendJSON(
        response,
        await getEvents(
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
        'technical'
    ) {
      return sendJSON(
        response,
        await getTechnicalAnalysis(
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

/* =========================================================
   WEB PAGE
========================================================= */

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

.auditFilters {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(210px,1fr)
    );
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

.symbolSub {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: #718394;
  font-weight: 400;
}

.company {
  min-width: 230px;
}

#stocks .exploreTable {
  font-size: 13px;
}

#stocks .exploreTable th,
#stocks .exploreTable td {
  padding: 9px 10px;
}

#stocks .exploreTable th {
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: #6d8294;
}

#stocks .exploreTable .company {
  min-width: 190px;
  max-width: 250px;
}

#stocks .exploreTable td:not(.company) {
  white-space: nowrap;
}

.volumeCell {
  min-width: 92px;
}

.metricPrimary {
  display: block;
  font-weight: 650;
}

.metricSecondary {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: #718394;
  font-weight: 400;
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

.livePriceUp {
  background: rgba(17,130,59,.08);
}

.livePriceDown {
  background: rgba(181,42,42,.08);
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

.identityLine {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 3px;
}

.statusPill {
  position: relative;
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  background: #fff0d6;
  color: #865b12;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid #f0d39e;
  cursor: help;
  outline: none;
}

.statusPill:hover::after,
.statusPill:focus::after {
  content: attr(data-help);
  position: absolute;
  z-index: 40;
  left: 50%;
  bottom: calc(100% + 7px);
  transform: translateX(-50%);
  width: max-content;
  max-width: 260px;
  padding: 8px 10px;
  border-radius: 7px;
  background: #18384e;
  color: white;
  font-size: 11px;
  line-height: 1.4;
  font-weight: 500;
  white-space: normal;
  box-shadow: 0 4px 16px rgba(0,0,0,.14);
}

.auditEvidence {
  min-width: 180px;
  line-height: 1.45;
  color: #53697b;
}

.auditEvidence strong {
  display: block;
  color: #31495d;
  margin-bottom: 3px;
}

.auditPill {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  background: #eef3f6;
  color: #44596b;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

.auditPill.warning {
  background: #fff0d6;
  color: #865b12;
}

.auditPill.danger {
  background: #fdecec;
  color: #a72a2a;
}

.auditPill.info {
  background: #eaf3f8;
  color: #28536c;
}

.auditReason {
  min-width: 320px;
  line-height: 1.45;
  color: #53697b;
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
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: #66788a;
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
.rangeToggle,
.eventToggle {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid #d9e2e9;
  border-radius: 9px;
  background: #f7f9fb;
  flex-wrap: wrap;
}

.chartModeButton,
.rangeButton,
.eventModeButton {
  background: transparent;
  color: #44596b;
  padding: 7px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.chartModeButton.active,
.rangeButton.active,
.eventModeButton.active {
  background: #173f58;
  color: white;
}

.chartLegend {
  display: flex;
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

.legendSwatch.price {
  background: #173f58;
}

.legendSwatch.sma20 {
  background: #9b59b6;
}

.legendSwatch.sma50 {
  background: #e67e22;
}

.legendSwatch.sma200 {
  background: #2c8c6b;
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

.priceChart,
.technicalChart {
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

.technicalPrice {
  fill: none;
  stroke: #173f58;
  stroke-width: 2.3;
}

.technicalSMA20 {
  fill: none;
  stroke: #9b59b6;
  stroke-width: 1.6;
}

.technicalSMA50 {
  fill: none;
  stroke: #e67e22;
  stroke-width: 1.6;
}

.technicalSMA200 {
  fill: none;
  stroke: #2c8c6b;
  stroke-width: 1.6;
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

.infoBox {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 8px;
  background: #eef4f7;
  color: #44596b;
  font-size: 13px;
}

.learnBox {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: 9px;
  background: #f5f8fb;
  border: 1px solid #dce6ed;
  color: #42596c;
  line-height: 1.55;
  font-size: 13px;
}

.learnBox strong {
  color: #18384e;
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
  padding: 3px 8px;
  border-radius: 999px;
  background: #eef3f6;
  color: #44596b;
  font-size: 11px;
}

.posture {
  font-size: 22px;
  font-weight: 760;
}

.techExplanation {
  color: #5f7181;
  line-height: 1.55;
  font-size: 13px;
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

  .filters,
  .auditFilters {
    grid-template-columns: 1fr;
  }

  .pagination {
    flex-direction: column;
    align-items: flex-start;
  }

  .priceChart,
  .technicalChart {
    height: 260px;
  }

  .candleChart {
    height: 340px;
  }

  .decisionPrice {
    font-size: 30px;
  }

}



/* =========================================================
   APP SHELL + DECISION CENTER - BUILD 0.8.1
========================================================= */

:root {
  --nomad-navy: #0b1728;
  --nomad-navy-2: #132238;
  --nomad-accent: #1f6f8b;
  --nomad-bg: #f3f6fa;
  --nomad-card: #ffffff;
  --nomad-border: #dfe6ee;
  --nomad-text: #172a3c;
  --nomad-muted: #6b7c8f;
}

body {
  background: var(--nomad-bg);
}

.appShell {
  min-height: 100vh;
  display: flex;
}

.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: 238px;
  box-sizing: border-box;
  padding: 22px 14px 16px;
  background: var(--nomad-navy);
  color: #fff;
  display: flex;
  flex-direction: column;
  z-index: 30;
  border-right: 1px solid rgba(255,255,255,.06);
}

.brandBlock {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 2px 8px 24px;
}

.brandMark {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-weight: 800;
  background: #fff;
  color: var(--nomad-navy);
}

.brandName {
  font-size: 16px;
  font-weight: 750;
}

.brandSub,
.sidebarFoot {
  color: #8fa2b8;
  font-size: 11px;
}

.sideNav {
  display: grid;
  gap: 5px;
}

.navButton {
  width: 100%;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 11px;
  border: 0;
  padding: 11px 12px;
  border-radius: 8px;
  background: transparent;
  color: #c9d4e1;
  font-size: 14px;
  cursor: pointer;
}

.navButton:hover,
.navButton.active {
  background: #223149;
  color: #fff;
}

.navButton span {
  width: 18px;
  opacity: .85;
}

.sideSpacer {
  flex: 1;
}

.sideNavBottom {
  margin-top: 18px;
}

.sidebarFoot {
  padding: 14px 12px 0;
}

.appMain {
  width: calc(100% - 238px);
  max-width: none;
  margin: 0 0 0 238px;
  padding: 0 32px 48px;
  box-sizing: border-box;
}

.topBar {
  position: sticky;
  top: 0;
  z-index: 20;
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: rgba(243,246,250,.94);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(211,220,230,.75);
}

.topSearchWrap {
  flex: 1;
}

.topSearch {
  margin: 0;
  background: #fff;
  border-radius: 9px;
  padding: 12px 15px;
  border: 1px solid #d8e1ea;
}

.askNomadButton {
  white-space: nowrap;
  background: var(--nomad-navy);
}

.legacyHeader,
body > main > header {
  display: none;
}

.appPage {
  display: none;
  max-width: 1320px;
  margin: 0 auto;
}

.appPage.active {
  display: block;
}

#error {
  max-width: 1320px;
  margin-left: auto;
  margin-right: auto;
}

.notice,
#status {
  display: none;
}

.decisionHero {
  margin: 28px 0 18px;
  padding: 28px 30px;
  border-radius: 14px;
  background: linear-gradient(135deg, #0b1728, #172b44);
  color: #fff;
  display: flex;
  justify-content: space-between;
  gap: 28px;
  align-items: center;
}

.decisionHero h1 {
  margin: 4px 0 7px;
  font-size: 32px;
}

.decisionHero p {
  max-width: 720px;
  margin: 0;
  color: #c2cede;
  line-height: 1.55;
}

.eyebrow {
  font-size: 11px;
  letter-spacing: .12em;
  font-weight: 800;
  color: #6f8499;
}

.decisionHero .eyebrow {
  color: #80a7bd;
}

.heroStatus {
  min-width: 210px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 15px;
  border: 1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.06);
  border-radius: 10px;
}

.statusDot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #4fd39a;
  box-shadow: 0 0 0 5px rgba(79,211,154,.1);
}

.heroStatus .metricLabel {
  color: #98abc0;
}

.heroStatusValue {
  font-weight: 750;
  margin-top: 2px;
}

.decisionGrid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(300px, .9fr);
  gap: 16px;
}

.decisionCard {
  background: #fff;
  border: 1px solid var(--nomad-border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(16,31,50,.03);
}

.attentionCard {
  grid-row: span 2;
  min-height: 390px;
}

.cardTopline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.cardTopline h2,
.decisionCard h2 {
  margin: 4px 0 12px;
  font-size: 21px;
}

.ghostButton {
  background: #f3f6f9;
  color: #274158;
  border: 1px solid #dce5ed;
}

.fullButton {
  width: 100%;
  margin-top: 16px;
}

.attentionFeed {
  display: grid;
  gap: 0;
  border-top: 1px solid #edf1f5;
}

.attentionItem {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 15px 0;
  border-bottom: 1px solid #edf1f5;
}

.attentionSymbol {
  font-weight: 800;
  font-size: 15px;
}

.attentionSummary {
  font-size: 14px;
  line-height: 1.4;
}

.attentionTime {
  margin-top: 3px;
  color: var(--nomad-muted);
  font-size: 11px;
}

.severityPill {
  font-size: 10px;
  text-transform: uppercase;
  font-weight: 800;
  letter-spacing: .05em;
  border-radius: 999px;
  padding: 5px 8px;
  background: #eef3f7;
  color: #617487;
}

.severityPill.high,
.severityPill.critical {
  background: #fff0ee;
  color: #b73c32;
}

.severityPill.medium {
  background: #fff7e5;
  color: #946b12;
}

.emptyState {
  padding: 44px 8px;
  color: var(--nomad-muted);
  text-align: center;
}

.contextCard label {
  font-size: 12px;
  color: #5d7084;
}

.moneyInputWrap {
  display: flex;
  align-items: center;
  border: 1px solid #d7e0e9;
  border-radius: 9px;
  overflow: hidden;
  margin: 7px 0 14px;
}

.moneyInputWrap span {
  padding: 0 0 0 12px;
  color: #64778a;
  font-weight: 700;
}

.moneyInputWrap input {
  border: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 760;
}

.contextRow {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.contextRow select {
  margin-top: 6px;
}

.primaryWide {
  width: 100%;
  margin-top: 12px;
}

.smallStatus {
  min-height: 16px;
  margin-top: 9px;
  font-size: 12px;
  color: var(--nomad-muted);
}

.bigMetric {
  margin-top: 8px;
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -.03em;
}

.bigMetric small {
  font-size: 16px;
  color: #8090a0;
}

.progressTrack {
  height: 7px;
  margin-top: 16px;
  border-radius: 999px;
  background: #e9eef3;
  overflow: hidden;
}

.progressFill {
  width: 0%;
  height: 100%;
  background: var(--nomad-accent);
  transition: width .25s ease;
}

.scanHeadline {
  font-size: 21px;
  font-weight: 770;
  margin: 8px 0 5px;
}

.quickCard {
  grid-column: 1 / -1;
}

.quickAction {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  background: transparent;
  color: #22384d;
  border: 0;
  border-bottom: 1px solid #edf1f5;
  border-radius: 0;
  padding: 12px 0;
  text-align: left;
}

.quickAction:last-child {
  border-bottom: 0;
}

.principleStrip {
  margin: 16px 0 30px;
  padding: 13px 16px;
  border-left: 3px solid var(--nomad-accent);
  background: #eaf2f6;
  color: #385065;
  border-radius: 7px;
  font-size: 13px;
}

.card.appPage {
  margin-top: 26px;
}

@media (max-width: 900px) {
  .sidebar {
    position: static;
    width: 100%;
    min-height: auto;
    padding: 12px;
  }

  .appShell {
    display: block;
  }

  .brandBlock,
  .sideSpacer,
  .sideNavBottom,
  .sidebarFoot {
    display: none;
  }

  .sideNav {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .navButton {
    justify-content: center;
    font-size: 12px;
    padding: 9px 6px;
  }

  .navButton span {
    display: none;
  }

  .appMain {
    width: 100%;
    margin: 0;
    padding: 0 16px 30px;
  }

  .topBar {
    min-height: 62px;
  }

  .decisionHero {
    display: block;
    padding: 22px;
  }

  .heroStatus {
    margin-top: 18px;
    min-width: 0;
  }

  .decisionGrid {
    grid-template-columns: 1fr;
  }

  .attentionCard,
  .quickCard {
    grid-row: auto;
    grid-column: auto;
  }
}



/* =========================================================
   TRADING WORKSPACE + DECISION CENTER UI - BUILD 0.8.4B.1
========================================================= */

:root {
  --trade-bg: #09111d;
  --trade-panel: #101b2a;
  --trade-panel-2: #142235;
  --trade-panel-3: #18283d;
  --trade-border: #263750;
  --trade-text: #edf3f9;
  --trade-muted: #8fa1b7;
  --trade-accent: #3b82f6;
  --trade-positive: #33d69f;
  --trade-negative: #ff6b75;
  --trade-warning: #f4c15d;
}

body {
  background: var(--trade-bg);
  color: var(--trade-text);
}

.sidebar {
  width: 222px;
  background: #07101d;
  border-right: 1px solid #1c2a3d;
  padding: 18px 12px 14px;
}

.appMain {
  width: calc(100% - 222px);
  margin-left: 222px;
  padding: 0 24px 42px;
  background:
    radial-gradient(circle at 90% 0%, rgba(33,84,130,.16), transparent 28%),
    var(--trade-bg);
}

.brandMark {
  background: #eaf2fb;
  color: #07101d;
  border-radius: 7px;
}

.brandName {
  letter-spacing: -.01em;
}

.navButton {
  color: #a9b8ca;
  border-radius: 6px;
  padding: 10px 11px;
}

.navButton:hover,
.navButton.active {
  background: #16253a;
  color: #fff;
}

.topBar {
  min-height: 64px;
  background: rgba(9,17,29,.94);
  border-bottom: 1px solid #1f2d40;
}

.topSearch {
  background: #0f1a29;
  border-color: #27384f;
  color: #eef4fa;
  border-radius: 6px;
  padding: 11px 14px;
}

.topSearch::placeholder,
input::placeholder {
  color: #6f8299;
}

.askNomadButton {
  background: #1d66d6;
  border-radius: 6px;
  font-weight: 700;
}

.appPage {
  max-width: 1440px;
}

.card,
.terminalCard,
.decisionCard,
.metric,
.chartBox,
.rangeCard,
.eventItem,
.dataTable,
.learnBox,
.infoBox {
  background: var(--trade-panel);
  border-color: var(--trade-border);
  color: var(--trade-text);
  box-shadow: none;
}

.card.appPage {
  margin-top: 18px;
}

.sub,
.muted,
.metricLabel,
.metricSub,
.sourceNote,
.feedMeta,
.chartLegend,
.eventMeta,
.techExplanation,
.auditEvidence,
.auditReason,
.companyHeader span,
.decisionTimestamp,
.rangeHeader,
.rangeLabels,
.marketStateMeta,
.terminalSub {
  color: var(--trade-muted) !important;
}

input,
select {
  background: #0d1725;
  color: var(--trade-text);
  border-color: #2a3b53;
  border-radius: 6px;
}

button {
  background: #1c4e6b;
  border-radius: 6px;
}

button:hover:not(:disabled) {
  filter: brightness(1.08);
}

th {
  background: #142235;
  color: #b7c4d4;
}

th,
td {
  border-bottom-color: #24354a;
}

tbody tr:hover {
  background: #132237;
}

.positive {
  color: var(--trade-positive) !important;
}

.negative {
  color: var(--trade-negative) !important;
}

.neutral {
  color: #a7b5c5 !important;
}

.emptyState,
.terminalEmpty {
  background: #0d1827;
  border: 1px dashed #2b3d55;
  color: var(--trade-muted);
}

.infoBox {
  background: #0e1b2a;
  color: #a9b9ca;
}

.learnBox {
  background: #0e1a29;
  color: #a9b9ca;
}

.learnBox strong {
  color: #e8f1fb;
}

.warningBox {
  background: #2b2515;
  color: #f2d893;
}

.chartModeToggle,
.rangeToggle,
.eventToggle {
  background: #0d1725;
  border-color: #2a3b53;
}

.chartModeButton,
.rangeButton,
.eventModeButton {
  color: #a8b9ca;
}

.chartModeButton.active,
.rangeButton.active,
.eventModeButton.active {
  background: #244b69;
}

.chartAxis,
.volumeSeparator {
  stroke: #34465e;
}

.chartLabel {
  fill: #8396ab;
}

.chartLine,
.technicalPrice {
  stroke: #64a9ff;
}

.chartArea {
  fill: rgba(100,169,255,.09);
}

.terminalHeader {
  margin: 22px 0 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.terminalHeader h1,
.pageTitleRow h1 {
  margin: 3px 0 4px;
  font-size: 26px;
  letter-spacing: -.025em;
}

.terminalSub {
  font-size: 13px;
}

.marketStateBox {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 230px;
  padding: 10px 12px;
  background: #0f1b2b;
  border: 1px solid #24364d;
  border-radius: 7px;
}

.marketStateValue {
  font-weight: 750;
  font-size: 13px;
}

.marketStateMeta {
  margin-top: 2px;
  font-size: 11px;
}

.marketRibbon {
  display: grid;
  grid-template-columns: repeat(4, minmax(0,1fr));
  border: 1px solid #223249;
  border-radius: 7px;
  overflow: hidden;
  margin-bottom: 12px;
  background: #0d1725;
}

.ribbonMetric {
  padding: 10px 13px;
  border-right: 1px solid #223249;
}

.ribbonMetric:last-child {
  border-right: 0;
}

.ribbonMetric span {
  display: block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: #73869c;
  margin-bottom: 4px;
}

.ribbonMetric strong {
  font-size: 13px;
  color: #eaf2fb;
}

.terminalGrid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(320px, .85fr);
  gap: 12px;
}

.terminalCard {
  border: 1px solid var(--trade-border);
  border-radius: 8px;
  padding: 16px;
}

.terminalCard h2 {
  margin: 3px 0 10px;
  font-size: 18px;
  letter-spacing: -.01em;
}

.portfolioHomeCard,
.attentionCardNew {
  min-height: 210px;
}

.panelHeader,
.pageTitleRow,
.modalHeader,
.modalActions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.panelHeader {
  align-items: flex-start;
}

.panelActions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}

.miniButton,
.iconButton {
  padding: 7px 10px;
  font-size: 12px;
  background: #1c4e6b;
  color: #eaf2fb;
  border: 1px solid #2e5e7d;
}

.miniButton.secondary,
.iconButton {
  background: #111d2c;
  color: #aebed0;
  border-color: #2a3a50;
}

.iconButton {
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 22px;
}

.moneyCompact {
  display: flex;
  align-items: center;
  margin: 10px 0 12px;
  background: #0c1623;
  border: 1px solid #2a3a50;
  border-radius: 6px;
}

.moneyCompact span {
  padding-left: 12px;
  color: #8497ad;
  font-size: 12px;
  font-weight: 700;
}

.moneyCompact input {
  margin: 0;
  border: 0;
  font-size: 18px;
  font-weight: 800;
}

.decisionResult {
  margin-top: 9px;
  padding: 10px 11px;
  border: 1px solid #27394f;
  background: #0c1725;
  color: #8fa1b7;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
}

.decisionShadowBanner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 9px;
  padding: 5px 8px;
  border: 1px solid #66552a;
  border-radius: 4px;
  background: #261f0f;
  color: #e4c86d;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .06em;
}

.decisionOutcome {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding-bottom: 9px;
  border-bottom: 1px solid #23344a;
}

.decisionOutcome strong {
  color: #eef5fb;
  font-size: 15px;
}

.decisionOutcome span {
  color: #8ea2b9;
}

.decisionMoneyLine {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: 7px;
  margin-top: 9px;
}

.decisionMoneyLine div {
  padding: 8px;
  border: 1px solid #24364c;
  border-radius: 5px;
  background: #0a1421;
}

.decisionMoneyLine span {
  display: block;
  color: #70869d;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: .05em;
}

.decisionMoneyLine strong {
  display: block;
  margin-top: 2px;
  color: #e8f0f8;
  font-size: 12px;
}

.decisionAllocationRow,
.decisionCandidateRow {
  display: grid;
  grid-template-columns: 72px minmax(0,1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #1f3044;
}

.decisionAllocationRow:last-child,
.decisionCandidateRow:last-child {
  border-bottom: 0;
}

.decisionSymbol {
  color: #f0f5fa;
  font-weight: 800;
}

.decisionMinor {
  color: #8195aa;
  font-size: 10px;
}

.decisionActionTag {
  padding: 3px 6px;
  border-radius: 4px;
  background: #13283a;
  color: #7fbedf;
  font-size: 9px;
  font-weight: 800;
}

.decisionActionTag.buy_now {
  background: #103124;
  color: #75d5a4;
}

.decisionActionTag.staged_buy {
  background: #302811;
  color: #e6c867;
}

.decisionActionTag.avoid {
  background: #321a22;
  color: #ee8a98;
}

.decisionActionTag.data_blocked {
  background: #302811;
  color: #e6c867;
}

.decisionMetaLine {
  margin-top: 8px;
  color: #667d94;
  font-size: 10px;
}

@media (max-width: 700px) {
  .decisionMoneyLine {
    grid-template-columns: 1fr;
  }
}

.compactFeed .attentionItem {
  grid-template-columns: 70px minmax(0,1fr) auto;
  padding: 11px 0;
  border-color: #26364b;
}

.attentionFeed {
  border-color: #26364b;
}

.attentionSummary {
  color: #dfe8f2;
  font-size: 13px;
}

.attentionTime {
  color: #71859b;
}

.severityPill {
  background: #152337;
  color: #8ea3bb;
}

.severityPill.medium {
  background: #332b17;
  color: #f0c768;
}

.severityPill.high,
.severityPill.critical {
  background: #351b24;
  color: #ff7e8a;
}

.breadthBody {
  margin-top: 12px;
}

.breadthCounts {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 8px;
}

.breadthStat {
  padding: 10px;
  border: 1px solid #26364b;
  border-radius: 6px;
  background: #0d1725;
}

.breadthStat strong {
  display: block;
  font-size: 20px;
  margin-top: 3px;
}

.breadthStat span {
  font-size: 10px;
  text-transform: uppercase;
  color: #72869c;
}

.moversGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
}

.moverList {
  display: grid;
  gap: 0;
}

.moverRow {
  display: grid;
  grid-template-columns: 62px minmax(0,1fr) 90px 72px;
  align-items: center;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid #23344a;
  cursor: pointer;
}

.moverRow:last-child {
  border-bottom: 0;
}

.moverRow:hover {
  background: rgba(255,255,255,.018);
}

.moverSymbol {
  font-weight: 800;
}

.moverName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #9dafc2;
  font-size: 12px;
}

.moverPrice,
.moverChange {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.portfolioHome {
  margin-top: 8px;
}

.portfolioSummaryStrip {
  display: grid;
  grid-template-columns: repeat(4,minmax(0,1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.portfolioMetric {
  padding: 10px;
  border: 1px solid #26364b;
  border-radius: 6px;
  background: #0d1725;
}

.portfolioMetric span {
  display: block;
  color: #71869c;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .05em;
}

.portfolioMetric strong {
  display: block;
  margin-top: 4px;
  font-size: 16px;
}

.portfolioRows {
  display: grid;
}

.portfolioRow {
  display: grid;
  grid-template-columns: 62px minmax(0,1fr) 95px 90px 82px;
  gap: 8px;
  align-items: center;
  padding: 9px 0;
  border-top: 1px solid #23344a;
}

.portfolioRow.fullRow {
  grid-template-columns: 62px minmax(0,1fr) 95px 90px 82px 72px;
}

.portfolioRow .symbolName {
  font-weight: 800;
}

.portfolioRow .companyMini {
  color: #7f93aa;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conditionTag {
  display: inline-block;
  margin-top: 3px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #18263a;
  color: #9db0c5;
  font-size: 10px;
}

.conditionTag.weak,
.conditionTag.soft {
  background: #351b24;
  color: #ff8b96;
}

.conditionTag.strong,
.conditionTag.positive {
  background: #123328;
  color: #5de2ad;
}


.portfolioLiveStrip {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid #26364b;
  border-radius: 6px;
  background: #0d1725;
  color: #8ea3ba;
  font-size: 11px;
}

.portfolioDashboardGrid {
  display: grid;
  grid-template-columns: minmax(0,1.5fr) minmax(280px,.7fr);
  gap: 12px;
  margin: 12px 0;
}

.portfolioHealthGrid {
  display: grid;
  grid-template-columns: repeat(2,minmax(0,1fr));
  gap: 8px;
}

.portfolioHealthMetric {
  padding: 10px;
  border: 1px solid #26364b;
  border-radius: 6px;
  background: #0d1725;
}

.portfolioHealthMetric span {
  display: block;
  color: #71869c;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: .05em;
}

.portfolioHealthMetric strong {
  display: block;
  margin-top: 4px;
  font-size: 14px;
}

.portfolioSectorList {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.portfolioSectorRow {
  display: grid;
  grid-template-columns: minmax(0,1fr) 55px;
  gap: 8px;
  align-items: center;
  font-size: 11px;
}

.portfolioSectorTrack {
  height: 5px;
  margin-top: 4px;
  border-radius: 999px;
  background: #1a2a3d;
  overflow: hidden;
}

.portfolioSectorFill {
  height: 100%;
  border-radius: 999px;
  background: #456987;
}

.portfolioTableScroller {
  width: 100%;
  overflow-x: auto;
}

.portfolioPositionHeader,
.portfolioPositionRow {
  min-width: 1040px;
  display: grid;
  grid-template-columns: 75px minmax(180px,1.45fr) 72px 88px 88px 105px 110px 88px 105px;
  gap: 10px;
  align-items: center;
}

.portfolioPositionHeader {
  padding: 8px 10px;
  color: #71869c;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: .05em;
  border-bottom: 1px solid #26364b;
}

.portfolioPositionRow {
  padding: 11px 10px;
  border-bottom: 1px solid #23344a;
  font-size: 11px;
}

.portfolioPositionRow:last-child {
  border-bottom: 0;
}

.portfolioPositionName {
  color: #7f93aa;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.portfolioViewTag,
.transactionSideTag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 68px;
  padding: 3px 7px;
  border: 1px solid #2c4059;
  border-radius: 999px;
  background: #132033;
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
}

.portfolioViewTag.accumulate,
.portfolioViewTag.buy,
.transactionSideTag.buy {
  background: #123328;
  color: #5de2ad;
}

.portfolioViewTag.avoid,
.transactionSideTag.sell {
  background: #351b24;
  color: #ff8b96;
}

.portfolioViewTag.research_required,
.transactionSideTag.dividend {
  background: #372d13;
  color: #f1d47b;
}

.transactionList {
  display: grid;
}

.transactionRow {
  display: grid;
  grid-template-columns: 90px 72px 68px minmax(0,1fr) 90px 62px;
  gap: 9px;
  align-items: center;
  padding: 9px 0;
  border-top: 1px solid #23344a;
  font-size: 11px;
}

.transactionRow:first-child {
  border-top: 0;
}

@media (max-width: 900px) {
  .portfolioDashboardGrid {
    grid-template-columns: 1fr;
  }

  .portfolioHealthGrid {
    grid-template-columns: repeat(2,minmax(0,1fr));
  }
}

.pageTitleRow {
  margin: 22px 0 12px;
  align-items: flex-end;
}

.modalBackdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: rgba(2,7,14,.72);
  backdrop-filter: blur(4px);
}

.modalBackdrop[hidden] {
  display: none;
}

.modalCard {
  width: min(620px, calc(100vw - 32px));
  background: #101b2a;
  border: 1px solid #2b3d55;
  border-radius: 9px;
  padding: 18px;
  box-shadow: 0 22px 70px rgba(0,0,0,.38);
}

.formGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 11px;
  margin: 14px 0;
}

.formGrid label,
.contextRow label {
  color: #8093aa;
  font-size: 11px;
}

.modalActions {
  justify-content: flex-end;
}

.terminalEmpty {
  padding: 28px 12px;
  border-radius: 6px;
  text-align: center;
  font-size: 12px;
}

.terminalEmpty.small {
  padding: 16px 10px;
}

.statusPill,
.auditPill,
.pill {
  background: #16263b;
  color: #a8b9cb;
  border-color: #2a3d55;
}

pre {
  background: #07111c;
  color: #b9c7d6;
}

@media (max-width: 1050px) {
  .terminalGrid,
  .moversGrid {
    grid-template-columns: 1fr;
  }

  .marketRibbon {
    grid-template-columns: 1fr 1fr;
  }

  .ribbonMetric:nth-child(2) {
    border-right: 0;
  }

  .ribbonMetric:nth-child(-n+2) {
    border-bottom: 1px solid #223249;
  }
}

@media (max-width: 900px) {
  .sidebar {
    width: 100%;
  }

  .appMain {
    width: 100%;
    margin: 0;
    padding: 0 12px 30px;
  }

  .terminalHeader {
    align-items: flex-start;
    flex-direction: column;
  }

  .marketStateBox {
    width: 100%;
    box-sizing: border-box;
  }

  .portfolioSummaryStrip {
    grid-template-columns: 1fr 1fr;
  }

  .portfolioRow {
    grid-template-columns: 55px minmax(0,1fr) 80px;
  }

  .portfolioRow .hideMobile {
    display: none;
  }
}

@media (max-width: 620px) {
  .marketRibbon,
  .formGrid,
  .contextRow {
    grid-template-columns: 1fr;
  }

  .ribbonMetric {
    border-right: 0;
    border-bottom: 1px solid #223249;
  }

  .moverRow {
    grid-template-columns: 54px minmax(0,1fr) 68px;
  }

  .moverPrice {
    display: none;
  }
}


/* =========================================================
   DECISION CENTER - BUILD 0.8.4B.1
========================================================= */
.decisionTitleRow {
  align-items: flex-start;
}

.decisionModeBadge {
  border: 1px solid #344865;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .08em;
  color: #bfd0e8;
  background: #111d2d;
  white-space: nowrap;
}

.decisionWorkspaceGrid {
  display: grid;
  grid-template-columns: minmax(270px, .8fr) minmax(0, 2.2fr);
  gap: 16px;
  margin-bottom: 18px;
}

.decisionSetupCard,
.decisionVerdictCard,
.opportunityCard,
.decisionAuditCard {
  min-width: 0;
}

.decisionMoneyInput {
  margin: 14px 0 12px;
}

.decisionPrinciple,
.decisionBoardNote {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.55;
  color: #91a4be;
}

.decisionBoardHeader {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-end;
  margin: 8px 0 12px;
}

.decisionBoardHeader h2 {
  margin: 2px 0 0;
}

.decisionBoardNote {
  max-width: 560px;
  margin: 0;
  text-align: right;
}

.opportunityBoardGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.boardCount {
  display: inline-flex;
  min-width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid #33465f;
  background: #111d2d;
  color: #dfe9f7;
  font-size: 12px;
  font-weight: 800;
}

.opportunityList {
  display: grid;
  gap: 10px;
}

.opportunityRow {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  border-top: 1px solid #223249;
  padding-top: 12px;
}

.opportunityRow:first-child {
  border-top: 0;
  padding-top: 0;
}

.opportunityRank {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: #111d2d;
  border: 1px solid #2f435e;
  color: #b9c9dc;
  font-size: 11px;
  font-weight: 900;
}

.opportunityIdentity {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.opportunityIdentity strong {
  font-size: 14px;
}

.opportunityIdentity span,
.opportunityMeta,
.opportunityReason,
.opportunityConcern {
  font-size: 11px;
  line-height: 1.5;
  color: #8ea1ba;
}

.opportunityMeta {
  margin-bottom: 5px;
}

.opportunityReason {
  color: #bdcada;
}

.opportunityConcern {
  margin-top: 3px;
}

.opportunityAction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 82px;
  border-radius: 999px;
  padding: 6px 9px;
  border: 1px solid #31445e;
  background: #111d2d;
  color: #dce8f8;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .04em;
  white-space: nowrap;
}

.opportunityAction.buy,
.opportunityAction.accumulate {
  border-color: #315c4b;
  background: #10251f;
}

.opportunityAction.research_required {
  border-color: #69572f;
  background: #2a2415;
}

.opportunityAction.avoid {
  border-color: #603944;
  background: #29161d;
}

.decisionHomeSummary {
  min-height: 120px;
}

.homeDecisionHeadline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 10px;
}

.homeDecisionHeadline strong {
  font-size: 22px;
}

.homeDecisionMeta {
  color: #93a6bf;
  font-size: 12px;
  line-height: 1.55;
}

.homeDecisionSymbols {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.homeDecisionSymbols span {
  border: 1px solid #2f435e;
  background: #111d2d;
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 10px;
  font-weight: 800;
}

.stockStrategyCard {
  margin: 0 0 18px;
}

.stockStrategyControls {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) minmax(130px, .8fr) minmax(130px, .8fr) auto;
  gap: 10px;
  align-items: end;
  margin-top: 12px;
}

.stockStrategyControls label {
  display: block;
  margin-bottom: 6px;
}

.stockStrategyControls input,
.stockStrategyControls select {
  width: 100%;
}

.stockStrategyResult {
  margin-top: 14px;
  border-top: 1px solid #24364d;
  padding-top: 14px;
}

.stockStrategyHeadline {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.stockStrategyIdentity strong {
  display: block;
  font-size: 20px;
  margin-bottom: 4px;
}

.stockStrategyIdentity span {
  color: #91a4be;
  font-size: 12px;
}

.stockStrategyBadges {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  justify-content: flex-end;
}

.strategyBadge {
  border: 1px solid #344865;
  background: #111d2d;
  border-radius: 999px;
  padding: 6px 9px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .04em;
  white-space: nowrap;
}

.strategyBadge.good {
  border-color: #315c4b;
  background: #10251f;
}

.strategyBadge.warn {
  border-color: #69572f;
  background: #2a2415;
}

.strategyBadge.bad {
  border-color: #603944;
  background: #29161d;
}

.strategyMetricGrid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0;
}

.strategyMetric {
  border: 1px solid #24364d;
  background: #101a28;
  border-radius: 10px;
  padding: 10px;
  min-width: 0;
}

.strategyMetric span {
  display: block;
  color: #8498b3;
  font-size: 10px;
  margin-bottom: 5px;
}

.strategyMetric strong {
  display: block;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.strategySections {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.strategySection {
  border: 1px solid #24364d;
  background: #101a28;
  border-radius: 10px;
  padding: 12px;
}

.strategySection h3 {
  margin: 0 0 8px;
  font-size: 13px;
}

.strategyLine {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-top: 1px solid #1d2a3d;
  font-size: 11px;
}

.strategyLine:first-of-type {
  border-top: 0;
}

.strategyLine span {
  color: #8ea1ba;
}

.strategyReason {
  color: #bdcada;
  font-size: 12px;
  line-height: 1.55;
  margin: 8px 0 0;
}

.strategyRiskList {
  margin: 8px 0 0;
  padding-left: 18px;
  color: #9dafc6;
  font-size: 11px;
  line-height: 1.55;
}

.opportunityAnalyzeButton {
  border: 0;
  background: transparent;
  color: #72b9e6;
  padding: 0;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
}

.decisionAudit {
  display: grid;
  grid-template-columns: repeat(6, minmax(0,1fr));
  gap: 8px;
}

.auditMetric {
  border: 1px solid #24364d;
  background: #101a28;
  border-radius: 10px;
  padding: 10px;
}

.auditMetric span {
  display: block;
  font-size: 10px;
  color: #8498b3;
  margin-bottom: 4px;
}

.auditMetric strong {
  font-size: 15px;
}

@media (max-width: 1000px) {
  .decisionWorkspaceGrid,
  .opportunityBoardGrid {
    grid-template-columns: 1fr;
  }

  .decisionBoardHeader {
    align-items: flex-start;
    flex-direction: column;
  }

  .decisionBoardNote {
    text-align: left;
  }

  .decisionAudit {
    grid-template-columns: repeat(3, minmax(0,1fr));
  }

  .stockStrategyControls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .strategyMetricGrid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

}

@media (max-width: 640px) {
  .decisionAudit {
    grid-template-columns: repeat(2, minmax(0,1fr));
  }

  .opportunityRow {
    grid-template-columns: 30px minmax(0,1fr);
  }

  .opportunityAction {
    grid-column: 2;
    justify-self: start;
  }

  .stockStrategyControls,
  .strategySections {
    grid-template-columns: 1fr;
  }

  .strategyMetricGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stockStrategyHeadline {
    flex-direction: column;
  }

  .stockStrategyBadges {
    justify-content: flex-start;
  }

}

</style>

</head>

<body>

<div class="appShell">

<aside class="sidebar">

<div class="brandBlock">
<div class="brandMark">N</div>
<div>
<div class="brandName">NOMAD Invest</div>
<div class="brandSub">Decision intelligence</div>
</div>
</div>

<nav class="sideNav">
<button class="navButton active" data-nav="home"><span>⌂</span>Home</button>
<button class="navButton" data-nav="portfolio"><span>▤</span>Portfolio</button>
<button class="navButton" data-nav="decision"><span>◆</span>Decision Center</button>
<button class="navButton" data-nav="research"><span>⌕</span>Research</button>
<button class="navButton" data-nav="explore"><span>↗</span>Explore PSX</button>
<button class="navButton" data-nav="universe"><span>◎</span>Universe</button>
</nav>

<div class="sideSpacer"></div>

<nav class="sideNav sideNavBottom">
<button class="navButton" data-nav="system"><span>⚙</span>System</button>
</nav>

<div class="sidebarFoot">Build ${VERSION}</div>

</aside>

<main class="appMain">

<div class="topBar">
<div class="topSearchWrap">
<input id="globalSymbolSearch" class="topSearch" placeholder="Search company or PSX symbol...">
</div>
<button id="askNomadButton" class="askNomadButton">Ask NOMAD</button>
</div>

<header class="legacyHeader">

<div>

<h1>NOMAD Invest</h1>

<div class="sub">
AI-powered PSX decision intelligence
</div>

</div>

<strong>
Build ${VERSION}
</strong>

</header>

<p class="notice">

Market, company metadata, fundamentals, symbol normalization,
canonical universe identity, metadata, fundamentals and deterministic technical analysis are connected.

NOMAD 0.9.0 consolidates security validation, evidence state, analyst action, opportunity priority, portfolio context and allocation permission into one canonical decision contract. Live portfolio and market features remain shadow-only and no trade execution is performed.

</p>

<p id="status">
Checking connection...
</p>

<p id="error"></p>

<section
  class="appPage active"
  data-page="home"
  id="homePage"
>

<div class="terminalHeader">
<div>
<div class="eyebrow">HOME</div>
<h1>Your market command center</h1>
<div class="terminalSub">NOMAD prioritizes what matters to your money — holdings, meaningful changes, market leaders and decisions.</div>
</div>
<div class="marketStateBox">
<div class="statusDot"></div>
<div>
<div id="homeMarketState" class="marketStateValue">Checking market...</div>
<div id="homeMarketAsOf" class="marketStateMeta">Latest available PSX snapshot</div>
</div>
</div>
</div>

<div class="marketRibbon">
<div class="ribbonMetric"><span>Core monitored</span><strong id="homeStateCoverage">0 / ${PSX_UNIVERSE_MASTER.summary.coreEquity}</strong></div>
<div class="ribbonMetric"><span>Historical context</span><strong id="homeHistoryCoverage">0 / ${PSX_UNIVERSE_MASTER.summary.coreEquity}</strong></div>
<div class="ribbonMetric"><span>Last scan</span><strong id="homeLastScan">Waiting</strong></div>
<div class="ribbonMetric"><span>Portfolio</span><strong id="homePortfolioCount">Not added</strong></div>
</div>

<div class="terminalGrid">

<div class="terminalCard portfolioHomeCard">
<div class="panelHeader">
<div>
<div class="eyebrow">YOUR MONEY</div>
<h2>Portfolio</h2>
</div>
<div class="panelActions">
<button class="miniButton" id="homeRecordTrade">+ Record trade</button>
<button class="miniButton secondary" id="homeImportPortfolio">Import CSV</button>
</div>
</div>
<div id="portfolioHome" class="portfolioHome">
<div class="terminalEmpty">Loading portfolio...</div>
</div>
</div>

<div class="terminalCard plannerCardNew">
<div class="panelHeader">
<div>
<div class="eyebrow">NOMAD DECISION</div>
<h2>Latest capital decision</h2>
</div>
<button class="miniButton secondary" data-open-page="decision">Open Decision Center</button>
</div>
<div id="homeDecisionSummary" class="decisionHomeSummary">
<div class="terminalEmpty">Run your first analysis in Decision Center.</div>
</div>
</div>

<div class="terminalCard attentionCardNew">
<div class="panelHeader">
<div>
<div class="eyebrow">NEEDS YOUR ATTENTION</div>
<h2>What changed or is already weak?</h2>
</div>
<button id="refreshIntelligenceFeed" class="miniButton secondary">Refresh</button>
</div>
<div id="attentionFeed" class="attentionFeed compactFeed">
<div class="terminalEmpty">Loading latest intelligence...</div>
</div>
</div>

<div class="terminalCard breadthCard">
<div class="eyebrow">MARKET BREADTH</div>
<h2>Session snapshot</h2>
<div id="marketBreadth" class="breadthBody">
<div class="terminalEmpty small">Loading...</div>
</div>
</div>

</div>

<div class="moversGrid">
<div class="terminalCard moverCard">
<div class="panelHeader"><div><div class="eyebrow">LEADERS</div><h2 id="gainersTitle">Top 5 gainers</h2></div></div>
<div id="topGainers" class="moverList"><div class="terminalEmpty small">Loading...</div></div>
</div>
<div class="terminalCard moverCard">
<div class="panelHeader"><div><div class="eyebrow">LAGGARDS</div><h2 id="losersTitle">Top 5 losers</h2></div></div>
<div id="topLosers" class="moverList"><div class="terminalEmpty small">Loading...</div></div>
</div>
</div>

</section>

<section class="appPage" id="decisionCenterPage" data-page="decision">
<div class="pageTitleRow decisionTitleRow">
<div>
<div class="eyebrow">CORE AI INTELLIGENCE</div>
<h1>Decision Center</h1>
<p class="muted">NOMAD first ranks the best PSX opportunities independently of your budget. Only after the thesis and evidence pass does the allocator convert your amount into whole shares.</p>
</div>
<div class="decisionModeBadge">SHADOW · STRICT EVIDENCE GATES</div>
</div>

<div class="decisionWorkspaceGrid">
<div class="terminalCard decisionSetupCard">
<div class="eyebrow">CAPITAL TO DEPLOY</div>
<h2>Build the best feasible plan</h2>
<div class="moneyCompact decisionMoneyInput"><span>PKR</span><input id="decisionAmount" inputmode="numeric" value="5000"></div>
<div class="contextRow">
<div><label>Horizon</label><select id="decisionHorizon"><option value="long_term">Long-term</option><option value="short_term">Short-term</option></select></div>
<div><label>Risk</label><select id="decisionRisk"><option value="balanced">Balanced</option><option value="conservative">Conservative</option><option value="aggressive">Aggressive</option></select></div>
</div>
<button id="findBestOption" class="primaryWide">Analyze PSX & build plan</button>
<div class="decisionPrinciple">Priority ranking does not change because of your budget. If a better stock cannot fit one whole share, NOMAD keeps it ranked and leaves cash rather than substituting a weaker idea.</div>
</div>

<div class="terminalCard decisionVerdictCard">
<div class="panelHeader"><div><div class="eyebrow">CAPITAL DECISION</div><h2>What NOMAD would do now</h2></div></div>
<div id="decisionResult" class="decisionResult">Run an analysis to generate the current ranked opportunity board and a separate whole-share allocation for your amount.</div>
</div>
</div>

<div class="terminalCard stockStrategyCard">
<div class="panelHeader">
<div>
<div class="eyebrow">STOCK STRATEGY</div>
<h2>Analyze one company before you act</h2>
<p class="muted">Use the same professional brain on a single PSX stock. NOMAD separates the objective market view from what you personally should do based on horizon, risk profile and existing holdings.</p>
</div>
</div>
<div class="stockStrategyControls">
<div><label>Stock</label><input id="strategySymbol" placeholder="Example: OGDC"></div>
<div><label>Horizon</label><select id="strategyHorizon"><option value="long_term">Long-term</option><option value="short_term">Short-term</option></select></div>
<div><label>Risk</label><select id="strategyRisk"><option value="balanced">Balanced</option><option value="conservative">Conservative</option><option value="aggressive">Aggressive</option></select></div>
<button id="analyzeStockStrategy" class="primaryWide">Analyze stock</button>
</div>
<div id="stockStrategyResult" class="stockStrategyResult"><div class="terminalEmpty small">Enter a symbol to see thesis, performance, valuation, risk, technical timing and your personal action.</div></div>
</div>

<div class="decisionBoardHeader">
<div><div class="eyebrow">OPPORTUNITY BOARD</div><h2>Ranked before allocation</h2></div>
<div class="decisionBoardNote">Each company now has one canonical state. Missing evidence triggers automatic Evidence Research and backfill; WATCH, active research and Avoid are never allowed to receive capital. Priority controls ranking, while the canonical market action controls whether allocation is permitted.</div>
</div>

<div class="opportunityBoardGrid">
<div class="terminalCard opportunityCard priorityOneCard">
<div class="panelHeader"><div><div class="eyebrow">PRIORITY 1</div><h2>Best current opportunities</h2></div><span class="boardCount" id="priorityOneCount">0</span></div>
<div id="priorityOneList" class="opportunityList"><div class="terminalEmpty small">Run analysis to rank opportunities.</div></div>
</div>

<div class="terminalCard opportunityCard priorityTwoCard">
<div class="panelHeader"><div><div class="eyebrow">PRIORITY 2</div><h2>Next best opportunities</h2></div><span class="boardCount" id="priorityTwoCount">0</span></div>
<div id="priorityTwoList" class="opportunityList"><div class="terminalEmpty small">Run analysis to rank opportunities.</div></div>
</div>

<div class="terminalCard opportunityCard researchCard">
<div class="panelHeader"><div><div class="eyebrow">EVIDENCE RESEARCH</div><h2>NOMAD is investigating missing evidence</h2></div><span class="boardCount" id="researchRequiredCount">0</span></div>
<div id="researchRequiredList" class="opportunityList"><div class="terminalEmpty small">Missing evidence triggers automatic research and does not consume the whole comparable set.</div></div>
</div>

<div class="terminalCard opportunityCard avoidCard">
<div class="panelHeader"><div><div class="eyebrow">LOW PRIORITY / AVOID</div><h2>Not attractive enough now</h2></div><span class="boardCount" id="avoidCount">0</span></div>
<div id="avoidList" class="opportunityList"><div class="terminalEmpty small">Evidence-backed rejects will appear here.</div></div>
</div>
</div>

<div class="terminalCard decisionAuditCard">
<div class="panelHeader"><div><div class="eyebrow">AUDIT</div><h2>What NOMAD actually analyzed</h2></div></div>
<div id="decisionAudit" class="decisionAudit"><div class="terminalEmpty small">No analysis run yet.</div></div>
</div>
</section>

<section class="appPage" id="portfolioPage" data-page="portfolio">
<div class="pageTitleRow">
<div><div class="eyebrow">LIVE PORTFOLIO INTELLIGENCE</div><h1>Your portfolio mirror</h1><p class="muted">Record the trades you execute with your broker. NOMAD mirrors the positions against current PSX prices, tracks P&amp;L, concentration and the latest NOMAD view, and uses existing holdings when allocating new money.</p></div>
<div class="panelActions"><button id="portfolioRecordTrade" class="miniButton">+ Record trade</button><button id="portfolioImportCsv" class="miniButton secondary">Import CSV</button><button id="portfolioAddHolding" class="miniButton secondary">Opening holding</button></div>
</div>
<div id="portfolioFull"><div class="terminalCard"><div class="terminalEmpty">Loading live portfolio...</div></div></div>
</section>

<section
  class="card appPage"
  id="researchSection" data-page="research"
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

<button id="loadTechnical">
Technical
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

<section class="card appPage" id="exploreSection" data-page="explore">

<div class="panelHeader">
<div>
<div class="eyebrow">LIVE MARKET</div>
<h2>Explore PSX</h2>
<p class="muted">Current PSX market feed with live price tracking. Prices refresh automatically while this page is open.</p>
</div>
<button id="loadMarket" class="miniButton secondary">Refresh now</button>
</div>

<div id="exploreLiveStatus" class="liveStrip">
<span class="feedDot delayed"></span>
<span class="feedMeta">Loading latest PSX market feed...</span>
</div>

<div class="filters">

<div>

<label>
Search
</label>

<input
  id="search"
  type="search"
  placeholder="Company or symbol"
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

<option value="dayChangeDesc">
Top gainers today
</option>

<option value="dayChangeAsc">
Top losers today
</option>

<option value="sessionVolumeDesc">
Highest live volume
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

<section class="card appPage" id="universeMasterSection" data-page="universe">

<h2>Canonical PSX Universe</h2>

<p class="muted">
NOMAD now uses a frozen, versioned security master for identity and recommendation eligibility. Market-price feeds can update prices, volumes and live status codes, but they cannot add a security to the recommendation universe.
</p>

<div class="summaryGrid">

<div class="metric"><div class="metricLabel">Master version</div><div class="metricValue">${PSX_UNIVERSE_MASTER.masterVersion}</div></div>

<div class="metric"><div class="metricLabel">Core equities</div><div class="metricValue">${PSX_UNIVERSE_MASTER.summary.coreEquity}</div><div class="metricSub">Default recommendation universe</div></div>

<div class="metric"><div class="metricLabel">GEM equities</div><div class="metricValue">${PSX_UNIVERSE_MASTER.summary.gemEquity}</div><div class="metricSub">Separate higher-risk universe</div></div>

<div class="metric"><div class="metricLabel">Alternative current</div><div class="metricValue">${PSX_UNIVERSE_MASTER.summary.alternativeCurrent}</div><div class="metricSub">REIT / Modaraba / fund / rights / special</div></div>

<div class="metric"><div class="metricLabel">Review required</div><div class="metricValue">${PSX_UNIVERSE_MASTER.summary.reviewRequired}</div><div class="metricSub">Quarantined from recommendations</div></div>

<div class="metric"><div class="metricLabel">Total identities</div><div class="metricValue">${PSX_UNIVERSE_MASTER.summary.total}</div></div>

</div>

<div class="infoBox">
<strong>Universe lock:</strong> Core equities may proceed to future scoring and allocation. GEM and alternative securities require separate frameworks. Review-required symbols remain searchable for research but cannot enter recommendations. Universe changes will be handled later through a controlled master refresh/diff, not during normal app use.
</div>

</section>

<section class="card appPage" id="scannerSystemSection" data-page="system">

<h2>Intelligence Scanner</h2>
<p class="muted">The scanner keeps a fast market baseline across the core universe and also rotates through historical context so NOMAD can distinguish new changes from conditions that were already weak or strong. Portfolio holdings receive priority context checks.</p>

<div class="summaryGrid">
<div class="metric"><div class="metricLabel">Core universe</div><div class="metricValue">${PSX_UNIVERSE_MASTER.summary.coreEquity}</div></div>
<div class="metric"><div class="metricLabel">Scanner</div><div id="scannerSystemState" class="metricValue">Ready</div><div class="metricSub">Market + rotating historical context</div></div>
<div class="metric"><div class="metricLabel">Autonomous schedule</div><div id="scannerScheduleState" class="metricValue">Pending</div><div class="metricSub">Configured separately after scan verification</div></div>
</div>

<div class="actions"><button id="runIntelligenceScan">Refresh market + context now</button></div>
<div id="scanSystemResult" class="infoBox">Developer control: refresh the fast market baseline and a rotating batch of historical situations.</div>

</section>

<section class="card appPage" id="continuousMemorySection" data-page="system">

<h2>Continuous Intelligence Memory</h2>

<p class="muted">
Developer verification tool. NOMAD reads a stock's previously stored state, recalculates its current market and technical state, records changes, and saves the new state for the next run.
</p>

<div class="grid3">

<div>
<label for="memoryTestSymbol">Test symbol</label>
<input
  id="memoryTestSymbol"
  type="text"
  value="HBL"
  placeholder="Example: HBL"
>
</div>

<div style="align-self:end">
<button id="runMemoryTest">
Test persistent memory
</button>
</div>

<div>
<div class="metricLabel">Database status</div>
<div
  id="memoryDatabaseStatus"
  class="metricValue"
>
Checking...
</div>
</div>

</div>

<div
  id="memoryTestResult"
  class="infoBox"
  style="margin-top:16px"
>
Run the test once to create the first observation. Run it again later to prove NOMAD can retrieve the previous state before saving the new one.
</div>

</section>

<section
  class="card appPage"
  data-page="system"
  id="metadataAuditSection"
  style="display:none"
>

<h2>
Legacy Universe Audit (retired)
</h2>

<p class="muted">
Read-only diagnostic. This checks metadata completeness, uses official PSX bulk listing/status evidence, separates security type from issuer type, and prepares future universe eligibility. It does not remove or modify any security.
</p>

<div class="actions">

<button id="runMetadataAudit">
Run metadata audit
</button>

<button
  id="downloadMetadataAuditCSV"
  style="display:none"
>
Download current view CSV
</button>

<button
  id="downloadMetadataAuditJSON"
  style="display:none"
>
Download full audit JSON
</button>

</div>

<p
  id="metadataAuditProgress"
  class="muted"
></p>

<div id="metadataAuditSummary"></div>

<div
  id="metadataAuditControls"
  style="display:none"
>

<div class="auditFilters">

<div>

<label>
Audit view
</label>

<select id="metadataAuditView">

<option value="issues">
Metadata issues only
</option>

<option value="universe">
All securities
</option>

</select>

</div>

<div>

<label>
Search audit
</label>

<input
  id="metadataAuditSearch"
  type="search"
  placeholder="Symbol, company, sector, status, successor or evidence"
>

</div>

<div>

<label>
Issue category
</label>

<select id="metadataAuditCategory">

<option value="">
All issue categories
</option>

<option value="LIKELY_NORMAL_COMPANY_MISSING_METADATA">
Likely company metadata gaps
</option>

<option value="LIKELY_SPECIAL_INSTRUMENT">
Special-instrument metadata gaps
</option>

<option value="LEGACY_STALE_CANDIDATE">
Legacy / stale candidates
</option>

<option value="HISTORICAL_SECURITY">
Historical-security metadata gaps
</option>

<option value="UNRESOLVED">
Unresolved
</option>

</select>

</div>

<div>

<label>
Security class
</label>

<select id="metadataAuditUniverseClass">

<option value="">
All security classes
</option>

<option value="VERIFIED_CURRENT">
Verified current
</option>

<option value="SPECIAL_INSTRUMENT">
Special instrument
</option>

<option value="SUSPENDED_SECURITY">
Suspended security
</option>

<option value="HISTORICAL_OR_INACTIVE">
Historical / inactive
</option>

<option value="LEGACY_STALE_CANDIDATE">
Legacy / stale candidate
</option>

<option value="REVIEW_REQUIRED">
Review required
</option>

<option value="UNVERIFIED">
Unverified
</option>

</select>

</div>

<div>

<label>
Trading status
</label>

<select id="metadataAuditTradingStatus">

<option value="">
All trading statuses
</option>

<option value="CURRENT">
Current - bulk PSX evidence
</option>

<option value="CURRENT_PAGE_EVIDENCE">
Current - company page evidence
</option>

<option value="SUSPENDED">
Suspended
</option>

<option value="DELISTED">
Delisted
</option>

<option value="CHANGED">
Changed / renamed
</option>

<option value="MERGED">
Merged / amalgamated
</option>

<option value="MIGRATED_OR_SYMBOL_CHANGED">
Migrated / symbol changed
</option>

<option value="HISTORICAL_OR_INACTIVE">
Historical / inactive
</option>

<option value="PAGE_STATUS_UNCLEAR">
Official page - unclear
</option>

<option value="NO_COMPANY_PAGE_EVIDENCE">
No company-page evidence
</option>

<option value="UNKNOWN">
Not resolved yet
</option>

</select>

</div>

<div>

<label>
Universe eligibility
</label>

<select id="metadataAuditEligibility">

<option value="">
All eligibility classes
</option>

<option value="CORE_EQUITY_CANDIDATE">
Core equity candidate
</option>

<option value="GEM_EQUITY_CANDIDATE">
GEM equity candidate
</option>

<option value="ALTERNATIVE_LISTED_SECURITY">
Alternative listed security
</option>

<option value="NON_CORE_SPECIAL_SECURITY">
Separate special-security universe
</option>

<option value="SPECIAL_EQUITY_REVIEW">
Special equity review
</option>

<option value="HOLD_SUSPENDED">
Hold - suspended
</option>

<option value="INELIGIBLE_DELISTED">
Not eligible - delisted
</option>

<option value="INELIGIBLE_HISTORICAL_SYMBOL">
Not eligible - historical symbol
</option>

<option value="REVIEW_REQUIRED">
Review required
</option>

</select>

</div>

</div>
<p
  id="metadataAuditInfo"
  class="muted"
></p>

<div
  id="metadataAuditTable"
  class="scroll"
></div>

<div class="pagination">

<div
  id="metadataAuditPageInfo"
  class="muted"
></div>

<div class="paginationControls">

<button id="metadataAuditPrevious">
Previous
</button>

<button id="metadataAuditNext">
Next
</button>

</div>

</div>

</div>

</section>

<div id="portfolioModal" class="modalBackdrop" hidden>
<div class="modalCard">
<div class="modalHeader"><div><div class="eyebrow">PORTFOLIO</div><h2>Add or update holding</h2></div><button id="closePortfolioModal" class="iconButton">×</button></div>
<div class="formGrid">
<div><label>PSX symbol</label><input id="holdingSymbol" placeholder="HBL"></div>
<div><label>Quantity</label><input id="holdingQuantity" inputmode="decimal" placeholder="10"></div>
<div><label>Average cost / share</label><input id="holdingAverageCost" inputmode="decimal" placeholder="295.00"></div>
<div><label>Purchase date</label><input id="holdingPurchaseDate" type="date"></div>
<div><label>Fees (optional)</label><input id="holdingFees" inputmode="decimal" value="0"></div>
</div>
<div id="holdingFormStatus" class="smallStatus"></div>
<div class="modalActions"><button id="saveHoldingButton">Save holding</button><button id="cancelHoldingButton" class="miniButton secondary">Cancel</button></div>
</div>
</div>

<div id="portfolioTransactionModal" class="modalBackdrop" hidden>
<div class="modalCard">
<div class="modalHeader"><div><div class="eyebrow">PORTFOLIO LEDGER</div><h2>Record a real trade</h2></div><button id="closePortfolioTransactionModal" class="iconButton">×</button></div>
<div class="formGrid">
<div><label>Transaction</label><select id="transactionSide"><option value="BUY">Buy</option><option value="SELL">Sell</option><option value="DIVIDEND">Dividend received</option></select></div>
<div><label>PSX symbol</label><input id="transactionSymbol" placeholder="FCL"></div>
<div class="tradeField"><label>Quantity</label><input id="transactionQuantity" inputmode="decimal" placeholder="100"></div>
<div class="tradeField"><label>Price / share</label><input id="transactionPrice" inputmode="decimal" placeholder="26.50"></div>
<div class="dividendField" hidden><label>Dividend cash received</label><input id="transactionCashAmount" inputmode="decimal" placeholder="1500"></div>
<div><label>Trade date</label><input id="transactionDate" type="date"></div>
<div><label>Fees / charges</label><input id="transactionFees" inputmode="decimal" value="0"></div>
<div><label>Notes (optional)</label><input id="transactionNotes" placeholder="Broker / contract note reference"></div>
</div>
<div id="transactionFormStatus" class="smallStatus"></div>
<div class="modalActions"><button id="saveTransactionButton">Save transaction</button><button id="cancelTransactionButton" class="miniButton secondary">Cancel</button></div>
</div>
</div>
<input id="portfolioCsvInput" type="file" accept=".csv,text/csv" hidden>

</main>

</div>

<script>

const $ =
  id =>
    document.getElementById(
      id
    );

let marketRows = [];

let currentPage = 1;

const PAGE_SIZE = 25;

let metadataAuditRows = [];

let metadataAuditUniverseRows = [];

let lastMetadataAuditResult =
  null;

let metadataAuditPage = 1;

const METADATA_AUDIT_PAGE_SIZE =
  50;

let liveRefreshTimer = null;
let portfolioRefreshTimer = null;
let exploreRefreshTimer = null;
let exploreRefreshInFlight = false;
let explorePreviousPrices = new Map();

let liveRefreshSymbol = null;

let liveView = null;

let liveChartMode =
  'candles';

let lastLiveChartResult =
  null;

let lastQuoteResult =
  null;

let selectedHistoryRange =
  '1Y';

let lastEventsResult =
  null;

let eventMode =
  'key';

/* =========================================================
   UI HELPERS
========================================================= */

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

  return number.toLocaleString(
    'en-PK',
    {
      maximumFractionDigits:
        digits
    }
  );
}

function formatCompactNumber(
  value
) {
  const number =
    Number(
      value
    );

  if (!Number.isFinite(number)) {
    return 'N/A';
  }

  const absolute =
    Math.abs(
      number
    );

  if (absolute >= 1e12) {
    return (
      number / 1e12
    ).toFixed(2) + 'T';
  }

  if (absolute >= 1e9) {
    return (
      number / 1e9
    ).toFixed(2) + 'B';
  }

  if (absolute >= 1e6) {
    return (
      number / 1e6
    ).toFixed(2) + 'M';
  }

  if (absolute >= 1e3) {
    return (
      number / 1e3
    ).toFixed(1) + 'K';
  }

  return formatNumber(
    number,
    0
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

  return date.toLocaleDateString(
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

  return date.toLocaleString(
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

function formatKarachiDate(
  value = Date.now()
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
    return '';
  }

  return date.toLocaleDateString(
    'en-PK',
    {
      timeZone:
        'Asia/Karachi',

      day:
        'numeric',

      month:
        'short',

      year:
        'numeric'
    }
  );
}

function marketClosedLabel(
  marketStatus
) {
  const dateLabel =
    formatKarachiDate();

  let label =
    'Market closed' +
    (
      dateLabel
        ? ' for ' +
          dateLabel
        : ''
    );

  if (
    marketStatus?.holidayName
  ) {
    label +=
      ' · ' +
      marketStatus.holidayName;
  }

  return label;
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

  return date.toLocaleTimeString(
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
    Math.abs(
      number
    );

  if (
    absolute >=
    1e12
  ) {
    return (
      'PKR ' +
      formatNumber(
        number /
        1e12,
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
        number /
        1e9,
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
        number /
        1e6,
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

function formatFinancialThousands(
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

  return formatCompactPKR(
    number *
    1000
  );
}

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
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

  url.searchParams.set(
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

async function apiPost(
  action,
  body = {},
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
      url.searchParams.set(
        key,
        value
      );
    }
  }

  const response =
    await fetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body:
          JSON.stringify(
            body
          )
      }
    );

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



/* =========================================================
   APP NAVIGATION + DECISION CENTER + LIVE PORTFOLIO - BUILD 0.9.0
========================================================= */

const NOMAD_APP_PAGES =
  new Set([
    'home',
    'portfolio',
    'decision',
    'research',
    'explore',
    'universe',
    'system'
  ]);

function normalizedAppPage(
  page
) {
  const normalized =
    String(
      page ||
      ''
    )
      .trim()
      .toLowerCase();

  return NOMAD_APP_PAGES.has(
    normalized
  )
    ? normalized
    : 'home';
}

function appPageFromLocation() {
  const rawHashPage =
    String(
      window.location.hash ||
      ''
    )
      .replace(
        /^#/,
        ''
      )
      .trim()
      .toLowerCase();

  if (
    rawHashPage &&
    NOMAD_APP_PAGES.has(
      rawHashPage
    )
  ) {
    return rawHashPage;
  }

  try {
    const stored =
      localStorage.getItem(
        'nomadActivePage'
      );

    if (
      stored &&
      NOMAD_APP_PAGES.has(
        stored
      )
    ) {
      return stored;
    }
  } catch {}

  return 'home';
}

function openAppPage(
  page,
  options = {}
) {
  page =
    normalizedAppPage(
      page
    );

  // Clear page-scoped errors when the user navigates. A failed Research
  // request must not leave a stale red error banner on Decision Center,
  // Explore PSX, Portfolio, or any other page.
  if ($('error')) {
    $('error')
      .textContent =
        '';
  }

  const updateLocation =
    options.updateLocation !==
      false;

  const scrollToTop =
    options.scrollToTop !==
      false;
  document
    .querySelectorAll(
      '.appPage'
    )
    .forEach(
      element => {
        element.classList.toggle(
          'active',
          element.dataset.page ===
            page
        );
      }
    );

  document
    .querySelectorAll(
      '.navButton[data-nav]'
    )
    .forEach(
      button => {
        button.classList.toggle(
          'active',
          button.dataset.nav ===
            page
        );
      }
    );

  try {
    localStorage.setItem(
      'nomadActivePage',
      page
    );
  } catch {}

  if (updateLocation) {
    const targetHash =
      '#' +
      page;

    if (
      window.location.hash !==
      targetHash
    ) {
      history.pushState(
        null,
        '',
        targetHash
      );
    }
  }

  if (scrollToTop) {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }

  if (portfolioRefreshTimer) {
    clearInterval(
      portfolioRefreshTimer
    );
    portfolioRefreshTimer =
      null;
  }

  if (exploreRefreshTimer) {
    clearInterval(
      exploreRefreshTimer
    );
    exploreRefreshTimer =
      null;
  }

  if (page === 'portfolio') {
    loadPortfolioViews();

    portfolioRefreshTimer =
      setInterval(
        () => {
          if (
            document.visibilityState ===
            'visible'
          ) {
            loadPortfolioViews();
          }
        },
        10000
      );
  }

  if (page === 'explore') {
    loadExploreMarket(
      false
    );

    exploreRefreshTimer =
      setInterval(
        () => {
          if (
            document.visibilityState ===
            'visible'
          ) {
            loadExploreMarket(
              false
            );
          }
        },
        10000
      );
  }
}

function relativeTime(
  value
) {
  const time =
    Date.parse(value);

  if (!Number.isFinite(time)) {
    return '';
  }

  const seconds =
    Math.max(
      0,
      Math.round(
        (
          Date.now() -
          time
        ) /
        1000
      )
    );

  if (seconds < 60) {
    return seconds + ' sec ago';
  }

  const minutes =
    Math.round(
      seconds / 60
    );

  if (minutes < 60) {
    return minutes + ' min ago';
  }

  const hours =
    Math.round(
      minutes / 60
    );

  if (hours < 24) {
    return hours + ' hr ago';
  }

  return Math.round(
    hours / 24
  ) + ' d ago';
}

function renderAttentionFeed(
  items
) {
  const target =
    $('attentionFeed');

  if (!target) {
    return;
  }

  if (
    !Array.isArray(items) ||
    !items.length
  ) {
    target.innerHTML =
      '<div class="emptyState">No material changes are waiting for you right now. NOMAD will surface them here when the scanner detects something meaningful.</div>';
    return;
  }

  target.innerHTML =
    items
      .map(
        item =>
          '<div class="attentionItem">' +
          '<div class="attentionSymbol">' +
          escapeHtml(
            item.symbol || '-'
          ) +
          '</div>' +
          '<div>' +
          '<div class="attentionSummary">' +
          escapeHtml(
            item.summary ||
            'Meaningful state change detected.'
          ) +
          '</div>' +
          '<div class="attentionTime">' +
          escapeHtml(
            relativeTime(
              item.detected_at
            )
          ) +
          '</div>' +
          '</div>' +
          '<div class="severityPill ' +
          escapeHtml(
            item.significance ||
            'medium'
          ) +
          '">' +
          escapeHtml(
            item.significance ||
            'medium'
          ) +
          '</div>' +
          '</div>'
      )
      .join('');
}

function renderMoverList(
  targetId,
  rows
) {
  const target =
    $(targetId);

  if (!target) {
    return;
  }

  if (
    !Array.isArray(rows) ||
    !rows.length
  ) {
    target.innerHTML =
      '<div class="terminalEmpty small">No mover data available from the latest PSX market snapshot.</div>';
    return;
  }

  target.innerHTML =
    rows
      .map(
        item =>
          '<div class="moverRow" data-research-symbol="' +
          escapeHtml(
            item.symbol
          ) +
          '">' +
          '<div class="moverSymbol">' +
          escapeHtml(
            item.symbol
          ) +
          '</div>' +
          '<div class="moverName">' +
          escapeHtml(
            item.companyName ||
            item.symbol
          ) +
          '</div>' +
          '<div class="moverPrice">PKR ' +
          formatNumber(
            item.price,
            2
          ) +
          '</div>' +
          '<div class="moverChange ' +
          percentClass(
            item.changePct
          ) +
          '">' +
          (
            Number(
              item.changePct
            ) > 0
              ? '+'
              : ''
          ) +
          formatNumber(
            item.changePct,
            2
          ) +
          '%</div>' +
          '</div>'
      )
      .join('');

  target
    .querySelectorAll(
      '[data-research-symbol]'
    )
    .forEach(
      row => {
        row.onclick =
          () => {
            $('stockSymbol')
              .value =
                row.dataset
                  .researchSymbol;

            openAppPage(
              'research'
            );

            $('loadQuote')
              .click();
          };
      }
    );
}

function renderMarketBreadth(
  pulse
) {
  const target =
    $('marketBreadth');

  if (!target) {
    return;
  }

  const breadth =
    pulse?.breadth;

  if (!breadth) {
    target.innerHTML =
      '<div class="terminalEmpty small">Live session change feed unavailable. NOMAD will not display false zero breadth.</div>';
    return;
  }

  target.innerHTML =
    '<div class="breadthCounts">' +
    '<div class="breadthStat"><span>Advancers</span><strong class="positive">' +
    formatNumber(
      breadth.advancers || 0,
      0
    ) +
    '</strong></div>' +
    '<div class="breadthStat"><span>Decliners</span><strong class="negative">' +
    formatNumber(
      breadth.decliners || 0,
      0
    ) +
    '</strong></div>' +
    '<div class="breadthStat"><span>Flat</span><strong>' +
    formatNumber(
      breadth.unchanged || 0,
      0
    ) +
    '</strong></div>' +
    '</div>' +
    (
      pulse?.sessionChangeSource
        ? '<div class="sourceNote">Source: Official PSX Data Portal · Main Board ordinary equities · ' +
          formatNumber(
            pulse?.sessionChangeRows || 0,
            0
          ) +
          ' securities' +
          (
            pulse?.asOf
              ? ' · ' +
                escapeHtml(
                  relativeTime(
                    pulse.asOf
                  )
                )
              : ''
          ) +
          ' · canonical market facts</div>'
        : ''
    );
}

function portfolioMoney(
  value
) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return 'N/A';
  }

  return 'PKR ' +
    formatNumber(
      number,
      0
    );
}


function portfolioViewClass(
  value
) {
  return String(
    value ||
    'monitor'
  )
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      '_'
    );
}

function renderPortfolioFull(
  result,
  targetId = 'portfolioFull'
) {
  const target =
    $(targetId);

  if (!target) {
    return;
  }

  if (!result?.configured) {
    target.innerHTML =
      '<div class="terminalCard"><div class="terminalEmpty">Portfolio storage is not set up yet. Run the portfolio foundation SQL migration in Supabase.</div></div>';
    return;
  }

  const holdings =
    Array.isArray(
      result.holdings
    )
      ? result.holdings
      : [];

  const summary =
    result.summary ||
    {};

  const health =
    result.health ||
    {};

  const transactions =
    Array.isArray(
      result.transactions
    )
      ? result.transactions
      : [];

  let html =
    '<div class="portfolioLiveStrip"><div><strong>Portfolio mirror</strong> · ' +
    (
      result.asOf
        ? 'PSX prices ' +
          escapeHtml(
            relativeTime(
              result.asOf
            )
          )
        : 'latest available PSX prices'
    ) +
    '</div><div>' +
    (
      result.ledgerConfigured
        ? 'Transaction ledger active · ' +
          formatNumber(
            summary.transactionCount ||
            0,
            0
          ) +
          ' records'
        : 'Holdings-only mode · run the 0.8.5A ledger migration to record buys/sells/dividends'
    ) +
    '</div></div>' +
    '<div class="portfolioSummaryStrip">' +
    '<div class="portfolioMetric"><span>Market value</span><strong>' +
    portfolioMoney(
      summary.currentValue
    ) +
    '</strong></div>' +
    '<div class="portfolioMetric"><span>Open cost basis</span><strong>' +
    portfolioMoney(
      summary.investedCost
    ) +
    '</strong></div>' +
    '<div class="portfolioMetric"><span>Today</span><strong class="' +
    percentClass(
      summary.dayPnlPct
    ) +
    '">' +
    portfolioMoney(
      summary.dayPnl
    ) +
    ' · ' +
    (
      Number(
        summary.dayPnlPct
      ) > 0
        ? '+'
        : ''
    ) +
    formatNumber(
      summary.dayPnlPct,
      2
    ) +
    '%</strong></div>' +
    '<div class="portfolioMetric"><span>Unrealized P&amp;L</span><strong class="' +
    percentClass(
      summary.totalPnlPct
    ) +
    '">' +
    portfolioMoney(
      summary.totalPnl
    ) +
    ' · ' +
    (
      Number(
        summary.totalPnlPct
      ) > 0
        ? '+'
        : ''
    ) +
    formatNumber(
      summary.totalPnlPct,
      2
    ) +
    '%</strong></div>' +
    '<div class="portfolioMetric"><span>Realized P&amp;L</span><strong class="' +
    percentClass(
      summary.realizedPnl
    ) +
    '">' +
    portfolioMoney(
      summary.realizedPnl
    ) +
    '</strong></div>' +
    '<div class="portfolioMetric"><span>Dividends logged</span><strong>' +
    portfolioMoney(
      summary.dividends
    ) +
    '</strong></div>' +
    '</div>';

  if (!holdings.length) {
    html +=
      '<div class="terminalCard"><div class="terminalEmpty"><strong>No open positions yet.</strong><br>Use Record trade for new buys, or Opening holding if you want to start NOMAD from an existing portfolio without entering historical transactions.</div></div>';
  } else {
    html +=
      '<div class="portfolioDashboardGrid">' +
      '<div class="terminalCard"><div class="panelHeader"><div><div class="eyebrow">LIVE POSITIONS</div><h2>What you own now</h2></div><span class="boardCount">' +
      formatNumber(
        holdings.length,
        0
      ) +
      '</span></div>' +
      '<div class="portfolioTableScroller"><div class="portfolioPositionHeader"><div>Symbol</div><div>Company</div><div>Qty</div><div>Avg cost</div><div>Live</div><div>Value</div><div>Total P&amp;L</div><div>Weight</div><div>NOMAD</div></div>' +
      holdings.map(
        item =>
          '<div class="portfolioPositionRow">' +
          '<div><strong>' +
          escapeHtml(
            item.symbol
          ) +
          '</strong></div>' +
          '<div><div class="portfolioPositionName">' +
          escapeHtml(
            item.companyName ||
            item.symbol
          ) +
          '</div><div class="decisionMinor">' +
          escapeHtml(
            item.sector ||
            'Unknown'
          ) +
          '</div></div>' +
          '<div>' +
          formatNumber(
            item.quantity,
            2
          ) +
          '</div>' +
          '<div>PKR ' +
          formatNumber(
            item.averageCost,
            2
          ) +
          '</div>' +
          '<div>PKR ' +
          formatNumber(
            item.currentPrice,
            2
          ) +
          '<div class="' +
          percentClass(
            item.dayChangePct
          ) +
          '">' +
          (
            Number(
              item.dayChangePct
            ) > 0
              ? '+'
              : ''
          ) +
          formatNumber(
            item.dayChangePct,
            2
          ) +
          '%</div></div>' +
          '<div>' +
          portfolioMoney(
            item.currentValue
          ) +
          '</div>' +
          '<div class="' +
          percentClass(
            item.totalPnlPct
          ) +
          '">' +
          portfolioMoney(
            item.totalPnl
          ) +
          '<div>' +
          (
            Number(
              item.totalPnlPct
            ) > 0
              ? '+'
              : ''
          ) +
          formatNumber(
            item.totalPnlPct,
            2
          ) +
          '%</div></div>' +
          '<div>' +
          formatNumber(
            item.weightPct,
            1
          ) +
          '%</div>' +
          '<div><span class="portfolioViewTag ' +
          portfolioViewClass(
            item.nomadView
          ) +
          '">' +
          escapeHtml(
            decisionActionLabel(
              item.nomadView
            )
          ) +
          '</span><div class="decisionMinor">' +
          escapeHtml(
            item.historicalContext
              ?.condition ||
            'Context pending'
          ) +
          '</div></div>' +
          '</div>'
      ).join('') +
      '</div></div>' +
      '<div class="terminalCard"><div class="panelHeader"><div><div class="eyebrow">PORTFOLIO HEALTH</div><h2>Exposure &amp; concentration</h2></div></div>' +
      '<div class="portfolioHealthGrid">' +
      '<div class="portfolioHealthMetric"><span>Health</span><strong>' +
      escapeHtml(
        health.state ||
        'N/A'
      ) +
      '</strong></div>' +
      '<div class="portfolioHealthMetric"><span>Concentration</span><strong>' +
      escapeHtml(
        health.concentration ||
        'N/A'
      ) +
      '</strong></div>' +
      '<div class="portfolioHealthMetric"><span>Largest stock</span><strong>' +
      escapeHtml(
        health.largestPositionSymbol ||
        'N/A'
      ) +
      (
        health.largestPositionPct !==
          null &&
        health.largestPositionPct !==
          undefined
          ? ' · ' +
            formatNumber(
              health.largestPositionPct,
              1
            ) +
            '%'
          : ''
      ) +
      '</strong></div>' +
      '<div class="portfolioHealthMetric"><span>Largest sector</span><strong>' +
      escapeHtml(
        health.largestSector ||
        'N/A'
      ) +
      (
        health.largestSectorPct !==
          null &&
        health.largestSectorPct !==
          undefined
          ? ' · ' +
            formatNumber(
              health.largestSectorPct,
              1
            ) +
            '%'
          : ''
      ) +
      '</strong></div>' +
      '</div>' +
      '<div class="portfolioSectorList">' +
      (health.sectors || [])
        .slice(0, 8)
        .map(
          item =>
            '<div class="portfolioSectorRow"><div><strong>' +
            escapeHtml(
              item.sector
            ) +
            '</strong><div class="portfolioSectorTrack"><div class="portfolioSectorFill" style="width:' +
            Math.max(
              0,
              Math.min(
                100,
                Number(
                  item.weightPct
                ) ||
                0
              )
            ) +
            '%"></div></div></div><div>' +
            formatNumber(
              item.weightPct,
              1
            ) +
            '%</div></div>'
        )
        .join('') +
      '</div></div>' +
      '</div>';
  }

  html +=
    '<div class="terminalCard"><div class="panelHeader"><div><div class="eyebrow">TRANSACTION LEDGER</div><h2>Recent activity</h2></div><span class="boardCount">' +
    formatNumber(
      summary.transactionCount ||
      0,
      0
    ) +
    '</span></div>';

  if (!result.ledgerConfigured) {
    html +=
      '<div class="terminalEmpty small">Transaction tracking is not enabled yet. Your existing holdings still work. Run the 0.8.5A portfolio ledger migration when you are ready to record every buy, sell and dividend.</div>';
  } else if (!transactions.length) {
    html +=
      '<div class="terminalEmpty small">No transactions recorded yet. Use <strong>Record trade</strong> after you execute a trade with your broker.</div>';
  } else {
    html +=
      '<div class="transactionList">' +
      transactions.map(
        item => {
          const side =
            String(
              item.side ||
              ''
            ).toUpperCase();

          const detail =
            side === 'DIVIDEND'
              ? portfolioMoney(
                  item.cash_amount
                )
              : formatNumber(
                  item.quantity,
                  2
                ) +
                ' @ PKR ' +
                formatNumber(
                  item.price,
                  2
                );

          return (
            '<div class="transactionRow">' +
            '<div>' +
            escapeHtml(
              item.trade_date ||
              ''
            ) +
            '</div>' +
            '<div><strong>' +
            escapeHtml(
              item.symbol ||
              ''
            ) +
            '</strong></div>' +
            '<div><span class="transactionSideTag ' +
            portfolioViewClass(
              side
            ) +
            '">' +
            escapeHtml(
              side
            ) +
            '</span></div>' +
            '<div>' +
            escapeHtml(
              detail
            ) +
            '</div>' +
            '<div>' +
            (
              Number(
                item.fees
              ) > 0
                ? 'Fees ' +
                  portfolioMoney(
                    item.fees
                  )
                : ''
            ) +
            '</div>' +
            '<div>' +
            (
              side !== 'OPENING'
                ? '<button class="miniButton secondary deleteTransaction" data-delete-transaction="' +
                  escapeHtml(
                    item.id
                  ) +
                  '">Delete</button>'
                : '<span class="decisionMinor">Opening</span>'
            ) +
            '</div>' +
            '</div>'
          );
        }
      ).join('') +
      '</div>';
  }

  html +=
    '<div class="sourceNote">Live values use NOMAD\\'s latest PSX market snapshot. Portfolio P&amp;L is calculated from the prices and transactions you record; it is not a broker statement. Decision Center now considers your existing position and sector exposure before allocating new money.</div>' +
    '</div>';

  target.innerHTML =
    html;

  target
    .querySelectorAll(
      '[data-delete-transaction]'
    )
    .forEach(
      button => {
        button.onclick =
          async () => {
            const id =
              button.dataset
                .deleteTransaction;

            if (
              !id ||
              !confirm(
                'Delete this portfolio transaction? NOMAD will rebuild the position from the remaining ledger.'
              )
            ) {
              return;
            }

            button.disabled =
              true;

            try {
              await apiPost(
                'portfolio-transaction-delete',
                { id }
              );

              await loadPortfolioViews();
            } catch (error) {
              alert(
                error.message
              );
            } finally {
              button.disabled =
                false;
            }
          };
      }
    );
}

function renderPortfolioSnapshot(
  result,
  targetId = 'portfolioHome',
  full = false
) {
  const target =
    $(targetId);

  if (!target) {
    return;
  }

  if (full) {
    renderPortfolioFull(
      result,
      targetId
    );
    return;
  }

  if (!result?.configured) {
    target.innerHTML =
      '<div class="terminalEmpty">Portfolio storage is not set up yet. Run the portfolio foundation SQL migration in Supabase.</div>';
    return;
  }

  const holdings =
    Array.isArray(
      result.holdings
    )
      ? result.holdings
      : [];

  if (!holdings.length) {
    target.innerHTML =
      '<div class="terminalEmpty">' +
      '<strong>No holdings added yet.</strong><br>' +
      'Add the shares you already own and NOMAD will prioritize them for performance, historical weakness and future event monitoring.' +
      '</div>';
    return;
  }

  const summary =
    result.summary ||
    {};

  const totalClass =
    percentClass(
      summary.totalPnlPct
    );

  const dayClass =
    percentClass(
      summary.dayPnlPct
    );

  let html =
    '<div class="portfolioSummaryStrip">' +
    '<div class="portfolioMetric"><span>Value</span><strong>' +
    portfolioMoney(
      summary.currentValue
    ) +
    '</strong></div>' +
    '<div class="portfolioMetric"><span>Today / session</span><strong class="' +
    dayClass +
    '">' +
    portfolioMoney(
      summary.dayPnl
    ) +
    ' · ' +
    (
      Number(
        summary.dayPnlPct
      ) > 0
        ? '+'
        : ''
    ) +
    formatNumber(
      summary.dayPnlPct,
      2
    ) +
    '%</strong></div>' +
    '<div class="portfolioMetric"><span>Total P&amp;L</span><strong class="' +
    totalClass +
    '">' +
    portfolioMoney(
      summary.totalPnl
    ) +
    ' · ' +
    (
      Number(
        summary.totalPnlPct
      ) > 0
        ? '+'
        : ''
    ) +
    formatNumber(
      summary.totalPnlPct,
      2
    ) +
    '%</strong></div>' +
    '<div class="portfolioMetric"><span>Holdings</span><strong>' +
    formatNumber(
      summary.holdings,
      0
    ) +
    '</strong></div>' +
    '</div>' +
    '<div class="portfolioRows">';

  const rows =
    full
      ? holdings
      : holdings.slice(0, 5);

  html +=
    rows
      .map(
        item => {
          const context =
            item.historicalContext ||
            {};

          const condition =
            String(
              context.condition ||
              'Context pending'
            );

          return (
            '<div class="portfolioRow ' +
            (
              full
                ? 'fullRow'
                : ''
            ) +
            '">' +
            '<div><div class="symbolName">' +
            escapeHtml(
              item.symbol
            ) +
            '</div></div>' +
            '<div><div class="companyMini">' +
            escapeHtml(
              item.companyName ||
              item.symbol
            ) +
            '</div><span class="conditionTag ' +
            escapeHtml(
              condition.toLowerCase()
            ) +
            '">' +
            escapeHtml(
              condition
            ) +
            (
              context.returns?.m1 !==
                null &&
              context.returns?.m1 !==
                undefined
                ? ' · 1M ' +
                  (
                    Number(
                      context.returns.m1
                    ) > 0
                      ? '+'
                      : ''
                  ) +
                  formatNumber(
                    context.returns.m1,
                    1
                  ) +
                  '%'
                : ''
            ) +
            '</span></div>' +
            '<div class="hideMobile">' +
            formatNumber(
              item.quantity,
              2
            ) +
            ' sh</div>' +
            '<div class="hideMobile">PKR ' +
            formatNumber(
              item.currentPrice,
              2
            ) +
            '</div>' +
            '<div class="' +
            percentClass(
              item.totalPnlPct
            ) +
            '">' +
            (
              Number(
                item.totalPnlPct
              ) > 0
                ? '+'
                : ''
            ) +
            formatNumber(
              item.totalPnlPct,
              1
            ) +
            '%</div>' +
            (
              full
                ? (
                    '<button class="miniButton secondary removeHolding" data-remove-holding="' +
                    escapeHtml(
                      item.symbol
                    ) +
                    '">Remove</button>'
                  )
                : ''
            ) +
            '</div>'
          );
        }
      )
      .join('');

  html +=
    '</div>';

  if (!full) {
    html +=
      '<button class="quickAction" data-open-page="portfolio">Open full portfolio <span>→</span></button>';
  } else {
    html +=
      '<div class="sourceNote">Portfolio values use the latest available PSX market snapshot. Historical condition uses daily price history; it is not a Buy/Sell recommendation.</div>';
  }

  target.innerHTML =
    html;

  target
    .querySelectorAll(
      '[data-open-page]'
    )
    .forEach(
      button => {
        button.onclick =
          () =>
            openAppPage(
              button.dataset.openPage
            );
      }
    );

  target
    .querySelectorAll(
      '[data-remove-holding]'
    )
    .forEach(
      button => {
        button.onclick =
          async () => {
            const symbol =
              button.dataset
                .removeHolding;

            if (!symbol) {
              return;
            }

            if (
              !confirm(
                'Remove ' +
                symbol +
                ' from your NOMAD portfolio?'
              )
            ) {
              return;
            }

            button.disabled =
              true;

            try {
              await apiPost(
                'portfolio-delete',
                { symbol }
              );

              await loadDecisionCenter();
            } catch (error) {
              alert(
                error.message
              );
            } finally {
              button.disabled =
                false;
            }
          };
      }
    );
}

async function loadPortfolioViews() {
  try {
    const result =
      await api(
        'portfolio'
      );

    renderPortfolioSnapshot(
      result,
      'portfolioHome',
      false
    );

    renderPortfolioSnapshot(
      result,
      'portfolioFull',
      true
    );

    if ($('homePortfolioCount')) {
      const count =
        result?.summary?.holdings ||
        0;

      $('homePortfolioCount')
        .textContent =
          count
            ? count +
              (
                count === 1
                  ? ' holding'
                  : ' holdings'
              )
            : 'Not added';
    }

    return result;
  } catch (error) {
    const message =
      escapeHtml(
        error.message
      );

    if ($('portfolioHome')) {
      $('portfolioHome')
        .innerHTML =
          '<div class="terminalEmpty">' +
          message +
          '</div>';
    }

    if ($('portfolioFull')) {
      $('portfolioFull')
        .innerHTML =
          '<div class="terminalCard"><div class="terminalEmpty">' +
          message +
          '</div></div>';
    }

    return null;
  }
}

async function loadDecisionCenter() {
  try {
    const result =
      await api(
        'intelligence-feed'
      );

    const coverage =
      Number(
        result.stateCoverage || 0
      );

    const historicalCoverage =
      Number(
        result.historicalContextCoverage ||
        0
      );

    const total =
      Number(
        result.coreUniverse || 0
      );

    if ($('homeStateCoverage')) {
      $('homeStateCoverage')
        .textContent =
          formatNumber(
            coverage,
            0
          ) +
          ' / ' +
          formatNumber(
            total,
            0
          );
    }

    if ($('homeHistoryCoverage')) {
      $('homeHistoryCoverage')
        .textContent =
          formatNumber(
            historicalCoverage,
            0
          ) +
          ' / ' +
          formatNumber(
            total,
            0
          );
    }

    if (result.latestRun) {
      const run =
        result.latestRun;

      if ($('homeLastScan')) {
        $('homeLastScan')
          .textContent =
            run.status ===
              'completed'
              ? relativeTime(
                  run.completed_at ||
                  run.started_at
                )
              : String(
                  run.status ||
                  'Unknown'
                );
      }

      if ($('homeLastScanMeta')) {
        $('homeLastScanMeta')
          .textContent =
            formatNumber(
              run.securities_processed || 0,
              0
            ) +
            ' securities checked · ' +
            formatNumber(
              run.changes_detected || 0,
              0
            ) +
            ' changes recorded';
      }
    }

    renderAttentionFeed(
      result.attention || []
    );

    const pulse =
      result.marketPulse ||
      null;

    renderMoverList(
      'topGainers',
      pulse?.gainers || []
    );

    renderMoverList(
      'topLosers',
      pulse?.losers || []
    );

    renderMarketBreadth(
      pulse
    );

    if ($('homeMarketState')) {
      const status =
        pulse?.marketStatus;

      $('homeMarketState')
        .textContent =
          status?.known
            ? (
                status.isOpen
                  ? 'PSX market open'
                  : 'PSX ' +
                    marketClosedLabel(
                      status
                    ).replace(
                      /^Market/,
                      'market'
                    )
              )
            : 'Latest PSX session snapshot';
    }

    if ($('homeMarketAsOf')) {
      $('homeMarketAsOf')
        .textContent =
          pulse?.asOf
            ? 'Updated ' +
              relativeTime(
                pulse.asOf
              )
            : 'Latest available PSX snapshot';
    }

    const sessionLabel =
      pulse?.marketStatus?.known &&
      pulse.marketStatus.isOpen
        ? 'Top 5 today'
        : 'Top 5 last session';

    if ($('gainersTitle')) {
      $('gainersTitle')
        .textContent =
          sessionLabel.replace(
            'Top 5',
            'Top 5 gainers'
          );
    }

    if ($('losersTitle')) {
      $('losersTitle')
        .textContent =
          sessionLabel.replace(
            'Top 5',
            'Top 5 losers'
          );
    }

    if ($('scannerScheduleState')) {
      $('scannerScheduleState')
        .textContent =
          result.scannerSecretConfigured
            ? 'Ready to schedule'
            : 'Secret not configured';
    }
  } catch (error) {
    if ($('attentionFeed')) {
      $('attentionFeed')
        .innerHTML =
          '<div class="terminalEmpty">' +
          escapeHtml(
            error.message
          ) +
          '</div>';
    }
  }

  await loadPortfolioViews();
}

async function runDecisionScanner(
  outputId
) {
  const output =
    $(outputId);

  if (output) {
    output.textContent =
      'Scanning the core equity universe...';
  }

  try {
    const result =
      await api(
        'intelligence-scan'
      );

    if (output) {
      output.innerHTML =
        '<strong>Scan complete.</strong> ' +
        formatNumber(
          result.securitiesProcessed,
          0
        ) +
        ' core equities checked; ' +
        formatNumber(
          result.firstBaselines,
          0
        ) +
        ' new baselines; ' +
        formatNumber(
          result.changesDetected,
          0
        ) +
        ' material changes recorded; ' +
        formatNumber(
          result.historicalContextsUpdated || 0,
          0
        ) +
        ' historical situations refreshed.';
    }

    await loadDecisionCenter();
  } catch (error) {
    if (output) {
      output.textContent =
        error.message;
    }
  }
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
  const number =
    Number(value);

  const minimum =
    Number(low);

  const maximum =
    Number(high);

  if (
    !Number.isFinite(
      number
    ) ||
    !Number.isFinite(
      minimum
    ) ||
    !Number.isFinite(
      maximum
    ) ||
    maximum <=
      minimum
  ) {
    return 50;
  }

  return clamp(
    (
      (
        number -
        minimum
      ) /
      (
        maximum -
        minimum
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
    escapeHtml(
      title
    ) +
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
    formatNumber(
      low
    ) +
    '</span>' +

    '<span>High PKR ' +
    formatNumber(
      high
    ) +
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
    escapeHtml(
      label
    ) +
    '</div>' +

    '<div class="metricValue">' +
    value +
    '</div>' +

    (
      sub
        ? (
            '<div class="metricSub">' +
            escapeHtml(
              sub
            ) +
            '</div>'
          )
        : ''
    ) +

    '</div>'
  );
}

function statusHelpText(
  code
) {
  const normalized =
    String(
      code || ''
    )
      .trim()
      .toUpperCase();

  const known = {
    NC:
      'Non-Compliant Segment - a PSX regulatory/listing status. This is not a Shariah-compliance label.',

    XD:
      'Ex-Dividend - the security is trading after the entitlement date for the relevant cash dividend.',

    XB:
      'Ex-Bonus - the security is trading after the entitlement date for the relevant bonus shares.',

    XR:
      'Ex-Right - the security is trading after the entitlement date for the relevant rights issue.'
  };

  return (
    known[normalized] ||
    'PSX market-status / ex-entitlement marker. NOMAD keeps this separate from the permanent company ticker.'
  );
}

function statusPills(
  codes
) {
  const list =
    Array.isArray(
      codes
    )
      ? codes
      : [];

  return list
    .map(
      code => {
        const help =
          statusHelpText(
            code
          );

        return (
          '<span class="statusPill" tabindex="0" title="' +
          escapeHtml(
            help
          ) +
          '" data-help="' +
          escapeHtml(
            help
          ) +
          '" aria-label="' +
          escapeHtml(
            String(code) +
            ': ' +
            help
          ) +
          '">' +
          escapeHtml(
            code
          ) +
          '</span>'
        );
      }
    )
    .join('');
}


function identityNote(
  identity
) {
  if (
    !identity ||
    !identity.normalized
  ) {
    return '';
  }

  const canonical =
    identity.canonicalSymbol ||
    '';

  const trading =
    identity.tradingSymbol ||
    '';

  if (
    !canonical ||
    !trading ||
    canonical ===
      trading
  ) {
    return '';
  }

  return (
    '<div class="sourceNote">' +
    'Canonical company symbol: ' +
    '<strong>' +
    escapeHtml(
      canonical
    ) +
    '</strong>' +
    ' &bull; Current market symbol: ' +
    '<strong>' +
    escapeHtml(
      trading
    ) +
    '</strong>' +
    '</div>'
  );
}

/* =========================================================
   COMPANY HEADER
========================================================= */

function showSelectedCompany(
  symbol
) {
  const stock =
    marketRows.find(
      row =>
        row.symbol ===
          symbol ||
        row.tradingSymbol ===
          symbol ||
        row.rawSymbol ===
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

      '<div class="identityLine">' +

      '<span>' +
      escapeHtml(
        stock.symbol
      ) +
      ' &bull; ' +
      escapeHtml(
        stock.sector
      ) +
      '</span>' +

      statusPills(
        stock.statusCodes
      ) +

      '</div>';
}

function updateSelectedCompany(
  result
) {
  if (
    !result?.company?.name
  ) {
    return;
  }

  const identity =
    result.identity ||
    {};

  $('selectedCompany')
    .innerHTML =
      '<strong>' +
      escapeHtml(
        result.company.name
      ) +
      '</strong>' +

      '<div class="identityLine">' +

      '<span>' +
      escapeHtml(
        result.symbol
      ) +

      (
        result.company.sector
          ? (
              ' &bull; ' +
              escapeHtml(
                result.company.sector
              )
            )
          : ''
      ) +

      '</span>' +

      statusPills(
        identity.statusCodes
      ) +

      '</div>';
}

/* =========================================================
   OVERVIEW
========================================================= */

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
      decision?.previousClose
    );

  let change =
    finiteNumber(
      decision?.dayChange
    );

  let pct =
    finiteNumber(
      decision?.dayChangePct
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
    decision.session ||
    live?.session ||
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
      ? live.marketStatus.isOpen
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
    averageVolume !==
      null &&
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
      : '';

  let html =
    identityNote(
      result.identity
    ) +

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
      decision.priceTimestamp
        ? (
            ' &bull; ' +
            escapeHtml(
              formatDateTime(
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

    '<div class="sourceNote">' +

    (
      decision.sessionSource
        ? (
            'Session statistics: ' +
            escapeHtml(
              decision
                .sessionSource
            ) +
            '.'
          )
        : ''
    ) +

    '</div>' +

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
      decision.range52?.low,
      decision.range52?.high,
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

/* =========================================================
   MORE
========================================================= */

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
        decision.marketCapSource ===
          'estimated'
          ? 'Estimated market cap'
          : 'Market cap',

        formatCompactPKR(
          decision
            .marketCapPkr
        ),

        decision.marketCapSource ===
          'estimated'
          ? 'Latest price × shares outstanding'
          : 'PSX / connected source'
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
    identityNote(
      result.identity
    ) +

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
          'No additional reliable market fields are available for this symbol.' +
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
          canonicalSymbol:
            result.identity
              ?.canonicalSymbol ||
            result.symbol,

          marketSymbol:
            result.identity
              ?.tradingSymbol ||
            result.symbol,

          rawMarketSymbol:
            result.identity
              ?.rawMarketSymbol ||
            null,

          statusCodes:
            result.identity
              ?.statusCodes ||
            [],

          quoteProvider:
            'psxdata-api',

          quoteProviderSymbol:
            result.quoteProviderSymbol ||
            null,

          intradayProvider:
            result.live
              ? 'pyPSX'
              : null,

          intradayProviderSymbol:
            result.live
              ?.providerSymbol ||
            null,

          companyProvider:
            result.official
              ? 'PSX Data Portal'
              : null,

          sessionSource:
            decision.sessionSource ||
            null,

          marketCapSource:
            decision.marketCapSource ||
            null,

          quoteTimestamp:
            result.meta?.timestamp ||
            null,

          liveTimestamp:
            result.live?.timestamp ||
            null,

          companyFetchedAt:
            result.official
              ?.fetchedAt ||
            null,

          companySourceUrl:
            result.official
              ?.sourceUrl ||
            null
        },
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

/* =========================================================
   LIVE REFRESH
========================================================= */

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

  const marketClosed =
    Boolean(
      result?.marketStatus?.known &&
      !result.marketStatus.isOpen
    );

  if (marketClosed) {
    $('liveStatus')
      .innerHTML =
        '<span class="feedDot closed"></span>' +
        '<span class="feedPrice">' +
        escapeHtml(
          marketClosedLabel(
            result.marketStatus
          )
        ) +
        '</span>' +
        '<span class="feedMeta">Last market price PKR ' +
        formatNumber(
          result.price
        ) +
        ' · Updated ' +
        escapeHtml(
          formatDateTime(
            result.timestamp
          )
        ) +
        '</span>';

    return;
  }

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
      '</span>';
}

function shouldAutoRefresh(
  result
) {
  return Boolean(
    result?.marketStatus?.known &&
    result?.marketStatus?.isOpen
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
  }

  liveRefreshTimer =
    null;

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
          result.symbol
      ) {
        lastQuoteResult.live =
          result;

        if (
          result.marketStatus
            ?.isOpen
        ) {
          lastQuoteResult
            .decision
            .session =
              result.session;

          lastQuoteResult
            .decision
            .sessionSource =
              'pyPSX';

          lastQuoteResult
            .decision
            .price =
              result.price;

          lastQuoteResult
            .decision
            .priceTimestamp =
              result.timestamp;
        }

        renderDecisionOverview(
          lastQuoteResult
        );
      }
    }

    return result;
  } catch (error) {
    if (
      !silent
    ) {
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

  if (
    result
  ) {
    renderFeedStatus(
      result
    );
  } else {
    result =
      await refreshLiveOverview(
        symbol
      );
  }

  if (
    result
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

/* =========================================================
   LIVE CHART
========================================================= */

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
      '<div class="emptyState">' +
      'Not enough intraday data.' +
      '</div>'
    );
  }

  const width = 1000;
  const height = 410;
  const left = 65;
  const right = 20;
  const top = 20;
  const priceHeight = 265;

  const usableWidth =
    width -
    left -
    right;

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

  const margin =
    Math.max(
      (
        max -
        min
      ) *
      .08,

      max *
      .002
    );

  min -= margin;
  max += margin;

  const x =
    index =>
      left +
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
      top +
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
    rows.map(
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
    top +
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

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Intraday line + volume' +
    '</div>' +

    '<svg class="candleChart" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    buildPriceGrid(
      min,
      max,
      width,
      left,
      right,
      top,
      priceHeight
    ) +

    '<polygon points="' +
    areaPoints +
    '" class="chartArea" />' +

    '<polyline points="' +
    points +
    '" class="chartLine" />' +

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
      '<div class="emptyState">' +
      'Not enough intraday data.' +
      '</div>'
    );
  }

  const width = 1000;
  const height = 430;
  const left = 65;
  const right = 20;
  const top = 20;
  const priceHeight = 275;
  const volumeTop = 322;
  const volumeHeight = 64;

  const usableWidth =
    width -
    left -
    right;

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

        const high =
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

        const low =
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

  const margin =
    Math.max(
      (
        max -
        min
      ) *
      .06,

      max *
      .0015
    );

  min -= margin;
  max += margin;

  const y =
    price =>
      top +
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
        step *
        .68
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

  const candles =
    normalized.map(
      (
        row,
        index
      ) => {
        const centerX =
          left +
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

        const candleClass =
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

        return (
          '<g>' +

          '<title>' +
          escapeHtml(
            formatTime(
              row.timestamp
            ) +
            ' | O ' +
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
            ' | Volume ' +
            formatNumber(
              row.volume,
              0
            )
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
          candleClass +
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
          candleClass +
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

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Intraday candlesticks + volume - 1-minute candles' +
    '</div>' +

    '<div class="chartLegend">' +

    '<span>' +
    '<span class="legendSwatch up"></span>' +
    'Close ≥ open' +
    '</span>' +

    '<span>' +
    '<span class="legendSwatch down"></span>' +
    'Close < open' +
    '</span>' +

    '<span>' +
    'Hover for OHLCV' +
    '</span>' +

    '</div>' +

    '<svg class="candleChart" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    buildPriceGrid(
      min,
      max,
      width,
      left,
      right,
      top,
      priceHeight
    ) +

    '<line x1="' +
    left +
    '" x2="' +
    (
      width -
      right
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

    candles +

    '<text x="5" y="' +
    (
      volumeTop +
      12
    ) +
    '" class="chartLabel">' +
    'Vol' +
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
            liveChartMode =
              button.dataset
                .mode;

            if (
              lastLiveChartResult
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

  const selectedStock =
    marketRows.find(
      row =>
        row.symbol ===
        result.symbol
    );

  if (
    selectedStock
  ) {
    updateSelectedCompany(
      {
        symbol:
          result.symbol,

        identity:
          result.identity,

        company: {
          name:
            selectedStock.companyName,

          sector:
            selectedStock.sector
        }
      }
    );
  }

  const stateNote =
    result.feedState ===
      'LIVE'
      ? 'Market open - refreshing every 15 seconds'
      : result.feedState ===
        'DELAYED'
        ? 'Market open, but latest candle is delayed'
        : marketClosedLabel(
            result.marketStatus
          ) +
          ' - showing latest trading session';

  const chart =
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
      identityNote(
        result.identity
      ) +

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

      (
        result.providerSymbol
          ? (
              ' &bull; feed symbol ' +
              escapeHtml(
                result.providerSymbol
              )
            )
          : ''
      ) +

      '</div>' +

      '</div>' +

      '<div class="chartModeToggle">' +

      '<button class="chartModeButton ' +
      (
        liveChartMode ===
          'candles'
          ? 'active'
          : ''
      ) +
      '" data-mode="candles">' +
      'Candles' +
      '</button>' +

      '<button class="chartModeButton ' +
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
          result.session?.open
        )
      ) +

      metricCard(
        'Session high',
        'PKR ' +
        formatNumber(
          result.session?.high
        )
      ) +

      metricCard(
        'Session low',
        'PKR ' +
        formatNumber(
          result.session?.low
        )
      ) +

      metricCard(
        'Session volume',
        formatNumber(
          result.session?.volume,
          0
        )
      ) +

      '</div>' +

      chart;

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
    }

    return result;
  } catch (error) {
    if (
      !silent
    ) {
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
    result
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

/* =========================================================
   MARKET TABLE
========================================================= */

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
      stock =>
        (
          stock.symbol +
          ' ' +
          stock.tradingSymbol +
          ' ' +
          stock.rawSymbol +
          ' ' +
          (
            stock.statusCodes ||
            []
          ).join(' ') +
          ' ' +
          stock.companyName +
          ' ' +
          stock.sector
        )
          .toLowerCase()
          .includes(
            query
          ) &&
        (
          !sector ||
          stock.sector ===
            sector
        )
    );

  rows =
    [...rows];

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

    case 'dayChangeDesc':
      rows.sort(
        (
          a,
          b
        ) =>
          (
            b.dayChangePct ??
            -Infinity
          ) -
          (
            a.dayChangePct ??
            -Infinity
          )
      );
      break;

    case 'dayChangeAsc':
      rows.sort(
        (
          a,
          b
        ) =>
          (
            a.dayChangePct ??
            Infinity
          ) -
          (
            b.dayChangePct ??
            Infinity
          )
      );
      break;

    case 'sessionVolumeDesc':
      rows.sort(
        (
          a,
          b
        ) =>
          (
            b.sessionVolume ??
            -Infinity
          ) -
          (
            a.sessionVolume ??
            -Infinity
          )
      );
      break;

    case 'marketCapDesc':
      rows.sort(
        (
          a,
          b
        ) =>
          (
            b.marketCap ??
            -Infinity
          ) -
          (
            a.marketCap ??
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
              row.peRatio > 0
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
        '';

    return;
  }

  $('stocks')
    .innerHTML =
      '<table class="exploreTable">' +

      '<thead>' +

      '<tr>' +

      '<th>Symbol</th>' +
      '<th>Company</th>' +
      '<th>Price</th>' +
      '<th>Today</th>' +
      '<th>Volume</th>' +
      '<th>P/E</th>' +
      '<th>Div Yield</th>' +
      '<th>1Y</th>' +

      '</tr>' +

      '</thead>' +

      '<tbody>' +

      pageRows.map(
        stock => {
          const differentMarketSymbol =
            stock.tradingSymbol &&
            stock.tradingSymbol !==
              stock.symbol;

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

            (
              stock.statusCodes
                ?.length
                ? (
                    ' ' +
                    statusPills(
                      stock.statusCodes
                    )
                  )
                : ''
            ) +

            (
              differentMarketSymbol
                ? (
                    '<span class="symbolSub">' +
                    'Market: ' +
                    escapeHtml(
                      stock.tradingSymbol
                    ) +
                    '</span>'
                  )
                : ''
            ) +

            '</td>' +

            '<td class="company">' +
            escapeHtml(
              stock.companyName
            ) +
            '</td>' +

            '<td class="' +
            (
              explorePreviousPrices.has(
                stock.symbol
              ) &&
              Number(stock.price) >
                Number(
                  explorePreviousPrices.get(
                    stock.symbol
                  )
                )
                ? 'positive livePriceUp'
                : explorePreviousPrices.has(
                    stock.symbol
                  ) &&
                  Number(stock.price) <
                    Number(
                      explorePreviousPrices.get(
                        stock.symbol
                      )
                    )
                  ? 'negative livePriceDown'
                  : ''
            ) +
            '">PKR ' +
            formatNumber(
              stock.price
            ) +
            '</td>' +

            '<td class="' +
            percentClass(
              stock.dayChangePct
            ) +
            '">' +
            (
              stock.dayChangePct === null ||
              stock.dayChangePct === undefined
                ? '—'
                : formatPercent(
                    stock.dayChangePct
                  )
            ) +
            '</td>' +

            '<td class="volumeCell">' +
            '<span class="metricPrimary">' +
            (
              stock.sessionVolume === null ||
              stock.sessionVolume === undefined
                ? '—'
                : formatCompactNumber(
                    stock.sessionVolume
                  )
            ) +
            '</span>' +
            '<span class="metricSecondary">30D ' +
            (
              stock.averageVolume30d === null ||
              stock.averageVolume30d === undefined
                ? '—'
                : formatCompactNumber(
                    stock.averageVolume30d
                  )
            ) +
            '</span>' +
            '</td>' +

            '<td>' +
            (
              stock.peRatio ===
                null
                ? '—'
                : formatNumber(
                    stock.peRatio
                  )
            ) +
            '</td>' +

            '<td>' +
            (
              stock.dividendYield ===
                null
                ? '—'
                : formatPercent(
                    stock.dividendYield
                  )
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
      currentPage <= 1;

  $('nextPage')
    .disabled =
      currentPage >=
      pageCount;

  document.querySelectorAll(
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

      sectors.map(
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

/* =========================================================
   METADATA / SECURITY UNIVERSE AUDIT UI
========================================================= */

function auditBucketClass(
  bucket
) {
  if (
    bucket ===
      'UNRESOLVED' ||
    bucket ===
      'LEGACY_STALE_CANDIDATE' ||
    bucket ===
      'HISTORICAL_SECURITY'
  ) {
    return 'danger';
  }

  if (
    bucket ===
      'LIKELY_SPECIAL_INSTRUMENT'
  ) {
    return 'warning';
  }

  return 'info';
}

function universeClassPill(
  row
) {
  const danger =
    row.universeClass ===
      'HISTORICAL_OR_INACTIVE' ||
    row.universeClass ===
      'LEGACY_STALE_CANDIDATE';

  const warning =
    row.universeClass ===
      'SPECIAL_INSTRUMENT' ||
    row.universeClass ===
      'SUSPENDED_SECURITY' ||
    row.universeClass ===
      'REVIEW_REQUIRED';

  const className =
    danger
      ? 'danger'
      : warning
        ? 'warning'
        : 'info';

  return (
    '<span class="auditPill ' +
    className +
    '">' +
    escapeHtml(
      row.universeLabel ||
      row.universeClass ||
      'Unverified'
    ) +
    '</span>'
  );
}

function tradingStatusPill(
  row
) {
  const status =
    row.tradingStatus ||
    'UNKNOWN';

  const dangerStatuses = [
    'DELISTED',
    'CHANGED',
    'MERGED',
    'MIGRATED_OR_SYMBOL_CHANGED',
    'HISTORICAL_OR_INACTIVE',
    'NO_COMPANY_PAGE_EVIDENCE'
  ];

  const warningStatuses = [
    'SUSPENDED',
    'PAGE_STATUS_UNCLEAR',
    'UNKNOWN'
  ];

  const className =
    dangerStatuses.includes(
      status
    )
      ? 'danger'
      : warningStatuses.includes(
          status
        )
        ? 'warning'
        : 'info';

  return (
    '<span class="auditPill ' +
    className +
    '">' +
    escapeHtml(
      row.tradingStatusLabel ||
      status
    ) +
    '</span>'
  );
}

function clientCountBy(
  rows,
  key
) {
  const counts = {};

  rows.forEach(
    row => {
      const value =
        row?.[key];

      if (!value) {
        return;
      }

      counts[value] =
        (
          counts[value] ||
          0
        ) +
        1;
    }
  );

  return counts;
}

function recalculateMetadataAuditResult(
  result
) {
  const universe =
    Array.isArray(
      result.universe
    )
      ? result.universe
      : [];

  const issues =
    universe.filter(
      row =>
        Boolean(
          row.issueType
        )
    );

  const namesResolved =
    universe.filter(
      row =>
        row.nameResolved
    ).length;

  const sectorsResolved =
    universe.filter(
      row =>
        row.sectorResolved
    ).length;

  const universeClasses =
    clientCountBy(
      universe,
      'universeClass'
    );

  const tradingStatusCounts =
    clientCountBy(
      universe,
      'tradingStatus'
    );

  const eligibilityCounts =
    clientCountBy(
      universe,
      'eligibility'
    );

  const sourceCoverage = {
    ...(
      result.sourceCoverage ||
      {}
    ),

    companyPage:
      universe.filter(
        row =>
          row.hasOfficialPageEvidence
      ).length
  };

  return {
    ...result,

    resolvedAt:
      new Date()
        .toISOString(),

    summary: {
      ...(
        result.summary ||
        {}
      ),

      totalCanonicalSecurities:
        universe.length,

      namesResolved,

      namesMissing:
        universe.length -
        namesResolved,

      sectorsResolved,

      sectorsMissing:
        universe.length -
        sectorsResolved,

      statusSymbolsNormalized:
        universe.filter(
          row =>
            row.normalizedStatus
        ).length,

      totalMetadataIssues:
        issues.length,

      totalSpecialInstrumentsDetected:
        universe.filter(
          row =>
            row.isSpecialSecurity
        ).length,

      verifiedCurrentSecurities:
        universeClasses.VERIFIED_CURRENT ||
        0,

      specialInstrumentSecurities:
        universeClasses.SPECIAL_INSTRUMENT ||
        0,

      legacyStaleCandidates:
        universeClasses.LEGACY_STALE_CANDIDATE ||
        0,

      historicalOrInactive:
        universeClasses.HISTORICAL_OR_INACTIVE ||
        0,

      suspendedSecurities:
        (
          tradingStatusCounts.SUSPENDED ||
          0
        ),

      delistedSecurities:
        tradingStatusCounts.DELISTED ||
        0,

      changedOrMigratedSymbols:
        (
          tradingStatusCounts.CHANGED ||
          0
        ) +
        (
          tradingStatusCounts.MERGED ||
          0
        ) +
        (
          tradingStatusCounts.MIGRATED_OR_SYMBOL_CHANGED ||
          0
        ),

      statusReviewRequired:
        (
          universeClasses.REVIEW_REQUIRED ||
          0
        ) +
        (
          universeClasses.UNVERIFIED ||
          0
        ),

      coreEquityCandidates:
        eligibilityCounts.CORE_EQUITY_CANDIDATE ||
        0,

      gemEquityCandidates:
        eligibilityCounts.GEM_EQUITY_CANDIDATE ||
        0
    },

    sourceCoverage,

    universeClasses,
    tradingStatusCounts,
    eligibilityCounts,

    issueBuckets:
      clientCountBy(
        issues,
        'bucket'
      ),

    issueTypes:
      clientCountBy(
        issues,
        'issueType'
      ),

    securityTypes:
      clientCountBy(
        universe,
        'securityType'
      ),

    issuerTypes:
      clientCountBy(
        universe,
        'issuerType'
      ),

    issues,
    universe
  };
}

function renderMetadataAuditSummary(
  result
) {
  const summary =
    result.summary ||
    {};

  const sourceCoverage =
    result.sourceCoverage ||
    {};

  const fetchDiagnostics =
    result.fetchDiagnostics ||
    {};

  $('metadataAuditSummary')
    .innerHTML =
      '<div class="summaryGrid">' +

      metricCard(
        'Canonical securities',
        formatNumber(
          summary.totalCanonicalSecurities,
          0
        )
      ) +

      metricCard(
        'Verified current',
        formatNumber(
          summary.verifiedCurrentSecurities,
          0
        ),
        'Ordinary/current security class'
      ) +

      metricCard(
        'Special instruments',
        formatNumber(
          summary.specialInstrumentSecurities,
          0
        ),
        'Rights, Modaraba, REIT, fund, preference, etc.'
      ) +

      metricCard(
        'Delisted',
        '<span class="negative">' +
        formatNumber(
          summary.delistedSecurities ||
          0,
          0
        ) +
        '</span>'
      ) +

      metricCard(
        'Changed / migrated',
        formatNumber(
          summary.changedOrMigratedSymbols ||
          0,
          0
        )
      ) +

      metricCard(
        'Suspended',
        formatNumber(
          summary.suspendedSecurities ||
          0,
          0
        )
      ) +

      metricCard(
        'Historical / inactive',
        formatNumber(
          summary.historicalOrInactive ||
          0,
          0
        )
      ) +

      metricCard(
        'Status review required',
        formatNumber(
          summary.statusReviewRequired ||
          summary.unverifiedCurrentStatus ||
          0,
          0
        )
      ) +

      metricCard(
        'Core equity candidates',
        formatNumber(
          summary.coreEquityCandidates ||
          0,
          0
        )
      ) +

      metricCard(
        'GEM equity candidates',
        formatNumber(
          summary.gemEquityCandidates ||
          0,
          0
        )
      ) +

      metricCard(
        'Names resolved',
        formatNumber(
          summary.namesResolved,
          0
        ),
        formatNumber(
          summary.namesMissing,
          0
        ) +
        ' missing'
      ) +

      metricCard(
        'Sectors resolved',
        formatNumber(
          summary.sectorsResolved,
          0
        ),
        formatNumber(
          summary.sectorsMissing,
          0
        ) +
        ' missing'
      ) +

      metricCard(
        'Metadata issues',
        formatNumber(
          summary.totalMetadataIssues,
          0
        )
      ) +

      metricCard(
        'PSX market-watch evidence',
        formatNumber(
          sourceCoverage.marketWatch ||
          0,
          0
        ),
        'Current-universe evidence when available'
      ) +

      metricCard(
        'Bulk status reports loaded',
        formatNumber(
          summary.bulkStatusReportsLoaded ||
          0,
          0
        ),
        'Suspended / delisted / merged / renamed'
      ) +

      metricCard(
        'Bulk status matches',
        formatNumber(
          summary.bulkStatusMatches ||
          0,
          0
        ),
        'Official PSX historical/status evidence'
      ) +

      metricCard(
        'Bulk report failures',
        formatNumber(
          summary.bulkStatusReportsFailed ||
          0,
          0
        ),
        'Failed source stays review-required'
      ) +

      '</div>' +

      '<div class="infoBox">' +
      'Build 0.6.8 removes mass PSX company-page scraping from the universe audit. Current identities come from official bulk listing sources; suspended, delisted, merged and renamed identities come from official PSX bulk status reports. Company pages remain available only when you research an individual stock. Unmatched identities stay review-required rather than being guessed.' +
      '</div>';
}

function activeMetadataAuditRows() {
  const view =
    $('metadataAuditView')
      ?.value ||
    'issues';

  return view ===
    'universe'
      ? metadataAuditUniverseRows
      : metadataAuditRows;
}

function getFilteredMetadataAuditRows() {
  const query =
    $('metadataAuditSearch')
      .value
      .trim()
      .toLowerCase();

  const category =
    $('metadataAuditCategory')
      .value;

  const universeClass =
    $('metadataAuditUniverseClass')
      .value;

  const tradingStatus =
    $('metadataAuditTradingStatus')
      .value;

  const eligibility =
    $('metadataAuditEligibility')
      .value;

  return activeMetadataAuditRows()
    .filter(
      row => {
        const searchable =
          (
            row.symbol +
            ' ' +
            row.marketSymbol +
            ' ' +
            row.rawSymbol +
            ' ' +
            row.companyName +
            ' ' +
            row.sector +
            ' ' +
            row.securityLabel +
            ' ' +
            row.issuerLabel +
            ' ' +
            row.issueLabel +
            ' ' +
            row.auditReason +
            ' ' +
            row.universeLabel +
            ' ' +
            row.universeReason +
            ' ' +
            row.tradingStatusLabel +
            ' ' +
            row.eligibilityLabel +
            ' ' +
            row.parentSymbol +
            ' ' +
            row.successorSymbol +
            ' ' +
            row.successorName +
            ' ' +
            (
              row.metadataSources ||
              []
            ).join(' ') +
            ' ' +
            (
              row.officialEvidenceSources ||
              []
            ).join(' ') +
            ' ' +
            (
              row.statusCodes ||
              []
            ).join(' ')
          )
            .toLowerCase();

        return (
          searchable.includes(
            query
          ) &&
          (
            !category ||
            row.bucket ===
              category
          ) &&
          (
            !universeClass ||
            row.universeClass ===
              universeClass
          ) &&
          (
            !tradingStatus ||
            row.tradingStatus ===
              tradingStatus
          ) &&
          (
            !eligibility ||
            row.eligibility ===
              eligibility
          )
        );
      }
    );
}

function renderMetadataAuditTable() {
  const rows =
    getFilteredMetadataAuditRows();

  const pageCount =
    Math.max(
      1,
      Math.ceil(
        rows.length /
        METADATA_AUDIT_PAGE_SIZE
      )
    );

  if (
    metadataAuditPage >
    pageCount
  ) {
    metadataAuditPage =
      pageCount;
  }

  const start =
    (
      metadataAuditPage -
      1
    ) *
    METADATA_AUDIT_PAGE_SIZE;

  const pageRows =
    rows.slice(
      start,
      start +
      METADATA_AUDIT_PAGE_SIZE
    );

  const viewLabel =
    $('metadataAuditView')
      .value ===
      'universe'
      ? 'securities'
      : 'metadata issues';

  $('metadataAuditInfo')
    .textContent =
      rows.length +
      ' ' +
      viewLabel +
      ' after current filters.';

  if (
    !pageRows.length
  ) {
    $('metadataAuditTable')
      .innerHTML =
        '<div class="emptyState">' +
        'No audit rows match this filter.' +
        '</div>';

    $('metadataAuditPageInfo')
      .textContent =
        '';

    $('metadataAuditPrevious')
      .disabled =
        true;

    $('metadataAuditNext')
      .disabled =
        true;

    return;
  }

  $('metadataAuditTable')
    .innerHTML =
      '<table>' +

      '<thead>' +

      '<tr>' +

      '<th>Symbol</th>' +
      '<th>Company</th>' +
      '<th>Sector</th>' +
      '<th>Trading status</th>' +
      '<th>Board</th>' +
      '<th>Security type</th>' +
      '<th>Issuer type</th>' +
      '<th>Universe eligibility</th>' +
      '<th>Evidence</th>' +
      '<th>Issue</th>' +
      '<th>Why</th>' +

      '</tr>' +

      '</thead>' +

      '<tbody>' +

      pageRows.map(
        row => {
          const evidence =
            row.officialEvidenceSources
              ?.length
              ? row.officialEvidenceSources
              : row.metadataSources ||
                [];

          const successor =
            row.successorSymbol
              ? (
                  '<span class="symbolSub">Successor/current: ' +
                  escapeHtml(
                    row.successorSymbol
                  ) +
                  '</span>'
                )
              : '';

          return (
            '<tr>' +

            '<td class="symbol">' +

            escapeHtml(
              row.symbol
            ) +

            (
              row.statusCodes?.length
                ? (
                    ' ' +
                    statusPills(
                      row.statusCodes
                    )
                  )
                : ''
            ) +

            (
              row.marketSymbol &&
              row.marketSymbol !==
                row.symbol
                ? (
                    '<span class="symbolSub">Market: ' +
                    escapeHtml(
                      row.marketSymbol
                    ) +
                    '</span>'
                  )
                : ''
            ) +

            successor +

            '</td>' +

            '<td>' +
            (
              row.nameResolved
                ? escapeHtml(
                    row.companyName
                  )
                : (
                    '<span class="negative">' +
                    'Unresolved' +
                    '</span>'
                  )
            ) +
            '</td>' +

            '<td>' +
            (
              row.sectorResolved
                ? escapeHtml(
                    row.sector
                  )
                : (
                    '<span class="negative">' +
                    'Unknown' +
                    '</span>'
                  )
            ) +
            '</td>' +

            '<td>' +
            tradingStatusPill(
              row
            ) +
            (
              row.companyPageQuoteAsOf
                ? (
                    '<span class="symbolSub">Quote as of ' +
                    escapeHtml(
                      formatDate(
                        row.companyPageQuoteAsOf
                      )
                    ) +
                    '</span>'
                  )
                : ''
            ) +
            '</td>' +

            '<td>' +
            escapeHtml(
              row.boardLabel ||
              row.boardType ||
              'Unknown'
            ) +
            '</td>' +

            '<td>' +
            escapeHtml(
              row.securityLabel ||
              row.instrumentLabel ||
              'Unknown'
            ) +
            (
              row.parentSymbol
                ? (
                    '<span class="symbolSub">Parent: ' +
                    escapeHtml(
                      row.parentSymbol
                    ) +
                    '</span>'
                  )
                : ''
            ) +
            '</td>' +

            '<td>' +
            escapeHtml(
              row.issuerLabel ||
              row.issuerType ||
              'Unknown'
            ) +
            '</td>' +

            '<td>' +
            '<strong>' +
            escapeHtml(
              row.eligibilityLabel ||
              row.eligibility ||
              'Review required'
            ) +
            '</strong>' +
            '<span class="symbolSub">' +
            escapeHtml(
              row.eligibilityReason ||
              ''
            ) +
            '</span>' +
            '</td>' +

            '<td class="auditEvidence">' +
            (
              evidence.length
                ? (
                    '<strong>' +
                    escapeHtml(
                      evidence.join(', ')
                    ) +
                    '</strong>'
                  )
                : (
                    '<span class="negative">' +
                    'No official evidence yet' +
                    '</span>'
                  )
            ) +
            (
              row.statusEvidence
                ? (
                    '<span class="symbolSub">' +
                    escapeHtml(
                      row.statusEvidence
                    ) +
                    '</span>'
                  )
                : ''
            ) +
            (
              row.companyPageFetchStatus ===
                'FETCH_FAILED'
                ? (
                    '<span class="symbolSub negative">Page fetch failed after retry</span>'
                  )
                : ''
            ) +
            '</td>' +

            '<td>' +
            (
              row.issueType
                ? (
                    '<span class="auditPill ' +
                    auditBucketClass(
                      row.bucket
                    ) +
                    '">' +
                    escapeHtml(
                      row.bucketLabel ||
                      row.issueLabel ||
                      'Issue'
                    ) +
                    '</span>' +
                    '<div class="symbolSub">' +
                    escapeHtml(
                      row.issueLabel ||
                      ''
                    ) +
                    '</div>'
                  )
                : (
                    '<span class="positive">' +
                    'No metadata gap' +
                    '</span>'
                  )
            ) +
            '</td>' +

            '<td class="auditReason">' +
            escapeHtml(
              row.auditReason ||
              row.classificationReason ||
              row.universeReason ||
              ''
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
    start +
    1;

  const last =
    Math.min(
      start +
      METADATA_AUDIT_PAGE_SIZE,
      rows.length
    );

  $('metadataAuditPageInfo')
    .textContent =
      first +
      '-' +
      last +
      ' of ' +
      rows.length +
      ' | Page ' +
      metadataAuditPage +
      ' of ' +
      pageCount;

  $('metadataAuditPrevious')
    .disabled =
      metadataAuditPage <=
      1;

  $('metadataAuditNext')
    .disabled =
      metadataAuditPage >=
      pageCount;
}

function chunkArray(
  values,
  size
) {
  const chunks = [];

  for (
    let index = 0;
    index < values.length;
    index += size
  ) {
    chunks.push(
      values.slice(
        index,
        index +
        size
      )
    );
  }

  return chunks;
}

const SECURITY_STATUS_CACHE_KEY =
  'nomad-security-status-cache-v067';

const SECURITY_STATUS_CACHE_TTL_MS =
  24 *
  60 *
  60 *
  1000;

function clientWaitMilliseconds(
  value
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        value
      )
  );
}

function readSecurityStatusCache() {
  try {
    const parsed =
      JSON.parse(
        localStorage.getItem(
          SECURITY_STATUS_CACHE_KEY
        ) ||
        '{}'
      );

    const now =
      Date.now();

    const output = {};

    Object.entries(
      parsed ||
      {}
    ).forEach(
      ([symbol, entry]) => {
        if (
          !entry?.row ||
          !entry?.cachedAt ||
          now -
            Number(
              entry.cachedAt
            ) >
            SECURITY_STATUS_CACHE_TTL_MS
        ) {
          return;
        }

        output[symbol] =
          entry;
      }
    );

    return output;
  } catch {
    return {};
  }
}

function writeSecurityStatusCache(
  cache
) {
  try {
    localStorage.setItem(
      SECURITY_STATUS_CACHE_KEY,
      JSON.stringify(
        cache
      )
    );
  } catch {}
}

function shouldCacheResolvedAuditRow(
  row
) {
  const fetchStatus =
    String(
      row?.companyPageFetchStatus ||
      ''
    );

  return (
    row?.hasOfficialPageEvidence ===
      true ||
    fetchStatus ===
      'NOT_FOUND' ||
    fetchStatus ===
      'INVALID_PAGE'
  );
}

function needsDeepStatusResolution(
  row
) {
  if (!row) {
    return false;
  }

  if (
    row.hasOfficialCurrentEvidence ||
    row.tradingStatus ===
      'CURRENT' ||
    row.tradingStatus ===
      'CURRENT_PAGE_EVIDENCE'
  ) {
    return false;
  }

  if (
    row.tradingStatus ===
      'DELISTED' ||
    row.tradingStatus ===
      'CHANGED' ||
    row.tradingStatus ===
      'MERGED' ||
    row.tradingStatus ===
      'MIGRATED_OR_SYMBOL_CHANGED' ||
    row.tradingStatus ===
      'SUSPENDED' ||
    row.tradingStatus ===
      'HISTORICAL_OR_INACTIVE'
  ) {
    return false;
  }

  return (
    row.universeClass ===
      'LEGACY_STALE_CANDIDATE' ||
    row.universeClass ===
      'REVIEW_REQUIRED' ||
    row.universeClass ===
      'UNVERIFIED' ||
    row.isSpecialSecurity ===
      true
  );
}

async function deepResolveMetadataAudit(
  result
) {
  const universeMap =
    new Map(
      (
        result.universe ||
        []
      ).map(
        row => [
          row.symbol,
          row
        ]
      )
    );

  const statusCache =
    readSecurityStatusCache();

  let cacheHits = 0;

  Object.entries(
    statusCache
  ).forEach(
    ([symbol, entry]) => {
      if (
        !universeMap.has(
          symbol
        ) ||
        !entry?.row
      ) {
        return;
      }

      const fastRow =
        universeMap.get(
          symbol
        );

      // Never let yesterday's deep-page cache override stronger current
      // bulk-listing evidence obtained on this run.
      if (
        fastRow?.hasOfficialCurrentEvidence
      ) {
        return;
      }

      universeMap.set(
        symbol,
        {
          ...entry.row,

          companyPageFetchStatus:
            'CLIENT_CACHE',

          companyPageFetchAttempts:
            0,

          companyPageRetried:
            false
        }
      );

      cacheHits++;
    }
  );

  const targetRows =
    Array.from(
      universeMap.values()
    )
      .filter(
        needsDeepStatusResolution
      )
      .sort(
        (
          a,
          b
        ) =>
          Number(
            Boolean(
              a.isSpecialSecurity
            )
          ) -
          Number(
            Boolean(
              b.isSpecialSecurity
            )
          ) ||
          String(
            a.symbol
          ).localeCompare(
            String(
              b.symbol
            )
          )
      );

  const targetSymbols =
    targetRows.map(
      row =>
        row.symbol
    );

  const batches =
    chunkArray(
      targetSymbols,
      4
    );

  let successfulBatches =
    0;

  const fetchDiagnostics = {
    requested:
      0,
    attempted:
      0,
    succeeded:
      0,
    retried:
      0,
    notFound:
      0,
    fetchFailed:
      0,
    invalidPage:
      0,
    totalAttempts:
      0,
    cacheHits,
    bulkCurrentSkipped:
      (
        result.universe ||
        []
      ).filter(
        row =>
          row.hasOfficialCurrentEvidence
      ).length,
    cooldowns:
      0,
    httpStatusCounts:
      {}
  };

  for (
    let index = 0;
    index < batches.length;
    index++
  ) {
    $('metadataAuditProgress')
      .textContent =
        'Resolving remaining PSX company-page statuses ' +
        (
          index +
          1
        ) +
        '/' +
        batches.length +
        '... (' +
        cacheHits +
        ' cache hits; bulk-current rows skipped)';

    try {
      const batchResult =
        await api(
          'security-status-batch',
          {
            symbols:
              batches[index]
                .join(',')
          }
        );

      (
        batchResult.rows ||
        []
      ).forEach(
        row => {
          universeMap.set(
            row.symbol,
            row
          );

          if (
            shouldCacheResolvedAuditRow(
              row
            )
          ) {
            statusCache[
              row.symbol
            ] = {
              cachedAt:
                Date.now(),
              row
            };
          }
        }
      );

      writeSecurityStatusCache(
        statusCache
      );

      const diagnostics =
        batchResult.diagnostics ||
        {};

      [
        'requested',
        'attempted',
        'succeeded',
        'retried',
        'notFound',
        'fetchFailed',
        'invalidPage',
        'totalAttempts'
      ].forEach(
        key => {
          fetchDiagnostics[key] +=
            Number(
              diagnostics[key] ||
              0
            );
        }
      );

      Object.entries(
        diagnostics.httpStatusCounts ||
        {}
      ).forEach(
        ([status, count]) => {
          fetchDiagnostics
            .httpStatusCounts[
              status
            ] =
              (
                fetchDiagnostics
                  .httpStatusCounts[
                    status
                  ] ||
                0
              ) +
              Number(
                count ||
                0
              );
        }
      );

      successfulBatches++;

      const highFailureBatch =
        Number(
          diagnostics.fetchFailed ||
          0
        ) >=
        Math.max(
          1,
          Math.ceil(
            Number(
              diagnostics.attempted ||
              0
            ) /
            2
          )
        );

      if (
        index <
        batches.length - 1
      ) {
        if (
          highFailureBatch
        ) {
          fetchDiagnostics.cooldowns++;

          await clientWaitMilliseconds(
            3200
          );
        } else {
          await clientWaitMilliseconds(
            900
          );
        }
      }
    } catch (error) {
      console.warn(
        'NOMAD deep audit batch failed',
        error
      );

      fetchDiagnostics.cooldowns++;

      if (
        index <
        batches.length - 1
      ) {
        await clientWaitMilliseconds(
          3500
        );
      }
    }
  }

  const resolved =
    recalculateMetadataAuditResult({
      ...result,

      fetchDiagnostics,

      universe:
        Array.from(
          universeMap.values()
        )
    });

  const statusBreakdown =
    Object.entries(
      fetchDiagnostics
        .httpStatusCounts ||
      {}
    )
      .map(
        ([status, count]) =>
          status +
          ':' +
          count
      )
      .join(', ');

  $('metadataAuditProgress')
    .textContent =
      'Official status resolution complete: ' +
      successfulBatches +
      '/' +
      batches.length +
      ' batches. Bulk-current skipped: ' +
      fetchDiagnostics.bulkCurrentSkipped +
      '; cache hits: ' +
      fetchDiagnostics.cacheHits +
      '; pages resolved: ' +
      fetchDiagnostics.succeeded +
      '; retried: ' +
      fetchDiagnostics.retried +
      '; fetch failures: ' +
      fetchDiagnostics.fetchFailed +
      '; not found: ' +
      fetchDiagnostics.notFound +
      (
        statusBreakdown
          ? (
              '; HTTP: ' +
              statusBreakdown
            )
          : ''
      ) +
      '. No securities were removed.';

  return resolved;
}

function csvCell(
  value
) {
  const text =
    String(
      value ?? ''
    );

  return (
    '"' +
    text.replace(
      /"/g,
      '""'
    ) +
    '"'
  );
}

function triggerTextDownload(
  filename,
  content,
  mimeType
) {
  const blob =
    new Blob(
      [content],
      {
        type:
          mimeType
      }
    );

  const url =
    URL.createObjectURL(
      blob
    );

  const anchor =
    document.createElement(
      'a'
    );

  anchor.href =
    url;

  anchor.download =
    filename;

  document.body.appendChild(
    anchor
  );

  anchor.click();
  anchor.remove();

  setTimeout(
    () =>
      URL.revokeObjectURL(
        url
      ),
    1000
  );
}

function downloadMetadataAuditCSV() {
  const rows =
    getFilteredMetadataAuditRows();

  const headers = [
    'Symbol',
    'Market Symbol',
    'Company',
    'Sector',
    'Status Codes',
    'Trading Status',
    'Board',
    'Security Type',
    'Issuer Type',
    'Parent Symbol',
    'Successor Symbol',
    'Universe Class',
    'Universe Eligibility',
    'Official Evidence',
    'Status Evidence',
    'Company Page Fetch Status',
    'Company Page Retried',
    'All Metadata Sources',
    'Issue Type',
    'Issue Bucket',
    'Company Page Quote As Of',
    'Company Page URL',
    'Reason'
  ];

  const lines = [
    headers.map(
      csvCell
    ).join(',')
  ];

  for (
    const row
    of rows
  ) {
    lines.push(
      [
        row.symbol,
        row.marketSymbol,
        row.companyName,
        row.sector,
        (
          row.statusCodes ||
          []
        ).join(' | '),
        row.tradingStatusLabel ||
          row.tradingStatus ||
          '',
        row.boardLabel ||
          row.boardType ||
          '',
        row.securityLabel ||
          row.securityType ||
          '',
        row.issuerLabel ||
          row.issuerType ||
          '',
        row.parentSymbol ||
          '',
        row.successorSymbol ||
          '',
        row.universeLabel ||
          row.universeClass ||
          '',
        row.eligibilityLabel ||
          row.eligibility ||
          '',
        (
          row.officialEvidenceSources ||
          []
        ).join(' | '),
        row.statusEvidence ||
          '',
        row.companyPageFetchStatus ||
          '',
        row.companyPageRetried
          ? 'Yes'
          : 'No',
        (
          row.metadataSources ||
          []
        ).join(' | '),
        row.issueLabel ||
          '',
        row.bucketLabel ||
          '',
        row.companyPageQuoteAsOf ||
          '',
        row.companyPageUrl ||
          '',
        row.auditReason ||
        row.universeReason ||
          ''
      ]
        .map(
          csvCell
        )
        .join(',')
    );
  }

  triggerTextDownload(
    'nomad-metadata-audit-' +
    new Date()
      .toISOString()
      .slice(
        0,
        10
      ) +
    '.csv',
    lines.join('\\n'),
    'text/csv;charset=utf-8'
  );
}

function downloadMetadataAuditJSON() {
  if (
    !lastMetadataAuditResult
  ) {
    return;
  }

  triggerTextDownload(
    'nomad-metadata-audit-' +
    new Date()
      .toISOString()
      .slice(
        0,
        10
      ) +
    '.json',
    JSON.stringify(
      lastMetadataAuditResult,
      null,
      2
    ),
    'application/json;charset=utf-8'
  );
}

/* =========================================================
   HISTORY CHART
========================================================= */

function buildPriceChart(
  rows
) {
  if (
    !rows ||
    rows.length < 2
  ) {
    return '';
  }

  const width = 1000;
  const height = 330;
  const left = 65;
  const right = 20;
  const top = 20;
  const bottom = 42;

  const usableWidth =
    width -
    left -
    right;

  const usableHeight =
    height -
    top -
    bottom;

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

  const margin =
    Math.max(
      (
        max -
        min
      ) *
      .08,
      max *
      .001
    );

  min -= margin;
  max += margin;

  const x =
    index =>
      left +
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
      top +
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
    rows.map(
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
    top +
    usableHeight;

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

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Closing price history (PKR)' +
    '</div>' +

    '<svg class="priceChart" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    '<polygon points="' +
    areaPoints +
    '" class="chartArea" />' +

    '<polyline points="' +
    points +
    '" class="chartLine" />' +

    '</svg>' +

    '</div>'
  );
}

function historyRangeToggle(
  activeRange
) {
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

    [
      '1M',
      '6M',
      '1Y',
      '2Y',
      'ALL'
    ]
      .map(
        range =>
          '<button class="rangeButton ' +
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
  document.querySelectorAll(
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
  updateSelectedCompany(
    result
  );

  const summary =
    result.summary;

  if (
    !summary
  ) {
    $('research')
      .innerHTML =
        identityNote(
          result.identity
        ) +

        historyRangeToggle(
          result.range
        ) +

        '<div class="emptyState">' +
        'No valid historical price data was available for the canonical ticker ' +
        escapeHtml(
          result.symbol
        ) +
        '.' +
        '</div>';

    bindHistoryRangeButtons(
      result.symbol
    );

    return;
  }

  $('research')
    .innerHTML =
      identityNote(
        result.identity
      ) +

      historyRangeToggle(
        result.range
      ) +

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
        percentClass(
          summary.changePct
        ) +
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

      '</div>' +

      buildPriceChart(
        result.data
      ) +

      (
        summary.excludedAnomalies >
          0
          ? (
              '<div class="warningBox">' +
              summary.excludedAnomalies +
              ' suspicious historical rows were excluded from this chart.' +
              '</div>'
            )
          : ''
      ) +

      '<div class="sourceNote">' +
      'Historical data uses canonical ticker ' +
      '<strong>' +
      escapeHtml(
        result.symbol
      ) +
      '</strong>. Live/session prices are handled separately.' +
      '</div>';

  bindHistoryRangeButtons(
    result.symbol
  );
}

async function loadHistoryView(
  symbol,
  range
) {
  stopLiveRefresh();

  $('liveStatus')
    .innerHTML =
      '';

  $('research')
    .innerHTML =
      '<p class="muted">' +
      'Loading history...' +
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
      result.range;

    $('stockSymbol')
      .value =
        result.symbol;

    renderHistory(
      result
    );
  } catch (error) {
    $('error')
      .textContent =
        error.message;
  }
}

/* =========================================================
   TECHNICAL CHART
========================================================= */

function buildTechnicalChart(
  rows
) {
  if (
    !rows ||
    rows.length < 2
  ) {
    return '';
  }

  const width = 1000;
  const height = 360;
  const left = 60;
  const right = 20;
  const top = 20;
  const bottom = 30;

  const usableWidth =
    width -
    left -
    right;

  const usableHeight =
    height -
    top -
    bottom;

  const allValues = [];

  rows.forEach(
    row => {
      [
        row.close,
        row.sma20,
        row.sma50,
        row.sma200
      ]
        .forEach(
          value => {
            const number =
              Number(value);

            if (
              Number.isFinite(
                number
              )
            ) {
              allValues.push(
                number
              );
            }
          }
        );
    }
  );

  if (
    !allValues.length
  ) {
    return '';
  }

  let min =
    Math.min(
      ...allValues
    );

  let max =
    Math.max(
      ...allValues
    );

  const margin =
    Math.max(
      (
        max -
        min
      ) *
      .06,
      max *
      .002
    );

  min -= margin;
  max += margin;

  const x =
    index =>
      left +
      (
        index /
        (
          rows.length -
          1
        )
      ) *
      usableWidth;

  const y =
    value =>
      top +
      (
        1 -
        (
          (
            value -
            min
          ) /
          (
            max -
            min
          )
        )
      ) *
      usableHeight;

  function polyline(
    key,
    className
  ) {
    let segments = [];
    let current = [];

    rows.forEach(
      (
        row,
        index
      ) => {
        const number =
          Number(
            row[key]
          );

        if (
          Number.isFinite(
            number
          )
        ) {
          current.push(
            x(index) +
            ',' +
            y(number)
          );
        } else if (
          current.length
        ) {
          segments.push(
            current
          );

          current = [];
        }
      }
    );

    if (
      current.length
    ) {
      segments.push(
        current
      );
    }

    return segments.map(
      segment =>
        '<polyline points="' +
        segment.join(' ') +
        '" class="' +
        className +
        '" />'
    )
      .join('');
  }

  return (
    '<div class="chartBox">' +

    '<div class="chartTitle">' +
    'Price with moving averages' +
    '</div>' +

    '<div class="chartLegend">' +

    '<span><span class="legendSwatch price"></span>Price</span>' +

    '<span><span class="legendSwatch sma20"></span>SMA 20</span>' +

    '<span><span class="legendSwatch sma50"></span>SMA 50</span>' +

    '<span><span class="legendSwatch sma200"></span>SMA 200</span>' +

    '</div>' +

    '<svg class="technicalChart" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" preserveAspectRatio="none">' +

    polyline(
      'close',
      'technicalPrice'
    ) +

    polyline(
      'sma20',
      'technicalSMA20'
    ) +

    polyline(
      'sma50',
      'technicalSMA50'
    ) +

    polyline(
      'sma200',
      'technicalSMA200'
    ) +

    '</svg>' +

    '</div>'
  );
}

function buildSMALearningText(
  result
) {
  const price =
    finiteNumber(
      result.price
    );

  const sma20 =
    finiteNumber(
      result.trend?.sma20
    );

  const sma50 =
    finiteNumber(
      result.trend?.sma50
    );

  const sma200 =
    finiteNumber(
      result.trend?.sma200
    );

  const available = [
    {
      label:
        '20-day',
      value:
        sma20
    },
    {
      label:
        '50-day',
      value:
        sma50
    },
    {
      label:
        '200-day',
      value:
        sma200
    }
  ]
    .filter(
      item =>
        item.value !==
        null
    );

  let interpretation =
    '';

  if (
    price !== null &&
    available.length
  ) {
    const above =
      available.filter(
        item =>
          price >
          item.value
      );

    const below =
      available.filter(
        item =>
          price <
          item.value
      );

    if (
      above.length ===
      available.length
    ) {
      interpretation =
        ' The current price is above all available moving averages, which indicates stronger trend structure across those time horizons.';
    } else if (
      below.length ===
      available.length
    ) {
      interpretation =
        ' The current price is below all available moving averages, which indicates weaker trend structure across those time horizons.';
    } else {
      interpretation =
        ' The price is above some moving averages and below others, so the short-, medium- and longer-term trend signals are mixed.';
    }
  }

  return (
    '<div class="learnBox">' +

    '<strong>How to read SMA 20 / 50 / 200</strong><br>' +

    'SMA means Simple Moving Average. SMA 20 is the average closing price over the last 20 trading sessions, SMA 50 covers 50 sessions, and SMA 200 covers roughly 200 sessions. ' +

    'Price above a moving average generally indicates stronger trend structure for that time horizon; price below it suggests weakness.' +

    interpretation +

    '<br><br>' +

    '<strong>Important:</strong> moving averages describe price trend. They are not, by themselves, a Buy or Sell instruction.' +

    '</div>'
  );
}

function buildIndicatorLearningText() {
  return (
    '<div class="learnBox">' +

    '<strong>Quick guide to the indicators above</strong><br>' +

    '<strong>RSI (14):</strong> measures recent momentum on a 0-100 scale. Readings above 70 are commonly treated as an overbought zone and below 30 as an oversold zone.<br>' +

    '<strong>MACD:</strong> compares faster and slower exponential moving averages to show changes in momentum.<br>' +

    '<strong>ATR (14):</strong> measures the typical trading range, so a larger ATR generally means larger price swings.<br>' +

    '<strong>20D volatility:</strong> estimates how variable recent daily returns have been, annualized for easier comparison.<br>' +

    '<strong>Volume vs 20D:</strong> compares the latest session volume with its recent average. High volume can give more weight to a price move.<br>' +

    '<strong>Support / resistance:</strong> NOMAD currently uses recent 20-session lows and highs as simple reference levels. These are descriptive levels, not guaranteed floors or ceilings.' +

    '</div>'
  );
}

function renderTechnical(
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
        identityNote(
          result.identity
        ) +

        '<div class="emptyState">' +
        escapeHtml(
          result.reason ||
          'Technical analysis unavailable.'
        ) +
        '</div>';

    return;
  }

  const trend =
    result.trend ||
    {};

  const momentum =
    result.momentum ||
    {};

  const risk =
    result.risk ||
    {};

  const volume =
    result.volume ||
    {};

  const levels =
    result.levels ||
    {};

  let html =
    identityNote(
      result.identity
    ) +

    '<div class="decisionSectionTitle">' +
    'Technical posture' +
    '</div>' +

    '<div class="posture">' +
    escapeHtml(
      trend.label ||
      'Unavailable'
    ) +
    '</div>' +

    '<div class="sourceNote">' +
    'Based on canonical daily historical price and volume through ' +
    escapeHtml(
      result.asOf ||
      ''
    ) +
    '.' +
    '</div>';

  html +=
    '<div class="summaryGrid">' +

    metricCard(
      'RSI (14)',
      formatNumber(
        momentum.rsi14,
        1
      ),
      momentum.rsiLabel ||
      ''
    ) +

    metricCard(
      'MACD',
      formatNumber(
        momentum.macd,
        2
      ),
      momentum.macdLabel ||
      ''
    ) +

    metricCard(
      '20-day momentum',
      formatPercent(
        momentum.momentum20Pct
      )
    ) +

    metricCard(
      '20D volatility',
      formatPercent(
        risk.annualizedVolatility20dPct
      ),
      'Annualized'
    ) +

    metricCard(
      'ATR (14)',
      risk.atr14 !==
        null
        ? (
            'PKR ' +
            formatNumber(
              risk.atr14
            )
          )
        : 'N/A',

      risk.atrPct !==
        null
        ? (
            formatPercent(
              risk.atrPct
            ) +
            ' of price'
          )
        : ''
    ) +

    metricCard(
      'Volume vs 20D',
      volume.ratio !==
        null
        ? (
            formatNumber(
              volume.ratio,
              2
            ) +
            'x'
          )
        : 'N/A',

      volume.label ||
      ''
    ) +

    '</div>';

  html +=
    buildIndicatorLearningText();

  html +=
    '<div class="decisionSection">' +

    '<div class="decisionSectionTitle">' +
    'Trend structure' +
    '</div>' +

    '<div class="summaryGrid">' +

    metricCard(
      'Price',
      'PKR ' +
      formatNumber(
        result.price
      )
    ) +

    metricCard(
      'SMA 20',
      trend.sma20 !==
        null
        ? (
            'PKR ' +
            formatNumber(
              trend.sma20
            )
          )
        : 'N/A'
    ) +

    metricCard(
      'SMA 50',
      trend.sma50 !==
        null
        ? (
            'PKR ' +
            formatNumber(
              trend.sma50
            )
          )
        : 'N/A'
    ) +

    metricCard(
      'SMA 200',
      trend.sma200 !==
        null
        ? (
            'PKR ' +
            formatNumber(
              trend.sma200
            )
          )
        : 'N/A'
    ) +

    '</div>' +

    '</div>';

  html +=
    '<div class="decisionSection">' +

    '<div class="decisionSectionTitle">' +
    'Recent price levels' +
    '</div>' +

    '<div class="summaryGrid">' +

    metricCard(
      '20D support',
      levels.support20 !==
        null
        ? (
            'PKR ' +
            formatNumber(
              levels.support20
            )
          )
        : 'N/A',

      levels.distanceToSupportPct !==
        null
        ? (
            formatPercent(
              levels.distanceToSupportPct
            ) +
            ' above support'
          )
        : ''
    ) +

    metricCard(
      '20D resistance',
      levels.resistance20 !==
        null
        ? (
            'PKR ' +
            formatNumber(
              levels.resistance20
            )
          )
        : 'N/A',

      levels.distanceToResistancePct !==
        null
        ? (
            formatPercent(
              levels.distanceToResistancePct
            ) +
            ' to resistance'
          )
        : ''
    ) +

    '</div>' +

    '</div>';

  html +=
    buildTechnicalChart(
      result.chartData
    );

  html +=
    buildSMALearningText(
      result
    );

  html +=
    '<div class="infoBox">' +
    escapeHtml(
      result.disclaimer
    ) +
    '</div>';

  html +=
    '<details>' +

    '<summary>' +
    'Indicator details & data quality' +
    '</summary>' +

    '<pre>' +
    escapeHtml(
      JSON.stringify(
        {
          identity:
            result.identity,

          trend:
            result.trend,

          momentum:
            result.momentum,

          risk:
            result.risk,

          volume:
            result.volume,

          levels:
            result.levels,

          dataQuality:
            result.dataQuality
        },
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

/* =========================================================
   FUNDAMENTALS
========================================================= */

function financialMetricRow(
  table,
  matcher
) {
  return table?.rows
    ?.find(
      row =>
        matcher.test(
          String(
            row.label ||
            ''
          )
        )
    ) ||
    null;
}

function financialMetricFromTable(
  table,
  matcher
) {
  const row =
    financialMetricRow(
      table,
      matcher
    );

  return row
    ?.values?.[0] ||
    null;
}

function financialYoYChange(
  table,
  matcher
) {
  const row =
    financialMetricRow(
      table,
      matcher
    );

  if (
    !row?.values ||
    row.values.length <
      2
  ) {
    return null;
  }

  const latest =
    finiteNumber(
      row.values[0]
        .value
    );

  const previous =
    finiteNumber(
      row.values[1]
        .value
    );

  if (
    latest === null ||
    previous === null ||
    previous === 0
  ) {
    return null;
  }

  return (
    (
      latest -
      previous
    ) /
    Math.abs(
      previous
    )
  ) *
  100;
}

function renderFinancialTable(
  title,
  table
) {
  if (
    !table?.periods?.length ||
    !table?.rows?.length
  ) {
    return '';
  }

  return (
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

    table.periods.map(
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

    '<tbody>' +

    table.rows.map(
      row =>
        '<tr>' +

        '<td><strong>' +
        escapeHtml(
          row.label
        ) +
        '</strong></td>' +

        row.values.map(
          value =>
            '<td>' +
            escapeHtml(
              value.raw ||
              'N/A'
            ) +
            '</td>'
        )
          .join('') +

        '</tr>'
    )
      .join('') +

    '</tbody>' +

    '</table>' +

    '</div>' +

    '</div>'
  );
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
        identityNote(
          result.identity
        ) +

        '<div class="emptyState">' +
        'Structured fundamentals are unavailable from the connected PSX source. NOMAD will not invent missing values.' +
        '</div>';

    return;
  }

  const eps =
    financialMetricFromTable(
      result.annual,
      /^EPS$/i
    );

  const pat =
    financialMetricFromTable(
      result.annual,
      /profit after taxation/i
    );

  const incomeRow =
    financialMetricRow(
      result.annual,
      /^(sales|total income|mark-up earned)$/i
    );

  const income =
    incomeRow
      ?.values?.[0] ||
    null;

  const epsYoY =
    financialYoYChange(
      result.annual,
      /^EPS$/i
    );

  const patYoY =
    financialYoYChange(
      result.annual,
      /profit after taxation/i
    );

  const incomeYoY =
    financialYoYChange(
      result.annual,
      /^(sales|total income|mark-up earned)$/i
    );

  let html =
    identityNote(
      result.identity
    ) +

    '<div class="decisionSectionTitle">' +
    'Fundamental snapshot' +
    '</div>' +

    '<div class="summaryGrid">' +

    metricCard(
      'P/E',
      result.valuation?.peRatio !==
        null &&
      result.valuation?.peRatio !==
        undefined
        ? formatNumber(
            result.valuation.peRatio
          )
        : 'N/A'
    ) +

    metricCard(
      'Dividend yield',
      result.valuation?.dividendYield !==
        null &&
      result.valuation?.dividendYield !==
        undefined
        ? formatPercent(
            result.valuation.dividendYield
          )
        : 'N/A'
    );

  if (
    eps
  ) {
    html +=
      metricCard(
        'Latest annual EPS',
        formatNumber(
          eps.value
        ),
        eps.period
      );
  }

  if (
    epsYoY !== null
  ) {
    html +=
      metricCard(
        'EPS YoY',
        '<span class="' +
        percentClass(
          epsYoY
        ) +
        '">' +
        formatPercent(
          epsYoY
        ) +
        '</span>'
      );
  }

  if (
    pat
  ) {
    html +=
      metricCard(
        'Profit after tax',
        formatFinancialThousands(
          pat.value
        ),
        pat.period
      );
  }

  if (
    patYoY !== null
  ) {
    html +=
      metricCard(
        'PAT YoY',
        '<span class="' +
        percentClass(
          patYoY
        ) +
        '">' +
        formatPercent(
          patYoY
        ) +
        '</span>'
      );
  }

  if (
    income
  ) {
    html +=
      metricCard(
        incomeRow.label,
        formatFinancialThousands(
          income.value
        ),
        income.period
      );
  }

  if (
    incomeYoY !== null
  ) {
    html +=
      metricCard(
        'Income YoY',
        '<span class="' +
        percentClass(
          incomeYoY
        ) +
        '">' +
        formatPercent(
          incomeYoY
        ) +
        '</span>'
      );
  }

  html +=
    '</div>' +

    renderFinancialTable(
      'Annual financials',
      result.annual
    ) +

    renderFinancialTable(
      'Recent quarterly financials',
      result.quarterly
    ) +

    renderFinancialTable(
      'Ratios',
      result.ratios
    ) +

    '<div class="sourceNote">' +
    'Source: ' +
    escapeHtml(
      result.source
    ) +
    '. Company data uses canonical ticker ' +
    escapeHtml(
      result.symbol
    ) +
    '.' +
    '</div>';

  $('research')
    .innerHTML =
      html;
}

/* =========================================================
   EVENTS
========================================================= */

function isKeyEvent(
  item
) {
  if (
    item.type ===
      'Financial' ||
    item.type ===
      'Payout'
  ) {
    return true;
  }

  const title =
    String(
      item.title ||
      ''
    ).toLowerCase();

  if (
    item.type ===
      'Meeting' &&
    title.includes(
      'financial result'
    )
  ) {
    return true;
  }

  return (
    title.includes(
      'dividend'
    ) ||
    title.includes(
      'bonus'
    ) ||
    title.includes(
      'right issue'
    ) ||
    title.includes(
      'financial result'
    )
  );
}

function bindEventModeButtons() {
  document.querySelectorAll(
    '.eventModeButton'
  )
    .forEach(
      button => {
        button.onclick =
          () => {
            eventMode =
              button.dataset
                .mode ||
              'key';

            if (
              lastEventsResult
            ) {
              renderEvents(
                lastEventsResult
              );
            }
          };
      }
    );
}

function renderEvents(
  result
) {
  lastEventsResult =
    result;

  updateSelectedCompany(
    result
  );

  const allEvents =
    Array.isArray(
      result.events
    )
      ? result.events
      : [];

  const events =
    eventMode ===
      'all'
      ? allEvents
      : allEvents.filter(
          isKeyEvent
        );

  const modeDescription =
    eventMode ===
      'key'
      ? 'Showing events most likely to matter to an investment decision.'
      : 'Showing all available company announcements.';

  let html =
    identityNote(
      result.identity
    ) +

    '<div class="liveChartHeader">' +

    '<div>' +

    '<div class="decisionSectionTitle">' +
    'Company events & announcements' +
    '</div>' +

    '<div class="muted">' +
    escapeHtml(
      modeDescription
    ) +
    '</div>' +

    '</div>' +

    '<div class="eventToggle">' +

    '<button class="eventModeButton ' +
    (
      eventMode ===
        'key'
        ? 'active'
        : ''
    ) +
    '" data-mode="key">' +
    'Key Events' +
    '</button>' +

    '<button class="eventModeButton ' +
    (
      eventMode ===
        'all'
        ? 'active'
        : ''
    ) +
    '" data-mode="all">' +
    'All' +
    '</button>' +

    '</div>' +

    '</div>';

  if (
    !events.length
  ) {
    html +=
      '<div class="emptyState">' +
      'No matching announcements are available.' +
      '</div>';
  } else {
    html +=
      '<div class="eventList">' +

      events.slice(
        0,
        20
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
    ' &bull; Canonical ticker: ' +
    escapeHtml(
      result.symbol
    ) +
    '</div>';

  $('research')
    .innerHTML =
      html;

  bindEventModeButtons();
}

function buildSituationPanel(
  situation
) {
  if (!situation?.available) {
    return '';
  }

  const returns =
    situation.returns ||
    {};

  const condition =
    situation.condition ||
    'Mixed';

  const returnCell =
    (
      label,
      value
    ) =>
      '<div class="portfolioMetric"><span>' +
      escapeHtml(
        label
      ) +
      '</span><strong class="' +
      percentClass(
        value
      ) +
      '">' +
      (
        Number(value) > 0
          ? '+'
          : ''
      ) +
      formatNumber(
        value,
        2
      ) +
      '%</strong></div>';

  return (
    '<div class="terminalCard" style="margin-bottom:14px">' +
    '<div class="panelHeader"><div><div class="eyebrow">BEFORE YOU ACT</div><h2>What has already been happening?</h2></div>' +
    '<span class="conditionTag ' +
    escapeHtml(
      String(condition)
        .toLowerCase()
    ) +
    '">' +
    escapeHtml(
      condition
    ) +
    '</span></div>' +
    '<div class="portfolioSummaryStrip">' +
    returnCell(
      '5 sessions',
      returns.d5
    ) +
    returnCell(
      '1 month',
      returns.m1
    ) +
    returnCell(
      '3 months',
      returns.m3
    ) +
    returnCell(
      '1 year',
      returns.y1
    ) +
    '</div>' +
    '<div class="infoBox"><strong>Price structure:</strong> ' +
    escapeHtml(
      situation.trend ||
      'Mixed'
    ) +
    '. ' +
    escapeHtml(
      situation.interpretation ||
      ''
    ) +
    '</div>' +
    '<div class="sourceNote">Historical situation describes existing price conditions even if NOMAD only started monitoring today. It is not a recommendation by itself.</div>' +
    '</div>'
  );
}

/* =========================================================
   MARKET BUTTON
========================================================= */

async function loadExploreMarket(
  manualRefresh = false
) {
  if (exploreRefreshInFlight) {
    return;
  }

  exploreRefreshInFlight =
    true;

  $('error')
    .textContent =
      '';

  if ($('loadMarket')) {
    $('loadMarket')
      .disabled =
        true;
  }

  const status =
    $('exploreLiveStatus');

  if (
    status &&
    !marketRows.length
  ) {
    status.innerHTML =
      '<span class="feedDot delayed"></span>' +
      '<span class="feedMeta">Loading latest PSX market feed...</span>';
  }

  try {
    const result =
      await api(
        'market'
      );

    explorePreviousPrices =
      new Map(
        marketRows.map(
          row => [
            row.symbol,
            row.price
          ]
        )
      );

    marketRows =
      (
        result.stocks ||
        []
      ).filter(
        row =>
          row.marketFactEligible ===
          true
      );

    if (
      manualRefresh ||
      currentPage < 1
    ) {
      currentPage = 1;
    }

    const marketStatus =
      result.marketStatus ||
      null;

    const marketOpen =
      Boolean(
        marketStatus?.known &&
        marketStatus.isOpen
      );

    const marketClosed =
      Boolean(
        marketStatus?.known &&
        !marketStatus.isOpen
      );

    const updatedLabel =
      relativeTime(
        result.marketWatchAsOf ||
        result.asOf
      ) ||
      'now';

    $('coverage')
      .textContent =
        marketOpen
          ? (
              (
                result.sessionChangeCoverage ||
                0
              ) +
              '/' +
              (
                result.marketFactCount ||
                marketRows.length
              ) +
              ' active equities · Official PSX · 10 sec refresh · Updated ' +
              updatedLabel
            )
          : marketClosed
            ? (
                (
                  result.marketFactCount ||
                  marketRows.length
                ) +
                ' active equities · ' +
                marketClosedLabel(
                  marketStatus
                ) +
                ' · Latest session updated ' +
                updatedLabel
              )
            : (
                (
                  result.marketFactCount ||
                  marketRows.length
                ) +
                ' active equities · Market status unavailable · Updated ' +
                updatedLabel
              );

    populateSectors();

    renderStocks();

    if (status) {
      if (marketOpen) {
        status.innerHTML =
          '<span class="feedDot live"></span>' +
          '<span class="feedPrice">Official PSX market feed</span>' +
          '<span class="feedMeta">Active Main Board equities · PSX Data Portal (up to 5 min delayed) · ' +
          escapeHtml(
            updatedLabel
          ) +
          ' · refreshing every 10 sec</span>';
      } else if (marketClosed) {
        status.innerHTML =
          '<span class="feedDot closed"></span>' +
          '<span class="feedPrice">' +
          escapeHtml(
            marketClosedLabel(
              marketStatus
            )
          ) +
          '</span>' +
          '<span class="feedMeta">Showing latest completed Official PSX session · Active Main Board equities · ' +
          escapeHtml(
            updatedLabel
          ) +
          '</span>';
      } else {
        status.innerHTML =
          '<span class="feedDot delayed"></span>' +
          '<span class="feedPrice">Latest PSX snapshot</span>' +
          '<span class="feedMeta">Market status unavailable · ' +
          escapeHtml(
            updatedLabel
          ) +
          '</span>';
      }
    }
  } catch (error) {
    if (!marketRows.length) {
      $('error')
        .textContent =
          error.message;
    }

    if (status) {
      status.innerHTML =
        '<span class="feedDot delayed"></span>' +
        '<span class="feedWarning">Live refresh failed. Keeping the last successful market snapshot.</span>';
    }
  } finally {
    exploreRefreshInFlight =
      false;

    if ($('loadMarket')) {
      $('loadMarket')
        .disabled =
          false;
    }
  }
}

$('loadMarket')
  .onclick =
    () =>
      loadExploreMarket(
        true
      );

/* =========================================================
   METADATA / SECURITY UNIVERSE AUDIT BUTTONS
========================================================= */

$('runMetadataAudit')
  .onclick =
    async () => {
      $('error')
        .textContent =
          '';

      $('runMetadataAudit')
        .disabled =
          true;

      $('metadataAuditProgress')
        .textContent =
          '';

      $('metadataAuditSummary')
        .innerHTML =
          '<p class="muted">' +
          'Loading official PSX bulk listing and status evidence...' +
          '</p>';

      try {
        let result =
          await api(
            'metadata-audit'
          );

        lastMetadataAuditResult =
          result;

        metadataAuditRows =
          result.issues ||
          [];

        metadataAuditUniverseRows =
          result.universe ||
          [];

        metadataAuditPage =
          1;

        renderMetadataAuditSummary(
          result
        );

        $('metadataAuditControls')
          .style
          .display =
            'block';

        $('downloadMetadataAuditCSV')
          .style
          .display =
            'inline-block';

        $('downloadMetadataAuditJSON')
          .style
          .display =
            'inline-block';

        $('metadataAuditView')
          .value =
            'issues';

        $('metadataAuditSearch')
          .value =
            '';

        $('metadataAuditCategory')
          .value =
            '';

        $('metadataAuditUniverseClass')
          .value =
            '';

        $('metadataAuditTradingStatus')
          .value =
            '';

        $('metadataAuditEligibility')
          .value =
            '';

        renderMetadataAuditTable();

        const bulkDiagnostics =
          result.bulkStatusDiagnostics ||
          {};

        const matchBreakdown =
          Object.entries(
            bulkDiagnostics.matchesByReport ||
            {}
          )
            .map(
              ([key, value]) =>
                key + ':' + value
            )
            .join(', ');

        $('metadataAuditProgress')
          .textContent =
            'Bulk PSX status resolution complete. Reports loaded: ' +
            Number(
              bulkDiagnostics.loadedReports ||
              0
            ) +
            '/4; report failures: ' +
            Number(
              bulkDiagnostics.failedReports ||
              0
            ) +
            (
              matchBreakdown
                ? (
                    '; matches: ' +
                    matchBreakdown
                  )
                : ''
            ) +
            '. No mass company-page requests were made and no securities were removed.';
      } catch (error) {
        $('metadataAuditSummary')
          .innerHTML =
            '';

        $('metadataAuditProgress')
          .textContent =
            '';

        $('error')
          .textContent =
            error.message;
      } finally {
        $('runMetadataAudit')
          .disabled =
            false;
      }
    };

$('metadataAuditView')
  .onchange =
    () => {
      metadataAuditPage =
        1;

      renderMetadataAuditTable();
    };

$('metadataAuditSearch')
  .oninput =
    () => {
      metadataAuditPage =
        1;

      renderMetadataAuditTable();
    };

$('metadataAuditCategory')
  .onchange =
    () => {
      metadataAuditPage =
        1;

      renderMetadataAuditTable();
    };

$('metadataAuditUniverseClass')
  .onchange =
    () => {
      metadataAuditPage =
        1;

      renderMetadataAuditTable();
    };


$('metadataAuditTradingStatus')
  .onchange =
    () => {
      metadataAuditPage =
        1;

      renderMetadataAuditTable();
    };

$('metadataAuditEligibility')
  .onchange =
    () => {
      metadataAuditPage =
        1;

      renderMetadataAuditTable();
    };

$('downloadMetadataAuditCSV')
  .onclick =
    downloadMetadataAuditCSV;

$('downloadMetadataAuditJSON')
  .onclick =
    downloadMetadataAuditJSON;

$('metadataAuditPrevious')
  .onclick =
    () => {
      if (
        metadataAuditPage >
        1
      ) {
        metadataAuditPage--;

        renderMetadataAuditTable();
      }
    };

$('metadataAuditNext')
  .onclick =
    () => {
      const pageCount =
        Math.ceil(
          getFilteredMetadataAuditRows()
            .length /
          METADATA_AUDIT_PAGE_SIZE
        );

      if (
        metadataAuditPage <
        pageCount
      ) {
        metadataAuditPage++;

        renderMetadataAuditTable();
      }
    };

/* =========================================================
   FILTER EVENTS
========================================================= */

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

/* =========================================================
   OVERVIEW BUTTON
========================================================= */

$('loadQuote')
  .onclick =
    async () => {
      $('error')
        .textContent =
          '';

      const inputSymbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      if (
        !inputSymbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      showSelectedCompany(
        inputSymbol
      );

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Loading overview...' +
          '</p>';

      try {
        const [
          result,
          situation
        ] =
          await Promise.all([
            api(
              'quote',
              {
                symbol:
                  inputSymbol
              }
            ),
            api(
              'situation',
              {
                symbol:
                  inputSymbol
              }
            ).catch(
              () => null
            )
          ]);

        $('stockSymbol')
          .value =
            result.symbol;

        updateSelectedCompany(
          result
        );

        lastQuoteResult =
          result;

        renderDecisionOverview(
          result
        );

        if (situation?.available) {
          $('research')
            .insertAdjacentHTML(
              'afterbegin',
              buildSituationPanel(
                situation
              )
            );
        }

        startLiveOverview(
          result.symbol,
          result.live ||
          null
        );
      } catch (error) {
        $('error')
          .textContent =
            error.message;
      }
    };

/* =========================================================
   LIVE CHART BUTTON
========================================================= */

$('loadLiveChart')
  .onclick =
    () => {
      $('error')
        .textContent =
          '';

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      if (
        !symbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      startLiveChart(
        symbol
      );
    };

/* =========================================================
   HISTORY BUTTON
========================================================= */

$('loadHistory')
  .onclick =
    () => {
      $('error')
        .textContent =
          '';

      const symbol =
        $('stockSymbol')
          .value
          .trim()
          .toUpperCase();

      if (
        !symbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      loadHistoryView(
        symbol,
        selectedHistoryRange
      );
    };

/* =========================================================
   TECHNICAL BUTTON
========================================================= */

$('loadTechnical')
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

      if (
        !symbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Calculating technical indicators...' +
          '</p>';

      try {
        const result =
          await api(
            'technical',
            {
              symbol
            }
          );

        $('stockSymbol')
          .value =
            result.symbol;

        renderTechnical(
          result
        );
      } catch (error) {
        $('error')
          .textContent =
            error.message;
      }
    };

/* =========================================================
   FUNDAMENTALS BUTTON
========================================================= */

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

      if (
        !symbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Loading fundamentals...' +
          '</p>';

      try {
        const result =
          await api(
            'fundamentals',
            {
              symbol
            }
          );

        $('stockSymbol')
          .value =
            result.symbol;

        renderFundamentals(
          result
        );
      } catch (error) {
        $('error')
          .textContent =
            error.message;
      }
    };

/* =========================================================
   EVENTS BUTTON
========================================================= */

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

      if (
        !symbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      $('research')
        .innerHTML =
          '<p class="muted">' +
          'Loading company events...' +
          '</p>';

      eventMode =
        'key';

      try {
        const result =
          await api(
            'events',
            {
              symbol
            }
          );

        $('stockSymbol')
          .value =
            result.symbol;

        renderEvents(
          result
        );
      } catch (error) {
        $('error')
          .textContent =
            error.message;
      }
    };

/* =========================================================
   MORE BUTTON
========================================================= */

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

      if (
        !symbol
      ) {
        $('error')
          .textContent =
            'Enter a PSX symbol.';

        return;
      }

      stopLiveRefresh();

      $('liveStatus')
        .innerHTML =
          '';

      try {
        let result =
          lastQuoteResult &&
          (
            lastQuoteResult.symbol ===
              symbol ||
            lastQuoteResult
              .identity
              ?.tradingSymbol ===
              symbol
          )
            ? lastQuoteResult
            : null;

        if (
          !result
        ) {
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

        $('stockSymbol')
          .value =
            result.symbol;

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
      }
    };

/* =========================================================
   SYMBOL INPUT
========================================================= */

$('stockSymbol')
  .oninput =
    () => {
      stopLiveRefresh();

      lastQuoteResult =
        null;

      lastEventsResult =
        null;

      selectedHistoryRange =
        '1Y';

      $('liveStatus')
        .innerHTML =
          '';
    };

/* =========================================================
   CONTINUOUS INTELLIGENCE MEMORY
========================================================= */

function renderMemoryTestResult(
  result
) {
  const previousLine =
    result.previousStateFound
      ? (
          '<strong>Previous state found:</strong> Yes' +
          (
            result.previousEvaluatedAt
              ? ' | Saved ' +
                escapeHtml(
                  result.previousEvaluatedAt
                )
              : ''
          )
        )
      : '<strong>Previous state found:</strong> No - first observation';

  const changeLine =
    '<strong>Changes detected:</strong> ' +
    escapeHtml(
      String(
        result.changesDetected ?? 0
      )
    );

  const stateLine =
    '<strong>Current state:</strong> ' +
    escapeHtml(
      result.current?.view || 'N/A'
    ) +
    ' | Price PKR ' +
    escapeHtml(
      result.current?.price === null ||
      result.current?.price === undefined
        ? 'N/A'
        : String(result.current.price)
    );

  const changeRows =
    Array.isArray(result.changes) &&
    result.changes.length
      ? (
          '<div style="margin-top:10px"><strong>Recorded changes</strong><ul>' +
          result.changes
            .map(
              item =>
                '<li>' +
                escapeHtml(
                  item.summary ||
                  item.field_name ||
                  'State change'
                ) +
                ' <span class="muted">(' +
                escapeHtml(
                  item.significance || 'low'
                ) +
                ')</span></li>'
            )
            .join('') +
          '</ul></div>'
        )
      : '';

  $('memoryTestResult')
    .innerHTML =
      '<strong>' +
      escapeHtml(result.symbol || '') +
      ' - ' +
      escapeHtml(result.companyName || '') +
      '</strong><br>' +
      previousLine +
      '<br>' +
      changeLine +
      '<br>' +
      stateLine +
      '<br><span class="muted">' +
      escapeHtml(result.proof || '') +
      '</span>' +
      changeRows;
}

$('runMemoryTest')
  .onclick =
    async () => {
      const button =
        $('runMemoryTest');

      const symbol =
        String(
          $('memoryTestSymbol').value ||
          'HBL'
        )
          .trim()
          .toUpperCase();

      button.disabled = true;
      button.textContent =
        'Testing memory...';

      $('memoryTestResult')
        .textContent =
          'Reading previous state, calculating current state and saving the observation...';

      try {
        const result =
          await api(
            'intelligence-memory-test',
            { symbol }
          );

        renderMemoryTestResult(result);
      } catch (error) {
        $('memoryTestResult')
          .innerHTML =
            '<span class="negative">' +
            escapeHtml(error.message) +
            '</span>';
      } finally {
        button.disabled = false;
        button.textContent =
          'Test persistent memory';
      }
    };



function setPortfolioTransactionMode() {
  const side =
    String(
      $('transactionSide')
        ?.value ||
      'BUY'
    ).toUpperCase();

  document
    .querySelectorAll(
      '#portfolioTransactionModal .tradeField'
    )
    .forEach(
      element => {
        element.hidden =
          side === 'DIVIDEND';
      }
    );

  document
    .querySelectorAll(
      '#portfolioTransactionModal .dividendField'
    )
    .forEach(
      element => {
        element.hidden =
          side !== 'DIVIDEND';
      }
    );
}

function openPortfolioTransactionModal(
  preset = {}
) {
  if (
    !$('portfolioTransactionModal')
  ) {
    return;
  }

  $('transactionSide').value =
    preset.side ||
    'BUY';

  $('transactionSymbol').value =
    preset.symbol ||
    '';

  $('transactionQuantity').value =
    preset.quantity ||
    '';

  $('transactionPrice').value =
    preset.price ||
    '';

  $('transactionCashAmount').value =
    preset.cashAmount ||
    '';

  $('transactionFees').value =
    preset.fees ??
    0;

  $('transactionNotes').value =
    preset.notes ||
    '';

  $('transactionDate').value =
    preset.tradeDate ||
    new Date()
      .toISOString()
      .slice(0, 10);

  $('transactionFormStatus')
    .textContent =
      '';

  setPortfolioTransactionMode();

  $('portfolioTransactionModal').hidden =
    false;

  setTimeout(
    () =>
      $('transactionSymbol')
        .focus(),
    0
  );
}

function closePortfolioTransactionModal() {
  if (
    $('portfolioTransactionModal')
  ) {
    $('portfolioTransactionModal').hidden =
      true;
  }
}

async function savePortfolioTransactionFromForm() {
  const button =
    $('saveTransactionButton');

  if (!button) {
    return;
  }

  button.disabled =
    true;

  $('transactionFormStatus')
    .textContent =
      'Saving transaction and rebuilding your live position...';

  try {
    await apiPost(
      'portfolio-transaction',
      {
        side:
          $('transactionSide')
            .value,
        symbol:
          $('transactionSymbol')
            .value,
        quantity:
          $('transactionQuantity')
            .value ||
          0,
        price:
          $('transactionPrice')
            .value ||
          0,
        cash_amount:
          $('transactionCashAmount')
            .value ||
          0,
        trade_date:
          $('transactionDate')
            .value,
        fees:
          $('transactionFees')
            .value ||
          0,
        notes:
          $('transactionNotes')
            .value ||
          ''
      }
    );

    closePortfolioTransactionModal();
    await loadDecisionCenter();
  } catch (error) {
    $('transactionFormStatus')
      .textContent =
        error.message;
  } finally {
    button.disabled =
      false;
  }
}

function openPortfolioModal(
  preset = {}
) {
  if (!$('portfolioModal')) {
    return;
  }

  $('holdingSymbol').value =
    preset.symbol ||
    '';

  $('holdingQuantity').value =
    preset.quantity ||
    '';

  $('holdingAverageCost').value =
    preset.averageCost ||
    '';

  $('holdingPurchaseDate').value =
    preset.purchaseDate ||
    '';

  $('holdingFees').value =
    preset.fees ??
    0;

  $('holdingFormStatus')
    .textContent =
      '';

  $('portfolioModal').hidden =
    false;

  setTimeout(
    () =>
      $('holdingSymbol')
        .focus(),
    0
  );
}

function closePortfolioModal() {
  if ($('portfolioModal')) {
    $('portfolioModal').hidden =
      true;
  }
}

function parseCsvLine(
  line
) {
  const output = [];
  let current = '';
  let quoted = false;

  for (
    let index = 0;
    index < line.length;
    index++
  ) {
    const char =
      line[index];

    if (char === '"') {
      if (
        quoted &&
        line[index + 1] === '"'
      ) {
        current += '"';
        index += 1;
      } else {
        quoted =
          !quoted;
      }

      continue;
    }

    if (
      char === ',' &&
      !quoted
    ) {
      output.push(
        current.trim()
      );
      current = '';
      continue;
    }

    current +=
      char;
  }

  output.push(
    current.trim()
  );

  return output;
}

function normalizeCsvHeader(
  value
) {
  return String(
    value ||
    ''
  )
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      '_'
    )
    .replace(
      /^_+|_+$/g,
      ''
    );
}

function csvValue(
  row,
  keys
) {
  for (
    const key
    of keys
  ) {
    if (
      row[key] !==
        undefined &&
      row[key] !==
        null &&
      row[key] !==
        ''
    ) {
      return row[key];
    }
  }

  return '';
}

async function importPortfolioCsv(
  file
) {
  const text =
    await file.text();

  const lines =
    text
      .split(/\\r?\\n/)
      .filter(
        line =>
          line.trim()
      );

  if (lines.length < 2) {
    throw new Error(
      'CSV needs a header row and at least one data row.'
    );
  }

  const headers =
    parseCsvLine(
      lines[0]
    ).map(
      normalizeCsvHeader
    );

  const transactionMode =
    headers.some(
      header =>
        [
          'side',
          'type',
          'action',
          'transaction_type',
          'trade_type'
        ].includes(
          header
        )
    );

  let imported = 0;
  const errors = [];

  for (
    let index = 1;
    index < lines.length;
    index++
  ) {
    const values =
      parseCsvLine(
        lines[index]
      );

    const row = {};

    headers.forEach(
      (
        header,
        column
      ) => {
        row[header] =
          values[column] ||
          '';
      }
    );

    let action =
      'portfolio-holding';

    let payload;

    if (transactionMode) {
      action =
        'portfolio-transaction';

      payload = {
        side:
          csvValue(
            row,
            [
              'side',
              'type',
              'action',
              'transaction_type',
              'trade_type'
            ]
          ),
        symbol:
          csvValue(
            row,
            [
              'symbol',
              'ticker',
              'stock'
            ]
          ),
        quantity:
          csvValue(
            row,
            [
              'quantity',
              'qty',
              'shares'
            ]
          ) ||
          0,
        price:
          csvValue(
            row,
            [
              'price',
              'trade_price',
              'buy_price',
              'sell_price',
              'purchase_price'
            ]
          ) ||
          0,
        trade_date:
          csvValue(
            row,
            [
              'trade_date',
              'date',
              'purchase_date',
              'buy_date',
              'sell_date'
            ]
          ) ||
          null,
        fees:
          csvValue(
            row,
            [
              'fees',
              'fee',
              'charges',
              'brokerage'
            ]
          ) ||
          0,
        cash_amount:
          csvValue(
            row,
            [
              'cash_amount',
              'dividend_amount',
              'amount'
            ]
          ) ||
          0,
        notes:
          csvValue(
            row,
            [
              'notes',
              'note',
              'reference'
            ]
          ) ||
          ''
      };
    } else {
      payload = {
        symbol:
          csvValue(
            row,
            [
              'symbol',
              'ticker',
              'stock'
            ]
          ),
        quantity:
          csvValue(
            row,
            [
              'quantity',
              'qty',
              'shares'
            ]
          ),
        average_cost:
          csvValue(
            row,
            [
              'average_cost',
              'avg_cost',
              'cost',
              'buy_price',
              'purchase_price'
            ]
          ),
        purchase_date:
          csvValue(
            row,
            [
              'purchase_date',
              'buy_date',
              'date'
            ]
          ) ||
          null,
        fees:
          csvValue(
            row,
            [
              'fees',
              'fee'
            ]
          ) ||
          0
      };
    }

    try {
      await apiPost(
        action,
        payload
      );

      imported +=
        1;
    } catch (error) {
      errors.push(
        'Row ' +
        (index + 1) +
        ': ' +
        error.message
      );
    }
  }

  await loadDecisionCenter();

  return {
    imported,
    errors,
    mode:
      transactionMode
        ? 'transactions'
        : 'holdings'
  };
}

async function saveHoldingFromForm() {
  const button =
    $('saveHoldingButton');

  button.disabled =
    true;

  $('holdingFormStatus')
    .textContent =
      'Saving holding and checking its recent history...';

  try {
    await apiPost(
      'portfolio-holding',
      {
        symbol:
          $('holdingSymbol')
            .value,
        quantity:
          $('holdingQuantity')
            .value,
        average_cost:
          $('holdingAverageCost')
            .value,
        purchase_date:
          $('holdingPurchaseDate')
            .value ||
          null,
        fees:
          $('holdingFees')
            .value ||
          0
      }
    );

    closePortfolioModal();
    await loadDecisionCenter();
  } catch (error) {
    $('holdingFormStatus')
      .textContent =
        error.message;
  } finally {
    button.disabled =
      false;
  }
}

/* =========================================================
   APP SHELL EVENTS
========================================================= */

document
  .querySelectorAll(
    '.navButton[data-nav]'
  )
  .forEach(
    button => {
      button.onclick =
        () =>
          openAppPage(
            button.dataset.nav
          );
    }
  );

window.addEventListener(
  'popstate',
  () => {
    openAppPage(
      appPageFromLocation(),
      {
        updateLocation: false,
        scrollToTop: false
      }
    );
  }
);

document
  .querySelectorAll(
    '[data-open-page]'
  )
  .forEach(
    button => {
      button.onclick =
        () =>
          openAppPage(
            button.dataset.openPage
          );
    }
  );

if ($('globalSymbolSearch')) {
  $('globalSymbolSearch')
    .onkeydown =
      event => {
        if (event.key !== 'Enter') {
          return;
        }

        const symbol =
          String(
            $('globalSymbolSearch')
              .value ||
            ''
          )
            .trim()
            .toUpperCase();

        if (!symbol) {
          return;
        }

        $('stockSymbol')
          .value =
            symbol;

        openAppPage(
          'research'
        );

        $('loadQuote')
          .click();
      };
}

if ($('askNomadButton')) {
  $('askNomadButton')
    .onclick =
      () => {
        alert(
          'Ask NOMAD will become the conversational layer on top of the validated intelligence engine. The current build is establishing the engine first.'
        );
      };
}

if ($('refreshIntelligenceFeed')) {
  $('refreshIntelligenceFeed')
    .onclick =
      () =>
        loadDecisionCenter();
}


[
  'homeRecordTrade',
  'portfolioRecordTrade'
]
  .forEach(
    id => {
      if ($(id)) {
        $(id).onclick =
          () =>
            openPortfolioTransactionModal();
      }
    }
  );

[
  'homeAddHolding',
  'portfolioAddHolding'
]
  .forEach(
    id => {
      if ($(id)) {
        $(id).onclick =
          () =>
            openPortfolioModal();
      }
    }
  );

[
  'homeImportPortfolio',
  'portfolioImportCsv'
]
  .forEach(
    id => {
      if ($(id)) {
        $(id).onclick =
          () =>
            $('portfolioCsvInput')
              .click();
      }
    }
  );

if ($('closePortfolioModal')) {
  $('closePortfolioModal')
    .onclick =
      closePortfolioModal;
}

if ($('cancelHoldingButton')) {
  $('cancelHoldingButton')
    .onclick =
      closePortfolioModal;
}

if ($('saveHoldingButton')) {
  $('saveHoldingButton')
    .onclick =
      saveHoldingFromForm;
}

if ($('portfolioModal')) {
  $('portfolioModal')
    .onclick =
      event => {
        if (
          event.target ===
          $('portfolioModal')
        ) {
          closePortfolioModal();
        }
      };
}


if ($('transactionSide')) {
  $('transactionSide')
    .onchange =
      setPortfolioTransactionMode;
}

if ($('saveTransactionButton')) {
  $('saveTransactionButton')
    .onclick =
      savePortfolioTransactionFromForm;
}

if ($('cancelTransactionButton')) {
  $('cancelTransactionButton')
    .onclick =
      closePortfolioTransactionModal;
}

if ($('closePortfolioTransactionModal')) {
  $('closePortfolioTransactionModal')
    .onclick =
      closePortfolioTransactionModal;
}

if ($('portfolioTransactionModal')) {
  $('portfolioTransactionModal')
    .onclick =
      event => {
        if (
          event.target ===
          $('portfolioTransactionModal')
        ) {
          closePortfolioTransactionModal();
        }
      };
}

if ($('portfolioCsvInput')) {
  $('portfolioCsvInput')
    .onchange =
      async event => {
        const file =
          event.target
            .files?.[0];

        if (!file) {
          return;
        }

        try {
          const result =
            await importPortfolioCsv(
              file
            );

          alert(
            'Imported ' +
            result.imported +
            (
              result.mode === 'transactions'
                ? ' transaction(s).'
                : ' holding(s).'
            ) +
            (
              result.errors.length
                ? '\\n' +
                  result.errors
                    .slice(0, 5)
                    .join('\\n')
                : ''
            )
          );
        } catch (error) {
          alert(
            error.message
          );
        } finally {
          event.target.value =
            '';
        }
      };
}


function decisionActionLabel(
  action
) {
  const labels = {
    BUY_NOW: 'BUY NOW',
    STAGED_BUY: 'STAGED BUY',
    BUY: 'BUY',
    ACCUMULATE: 'ACCUMULATE',
    WATCH: 'WATCH',
    HOLD: 'HOLD',
    RESEARCH_REQUIRED:
      'EVIDENCE RESEARCH',
    EVIDENCE_RESEARCH:
      'EVIDENCE RESEARCH',
    RESEARCHING: 'RESEARCHING',
    NO_ACTION_YET: 'NO ACTION YET',
    HOLD_RESEARCH: 'HOLD / RESEARCH',
    ADD_CANDIDATE: 'ADD',
    REVIEW_REDUCE: 'REVIEW / REDUCE',
    WAIT: 'WAIT',
    WAIT_DATA: 'WAIT / DATA',
    DATA_BLOCKED: 'DATA BLOCKED',
    AVOID: 'AVOID',
    INVEST: 'INVEST',
    PARTIAL_INVEST:
      'PARTIAL INVEST',
    ADD: 'ADD',
    NO_ADD: 'NO ADD',
    DO_NOT_ADD: 'DO NOT ADD'
  };

  return labels[action] ||
    String(
      action ||
      'WATCH'
    ).replace(
      /_/g,
      ' '
    );
}

function renderOpportunityList(
  targetId,
  items,
  emptyText
) {
  const target =
    $(targetId);

  if (!target) {
    return;
  }

  const list =
    Array.isArray(items)
      ? items
      : [];

  if (!list.length) {
    target.innerHTML =
      '<div class="terminalEmpty small">' +
      escapeHtml(
        emptyText
      ) +
      '</div>';
    return;
  }

  target.innerHTML =
    list.map(
      item => {
        const firstRisk =
          item.risks?.[0] ||
          '';

        const analyst =
          item.analyst ||
          {};

        const professional =
          item.professional ||
          {};

        const isShortTerm =
          professional.framework ===
            'SHORT_TERM_TRADER';

        const canonicalEvidence =
          item.canonicalState
            ?.evidence ||
          {};

        const evidenceMeta =
          isShortTerm
            ? (
                ' · Technical evidence ' +
                escapeHtml(
                  canonicalEvidence.confidence ||
                  'UNRESOLVED'
                ) +
                ' · Coverage ' +
                formatNumber(
                  canonicalEvidence.technicalCoveragePct ||
                  canonicalEvidence.score ||
                  0,
                  0
                ) +
                '%' +
                ' · Plan ' +
                escapeHtml(
                  canonicalEvidence.setupCompleteness ||
                  'INCOMPLETE'
                )
              )
            : (
                ' · Headline financials ' +
                escapeHtml(
                  analyst.financialView ||
                  'UNAVAILABLE'
                ) +
                ' · Evidence ' +
                escapeHtml(
                  analyst.evidenceConfidence ||
                  'UNRESOLVED'
                ) +
                ' · Summary ' +
                (
                  analyst.coveragePct !== null &&
                  analyst.coveragePct !== undefined
                    ? formatNumber(
                        analyst.coveragePct,
                        0
                      ) + '%'
                    : 'N/A'
                ) +
                (
                  analyst.extendedCoveragePct !== null &&
                  analyst.extendedCoveragePct !== undefined
                    ? ' · Extended ' +
                      formatNumber(
                        analyst.extendedCoveragePct,
                        0
                      ) + '%'
                    : ''
                )
              );

        return (
          '<div class="opportunityRow">' +
          '<div class="opportunityRank">#' +
          escapeHtml(
            item.rank
          ) +
          '</div>' +
          '<div>' +
          '<div class="opportunityIdentity"><strong>' +
          escapeHtml(
            item.symbol
          ) +
          '</strong><span>' +
          escapeHtml(
            item.companyName ||
            ''
          ) +
          '</span><button type="button" class="opportunityAnalyzeButton" data-strategy-symbol="' +
          escapeHtml(
            item.symbol
          ) +
          '">Analyze</button></div>' +
          '<div class="opportunityMeta">PKR ' +
          formatNumber(
            item.price,
            2
          ) +
          ' · ' +
          escapeHtml(
            item.sector ||
            'Unknown sector'
          ) +
          evidenceMeta +
          (
            professional.thesisStatus
              ? (
                  isShortTerm
                    ? ' · State '
                    : ' · Thesis '
                ) +
                escapeHtml(
                  professional.thesisStatus
                )
              : ''
          ) +
          (
            professional.timingState
              ? ' · Timing ' +
                escapeHtml(
                  professional.timingState
                )
              : ''
          ) +
          (
            item.profileSuitability?.state
              ? ' · Profile ' +
                escapeHtml(
                  item.profileSuitability.state === 'SUITABLE'
                    ? 'SUITABLE'
                    : 'NOT SUITABLE'
                )
              : ''
          ) +
          (
            professional.setup &&
            professional.framework === 'SHORT_TERM_TRADER'
              ? ' · Setup ' +
                escapeHtml(
                  professional.setup
                )
              : ''
          ) +
          '</div>' +
          '<div class="opportunityReason">' +
          escapeHtml(
            item.reason ||
            ''
          ) +
          '</div>' +
          (
            firstRisk
              ? '<div class="opportunityConcern">Risk: ' +
                escapeHtml(
                  firstRisk
                ) +
                '</div>'
              : ''
          ) +
          '</div>' +
          '<div class="opportunityAction ' +
          escapeHtml(
            String(
              item.decisionCenterView ||
              ''
            ).toLowerCase()
          ) +
          '">' +
          escapeHtml(
            (
              ['BUY', 'ACCUMULATE', 'WATCH', 'AVOID'].includes(
                String(item.decisionCenterView || '').toUpperCase()
              )
                ? 'Market: '
                : ''
            ) +
            decisionActionLabel(
              item.decisionCenterView
            )
          ) +
          '</div>' +
          '</div>'
        );
      }
    ).join('');
}

function strategyValue(
  value,
  suffix = ''
) {
  return value === null ||
    value === undefined ||
    value === ''
      ? '—'
      : escapeHtml(
          String(value)
        ) +
        suffix;
}

function strategyMetricCard(
  label,
  value
) {
  return (
    '<div class="strategyMetric"><span>' +
    escapeHtml(label) +
    '</span><strong>' +
    value +
    '</strong></div>'
  );
}

function strategyRiskKey(
  value
) {
  const text =
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  if (
    text.includes('annualized volatility') &&
    text.includes('profile')
  ) {
    return 'profile-volatility';
  }

  if (
    text.includes('moving average') &&
    (
      text.includes('short') ||
      text.includes('medium')
    )
  ) {
    return 'moving-average-structure';
  }

  if (
    text.includes('fundamental metric coverage')
  ) {
    return 'fundamental-coverage';
  }

  return text;
}

function uniqueStrategyRisks(
  values
) {
  const seen = new Set();
  const output = [];

  for (
    const value
    of values || []
  ) {
    if (!value) {
      continue;
    }

    const key =
      strategyRiskKey(
        value
      );

    if (
      !key ||
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}

function renderStockStrategy(
  result
) {
  const target =
    $('stockStrategyResult');

  if (!target) {
    return;
  }

  const professional =
    result?.professional || {};
  const personal =
    result?.personal || {};
  const technical =
    result?.technical || {};
  const performance =
    result?.performance || {};
  const financial =
    result?.financial || {};
  const valuation =
    result?.valuation || {};
  const risk =
    result?.risk || {};
  const evidence =
    result?.evidence || {};
  const suitability =
    result?.riskSuitability || {};
  const isShortTerm =
    result?.input?.horizon ===
      'short_term';

  const actionable =
    professional.marketAction === 'BUY' ||
    professional.marketAction === 'ACCUMULATE';

  const actionClass =
    actionable
      ? 'good'
      : professional.marketAction === 'AVOID'
        ? 'bad'
        : 'warn';

  const personalClass =
    String(personal.action || '').includes('AVOID') ||
    String(personal.action || '').includes('REDUCE') ||
    String(personal.action || '').includes('DO_NOT')
      ? 'bad'
      : String(personal.action || '').includes('ADD') ||
        personal.action === 'BUY' ||
        personal.action === 'ACCUMULATE'
          ? 'good'
          : 'warn';

  const suitabilityClass =
    suitability.state === 'SUITABLE'
      ? 'good'
      : 'bad';

  const price = result?.market?.price;
  const dayChange = result?.market?.dayChangePct;

  let html =
    '<div class="stockStrategyHeadline">' +
    '<div class="stockStrategyIdentity"><strong>' +
    escapeHtml(result?.identity?.symbol || '') +
    ' · ' +
    escapeHtml(result?.identity?.companyName || '') +
    '</strong><span>' +
    escapeHtml(result?.identity?.sector || '') +
    ' · PKR ' +
    formatNumber(price, 2) +
    (
      dayChange !== null &&
      dayChange !== undefined
        ? ' · Today ' +
          formatPercent(dayChange)
        : ''
    ) +
    '</span></div>' +
    '<div class="stockStrategyBadges">' +
    '<span class="strategyBadge ' + actionClass + '">Market: ' +
    escapeHtml(
      decisionActionLabel(
        professional.marketAction ||
        'UNRESOLVED'
      )
    ) +
    '</span>' +
    '<span class="strategyBadge ' + personalClass + '">You: ' +
    escapeHtml(
      decisionActionLabel(
        personal.action ||
        'UNRESOLVED'
      )
    ) +
    '</span>' +
    '<span class="strategyBadge ' + suitabilityClass + '">' +
    escapeHtml(
      suitability.state ||
      'UNRESOLVED'
    ) +
    ' for ' +
    escapeHtml(result?.input?.risk || '') +
    '</span>' +
    '</div></div>';

  if (isShortTerm) {
    html +=
      '<div class="strategyMetricGrid">' +
      strategyMetricCard(
        'Setup',
        strategyValue(technical.setup)
      ) +
      strategyMetricCard(
        'Trend structure',
        strategyValue(
          technical.structureBias ||
          technical.trend
        )
      ) +
      strategyMetricCard(
        'Trader risk',
        strategyValue(risk.state)
      ) +
      strategyMetricCard(
        'Your risk fit',
        strategyValue(suitability.state)
      ) +
      strategyMetricCard(
        'Timing',
        strategyValue(technical.timingState)
      ) +
      strategyMetricCard(
        'Technical evidence',
        strategyValue(evidence.confidence)
      ) +
      strategyMetricCard(
        'Reward / risk',
        technical.rewardRisk !== null &&
        technical.rewardRisk !== undefined
          ? formatNumber(technical.rewardRisk, 2) + 'x'
          : '—'
      ) +
      '</div>';
  } else {
    html +=
      '<div class="strategyMetricGrid">' +
      strategyMetricCard(
        'Thesis',
        strategyValue(professional.thesisStatus)
      ) +
      strategyMetricCard(
        'Valuation',
        strategyValue(valuation.state)
      ) +
      strategyMetricCard(
        'Company risk',
        strategyValue(risk.state)
      ) +
      strategyMetricCard(
        'Your risk fit',
        strategyValue(suitability.state)
      ) +
      strategyMetricCard(
        'Timing',
        strategyValue(technical.timingState)
      ) +
      strategyMetricCard(
        'Evidence',
        strategyValue(evidence.confidence)
      ) +
      strategyMetricCard(
        'Current holding',
        personal.hasPosition
          ? formatNumber(
              personal.currentPortfolioWeightPct,
              1
            ) + '%'
          : 'None'
      ) +
      '</div>';
  }

  html +=
    '<p class="strategyReason"><strong>NOMAD view:</strong> ' +
    escapeHtml(professional.reason || '') +
    '</p>' +
    '<p class="strategyReason"><strong>Your action:</strong> ' +
    escapeHtml(personal.reason || '') +
    '</p>';

  if (isShortTerm) {
    const entryText =
      technical.entryLow !== null &&
      technical.entryLow !== undefined &&
      technical.entryHigh !== null &&
      technical.entryHigh !== undefined
        ? 'PKR ' +
          formatNumber(technical.entryLow, 2) +
          ' – ' +
          formatNumber(technical.entryHigh, 2)
        : '—';

    html +=
      '<div class="strategySections">' +
      '<div class="strategySection"><h3>Trade setup & execution</h3>' +
      '<div class="strategyLine"><span>5 sessions</span><strong>' +
      formatPercent(performance.d5Pct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>1 month</span><strong>' +
      formatPercent(performance.m1Pct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Structure</span><strong>' +
      strategyValue(
        technical.structureBias ||
        technical.trend
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Setup</span><strong>' +
      strategyValue(technical.setup) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Candle</span><strong>' +
      strategyValue(technical.candlePattern) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Entry zone</span><strong>' +
      entryText +
      '</strong></div>' +
      '<div class="strategyLine"><span>Stop / invalidation</span><strong>' +
      (
        technical.stop !== null &&
        technical.stop !== undefined
          ? 'PKR ' +
            formatNumber(technical.stop, 2)
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Target 1</span><strong>' +
      (
        technical.target1 !== null &&
        technical.target1 !== undefined
          ? 'PKR ' +
            formatNumber(technical.target1, 2)
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Target 2</span><strong>' +
      (
        technical.target2 !== null &&
        technical.target2 !== undefined
          ? 'PKR ' +
            formatNumber(technical.target2, 2)
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Reward / risk</span><strong>' +
      (
        technical.rewardRisk !== null &&
        technical.rewardRisk !== undefined
          ? formatNumber(technical.rewardRisk, 2) + 'x'
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Risk / share</span><strong>' +
      (
        technical.riskPerShare !== null &&
        technical.riskPerShare !== undefined
          ? 'PKR ' +
            formatNumber(technical.riskPerShare, 2)
          : '—'
      ) +
      '</strong></div>' +
      '</div>' +
      '<div class="strategySection"><h3>Trader evidence & risk</h3>' +
      '<div class="strategyLine"><span>Technical evidence</span><strong>' +
      strategyValue(evidence.confidence) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Technical coverage</span><strong>' +
      formatNumber(
        evidence.technicalCoveragePct ||
        evidence.score ||
        0,
        0
      ) + '%</strong></div>' +
      '<div class="strategyLine"><span>Setup plan</span><strong>' +
      strategyValue(
        evidence.setupCompleteness ||
        technical.tradePlanState
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>History sessions</span><strong>' +
      strategyValue(evidence.validSessions) +
      '</strong></div>' +
      '<div class="strategyLine"><span>RSI 14</span><strong>' +
      strategyValue(
        technical.rsi14 !== null &&
        technical.rsi14 !== undefined
          ? formatNumber(technical.rsi14, 2)
          : null
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>MACD histogram</span><strong>' +
      strategyValue(
        technical.macdHistogram !== null &&
        technical.macdHistogram !== undefined
          ? formatNumber(
              technical.macdHistogram,
              4
            )
          : null
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Volume vs 20D avg</span><strong>' +
      (
        technical.volumeRatio20d !== null &&
        technical.volumeRatio20d !== undefined
          ? formatNumber(
              technical.volumeRatio20d,
              2
            ) + 'x'
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>ATR 14</span><strong>' +
      (
        technical.atr14 !== null &&
        technical.atr14 !== undefined
          ? 'PKR ' +
            formatNumber(technical.atr14, 2) +
            (
              technical.atrPct !== null &&
              technical.atrPct !== undefined
                ? ' (' +
                  formatPercent(
                    technical.atrPct
                  ) +
                  ')'
                : ''
            )
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>20D annualized volatility</span><strong>' +
      formatPercent(
        risk.annualizedVolatility20dPct
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>30D average volume</span><strong>' +
      formatNumber(
        risk.averageVolume30d ||
        0,
        0
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Financial context</span><strong>' +
      strategyValue(
        financial.headlineView ||
        'SECONDARY'
      ) +
      '</strong></div>' +
      '</div></div>';

    if (technical.invalidation) {
      html +=
        '<p class="strategyReason"><strong>Invalidation:</strong> ' +
        escapeHtml(technical.invalidation) +
        '</p>';
    }
  } else {
    html +=
      '<div class="strategySections">' +
      '<div class="strategySection"><h3>Performance & price action</h3>' +
      '<div class="strategyLine"><span>5 sessions</span><strong>' +
      formatPercent(performance.d5Pct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>1 month</span><strong>' +
      formatPercent(performance.m1Pct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>3 months</span><strong>' +
      formatPercent(performance.m3Pct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>1 year</span><strong>' +
      formatPercent(performance.y1Pct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Trend</span><strong>' +
      strategyValue(technical.trend) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Setup</span><strong>' +
      strategyValue(technical.setup) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Candle</span><strong>' +
      strategyValue(technical.candlePattern) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Support</span><strong>' +
      (
        technical.support !== null &&
        technical.support !== undefined
          ? 'PKR ' +
            formatNumber(
              technical.support,
              2
            )
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Resistance</span><strong>' +
      (
        technical.resistance !== null &&
        technical.resistance !== undefined
          ? 'PKR ' +
            formatNumber(
              technical.resistance,
              2
            )
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Reward / risk</span><strong>' +
      (
        technical.rewardRisk !== null &&
        technical.rewardRisk !== undefined
          ? formatNumber(
              technical.rewardRisk,
              2
            ) + 'x'
          : '—'
      ) +
      '</strong></div>' +
      '</div>' +
      '<div class="strategySection"><h3>Professional evidence</h3>' +
      '<div class="strategyLine"><span>Headline financials</span><strong>' +
      strategyValue(
        financial.headlineView ||
        financial.overall
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Deep financial validation</span><strong>' +
      strategyValue(financial.deepValidation) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Earnings quality</span><strong>' +
      strategyValue(financial.earningsQuality) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Cash flow</span><strong>' +
      strategyValue(financial.cashFlowQuality) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Balance sheet</span><strong>' +
      strategyValue(financial.balanceSheet) +
      '</strong></div>' +
      '<div class="strategyLine"><span>P/E</span><strong>' +
      (
        valuation.peRatio !== null &&
        valuation.peRatio !== undefined
          ? formatNumber(
              valuation.peRatio,
              2
            ) + 'x'
          : '—'
      ) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Dividend yield</span><strong>' +
      formatPercent(valuation.dividendYield) +
      '</strong></div>' +
      '<div class="strategyLine"><span>20D volatility</span><strong>' +
      formatPercent(risk.annualizedVolatility20dPct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>52W max drawdown</span><strong>' +
      formatPercent(risk.maxDrawdown52wPct) +
      '</strong></div>' +
      '<div class="strategyLine"><span>Summary evidence</span><strong>' +
      formatNumber(
        evidence.summaryCoveragePct ||
        0,
        0
      ) + '%</strong></div>' +
      '<div class="strategyLine"><span>Extended evidence</span><strong>' +
      formatNumber(
        evidence.extendedCoveragePct ||
        0,
        0
      ) + '%</strong></div>' +
      '</div></div>';
  }

  const issues =
    Array.isArray(suitability.issues)
      ? suitability.issues
      : [];

  const risks =
    uniqueStrategyRisks([
      ...issues,
      ...(result?.reasons?.risks || []),
      ...(technical.risks || [])
    ]).slice(0, 6);

  if (risks.length) {
    html +=
      '<div class="strategySection" style="margin-top:10px"><h3>What NOMAD is watching</h3><ul class="strategyRiskList">' +
      risks.map(
        item =>
          '<li>' +
          escapeHtml(item) +
          '</li>'
      ).join('') +
      '</ul></div>';
  }

  target.innerHTML = html;
}

async function loadStockStrategy(
  symbolOverride
) {
  const symbol =
    String(
      symbolOverride ||
      $('strategySymbol')
        ?.value ||
      ''
    )
      .trim()
      .toUpperCase();

  if (!symbol) {
    $('stockStrategyResult')
      .innerHTML =
        '<div class="terminalEmpty small">Enter a PSX symbol first.</div>';
    return;
  }

  $('strategySymbol')
    .value =
      symbol;

  const button =
    $('analyzeStockStrategy');

  const original =
    button?.textContent ||
    'Analyze stock';

  if (button) {
    button.disabled = true;
    button.textContent =
      'Analyzing...';
  }

  $('stockStrategyResult')
    .innerHTML =
      '<div class="terminalEmpty small">NOMAD is analyzing the company, evidence, valuation, risk, portfolio fit and price action...</div>';

  try {
    const result =
      await apiPost(
        'stock-strategy',
        {
          symbol,
          horizon:
            $('strategyHorizon')
              .value,
          risk:
            $('strategyRisk')
              .value
        }
      );

    renderStockStrategy(
      result
    );
  } catch (error) {
    $('stockStrategyResult')
      .innerHTML =
        '<div class="terminalEmpty small">' +
        escapeHtml(
          error.message ||
          'Stock strategy analysis failed.'
        ) +
        '</div>';
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent =
        original;
    }
  }
}

function renderOpportunityBoard(
  result
) {
  const board =
    result?.opportunityBoard ||
    {};

  const priority1 =
    board.priority1 ||
    [];

  const priority2 =
    board.priority2 ||
    [];

  const research =
    board.evidenceResearch ||
    board.researchRequired ||
    [];

  const avoid =
    board.avoid ||
    [];

  renderOpportunityList(
    'priorityOneList',
    priority1,
    'No company currently earns Priority 1 under the tiered analyst-evidence gate.'
  );

  renderOpportunityList(
    'priorityTwoList',
    priority2,
    'No Priority 2 opportunity currently stands out.'
  );

  renderOpportunityList(
    'researchRequiredList',
    research,
    'No shortlisted company is currently in automatic evidence research.'
  );

  renderOpportunityList(
    'avoidList',
    avoid,
    'No evidence-backed avoid candidate in the current deep shortlist.'
  );

  if ($('priorityOneCount')) {
    $('priorityOneCount')
      .textContent =
        priority1.length;
  }

  if ($('priorityTwoCount')) {
    $('priorityTwoCount')
      .textContent =
        priority2.length;
  }

  if ($('researchRequiredCount')) {
    $('researchRequiredCount')
      .textContent =
        research.length;
  }

  if ($('avoidCount')) {
    $('avoidCount')
      .textContent =
        avoid.length;
  }
}

function renderDecisionAudit(
  result
) {
  const target =
    $('decisionAudit');

  if (!target) {
    return;
  }

  const screening =
    result?.screening ||
    {};

  const metrics = [
    [
      'Eligible universe',
      screening.eligibleUniverse
    ],
    [
      'Liquidity passed',
      screening.liquidityPassed
    ],
    [
      'Shortlisted',
      screening.shortlisted
    ],
    [
      'History analyzed',
      screening.historicalAnalyzed
    ],
    [
      'Deep attempts',
      screening.deepAnalyzed
    ],
    [
      'Comparable set',
      screening.comparableAnalyzed
    ],
    [
      'Actionable fit',
      screening.actionableProfileFit
    ],
    [
      'Research target',
      screening.actionableResearchTarget
    ],
    [
      'Target deploy %',
      result?.allocationDiagnostics
        ?.targetDeploymentPct
    ],
    [
      'Shadow conviction /100',
      result?.allocationDiagnostics
        ?.averageConvictionScore
    ],
    [
      'Evidence research',
      screening.evidenceResearch
    ],
    [
      'Data blocked',
      screening.dataBlocked
    ]
  ];

  target.innerHTML =
    metrics.map(
      item =>
        '<div class="auditMetric"><span>' +
        escapeHtml(
          item[0]
        ) +
        '</span><strong>' +
        formatNumber(
          item[1] ||
          0,
          0
        ) +
        '</strong></div>'
    ).join('');
}

function homeDecisionSummaryData(
  result
) {
  const board =
    result?.opportunityBoard ||
    {};

  return {
    savedAt:
      new Date()
        .toISOString(),
    action:
      result?.decision?.action ||
      'WATCH',
    headline:
      result?.decision?.headline ||
      '',
    amount:
      result?.input?.amount ||
      0,
    invested:
      result?.decision
        ?.amountInvestedPkr ||
      0,
    cash:
      result?.decision
        ?.cashRemainingPkr ||
      0,
    priority1:
      (board.priority1 || [])
        .map(
          item =>
            item.symbol
        )
        .slice(0, 5),
    priority2Count:
      (board.priority2 || [])
        .length,
    researchCount:
      (board.researchRequired || [])
        .length
  };
}

function renderHomeDecisionSummary(
  summary
) {
  const target =
    $('homeDecisionSummary');

  if (!target) {
    return;
  }

  if (!summary) {
    target.innerHTML =
      '<div class="terminalEmpty">Run your first analysis in Decision Center.</div>';
    return;
  }

  target.innerHTML =
    '<div class="homeDecisionHeadline"><div><strong>' +
    escapeHtml(
      decisionActionLabel(
        summary.action
      )
    ) +
    '</strong><div class="homeDecisionMeta">' +
    escapeHtml(
      summary.headline ||
      ''
    ) +
    '</div></div><div class="homeDecisionMeta">PKR ' +
    formatNumber(
      summary.amount,
      0
    ) +
    '</div></div>' +
    '<div class="homeDecisionMeta">Allocate PKR ' +
    formatNumber(
      summary.invested,
      0
    ) +
    ' · Keep PKR ' +
    formatNumber(
      summary.cash,
      0
    ) +
    ' cash · Priority 2: ' +
    formatNumber(
      summary.priority2Count,
      0
    ) +
    ' · Evidence research: ' +
    formatNumber(
      summary.researchCount,
      0
    ) +
    '</div>' +
    (
      summary.priority1?.length
        ? '<div class="homeDecisionSymbols">' +
          summary.priority1
            .map(
              symbol =>
                '<span>' +
                escapeHtml(
                  symbol
                ) +
                '</span>'
            )
            .join('') +
          '</div>'
        : ''
    );
}

function renderShadowDecision(
  result
) {
  const target =
    $('decisionResult');

  if (!target) {
    return;
  }

  if (!result?.decision) {
    target.innerHTML =
      '<strong>Decision engine returned no result.</strong>';
    return;
  }

  const decision =
    result.decision;

  const allocations =
    Array.isArray(
      result.allocations
    )
      ? result.allocations
      : [];

  let html =
    '<div class="decisionShadowBanner">SHADOW MODEL · NOT REAL-MONEY ELIGIBLE</div>' +
    '<div class="decisionOutcome">' +
    '<div><strong>' +
    escapeHtml(
      decisionActionLabel(
        decision.action
      )
    ) +
    '</strong><div class="decisionMinor">' +
    escapeHtml(
      decision.headline ||
      ''
    ) +
    '</div></div>' +
    '<span>' +
    (
      result?.input?.horizon === 'short_term'
        ? 'Technical evidence ' +
          escapeHtml(
            decision.evidence
              ?.confidence ||
            'UNRESOLVED'
          ) +
          ' · Coverage ' +
          formatNumber(
            decision.evidence
              ?.technicalCoveragePct ||
            decision.evidence
              ?.score ||
            0,
            0
          ) +
          '% · Trade plan ' +
          escapeHtml(
            decision.evidence
              ?.setupCompleteness ||
            'INCOMPLETE'
          )
        : 'Evidence confidence ' +
          escapeHtml(
            decision.evidence
              ?.confidence ||
            'UNRESOLVED'
          ) +
          ' · Summary ' +
          formatNumber(
            decision.evidence
              ?.summaryCoveragePct ||
            0,
            0
          ) +
          '% · Extended ' +
          formatNumber(
            decision.evidence
              ?.extendedCoveragePct ||
            0,
            0
          ) +
          '%'
    ) +
    '</span>' +
    '</div>' +
    '<div class="decisionMoneyLine">' +
    '<div><span>Requested</span><strong>PKR ' +
    formatNumber(
      result.input?.amount ||
      0,
      0
    ) +
    '</strong></div>' +
    '<div><span>Buy now</span><strong>PKR ' +
    formatNumber(
      decision.amountInvestedPkr ||
      0,
      0
    ) +
    '</strong></div>' +
    '<div><span>Cash retained</span><strong>PKR ' +
    formatNumber(
      decision.cashRemainingPkr ||
      0,
      0
    ) +
    '</strong></div>' +
    '</div>' +
    '<div class="decisionMetaLine">' +
    escapeHtml(
      decision.reason ||
      ''
    ) +
    '</div>';

  if (
    result?.allocationDiagnostics
      ?.portfolioAware
  ) {
    html +=
      '<div class="decisionMetaLine"><strong>Portfolio-aware allocation:</strong> NOMAD considered your existing portfolio value of PKR ' +
      formatNumber(
        result.allocationDiagnostics
          .existingPortfolioValuePkr ||
        0,
        0
      ) +
      ' before applying stock and sector caps to this new capital.</div>';
  }

  if (
    result?.allocationDiagnostics
      ?.targetPositionCount
  ) {
    html +=
      '<div class="decisionMetaLine"><strong>Portfolio construction:</strong> target ' +
      formatNumber(
        result.allocationDiagnostics
          .targetPositionCount ||
        0,
        0
      ) +
      ' positions (minimum target ' +
      formatNumber(
        result.allocationDiagnostics
          .minimumTargetPositions ||
        3,
        0
      ) +
      ', maximum ' +
      formatNumber(
        result.allocationDiagnostics
          .maximumTargetPositions ||
        8,
        0
      ) +
      '); ' +
      formatNumber(
        result.allocationDiagnostics
          .eligibleAllocationCandidates ||
        0,
        0
      ) +
      ' currently pass the allocation gate (' +
      formatNumber(
        result.allocationDiagnostics
          .priorityOneAllocationCandidates ||
        0,
        0
      ) +
      ' Priority 1 + ' +
      formatNumber(
        result.allocationDiagnostics
          .priorityTwoAllocationCandidates ||
        0,
        0
      ) +
      ' actionable Priority 2). Current caps: ' +
      formatNumber(
        result.allocationDiagnostics
          .dynamicMaxStockPct ||
        0,
        1
      ) +
      '% per stock and ' +
      formatNumber(
        result.allocationDiagnostics
          .dynamicMaxSectorPct ||
        0,
        1
      ) +
      '% per sector.</div>';

    if (
      result?.allocationDiagnostics
        ?.targetDeploymentPct !==
        undefined
    ) {
      html +=
        '<div class="decisionMetaLine"><strong>Intentional deployment:</strong> target ' +
        formatNumber(
          result.allocationDiagnostics
            .targetDeploymentPct ||
          0,
          1
        ) +
        '% deployed · deliberate cash reserve ' +
        formatNumber(
          result.allocationDiagnostics
            .intentionalCashReservePct ||
          0,
          1
        ) +
        '% · average conviction ' +
        formatNumber(
          result.allocationDiagnostics
            .averageConvictionScore ||
          0,
          1
        ) +
        '/100. ' +
        escapeHtml(
          result.allocationDiagnostics
            .cashReserveReason ||
          ''
        ) +
        '</div>';
    }

    if (
      result?.screening
        ?.actionableResearchTarget
    ) {
      html +=
        '<div class="decisionMetaLine"><strong>Capital-efficiency search:</strong> NOMAD continued deeper research until it found ' +
        formatNumber(
          result.screening
            .actionableProfileFit ||
          0,
          0
        ) +
        ' profile-suitable actionable ideas against a research target of ' +
        formatNumber(
          result.screening
            .actionableResearchTarget ||
          0,
          0
        ) +
        ', or exhausted the bounded deep-research budget. Cash is retained only after that search; WATCH, unresolved evidence and profile failures still receive PKR 0.</div>';
    }

    if (
      result.allocationDiagnostics
        ?.diversificationException
        ?.triggered
    ) {
      html +=
        '<div class="decisionMetaLine"><strong>Diversification exception:</strong> ' +
        escapeHtml(
          result.allocationDiagnostics
            .diversificationException
            .reason ||
          'The minimum three-stock diversification target could not be reached without weakening the professional allocation gates.'
        ) +
        '</div>';
    }
  }

  if (allocations.length) {
    html +=
      '<div class="decisionMetaLine">Whole-share implementation</div>';

    html +=
      allocations.map(
        item =>
          '<div class="decisionAllocationRow">' +
          '<div class="decisionSymbol">' +
          escapeHtml(
            item.symbol
          ) +
          '</div>' +
          '<div><strong>' +
          formatNumber(
            item.shares,
            0
          ) +
          ' share' +
          (
            Number(
              item.shares
            ) === 1
              ? ''
              : 's'
          ) +
          ' · PKR ' +
          formatNumber(
            item.principalPkr,
            0
          ) +
          '</strong><div class="decisionMinor">' +
          escapeHtml(
            item.companyName ||
            ''
          ) +
          ' · ' +
          escapeHtml(
            item.allocationTier ===
              'PRIORITY_2'
              ? 'Priority 2'
              : 'Priority 1'
          ) +
          ' · new money ' +
          formatNumber(
            item.newMoneyWeightPct ??
            item.actualWeightPct,
            1
          ) +
          '%' +
          (
            item.postPortfolioWeightPct !==
              undefined &&
            item.postPortfolioWeightPct !==
              null
              ? ' · post-portfolio ' +
                formatNumber(
                  item.postPortfolioWeightPct,
                  1
                ) +
                '%'
              : ''
          ) +
          (
            item.traderPlan
              ? ' · setup ' +
                escapeHtml(
                  item.traderPlan.setup ||
                  'DEFINED'
                ) +
                (
                  item.traderPlan.stop !== null &&
                  item.traderPlan.stop !== undefined
                    ? ' · stop PKR ' +
                      formatNumber(
                        item.traderPlan.stop,
                        2
                      )
                    : ''
                ) +
                (
                  item.traderPlan.target1 !== null &&
                  item.traderPlan.target1 !== undefined
                    ? ' · target PKR ' +
                      formatNumber(
                        item.traderPlan.target1,
                        2
                      )
                    : ''
                ) +
                (
                  item.traderPlan.rewardRisk !== null &&
                  item.traderPlan.rewardRisk !== undefined
                    ? ' · R/R ' +
                      formatNumber(
                        item.traderPlan.rewardRisk,
                        2
                      ) + 'x'
                    : ''
                ) +
                (
                  item.traderPlan.riskBudgetPct !== null &&
                  item.traderPlan.riskBudgetPct !== undefined
                    ? ' · risk budget ' +
                      formatNumber(
                        item.traderPlan.riskBudgetPct,
                        2
                      ) + '%'
                    : ''
                )
              : ''
          ) +
          '</div></div>' +
          '<div class="decisionActionTag ' +
          escapeHtml(
            String(
              item.action ||
              ''
            ).toLowerCase()
          ) +
          '">' +
          escapeHtml(
            decisionActionLabel(
              item.action
            )
          ) +
          '</div>' +
          '</div>'
      ).join('');
  } else {
    html +=
      '<div class="decisionMetaLine">No capital is allocated unless a canonical BUY or ACCUMULATE state has allocation permission and at least one whole share fits the portfolio/risk limits.</div>';
  }

  const unfunded =
    result?.allocationDiagnostics
      ?.unfundedPriorityOne ||
    [];

  if (unfunded.length) {
    html +=
      '<div class="decisionMetaLine"><strong>Priority 1 not fitted:</strong> ' +
      unfunded.map(
        item =>
          escapeHtml(
            item.symbol
          )
      ).join(', ') +
      '. NOMAD kept these ranked instead of replacing them with weaker cheaper stocks.</div>';
  }

  const personalActions =
    result?.allocationDiagnostics
      ?.personalActions ||
    [];

  const existingPortfolioActions =
    personalActions.filter(
      item =>
        Number(
          item.existingWeightPct ||
          0
        ) > 0
    );

  if (existingPortfolioActions.length) {
    html +=
      '<div class="decisionMetaLine"><strong>Your holdings changed the recommendation:</strong> ' +
      existingPortfolioActions
        .slice(0, 5)
        .map(
          item =>
            escapeHtml(
              item.symbol
            ) +
            ' = ' +
            escapeHtml(
              decisionActionLabel(
                item.portfolioAction
              )
            )
        )
        .join(' · ') +
      '.</div>';
  }

  html +=
    '<div class="decisionMetaLine">Model ' +
    escapeHtml(
      result.model?.id ||
      'N/A'
    ) +
    ' · ' +
    escapeHtml(
      result.riskPolicy?.id ||
      ''
    ) +
    ' · ' +
    (
      result.recording?.recorded
        ? 'recorded for accountability'
        : 'not recorded: ' +
          escapeHtml(
            result.recording?.reason ||
            'decision tables unavailable'
          )
    ) +
    '</div>' +
    '<div class="decisionMetaLine">Execution costs and forward-return scenarios are not included yet. This remains shadow research, not a trade instruction.</div>';

  target.innerHTML =
    html;

  renderOpportunityBoard(
    result
  );

  renderDecisionAudit(
    result
  );

  const summary =
    homeDecisionSummaryData(
      result
    );

  try {
    localStorage.setItem(
      'nomadLastDecisionSummary',
      JSON.stringify(
        summary
      )
    );
  } catch {}

  renderHomeDecisionSummary(
    summary
  );
}

if ($('analyzeStockStrategy')) {
  $('analyzeStockStrategy')
    .onclick =
      () =>
        loadStockStrategy();
}

if ($('strategySymbol')) {
  $('strategySymbol')
    .onkeydown =
      event => {
        if (event.key === 'Enter') {
          loadStockStrategy();
        }
      };
}

if ($('decisionCenterPage')) {
  $('decisionCenterPage')
    .addEventListener(
      'click',
      event => {
        const button =
          event.target
            ?.closest(
              '[data-strategy-symbol]'
            );

        if (!button) {
          return;
        }

        const symbol =
          String(
            button.dataset
              .strategySymbol ||
            ''
          )
            .trim()
            .toUpperCase();

        if (!symbol) {
          return;
        }

        $('strategySymbol')
          .value =
            symbol;

        loadStockStrategy(
          symbol
        );

        $('stockStrategyResult')
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
      }
    );
}

if ($('decisionHorizon') && $('strategyHorizon')) {
  $('decisionHorizon')
    .addEventListener(
      'change',
      () => {
        $('strategyHorizon').value =
          $('decisionHorizon').value;
      }
    );
}

if ($('decisionRisk') && $('strategyRisk')) {
  $('decisionRisk')
    .addEventListener(
      'change',
      () => {
        $('strategyRisk').value =
          $('decisionRisk').value;
      }
    );
}

['strategyHorizon', 'strategyRisk']
  .forEach(
    id => {
      if (!$(id)) {
        return;
      }

      $(id).addEventListener(
        'change',
        () => {
          const symbol =
            String(
              $('strategySymbol')
                ?.value ||
              ''
            )
              .trim()
              .toUpperCase();

          if (!symbol) {
            return;
          }

          $('stockStrategyResult')
            .innerHTML =
              '<div class="terminalEmpty small">Strategy settings changed. NOMAD is re-running this stock under the selected horizon and risk profile...</div>';

          loadStockStrategy(
            symbol
          );
        }
      );
    }
  );

if ($('findBestOption')) {
  $('findBestOption')
    .onclick =
      async () => {
        const button =
          $('findBestOption');

        const amount =
          Number(
            String(
              $('decisionAmount')
                .value ||
              ''
            ).replace(
              /,/g,
              ''
            )
          );

        const context = {
          amount:
            Number.isFinite(amount) &&
            amount > 0
              ? amount
              : 5000,
          horizon:
            $('decisionHorizon')
              .value,
          risk:
            $('decisionRisk')
              .value
        };

        localStorage.setItem(
          'nomadDecisionContext',
          JSON.stringify(
            context
          )
        );

        const originalText =
          button.textContent;

        button.disabled =
          true;

        button.textContent =
          'Analyzing PSX...';

        $('decisionResult')
          .innerHTML =
            '<div class="decisionShadowBanner">SHADOW MODEL</div>' +
            '<strong>NOMAD is ranking the eligible universe.</strong><br>' +
            'Opportunity ranking is independent of your budget. NOMAD is checking liquidity, history, fundamentals, Financial Analyst evidence, valuation, entry and risk before the separate whole-share allocator runs.';

        try {
          const result =
            await apiPost(
              'decision-lab',
              context
            );

          renderShadowDecision(
            result
          );
        } catch (error) {
          $('decisionResult')
            .innerHTML =
              '<strong>Decision engine unavailable.</strong><br>' +
              escapeHtml(
                error.message ||
                'The decision request failed.'
              ) +
              '<br>NOMAD did not substitute a guess.';
        } finally {
          button.disabled =
            false;

          button.textContent =
            originalText;
        }
      };
}

if ($('homeRunScan')) {
  $('homeRunScan')
    .onclick =
      () =>
        runDecisionScanner(
          'homeLastScanMeta'
        );
}

if ($('runIntelligenceScan')) {
  $('runIntelligenceScan')
    .onclick =
      () =>
        runDecisionScanner(
          'scanSystemResult'
        );
}

if ($('saveDecisionContext')) {
  $('saveDecisionContext')
    .onclick =
      () => {
        const amount =
          Number(
            String(
              $('decisionAmount')
                .value ||
              ''
            ).replace(
              /,/g,
              ''
            )
          );

        const context = {
          amount:
            Number.isFinite(amount) &&
            amount > 0
              ? amount
              : 5000,
          horizon:
            $('decisionHorizon')
              .value,
          risk:
            $('decisionRisk')
              .value
        };

        localStorage.setItem(
          'nomadDecisionContext',
          JSON.stringify(
            context
          )
        );

        $('decisionContextStatus')
          .textContent =
            'Decision context saved: PKR ' +
            formatNumber(
              context.amount,
              0
            ) +
            '. Allocation recommendations remain disabled until the scoring engine is validated.';
      };
}

try {
  const storedContext =
    JSON.parse(
      localStorage.getItem(
        'nomadDecisionContext'
      ) ||
      'null'
    );

  if (storedContext) {
    if (
      storedContext.amount &&
      $('decisionAmount')
    ) {
      $('decisionAmount')
        .value =
          storedContext.amount;
    }

    if (
      storedContext.horizon &&
      $('decisionHorizon')
    ) {
      $('decisionHorizon')
        .value =
          storedContext.horizon;
    }

    if (
      storedContext.risk &&
      $('decisionRisk')
    ) {
      $('decisionRisk')
        .value =
          storedContext.risk;
    }
  }
} catch {}

try {
  const storedDecisionSummary =
    JSON.parse(
      localStorage.getItem(
        'nomadLastDecisionSummary'
      ) ||
      'null'
    );

  renderHomeDecisionSummary(
    storedDecisionSummary
  );
} catch {
  renderHomeDecisionSummary(
    null
  );
}

openAppPage(
  appPageFromLocation(),
  {
    updateLocation: false,
    scrollToTop: false
  }
);

loadDecisionCenter();

/* =========================================================
   HEALTH
========================================================= */

api(
  'health'
)
  .then(
    result => {
      $('status')
        .textContent =
          'Market: connected | ' +
          'Company metadata: connected | ' +
          'Symbol normalization: validated canonical mapping | ' +
          'Universe master: ' +
          (result.universeMasterVersion || 'loaded') + ' | ' +
          'pyPSX: ' +
          (
            result.pyPSXConfigured
              ? 'configured'
              : 'not configured'
          ) +
          ' | Fundamentals: connected' +
          ' | Technical engine: deterministic' +
          ' | Persistent memory: ' +
          (
            result.supabaseConfigured
              ? 'connected'
              : 'not configured'
          ) +
          ' | Prediction engine: ' +
          result.predictionEngine;

      $('memoryDatabaseStatus')
        .textContent =
          result.supabaseConfigured
            ? 'Connected'
            : 'Not configured';
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

/* =========================================================
   EXPORT / LOCAL SERVER
========================================================= */

module.exports =
  handler;

module.exports.decisionEngine = {
  models:
    DECISION_MODELS,
  riskPolicies:
    DECISION_RISK_POLICIES,
  scoreEntry:
    scoreDecisionEntry,
  scoreFundamentals:
    scoreDecisionFundamentals,
  allocate:
    allocateDecisionCandidates,
  allocateDecisionCenter:
    allocateDecisionCenterOpportunities,
  opportunityBoard:
    buildDecisionOpportunityBoard,
  analystGate:
    decisionCenterAnalystGate,
  canonicalState:
    decisionCanonicalCompanyState,
  profileSuitability:
    decisionProfileSuitability,
  candidateAction:
    decisionCandidateAction
};

if (require.main === module) {
  if (
    process.argv.includes(
      '--test-decision'
    )
  ) {
    runDecisionEngineSelfTests();
  } else {
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
            'NOMAD Invest running at http://127.0.0.1:' +
            port
          );
        }
      );
  }
}
