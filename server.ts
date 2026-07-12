// mcp-nychousing: MCP server over NYC Open Data (Socrata / SODA) for NYC
// housing data: HPD maintenance-code violations, complaints, building
// ownership / registration, HPD-initiated litigation against landlords, and
// marshal-executed evictions.
//
// Built for tenant organizers, housing-court legal-aid intake, and Right-to-
// Counsel orgs who need a building's condition, its real owner/agent to serve,
// and its court history.
//
// Data source: NYC Open Data, Socrata Open Data API (SODA).
//   Base: https://data.cityofnewyork.us/resource/<dataset-id>.json
//   Auth: NONE. SODA is keyless. An optional Socrata app token (sent as the
//         X-App-Token header) only raises the per-IP rate limit; every tool in
//         this server works fully without one.
//
// Datasets (see README.md "Data source and grounding" for column notes):
//   wvxf-dwi5  HPD Housing Maintenance Code Violations
//   ygpa-z7cr  HPD Complaints and Problems (the current combined dataset)
//   tesw-yqqr  HPD Registrations (current building registrations)
//   feu5-w2e2  HPD Registration Contacts (owners / agents / officers)
//   59kj-x8nc  HPD Housing Litigations (HPD-initiated cases + tenant actions)
//   6z8x-wfk4  Evictions (marshal-executed only)
//
// SODA / SoQL quirks handled here:
//   - Address columns differ per dataset: violations & registrations use
//     housenumber / streetname / boro; complaints uses house_number /
//     street_name / borough; litigations uses housenumber / streetname / boroid
//     (a numeric 1-5 borough code, with NO text borough column); evictions store
//     one combined eviction_address string plus a borough column.
//   - Street names are stored UPPERCASE. This server uppercases and trims inputs
//     and matches street with `upper(col) like '%INPUT%'` as a substring match,
//     not a geocode. House number is matched exactly (uppercased).
//   - String equality in SoQL is case-sensitive, so status filters wrap the
//     column in upper() before comparing.
//   - The Evictions borough column mixes borough and county spellings (BROOKLYN
//     and KINGS, MANHATTAN and NEW YORK, STATEN ISLAND and RICHMOND); the borough
//     filter expands to every alias so no rows are silently dropped.
//   - All user-supplied text is escaped for SoQL (a single quote becomes two).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// API constants
// ---------------------------------------------------------------------------

/** NYC Open Data SODA resource base; a dataset id + ".json" is appended. */
const NYC_API = "https://data.cityofnewyork.us/resource";

/** The Socrata dataset ids this server reads. */
const DATASET = {
  violations: "wvxf-dwi5",
  complaints: "ygpa-z7cr",
  registrations: "tesw-yqqr",
  contacts: "feu5-w2e2",
  litigations: "59kj-x8nc",
  evictions: "6z8x-wfk4",
} as const;

/** Where to get a free (optional) Socrata app token; tools work without one. */
const APP_TOKEN_DOCS = "https://dev.socrata.com/docs/app-tokens.html";
/** Descriptive User-Agent (NYC Open Data is a free public service; be identifiable). */
const UA = "mcp-nychousing/1.0 (+https://github.com/haksanlulz/mcp-nychousing)";
/** Minimum spacing between outbound API calls (polite throttle). */
const THROTTLE_MS = 200;
/** Hard upper bound on rows returned by any single detail tool call. */
const MAX_RESULTS = 500;

// ---------------------------------------------------------------------------
// Auth (optional app token)
// ---------------------------------------------------------------------------

/** The Socrata app token if set, else null. Only used to raise the rate limit. */
function optionalToken(): string | null {
  return process.env.NYC_APP_TOKEN?.trim() || null;
}

/** Request headers. Attaches X-App-Token only when a token is configured. */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  const t = optionalToken();
  if (t) headers["X-App-Token"] = t;
  return headers;
}

