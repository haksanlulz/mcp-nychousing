// mcp-nychousing: MCP server over NYC Open Data (Socrata / SODA) for NYC
// housing data: HPD maintenance-code violations, complaints, building
// ownership / registration, landlord portfolios (every building registered
// under an owner/agent name), HPD-initiated litigation against landlords, and
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
  // --- added for the 1.1.0 coverage expansion (each verified live before use) ---
  dobViolations: "3h2n-5cm9", // DOB violations (BIS): boro is a NUMERIC-as-text code 1-5 (plus legacy junk rows)
  dobComplaints: "eabe-havv", // DOB complaints: NO borough column; community_board's first digit is the borough code
  threeOneOne: "erm2-nwe9", // 311 service requests: borough is uppercase text
  bedbug: "wz6d-d3jb", // HPD bedbug filings: borough uppercase text
  aep: "hcir-3275", // HPD Alternative Enforcement Program: boro is Title Case text
  vacate: "tb8q-a3ar", // HPD vacate orders: boro_short_name is the 2-letter code
  hwo: "sbnd-xujn", // HPD Handyman Work Order (emergency-repair) charges: boro uppercase text
  pluto: "64uk-42ks", // PLUTO tax lots: borough is the 2-letter code; carries DOF ownername + bbl
  acrisLegals: "8h5j-fqxa", // ACRIS real property legals: borough/block/lot -> document_id
  acrisMaster: "bnx9-e6tj", // ACRIS real property master: document_id -> doc type/date/amount
  acrisParties: "636b-3b5g", // ACRIS real property parties: document_id -> named parties
  speculationWatch: "adax-9mit", // Speculation Watch List: qualifying flip-risk purchases
} as const;

/**
 * Read an integer environment knob, falling back to the documented default.
 *
 * A bad value here is not inert. `Number("abc")` is NaN, and NaN silently
 * disables whatever it configures — each confirmed by running the code path:
 *   - SODA_HTTP_ATTEMPTS: `for (a = 0; a < NaN; a++)` never enters, so withRetry
 *     falls straight to `throw last` with `last` still undefined and the handler
 *     renders literally "Error: undefined" — with no HTTP request made at all.
 *   - SODA_CACHE_TTL_MS: `NaN <= 0` is false so the cache stays on, and
 *     `age > NaN` is false so no entry ever expires.
 *   - SODA_CACHE_MAX: `size > NaN` is false, so eviction never runs and the map
 *     grows unbounded.
 *
 * Reported on stderr and never thrown: an optional knob with a typo must not
 * take the server down at import time. stderr is the only usable channel here —
 * stdout is the MCP JSON-RPC stream.
 */
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    process.stderr.write(
      `mcp-nychousing: ${name}=${JSON.stringify(raw)} is not an integer >= ${min}; using the default ${fallback}.\n`,
    );
    return fallback;
  }
  return n;
}

/** Where to get a free (optional) Socrata app token; tools work without one. */
const APP_TOKEN_DOCS = "https://dev.socrata.com/docs/app-tokens.html";
/** Descriptive User-Agent (NYC Open Data is a free public service; be identifiable). */
const UA = "mcp-nychousing/1.0 (+https://github.com/haksanlulz/mcp-nychousing)";
/** Minimum spacing between outbound API calls (polite throttle). */
const THROTTLE_MS = 200;
/** Abort a single outbound request after this long. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Hard upper bound on rows returned by any single detail tool call. */
const MAX_RESULTS = 500;
/** Contact rows scanned per landlord_portfolio search; a response note reports
 * when the server-side match count exceeds this. */
const PORTFOLIO_SCAN_CAP = 1000;
/** Registration ids per IN() chunk when resolving a portfolio to buildings
 * (keeps each query URL well under length limits). */
const PORTFOLIO_ID_CHUNK = 100;
/** Rows per page when resolving one registration-id chunk to buildings.
 *
 * One registrationid does NOT mean one building: in tesw-yqqr a single
 * registration routinely covers a whole multi-building portfolio (live
 * 2026-09-14, registrationid 10391 = 87 rows / 87 distinct buildingids), so a
 * chunk is paged to a short read rather than capped at the chunk's id count.
 * Capping at the id count returned 1 of those 87 with no warning. */
const PORTFOLIO_PAGE_SIZE = MAX_RESULTS;
/** Ceiling on buildings resolved across every chunk. It is checked after each
 * page rather than mid-page, so the resolved count can land up to one page
 * above it; leaving ids unread because of it emits an explicit truncation note
 * rather than silently shortening the portfolio. */
const PORTFOLIO_BUILDING_CAP = MAX_RESULTS * 4;

// ---------------------------------------------------------------------------
// Auth (optional app token)
// ---------------------------------------------------------------------------

/**
 * The Socrata app token if set, else null. Only used to raise the rate limit.
 *
 * An unsubstituted template is treated as unset. The .mcpb manifest injects the
 * token as NYC_APP_TOKEN=${user_config.app_token} and the field is optional, and
 * the MCPB spec does not state what a host passes for an optional value the user
 * left blank - so rather than assume, reject anything still carrying "${", which
 * can never be a real token. Sending one as X-App-Token would be a bad-credential
 * header on every request.
 */
function optionalToken(): string | null {
  const raw = process.env.NYC_APP_TOKEN?.trim();
  if (!raw || raw.includes("${")) return null;
  return raw;
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

/**
 * Run `fn` after all prior throttled calls, then hold the queue open for
 * THROTTLE_MS so the NEXT call starts spaced out. The caller receives fn's
 * result as soon as it settles (the gap is charged to the following call, not
 * this one). Rejections are swallowed on the internal chain so one failed call
 * cannot poison the queue; the caller still sees the original error via `run`.
 */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => new Promise((r) => setTimeout(r, THROTTLE_MS)),
    () => new Promise((r) => setTimeout(r, THROTTLE_MS)),
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
// Socrata is a shared public endpoint, so a 429 or a 5xx is a "come back", not a
// verdict. Ported from mcp-housing.
//
// Retried: 429, 5xx, and transport errors. NOT retried: other 4xx (a malformed
// SoQL answers the same however often it is asked) and a non-JSON body.
//
// ⚑ The non-JSON call is a genuine judgment: an HTML interstitial during an
// upstream wobble IS transient and would benefit from a retry, while a rejected
// app token is not and would not. Treated as permanent for consistency with the
// sibling servers and because not-retrying is the conservative direction; revisit
// if interstitials are ever observed in practice.
class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
class PermanentError extends Error {}

// At least one attempt: a zero cap reaches `throw last` with last undefined.
const HTTP_ATTEMPTS = envInt("SODA_HTTP_ATTEMPTS", 3, 1);
const RETRY_BACKOFF_MS = [500, 2000];
const RETRY_DEADLINE_MS = 40_000;

function isRetryable(e: unknown): boolean {
  if (e instanceof PermanentError) return false;
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  return true; // transport error or abort
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let last: unknown;
  for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === HTTP_ATTEMPTS - 1 || !isRetryable(e)) break;
      const backoff = RETRY_BACKOFF_MS[attempt] ?? 2000;
      if (Date.now() - started + backoff + REQUEST_TIMEOUT_MS > RETRY_DEADLINE_MS) break;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}

// HPD refreshes its Open Data extracts every 8 hours (operator-stated
// 2026-08-24), so a repeat query inside that window is asking a question whose
// answer cannot have moved. TTL is matched to that cadence rather than guessed.
//
// ⚠️ Worst case this serves data up to ~8h behind the latest extract: an entry
// written just before a refresh lives until just before the one after. That is
// one cycle, which is the honest bound of any TTL cache against a periodic
// source. Set SODA_CACHE_TTL_MS=0 to disable if a caller needs the freshest
// possible read.
//
// In memory only, and only successful reads: an MCP server is a short-lived
// child process, and caching an error would pin a transient failure for the
// life of it.
// min 0, because 0 is the documented way to disable the cache.
const CACHE_TTL_MS = envInt("SODA_CACHE_TTL_MS", 8 * 60 * 60 * 1000, 0);
const CACHE_MAX = envInt("SODA_CACHE_MAX", 300, 1);
const cache = new Map<string, { at: number; rows: Row[] }>();

