#!/usr/bin/env node
/**
 * CHANNEL RUNG — the .mcpb bundle, exercised the way a host installs it.
 *
 * Sibling of scripts/pack-probe.mjs, which covers the npm channel. A bundle is
 * a second artifact with its own failure modes: the manifest's entry_point and
 * mcp_config are hand-written strings that nothing else in the repo reads, and
 * a bundle whose command cannot start looks exactly like a bundle that works
 * until someone double-clicks it.
 *
 * What it does:
 *   1. builds dist/, then stages manifest.json + package.json + dist/ and
 *      installs production dependencies into the staging directory (a host runs
 *      the bundle as-is, with no install step, so the SDK must be inside it);
 *   2. packs the staging directory with the vendor CLI, which validates the
 *      manifest against the MCPB schema before it writes anything;
 *   3. unpacks the .mcpb, reads the manifest OUT OF THE BUNDLE, resolves
 *      ${__dirname} and the user_config substitution the way a host does, and
 *      launches exactly that command;
 *   4. completes the MCP initialize handshake over stdio and asserts the ten
 *      documented tools, plus that the manifest's declared tool list matches.
 *
 * Run: npm run verify:mcpb
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not import.meta.dirname: the latter is Node 20.11+ and would
// throw on 18 before the probe reached the artifact at all (see pack-probe).
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`  ok  ${m}`);

console.log(`mcpb-probe: ${manifest.name}@${manifest.version}`);

if (manifest.version !== pkg.version) fail(`manifest.json ${manifest.version} != package.json ${pkg.version}`);
ok("manifest version matches the package");

const mcpbCli = join(repo, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
if (!existsSync(mcpbCli)) fail("@anthropic-ai/mcpb is not installed — run npm ci");

const work = mkdtempSync(join(tmpdir(), "mcpbprobe-"));
const stage = join(work, "stage");
const unpacked = join(work, "unpacked");
const bundle = join(work, `${manifest.name}.mcpb`);
let child;
try {
  // --- 1. build + stage ----------------------------------------------------
  if (spawnSync("npm", ["run", "build"], { cwd: repo, shell: true }).status !== 0) fail("build");
  cpSync(join(repo, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(repo, "manifest.json"), join(stage, "manifest.json"));
  // A trimmed package.json: the bundle needs the runtime dependency list and
  // nothing else. Scripts and devDependencies would only invite the installer
  // to run them.
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, type: pkg.type, main: pkg.main, bin: pkg.bin, dependencies: pkg.dependencies },
      null,
      2,
    ),
  );
  const install = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], {
    cwd: stage,
    shell: true,
    encoding: "utf8",
  });
  if (install.status !== 0) fail(`staging install failed: ${install.stderr?.slice(0, 400)}`);
  ok("staged dist/ + manifest + production node_modules");

  // --- 2. pack (the CLI validates the manifest first) -----------------------
  const packed = spawnSync("node", [mcpbCli, "pack", stage, bundle], { cwd: repo, encoding: "utf8" });
  if (packed.status !== 0) fail(`mcpb pack failed: ${(packed.stderr || packed.stdout || "").slice(0, 800)}`);
  if (!existsSync(bundle)) fail("mcpb pack reported success but wrote no bundle");
  ok(`packed ${manifest.name}.mcpb`);

  // --- 3. unpack and read the manifest OUT OF THE BUNDLE --------------------
  const unpackRes = spawnSync("node", [mcpbCli, "unpack", bundle, unpacked], { cwd: repo, encoding: "utf8" });
  if (unpackRes.status !== 0) fail(`mcpb unpack failed: ${(unpackRes.stderr || unpackRes.stdout || "").slice(0, 800)}`);
  const shipped = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
  const entry = join(unpacked, shipped.server.entry_point);
  if (!existsSync(entry)) fail(`server.entry_point is not in the bundle: ${shipped.server.entry_point}`);
  ok(`entry_point present: ${shipped.server.entry_point}`);

  // --- 4. launch it the way a host does ------------------------------------
  // ${__dirname} is the installed bundle directory. The app token is optional
  // and left unset here, which is the case a host hits when the user skips it.
  const subst = (s) => s.replaceAll("${__dirname}", unpacked);
  const args = (shipped.server.mcp_config.args ?? []).map(subst);
  // entry_point must be the file the command actually runs. Existence alone is
  // not enough: dist/ holds several compiled modules, so a wrong entry_point
  // can name a real file and still describe the bundle incorrectly.
  if (!args.some((a) => resolve(a) === resolve(entry))) {
    fail(`server.entry_point (${shipped.server.entry_point}) is not what mcp_config.args launches: ${args.join(" ")}`);
  }
  ok("entry_point is the file mcp_config launches");
  const env = { ...process.env };
  for (const [k, v] of Object.entries(shipped.server.mcp_config.env ?? {})) env[k] = subst(v);
  delete env.NYC_APP_TOKEN; // unset, as a user who skipped the optional field leaves it

  child = spawn(shipped.server.mcp_config.command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: unpacked, env, shell: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-probe", version: "1.0.0" } },
  });
  await new Promise((r) => setTimeout(r, 1500));
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  await new Promise((r) => {
    child.once("exit", r);
    setTimeout(r, 3000);
  });

  const msgs = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const init = msgs.find((m) => m.id === 1);
  const tools = msgs.find((m) => m.id === 2);

  if (!init?.result) fail(`no initialize response from the bundled server. stderr: ${err.slice(0, 500)}`);
  ok(`initialize -> ${init.result.serverInfo?.name}@${init.result.serverInfo?.version}`);
  if (init.result.serverInfo?.version !== manifest.version) {
    fail(`handshake version ${init.result.serverInfo?.version} != manifest ${manifest.version}`);
  }

  const list = tools?.result?.tools;
  if (!Array.isArray(list)) fail(`tools/list returned nothing. stderr: ${err.slice(0, 500)}`);
  const live = list.map((t) => t.name).sort();
  const EXPECTED = [
    "building_311",
    "building_complaints",
    "building_profile",
    "building_violations",
    "dob_building",
    "eviction_lookup",
    "landlord_litigation",
    "landlord_portfolio",
    "true_owner",
    "who_owns",
  ];
  if (live.join(",") !== EXPECTED.join(",")) fail(`tools/list is ${live.join(", ")}; expected ${EXPECTED.join(", ")}`);
  ok(`tools/list -> ${live.length}: ${live.join(", ")}`);

  const declared = (shipped.tools ?? []).map((t) => t.name).sort();
  if (declared.join(",") !== live.join(",")) fail(`manifest declares ${declared.join(", ")}; the server serves ${live.join(", ")}`);
  ok("the manifest's declared tool list matches the server");

  console.log("PASS — the bundle installs, starts from its own manifest, and serves its tools.");
} finally {
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  // Teardown is best-effort and must never decide the verdict: an EBUSY on a
  // temp directory is not a failure of the artifact under test.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it to the OS */
  }
}