// ---------------------------------------------------------------------------
// Throttled fetch queue (serialize calls, >= THROTTLE_MS apart)
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` after all prior throttled calls, spacing each by THROTTLE_MS. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const result = await fn();
    await sleep(THROTTLE_MS);
    return result;
  });
  // Keep the queue alive regardless of success/failure; swallow to avoid
  // unhandled-rejection noise on the internal chain (callers still see errors).
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Low-level SODA access
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type QueryValue = string | number | undefined | null;

/**
 * Execute one GET against a SODA dataset and return the parsed JSON rows.
 * Undefined / null / empty params are omitted. SODA answers list and aggregate
 * queries with a JSON array; errors come back as `{ error: true, message }`.
 */
async function sodaGet(dataset: string, params: Record<string, QueryValue> = {}): Promise<Row[]> {
  const url = new URL(`${NYC_API}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await throttled(() => fetch(url, { headers: buildHeaders() }));
  const text = await res.text();

  if (!res.ok) {
    // SODA errors are JSON like {"error":true,"message":"..."}; surface the message.
    let detail = text.slice(0, 300).trim();
    try {
      const j = JSON.parse(text) as Row;
      if (j && typeof j === "object" && typeof j.message === "string") detail = j.message;
    } catch {
      /* leave detail as the raw text slice */
    }
    throw new Error(`NYC Open Data request failed (HTTP ${res.status}): ${detail}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML error pages / proxy interstitials arrive as non-JSON with a 200.
    throw new Error(`NYC Open Data returned a non-JSON response: ${text.slice(0, 300).trim()}`);
  }

  if (Array.isArray(json)) return json as Row[];
  // A 200 with an error object is rare but possible for malformed SoQL.
  if (json && typeof json === "object" && (json as Row).error) {
    const msg = (json as Row).message;
    throw new Error(`NYC Open Data query error: ${typeof msg === "string" ? msg : JSON.stringify(json)}`);
  }
  throw new Error("NYC Open Data returned an unexpected (non-array) response.");
}

// ---------------------------------------------------------------------------
// Value normalization helpers
// ---------------------------------------------------------------------------

/** Coerce a SODA value to a number, or null. */
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Coerce a SODA value to a trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** SODA "Y"/"N" flag to boolean, or null when neither. */
function ynBool(v: unknown): boolean | null {
  const s = str(v);
  if (s == null) return null;
  const u = s.toUpperCase();
  if (u === "Y" || u === "YES") return true;
  if (u === "N" || u === "NO") return false;
  return null;
}

// ---------------------------------------------------------------------------
// SoQL builders (all user text is escaped before it reaches a query)
// ---------------------------------------------------------------------------

/** Escape a string for a SoQL single-quoted literal (' -> ''). */
function soql(s: string): string {
  return s.replace(/'/g, "''");
}

/** `col = 'value'` (case-insensitive exact via upper() on both sides). */
function eqTextCI(col: string, value: string): string {
  return `upper(${col})='${soql(value.toUpperCase())}'`;
}

/** `col = 'value'` (exact, case-sensitive; for codes like a court index number). */
function eqText(col: string, value: string): string {
  return `${col}='${soql(value)}'`;
}

/** `col = n` for a validated numeric column (e.g. boroid). */
function eqNum(col: string, n: number): string {
  return `${col}=${n}`;
}

/** `upper(col) like '%value%'`, a case-insensitive substring match. */
function likeCI(col: string, value: string): string {
  return `upper(${col}) like '%${soql(value.toUpperCase())}%'`;
}

/** `col >= 'isoDate'` for a floating-timestamp column. isoDate must be trusted. */
function gteDate(col: string, isoDate: string): string {
  return `${col} >= '${isoDate}'`;
}

/** `col in ('a','b',...)` for text values. */
function inText(col: string, values: string[]): string {
  return `${col} in (${values.map((v) => `'${soql(v)}'`).join(",")})`;
}

/** `col in (1,2,...)` for validated numeric values. */
function inNum(col: string, values: number[]): string {
  return `${col} in (${values.join(",")})`;
}

/** Join conditions with AND (empty list -> no filter). */
function whereAnd(conditions: string[]): string | undefined {
  const kept = conditions.filter((c) => c && c.trim() !== "");
  return kept.length ? kept.join(" AND ") : undefined;
}

// ---------------------------------------------------------------------------
// Borough resolution (the messiest cross-dataset detail; see header notes)
// ---------------------------------------------------------------------------

interface Borough {
  /** Numeric borough code (1-5) used by the litigations dataset's boroid. */
  id: number;
  /** Canonical uppercase borough text used by most datasets' boro/borough. */
  text: string;
  /** Every spelling the Evictions borough column uses for this borough. */
  evictionAliases: string[];
}

const BOROUGHS: Record<string, Borough> = {
  MANHATTAN: { id: 1, text: "MANHATTAN", evictionAliases: ["MANHATTAN", "NEW YORK"] },
  BRONX: { id: 2, text: "BRONX", evictionAliases: ["BRONX"] },
  BROOKLYN: { id: 3, text: "BROOKLYN", evictionAliases: ["BROOKLYN", "KINGS"] },
  QUEENS: { id: 4, text: "QUEENS", evictionAliases: ["QUEENS"] },
  "STATEN ISLAND": { id: 5, text: "STATEN ISLAND", evictionAliases: ["STATEN ISLAND", "RICHMOND"] },
};

/** Every accepted spelling / abbreviation / code -> canonical borough key. */
const BOROUGH_ALIASES: Record<string, string> = {
  MANHATTAN: "MANHATTAN", MN: "MANHATTAN", MAN: "MANHATTAN", "NEW YORK": "MANHATTAN",
  NEWYORK: "MANHATTAN", NY: "MANHATTAN", NYC: "MANHATTAN", "1": "MANHATTAN",
  BRONX: "BRONX", "THE BRONX": "BRONX", BX: "BRONX", "2": "BRONX",
  BROOKLYN: "BROOKLYN", BK: "BROOKLYN", BKLYN: "BROOKLYN", KINGS: "BROOKLYN", "3": "BROOKLYN",
  QUEENS: "QUEENS", QN: "QUEENS", QNS: "QUEENS", "4": "QUEENS",
  "STATEN ISLAND": "STATEN ISLAND", STATENISLAND: "STATEN ISLAND", SI: "STATEN ISLAND",
  RICHMOND: "STATEN ISLAND", "5": "STATEN ISLAND",
};

/** Resolve free-form borough input to a Borough, or throw a clear error. */
function resolveBorough(input: unknown): Borough {
  const s = str(input);
  if (!s) throw new Error("borough is required (Manhattan, Bronx, Brooklyn, Queens, or Staten Island).");
  const key = s.toUpperCase().replace(/\s+/g, " ").trim();
  const canon = BOROUGH_ALIASES[key];
  if (!canon) {
    throw new Error(
      `Unrecognized borough ${JSON.stringify(s)}. Use one of Manhattan, Bronx, Brooklyn, Queens, ` +
        "Staten Island (also accepts MN/BX/BK/QN/SI or the codes 1-5).",
    );
  }
  return BOROUGHS[canon];
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/** Clamp a requested limit into [1, MAX_RESULTS], falling back when absent. */
function clampLimit(v: unknown, fallback: number): number {
  const n = num(v);
  if (n == null) return fallback;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
}

/** Require a non-empty trimmed string argument, or throw naming the field. */
function reqStr(v: unknown, field: string): string {
  const s = str(v);
  if (!s) throw new Error(`${field} is required.`);
  return s;
}

/**
 * Validate an optional ISO date (YYYY-MM-DD) and return it as a floating
 * timestamp lower bound (…T00:00:00) for a SoQL comparison, or undefined.
 */
function normSince(v: unknown, label: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD); got ${JSON.stringify(v)}.`);
  }
  return `${s}T00:00:00`;
}

