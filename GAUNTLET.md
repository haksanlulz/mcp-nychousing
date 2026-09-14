# GAUNTLET — mcp-nychousing

Constraint state for this server (SSoT). Created by `/gauntlet convert` 2026-07-29. Operator owns §1 and §5; Claude maintains §2–§4 and §6, transcribing operator rulings only.

One of four near-identical civic servers converted together on 2026-07-29 (`mcp-fairrent` is the pilot and carries the fullest escape log). Sibling precedent: `mcp-scryfall/GAUNTLET.md`.

## §1 Oracle — done-definition

- **It is**: a stdio MCP server over NYC Open Data (Socrata/SODA). Tools — `building_violations`, `building_complaints`, `who_owns`, `landlord_portfolio`, `landlord_litigation`, `eviction_lookup`, `building_profile`, `true_owner`, `dob_building`, `building_311`. It exists so that HPD violations, complaints, building ownership, landlord portfolios (reverse lookup by name), HPD litigation and marshal evictions are answered from the city's own records, for tenant organizers, housing-court legal aid and Right-to-Counsel orgs.
- **DONE means**: (a) an MCP client sees every tool and a real lookup round-trips over stdio; (b) results carry the underlying values so a caller can cite rather than trust; (c) every upstream request is serialized, spaced, timed out, and identifies itself.
- **Non-goals**: tenant PII storage, legal advice, anything that implies a case outcome.

- **MUST NEVER** (operator, 2026-07-29): *"It implies a case outcome."* These are administrative records with narrow meanings — HPD workflow codes, and evictions captured only at marshal execution. Nothing this server returns establishes who won, who was at fault, or whether an action was justified, and no absence of a record is evidence that nothing happened. Locked by SPEC `no-implied-outcome`.

⚠️ The three bullets above the MUST NEVER line are still transcribed from the README rather than elicited; the MUST NEVER clause is operator-authored.

⚠️ **NEEDS OPERATOR CONFIRMATION (2026-09-14).** The tool list above was six names while ten shipped; the four added in 1.1.0 are now transcribed in, from `test/server.test.ts` ("lists exactly the ten documented tools") and the `HANDLERS` map in `server.ts`. **Only the enumeration was touched.** The sentence after it still describes the six original domains, so the done-definition does not yet cover what `building_profile` and `true_owner` actually do — cross-dataset assembly, and in `true_owner`'s case an ownership answer built from the recorded instrument rather than from HPD's filings. That is done-definition language and is not Claude's to author. `DONE means`, `Non-goals` and `MUST NEVER` are unchanged.

## §2 Channel map

**A test suite is one channel; it is never the artifact's channel.**

| Artifact | Real channel | Pass condition | Rung? |
|---|---|---|---|
| server process | an MCP client spawns it and speaks JSON-RPC over **stdio** | initialize handshake · tools/list returns the documented set · a real lookup round-trips | ✅ **`npm run verify:pack` spawns the installed binary and speaks real stdio** (added 2026-07-29). ⚠️ `npm run smoke` and `test/` are BOTH `InMemoryTransport` — an earlier version of this table claimed smoke drove real stdio; it does not, and that claim was wrong when written. |
| upstream API contract | live NYC Open Data (Socrata/SODA) | endpoints answer; token absence is reported, not crashed | ✅ `npm run smoke` (skips loudly without `NYC_APP_TOKEN` (optional — Socrata rate-limits anonymous clients harder)) |
| public repo | a stranger clones and runs `npm test` | suite green, typecheck clean, build emits | ✅ **GitHub Actions, Node 18/20/22** (added 2026-07-29): `npm ci` → typecheck → build → test, plus a separate `package` job running `verify:pack` |
| **npm package** | a stranger runs `npx @haksanlulz/mcp-nychousing` having never cloned | bin shim resolves · server boots · handshake answers · tools/list is well-formed | ✅ **`npm run verify:pack`** — builds, packs, installs the tarball into a throwaway project, launches **through the bin shim**, speaks MCP. Mutation-probed against the real historical defect: restoring the `npx tsx` shebang turns it red. Wired into CI. |
| **.mcpb bundle** | a host installs `manifest.json` + the bundle and launches the server from it | manifest validates · bundle carries its own runtime · the declared `mcp_config` command starts · handshake answers · tools/list is the documented ten | ✅ **`npm run verify:mcpb`** (added 2026-09-14) — stages `dist/` + production `node_modules`, packs with the vendor CLI, unpacks, reads the manifest **out of the bundle**, resolves `${__dirname}` and `${user_config.*}` the way a host does, launches that command and speaks MCP. Mutation-probed: a broken `mcp_config.args` reddens it, and so does an `entry_point` that names a different real file. Wired into CI. |
| registry listing (LobeHub, Glama) | a stranger reads the README there and follows it cold | documented install produces a working server | 🟡 **PARTIAL** — the documented install is now `npx @haksanlulz/mcp-nychousing` and `verify:pack` proves exactly that path executes. What is still unchecked is the README's *prose*: the tool table, the worked example's figures, and the dataset count are hand-maintained. The dataset count has one documented grep beside it (README lede); the rest have nothing. |

