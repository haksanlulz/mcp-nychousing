# mcp-nychousing

MCP server for NYC housing data over [NYC Open Data](https://opendata.cityofnewyork.us/) (the Socrata / SODA API). Built for tenant organizers, housing-court legal-aid intake, and Right-to-Counsel orgs: pull a building's HPD violations and complaints, find out who actually owns it two different ways (HPD's registration filings, and the property record itself: the assessment roll, recorded deeds and mortgages, and Speculation Watch List), map everything else registered under that owner or agent's name, check HPD litigation, Department of Buildings records, 311 heat complaints, and marshal-executed evictions — or pull the whole picture in one `building_profile` call.

It wraps seventeen city datasets and normalizes their raw columns (`novdescription`, `violationstatus`, `registrationid`, `court_index_number`, and so on) into documented tool outputs.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `building_violations` | `house_number`, `street`, `borough` (all required), `open_only`, `violation_class`, `since`, `limit` | HPD violations for a building (`wvxf-dwi5`). Server-side per-class count summary (A/B/C/I) plus recent rows: id, apartment, class, description, status, open flag, inspection date. |
| `building_complaints` | `house_number`, `street`, `borough` (all required), `open_only`, `since`, `limit` | HPD complaints and problems for a building (`ygpa-z7cr`). Open/closed count summary plus recent rows: complaint id, category, status, dates. |
| `who_owns` | `house_number`, `street`, `borough` (all required) | HPD registration (`tesw-yqqr`) joined to registration contacts (`feu5-w2e2`). Owner, head officer, officer, agent, and site manager, with names and business addresses, grouped by type. |
| `landlord_portfolio` | `name` (required), `borough`, `limit` | Reverse of `who_owns`: registration contacts (`feu5-w2e2`) matched by corporation or person name, resolved to every currently registered building (`tesw-yqqr`). Address, borough, zip, BIN, registration dates, and which contact(s) matched, plus contact/registration/building counts. |
| `landlord_litigation` | `house_number` + `street` + `borough`, and/or `respondent`, plus `case_status`, `limit` | HPD Housing Litigations (`59kj-x8nc`) by building or by respondent name. Case type, open date, status, judgement, harassment finding, penalty, respondent, with a by-status summary. |
| `eviction_lookup` | `court_index_number`, and/or `address`, and/or `borough`, plus `since`, `limit` | Marshal-executed evictions (`6z8x-wfk4`) by court index number or address/borough. Index number, address, executed date, marshal, residential/commercial flag. |
| `building_profile` | `house_number`, `street`, `borough` (all required) | One-call profile across nine datasets: registration + contacts, violation counts by class, complaint counts by status, litigation counts by status, executed-eviction count, AEP status (`hcir-3275`), vacate orders (`tb8q-a3ar`), latest bedbug filings (`wz6d-d3jb`), and emergency-repair charge count (`sbnd-xujn`). Start here, then drill down. |
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
| ACRIS Legals / Master / Parties | `8h5j-fqxa` / `bnx9-e6tj` / `636b-3b5g` | The recorded-instrument chain: borough/block/lot -> document ids -> doc type/date/amount -> named parties. Text-typed columns, quoted comparisons. Staten Island is NOT in ACRIS (Richmond County Clerk). |
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

## App token (optional)

Every tool works with no token. If you make heavy or bursty use, a free Socrata app token raises the rate limit. Create one from the developer settings on your NYC Open Data account. Docs: https://dev.socrata.com/docs/app-tokens.html

Expose it as `NYC_APP_TOKEN` and it is sent as the `X-App-Token` header:

```
export NYC_APP_TOKEN=your-token-here   # macOS / Linux
setx NYC_APP_TOKEN your-token-here      # Windows (new shells)
```

The token is never logged.

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

## Address matching

There is no geocoding here. Address matching is literal against how HPD stores addresses:

- Street names are stored uppercase. The server uppercases and trims your `street` input and matches it as a substring (`upper(streetname) like '%YOUR STREET%'`). So `Sedgwick`, `sedgwick avenue`, and `SEDGWICK AVE` all match `SEDGWICK AVENUE`, but a very short input can over-match (`5 St` would also hit `125 St`). Pass the fuller street name when you can.
- House number is matched exactly (uppercased) first — and on a zero, the per-building tools automatically retry spelling variants: `120 15` and `12015` are re-tried as `120-15` (Queens numbers get the digit-split form), and the response's `note` names every spelling tried, so a hyphenation zero never silently reads as a clean building. Multi-address buildings can still register under a range (`1516-1520`).
- Borough disambiguates same-numbered streets across boroughs, so it is required for the building tools. Litigations store a numeric borough code; evictions mix borough and county spellings (Brooklyn and Kings, Manhattan and New York, Staten Island and Richmond), and the borough filter expands to all of them.
- `landlord_portfolio` matches names the same way: uppercase substring against `corporationname`, `firstname`, `lastname`, and the `firstname || ' ' || lastname` concatenation (so a pasted `person_name` from `who_owns` works). LIKE wildcards (`%`, `_`) in your input are escaped. Pass the fullest name you have; a short fragment like `SMITH` or `LLC` over-matches, and the response says how many contact records matched before any cap.
- `who_owns`, `landlord_portfolio`, `landlord_litigation`, and the datasets themselves reflect HPD filings, which can lag reality. Confirm anything you intend to act on (for example a name to serve) before relying on it.

## Develop

```
npm test         # vitest, fetch mocked (no network)
npm run smoke    # one live call per tool against SODA (keyless, no setup)
npm run typecheck
```

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the mocked vitest suite, by running every tool live against NYC Open Data (`npm run smoke`; the Queens hyphenated-house-number, NY/NYC borough, and litigation-summary fixes all came from live behavior, not mocks), and by typecheck. The author reviews the code and is accountable for it.

## License

MIT. See [LICENSE](LICENSE). Data from NYC Open Data (public City of New York data) served via the Socrata SODA API. Unofficial, not affiliated with the City of New York, HPD, or Socrata.
