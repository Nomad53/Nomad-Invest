'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.6.3';

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
            'Mozilla/5.0 NOMAD-Invest/0.6.2',

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

  try {
    const response =
      await fetchJSON(
        `${PSX_DPS_BASE}/symbols`,
        30000,
        {
          'User-Agent':
            'Mozilla/5.0 NOMAD-Invest/0.6.2',

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

          isCanonical:
            true
        }
      );
    }
  } catch {}

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

            isCanonical:
              false
          }
        );
      }
    }
  } catch {}
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

  const map =
    await loadOfficialSymbolsMap();

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

  let sectorName =
    null;

  const pageStatusCodes = [];

  if (
    companyName
  ) {
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
          companyLineIndex + 1;

        index <
          Math.min(
            lines.length,
            companyLineIndex + 12
          );

        index++
      ) {
        const candidate =
          String(
            lines[index] || ''
          )
            .trim()
            .toUpperCase();

        if (!candidate) {
          continue;
        }

        if (
          isSecurityStatusToken(
            candidate
          )
        ) {
          pageStatusCodes.push(
            candidate
          );

          continue;
        }

        if (
          candidate ===
            normalizeSymbol(
              symbol
            )
        ) {
          continue;
        }

        if (
          /^(QUOTE|PROFILE|EQUITY|ANNOUNCEMENTS|FINANCIALS|RATIOS|PAYOUTS|REPORTS|REG|DFC|CSF|ODL)$/i
            .test(
              candidate
            )
        ) {
          continue;
        }

        if (
          /^RS\.?/i
            .test(
              candidate
            ) ||
          /^PKR\b/i
            .test(
              candidate
            ) ||
          /^\d/
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

  return {
    symbol,

    companyName,

    sectorName,

    statusCodes:
      uniqueStrings(
        pageStatusCodes
      ),

    sourceUrl:
      `${PSX_DPS_BASE}/company/${encodeURIComponent(
        symbol
      )}`,

    fetchedAt:
      new Date()
        .toISOString(),

    quote:
      parseOfficialQuoteStats(
        lines
      ),

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
      loadRawScreener(),
      loadSectorMap(),
      loadCompanyMap()
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
      .sort(
        (
          a,
          b
        ) =>
          a.symbol.localeCompare(
            b.symbol
          )
      );

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

  const result = {
    sourceName:
      'psxdata-api',

    companyNamesMatched,

    sectorsMatched,

    normalizedStatusRows,

    rawRows:
      normalizedRows.length,

    asOf:
      screener.timestamp,

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

/* =========================================================
   METADATA AUDIT - BUILD 0.6.2
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

function classifyInstrumentForAudit(
  stock
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

  let instrumentType =
    'ORDINARY_OR_UNCLASSIFIED';

  let instrumentLabel =
    'Ordinary / unclassified';

  let classificationReason =
    'No strong special-security marker was detected.';

  let classificationConfidence =
    'medium';

  if (
    containsAny(
      searchable,
      [
        /\bREAL ESTATE INVESTMENT TRUST\b/,
        /\bREIT\b/
      ]
    )
  ) {
    instrumentType =
      'REIT';

    instrumentLabel =
      'REIT';

    classificationReason =
      'Name or sector contains a REIT marker.';

    classificationConfidence =
      'high';
  } else if (
    containsAny(
      searchable,
      [
        /\bEXCHANGE TRADED FUND\b/,
        /\bETF\b/
      ]
    )
  ) {
    instrumentType =
      'ETF';

    instrumentLabel =
      'ETF';

    classificationReason =
      'Name or sector contains an ETF marker.';

    classificationConfidence =
      'high';
  } else if (
    containsAny(
      searchable,
      [
        /\bMUTUAL FUND\b/,
        /\bCLOSED END FUND\b/,
        /\bFUND\b/
      ]
    )
  ) {
    instrumentType =
      'FUND';

    instrumentLabel =
      'Fund';

    classificationReason =
      'Name or sector contains a fund marker.';

    classificationConfidence =
      'medium';
  } else if (
    containsAny(
      searchable,
      [
        /\bMODARABA\b/
      ]
    )
  ) {
    instrumentType =
      'MODARABA';

    instrumentLabel =
      'Modaraba';

    classificationReason =
      'Name or sector identifies a Modaraba.';

    classificationConfidence =
      'high';
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
    instrumentType =
      'DEBT_OR_SUKUK';

    instrumentLabel =
      'Debt / Sukuk';

    classificationReason =
      'Name, sector or listing field contains a debt-security marker.';

    classificationConfidence =
      'high';
  } else if (
    containsAny(
      searchable,
      [
        /\bRIGHT ISSUE\b/,
        /\bRIGHTS ISSUE\b/,
        /\bRIGHTS\b/,
        /\bENTITLEMENT\b/
      ]
    )
  ) {
    instrumentType =
      'RIGHTS_OR_ENTITLEMENT';

    instrumentLabel =
      'Rights / entitlement';

    classificationReason =
      'Name or listing information contains a rights or entitlement marker.';

    classificationConfidence =
      'high';
  } else if (
    !nameResolved &&
    /R\d*$/.test(
      symbol
    )
  ) {
    instrumentType =
      'POSSIBLE_RIGHTS_OR_ENTITLEMENT';

    instrumentLabel =
      'Possible rights / entitlement';

    classificationReason =
      'Unresolved symbol ends in R or R plus digits. This is only a diagnostic hint and is not treated as confirmed.';

    classificationConfidence =
      'low';
  } else if (
    containsAny(
      searchable,
      [
        /\bPREFERENCE\b/,
        /\bPREFERRED\b/,
        /\bPREF\b/
      ]
    )
  ) {
    instrumentType =
      'PREFERENCE_OR_CLASS';

    instrumentLabel =
      'Preference / special class';

    classificationReason =
      'Name or listing information contains a preference-security marker.';

    classificationConfidence =
      'high';
  }

  const hasSpecialClassification =
    instrumentType !==
    'ORDINARY_OR_UNCLASSIFIED';

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

  let auditReason =
    '';

  if (
    issueType
  ) {
    if (
      hasSpecialClassification
    ) {
      bucket =
        'LIKELY_SPECIAL_INSTRUMENT';

      bucketLabel =
        'Likely special instrument';

      auditReason =
        issueLabel +
        '. ' +
        classificationReason;
    } else if (
      nameResolved ||
      sectorResolved
    ) {
      bucket =
        'LIKELY_NORMAL_COMPANY_MISSING_METADATA';

      bucketLabel =
        'Likely company metadata gap';

      auditReason =
        issueLabel +
        '. Some identity metadata is already resolved, so this is likely a normal listed security with incomplete metadata.';
    } else {
      bucket =
        'UNRESOLVED';

      bucketLabel =
        'Unresolved';

      auditReason =
        'Neither company name nor sector is reliably resolved and no strong special-security marker was detected. NOMAD should not guess this identity.';
    }
  }

  if (
    stock.normalizedSymbol &&
    issueType
  ) {
    auditReason +=
      ' A PSX status symbol was normalized successfully, but metadata is still incomplete.';
  }

  return {
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

    instrumentType,

    instrumentLabel,

    classificationReason,

    classificationConfidence,

    issueType,

    issueLabel,

    bucket,

    bucketLabel,

    auditReason
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

  const classified =
    market.stocks.map(
      classifyInstrumentForAudit
    );

  const issues =
    classified.filter(
      row =>
        Boolean(
          row.issueType
        )
    );

  const specialInstruments =
    classified.filter(
      row =>
        row.instrumentType !==
        'ORDINARY_OR_UNCLASSIFIED'
    );

  const likelyNormalCompanyIssues =
    issues.filter(
      row =>
        row.bucket ===
        'LIKELY_NORMAL_COMPANY_MISSING_METADATA'
    );

  const likelySpecialIssues =
    issues.filter(
      row =>
        row.bucket ===
        'LIKELY_SPECIAL_INSTRUMENT'
    );

  const unresolvedIssues =
    issues.filter(
      row =>
        row.bucket ===
        'UNRESOLVED'
    );

  const namesResolved =
    classified.filter(
      row =>
        row.nameResolved
    ).length;

  const sectorsResolved =
    classified.filter(
      row =>
        row.sectorResolved
    ).length;

  const data = {
    version:
      VERSION,

    generatedAt:
      new Date()
        .toISOString(),

    marketAsOf:
      market.asOf,

    mode:
      'READ_ONLY_DIAGNOSTIC',

    summary: {
      totalCanonicalSecurities:
        classified.length,

      namesResolved,

      namesMissing:
        classified.length -
        namesResolved,

      sectorsResolved,

      sectorsMissing:
        classified.length -
        sectorsResolved,

      statusSymbolsNormalized:
        classified.filter(
          row =>
            row.normalizedStatus
        ).length,

      totalMetadataIssues:
        issues.length,

      likelyNormalCompaniesMissingMetadata:
        likelyNormalCompanyIssues.length,

      likelySpecialInstrumentIssues:
        likelySpecialIssues.length,

      unresolved:
        unresolvedIssues.length,

      totalSpecialInstrumentsDetected:
        specialInstruments.length
    },

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

    instrumentTypes:
      countBy(
        specialInstruments,
        'instrumentType'
      ),

    issues
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
    snapshot,
    quote
  ] =
    await Promise.all([
      loadSectorMap(),

      getPSXCompanySnapshot(
        symbol
      ).catch(
        () => null
      ),

      fetchQuoteForSymbols([
        context.tradingSymbol,
        symbol
      ]).catch(
        () => null
      )
    ]);

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
            'PSX canonical metadata + ALLSHR + fallbacks',

          symbolNormalization:
            'VALIDATED_CANONICAL_STATUS_SEPARATION',

          metadataAudit:
            'READ_ONLY_DIAGNOSTIC',

          fundamentalsProvider:
            'PSX Data Portal company page',

          technicalEngine:
            'IMPLEMENTED_DETERMINISTIC',

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
    minmax(260px,2fr)
    minmax(240px,1fr);
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

.identityLine {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 3px;
}

.statusPill {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  background: #fff0d6;
  color: #865b12;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid #f0d39e;
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

Market, company metadata, fundamentals, symbol normalization,
metadata auditing and deterministic technical analysis are connected.

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

<section
  class="card"
  id="metadataAuditSection"
>

<h2>
Metadata Audit
</h2>

<p class="muted">
Read-only diagnostic. This checks which PSX securities still have incomplete company-name or sector metadata. It does not modify any market data.
</p>

<div class="actions">

<button id="runMetadataAudit">
Run metadata audit
</button>

</div>

<div id="metadataAuditSummary"></div>

<div
  id="metadataAuditControls"
  style="display:none"
>

<div class="auditFilters">

<div>

<label>
Search audit
</label>

<input
  id="metadataAuditSearch"
  type="search"
  placeholder="Symbol, company, sector, market symbol or reason"
>

</div>

<div>

<label>
Issue category
</label>

<select id="metadataAuditCategory">

<option value="">
All metadata issues
</option>

<option value="LIKELY_NORMAL_COMPANY_MISSING_METADATA">
Likely company metadata gaps
</option>

<option value="LIKELY_SPECIAL_INSTRUMENT">
Likely special instruments
</option>

<option value="UNRESOLVED">
Unresolved
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

let metadataAuditRows = [];

let metadataAuditPage = 1;

const METADATA_AUDIT_PAGE_SIZE =
  50;

let liveRefreshTimer = null;

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
      code =>
        '<span class="statusPill">' +
        escapeHtml(
          code
        ) +
        '</span>'
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
        : 'Market closed - showing latest trading session';

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
              stock.peRatio ===
                null
                ? 'N/A'
                : formatNumber(
                    stock.peRatio
                  )
            ) +
            '</td>' +

            '<td>' +
            (
              stock.dividendYield ===
                null
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
   METADATA AUDIT UI
========================================================= */

function auditBucketClass(
  bucket
) {
  if (
    bucket ===
    'UNRESOLVED'
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

function renderMetadataAuditSummary(
  result
) {
  const summary =
    result.summary ||
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
        'Status symbols normalized',
        formatNumber(
          summary.statusSymbolsNormalized,
          0
        )
      ) +

      metricCard(
        'Likely company gaps',
        formatNumber(
          summary.likelyNormalCompaniesMissingMetadata,
          0
        )
      ) +

      metricCard(
        'Likely special instruments',
        formatNumber(
          summary.likelySpecialInstrumentIssues,
          0
        )
      ) +

      metricCard(
        'Unresolved',
        '<span class="' +
        (
          Number(
            summary.unresolved
          ) > 0
            ? 'negative'
            : 'positive'
        ) +
        '">' +
        formatNumber(
          summary.unresolved,
          0
        ) +
        '</span>'
      ) +

      '</div>' +

      '<div class="infoBox">' +
      'This audit does not change metadata. Low-confidence classifications are diagnostic hints only. Unresolved securities remain unresolved rather than being guessed.' +
      '</div>';
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

  return metadataAuditRows.filter(
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
          row.instrumentLabel +
          ' ' +
          row.issueLabel +
          ' ' +
          row.auditReason +
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

  $('metadataAuditInfo')
    .textContent =
      rows.length +
      ' metadata issues after current filters.';

  if (
    !pageRows.length
  ) {
    $('metadataAuditTable')
      .innerHTML =
        '<div class="emptyState">' +
        'No metadata issues match this filter.' +
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
      '<th>Market symbol</th>' +
      '<th>Company</th>' +
      '<th>Sector</th>' +
      '<th>Issue</th>' +
      '<th>Instrument</th>' +
      '<th>Confidence</th>' +
      '<th>Why flagged</th>' +

      '</tr>' +

      '</thead>' +

      '<tbody>' +

      pageRows.map(
        row =>
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

          '</td>' +

          '<td>' +
          escapeHtml(
            row.marketSymbol ||
            row.symbol
          ) +
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

          '</div>' +

          '</td>' +

          '<td>' +
          escapeHtml(
            row.instrumentLabel
          ) +
          '</td>' +

          '<td>' +
          escapeHtml(
            row.classificationConfidence
          ) +
          '</td>' +

          '<td class="auditReason">' +
          escapeHtml(
            row.auditReason
          ) +
          '</td>' +

          '</tr>'
      )
        .join('') +

      '</tbody>' +

      '</table>';

  const first =
    start + 1;

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
      ' issues | Page ' +
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

/* =========================================================
   MARKET BUTTON
========================================================= */

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
            ' canonical stocks | Company names matched ' +
            result.companyNamesMatched +
            '/' +
            result.totalStocks +
            ' | Sectors matched ' +
            result.sectorsMatched +
            '/' +
            result.totalStocks +
            ' | Status symbols normalized ' +
            result.normalizedStatusRows +
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

/* =========================================================
   METADATA AUDIT BUTTON
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

      $('metadataAuditSummary')
        .innerHTML =
          '<p class="muted">' +
          'Running read-only metadata audit...' +
          '</p>';

      try {
        const result =
          await api(
            'metadata-audit'
          );

        metadataAuditRows =
          result.issues ||
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

        $('metadataAuditSearch')
          .value =
            '';

        $('metadataAuditCategory')
          .value =
            '';

        renderMetadataAuditTable();
      } catch (error) {
        $('metadataAuditSummary')
          .innerHTML =
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
        const result =
          await api(
            'quote',
            {
              symbol:
                inputSymbol
            }
          );

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
          'Metadata audit: read-only | ' +
          'pyPSX: ' +
          (
            result.pyPSXConfigured
              ? 'configured'
              : 'not configured'
          ) +
          ' | Fundamentals: connected' +
          ' | Technical engine: deterministic' +
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

/* =========================================================
   EXPORT / LOCAL SERVER
========================================================= */

module.exports =
  handler;

if (require.main === module) {
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