## §3 Invariants — scans

| Invariant | Scan | Status |
|---|---|---|
| Concurrent calls cannot breach the throttle | vitest: *"serializes concurrent requests through the throttle queue"* | ✅ present |
| Spacing is start-to-start, not gap+latency | vitest: *"spaces request STARTS by the throttle gap"* | ✅ present |
| One hung request cannot wedge later calls | `AbortSignal.timeout(15_000)` on every fetch | ✅ present (assertion via the header test) |
| Every request identifies itself to NYC Open Data | vitest asserts `User-Agent` matches `^mcp-nychousing/\d` | ✅ **added 2026-07-29, mutation-probed red** |
| Token never enters the query string | vitest asserts header-only auth | ✅ present |
| Published tarball ships no tests/tooling | `files` whitelist + `npm pack --dry-run` | ✅ **added 2026-07-29** — `files: ["dist"]`; `verify:pack` fails if any source, test or tsconfig appears in the tarball |
| Every record states its scope (SPEC `no-implied-outcome`) | vitest ×3 — litigation, evictions, and the empty result | ✅ **added 2026-07-29**, written RED first |

## §4 Ladder

| Class | Rungs |
|---|---|
| docs-only | none |
| code-touch (`server.ts` / `index.ts` / `test/`) | `npm test` + `npm run typecheck` + §3 scans · **this is a public commit** |
| behavior-change (tool names, schemas, output shape) | + `npm run smoke` with a live token + README tool table + §5 specs |
| artifact-affecting (`package.json`, deps, shebang, tsconfig) | + **`npm run verify:pack`** + **`npm run verify:mcpb`** |
| bundle-affecting (`manifest.json`, `scripts/mcpb-probe.mjs`) | + **`npm run verify:mcpb`** |
| release (tag / npm publish) | + the full §2 channel map + `npm run smoke` with a live token + §5 specs |

**Hard gate:** a skipped rung makes the done-report say **BLOCKED**, not done. `prepublishOnly` (`build && typecheck && test`) enforces the code half mechanically. The npm channel itself is covered by `verify:pack`, which CI runs on every push.

## §5 Acceptance specs

### SPEC no-implied-outcome
```
Given HPD litigation records or the marshal-executed eviction dataset
When either is returned
Then the payload states what that record does and does not establish
```
Per-tool, not one generic disclaimer — a generic one gets ignored, and each dataset has a different wrong reading a reasonable person reaches for. `case_status: CLOSED` is an HPD workflow code, not a ruling. The eviction set begins at marshal execution, so no row does **not** mean no case was filed. The empty-result case is explicitly covered: that is where a reader is most likely to infer "clean record", so it must never ship the note-less shape.

Check: `test/server.test.ts` (tagged `spec: no-implied-outcome`), three cases — litigation, evictions, and the empty result. **Red-capable:** written RED first; all three failed before `withRecordScope` existed (2026-07-29).