/** Turn an aggregate `[{key, n}]` result into a { key: count } object + total. */
function tally(rows: Row[], keyField: string): { total: number; by: Record<string, number> } {
  const by: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const key = str(r[keyField]) ?? "(unspecified)";
    const n = num(r.n) ?? 0;
    by[key] = (by[key] ?? 0) + n;
    total += n;
  }
  return { total, by };
}

// ---------------------------------------------------------------------------
// Per-row normalizers (raw SODA columns -> tool output fields)
// ---------------------------------------------------------------------------

/** One HPD violation (wvxf-dwi5). */
function normViolation(r: Row): Record<string, unknown> {
  const status = str(r.violationstatus); // "Open" | "Close"
  return {
    violation_id: str(r.violationid),
    apartment: str(r.apartment),
    story: str(r.story),
    class: str(r.class), // A (non-hazardous), B (hazardous), C (immediately hazardous), I (info)
    description: str(r.novdescription),
    current_status: str(r.currentstatus),
    is_open: status == null ? null : status.toUpperCase() === "OPEN",
    rent_impairing: ynBool(r.rentimpairing),
    inspection_date: str(r.inspectiondate),
    nov_issued_date: str(r.novissueddate),
    nov_type: str(r.novtype),
  };
}

/** One HPD complaint problem row (ygpa-z7cr; one row per reported problem). */
function normComplaint(r: Row): Record<string, unknown> {
  return {
    complaint_id: str(r.complaint_id),
    problem_id: str(r.problem_id),
    apartment: str(r.apartment),
    unit_type: str(r.unit_type),
    space_type: str(r.space_type),
    type: str(r.type), // e.g. EMERGENCY, NON EMERGENCY
    major_category: str(r.major_category),
    minor_category: str(r.minor_category),
    problem_code: str(r.problem_code),
    complaint_status: str(r.complaint_status),
    problem_status: str(r.problem_status),
    status_description: str(r.status_description),
    received_date: str(r.received_date),
  };
}