function cacheGet(key: string): Row[] | undefined {
  if (CACHE_TTL_MS <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // re-insert to move the key to the end of Map order, making eviction LRU
  cache.delete(key);
  cache.set(key, hit);
  return hit.rows;
}

function cacheSet(key: string, rows: Row[]): void {
  if (CACHE_TTL_MS <= 0) return;
  cache.set(key, { at: Date.now(), rows });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Exported for tests: a cache that cannot be cleared makes every later test
 *  depend on the order of the ones before it. */
export function clearSodaCache(): void {
  cache.clear();
}

async function sodaGet(dataset: string, params: Record<string, QueryValue> = {}): Promise<Row[]> {
  const key = `${dataset}?${JSON.stringify(params)}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const rows = await withRetry(() => sodaGetOnce(dataset, params));
  cacheSet(key, rows);
  return rows;
}

async function sodaGetOnce(dataset: string, params: Record<string, QueryValue> = {}): Promise<Row[]> {
  const url = new URL(`${NYC_API}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  // The whole fetch + parse runs inside the throttle so spacing and the request
  // timeout apply to every call.
  return throttled(async () => {
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
      throw new HttpError(`NYC Open Data request failed (HTTP ${res.status}): ${detail}`, res.status);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // HTML error pages / proxy interstitials arrive as non-JSON with a 200.
      throw new PermanentError(`NYC Open Data returned a non-JSON response: ${text.slice(0, 300).trim()}`);
    }

    if (Array.isArray(json)) return json as Row[];
    // A 200 with an error object is rare but possible for malformed SoQL.
    if (json && typeof json === "object" && (json as Row).error) {
      const msg = (json as Row).message;
      throw new Error(`NYC Open Data query error: ${typeof msg === "string" ? msg : JSON.stringify(json)}`);
    }
    throw new Error("NYC Open Data returned an unexpected (non-array) response.");
  });
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

/**
 * Escape a string for use INSIDE a SoQL LIKE pattern. Beyond `soql`'s quote
 * escaping, the LIKE wildcards `%` (any run) and `_` (any single char) and the
 * escape character `\` itself must be neutralized, or user input like "100%"
 * would silently widen the match to everything. SoQL treats backslash as the
 * LIKE escape char (`2\_7` matches a literal "2_7", not "217").
 * Order matters: double backslashes first, then the wildcards, then the quote.
 */
function soqlLike(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/'/g, "''");
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

/** `upper(col) like '%value%'`, a case-insensitive substring match. The outer
 * `%` are our intentional wildcards; the user value is wildcard-escaped. */
function likeCI(col: string, value: string): string {
  return `upper(${col}) like '%${soqlLike(value.toUpperCase())}%'`;
}

/**
 * A house number sitting on a TOKEN BOUNDARY inside a free-text address line:
 * it either starts the line or follows a space, and is followed by a space or
 * by the hyphen of a range ("2763-69 SEDGWICK AVE").
 *
 * A bare `'%<hn>%<street>%'` reads one building's rows onto another, because
 * the number matches inside a longer number: live 2026-09-14, `'%20%SEDGWICK%'`
 * in the Bronx returns 13 executed evictions and every one of them belongs to
 * 1520 SEDGWICK AVENUE. Anchored, the same house 20 returns 0, while house 2763
 * still returns the range spellings and house 2707 still matches the A/K/A form
 * ("155B KINGSBRIDGE RD A/K/A 2707 SEDGWICK AVENUE").
 */
function houseNumberAnchored(col: string, hn: string): string {
  const p = soqlLike(hn.toUpperCase());
  const patterns = [`'${p} %'`, `'${p}-%'`, `'% ${p} %'`, `'% ${p}-%'`];
  return `(${patterns.map((pat) => `upper(${col}) like ${pat}`).join(" OR ")})`;
}

/**
 * Generic street-type words, each mapped to the two-letter stems a free-text
 * address line may use for it. The distinctive part of a street name is what is
 * left once these are stripped off the end; directionals are NOT in the list,
 * since "E 138 STREET" and "W 138 STREET" are different streets.
 *
 * A family needs more than one stem whenever the abbreviation is not a prefix
 * of the full word: the evictions dataset stores "3704 WHITE PLAINS RD",
 * "4064 BRONX BLVD", "4 LYNN CT", "2104 CROTONA PKWY", "2821 KINGS HWY". Taking
 * the first two letters of the caller's word instead would require "RO" of an
 * "RD" line and read those buildings as having no evictions (measured live
 * 2026-09-14: 4064 Bronx Boulevard drops from 13 to 0 that way).
 */
const STREET_TYPE_STEMS = new Map<string, string[]>([
  ["AVENUE", ["AV"]], ["AVE", ["AV"]], ["AV", ["AV"]],
  ["STREET", ["ST"]], ["STR", ["ST"]], ["ST", ["ST"]],
  ["ROAD", ["RO", "RD"]], ["RD", ["RO", "RD"]],
  ["PLACE", ["PL"]], ["PL", ["PL"]],
  ["BOULEVARD", ["BO", "BL"]], ["BLVD", ["BO", "BL"]],
  ["DRIVE", ["DR"]], ["DR", ["DR"]],
  ["LANE", ["LA", "LN"]], ["LN", ["LA", "LN"]],
  ["COURT", ["CO", "CT"]], ["CT", ["CO", "CT"]],
  ["TERRACE", ["TE"]], ["TER", ["TE"]],
  ["PARKWAY", ["PA", "PK"]], ["PKWY", ["PA", "PK"]],
  ["HIGHWAY", ["HI", "HW"]], ["HWY", ["HI", "HW"]],
  ["EXPRESSWAY", ["EX"]], ["EXPY", ["EX"]],
  ["CIRCLE", ["CI"]], ["CIR", ["CI"]],
  ["SQUARE", ["SQ"]], ["SQ", ["SQ"]],
]);

/**
 * The distinctive part of a street name: everything before the generic type
 * word ("SEDGWICK AVENUE" -> "SEDGWICK"). Falls back to the whole input when
 * stripping would leave nothing, so "AVENUE X" or a bare "AVENUE" survives.
 */
function streetDistinctive(street: string): string {
  const whole = street.toUpperCase().trim();
  const words = whole.split(/\s+/).filter(Boolean);
  while (words.length > 1 && STREET_TYPE_STEMS.has(words[words.length - 1])) words.pop();
  return words.join(" ") || whole;
}

/**
 * The outermost generic type word `streetDistinctive` strips, or null when the
 * caller gave a street that carries none ("GRAND CONCOURSE", "AVENUE X").
 */
function streetTypeWord(street: string): string | null {
  const words = street.toUpperCase().trim().split(/\s+/).filter(Boolean);
  let last: string | null = null;
  while (words.length > 1 && STREET_TYPE_STEMS.has(words[words.length - 1])) last = words.pop()!;
  return last;
}

/**
 * The street, anchored the way houseNumberAnchored anchors the number: the
 * distinctive token sits on a word boundary; when the caller's street carried a
 * generic type word, a stem of that word FOLLOWS the distinctive token with
 * nothing but spaces between (or the line ends on the distinctive token, i.e.
 * stores no type word); and no directional PRECEDES it (see STREET_DIRECTIONALS
 * below -- that arm is the only one a street carrying no type word gets, and
 * "475 WEST BROADWAY" was 475 Broadway's only reported eviction without it).
 *
 * A bare '%<distinctive>%' reads another street's evictions onto this building.
 * Measured live 2026-09-14 against 6z8x-wfk4: house 1650 on OCEAN AVENUE in
 * Brooklyn returned 3 executed evictions, all three of them 1650 OCEAN
 * PARKWAY's, on an HPD-registered building with none of its own; 1170 returned
 * 6 where 4 are its own; 100 PARK PLACE returned 4, none on Park Place (two at
 * 100 OCEAN PARKWAY, two matching PARKING inside an apartment descriptor);
 * 1500 GRAND AVENUE in the Bronx returned 4, all at 1500 GRAND CONCOURSE.
 *
 * Bounding the distinctive token is necessary and NOT sufficient: a street whose
 * name is a PREFIX of a longer street in the same borough carries the type stem
 * somewhere in the line anyway. Live 2026-09-14, with the distinctive token
 * bounded but the stem free-floating, "590 MORRIS PARK AVE" was 590 MORRIS
 * AVENUE's only executed eviction, "632 MORRIS PARK AVENUE" was 632's only one,
 * and 562 MORRIS AVENUE read 7 where 6 are its own — three HPD-registered Bronx
 * buildings (buildingid 97665 / 97675 / 97662). Requiring the stem to follow the
 * distinctive token takes those to 0 / 0 / 6, while every regression case holds:
 * 1520 / 2763 / 2707 / 3605 SEDGWICK stay at 13 / 8 / 7 / 17 (the "2763-69"
 * range, the "155B KINGSBRIDGE RD A/K/A 2707 SEDGWICK AVENUE" form and the
 * mangled "3605 SEDGWICK    AVE NUE" included), 4064 BRONX BLVD stays 13,
 * 3704 WHITE PLAINS RD stays 1, 1170 OCEAN AVENUE stays 4, and 1650 OCEAN /
 * 100 PARK PLACE / 1500 GRAND AVENUE stay 0.
 *
 * The stem is not required to be ADJACENT in the abbreviation sense — the column
 * both abbreviates and mangles the type word ("AVE NUE", "AVEN UE"), which the
 * two-letter stem already covers — but it must be the next token. SoQL LIKE has
 * no "one or more spaces" quantifier and the column stores runs of them
 * ("SEDGWICK    AVE NUE"), so the runs are enumerated; 8 is above the longest
 * run measured in 6z8x-wfk4.
 *
 * Residual: house number and street are independent conditions on one free-text
 * line, so a row naming two addresses (A/K/A) can still be attributed to either.
 * And a street name that is a SUFFIX of a longer one with no directional and no
 * type word between them is still unguarded.
 */
const STREET_TYPE_GAPS = [" ", "  ", "   ", "    ", "     ", "      ", "       ", "        "];

/**
 * Directionals that name a DIFFERENT street when they sit in front of the
 * distinctive token. They are deliberately absent from STREET_TYPE_STEMS (a
 * directional is not a type word), which is why neither the boundary arm nor
 * the stem arm can see one.
 */
const STREET_DIRECTIONALS = ["NORTH", "SOUTH", "EAST", "WEST", "N", "S", "E", "W"];

function streetAnchored(col: string, street: string): string {
  const dist = soqlLike(streetDistinctive(street));
  const boundary = [`'${dist} %'`, `'% ${dist} %'`, `'% ${dist}'`, `'${dist}'`]
    .map((p) => `upper(${col}) like ${p}`)
    .join(" OR ");
  const conds = [`(${boundary})`];
  const type = streetTypeWord(street);
  if (type) {
    const arms: string[] = [];
    for (const stem of STREET_TYPE_STEMS.get(type) ?? []) {
      for (const gap of STREET_TYPE_GAPS) arms.push(`upper(${col}) like '%${dist}${gap}${soqlLike(stem)}%'`);
    }
    // No type word stored at all ("68 WEST 238TH STRE ET AKA 3605 SEDGWICK"):
    // the line ending on the distinctive token is not some other street.
    arms.push(`upper(${col}) like '% ${dist}'`, `upper(${col}) like '${dist}'`);
    conds.push(`(${arms.join(" OR ")})`);
  }
  // A DIRECTIONAL in front of the distinctive token names a DIFFERENT street,
  // and neither guard above can see it -- least of all on a street carrying no
  // type word, which gets the boundary arm ALONE. Live 2026-09-15 against
  // 6z8x-wfk4: "475 WEST BROADWAY" was the only executed eviction the profile
  // reported for 475 Broadway, Manhattan (both buildings HPD-registered in
  // tesw-yqqr, buildingid 8330 and 43923); 88 Broadway read 3, all of them West
  // or East Broadway's; 341 and 482 Broadway read 1 each, both West Broadway's.
  //
  // Skipped when the caller's OWN street starts with a directional, since it is
  // then part of `dist` and excluding it would exclude the building itself
  // (475 West Broadway still returns its own 1).
  //
  // Re-measured with this clause, live 2026-09-15: 475 / 341 / 482 / 88
  // Broadway -> 0, 424 Broadway -> 1 (its own "424-426 BROADWAY COMMERICAL UNIT
  // NO. 1" row, down from 2), 475 West Broadway -> 1, and every regression case
  // holds -- 1520 / 2763 / 2707 / 3605 SEDGWICK at 13 / 8 / 7 / 17, 4064 BRONX
  // BLVD 13, 3704 WHITE PLAINS RD 1, 1170 OCEAN AVENUE 4, 562 MORRIS AVENUE 6,
  // and 1650 OCEAN / 100 PARK PLACE / 1500 GRAND AVENUE at 0.
  if (!STREET_DIRECTIONALS.includes(dist.split(" ")[0])) {
    const excl: string[] = [];
    for (const d of STREET_DIRECTIONALS) {
      for (const gap of STREET_TYPE_GAPS) excl.push(`upper(${col}) like '% ${d}${gap}${dist}%'`);
      excl.push(`upper(${col}) like '${d} ${dist}%'`);
    }
    conds.push(`NOT (${excl.join(" OR ")})`);
  }
  return `(${conds.join(" AND ")})`;
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
  /** 2-letter code used by PLUTO's borough and the vacate orders' boro_short_name. */
  short: string;
  /** Every spelling the Evictions borough column uses for this borough. */
  evictionAliases: string[];
}

const BOROUGHS: Record<string, Borough> = {
  MANHATTAN: { id: 1, text: "MANHATTAN", short: "MN", evictionAliases: ["MANHATTAN", "NEW YORK"] },
  BRONX: { id: 2, text: "BRONX", short: "BX", evictionAliases: ["BRONX"] },
  BROOKLYN: { id: 3, text: "BROOKLYN", short: "BK", evictionAliases: ["BROOKLYN", "KINGS"] },
  QUEENS: { id: 4, text: "QUEENS", short: "QN", evictionAliases: ["QUEENS"] },
  "STATEN ISLAND": { id: 5, text: "STATEN ISLAND", short: "SI", evictionAliases: ["STATEN ISLAND", "RICHMOND"] },
};

/** Every accepted spelling / abbreviation / code -> canonical borough key. */
const BOROUGH_ALIASES: Record<string, string> = {
  // "NEW YORK" (the county name) and code "1" are real Manhattan references and
  // stay. "NY"/"NYC" name the whole city, not a borough, and are handled as
  // ambiguous below rather than silently mapped to Manhattan (a "NYC" query
  // used to return Manhattan-only data under a city-wide label).
  MANHATTAN: "MANHATTAN", MN: "MANHATTAN", MAN: "MANHATTAN", "NEW YORK": "MANHATTAN",
  NEWYORK: "MANHATTAN", "1": "MANHATTAN",
  BRONX: "BRONX", "THE BRONX": "BRONX", BX: "BRONX", "2": "BRONX",
  BROOKLYN: "BROOKLYN", BK: "BROOKLYN", BKLYN: "BROOKLYN", KINGS: "BROOKLYN", "3": "BROOKLYN",
  QUEENS: "QUEENS", QN: "QUEENS", QNS: "QUEENS", "4": "QUEENS",
  "STATEN ISLAND": "STATEN ISLAND", STATENISLAND: "STATEN ISLAND", SI: "STATEN ISLAND",
  RICHMOND: "STATEN ISLAND", "5": "STATEN ISLAND",
};

/**
 * City-wide inputs that name the whole city, not one borough. HPD datasets are
 * per-borough, so silently resolving these to Manhattan (as an earlier version
 * did for NY/NYC) returns one borough's data under a five-borough label: a
 * silent wrong answer. We reject them with an error instead of querying all
 * five boroughs, because each dataset uses a different borough column and a
 * single Borough value flows through every query.
 */
const CITYWIDE_AMBIGUOUS = new Set(["NY", "NYC", "NEW YORK CITY"]);

/** Resolve free-form borough input to a Borough, or throw a clear error. */
function resolveBorough(input: unknown): Borough {
  const s = str(input);
  if (!s) throw new Error("borough is required (Manhattan, Bronx, Brooklyn, Queens, or Staten Island).");
  const key = s.toUpperCase().replace(/\s+/g, " ").trim();
  if (CITYWIDE_AMBIGUOUS.has(key)) {
    throw new Error(
      `Borough ${JSON.stringify(s)} is ambiguous: it names the whole city, not one borough. ` +
        "Specify MANHATTAN, BRONX, BROOKLYN, QUEENS, or STATEN ISLAND (one borough per query).",
    );
  }
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

/**
 * Candidate house-number spellings to try when an exact match finds nothing.
 * NYC outer-borough addresses (Queens especially) are stored hyphenated, e.g.
 * "120-15"; a user who types "12015" or "120 15" would otherwise get a silent
 * zero, which for a tenant reads as a falsely clean building. Returns the input
 * first (so a direct hit needs no retry), then separator-normalized forms. The
 * digit-insertion form ("12015" -> "120-15") is only offered when
 * `hyphenateDigits` is set (callers pass this for Queens), so plain numbers in
 * other boroughs are never rewritten into unrelated addresses.
 */
function houseNumberVariants(input: string, opts: { hyphenateDigits?: boolean } = {}): string[] {
  const base = input.toUpperCase().trim();
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(base);
  if (/[\s-]/.test(base)) {
    push(base.replace(/\s+/g, "-")); // "120 15" -> "120-15"
    push(base.replace(/[\s-]+/g, "")); // "120-15" -> "12015"
  }
  if (opts.hyphenateDigits && /^\d{3,}$/.test(base)) {
    push(`${base.slice(0, -2)}-${base.slice(-2)}`); // "12015" -> "120-15"
  }
  return out;
}

/**
 * House-number spellings for a COMBINED address line ("12015 Queens Boulevard"
 * -> ["12015 Queens Boulevard", "120-15 Queens Boulevard"]).
 *
 * Only the leading token is rewritten, and only when it starts with a digit;
 * an address that does not begin with a house number is returned unchanged, so
 * nothing is rewritten into an unrelated address.
 */
function addressHouseNumberVariants(address: string, opts: { hyphenateDigits?: boolean } = {}): string[] {
  const trimmed = address.trim();
  const m = /^(\S+)(\s+.+)$/.exec(trimmed);
  if (!m || !/^\d/.test(m[1])) return [trimmed];
  const rest = m[2];
  const out: string[] = [];
  for (const v of houseNumberVariants(m[1], opts)) {
    const candidate = `${v}${rest}`;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Run `probe` for each house-number spelling variant until one reports a match,
 * defeating the hyphenation silent-zero. Returns the matching variant's result
 * (and which spelling won); if none match, returns the first (literal) attempt's
 * result unchanged so the caller still reports the empty result for the
 * spelling the user gave.
 *
 * `tried` is the spellings actually queried. Stopping on the first match means
 * the rest went UNQUERIED, and in a dataset that files one building under more
 * than one spelling those hold their own rows: live 2026-09-14 on 3h2n-5cm9,
 * boro='4' and street like '%QUEENS BOULEVARD%', house_number '9015' returns 12
 * DOB violations and '90-15' returns 383. A caller who typed the de-hyphenated
 * form gets 12 and, without this, is told nothing. `matchedVariant` cannot
 * carry that: it is false both when the literal matched and stopped the loop,
 * and when nothing matched and every spelling was tried.
 */
async function tryHouseNumberVariants<T>(
  variants: string[],
  probe: (houseNumber: string) => Promise<{ matched: boolean; value: T }>,
): Promise<{ houseNumber: string; matchedVariant: boolean; tried: string[]; value: T }> {
  let first: { houseNumber: string; value: T } | undefined;
  const tried: string[] = [];
  for (const houseNumber of variants) {
    tried.push(houseNumber);
    const r = await probe(houseNumber);
    if (!first) first = { houseNumber, value: r.value };
    if (r.matched) return { houseNumber, matchedVariant: houseNumber !== variants[0], tried, value: r.value };
  }
  return { houseNumber: first!.houseNumber, matchedVariant: false, tried, value: first!.value };
}

/**
 * Guidance for an empty per-building result. Two distinct rescues, learned
 * from live misses: (1) the house-number variants the server ALREADY tried —
 * without naming them, a reader retypes "120-15" by hand and gets the same
 * zero; (2) the street field is substring-matched, so the shortest
 * distinctive fragment ("Sedgwick", not "Sedgwich Av") is the reliable form.
 */
function emptyBuildingNote(triedVariants: string[], street: string): string {
  const tried = triedVariants.length > 1 ? `Tried house-number spellings: ${triedVariants.join(", ")}. ` : "";
  return (
    `No rows matched. ${tried}` +
    `Street is matched as a substring — a misspelling returns zero, so try the shortest distinctive ` +
    `fragment of the street name (e.g. "Sedgwick" rather than ${JSON.stringify(street)}), and check ` +
    "the borough. A true zero and a wrong-spelling zero look identical without this."
  );
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

// --- normalizers for the 1.1.0 datasets ------------------------------------

/** One DOB violation (3h2n-5cm9). DOB BIS dates arrive as raw "YYYYMMDD" strings. */
function normDobViolation(r: Row): Record<string, unknown> {
  return {
    violation_number: str(r.number) ?? str(r.violation_number),
    isn: str(r.isn_dob_bis_viol),
    issue_date: str(r.issue_date),
    violation_type_code: str(r.violation_type_code),
    violation_category: str(r.violation_category),
    violation_type: str(r.violation_type),
    description: str(r.description),
    disposition_date: str(r.disposition_date),
    disposition_comments: str(r.disposition_comments),
    device_number: str(r.device_number),
  };
}

/** One DOB complaint (eabe-havv). */
function normDobComplaint(r: Row): Record<string, unknown> {
  return {
    complaint_number: str(r.complaint_number),
    status: str(r.status),
    date_entered: str(r.date_entered),
    complaint_category: str(r.complaint_category),
    unit: str(r.unit),
    disposition_date: str(r.disposition_date),
    disposition_code: str(r.disposition_code),
    inspection_date: str(r.inspection_date),
    bin: str(r.bin),
    community_board: str(r.community_board),
  };
}

/** One 311 service request (erm2-nwe9). */
function norm311(r: Row): Record<string, unknown> {
  return {
    unique_key: str(r.unique_key),
    created_date: str(r.created_date),
    closed_date: str(r.closed_date),
    complaint_type: str(r.complaint_type),
    descriptor: str(r.descriptor),
    status: str(r.status),
    resolution_description: str(r.resolution_description),
    agency: str(r.agency),
    incident_address: str(r.incident_address),
    incident_zip: str(r.incident_zip),
  };
}

/** One bedbug filing (wz6d-d3jb). */
function normBedbug(r: Row): Record<string, unknown> {
  return {
    filing_date: str(r.filing_date),
    filing_period_start: str(r.filing_period_start_date),
    filing_period_end: str(r.filling_period_end_date) ?? str(r.filing_period_end_date),
    dwelling_units: num(r.of_dwelling_units),
    infested_units: num(r.infested_dwelling_unit_count),
    eradicated_units: num(r.eradicated_unit_count),
    re_infested_units: num(r.re_infested_dwelling_unit),
  };
}

/** One vacate order (tb8q-a3ar). */
function normVacate(r: Row): Record<string, unknown> {
  return {
    vacate_order_number: str(r.vacate_order_number),
    vacate_type: str(r.vacate_type),
    primary_vacate_reason: str(r.primary_vacate_reason),
    vacate_effective_date: str(r.vacate_effective_date),
    rescind_date: str(r.actual_rescind_date),
    vacated_units: num(r.number_of_vacated_units),
  };
}

/** One AEP row (hcir-3275). */
function normAep(r: Row): Record<string, unknown> {
  return {
    aep_round: str(r.aep_round),
    current_status: str(r.current_status),
    aep_start_date: str(r.aep_start_date),
    discharge_date: str(r.discharge_date),
    total_units: num(r.total_units),
    bc_violations_at_start: num(r.of_b_c_violations_at_start),
  };
}

/**
 * One PLUTO tax lot (64uk-42ks). ownername is DOF's assessment-roll owner.
 *
 * bbl arrives float-formatted: live 2026-09-14, 1520 SEDGWICK AVENUE (borough
 * BX) serves "2028800017.00000000". A BBL is the identifier a caseworker copies
 * into ACRIS or DOF, and the decimal tail makes it unusable there, so the
 * all-zero fraction is trimmed. A non-zero fraction would be a real anomaly and
 * is left visible rather than rounded away.
 */
function normPlutoLot(r: Row): Record<string, unknown> {
  return {
    address: str(r.address),
    bbl: str(r.bbl)?.replace(/\.0+$/, "") ?? null,
    block: num(r.block),
    lot: num(r.lot),
    owner_name: str(r.ownername),
    building_class: str(r.bldgclass),
    land_use: str(r.landuse),
    residential_units: num(r.unitsres),
    total_units: num(r.unitstotal),
    year_built: num(r.yearbuilt),
    num_floors: num(r.numfloors),
    zip: str(r.zipcode),
  };
}

/** One ACRIS master document joined with its parties. */
function normAcrisDoc(m: Row, parties: Row[]): Record<string, unknown> {
  const byType: Record<string, string[]> = {};
  for (const p of parties) {
    const t = str(p.party_type) ?? "?";
    const name = str(p.name);
    if (!name) continue;
    (byType[t] ??= []).push(name);
  }
  return {
    document_id: str(m.document_id),
    doc_type: str(m.doc_type),
    document_date: str(m.document_date),
    recorded_datetime: str(m.recorded_datetime),
    document_amount: num(m.document_amt),
    percent_transferred: num(m.percent_trans),
    // Party-role semantics VARY BY DOC TYPE: for a deed, party 1 is the
    // grantor (seller) and party 2 the grantee (buyer); for a mortgage,
    // party 1 is the borrower and party 2 the lender.
    party_1: byType["1"] ?? [],
    party_2: byType["2"] ?? [],
    party_3: byType["3"] ?? [],
  };
}

/** One Speculation Watch List row (adax-9mit). */
function normSpeculation(r: Row): Record<string, unknown> {
  return {
    bbl: str(r.bbl),
    address: [str(r.hnum_lo), str(r.str_name)].filter(Boolean).join(" ") || null,
    grantee: str(r.grantee),
    deed_date: str(r.deed_date),
    price: num(r.price),
    cap_rate: num(r.cap_rate),
    borough_cap_rate: num(r.borough_cap_rate),
  };
}

/**
 * Resolve a building's canonical HPD house-number spelling ONCE (running the
 * hyphenation variant probe against the registrations dataset), so an
 * aggregate tool does not re-probe per dataset. Returns the registrations it
 * found along the way; found=false still carries the literal spelling so the
 * caller can query the non-HPD datasets with the user's own input.
 */
async function resolveBuilding(
  houseNumberInput: string,
  street: string,
  boro: Borough,
): Promise<{ houseNumber: string; matchedVariant: boolean; registrations: Row[] }> {
  const variants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" });
  const resolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
    const rows = await sodaGet(DATASET.registrations, {
      $where: whereAnd([eqTextCI("housenumber", houseNumber), eqText("boro", boro.text), likeCI("streetname", street)]),
      $order: "lastregistrationdate DESC",
      $limit: 10,
    });
    return { matched: rows.length > 0, value: rows };
  });
  return { houseNumber: resolved.houseNumber, matchedVariant: resolved.matchedVariant, registrations: resolved.value };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const BOROUGH_DESC =
  "NYC borough: Manhattan, Bronx, Brooklyn, Queens, or Staten Island (also accepts MN/BX/BK/QN/SI or 1-5).";


// ---------------------------------------------------------------------------
// Unknown-argument guard. The low-level SDK Server hands the arguments object
// to the handler without validating it against inputSchema, so every schema's
// additionalProperties:false is advisory: a caller who typed `found_afer` got
// a full-history answer they believed was date-limited, and nothing said so.
// Same helper, same wording, in every one of the operator's TypeScript servers.

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** The closest accepted argument name, if it is close enough to be a typo. */
function nearestArg(key: string, accepted: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Scale with the length of what was typed: one edit is a typo in a short name,
  // three is still a typo in a long one, and neither makes "bogus_param" a
  // misspelling of "limit".
  return bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : null;
}

/** Reject arguments the tool does not declare, naming the likely intended one. */
function validateArgs(toolName: string, accepted: string[], args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
  if (unknown.length === 0) return;
  const described = unknown.map((k) => {
    const near = nearestArg(k, accepted);
    return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
  });
  throw new Error(
    `${toolName} does not accept ${described.join(", ")}. ` +
      `Accepted arguments: ${accepted.join(", ")}. Nothing was queried.`,
  );
}

/** Declared argument names of a tool, from the same list ListTools serves. */
function acceptedArgsOf(tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>, name: string): string[] | null {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Object.keys(props ?? {});
}

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
    name: "landlord_portfolio",
    description:
      "The reverse of who_owns: every building currently registered with HPD under a given " +
      "landlord, corporation, officer, or agent name. Searches HPD Registration Contacts " +
      "(feu5-w2e2) for the name (case-insensitive substring against corporation names and person " +
      "first/last names), then resolves each matched registration to its building (tesw-yqqr): " +
      "address, borough, zip, BIN, registration dates, and which contact matched. Start from a " +
      "name surfaced by who_owns or landlord_litigation. Landlords often hold each building in a " +
      "separate LLC; officer and agent person names frequently connect buildings the LLC names hide. " +
      "Reflects current HPD registration filings only. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Owner / corporation / officer / agent name to match, e.g. "WFHA 1520 SEDGWICK LP" or ' +
            '"DANA REYES" (case-insensitive substring against HPD registration-contact names; ' +
            "pass the fullest name you have, short fragments over-match).",
        },
        borough: { type: "string", description: `Optional filter: only buildings in this borough. ${BOROUGH_DESC}` },
        limit: { type: "integer", description: `Max buildings to return (1-${MAX_RESULTS}, default 50).` },
      },
      required: ["name"],
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
  {
    name: "building_profile",
    description:
      "One-call condition-and-history profile of a building, aggregating ten city datasets: HPD " +
      "registration + contacts (who is on file), violation counts by class, complaint counts by " +
      "status, HPD litigation counts by status, marshal-executed eviction count, Alternative " +
      "Enforcement Program status, vacate orders, the latest bedbug filings, and HPD emergency-repair " +
      "(Handyman Work Order) charge count. START HERE for any 'tell me about this building' " +
      "question, then drill into building_violations / building_complaints / landlord_litigation / " +
      "dob_building / building_311 / true_owner for detail. Give the house number, street, and " +
      "borough. Makes ~11 sequential city-API calls (a few seconds). Keyless.",
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
    name: "true_owner",
    description:
      "Ownership from the city's PROPERTY records rather than HPD's self-reported filings: the " +
      "Department of Finance assessment-roll owner (PLUTO), the building's recent recorded deeds and " +
      "mortgages with their named parties (ACRIS), and any Speculation Watch List hit (a qualifying " +
      "flip-risk purchase). Complements who_owns: HPD registration says who the landlord TOLD HPD " +
      "they are; this says what the property record shows. Give the house number, street, and " +
      "borough. PLUTO stores ONE combined address line per tax lot and it is matched from the house " +
      "number forward, so a corner or multi-lot building can return more than one lot; " +
      "assessor_owner, latest_deed and speculation_watch all describe the FIRST one, named in " +
      "assessor_owner_lot_address. NOTE: ACRIS covers Manhattan, Bronx, Brooklyn, and Queens; " +
      "Staten Island deeds are recorded with the Richmond County Clerk and will not appear. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        house_number: {
          type: "string",
          description:
            'Building house number, e.g. "1520". Must be the start of PLUTO\'s address line; ' +
            "hyphenated and de-hyphenated outer-borough spellings are both tried.",
        },
        street: { type: "string", description: "Street name (matched case-insensitively as a substring)." },
        borough: { type: "string", description: BOROUGH_DESC },
        docs_limit: { type: "integer", description: "Max recent ACRIS documents to return (1-25, default 8)." },
      },
      required: ["house_number", "street", "borough"],
      additionalProperties: false,
    },
  },
  {
    name: "dob_building",
    description:
      "Department of Buildings records for one building — a DIFFERENT agency from HPD: construction, " +
      "structural, elevator, boiler, permit, and illegal-conversion issues live here, not in HPD " +
      "datasets. Returns DOB violations (with a by-category summary) and DOB complaints (with a " +
      "by-status summary). Give the house number, street, and borough. DOB dates arrive in the " +
      "agency's raw formats (often YYYYMMDD) and are returned as published. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        house_number: { type: "string", description: 'Building house number, e.g. "1520".' },
        street: { type: "string", description: "Street name (matched case-insensitively as a substring)." },
        borough: { type: "string", description: BOROUGH_DESC },
        limit: { type: "integer", description: `Max rows per section (1-${MAX_RESULTS}, default 50).` },
      },
      required: ["house_number", "street", "borough"],
      additionalProperties: false,
    },
  },
  {
    name: "building_311",
    description:
      "311 service requests for an address. Defaults to the heat/hot-water complaint types (the top " +
      "tenant-side habitability signal, and a record HPD complaint data undercounts); pass " +
      "complaint_type to search any other type instead (e.g. \"UNSANITARY CONDITION\", \"PAINT/PLASTER\", " +
      "\"Rodent\", \"General Construction/Plumbing\"). Returns matching requests newest-first plus a " +
      "by-status summary. Give the street address and borough. Keyless.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: 'Street address, e.g. "1520 SEDGWICK AVENUE" (matched case-insensitively as a substring of the 311 incident address).' },
        borough: { type: "string", description: BOROUGH_DESC },
        complaint_type: { type: "string", description: "Optional 311 complaint type (exact, case-insensitive). Omit for the heat/hot-water types." },
        since: { type: "string", description: "Only requests created on/after this ISO date (YYYY-MM-DD)." },
        limit: { type: "integer", description: `Max requests to return (1-${MAX_RESULTS}, default 50).` },
      },
      required: ["address", "borough"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function buildingViolations(args: Row): Promise<unknown> {
  const houseNumberInput = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);
  const openOnly = args.open_only === true;
  const since = normSince(args.since, "since");
  const violationClass = str(args.violation_class);
  const limit = clampLimit(args.limit, 100);

  const buildWhere = (houseNumber: string): string | undefined => {
    const conditions = [
      eqTextCI("housenumber", houseNumber),
      eqText("boro", boro.text),
      likeCI("streetname", street),
    ];
    if (openOnly) conditions.push(eqTextCI("violationstatus", "OPEN"));
    if (violationClass) conditions.push(eqTextCI("class", violationClass));
    if (since) conditions.push(gteDate("inspectiondate", since));
    return whereAnd(conditions);
  };

  // Summary: server-side class tally over ALL matches (not just the returned
  // page). This count query also probes house-number spelling variants so a
  // de-hyphenated Queens number does not read as a clean building (silent zero).
  const variants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" });
  const resolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
    const where = buildWhere(houseNumber);
    const summaryRows = await sodaGet(DATASET.violations, {
      $select: "class,count(1) as n",
      $where: where,
      $group: "class",
      $order: "class",
    });
    const { total, by } = tally(summaryRows, "class");
    return { matched: total > 0, value: { where, total, by } };
  });
  const { where, total, by } = resolved.value;

  const rows =
    total > 0
      ? await sodaGet(DATASET.violations, { $where: where, $order: "inspectiondate DESC", $limit: limit })
      : [];
  const results = rows.map(normViolation);

  return {
    query: {
      house_number: resolved.matchedVariant ? resolved.houseNumber : houseNumberInput,
      house_number_searched: resolved.matchedVariant ? houseNumberInput : undefined,
      street,
      borough: boro.text,
      open_only: openOnly,
      violation_class: violationClass ?? null,
      since: str(args.since) ?? null,
    },
    summary: { total_matching: total, by_class: by },
    note: resolved.matchedVariant
      ? `No exact match for "${houseNumberInput}"; matched HPD's stored house number "${resolved.houseNumber}". NYC outer-borough addresses (especially Queens) are stored hyphenated, e.g. 120-15.`
      : total === 0
        ? emptyBuildingNote(variants, street)
        : undefined,
    returned: results.length,
    results,
  };
}

