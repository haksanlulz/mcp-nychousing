# mcp-nychousing

MCP server for NYC housing data over [NYC Open Data](https://opendata.cityofnewyork.us/) (the Socrata / SODA API). Built for tenant organizers, housing-court legal-aid intake, and Right-to-Counsel orgs: pull a building's HPD violations and complaints, find out who actually owns it (to serve papers), check HPD litigation against the landlord, and look up marshal-executed evictions.

It wraps six city datasets and normalizes their raw columns (`novdescription`, `violationstatus`, `registrationid`, `court_index_number`, and so on) into documented tool outputs.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `building_violations` | `house_number`, `street`, `borough` (all required), `open_only`, `violation_class`, `since`, `limit` | HPD violations for a building (`wvxf-dwi5`). Server-side per-class count summary (A/B/C/I) plus recent rows: id, apartment, class, description, status, open flag, inspection date. |
| `building_complaints` | `house_number`, `street`, `borough` (all required), `open_only`, `since`, `limit` | HPD complaints and problems for a building (`ygpa-z7cr`). Open/closed count summary plus recent rows: complaint id, category, status, dates. |
| `who_owns` | `house_number`, `street`, `borough` (all required) | HPD registration (`tesw-yqqr`) joined to registration contacts (`feu5-w2e2`). Owner, head officer, officer, agent, and site manager, with names and business addresses, grouped by type. |
| `landlord_litigation` | `house_number` + `street` + `borough`, and/or `respondent`, plus `case_status`, `limit` | HPD Housing Litigations (`59kj-x8nc`) by building or by respondent name. Case type, open date, status, judgement, harassment finding, penalty, respondent, with a by-status summary. |
| `eviction_lookup` | `court_index_number`, and/or `address`, and/or `borough`, plus `since`, `limit` | Marshal-executed evictions (`6z8x-wfk4`) by court index number or address/borough. Index number, address, executed date, marshal, residential/commercial flag. |

`borough` accepts Manhattan, Bronx, Brooklyn, Queens, or Staten Island (also `MN`/`BX`/`BK`/`QN`/`SI` or the codes 1 to 5). `violation_class` is one of A (non-hazardous), B (hazardous), C (immediately hazardous), I (informational). `since` is an ISO date (`YYYY-MM-DD`).

## Data source and grounding

- Base URL: `https://data.cityofnewyork.us/resource/<dataset-id>.json`
- Auth: none. SODA is keyless. An optional Socrata app token (see below) only raises the per-IP rate limit.
- Response: list and aggregate queries return a bare JSON array. Errors return `{ "error": true, "message": "..." }`.
- Query language: SoQL via `$select`, `$where`, `$group`, `$order`, `$limit`, with `upper(...)` and `like` for string matching. All user text is escaped (a single quote becomes two) before it reaches a query.

Dataset ids and column notes:

| Dataset | Id | Notes |
|---------|-----|-------|
| HPD Violations | `wvxf-dwi5` | Address columns `housenumber` / `streetname` / `boro`. Status is `violationstatus` (Open/Close); `currentstatus` is the detailed step. |
| HPD Complaints and Problems | `ygpa-z7cr` | The current combined dataset (the older `uwyv-629c` is not publicly readable). Address columns `house_number` / `street_name` / `borough`. One row per problem. |
| HPD Registrations | `tesw-yqqr` | Current registrations. Join key `registrationid`. |
| HPD Registration Contacts | `feu5-w2e2` | Owner / agent / officer names. Joined by `registrationid`. |
| HPD Housing Litigations | `59kj-x8nc` | Address columns `housenumber` / `streetname` / `boroid` (numeric 1 to 5, no text borough). Has `respondent`, `penalty`, `findingofharassment`. |
| Evictions | `6z8x-wfk4` | Marshal-executed only. Combined `eviction_address` string plus `borough`. |

### Field map (raw column to normalized output)

| Raw column | Normalized field | Tool |
|------------|------------------|------|
| `violationid`, `novdescription`, `currentstatus`, `violationstatus` | `violation_id`, `description`, `current_status`, `is_open` | building_violations |
| `class`, `rentimpairing`, `inspectiondate` | `class`, `rent_impairing`, `inspection_date` | building_violations |
| `complaint_id`, `major_category`, `complaint_status`, `received_date` | `complaint_id`, `major_category`, `complaint_status`, `received_date` | building_complaints |
| `registrationid`, `corporationname`, `firstname` + `lastname`, `business*` | `registration_id`, `organization`, `person_name`, `business_address` | who_owns |
| `litigationid`, `casetype`, `casestatus`, `penalty`, `respondent` | `litigation_id`, `case_type`, `case_status`, `penalty`, `respondent` | landlord_litigation |
| `court_index_number`, `eviction_address`, `executed_date`, `marshal_*` | `court_index_number`, `eviction_address`, `executed_date`, `marshal_name` | eviction_lookup |

## Install

No build step. Runs directly on [tsx](https://github.com/privatenumber/tsx).

```
git clone https://github.com/haksanlulz/mcp-nychousing.git
cd mcp-nychousing
npm install
```

## App token (optional)

Every tool works with no token. If you make heavy or bursty use, a free Socrata app token raises the rate limit. Create one from the developer settings on your NYC Open Data account. Docs: https://dev.socrata.com/docs/app-tokens.html

Expose it as `NYC_APP_TOKEN` and it is sent as the `X-App-Token` header:

```
export NYC_APP_TOKEN=your-token-here   # macOS / Linux
setx NYC_APP_TOKEN your-token-here      # Windows (new shells)
```

The token is never logged.

## MCP client config

Point your MCP client at `index.ts` via tsx. Use an absolute path.

```json
{
  "mcpServers": {
    "nychousing": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-nychousing/index.ts"]
    }
  }
}
```

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
      "class": "C",
      "description": "HMC ADM CODE: ... ABATE THE INFESTATION CONSISTING OF MICE ...",
      "current_status": "NOTICE OF ISSUANCE SENT TO TENANT",
      "is_open": true,
      "rent_impairing": false,
      "inspection_date": "2026-07-04T00:00:00.000",
      "nov_type": "Original"
    }
  ]
}
```

The counts are illustrative and move as the city updates the data. The `summary` counts every match server-side; `results` is the most recent `limit` of them.

## Address matching

There is no geocoding here. Address matching is literal against how HPD stores addresses:

- Street names are stored uppercase. The server uppercases and trims your `street` input and matches it as a substring (`upper(streetname) like '%YOUR STREET%'`). So `Sedgwick`, `sedgwick avenue`, and `SEDGWICK AVE` all match `SEDGWICK AVENUE`, but a very short input can over-match (`5 St` would also hit `125 St`). Pass the fuller street name when you can.
- House number is matched exactly (uppercased), so `1520` is not `1516-1520`. Multi-address buildings can register under a range.
- Borough disambiguates same-numbered streets across boroughs, so it is required for the building tools. Litigations store a numeric borough code; evictions mix borough and county spellings (Brooklyn and Kings, Manhattan and New York, Staten Island and Richmond), and the borough filter expands to all of them.
- `who_owns`, `landlord_litigation`, and the datasets themselves reflect HPD filings, which can lag reality. Confirm anything you intend to act on (for example a name to serve) before relying on it.

## Develop

```
npm test         # vitest, fetch mocked (no network)
npm run smoke    # one live call per tool against SODA (keyless, no setup)
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE). Data from NYC Open Data (public City of New York data) served via the Socrata SODA API. Unofficial, not affiliated with the City of New York, HPD, or Socrata.