*Slots 2 and 3 are open and operator-owned.*

## §6 Escape log

**2026-07-29 · The npm package cannot work, and the install line I recommended was wrong.** Adding `bin` + `files` + a scoped name and then actually exercising the channel — `npm pack`, install the tarball into a clean project, spawn the installed binary and speak MCP to it — showed the binary dies on launch. `index.ts` carries `#!/usr/bin/env -S npx tsx`, and npm's generated shim cannot honour that: it resolves `npx-cli.js` inside the *consumer's* `node_modules/npm/`, which does not exist. Isolated to packaging, not code — the installed source runs correctly when `tsx` is invoked directly, and the repo's own smoke still passes. **RESOLVED same day by operator ruling** ("bring it up to our best"): a compile step went in. `tsc` already had `outDir`/`rootDir`/`nodenext` configured and every relative import already carried a `.js` extension, so the build cost was the shebang and the wiring — `#!/usr/bin/env node`, `bin` → `dist/index.js`, `files: ["dist"]`, `prepublishOnly`. **⚑ And the first version of the new rung was toothless.** It spawned `node dist/index.js` directly, which bypasses the shebang — so it passed against the broken package. Caught by mutation-probing the rung itself; it now launches through the **bin shim**, and restoring the `npx tsx` shebang turns it red. **This is the founding-incident shape twice over** — 46 green tests plus a passing smoke over an artifact that could not start, and then a rung that could not see it.

**2026-07-29 · `mcp-wagewatch` shipped with no User-Agent at all; 21 green tests never noticed.** It called a free federal API as an anonymous Node client while all three siblings identified themselves. Fixed, and the missing assertion added to all four — mutation-probed in each. **New rung** (§3): every server asserts its own UA.

**2026-07-29 · Four of my own probes returned confident wrong answers in one session.** `npm pack --dry-run` writes no file, so an install test ran against a tarball that never existed and reported "no bin linked". A UA mutation probe grepped stdout for `"User-Agent"`, which also appears in a *passing* run because it is in the test name. A test-count grep missed fairrent entirely because it runs vitest 2.1.9 with ANSI codes while the siblings run 4.1.10. A rate-limiter read called fairrent's throttle naive when it is correctly serialized. **Standing rule for this repo: a probe that cannot be shown to return a negative is not evidence** (workspace Audit Discipline Rules 22/23).

### 2026-08-23 — 1.1.0: four tools over eleven new datasets (behavior-change class)

`building_profile` (nine-dataset one-call aggregate), `true_owner` (PLUTO -> ACRIS -> Speculation Watch ownership chain), `dob_building`, `building_311`. Every dataset id and each dataset's borough encoding was probed live BEFORE use (five distinct encodings: uppercase text, Title Case, 2-letter, numeric 1-5, and DOB complaints with no borough column at all — community-board first digit instead). Rungs run: 57 tests, typecheck, live smoke 10/10 keyless, verify:pack. One live failure during the rung: building_311's summary query full-scanned the ~40M-row table and timed out at 15s; fixed by riding the indexed $q with the LIKE as refiner, then re-smoked green. pack-probe now parses npm's --json in both its array and object-keyed shapes (npm 11 changed it; found because the rung failed here, not in CI).

### 2026-09-14 — correctness sweep + the bundle channel

Nine items. Six were silent-wrong-answer defects, each confirmed live before the fix and after it: `landlord_portfolio` capped each registration-id chunk at the chunk's id count and returned 1 of 87 buildings for a portfolio registration; `who_owns` and `building_profile` shipped hundreds of duplicate contact rows (435 rows, 5 identities) from an unordered capped read; `building_profile`'s eviction match composed `"<house> <street>"` against a free-text column that stores ranges and mangled streets, reading 0 where 8 executed evictions sit; `true_owner` chose `latest_deed` from an unordered 150-document slice; `dob_building` and `building_311` skipped the house-number variant probe every sibling tool runs, returning 0 on a de-hyphenated Queens address; the three `SODA_*` env knobs were bare `Number()` reads where a NaN silently disabled retries, cache expiry and cache eviction.