async function buildingComplaints(args: Row): Promise<unknown> {
  const houseNumberInput = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);
  const openOnly = args.open_only === true;
  const since = normSince(args.since, "since");
  const limit = clampLimit(args.limit, 100);

  const buildWhere = (houseNumber: string): string | undefined => {
    const conditions = [
      eqTextCI("house_number", houseNumber),
      eqText("borough", boro.text),
      likeCI("street_name", street),
    ];
    if (openOnly) conditions.push(eqTextCI("complaint_status", "OPEN"));
    if (since) conditions.push(gteDate("received_date", since));
    return whereAnd(conditions);
  };

  // Summary: server-side open/closed tally over ALL matches, doubling as the
  // house-number variant probe (Queens hyphenation silent-zero guard).
  const variants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" });
  const resolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
    const where = buildWhere(houseNumber);
    const summaryRows = await sodaGet(DATASET.complaints, {
      $select: "complaint_status,count(1) as n",
      $where: where,
      $group: "complaint_status",
      $order: "complaint_status",
    });
    const { total, by } = tally(summaryRows, "complaint_status");
    return { matched: total > 0, value: { where, total, by } };
  });
  const { where, total, by } = resolved.value;

  const rows =
    total > 0
      ? await sodaGet(DATASET.complaints, { $where: where, $order: "received_date DESC", $limit: limit })
      : [];
  const results = rows.map(normComplaint);

  return {
    query: {
      house_number: resolved.matchedVariant ? resolved.houseNumber : houseNumberInput,
      house_number_searched: resolved.matchedVariant ? houseNumberInput : undefined,
      street,
      borough: boro.text,
      open_only: openOnly,
      since: str(args.since) ?? null,
    },
    summary: { total_matching: total, by_status: by },
    note: resolved.matchedVariant
      ? `No exact match for "${houseNumberInput}"; matched HPD's stored house number "${resolved.houseNumber}". NYC outer-borough addresses (especially Queens) are stored hyphenated, e.g. 120-15.`
      : total === 0
        ? emptyBuildingNote(variants, street)
        : undefined,
    returned: results.length,
    results,
  };
}