/** Assemble a "num street, city, state zip" business address from contact fields. */
function contactBusinessAddress(r: Row): string | null {
  const line = [str(r.businesshousenumber), str(r.businessstreetname)].filter(Boolean).join(" ");
  const apt = str(r.businessapartment);
  const cityStateZip = [str(r.businesscity), str(r.businessstate), str(r.businesszip)]
    .filter(Boolean)
    .join(" ");
  const parts = [line, apt ? `Apt ${apt}` : null, cityStateZip].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** One HPD registration contact (feu5-w2e2). */
function normContact(r: Row): Record<string, unknown> {
  const first = str(r.firstname);
  const last = str(r.lastname);
  const person = [first, last].filter(Boolean).join(" ") || null;
  return {
    registration_id: str(r.registrationid),
    type: str(r.type), // CorporateOwner, IndividualOwner, HeadOfficer, Officer, Agent, SiteManager...
    organization: str(r.corporationname),
    person_name: person,
    first_name: first,
    last_name: last,
    business_address: contactBusinessAddress(r),
    business_city: str(r.businesscity),
    business_state: str(r.businessstate),
    business_zip: str(r.businesszip),
  };
}

/** One HPD registration (tesw-yqqr). */
function normRegistration(r: Row): Record<string, unknown> {
  const addr = [str(r.housenumber), str(r.streetname)].filter(Boolean).join(" ");
  return {
    registration_id: str(r.registrationid),
    building_id: str(r.buildingid),
    building_address: addr || null,
    borough: str(r.boro),
    zip: str(r.zip),
    bin: str(r.bin),
    last_registration_date: str(r.lastregistrationdate),
    registration_end_date: str(r.registrationenddate),
  };
}

/** One HPD housing litigation (59kj-x8nc). */
function normLitigation(r: Row): Record<string, unknown> {
  const addr = [str(r.housenumber), str(r.streetname)].filter(Boolean).join(" ");
  return {
    litigation_id: str(r.litigationid),
    building_address: addr || null,
    zip: str(r.zip),
    case_type: str(r.casetype),
    case_open_date: str(r.caseopendate),
    case_status: str(r.casestatus),
    case_judgement: str(r.casejudgement),
    finding_of_harassment: str(r.findingofharassment),
    finding_date: str(r.findingdate),
    penalty: str(r.penalty),
    respondent: str(r.respondent),
  };
}

/** One marshal-executed eviction (6z8x-wfk4). */
function normEviction(r: Row): Record<string, unknown> {
  const marshal = [str(r.marshal_first_name), str(r.marshal_last_name)].filter(Boolean).join(" ") || null;
  return {
    court_index_number: str(r.court_index_number),
    docket_number: str(r.docket_number),
    eviction_address: str(r.eviction_address),
    apartment: str(r.eviction_apt_num),
    borough: str(r.borough),
    zip: str(r.eviction_zip),
    executed_date: str(r.executed_date),
    marshal_name: marshal,
    residential_or_commercial: str(r.residential_commercial_ind),
    ejectment: str(r.ejectment),
    possession_type: str(r.eviction_possession),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const BOROUGH_DESC =
  "NYC borough: Manhattan, Bronx, Brooklyn, Queens, or Staten Island (also accepts MN/BX/BK/QN/SI or 1-5).";

const TOOLS: Tool[] = [
  {
    name: "building_violations",
    description:
      "HPD Housing Maintenance Code violations for one building (dataset wvxf-dwi5). " +
      "Give the house number, street, and borough. Returns a server-side per-class count " +
      "summary (class A non-hazardous, B hazardous, C immediately hazardous, I informational) " +
      "plus the most recent matching violations. Street is matched as an uppercase substring; " +
      "house number is matched exactly. Keyless; an optional NYC_APP_TOKEN only raises the rate limit.",
    inputSchema: {
      type: "object",
      properties: {
        house_number: { type: "string", description: 'Building house number, e.g. "1520".' },
        street: { type: "string", description: 'Street name, e.g. "Sedgwick Avenue" (matched case-insensitively as a substring).' },
        borough: { type: "string", description: BOROUGH_DESC },
        open_only: { type: "boolean", description: "Only violations still open (default false)." },
        violation_class: { type: "string", description: 'Filter to one class: "A", "B", "C", or "I".' },
        since: { type: "string", description: "Only violations inspected on/after this ISO date (YYYY-MM-DD)." },
        limit: { type: "integer", description: `Max detail rows to return (1-${MAX_RESULTS}, default 100). The class summary counts all matches.` },
      },
      required: ["house_number", "street", "borough"],
      additionalProperties: false,
    },
  },
  {
    name: "building_complaints",
    description:
      "HPD complaints and problems for one building (dataset ygpa-z7cr; one row per reported " +
      "problem within a complaint). Give the house number, street, and borough. Returns an " +
      "open/closed count summary plus the most recent matching problems (category, status, dates). " +
      "Street is matched as an uppercase substring; house number exactly. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        house_number: { type: "string", description: 'Building house number, e.g. "1520".' },
        street: { type: "string", description: "Street name (matched case-insensitively as a substring)." },
        borough: { type: "string", description: BOROUGH_DESC },
        open_only: { type: "boolean", description: "Only complaints still open (default false)." },
        since: { type: "string", description: "Only problems received on/after this ISO date (YYYY-MM-DD)." },
        limit: { type: "integer", description: `Max detail rows to return (1-${MAX_RESULTS}, default 100). The status summary counts all matches.` },
      },
      required: ["house_number", "street", "borough"],
      additionalProperties: false,
    },
  },
  {
    name: "who_owns",
    description:
      "Who is on file with HPD for a building, the 'who do I actually serve' tool. Joins HPD " +
      "Registrations (tesw-yqqr) to Registration Contacts (feu5-w2e2) by registration id. Give the " +
      "house number, street, and borough. Returns the registration(s) and every contact " +
      "(corporate/individual owner, head officer, officer, agent, site manager) with names and " +
      "business addresses. Reflects HPD registration filings, which can lag reality. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        house_number: { type: "string", description: 'Building house number, e.g. "1520".' },
        street: { type: "string", description: "Street name (matched case-insensitively as a substring)." },
        borough: { type: "string", description: BOROUGH_DESC },
      },
      required: ["house_number", "street", "borough"],
      additionalProperties: false,
    },
  },
  {
    name: "landlord_litigation",
    description:
      "HPD Housing Litigations (dataset 59kj-x8nc): HPD-initiated cases against landlords plus " +
      "tenant actions. Look up by building (house_number + street + borough) OR by respondent " +
      "(landlord/owner) name. At least one is required. Returns case type, open date, status, " +
      "judgement, any harassment finding, penalty, and respondent, with a by-status summary. " +
      "Respondent and street are matched as case-insensitive substrings. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        house_number: { type: "string", description: "Building house number (building lookup; requires street + borough too)." },
        street: { type: "string", description: "Street name (building lookup; matched as a substring)." },
        borough: { type: "string", description: `${BOROUGH_DESC} Required for a building lookup.` },
        respondent: { type: "string", description: 'Respondent name to match, e.g. an LLC or owner (substring, e.g. "realty llc").' },
        case_status: { type: "string", description: 'Optional status filter, e.g. "OPEN" or "CLOSED".' },
        limit: { type: "integer", description: `Max cases to return (1-${MAX_RESULTS}, default 100).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "eviction_lookup",
    description:
      "Marshal-executed evictions (dataset 6z8x-wfk4). IMPORTANT: this dataset lists evictions a " +
      "city marshal actually CARRIED OUT, not filings, warrants, or pending housing-court cases. " +
      "Look up by court index number OR by address and/or borough. At least one is required. " +
      "Returns court index number, address, executed date, marshal, and residential/commercial flag. " +
      "Address is matched as a case-insensitive substring of the combined eviction address. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        court_index_number: { type: "string", description: 'Housing-court index number to match exactly, e.g. "123456/24".' },
        address: { type: "string", description: 'Address substring to match, e.g. "123 Example Avenue" (matched within the combined eviction address).' },
        borough: { type: "string", description: BOROUGH_DESC },
        since: { type: "string", description: "Only evictions executed on/after this ISO date (YYYY-MM-DD)." },
        limit: { type: "integer", description: `Max rows to return (1-${MAX_RESULTS}, default 50).` },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function buildingViolations(args: Row): Promise<unknown> {
  const houseNumber = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);
  const openOnly = args.open_only === true;
  const since = normSince(args.since, "since");
  const violationClass = str(args.violation_class);
  const limit = clampLimit(args.limit, 100);

  const conditions = [
    eqTextCI("housenumber", houseNumber),
    eqText("boro", boro.text),
    likeCI("streetname", street),
  ];
  if (openOnly) conditions.push(eqTextCI("violationstatus", "OPEN"));
  if (violationClass) conditions.push(eqTextCI("class", violationClass));
  if (since) conditions.push(gteDate("inspectiondate", since));
  const where = whereAnd(conditions);

  // Summary: server-side class tally over ALL matches (not just the returned page).
  const summaryRows = await sodaGet(DATASET.violations, {
    $select: "class,count(1) as n",
    $where: where,
    $group: "class",
    $order: "class",
  });
  const { total, by } = tally(summaryRows, "class");

  const rows = await sodaGet(DATASET.violations, {
    $where: where,
    $order: "inspectiondate DESC",
    $limit: limit,
  });
  const results = rows.map(normViolation);

  return {
    query: {
      house_number: houseNumber,
      street,
      borough: boro.text,
      open_only: openOnly,
      violation_class: violationClass ?? null,
      since: str(args.since) ?? null,
    },
    summary: { total_matching: total, by_class: by },
    returned: results.length,
    results,
  };
}

async function buildingComplaints(args: Row): Promise<unknown> {
  const houseNumber = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);
  const openOnly = args.open_only === true;
  const since = normSince(args.since, "since");
  const limit = clampLimit(args.limit, 100);

  const conditions = [
    eqTextCI("house_number", houseNumber),
    eqText("borough", boro.text),
    likeCI("street_name", street),
  ];
  if (openOnly) conditions.push(eqTextCI("complaint_status", "OPEN"));
  if (since) conditions.push(gteDate("received_date", since));
  const where = whereAnd(conditions);

  // Summary: server-side open/closed tally over ALL matches.
  const summaryRows = await sodaGet(DATASET.complaints, {
    $select: "complaint_status,count(1) as n",
    $where: where,
    $group: "complaint_status",
    $order: "complaint_status",
  });
  const { total, by } = tally(summaryRows, "complaint_status");

  const rows = await sodaGet(DATASET.complaints, {
    $where: where,
    $order: "received_date DESC",
    $limit: limit,
  });
  const results = rows.map(normComplaint);

  return {
    query: {
      house_number: houseNumber,
      street,
      borough: boro.text,
      open_only: openOnly,
      since: str(args.since) ?? null,
    },
    summary: { total_matching: total, by_status: by },
    returned: results.length,
    results,
  };
}

async function whoOwns(args: Row): Promise<unknown> {
  const houseNumber = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);

  const where = whereAnd([
    eqTextCI("housenumber", houseNumber),
    eqText("boro", boro.text),
    likeCI("streetname", street),
  ]);
  const regRows = await sodaGet(DATASET.registrations, {
    $where: where,
    $order: "lastregistrationdate DESC",
    $limit: 25,
  });
  const registrations = regRows.map(normRegistration);

  const query = { house_number: houseNumber, street, borough: boro.text };
  if (registrations.length === 0) {
    return {
      query,
      found: false,
      note:
        "No current HPD registration matched. A building may be unregistered, registered under a " +
        "different street spelling, or below the registration threshold. Try building_violations to confirm the address.",
      registrations: [],
      contacts: [],
    };
  }

  // Join to contacts by every matched registration id.
  const regIds = registrations
    .map((r) => num((r as Row).registration_id))
    .filter((n): n is number => n != null);
  let contacts: Record<string, unknown>[] = [];
  if (regIds.length) {
    const contactRows = await sodaGet(DATASET.contacts, {
      $where: inNum("registrationid", regIds),
      $limit: 200,
    });
    contacts = contactRows.map(normContact);
  }

  // Group by contact type for a quick "who to serve" scan.
  const byType: Record<string, unknown[]> = {};
  for (const c of contacts) {
    const t = (str((c as Row).type) ?? "Other") as string;
    (byType[t] ??= []).push(c);
  }

  return {
    query,
    found: true,
    note: "Contacts are HPD registration filings (owner/agent/officer of record); confirm before relying on them for service of process.",
    registrations,
    contacts_by_type: byType,
    contacts,
  };
}

async function landlordLitigation(args: Row): Promise<unknown> {
  const houseNumber = str(args.house_number);
  const street = str(args.street);
  const respondent = str(args.respondent);
  const caseStatus = str(args.case_status);
  const limit = clampLimit(args.limit, 100);

  const conditions: string[] = [];
  let boroText: string | null = null;

  // Building lookup: needs all three address parts (borough -> numeric boroid).
  if (houseNumber || street) {
    if (!houseNumber || !street || !str(args.borough)) {
      throw new Error("A building lookup needs house_number, street, and borough together. Or search by respondent instead.");
    }
    const boro = resolveBorough(args.borough);
    boroText = boro.text;
    conditions.push(eqTextCI("housenumber", houseNumber), eqNum("boroid", boro.id), likeCI("streetname", street));
  } else if (str(args.borough)) {
    // Borough given without a building: scope a respondent search to that boroid.
    const boro = resolveBorough(args.borough);
    boroText = boro.text;
    conditions.push(eqNum("boroid", boro.id));
  }

  if (respondent) conditions.push(likeCI("respondent", respondent));
  if (caseStatus) conditions.push(eqTextCI("casestatus", caseStatus));

  if (!respondent && !(houseNumber && street)) {
    throw new Error("Provide a building (house_number + street + borough) or a respondent name.");
  }

  const rows = await sodaGet(DATASET.litigations, {
    $where: whereAnd(conditions),
    $order: "caseopendate DESC",
    $limit: limit,
  });
  const results = rows.map(normLitigation);

  // Small per-status tally over the returned rows.
  const byStatus: Record<string, number> = {};
  for (const r of results) {
    const s = (str((r as Row).case_status) ?? "(unspecified)") as string;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }

  return {
    query: {
      house_number: houseNumber ?? null,
      street: street ?? null,
      borough: boroText,
      respondent: respondent ?? null,
      case_status: caseStatus ?? null,
    },
    summary: { returned: results.length, by_status: byStatus },
    note: results.length === limit ? `Capped at limit ${limit}; narrow the query for more.` : undefined,
    returned: results.length,
    results,
  };
}

async function evictionLookup(args: Row): Promise<unknown> {
  const courtIndex = str(args.court_index_number);
  const address = str(args.address);
  const since = normSince(args.since, "since");
  const limit = clampLimit(args.limit, 50);

  let boroText: string | null = null;
  const conditions: string[] = [];
  if (courtIndex) conditions.push(eqText("court_index_number", courtIndex));
  if (address) conditions.push(likeCI("eviction_address", address));
  if (str(args.borough)) {
    const boro = resolveBorough(args.borough);
    boroText = boro.text;
    // Evictions borough column mixes borough + county spellings; match all aliases.
    conditions.push(inText("borough", boro.evictionAliases));
  }
  if (since) conditions.push(gteDate("executed_date", since));

  if (!courtIndex && !address && !boroText) {
    throw new Error("Provide at least one of court_index_number, address, or borough.");
  }

  const rows = await sodaGet(DATASET.evictions, {
    $where: whereAnd(conditions),
    $order: "executed_date DESC",
    $limit: limit,
  });
  const results = rows.map(normEviction);

  return {
    query: {
      court_index_number: courtIndex ?? null,
      address: address ?? null,
      borough: boroText,
      since: str(args.since) ?? null,
    },
    note: "Marshal-executed evictions only; this dataset does not include filings, warrants, or pending cases.",
    returned: results.length,
    results,
  };
}

const HANDLERS: Record<string, (args: Row) => Promise<unknown>> = {
  building_violations: buildingViolations,
  building_complaints: buildingComplaints,
  who_owns: whoOwns,
  landlord_litigation: landlordLitigation,
  eviction_lookup: evictionLookup,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-nychousing", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await handler((args ?? {}) as Row);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Exported for tests only (not part of the MCP surface).
export const __test = { resolveBorough, soql, likeCI, eqTextCI, inText, tally };