Two shapes recurred and are worth carrying forward. **(a) A cap that cannot be made safe by ordering.** The contact repeats for one identity are contiguous under every column `feu5-w2e2` offers, so no `$order` rescues a capped row read — the fix had to move the distinct-set computation server-side. **(b) A mock that cannot fail.** The fetch stub returned every fixture row regardless of `$limit`, so the portfolio truncation was invisible to a green suite; the stub now honours `$limit`/`$offset`. Every fix was mutation-probed by restoring the old behaviour and watching the new tests redden.

`verify:mcpb` was added the same day, and its first version was toothless in the founding shape: it checked that `server.entry_point` existed in the bundle, which passed when pointed at `dist/server.js` — a different real file. It now asserts the entry point is the file `mcp_config` actually launches.

## Known gaps, ranked by blast radius

Re-ranked 2026-09-14: the README-install gap that sat at rank 1 is resolved — the README documents `npx @haksanlulz/mcp-nychousing` and `verify:pack` proves that path executes.

1. **§5 holds one spec of a planned three, and §1 is stale in a way Claude cannot fix** — the operator's stated MUST-NEVER is authored, implemented and linked (2026-07-29). Slots 2 and 3 are open. §1's descriptive bullets are still transcribed from the README rather than elicited, and its done-definition sentence still describes the six 1.0 tools while ten ship; see the ⚠️ in §1. **Now the highest-value remaining item.**
2. **README prose is unchecked.** The install path is covered, but the tool table, the worked example's figures and the dataset count are hand-maintained and rendered on LobeHub and Glama. Only the dataset count carries a checkable grep. A figure in the worked example going stale is low-severity (it is marked as a dated live run), a wrong tool name or argument in the table is not.
3. **vitest version drift** — fairrent 2.1.9, the siblings 4.1.10, for no recorded reason.
4. **`smoke` is in-memory, not stdio.** `verify:pack` and `verify:mcpb` now cover the real-stdio channels, so smoke's remaining job is the live upstream contract. Its name oversells it.
5. **Nothing is published yet.** The package is verified publishable and the bundle is verified launchable; `npm publish` is an operator action.

## Dependency advisories

**Measured 2026-09-14, `npm audit`: 7 total — 1 high, 2 moderate, 4 low.** None is reachable from this server's executed path. Recorded here dated, because the numbers move and an undated "we looked at it" is worth nothing.

| Advisory | Severity | Enters via | Why it does not reach the server |
|---|---|---|---|
| `hono` | moderate | `@modelcontextprotocol/sdk` -> `hono` / `@hono/node-server` | The SDK carries hono and express to support its HTTP transports. Nothing here imports one — pinned by `test/no-http-stack.test.ts`, which reads `index.ts` and `server.ts` and fails if any non-stdio transport appears. |
| `qs` | moderate | `@modelcontextprotocol/sdk` -> `express` -> `body-parser` -> `qs` | Same path, same reason: express is never loaded. |
| `tmp` | high | `@anthropic-ai/mcpb` -> `@inquirer/prompts` -> `@inquirer/editor` -> `external-editor` -> `tmp` | **devDependency only.** It is the interactive prompt stack behind `mcpb init`, which this repo does not use — `manifest.json` is checked in, and `verify:mcpb` calls only `pack` and `unpack`. Not in the published tarball (`files: ["dist"]`) and not in the bundle (staged with `--omit=dev`). No fix is available upstream. |
| `@inquirer/*`, `external-editor`, `@anthropic-ai/mcpb` | low | same chain | Same: dev-only, and the four low entries are that one chain reported at each level. |

⚠️ This table is a claim about REACHABILITY, not about the advisories being wrong. If an HTTP transport is ever imported, the two moderate ones become live the same day — which is what `test/no-http-stack.test.ts` exists to catch. Re-measure on any dependency bump; do not carry the counts forward.