/** The columns that together identify one registration contact. */
const CONTACT_IDENTITY_COLS = [
  "registrationid",
  "type",
  "corporationname",
  "firstname",
  "lastname",
  "businesshousenumber",
  "businessstreetname",
  "businessapartment",
  "businesscity",
  "businessstate",
  "businesszip",
] as const;
/** Distinct contact identities read per registration set. */
const CONTACT_IDENTITY_CAP = 200;
/** Distinct stored eviction-address spellings reported per building profile. */
const EVICTION_ADDRESS_CAP = 50;
/** Recorded documents enumerated per ACRIS lot before the read is capped. */
const ACRIS_DOC_CAP = 1000;
/** Document ids per IN() chunk against the ACRIS master (URL-length bound). */
const ACRIS_ID_CHUNK = 200;

/**
 * Distinct registration contacts for a set of registration ids, with the raw
 * filing count kept.
 *
 * HPD repeats every contact once per building the registration covers, so a
 * portfolio registration carries hundreds of near-identical rows for a handful
 * of people (live 2026-09-14: registrationid 10391 = 435 rows, 5 identities,
 * each repeated 87 times; registrationid 911741 = 8,688 rows, 6 identities).
 *
 * The distinct set is computed SERVER-SIDE with $group, because a capped row
 * read cannot be made safe by ordering: the repeats of one identity are
 * contiguous under every column the dataset offers — registrationcontactid is
 * itself repeated once per building — so a cap drops whole identities rather
 * than thinning them. A plain `$limit: 200` over 8,688 rows could return one
 * identity and no note.
 *
 * Grouping is on the FULL identity tuple, never the name alone: MICHAEL MALEK
 * is filed on registration 10391 twice, as Agent at one business address and
 * as Officer at another, and collapsing on name would merge two real records.
 * The client-side pass repeats the dedup so the function is correct on raw
 * rows too, and counts a row without `n` as one filing.
 */
async function registrationContacts(
  regIds: number[],
): Promise<{ contacts: Record<string, unknown>[]; filings: number; truncated: boolean }> {
  if (!regIds.length) return { contacts: [], filings: 0, truncated: false };
  const cols = CONTACT_IDENTITY_COLS.join(",");
  const rows = await sodaGet(DATASET.contacts, {
    $select: `${cols},count(1) as n`,
    $where: inNum("registrationid", regIds),
    $group: cols,
    $order: "type,corporationname,lastname,firstname",
    $limit: CONTACT_IDENTITY_CAP,
  });

  const byKey = new Map<string, Record<string, unknown>>();
  let filings = 0;
  for (const r of rows) {
    const n = num(r.n) ?? 1; // a grouped row carries its count; a raw row is one filing
    filings += n;
    const key = CONTACT_IDENTITY_COLS.map((c) => String(r[c] ?? "")).join("|");
    const seen = byKey.get(key);
    if (seen) seen.filings = (num(seen.filings) ?? 0) + n;
    else byKey.set(key, { ...normContact(r), filings: n });
  }
  const truncated = rows.length >= CONTACT_IDENTITY_CAP;
  if (!truncated) return { contacts: [...byKey.values()], filings, truncated };
  // Past the cap the grouped page is a SAMPLE of the identities, so its sum is
  // a sample of the filings — and `filings` is published unqualified, as
  // who_owns.summary.contact_filings and building_profile.contact_filings, and
  // spoken in a note ("N filing(s) reduce to M distinct contact(s)"). Same
  // reasoning as evictions_executed: a display cap must not quietly become the
  // headline number. One extra request, only on the truncated path.
  const totalRows = await sodaGet(DATASET.contacts, {
    $select: "count(1) as n",
    $where: inNum("registrationid", regIds),
  });
  return { contacts: [...byKey.values()], filings: num(totalRows[0]?.n) ?? filings, truncated };
}

async function whoOwns(args: Row): Promise<unknown> {
  const houseNumberInput = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);

  const buildWhere = (houseNumber: string): string | undefined =>
    whereAnd([eqTextCI("housenumber", houseNumber), eqText("boro", boro.text), likeCI("streetname", street)]);

  // Probe house-number spelling variants so a de-hyphenated Queens number is not
  // reported as an unregistered building (silent zero).
  const variants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" });
  const resolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
    const regRows = await sodaGet(DATASET.registrations, {
      $where: buildWhere(houseNumber),
      $order: "lastregistrationdate DESC",
      $limit: 25,
    });
    return { matched: regRows.length > 0, value: regRows };
  });
  const registrations = resolved.value.map(normRegistration);

  const query = {
    house_number: resolved.matchedVariant ? resolved.houseNumber : houseNumberInput,
    house_number_searched: resolved.matchedVariant ? houseNumberInput : undefined,
    street,
    borough: boro.text,
  };
  if (registrations.length === 0) {
    const tried = variants.length > 1 ? ` Tried house-number spellings: ${variants.join(", ")}.` : "";
    return {
      query,
      found: false,
      note:
        `No current HPD registration matched.${tried} A building may be unregistered, registered under a ` +
        "different street spelling (street is substring-matched — try the shortest distinctive fragment), " +
        "or below the registration threshold (1-2 family homes often are). Try building_violations to confirm the address.",
      registrations: [],
      contacts: [],
    };
  }

  // Join to contacts by every matched registration id.
  const regIds = registrations
    .map((r) => num((r as Row).registration_id))
    .filter((n): n is number => n != null);
  const { contacts, filings, truncated } = await registrationContacts(regIds);

  // Group by contact type for a quick "who to serve" scan.
  const byType: Record<string, unknown[]> = {};
  for (const c of contacts) {
    const t = (str((c as Row).type) ?? "Other") as string;
    (byType[t] ??= []).push(c);
  }

  const notes: string[] = [];
  if (resolved.matchedVariant) {
    notes.push(
      `No exact match for "${houseNumberInput}"; matched HPD's stored house number "${resolved.houseNumber}" (NYC outer-borough addresses are stored hyphenated).`,
    );
  }
  if (truncated) {
    notes.push(
      `Showing the first ${contacts.length} distinct contacts; this registration has more on file.`,
    );
  }
  if (filings > contacts.length) {
    // Under truncation the distinct count is the cap, not the registration's
    // real one, so the reduction is a floor. The filing count is not: it comes
    // from its own aggregate over the same ids.
    notes.push(
      `HPD files each contact once per building the registration covers, so ${filings} filing(s) ` +
        `reduce to ${truncated ? "at least " : ""}${contacts.length} distinct contact(s); ` +
        'each contact\'s "filings" is its row count.',
    );
  }
  notes.push(
    "Contacts are HPD registration filings (owner/agent/officer of record); confirm before relying on them for service of process.",
  );

  return {
    query,
    found: true,
    summary: { contact_filings: filings, distinct_contacts: contacts.length },
    note: notes.join(" "),
    registrations,
    contacts_by_type: byType,
    contacts,
  };
}

