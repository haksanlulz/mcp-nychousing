#!/usr/bin/env -S npx tsx
// Live smoke test: one real call per tool against the NYC Open Data (SODA) API.
//
// SODA is KEYLESS, so this runs with no setup. An optional NYC_APP_TOKEN only
// raises the rate limit. Targets: 1520 Sedgwick Avenue in the Bronx for the
// building tools, and borough-level Bronx queries for litigation and evictions.
//
//   npm run smoke
//
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

function parse(result: any) {
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? "tool returned isError");
  return JSON.parse(result.content[0].text);
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  console.log(`smoke: live SODA calls (keyless${process.env.NYC_APP_TOKEN ? "; app token set" : ""})\n`);

  let failed = 0;
  const check = async (name: string, args: Record<string, unknown>, ok: (b: any) => boolean, describe: (b: any) => string) => {
    try {
      const body = parse(await client.callTool({ name, arguments: args }));
      if (ok(body)) console.log(`ok   ${name}\n     -> ${describe(body)}`);
      else {
        failed++;
        console.error(`FAIL ${name}: unexpected shape\n${JSON.stringify(body).slice(0, 300)}`);
      }
    } catch (e: any) {
      failed++;
      console.error(`FAIL ${name}: ${e.message}`);
    }
  };

  const bldg = { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" };

  await check(
    "building_violations",
    { ...bldg, limit: 3 },
    (b) => b.summary && typeof b.summary.total_matching === "number" && Array.isArray(b.results),
    (b) => `${b.summary.total_matching} violation(s); by class ${JSON.stringify(b.summary.by_class)}; showing ${b.returned}`,
  );

  await check(
    "building_complaints",
    { ...bldg, limit: 3 },
    (b) => b.summary && typeof b.summary.total_matching === "number" && Array.isArray(b.results),
    (b) => `${b.summary.total_matching} problem(s); by status ${JSON.stringify(b.summary.by_status)}; showing ${b.returned}`,
  );

  await check(
    "who_owns",
    bldg,
    (b) => b.found === true && Array.isArray(b.registrations) && b.registrations.length > 0 && Array.isArray(b.contacts) && b.contacts.length > 0,
    (b) => `reg ${b.registrations[0]?.registration_id}; ${b.contacts.length} contact(s); types ${Object.keys(b.contacts_by_type).join(", ")}`,
  );

  await check(
    "landlord_portfolio",
    { name: "WFHA 1520 SEDGWICK", borough: "Bronx", limit: 5 },
    (b) =>
      b.found === true &&
      b.summary &&
      typeof b.summary.contact_matches === "number" &&
      Array.isArray(b.buildings) &&
      b.buildings.length > 0,
    (b) =>
      `${b.summary.contact_matches} contact match(es) -> ${b.summary.buildings_found} building(s); first: ${b.buildings[0]?.building_address ?? "(none)"} (${b.buildings[0]?.borough ?? "?"})`,
  );

  await check(
    "landlord_litigation",
    { borough: "Bronx", respondent: "realty", limit: 3 },
    (b) => Array.isArray(b.results) && b.summary && typeof b.summary.total_matching === "number" && typeof b.returned === "number",
    (b) => `${b.summary.total_matching} case(s) via $group; showing ${b.returned}; first respondent: ${b.results[0]?.respondent ?? "(none)"}`,
  );

  await check(
    "eviction_lookup",
    { borough: "Bronx", limit: 3 },
    (b) => Array.isArray(b.results),
    (b) => `${b.returned} executed eviction(s); first: ${b.results[0]?.eviction_address ?? "(none)"} on ${b.results[0]?.executed_date ?? "?"}`,
  );

  await check(
    "building_profile",
    bldg,
    (b) =>
      b.registered_with_hpd === true &&
      typeof b.hpd_violations?.total === "number" &&
      typeof b.hpd_complaints?.total === "number" &&
      typeof b.evictions_executed === "number",
    (b) =>
      `viol ${b.hpd_violations.total}, compl ${b.hpd_complaints.total}, lit ${b.hpd_litigation.total}, ` +
      `evict ${b.evictions_executed}, AEP ${b.aep.in_program_history}, vacate ${b.vacate_orders.length}, ` +
      `bedbug ${b.bedbug_filings.length}, HWO ${b.emergency_repair_charges}`,
  );

  await check(
    "true_owner",
    bldg,
    (b) => b.found === true && typeof b.assessor_owner === "string" && Array.isArray(b.acris_documents),
    (b) =>
      `assessor: ${b.assessor_owner}; ${b.acris_documents.length} ACRIS doc(s), newest ${b.acris_documents[0]?.doc_type ?? "(none)"} ` +
      `${b.acris_documents[0]?.recorded_datetime ?? ""}; speculation hits ${b.speculation_watch.length}`,
  );

  await check(
    "dob_building",
    { ...bldg, limit: 3 },
    (b) => typeof b.violations?.total_matching === "number" && typeof b.complaints?.total_matching === "number",
    (b) => `DOB viol ${b.violations.total_matching}, DOB compl ${b.complaints.total_matching}`,
  );

  await check(
    "building_311",
    { address: "1520 Sedgwick Avenue", borough: "Bronx", limit: 3 },
    (b) => b.summary && typeof b.summary.total_matching === "number" && Array.isArray(b.results),
    (b) => `${b.summary.total_matching} heat/hot-water request(s); by status ${JSON.stringify(b.summary.by_status)}`,
  );

  await client.close();
  await server.close();

  console.log(failed === 0 ? "\nsmoke: all tools ok" : `\nsmoke: ${failed} tool(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
