# mcp-nychousing

MCP server for NYC housing data over [NYC Open Data](https://opendata.cityofnewyork.us/) (the Socrata / SODA API). Built for tenant organizers, housing-court legal-aid intake, and Right-to-Counsel orgs: pull a building's HPD violations and complaints, find out who actually owns it two different ways (HPD's registration filings, and the property record itself: the assessment roll, recorded deeds and mortgages, and Speculation Watch List), map everything else registered under that owner or agent's name, check HPD litigation, Department of Buildings records, 311 heat complaints, and marshal-executed evictions — or pull the whole picture in one `building_profile` call.

It wraps eighteen city datasets and normalizes their raw columns (`novdescription`, `violationstatus`, `registrationid`, `court_index_number`, and so on) into documented tool outputs. The number is the `DATASET` map in `server.ts`, one row per id in the table below:

```bash
sed -n '/^const DATASET = {/,/^} as const;/p' server.ts | grep -oE '"[a-z0-9]{4}-[a-z0-9]{4}"' | sort -u | wc -l
```

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `building_violations` | `house_number`, `street`, `borough` (all required), `open_only`, `violation_class`, `since`, `limit` | HPD violations for a building (`wvxf-dwi5`). Server-side per-class count summary (A/B/C/I) plus recent rows: id, apartment, class, description, status, open flag, inspection date. |
| `building_complaints` | `house_number`, `street`, `borough` (all required), `open_only`, `since`, `limit` | HPD complaints and problems for a building (`ygpa-z7cr`). Open/closed count summary plus recent rows: complaint id, category, status, dates. |
| `who_owns` | `house_number`, `street`, `borough` (all required) | HPD registration (`tesw-yqqr`) joined to registration contacts (`feu5-w2e2`). Owner, head officer, officer, agent, and site manager, with names and business addresses, grouped by type. |
| `landlord_portfolio` | `name` (required), `borough`, `limit` | Reverse of `who_owns`: registration contacts (`feu5-w2e2`) matched by corporation or person name, resolved to every currently registered building (`tesw-yqqr`). Address, borough, zip, BIN, registration dates, and which contact(s) matched, plus contact/registration/building counts. |
| `landlord_litigation` | `house_number` + `street` + `borough`, and/or `respondent`, plus `case_status`, `limit` | HPD Housing Litigations (`59kj-x8nc`) by building or by respondent name. Case type, open date, status, judgement, harassment finding, penalty, respondent, with a by-status summary. |
| `eviction_lookup` | `court_index_number`, and/or `address`, and/or `borough`, plus `since`, `limit` | Marshal-executed evictions (`6z8x-wfk4`) by court index number or address/borough. Index number, address, executed date, marshal, residential/commercial flag. |
| `building_profile` | `house_number`, `street`, `borough` (all required) | One-call profile across ten datasets: registration (`tesw-yqqr`) + contacts (`feu5-w2e2`), violation counts by class, complaint counts by status, litigation counts by status, executed-eviction count, AEP status (`hcir-3275`), vacate orders (`tb8q-a3ar`), latest bedbug filings (`wz6d-d3jb`), and emergency-repair charge count (`sbnd-xujn`). Start here, then drill down. |
| `true_owner` | `house_number`, `street`, `borough` (all required), `docs_limit` | Ownership from the property record rather than HPD's filings: the DOF assessment-roll owner (PLUTO `64uk-42ks`), recent recorded deeds/mortgages with named parties (ACRIS `8h5j-fqxa` -> `bnx9-e6tj` -> `636b-3b5g`), and Speculation Watch List hits (`adax-9mit`). Always surfaces `latest_deed` (the newest DEED-family instrument, chased specifically even when the newest documents are other paperwork). Staten Island instruments are with the Richmond County Clerk, not ACRIS. |
| `dob_building` | `house_number`, `street`, `borough` (all required), `limit` | Department of Buildings records — a different agency from HPD: DOB violations (`3h2n-5cm9`, by-category summary) and DOB complaints (`eabe-havv`, by-status summary). DOB dates arrive in the agency's raw formats. |
| `building_311` | `address`, `borough` (both required), `complaint_type`, `since`, `limit` | 311 service requests (`erm2-nwe9`) for an address, defaulting to the heat/hot-water types; pass `complaint_type` for any other. Newest-first with a by-status summary. Uses the dataset's full-text index (`$q`) so the 40M-row table answers fast. |

`borough` accepts Manhattan, Bronx, Brooklyn, Queens, or Staten Island (also `MN`/`BX`/`BK`/`QN`/`SI` or the codes 1 to 5). `violation_class` is one of A (non-hazardous), B (hazardous), C (immediately hazardous), I (informational). `since` is an ISO date (`YYYY-MM-DD`).

## Data source and grounding

- Base URL: `https://data.cityofnewyork.us/resource/<dataset-id>.json`
- Auth: none. SODA is keyless. An optional Socrata app token (see below) only raises the per-IP rate limit.
- Response: list and aggregate queries return a bare JSON array. Errors return `{ "error": true, "message": "..." }`.
- Query language: SoQL via `$select`, `$where`, `$group`, `$order`, `$limit`, with `upper(...)` and `like` for string matching and `||` for the first/last-name concatenation in `landlord_portfolio`. All user text is escaped (a single quote becomes two) before it reaches a query.

Dataset ids and column notes:

| Dataset | Id | Notes |
|---------|-----|-------|
| HPD Violations | `wvxf-dwi5` | Address columns `housenumber` / `streetname` / `boro`. Status is `violationstatus` (Open/Close); `currentstatus` is the detailed step. |
| HPD Complaints and Problems | `ygpa-z7cr` | The current combined dataset (the older `uwyv-629c` is not publicly readable). Address columns `house_number` / `street_name` / `borough`. One row per problem. |
| HPD Registrations | `tesw-yqqr` | Current registrations. Join key `registrationid`. |
| HPD Registration Contacts | `feu5-w2e2` | Owner / agent / officer names. Joined by `registrationid`. |
| HPD Housing Litigations | `59kj-x8nc` | Address columns `housenumber` / `streetname` / `boroid` (numeric 1 to 5, no text borough). Has `respondent`, `penalty`, `findingofharassment`. |
| Evictions | `6z8x-wfk4` | Marshal-executed only. Combined `eviction_address` string plus `borough`. |
| DOB Violations | `3h2n-5cm9` | `boro` is a NUMERIC-as-text code 1-5 (plus legacy junk rows). Dates in DOB's raw formats (often `YYYYMMDD`). |
| DOB Complaints | `eabe-havv` | NO borough column at all; the `community_board` first digit is the borough code (filtered via `starts_with`). |
| 311 Service Requests | `erm2-nwe9` | ~40M rows; a bare `LIKE` over `incident_address` full-scans and times out, so the address rides the indexed `$q` full-text parameter with the `LIKE` as refiner. Borough is uppercase text. |
| Bedbug Filings | `wz6d-d3jb` | Borough uppercase text. Infested / eradicated / re-infested unit counts per filing period. |
| AEP (Alternative Enforcement) | `hcir-3275` | `boro` is Title Case text ("Bronx"); matched case-insensitively. |
| Vacate Orders | `tb8q-a3ar` | `boro_short_name` is the 2-letter code (BX/BK/MN/QN/SI). |
| HWO Emergency-Repair Charges | `sbnd-xujn` | Handyman Work Orders billed to landlords. Borough uppercase text. |
| PLUTO Tax Lots | `64uk-42ks` | `borough` is the 2-letter code. Carries the DOF assessment-roll `ownername`, `bbl`, block/lot, units, year built. |
| ACRIS Legals | `8h5j-fqxa` | Step 1 of the recorded-instrument chain: borough/block/lot -> document ids. Text-typed columns, quoted comparisons. Carries NO recorded-date column, so recency comes from Master, never from `document_id` (legacy `FT_*` ids sort above every modern one). Staten Island is NOT in ACRIS (Richmond County Clerk). |
| ACRIS Master | `bnx9-e6tj` | Step 2: document id -> `doc_type`, `recorded_datetime`, `document_amt`. This is the recency key for `latest_deed`. |
| ACRIS Parties | `636b-3b5g` | Step 3: document id -> named parties. Role semantics vary by doc type (for a deed, party 1 is the seller and party 2 the buyer; for a mortgage, party 1 is the borrower and party 2 the lender). |
| Speculation Watch List | `adax-9mit` | Qualifying flip-risk purchases; matched by block/lot with the row's own `bbl` confirming borough. |

### Field map (raw column to normalized output)

| Raw column | Normalized field | Tool |
|------------|------------------|------|
| `violationid`, `novdescription`, `currentstatus`, `violationstatus` | `violation_id`, `description`, `current_status`, `is_open` | building_violations |
| `class`, `rentimpairing`, `inspectiondate` | `class`, `rent_impairing`, `inspection_date` | building_violations |
| `complaint_id`, `major_category`, `complaint_status`, `received_date` | `complaint_id`, `major_category`, `complaint_status`, `received_date` | building_complaints |
| `registrationid`, `corporationname`, `firstname` + `lastname`, `business*` | `registration_id`, `organization`, `person_name`, `business_address` | who_owns |
| `housenumber` + `streetname`, `boro`, `bin`, `lastregistrationdate` | `building_address`, `borough`, `bin`, `last_registration_date` (+ `matched_contacts`) | landlord_portfolio |
| `litigationid`, `casetype`, `casestatus`, `penalty`, `respondent` | `litigation_id`, `case_type`, `case_status`, `penalty`, `respondent` | landlord_litigation |
| `court_index_number`, `eviction_address`, `executed_date`, `marshal_*` | `court_index_number`, `eviction_address`, `executed_date`, `marshal_name` | eviction_lookup |
| `ownername`, `bbl`, `block`/`lot`, `unitsres`, `yearbuilt` | `owner_name`, `bbl`, `block`/`lot`, `residential_units`, `year_built` | true_owner (PLUTO) |
| `doc_type`, `document_amt`, `recorded_datetime`, parties by `party_type` | `doc_type`, `document_amount`, `recorded_datetime`, `party_1`/`party_2`/`party_3` | true_owner (ACRIS) |
| `complaint_type`, `descriptor`, `resolution_description`, `created_date` | same names | building_311 |

## Install

Nothing to clone. Point your MCP client at it and npm fetches it on first run:

```json
{
  "mcpServers": {
    "nychousing": {
      "command": "npx",
      "args": ["-y", "@haksanlulz/mcp-nychousing"],
      "env": { "NYC_APP_TOKEN": "your-nyc-app-token" }
    }
  }
}
```

<details>
<summary>From source (contributors)</summary>

```bash
git clone https://github.com/haksanlulz/mcp-nychousing
cd mcp-nychousing
npm install
npm run build     # emits dist/; the published bin is dist/index.js
```

`npm start` runs the TypeScript directly via [`tsx`](https://github.com/privatenumber/tsx) without building.
</details>

### Bundle (`.mcpb`)

`manifest.json` describes the server as an [MCP Bundle](https://github.com/anthropics/mcpb), for hosts that install a local server from a single file. Verify that channel:

```bash
npm run verify:mcpb
```

That stages `dist/` plus production dependencies, packs the bundle with the vendor CLI (which validates the manifest first), unpacks it, launches the server through the `mcp_config` in the packed manifest, and asserts the ten tools over stdio. It runs in the CI `package` job beside `verify:pack`, so the bundle channel is measured rather than assumed.

It stages and packs into a throwaway directory and removes it afterwards, so it proves the bundle rather than producing one. To keep a bundle, stage `dist/` plus production dependencies and run `npx @anthropic-ai/mcpb pack <stage-dir> <out>.mcpb` yourself.

The app token is declared as an optional `user_config` field (`required: false`, `sensitive: true`) injected as `NYC_APP_TOKEN`. The server treats a value still containing `${` as unset, so a host that passes an unsubstituted template for a field the user skipped does not produce a bad-credential header. The probe launches the bundle with exactly that unsubstituted template, since that is the case the guard exists for.

A bundle carries its own `node_modules`, which means it ships the MCP SDK's `hono` / `express` subtree inside the artifact. The same reasoning as `test/no-http-stack.test.ts` applies to this channel: those packages are present in the dependency tree but unreachable, because nothing in this server imports an HTTP transport. That test reads the source and pins the property; a vulnerability scan of the bundle will still list them.

## App token (optional)

Every tool works with no token. If you make heavy or bursty use, a free Socrata app token raises the rate limit. Create one from the developer settings on your NYC Open Data account. Docs: https://dev.socrata.com/docs/app-tokens.html

Expose it as `NYC_APP_TOKEN` and it is sent as the `X-App-Token` header:

```
export NYC_APP_TOKEN=your-token-here   # macOS / Linux
setx NYC_APP_TOKEN your-token-here      # Windows (new shells)
```

The token is never logged.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `NYC_APP_TOKEN` | unset | Socrata app token, sent as `X-App-Token`. Optional; raises the rate limit only. A value still containing `${` is treated as unset. |
| `SODA_HTTP_ATTEMPTS` | `3` | Attempts per outbound request (minimum 1). 429, 5xx and transport errors are retried with backoff; other 4xx and a non-JSON body are not. |
| `SODA_CACHE_TTL_MS` | `28800000` (8h) | Lifetime of a cached response, matched to HPD's 8-hour extract refresh. `0` disables the cache. In memory, successful reads only. |
| `SODA_CACHE_MAX` | `300` | Cached responses kept before the least recently used is evicted (minimum 1). |

The three `SODA_*` knobs take an integer. Anything else — a non-integer, a value below the minimum — is refused with one line on stderr naming the variable and the default it fell back to, rather than a throw at import: a typo in an optional knob should not take the server down. A silent `Number("abc")` would not be inert here, since `NaN` disables the retry loop, the cache expiry and the eviction pass in turn.

## MCP client config

Add an `"env": { "NYC_APP_TOKEN": "your-token-here" }` block only if you want the higher rate limit.

## Example

Call `building_violations` with `{ "house_number": "1520", "street": "Sedgwick Avenue", "borough": "Bronx", "open_only": true, "limit": 1 }`:

```json
{
  "query": {
    "house_number": "1520",
    "street": "Sedgwick Avenue",
    "borough": "BRONX",
    "open_only": true,
    "violation_class": null,
    "since": null
  },
  "summary": { "total_matching": 128, "by_class": { "A": 21, "B": 74, "C": 33 } },
  "returned": 1,
  "results": [
    {
      "violation_id": "19051745",
      "apartment": "2D",
      "story": "2",
      "class": "C",
      "description": "HMC ADM CODE: ... ABATE THE INFESTATION CONSISTING OF MICE ...",
      "current_status": "NOTICE OF ISSUANCE SENT TO TENANT",
      "is_open": true,
      "rent_impairing": false,
      "inspection_date": "2026-07-04T00:00:00.000",
      "nov_issued_date": "2026-07-08T00:00:00.000",
      "nov_type": "Original"
    }
  ],
  "record_scope": "HPD-issued violations: inspection findings on a date, with their own open/close workflow codes. Not court outcomes, and not a current condition report."
}
```

The counts are illustrative and move as the city updates the data. The `summary` counts every match server-side; `results` is the most recent `limit` of them.

Every response carries a `record_scope` line stating what that specific dataset does and does not establish. It is per-tool, because each one has a different wrong reading available: `landlord_litigation` returns HPD workflow codes, not rulings on the merits, and `eviction_lookup` covers **marshal-executed** evictions only — so no matching row does not mean no case was ever filed.

Then take a name from `who_owns` output and reverse it. Call `landlord_portfolio` with `{ "name": "WFHA 1520 SEDGWICK LP" }`:

```json
{
  "query": { "name": "WFHA 1520 SEDGWICK LP", "borough": null },
  "found": true,
  "summary": { "contact_matches": 1, "distinct_registrations": 1, "buildings_found": 1 },
  "note": "Contacts reflect HPD registration filings. The same landlord may file each building under a separate LLC; officer and agent person names often connect what the LLC names hide.",
  "returned": 1,
  "buildings": [
    {
      "registration_id": "221729",
      "building_id": "108415",
      "building_address": "1520 SEDGWICK AVENUE",
      "borough": "BRONX",
      "zip": "10453",
      "bin": "2009171",
      "last_registration_date": "2025-09-05T00:00:00.000",
      "registration_end_date": "2026-09-01T00:00:00.000",
      "matched_contacts": [
        { "type": "CorporateOwner", "organization": "WFHA 1520 SEDGWICK LP", "person_name": null }
      ]
    }
  ],
  "record_scope": "Buildings matched by registered-party name. Name matching is approximate and distinct entities can share a name; this is not proof of common ownership."
}
```

A single-building LLC like this one is itself the common NYC pattern; searching an officer or agent person name from the same `who_owns` output is how you connect the buildings the per-building LLC names hide.

## Worked example

A tenant comes to an intake desk about 1520 Sedgwick Avenue in the Bronx. You need the building's condition record, a name to serve, and whether the landlord holds other buildings — before the appointment ends.

Four calls, in this order. Figures below are from a live run on 2026-09-14 and move as the city updates the data.

**1. `building_profile`** — `{ "house_number": "1520", "street": "Sedgwick Avenue", "borough": "Bronx" }`

The one-call overview across ten datasets. Returned: registered with HPD; 1,038 violations (203 class A, 551 B, 281 C, 3 I); 2,831 complaints, all closed; 32 HPD litigations, 31 closed and 1 pending; 13 marshal-executed evictions; 1 vacate order; 3 bedbug filings; 7 emergency-repair charges; not in AEP. The eviction count arrives with the stored address spellings it matched (`1520 SEDGWICK AVE` once, `1520 SEDGWICK AVENUE` twelve times), so you can see what the count is made of.

**2. `who_owns`** — same three arguments

Registration `221729`, expiring 2026-09-01, with five distinct contacts: a corporate owner (`WFHA 1520 SEDGWICK LP`), an agent (`M H R MANAGEGEMENT INC` — HPD's own spelling), a head officer, an officer, and a site manager. Owner and agent share a business address at 43-55 11th Street, Long Island City. That address, and the agent, are the two threads worth pulling.

**3. `landlord_portfolio`** — `{ "name": "M H R MANAGE" }`

A fragment, not the full string, because the stored spelling is misspelled and a second filing may spell it correctly. Two contact records, two registrations, two buildings: 1520 Sedgwick Avenue in the Bronx and 588 Rogers Avenue in Brooklyn — different LLCs, same agent.

**4. `true_owner`** — same three arguments as step 1

The property record rather than HPD's filings. The assessment roll names `1520 SEDGWICK HOUSING DEVELOPMENT FUND C ORPORATION` (the spacing is DOF's), on BBL 2028800017, 101 residential units, built 1969. The most recent deed is document `2012070800054004`, recorded 2012-07-19, from `WFHA 1520 SEDGWICK, L.P.` to the HDFC.

### What goes in the intake note

> 1520 Sedgwick Avenue, Bronx (BBL 2028800017) is a 101-unit building from 1969, currently registered with HPD under registration 221729, which expires 2026-09-01. Its HPD record shows 1,038 violations to date, 281 of them class C (immediately hazardous), plus a vacate order and three bedbug filings. The building carries 32 HPD housing-litigation records, one still pending (the dataset holds HPD-initiated cases and tenant actions together). Thirteen evictions have been executed there by a marshal. The registered owner is WFHA 1520 Sedgwick LP and the registered managing agent is M H R Management Inc, both at 43-55 11th Street, Long Island City; the same agent is also on file for 588 Rogers Avenue in Brooklyn, under a different LLC. The recorded deed is older than the registration: the lot was conveyed in 2012 to 1520 Sedgwick Housing Development Fund Corporation. These are agency records, not findings: HPD registration is self-reported and can lag, violation counts are inspection findings rather than current conditions, and the litigation counts are HPD workflow statuses, not rulings. Confirm the owner and agent before serving.

Every response carries a `record_scope` line saying what that dataset does and does not establish; the last two sentences above are that line, in plain language.

## Address matching

There is no geocoding here. Address matching is literal against how HPD stores addresses:

- Street names are stored uppercase. The server uppercases and trims your `street` input and matches it as a substring (`upper(streetname) like '%YOUR STREET%'`). So `Sedgwick`, `sedgwick avenue`, and `SEDGWICK AVE` all match `SEDGWICK AVENUE`, but a very short input can over-match (`5 St` would also hit `125 St`). Pass the fuller street name when you can.
- House number is matched exactly (uppercased) first by the HPD- and DOB-keyed tools (`building_violations`, `building_complaints`, `who_owns`, `building_profile`, `dob_building`) — and on a zero they retry spelling variants, with the response's `note` naming the ones tried. Separator variants are always tried (`120 15` and `120-15` each also try the other and `12015`). **Splitting a plain number into a hyphenated one (`12015` -> `120-15`) is generated for Queens addresses only**, since rewriting a plain number elsewhere would point at an unrelated building — so outside Queens, pass the hyphenated spelling yourself if the exact one reads zero. Multi-address buildings can still register under a range (`1516-1520`).
- Two tools key on a combined address line instead of a separate house-number column, and match it differently. `true_owner` matches PLUTO's `address` (`1520 SEDGWICK AVENUE`) **from the start of the line**, since PLUTO always stores the house number first — a free substring returned 3817 and 2817 Sedgwick Avenue for house 17, and five unrelated lots (114-20, 118-20, 77-20, 109-20, 104-20) for house 20 on Queens Boulevard. `building_311` matches 311's `incident_address` as a substring. Both run the same house-number spelling probe as the tools above. A corner or multi-lot building can still return more than one PLUTO lot; `assessor_owner`, `latest_deed` and `speculation_watch` all describe the first one, which `assessor_owner_lot_address` names, and the rest are in `lots`.
- The retry stops at the first spelling that matches, so the rest are never sent — and DOB files one building under more than one spelling, each holding its own rows. On `3h2n-5cm9` with borough Queens and street `Queens Boulevard`, house number `9015` returns 12 violations and `90-15` returns 383. `dob_building` names the spellings it did not send, per section and per the spelling that actually stopped each probe, so a small count does not read as the whole record; `building_311` names its unqueried spellings the same way (a 311 row is only returned under the spelling it is stored with, though no 311 building was found holding rows under both). `building_profile` covers the other side of the same miss: when it finds nothing in any dataset, its `note` names the spellings tried and repeats that the street is substring-matched, instead of returning an all-zero profile that reads as a clean building.
- Borough disambiguates same-numbered streets across boroughs, so it is required for the building tools. Litigations store a numeric borough code; evictions mix borough and county spellings (Brooklyn and Kings, Manhattan and New York, Staten Island and Richmond), and the borough filter expands to all of them.
- Evictions store one free-text address line, often a house-number range with an abbreviated or mangled street (`2763-69 SEDGWICK AVE`, `3605 SEDGWICK    AVE NUE`). `building_profile` anchors both halves on a token boundary: the house number cannot match inside a longer number, and the street's distinctive word cannot match inside a longer word, with a stem of the street type (`AV` for Avenue, `RD` or `RO` for Road) required to be the next token after it. Both halves of the street anchor earn their place: without the word boundary, a search for 1650 Ocean Avenue in Brooklyn counts 1650 Ocean Parkway's evictions; with the boundary but the stem free to appear anywhere in the line, a search for 590 Morris Avenue in the Bronx counts `590 MORRIS PARK AVE`, a different street that carries `AV` anyway. A directional in front of the distinctive word names a different street and neither guard can see it, least of all on a street carrying no type word at all (Broadway, Grand Concourse, Avenue X), so it is excluded separately: without that, a search for 475 Broadway in Manhattan counts `475 WEST BROADWAY`'s eviction, and 88 Broadway counts three that are all West or East Broadway's. The exclusion is skipped when your own street starts with a directional, so 475 West Broadway still finds its own. Because the column stores runs of spaces between tokens, runs up to eight are matched. It returns `evictions_matched_addresses`, the stored spellings behind the count with a per-spelling count, so a match you did not intend is visible rather than hidden inside the integer. `evictions_executed` is its own aggregate over the same filter, so the address list's cap does not cap it. One stored line can still name two addresses (`155B KINGSBRIDGE RD A/K/A 2707 SEDGWICK AVENUE`) and is counted for either.
- `landlord_portfolio` matches names the same way: uppercase substring against `corporationname`, `firstname`, `lastname`, and the `firstname || ' ' || lastname` concatenation (so a pasted `person_name` from `who_owns` works). LIKE wildcards (`%`, `_`) in your input are escaped. Pass the fullest name you have; a short fragment like `SMITH` or `LLC` over-matches, and the response says how many contact records matched before any cap.
- `who_owns`, `landlord_portfolio`, `landlord_litigation`, and the datasets themselves reflect HPD filings, which can lag reality. Confirm anything you intend to act on (for example a name to serve) before relying on it.

## Testing

```
npm test         # vitest, fetch mocked (no network); 121 tests in 2 files
npm run smoke    # one live call per tool against SODA (keyless, no setup)
npm run typecheck
npm run verify:pack
npm run verify:mcpb
```

`npm test` is the offline tier: `test/server.test.ts` stubs `globalThis.fetch` and drives every tool through an in-memory MCP client; `test/no-http-stack.test.ts` reads the source and pins that only the stdio transport is imported. `npm run smoke` is the live tier (real SODA calls, not run in CI). There are no test markers; the split is the two scripts.

Counts, measured 2026-09-15:

```
find . -name '*.ts' -not -path './node_modules/*' -not -path './dist/*' -not -path './test/*' | xargs wc -l   # index.ts 8 + server.ts 2646 = 2654 app LOC (smoke.ts 139 is the live harness)
find test -name '*.ts' | xargs wc -l                                                                           # 2171 test LOC
npm test                                                                                                       # Tests 113 passed (113)
```

What the tests cover, by layer: SoQL query construction (where clauses, LIKE escaping, borough aliases, Queens hyphenated house numbers, date validation) is asserted on the URL the mocked fetch receives. Tool responses (summaries, normalized rows, `found`/`note` fields, isError text) are asserted on the parsed payload. Transport behavior (app token and User-Agent headers, 5xx/429 retry counts, 4xx no-retry, non-JSON bodies, response cache hit/miss, IN() chunking at 100 ids) is asserted on call counts and request init.

Mutation probe, re-run 2026-09-15: changed `PORTFOLIO_ID_CHUNK` in `server.ts` from 100 to 200 and ran `npm test`. Three tests failed and 110 passed — `landlord_portfolio > chunks large registration-id sets into multiple IN() queries` (expected 4 fetch calls, got 3), and both `crossing the resolution ceiling on a chunk's short final page` cases, which report `buildings_found` 2000 instead of 2050 and print a ceiling note over a portfolio that was read in full, because one chunk of 200 ids reaches the ceiling on a full page rather than a short one. Source restored after the run.

Wiring assertions, 2026-09-15: 31 `toHaveBeenCalled*` sites. Most sit beside a payload or URL assertion on the same response; the ones that assert a call count alone do so because the count is the whole contract there — the response cache (repeat query = one fetch, different params = two fetches), the retry cap, and the house-number variant probes (a second spelling is attempted only after the first returns zero). Policy: assert behavior and payloads, never that a function was merely called.

The fetch stub honours `$limit` and `$offset`. A stub that returns every fixture row regardless of the query cannot fail on a paging or cap bug, which is how a portfolio truncation — a chunk capped at its own registration-id count — passed a green suite.

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the mocked vitest suite, by running every tool live against NYC Open Data (`npm run smoke`; the Queens hyphenated-house-number, NY/NYC borough, and litigation-summary fixes all came from live behavior, not mocks), and by typecheck. The author reviews the code and is accountable for it.

## License

MIT. See [LICENSE](LICENSE). Data from NYC Open Data (public City of New York data) served via the Socrata SODA API. Unofficial, not affiliated with the City of New York, HPD, or Socrata.