/**
 * Contact-name match for landlord_portfolio: a case-insensitive substring
 * against the corporation name, the first or last name alone, and the
 * "FIRST LAST" concatenation, so a full person name pasted from who_owns
 * output matches. The `||` concat operator works inside $where on feu5-w2e2
 * (a NULL side makes that one clause NULL, never a false match; such rows
 * still hit via the single-column clauses). All user text is
 * quote- and LIKE-wildcard-escaped by likeCI.
 */
function contactNameWhere(name: string): string {
  return (
    "(" +
    [
      likeCI("corporationname", name),
      likeCI("firstname", name),
      likeCI("lastname", name),
      likeCI("firstname || ' ' || lastname", name),
    ].join(" OR ") +
    ")"
  );
}

async function landlordPortfolio(args: Row): Promise<unknown> {
  const name = reqStr(args.name, "name");
  const boro = str(args.borough) ? resolveBorough(args.borough) : null;
  const limit = clampLimit(args.limit, 50);
  const nameWhere = contactNameWhere(name);
  const query = { name, borough: boro?.text ?? null };

  // 1. Server-side count of matching contact records BEFORE any cap, so the
  //    response reports the full match count and an empty result gets search
  //    suggestions instead of a bare zero.
  const countRows = await sodaGet(DATASET.contacts, { $select: "count(1) as n", $where: nameWhere });
  const contactMatches = num(countRows[0]?.n) ?? 0;

  if (contactMatches === 0) {
    return {
      query,
      found: false,
      summary: { contact_matches: 0, distinct_registrations: 0, buildings_found: 0 },
      note:
        `No HPD registration contact matched ${JSON.stringify(name)}. Names are stored UPPERCASE ` +
        "and matched as substrings against corporation names and person first/last names. Try a " +
        'shorter, distinctive part of the name (e.g. "SEDGWICK" instead of "WFHA 1520 SEDGWICK LP"), ' +
        "take the exact spelling from who_owns on a building you know, or search landlord_litigation " +
        "by respondent.",
      returned: 0,
      buildings: [],
    };
  }

  // 2. Pull the matching contact rows (capped scan, deterministic order) and
  //    dedupe registration ids, remembering which contact(s) matched for each.
  const contactRows = await sodaGet(DATASET.contacts, {
    $select: "registrationid,type,corporationname,firstname,lastname",
    $where: nameWhere,
    $order: "registrationid",
    $limit: PORTFOLIO_SCAN_CAP,
  });

  const rolesByReg = new Map<number, Record<string, unknown>[]>();
  for (const r of contactRows) {
    const id = num(r.registrationid);
    if (id == null) continue;
    const c = normContact(r);
    const role = { type: c.type, organization: c.organization, person_name: c.person_name };
    const roles = rolesByReg.get(id) ?? [];
    if (!roles.some((x) => x.type === role.type && x.organization === role.organization && x.person_name === role.person_name)) {
      roles.push(role);
    }
    rolesByReg.set(id, roles);
  }
  const regIds = [...rolesByReg.keys()];

  // 3. Resolve the ids to current registrations in IN() chunks (URL-length
  //    bound), applying the optional borough filter server-side.
  const buildings: Record<string, unknown>[] = [];
  const resolvedRegIds = new Set<number>();
  let buildingsTruncated = false;
  chunks: for (let i = 0; i < regIds.length; i += PORTFOLIO_ID_CHUNK) {
    const chunk = regIds.slice(i, i + PORTFOLIO_ID_CHUNK);
    const conditions = [inNum("registrationid", chunk)];
    if (boro) conditions.push(eqText("boro", boro.text));
    const where = whereAnd(conditions);
    // Page until a short read. $order is required for $offset paging to be a
    // partition of the result set rather than an arbitrary redraw.
    for (let offset = 0; ; offset += PORTFOLIO_PAGE_SIZE) {
      const rows = await sodaGet(DATASET.registrations, {
        $where: where,
        $order: "registrationid,buildingid",
        $limit: PORTFOLIO_PAGE_SIZE,
        $offset: offset || undefined,
      });
      for (const row of rows) {
        const id = num(row.registrationid);
        if (id != null) resolvedRegIds.add(id);
        buildings.push({ ...normRegistration(row), matched_contacts: (id != null && rolesByReg.get(id)) || [] });
      }
      // The ceiling is checked on EVERY page, short ones included, so this loop
      // decides its own exit. Previously a short page that crossed the ceiling
      // fell through to the chunk-exhausted break and the NEXT chunk's top-of-
      // loop guard set the flag — action at a distance that reads like a hole
      // on the last chunk, which has no next iteration. It is not one: a short
      // page means the chunk is exhausted, and an exhausted last chunk leaves
      // nothing unread. Hence `moreToRead`: truncation is ids left unread, not
      // a count above the ceiling. Reporting it on the count alone would print
      // "this portfolio is larger than the count above" over a complete one
      // (pinned both ways in test/server.test.ts, "crossing the resolution
      // ceiling on a chunk's short final page").
      const chunkExhausted = rows.length < PORTFOLIO_PAGE_SIZE;
      const moreToRead = !chunkExhausted || i + PORTFOLIO_ID_CHUNK < regIds.length;
      if (buildings.length >= PORTFOLIO_BUILDING_CAP && moreToRead) {
        buildingsTruncated = true;
        break chunks;
      }
      if (chunkExhausted) break;
    }
  }
  // Group the portfolio for reading: borough, then address.
  buildings.sort((a, b) => {
    const ka = `${a.borough ?? ""} ${a.building_address ?? ""}`;
    const kb = `${b.borough ?? ""} ${b.building_address ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const summary = {
    contact_matches: contactMatches,
    distinct_registrations: regIds.length,
    buildings_found: buildings.length,
  };

  if (buildings.length === 0) {
    return {
      query,
      found: false,
      summary,
      note: boro
        ? `${contactMatches} contact record(s) matched ${JSON.stringify(name)}, but none of their ` +
          `${regIds.length} registration(s) are in ${boro.text}. Drop the borough filter to see the ` +
          "full portfolio."
        : `${contactMatches} contact record(s) matched ${JSON.stringify(name)}, but none map to a ` +
          "current HPD registration (the registrations dataset holds current filings only; the " +
          "buildings may have re-registered under different contacts). Try who_owns on a known " +
          "address to get the current names.",
      returned: 0,
      buildings: [],
    };
  }

  const shown = buildings.slice(0, limit);
  const notes: string[] = [];
  if (contactMatches > contactRows.length) {
    notes.push(
      `Matched ${contactMatches} contact records; scanned the first ${contactRows.length}, so the ` +
        "portfolio below may be incomplete. Use a more specific name.",
    );
  }
  if (buildingsTruncated) {
    notes.push(
      `Stopped resolving at ${buildings.length} buildings (the server's per-search ceiling), so this ` +
        "portfolio is larger than the count above. Narrow with borough.",
    );
  }
  // A shortfall is counted in REGISTRATION IDS that resolved to nothing, not in
  // buildings: one registration can cover many buildings, so comparing building
  // count to id count attributes a multi-building portfolio to "superseded
  // filings" and vice versa. Both notes are suppressed under truncation, where
  // an id can be unresolved simply because its chunk was never read.
  const unresolvedRegIds = buildingsTruncated ? 0 : regIds.length - resolvedRegIds.size;
  if (boro && unresolvedRegIds > 0) {
    notes.push(
      `${regIds.length} registration(s) matched the name city-wide; ${resolvedRegIds.size} in ${boro.text} after the borough filter.`,
    );
  }
  if (!boro && unresolvedRegIds > 0) {
    notes.push(
      `${unresolvedRegIds} matched registration id(s) have no current registration on file (superseded filings).`,
    );
  }
  if (shown.length < buildings.length) {
    notes.push(`Showing ${shown.length} of ${buildings.length} buildings; raise limit for more.`);
  }
  notes.push(
    "Contacts reflect HPD registration filings. The same landlord may file each building under a " +
      "separate LLC; officer and agent person names often connect what the LLC names hide.",
  );

  return {
    query,
    found: true,
    summary,
    note: notes.join(" "),
    returned: shown.length,
    buildings: shown,
  };
}

async function landlordLitigation(args: Row): Promise<unknown> {
  const houseNumberInput = str(args.house_number);
  const street = str(args.street);
  const respondent = str(args.respondent);
  const caseStatus = str(args.case_status);
  const limit = clampLimit(args.limit, 100);

  const isBuilding = Boolean(houseNumberInput || street);
  let boro: Borough | null = null;
  if (isBuilding) {
    // Building lookup: needs all three address parts (borough -> numeric boroid).
    if (!houseNumberInput || !street || !str(args.borough)) {
      throw new Error("A building lookup needs house_number, street, and borough together. Or search by respondent instead.");
    }
    boro = resolveBorough(args.borough);
  } else if (str(args.borough)) {
    // Borough given without a building: scope a respondent search to that boroid.
    boro = resolveBorough(args.borough);
  }
  if (!respondent && !(houseNumberInput && street)) {
    throw new Error("Provide a building (house_number + street + borough) or a respondent name.");
  }

  const buildWhere = (houseNumber: string | null): string | undefined => {
    const conditions: string[] = [];
    if (houseNumber) conditions.push(eqTextCI("housenumber", houseNumber));
    if (boro) conditions.push(eqNum("boroid", boro.id));
    if (street) conditions.push(likeCI("streetname", street));
    if (respondent) conditions.push(likeCI("respondent", respondent));
    if (caseStatus) conditions.push(eqTextCI("casestatus", caseStatus));
    return whereAnd(conditions);
  };

  // Server-side by-status summary over ALL matches (not a tally of the returned
  // page, which is capped at `limit`), mirroring building_violations. For a
  // building lookup this count query also probes house-number spelling variants.
  const summaryOf = async (houseNumber: string | null) => {
    const where = buildWhere(houseNumber);
    const summaryRows = await sodaGet(DATASET.litigations, {
      $select: "casestatus,count(1) as n",
      $where: where,
      $group: "casestatus",
      $order: "casestatus",
    });
    const { total, by } = tally(summaryRows, "casestatus");
    return { where, total, by };
  };

  let where: string | undefined;
  let total: number;
  let by: Record<string, number>;
  let displayHouseNumber = houseNumberInput;
  let matchedVariant = false;

  if (isBuilding && houseNumberInput) {
    const variants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro?.text === "QUEENS" });
    const resolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
      const s = await summaryOf(houseNumber);
      return { matched: s.total > 0, value: s };
    });
    ({ where, total, by } = resolved.value);
    matchedVariant = resolved.matchedVariant;
    displayHouseNumber = matchedVariant ? resolved.houseNumber : houseNumberInput;
  } else {
    ({ where, total, by } = await summaryOf(null));
  }

  const rows =
    total > 0
      ? await sodaGet(DATASET.litigations, { $where: where, $order: "caseopendate DESC", $limit: limit })
      : [];
  const results = rows.map(normLitigation);

  const notes: string[] = [];
  if (matchedVariant) {
    notes.push(
      `No exact match for "${houseNumberInput}"; matched HPD's stored house number "${displayHouseNumber}" (NYC outer-borough addresses are stored hyphenated, e.g. 120-15).`,
    );
  }
  if (results.length === limit && total > results.length) {
    notes.push(`Showing ${results.length} of ${total} matching cases; narrow the query or raise limit for more.`);
  }

  return {
    query: {
      house_number: displayHouseNumber ?? null,
      house_number_searched: matchedVariant ? houseNumberInput : undefined,
      street: street ?? null,
      borough: boro?.text ?? null,
      respondent: respondent ?? null,
      case_status: caseStatus ?? null,
    },
    summary: { total_matching: total, by_status: by },
    note: notes.length ? notes.join(" ") : undefined,
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

async function buildingProfile(args: Row): Promise<unknown> {
  const houseNumberInput = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);

  // Resolve the canonical HPD house-number spelling ONCE (Queens hyphenation),
  // then reuse it for every HPD-keyed dataset below.
  const resolved = await resolveBuilding(houseNumberInput, street, boro);
  const hn = resolved.houseNumber;
  const registrations = resolved.registrations.map(normRegistration);

  // Contacts for the newest registration (who is on file), deduped server-side:
  // HPD repeats each contact once per building the registration covers.
  const regIds = registrations.map((r) => num((r as Row).registration_id)).filter((n): n is number => n != null);
  const { contacts, filings: contactFilings, truncated: contactsTruncated } = await registrationContacts(regIds.slice(0, 5));

  // HPD violations by class.
  const violSummary = await sodaGet(DATASET.violations, {
    $select: "class,count(1) as n",
    $where: whereAnd([eqTextCI("housenumber", hn), eqText("boro", boro.text), likeCI("streetname", street)]),
    $group: "class",
  });
  const violations = tally(violSummary, "class");

  // HPD complaints by status.
  const compSummary = await sodaGet(DATASET.complaints, {
    $select: "complaint_status,count(1) as n",
    $where: whereAnd([eqTextCI("house_number", hn), eqText("borough", boro.text), likeCI("street_name", street)]),
    $group: "complaint_status",
  });
  const complaints = tally(compSummary, "complaint_status");

  // HPD litigation by status (boroid is numeric here).
  const litSummary = await sodaGet(DATASET.litigations, {
    $select: "casestatus,count(1) as n",
    $where: whereAnd([eqTextCI("housenumber", hn), eqNum("boroid", boro.id), likeCI("streetname", street)]),
    $group: "casestatus",
  });
  const litigation = tally(litSummary, "casestatus");

  // Marshal-executed evictions. 6z8x-wfk4 stores ONE free-text address line
  // that frequently carries a house-number RANGE and an abbreviated or mangled
  // street, so the composed "<house> <street>" is often not a substring of it:
  // live 2026-09-14, '%2763 SEDGWICK AVENUE%' in the Bronx returns 0 while the
  // stored spellings are '2763-69 SEDGWICK AVE' and '2763-69 SEDGWICK AVE NUE'
  // (a neighbour reads '2755-61 SEDGWICK AVE NUE'). A profile reading zero
  // there is a clean bill of health on a building with executed evictions.
  //
  // Anchor BOTH axes on a token boundary: the house number, and the street's
  // distinctive token followed by a stem of its type word. That matches the
  // stored range and mangled spellings without reading another building's rows
  // onto this one. Neither half of the street anchor is optional — a bare
  // '%<distinctive>%' reported 1650 OCEAN PARKWAY's three executed evictions as
  // 1650 Ocean Avenue's, and bounding the token while letting the stem float
  // free reported 590 MORRIS PARK AVE's as 590 Morris Avenue's (see
  // streetAnchored). It is still wider than an exact match: a longer street
  // ending in the same type word ("MORRIS AVENUE EAST") matches, which is why
  // the matched address strings are returned beside the count rather than a
  // bare number the caller cannot audit.
  //
  // The caller's `street` is a SUBSTRING match on every HPD-keyed section above
  // (likeCI("streetname", street)), so "Tremont Avenue" resolves a building HPD
  // files as EAST TREMONT AVENUE. The eviction anchor is the one section that
  // is NOT a substring match, and the directional exclusion then read the
  // building's own registered street as a different one and dropped its rows
  // -- NYCH-3 with the sign flipped, and a wrong non-zero reads as measured.
  // Live 2026-09-15 through the generated $where: 1960 "Tremont Avenue" BRONX
  // (HPD buildingid 73924, 194 violations, registered EAST TREMONT AVENUE)
  // reported evictions_executed 1 against the registered street's 10; 215
  // "145 Street" MANHATTAN (buildingid 805976, registered WEST 145 STREET)
  // reported 0 against 9. foundNothing rescues neither: every other section
  // is populated.
  //
  // When a registration resolved the building, anchor on the street HPD has
  // on FILE rather than on the fragment the caller typed. Re-measured live:
  // 1960 -> 10, 215 -> 9, and every regression case holds -- 475 Broadway 0,
  // 590 Morris Avenue 0, 1650 Ocean Avenue 0, 1500 Grand Avenue 0, 100 Park
  // Place 0, 1520 / 2763 / 2707 / 3605 SEDGWICK 13 / 8 / 7 / 17, 562 Morris
  // Avenue 6, 1170 Ocean Avenue 4, 4064 BRONX BLVD 13, 3704 WHITE PLAINS RD
  // 1, and 424 Broadway (no registration) falls back to the caller's street
  // and stays at 1.
  const evictionStreet = str(resolved.registrations[0]?.streetname) ?? street;
  const evictWhere = whereAnd([
    houseNumberAnchored("eviction_address", hn),
    streetAnchored("eviction_address", evictionStreet),
    inText("borough", boro.evictionAliases),
  ]);
  const evictRows = await sodaGet(DATASET.evictions, {
    $select: "eviction_address,count(1) as n",
    $where: evictWhere,
    $group: "eviction_address",
    $order: "eviction_address",
    $limit: EVICTION_ADDRESS_CAP,
  });
  const evictionAddresses = evictRows.map((r) => ({ address: str(r.eviction_address), count: num(r.n) ?? 0 }));
  const evictionsTruncated = evictRows.length >= EVICTION_ADDRESS_CAP;
  // The headline count is its own aggregate, not a sum of the page above:
  // that page stops at EVICTION_ADDRESS_CAP distinct spellings, and summing
  // it would make the display cap silently become the count.
  const evictTotalRows = await sodaGet(DATASET.evictions, { $select: "count(1) as n", $where: evictWhere });
  const evictionsExecuted = num(evictTotalRows[0]?.n) ?? 0;

  // AEP (Title Case boro; upper() both sides handles it), vacate (2-letter),
  // bedbug (uppercase), HWO charge count (uppercase).
  const aepRows = await sodaGet(DATASET.aep, {
    $where: whereAnd([eqTextCI("phn", hn), eqTextCI("boro", boro.text), likeCI("street_address", street)]),
    $limit: 5,
  });
  const vacateRows = await sodaGet(DATASET.vacate, {
    $where: whereAnd([eqTextCI("house_number", hn), eqText("boro_short_name", boro.short), likeCI("street_name", street)]),
    $order: "vacate_effective_date DESC",
    $limit: 10,
  });
  const bedbugRows = await sodaGet(DATASET.bedbug, {
    $where: whereAnd([eqTextCI("house_number", hn), eqText("borough", boro.text), likeCI("street_name", street)]),
    $order: "filing_date DESC",
    $limit: 3,
  });
  const hwoRows = await sodaGet(DATASET.hwo, {
    $select: "count(1) as n",
    $where: whereAnd([eqTextCI("housenumber", hn), eqText("boro", boro.text), likeCI("streetname", street)]),
  });
  const emergencyRepairCharges = num(hwoRows[0]?.n) ?? 0;

  // A profile that found NOTHING anywhere is the silent zero this tool's own
  // description ("START HERE") makes the most costly: a de-hyphenated outer-
  // borough number or a misspelled street returns an all-zero profile that
  // reads as a clean building. resolveBuilding probed the house-number
  // spellings against the registrations dataset and none matched, so every
  // other section above was keyed on the literal spelling the caller gave.
  // emptyBuildingNote names the spellings tried and the substring-matched
  // street, the same rescue building_violations and building_complaints ship.
  const foundNothing =
    registrations.length === 0 &&
    violations.total === 0 &&
    complaints.total === 0 &&
    litigation.total === 0 &&
    evictionsExecuted === 0 &&
    aepRows.length === 0 &&
    vacateRows.length === 0 &&
    bedbugRows.length === 0 &&
    emergencyRepairCharges === 0;

  return {
    query: {
      house_number: hn,
      house_number_searched: resolved.matchedVariant ? houseNumberInput : undefined,
      street,
      borough: boro.text,
    },
    registered_with_hpd: registrations.length > 0,
    registrations,
    contacts,
    contact_filings: contactFilings,
    contacts_truncated: contactsTruncated || undefined,
    hpd_violations: { total: violations.total, by_class: violations.by },
    hpd_complaints: { total: complaints.total, by_status: complaints.by },
    hpd_litigation: { total: litigation.total, by_status: litigation.by },
    evictions_executed: evictionsExecuted,
    // The stored spellings behind the count. Both axes are anchored, but the
    // match is still wider than exact — a longer street ending in the same type
    // word ("MORRIS AVENUE EAST" under "Morris Avenue") matches — so the rows
    // are shown here rather than hidden inside the number.
    evictions_matched_addresses: evictionAddresses,
    // Which street spelling the eviction anchor actually used, when it is not
    // the one passed. The count is unauditable without it.
    evictions_street_matched:
      evictionStreet.trim().toUpperCase() === street.trim().toUpperCase() ? undefined : evictionStreet,
    evictions_addresses_truncated: evictionsTruncated || undefined,
    aep: { in_program_history: aepRows.length > 0, records: aepRows.map(normAep) },
    vacate_orders: vacateRows.map(normVacate),
    bedbug_filings: bedbugRows.map(normBedbug),
    emergency_repair_charges: emergencyRepairCharges,
    note: resolved.matchedVariant
      ? `No exact match for "${houseNumberInput}"; the profile uses HPD's stored house number "${hn}" (NYC outer-borough addresses are stored hyphenated, e.g. 120-15).`
      : foundNothing
        ? emptyBuildingNote(
            houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" }),
            street,
          )
        : undefined,
    next_steps:
      "Detail tools: building_violations / building_complaints (rows), landlord_litigation (cases), " +
      "eviction_lookup (executed evictions), true_owner (property-record ownership), dob_building " +
      "(Department of Buildings), building_311 (heat and other 311 requests), landlord_portfolio " +
      "(other buildings under the same names).",
  };
}

/**
 * The newest ACRIS master documents across EVERY document id on a lot,
 * chunked by IN() and re-sorted client-side.
 *
 * Recency has to come from acrisMaster.recorded_datetime, because the legals
 * dataset carries no date column at all (document_id, record_type, borough,
 * block, lot, easement, partial_lot, air_rights, subterranean_rights,
 * property_type, street_number, street_name, unit, good_through_date) and
 * document_id is NOT a usable proxy: it is lexical, and the legacy `FT_*` ids
 * sort above every modern YYYYMMDD-prefixed id. Live 2026-09-14, Manhattan
 * block 1301 lot 1: 176 of its 226 documents are FT_*, and the first 150 under
 * `$order=document_id DESC` are all legacy — a candidate set with no modern
 * document in it.
 *
 * Asking each chunk for its own newest N and merging gives the true global
 * newest N, since the winner of the whole set is the winner of some chunk.
 */
async function acrisNewest(docIds: string[], limit: number, extra?: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < docIds.length; i += ACRIS_ID_CHUNK) {
    const conditions = [inText("document_id", docIds.slice(i, i + ACRIS_ID_CHUNK))];
    if (extra) conditions.push(extra);
    const rows = await sodaGet(DATASET.acrisMaster, {
      $where: whereAnd(conditions),
      $order: "recorded_datetime DESC",
      $limit: limit,
    });
    out.push(...rows);
  }
  // recorded_datetime is an ISO-ordered floating timestamp, so a string compare
  // is a chronological one.
  out.sort((a, b) => String(b.recorded_datetime ?? "").localeCompare(String(a.recorded_datetime ?? "")));
  return out.slice(0, limit);
}

async function trueOwner(args: Row): Promise<unknown> {
  const houseNumberInput = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);
  const docsLimit = Math.max(1, Math.min(25, Math.floor(num(args.docs_limit) ?? 8)));

  // PLUTO stores one combined address ("1520 SEDGWICK AVENUE") and the 2-letter
  // borough code, and that line ALWAYS begins with the house number -- so anchor
  // on the PREFIX. A bare '%<hn> <street>%' is the defect houseNumberAnchored's
  // docstring already names, and it was still open here. Live 2026-09-15:
  // '%17 SEDGWICK AVENUE%' with borough='BX' returns 3817 SEDGWICK AVENUE and
  // 2817 SEDGWICK AVENUE -- nothing at house 17 -- and the tool published
  // lots[0]'s owner ("TSAI, YU-CHI", a named individual) as assessor_owner and
  // chased THAT lot's ACRIS deed and speculation-watch row. '%20 QUEENS
  // BOULEVARD%' is worse: five lots, 114-20 / 118-20 / 77-20 / 109-20 / 104-20,
  // none of them house 20. latest_deed carries no address of its own, so the
  // substitution is invisible in the field read as the answer.
  //
  // Socrata's default ordering is unspecified -- the ACRIS legals read below
  // passes $order for exactly this reason -- and lots[0] decides three published
  // fields, so this page is ordered too.
  //
  // The spelling probe rides here for the same reason it does in the HPD- and
  // DOB-keyed tools: PLUTO stores outer-borough house numbers hyphenated (live,
  // "70-08 QUEENS BOULEVARD"), so "7008 Queens Boulevard" read found:false on a
  // real lot while the note offered only "the exact street spelling, or a corner
  // building's other street" -- never hyphenation.
  const plutoVariants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" });
  const plutoResolved = await tryHouseNumberVariants(plutoVariants, async (houseNumber) => {
    const rows = await sodaGet(DATASET.pluto, {
      $select: "address,bbl,block,lot,ownername,bldgclass,landuse,unitsres,unitstotal,yearbuilt,numfloors,zipcode",
      $where: whereAnd([
        // Prefix, OR the high end of a stored RANGE. PLUTO writes ranges for
        // multi-lot frontages outside Queens ("29-31 LEONARD STREET", "22-24
        // DOWNING STREET", "38-40 EAST 76 STREET", "145-125 WHITE STREET"), so
        // a pure prefix reports found:false on a real lot: live 2026-09-15,
        // true_owner("31","Leonard Street","Manhattan") returned nothing while
        // 64uk-42ks holds "29-31 LEONARD STREET", bbl 1001790043, ownername
        // "31 LEONARD STREET, LLC".
        //
        // Queens is excluded from the range arm, and the scoping is the whole
        // point: a hyphen in a Queens address is part of the house NUMBER, not
        // a range (live `address like '%-%'`: QN 302,210 rows vs MN 24 / BX 46
        // / BK 49 / SI 14), so an unscoped arm re-opens the defect this block
        // closed -- '%-20 QUEENS BOULEVARD%' returns 44-20, 39-20, 32-20,
        // 66-20, 70-20, 77-20 and no house 20. Outside Queens it is verified
        // not to: '%-17 SEDGWICK AVENUE%' in BX is still empty.
        //
        // Residual: MN's 24 hyphenated rows include "PIER-16 SOUTH STREET" and
        // "60-A RIVERSIDE BOULEVARD", so the arm can also match a pier or a
        // lettered sub-lot. Those land in `lots` and
        // assessor_owner_lot_address names the one the three published fields
        // describe.
        (() => {
          const p = soqlLike(`${houseNumber} ${street}`.toUpperCase());
          return boro.short === "QN"
            ? `upper(address) like '${p}%'`
            : `(upper(address) like '${p}%' OR upper(address) like '%-${p}%')`;
        })(),
        eqText("borough", boro.short),
      ]),
      $order: "bbl",
      $limit: 5,
    });
    return { matched: rows.length > 0, value: rows };
  });
  const plutoRows = plutoResolved.value;
  const lots = plutoRows.map(normPlutoLot);

  if (lots.length === 0) {
    return {
      query: { house_number: houseNumberInput, street, borough: boro.text },
      found: false,
      note:
        "No PLUTO tax lot matched that address. PLUTO stores one combined address line per lot " +
        '(e.g. "1520 SEDGWICK AVENUE") and the house number must START it, or be the high end of a ' +
        'stored range ("29-31 LEONARD STREET"); ' +
        (plutoResolved.tried.length > 1 ? `tried house-number spellings: ${plutoResolved.tried.join(", ")}. ` : "") +
        "Try the exact street spelling, or a corner building's other street. " +
        "who_owns (HPD registration) may still answer." +
        (boro.short === "SI"
          ? " Note: even with a PLUTO match, Staten Island deeds live with the Richmond County Clerk, not ACRIS."
          : ""),
      lots: [],
      acris_documents: [],
      speculation_watch: [],
    };
  }

  const first = lots[0] as Row;
  const block = num(first.block);
  const lot = num(first.lot);

  // ACRIS: legals (borough/block/lot -> document ids) -> master (type/date/amt)
  // -> parties (names). Staten Island is not in ACRIS at all.
  let acrisDocs: Record<string, unknown>[] = [];
  let latestDeed: Record<string, unknown> | null = null;
  let acrisNote: string | undefined;
  if (boro.short === "SI") {
    acrisNote =
      "Staten Island deeds and mortgages are recorded with the Richmond County Clerk, not ACRIS; " +
      "no document history is available from this dataset.";
  } else if (block != null && lot != null) {
    // ACRIS/spec columns are text-typed; SODA coerces but the quoted form is
    // the one both probes accepted, so quote (verified live 2026-08-22).
    const legalRows = await sodaGet(DATASET.acrisLegals, {
      $select: "document_id",
      $where: whereAnd([eqText("borough", String(boro.id)), eqText("block", String(block)), eqText("lot", String(lot))]),
      // Socrata's default ordering is unspecified, so without this the candidate
      // set on a lot above the cap is arbitrary. This orders the ENUMERATION; it
      // is not a date sort and is never used as one (see acrisNewest).
      $order: "document_id",
      $limit: ACRIS_DOC_CAP,
    });
    const docsTruncated = legalRows.length >= ACRIS_DOC_CAP;
    const docIds = [...new Set(legalRows.map((r) => str(r.document_id)).filter((s): s is string => s != null))];
    if (docIds.length) {
      // Newest first by recorded date, across EVERY document id on the lot.
      const masterRows = await acrisNewest(docIds, docsLimit);
      const shownIds = masterRows.map((m) => str(m.document_id)).filter((s): s is string => s != null);
      const partyRows = shownIds.length
        ? await sodaGet(DATASET.acrisParties, { $where: inText("document_id", shownIds), $limit: 400 })
        : [];
      const partiesByDoc = new Map<string, Row[]>();
      for (const p of partyRows) {
        const id = str(p.document_id);
        if (!id) continue;
        (partiesByDoc.get(id) ?? partiesByDoc.set(id, []).get(id)!).push(p);
      }
      acrisDocs = masterRows.map((m) => normAcrisDoc(m, partiesByDoc.get(str(m.document_id) ?? "") ?? []));
      if (docsTruncated) {
        acrisNote =
          `This lot has at least ${docIds.length} recorded documents and the read stopped at the ` +
          "server's cap, so both the list below and latest_deed may miss older filings.";
      } else if (docIds.length > acrisDocs.length) {
        acrisNote = `This lot has ${docIds.length} recorded documents; the ${acrisDocs.length} newest are shown.`;
      }
      // "Who bought this building last" is the headline question, and the
      // newest N documents are often SUBM/AGMT paperwork with the last deed
      // buried deeper (live: 1520 Sedgwick's top 3 held no deed at all). Chase
      // the latest DEED-family instrument specifically.
      if (!acrisDocs.some((d) => String(d.doc_type ?? "").startsWith("DEED"))) {
        const deedRows = await acrisNewest(docIds, 1, `doc_type like 'DEED%'`);
        if (deedRows.length) {
          const deedId = str(deedRows[0].document_id);
          const deedParties = deedId
            ? await sodaGet(DATASET.acrisParties, { $where: eqText("document_id", deedId), $limit: 50 })
            : [];
          latestDeed = normAcrisDoc(deedRows[0], deedParties);
        }
      } else {
        latestDeed = acrisDocs.find((d) => String(d.doc_type ?? "").startsWith("DEED")) ?? null;
      }
      // The caveat rides latest_deed itself. It is read as a standalone answer
      // ("who bought this building last"), so a warning that lives only in
      // acris_note is a warning the reader of that field never sees.
      if (latestDeed && docsTruncated) {
        // Copied, not mutated: in the else-branch above latestDeed is a
        // REFERENCE into acrisDocs, so assigning here would also stamp a
        // caveat field onto one row of the returned document list, where it
        // reads as a property of that document rather than of the read.
        latestDeed = {
          ...latestDeed,
          caveat:
            `Resolved over the first ${docIds.length} of this lot's recorded documents (the server's ` +
            "cap); an older deed set may exist beyond it.",
        };
      }
    }
  }

  // Speculation Watch List: match by block+lot, then confirm borough via the
  // row's own bbl first digit (the dataset carries several borough encodings).
  let speculation: Record<string, unknown>[] = [];
  if (block != null && lot != null) {
    const specRows = await sodaGet(DATASET.speculationWatch, {
      $where: whereAnd([eqText("block", String(block)), eqText("lot", String(lot))]),
      $limit: 10,
    });
    speculation = specRows
      .filter((r) => {
        const bbl = str(r.bbl);
        return bbl == null || bbl.startsWith(String(boro.id));
      })
      .map(normSpeculation);
  }

  return {
    query: {
      house_number: houseNumberInput,
      // Which spelling actually found the lot, when it was not the one given.
      house_number_searched: plutoResolved.matchedVariant ? plutoResolved.houseNumber : undefined,
      street,
      borough: boro.text,
    },
    found: true,
    // assessor_owner, latest_deed and speculation_watch all come from lots[0].
    // The lot it names is stated here rather than left to be read out of the
    // lots array, because those three fields carry no address of their own.
    assessor_owner: first.owner_name ?? null,
    assessor_owner_lot_address: first.address ?? null,
    lots,
    latest_deed: latestDeed,
    acris_documents: acrisDocs,
    acris_note: acrisNote,
    speculation_watch: speculation,
    note:
      "Three distinct ownership records: PLUTO owner_name is the Department of Finance " +
      "assessment roll (can lag sales, and for co-ops/condos may name the building entity); ACRIS " +
      "documents are the recorded instruments themselves (for a deed, party_1 = seller, party_2 = " +
      "buyer; for a mortgage, party_1 = borrower, party_2 = lender); who_owns is HPD's " +
      "self-reported registration. When they disagree, the recorded deed is the strongest evidence. " +
      "assessor_owner, latest_deed and speculation_watch are all read off the FIRST lot " +
      `(${str(first.address) ?? "see lots[0]"}); a corner or multi-lot building returns more than one, ` +
      "and the others are in `lots`." +
      (plutoResolved.matchedVariant
        ? ` No lot began with "${houseNumberInput}"; the address spelling "${plutoResolved.houseNumber}" is the one that matched.`
        : ""),
  };
}

async function dobBuilding(args: Row): Promise<unknown> {
  const houseNumberInput = reqStr(args.house_number, "house_number");
  const street = reqStr(args.street, "street");
  const boro = resolveBorough(args.borough);
  const limit = clampLimit(args.limit, 50);

  // DOB stores house numbers as filed, which for outer-borough addresses is
  // hyphenated (live 2026-09-14: 3h2n-5cm9 holds "59-11"/"90-15" on QUEENS
  // BLVD), so a de-hyphenated Queens number reads as a clean building. Probe the
  // spellings the way every other per-building tool does instead of telling the
  // caller to retry by hand — a note only helps a reader who already suspects
  // the zero. The two datasets are probed independently: a building can be filed
  // one way in violations and another in complaints.
  const variants = houseNumberVariants(houseNumberInput, { hyphenateDigits: boro.text === "QUEENS" });

  // DOB violations: boro is a numeric-as-text code ("1".."5").
  const violResolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
    const where = whereAnd([eqText("boro", String(boro.id)), eqTextCI("house_number", houseNumber), likeCI("street", street)]);
    const rows = await sodaGet(DATASET.dobViolations, {
      $select: "violation_category,count(1) as n",
      $where: where,
      $group: "violation_category",
    });
    const t = tally(rows, "violation_category");
    return { matched: t.total > 0, value: { where, ...t } };
  });
  const violWhere = violResolved.value.where;
  const violSummary = violResolved.value;
  const violRows =
    violSummary.total > 0
      ? await sodaGet(DATASET.dobViolations, { $where: violWhere, $order: "issue_date DESC", $limit: limit })
      : [];

  // DOB complaints: NO borough column; the community board's first digit is the
  // borough code, so filter with starts_with once a borough is known.
  const compResolved = await tryHouseNumberVariants(variants, async (houseNumber) => {
    const where = whereAnd([
      eqTextCI("house_number", houseNumber),
      likeCI("house_street", street),
      `starts_with(community_board, '${boro.id}')`,
    ]);
    const rows = await sodaGet(DATASET.dobComplaints, {
      $select: "status,count(1) as n",
      $where: where,
      $group: "status",
    });
    const t = tally(rows, "status");
    return { matched: t.total > 0, value: { where, ...t } };
  });
  const compWhere = compResolved.value.where;
  const compSummary = compResolved.value;
  const compRows =
    compSummary.total > 0
      ? await sodaGet(DATASET.dobComplaints, { $where: compWhere, $order: "date_entered DESC", $limit: limit })
      : [];

  const notes: string[] = [];
  if (violResolved.matchedVariant) {
    notes.push(
      `No DOB violations under "${houseNumberInput}"; matched DOB's stored house number "${violResolved.houseNumber}".`,
    );
  }
  if (compResolved.matchedVariant) {
    notes.push(
      `No DOB complaints under "${houseNumberInput}"; matched DOB's stored house number "${compResolved.houseNumber}".`,
    );
  }
  if (violSummary.total === 0 && compSummary.total === 0 && variants.length > 1) {
    notes.push(`Both sections read zero. Tried house-number spellings: ${variants.join(", ")}.`);
  }
  // The probe stops at the first spelling that matches, so a section that found
  // rows left the remaining spellings UNQUERIED — and DOB files one building
  // under more than one, each holding its own rows. Live 2026-09-14 on
  // 3h2n-5cm9, boro='4', street like '%QUEENS BOULEVARD%': house_number '9015'
  // returns 12 violations and '90-15' returns 383. Without this, a caller who
  // typed the de-hyphenated form is shown 12 and told nothing; neither of the
  // notes above fires, since the spelling passed is the one that matched.
  const untried = (r: { tried: string[] }) => variants.filter((v) => !r.tried.includes(v));
  const violUntried = violSummary.total > 0 ? untried(violResolved) : [];
  const compUntried = compSummary.total > 0 ? untried(compResolved) : [];
  const unqueried = [...new Set([...violUntried, ...compUntried])];
  if (unqueried.length) {
    // NOT "the spelling you passed matched": houseNumberVariants("120 15") is
    // ["120 15", "120-15", "12015"], so the loop can stop on the SECOND, leaving
    // the third unqueried while matchedVariant is true -- and the matchedVariant
    // note above then says, in this same string, that the passed spelling did
    // not match. Name the spelling that actually stopped each probe; the two
    // sections are probed independently and can stop on different ones.
    const parts: string[] = [];
    if (violUntried.length) {
      parts.push(`violations stopped at "${violResolved.houseNumber}", leaving ${violUntried.join(", ")}`);
    }
    if (compUntried.length) {
      parts.push(`complaints stopped at "${compResolved.houseNumber}", leaving ${compUntried.join(", ")}`);
    }
    notes.push(
      `The probe stops at the first spelling that matches, so these were never sent — ${parts.join("; ")}. ` +
        "DOB files one building under more than one spelling and each holds its own rows, so a small " +
        "count under a de-hyphenated number can sit beside a much larger one under the hyphenated form " +
        "(measured live: 12 under \"9015\" vs 383 under \"90-15\" on Queens Boulevard). Re-run with " +
        "that spelling to see it.",
    );
  }
  notes.push(
    "DOB records use the agency's raw formats (dates often YYYYMMDD; complaint categories and " +
      "disposition codes are DOB's own code tables). DOB house numbers are stored as filed, which " +
      "for outer-borough addresses is often hyphenated (e.g. 120-15). Separator variants of the " +
      "number you passed are probed before a zero is reported; splitting a plain number into a " +
      "hyphenated one is generated for Queens addresses only, so elsewhere try the hyphenated " +
      "spelling yourself.",
  );

  return {
    query: {
      house_number: houseNumberInput,
      house_number_matched: {
        violations: violResolved.matchedVariant ? violResolved.houseNumber : undefined,
        complaints: compResolved.matchedVariant ? compResolved.houseNumber : undefined,
      },
      street,
      borough: boro.text,
    },
    violations: {
      total_matching: violSummary.total,
      by_category: violSummary.by,
      returned: violRows.length,
      results: violRows.map(normDobViolation),
    },
    complaints: {
      total_matching: compSummary.total,
      by_status: compSummary.by,
      returned: compRows.length,
      results: compRows.map(normDobComplaint),
    },
    note: notes.join(" "),
  };
}

async function building311(args: Row): Promise<unknown> {
  const address = reqStr(args.address, "address");
  const boro = resolveBorough(args.borough);
  const complaintType = str(args.complaint_type);
  const since = normSince(args.since, "since");
  const limit = clampLimit(args.limit, 50);

  const whereFor = (candidate: string): string | undefined => {
    const conditions = [likeCI("incident_address", candidate), eqTextCI("borough", boro.text)];
    if (complaintType) {
      conditions.push(eqTextCI("complaint_type", complaintType));
    } else {
      // The current type is HEAT/HOT WATER; HEATING is the pre-2014 label.
      conditions.push(`upper(complaint_type) in ('HEAT/HOT WATER','HEATING')`);
    }
    if (since) conditions.push(gteDate("created_date", since));
    return whereAnd(conditions);
  };

  // 311 stores the incident address hyphenated for outer-borough buildings
  // (live 2026-09-14: "107-36 QUEENS BOULEVARD"), so a de-hyphenated number
  // returns zero heat complaints and reads as a clean building. Probe the house
  // number's spelling variants, recombined with the rest of the address line.
  const variants = addressHouseNumberVariants(address, { hyphenateDigits: boro.text === "QUEENS" });

  // The 311 table is ~40M rows and a bare LIKE over incident_address is a full
  // scan (observed: the summary query times out). $q rides the search index, so
  // pass the address there to narrow FIRST; the $where LIKE then refines the
  // candidate set to exact address substring + borough + type. Each probe is
  // count-only and keeps the $q narrowing, and a later spelling is only asked
  // for after the literal one comes back empty.
  const resolved = await tryHouseNumberVariants(variants, async (candidate) => {
    const where = whereFor(candidate);
    const rows = await sodaGet(DATASET.threeOneOne, {
      $q: candidate,
      $select: "status,count(1) as n",
      $where: where,
      $group: "status",
    });
    const t = tally(rows, "status");
    return { matched: t.total > 0, value: { where, ...t } };
  });
  const matchedAddress = resolved.houseNumber; // the winning full address spelling
  const { where, total, by } = resolved.value;
  const rows =
    total > 0
      ? await sodaGet(DATASET.threeOneOne, { $q: matchedAddress, $where: where, $order: "created_date DESC", $limit: limit })
      : [];

  const notes: string[] = [];
  if (resolved.matchedVariant) {
    notes.push(`No rows under "${address}"; matched 311's stored address "${matchedAddress}".`);
  }
  // dob_building's sibling, and it had the same blind spot: the probe stops at
  // the first spelling that matched, so the rest were never sent, and neither
  // note here fires -- matchedVariant needs the literal to have FAILED and the
  // zero note needs a zero. Rows are keyed on the literal stored string and do
  // not cross spellings (live 2026-09-15: "107-36 QUEENS BOULEVARD" has 27 heat
  // rows in Queens and "10736 QUEENS BOULEVARD" has 0), and 311 stores both
  // forms -- the zero note below cites 2,253 Bronx / 725 Manhattan / 205
  // Brooklyn hyphenated rows, while a live group-by on erm2-nwe9 returns
  // unhyphenated stored forms such as "34 59 AVENUE" and "23 21 ROAD". Unlike
  // DOB (12 vs 383 on one Queens Boulevard address) no 311 building was found
  // holding rows under BOTH spellings, so this says what was not QUERIED and
  // does not claim what it would return.
  if (total > 0) {
    const untriedSpellings = variants.filter((v) => !resolved.tried.includes(v));
    if (untriedSpellings.length) {
      notes.push(
        `The probe stopped at "${matchedAddress}", so these address spellings were NOT queried: ` +
          `${untriedSpellings.join(", ")}. 311 stores outer-borough addresses both hyphenated and ` +
          "de-hyphenated and a row is only returned under the spelling it is stored with, so re-run " +
          "with that spelling to see whether it holds any of its own.",
      );
    }
  }
  if (total === 0) {
    // Splitting a plain number into a hyphenated one is generated for QUEENS
    // only, because rewriting a plain number elsewhere would point at an
    // unrelated address. 311 does hold hyphenated addresses in the other
    // boroughs (live 2026-09-14: 2,253 Bronx, 725 Manhattan, 205 Brooklyn),
    // so outside Queens that retry is the caller's to make, and a zero note
    // that does not say so leaves them with no next move.
    const tried =
      variants.length > 1
        ? ` Tried address spellings: ${variants.join(", ")}.`
        : ` Only "${address}" was tried: the digit-split house number is generated for Queens addresses only.`;
    notes.push(
      "No matching 311 requests." +
        tried +
        " The 311 incident address is one combined line (e.g. " +
        '"1520 SEDGWICK AVENUE"); try the exact street spelling, a hyphenated house number (311 ' +
        "stores them outside Queens too), or drop complaint_type to search the heat/hot-water default.",
    );
  }

  return {
    query: {
      address: matchedAddress,
      address_searched: resolved.matchedVariant ? address : undefined,
      borough: boro.text,
      complaint_type: complaintType ?? "HEAT/HOT WATER (+ legacy HEATING)",
      since: str(args.since) ?? null,
    },
    summary: { total_matching: total, by_status: by },
    returned: rows.length,
    results: rows.map(norm311),
    note: notes.length ? notes.join(" ") : undefined,
  };
}

const HANDLERS: Record<string, (args: Row) => Promise<unknown>> = {
  building_violations: buildingViolations,
  building_complaints: buildingComplaints,
  who_owns: whoOwns,
  landlord_portfolio: landlordPortfolio,
  landlord_litigation: landlordLitigation,
  eviction_lookup: evictionLookup,
  building_profile: buildingProfile,
  true_owner: trueOwner,
  dob_building: dobBuilding,
  building_311: building311,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * SPEC no-implied-outcome.
 *
 * Every dataset here is an administrative record with a narrow meaning, and
 * each one has a specific wrong reading a reasonable person reaches for:
 *   - `case_status` / `case_judgement` are HPD's own workflow codes. CLOSED
 *     does not mean the landlord won, and it does not mean the tenant lost.
 *   - the eviction dataset begins at marshal EXECUTION. No row does not mean
 *     no case was filed, and a row says nothing about whether it was justified.
 *   - violations and complaints are allegations and inspection findings, which
 *     are not the same thing as each other and neither is a ruling.
 *
 * The note is per-tool because a single generic disclaimer would be ignored.
 * It rides the payload for the same reason as the sibling servers: the model
 * has the payload in hand when it writes the sentence a person actually reads.
 */
const RECORD_SCOPE: Record<string, string> = {
  landlord_litigation:
    "HPD housing-litigation records. case_status and case_judgement are HPD's " +
    "administrative codes for the proceeding, not a court's ruling on the merits — " +
    "they do not establish who won, who was at fault, or the outcome of any case. " +
    "No matching record does not mean no litigation exists.",
  eviction_lookup:
    "Marshal-executed evictions only. This dataset begins when a city marshal " +
    "carries out a warrant, so it excludes cases filed, settled, withdrawn, or " +
    "still pending — absence is not evidence that no eviction proceeding occurred. " +
    "A listed eviction records that one was executed, not that it was justified.",
  building_violations:
    "HPD-issued violations: inspection findings on a date, with their own open/close " +
    "workflow codes. Not court outcomes, and not a current condition report.",
  building_complaints:
    "Tenant-reported complaints. These are allegations recorded by HPD, not findings, " +
    "and not outcomes.",
  who_owns:
    "HPD registration filings, which record who registered the building, not who " +
    "beneficially owns it. Registrations lapse and go stale.",
  landlord_portfolio:
    "Buildings matched by registered-party name. Name matching is approximate and " +
    "distinct entities can share a name; this is not proof of common ownership.",
  building_profile:
    "A composite of administrative records, each with its own narrow meaning: " +
    "violations and complaints are findings and allegations (not rulings), " +
    "litigation statuses are HPD workflow codes (not outcomes), and the eviction " +
    "count begins at marshal execution. A zero in any section means no published " +
    "record matched — not that nothing happened.",
  true_owner:
    "Property records, not a beneficial-ownership determination. The assessment-" +
    "roll owner can lag sales; recorded parties are the names on the instrument, " +
    "which are often LLCs; a Speculation Watch List entry flags a qualifying " +
    "purchase, not wrongdoing. Staten Island instruments are not in ACRIS.",
  dob_building:
    "Department of Buildings administrative records. Violations are agency " +
    "findings with their own disposition codes, complaints are unverified " +
    "reports, and neither is a court outcome or a current condition report.",
  building_311:
    "311 service requests are resident reports — allegations, not findings. The " +
    "responding agency's resolution text describes what the agency says it did. " +
    "Absence of requests is not evidence a condition did not exist.",
};

function withRecordScope(name: string, result: unknown): unknown {
  const scope = RECORD_SCOPE[name];
  if (!scope) return result;
  if (result === null || typeof result !== "object") return { result, record_scope: scope };
  if (Array.isArray(result)) return { results: result, record_scope: scope };
  return { ...(result as Record<string, unknown>), record_scope: scope };
}

export function createServer(): Server {
  // Kept equal to package.json by a test that reads both, rather than a runtime
  // JSON import: cheaper, equally effective, and it keeps the runtime free of a
  // module-resolution wrinkle under NodeNext. A client or registry reading
  // serverInfo.version had been getting 1.1.0 from a 1.1.1 package.
  const server = new Server(
    { name: "mcp-nychousing", version: "1.1.1" },
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
      const given = (args ?? {}) as Row;
      const accepted = acceptedArgsOf(TOOLS, name);
      if (accepted) validateArgs(name, accepted, given);
      const result = await handler(given);
      return { content: [{ type: "text", text: JSON.stringify(withRecordScope(name, result), null, 2) }] };
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
export const __test = {
  resolveBorough,
  soql,
  soqlLike,
  likeCI,
  houseNumberAnchored,
  streetDistinctive,
  streetTypeWord,
  streetAnchored,
  eqTextCI,
  inText,
  tally,
  houseNumberVariants,
  addressHouseNumberVariants,
  contactNameWhere,
  /** The knob values this module resolved at import. */
  config: { HTTP_ATTEMPTS, CACHE_TTL_MS, CACHE_MAX },
};
