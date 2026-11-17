#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-portal-configuration-snapshot-git-backup.
 *
 * Extracts the JavaScript of every Code node straight from workflow.json and
 * executes it in an isolated Node.js VM context that emulates the parts of the
 * n8n Code-node runtime this workflow uses ($env, $input, $('Node'), require,
 * Buffer). The VM context has no access to http/https/net/fetch, so the run
 * is provably offline.
 *
 * It verifies:
 *   1. Workflow structure: unique names, valid connections, inactive on import,
 *      HubSpot calls are GET-only, every secret comes from $env, no hardcoded
 *      credentials, and every {{ expression }} parses.
 *   2. Safe defaults: empty env, typo'd env and blocked $env all stay in
 *      SANDBOX + DRY_RUN with commits and notifications off.
 *   3. Live-mode refusal when token / portal ID are missing.
 *   4. The embedded fixture equals sample-payloads/portal-metadata-fixture.json.
 *   5. SHA-256: pure-JS fallback matches node:crypto (NIST vectors + snapshot).
 *   6. Determinism: identical input yields an identical bundle checksum, even
 *      when the source arrays are shuffled.
 *   7. Integrity: SHA256SUMS written to sim-output/ verifies against the files.
 *   8. Diffing: a mutated portal produces the expected record-level changes.
 *   9. Live path (with mocked HTTP responses): response pairing, endpoint
 *      error handling (DEGRADED), portal guard, workflow pagination.
 *  10. Commit path (with mocked GitHub responses): tree payload contents,
 *      pruning rules, protected-branch block.
 *  11. Summary payload contains no secret values.
 *
 * Usage:   node scripts/simulate-sandbox-run.js [--quiet] [--keep-output]
 * Exit:    0 when every check passes, 1 otherwise.
 * Output:  sim-output/ (git-ignored) contains the generated snapshot tree.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'portal-metadata-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');

const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const nodesByName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

// ------------------------------------------------------------------ harness
let passed = 0;
let failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed++;
    if (!QUIET) console.log(`  ✔ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` -- ${detail}` : ''));
    console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title) {
  if (!QUIET) console.log(`\n▶ ${title}`);
}
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Run one Code node from workflow.json.
 * @param {string} name        node name
 * @param {object} opts
 *   input:    array of item json objects fed to $input
 *   outputs:  map of upstream node name -> array of item json (for $('Name'))
 *   env:      env var map, or the string 'BLOCKED' to emulate denied $env
 *   crypto:   false to emulate NODE_FUNCTION_ALLOW_BUILTIN not including crypto
 */
async function runNode(name, { input = [{}], outputs = {}, env = {}, crypto = true } = {}) {
  const node = nodesByName[name];
  if (!node || node.type !== 'n8n-nodes-base.code') throw new Error(`No Code node named "${name}"`);
  const wrapItems = (arr) => arr.map((json) => ({ json: clone(json) }));
  const accessor = (arr) => {
    const items = wrapItems(arr);
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const envProxy = new Proxy({}, {
    get(_t, key) {
      if (env === 'BLOCKED') throw new Error('access to env vars denied');
      return typeof key === 'string' ? env[key] : undefined;
    },
  });
  const sandbox = {
    $input: accessor(input),
    $env: envProxy,
    $: (n) => {
      if (!(n in outputs)) throw new Error(`Referenced node "${n}" has not executed`);
      return accessor(outputs[n]);
    },
    require: (m) => {
      if (m === 'crypto' && crypto) return nodeCrypto;
      throw new Error(`Cannot find module '${m}'`);
    },
    Buffer,
    console: { log() {}, warn() {}, error() {} },
  };
  const src = `(async () => {\n${node.parameters.jsCode}\n})()`;
  const result = await vm.runInNewContext(src, sandbox, { timeout: 10000, filename: `${name}.js` });
  if (!Array.isArray(result)) throw new Error(`Node "${name}" did not return an array`);
  return clone(result.map((i) => i.json));
}
async function expectThrow(fn, re) {
  try {
    await fn();
    return { threw: false };
  } catch (e) {
    return { threw: true, matches: re ? re.test(e.message) : true, message: e.message };
  }
}

// ----------------------------------------------------------- reusable runs
const LIVE_ENV = {
  SANDBOX_MODE: 'false',
  DRY_RUN: 'false',
  GIT_COMMITS_ENABLED: 'true',
  HUBSPOT_ACCESS_TOKEN: 'sim-placeholder-hubspot-token',
  HUBSPOT_PORTAL_ID: '99000001',
  GITHUB_PAT: 'sim-placeholder-git-token',
  GITHUB_REPOSITORY: 'example-org/hubspot-config-backup',
  GIT_BRANCH: 'hubspot-config-snapshots',
  GIT_REPO_URL: 'https://github.example/example-org/hubspot-config-backup.git',
  SNAPSHOT_TIMESTAMP_OVERRIDE: '2026-11-17T02:15:00.000Z',
};
const SECRET_VALUES = [LIVE_ENV.HUBSPOT_ACCESS_TOKEN, LIVE_ENV.GITHUB_PAT];

async function sandboxPipeline({ env = {}, fixtureOverride, previousManifest, crypto = true } = {}) {
  const cfgOut = await runNode('Config & Safety Gate', { env });
  const outputs = { 'Config & Safety Gate': cfgOut };
  let fixtureOut = await runNode('Load Synthetic Fixture', { outputs });
  if (fixtureOverride) fixtureOut = [{ ...fixtureOut[0], raw: fixtureOverride }];
  outputs['Load Synthetic Fixture'] = fixtureOut;
  const normOut = await runNode('Normalization & Checksum Auditor', { input: fixtureOut, outputs, crypto });
  outputs['Normalization & Checksum Auditor'] = normOut;
  const diffInput = previousManifest ? [{ previousManifest }] : normOut;
  const diffOut = await runNode('Versioned Diff Builder', { input: diffInput, outputs });
  outputs['Versioned Diff Builder'] = diffOut;
  const previewOut = await runNode('Dry-Run Preview', { input: diffOut, outputs });
  outputs['Dry-Run Preview'] = previewOut;
  const summaryOut = await runNode('RevOps Summary Builder', { input: previewOut, outputs });
  outputs['RevOps Summary Builder'] = summaryOut;
  const logOut = await runNode('Run Log (No External Calls)', { input: summaryOut, outputs });
  return {
    cfg: cfgOut[0].config,
    norm: normOut[0],
    diff: diffOut[0],
    preview: previewOut[0],
    summary: summaryOut[0],
    log: logOut[0],
    outputs,
  };
}

/** Build mocked HubSpot HTTP responses for the live path from the fixture. */
function mockHubspotResponses(requests, { failKeys = [], portalOverride } = {}) {
  return requests.map((r) => {
    const { key } = r;
    if (failKeys.includes(key)) return { error: { message: '403 - {"status":"error","category":"MISSING_SCOPES"}' } };
    const [kind, t] = key.split(':');
    switch (kind) {
      case 'accountInfo':
        return { ...fixture.accountInfo, portalId: portalOverride !== undefined ? portalOverride : fixture.accountInfo.portalId };
      case 'customObjectSchemas':
        return { results: fixture.customObjectSchemas };
      case 'properties':
        return { results: fixture.properties[t] || [] };
      case 'propertyGroups':
        return { results: fixture.propertyGroups[t] || [] };
      case 'pipelines':
        return { results: fixture.pipelines[t] || [] };
      default:
        return { error: { message: 'unexpected key ' + key } };
    }
  });
}

async function livePipeline({ env = LIVE_ENV, failKeys = [], portalOverride, workflowPages, previousManifestResponse, headCommit } = {}) {
  const outputs = {};
  outputs['Config & Safety Gate'] = await runNode('Config & Safety Gate', { env });
  const reqs = await runNode('Build HubSpot Export Requests', { outputs });
  outputs['Build HubSpot Export Requests'] = reqs;
  const http = mockHubspotResponses(reqs, { failKeys, portalOverride });
  outputs['HubSpot Metadata Export (v3 API)'] = http;
  outputs['Collect & Verify API Responses'] = await runNode('Collect & Verify API Responses', { input: http, outputs });
  const pages = workflowPages || [
    { results: fixture.workflows.slice(0, 2), paging: { next: { after: '2' } } },
    { results: fixture.workflows.slice(2) },
  ];
  outputs['Assemble Raw Snapshot'] = await runNode('Assemble Raw Snapshot', { input: pages, outputs });
  outputs['Normalization & Checksum Auditor'] = await runNode('Normalization & Checksum Auditor', { input: outputs['Assemble Raw Snapshot'], outputs });
  const diffIn = previousManifestResponse ? [previousManifestResponse] : [{ error: { message: '404 - Not Found' } }];
  outputs['Versioned Diff Builder'] = await runNode('Versioned Diff Builder', { input: diffIn, outputs });
  let tree = null;
  if (outputs['Versioned Diff Builder'][0].commitGate.allowed) {
    const head = headCommit || { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } };
    outputs['Build Git Tree Payload'] = await runNode('Build Git Tree Payload', { input: [head], outputs });
    tree = outputs['Build Git Tree Payload'][0];
  }
  return { outputs, reqs, tree, cfg: outputs['Config & Safety Gate'][0].config };
}

// -------------------------------------------------------------------- main
(async () => {
  console.log('n8n-hubspot-portal-configuration-snapshot-git-backup :: offline sandbox simulator');
  console.log(`workflow: ${path.relative(ROOT, WORKFLOW_PATH)} (${workflow.nodes.length} nodes)`);

  // ---------------------------------------------------------- 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import (active=false)', workflow.active === false);
  let badConn = [];
  for (const [src, conn] of Object.entries(workflow.connections)) {
    if (!nodesByName[src]) badConn.push(`unknown source ${src}`);
    for (const branch of conn.main || []) for (const c of branch) if (!nodesByName[c.node]) badConn.push(`${src} -> ${c.node}`);
  }
  check('All connections reference existing nodes', badConn.length === 0, badConn.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check('Every IF node wires both true and false outputs', ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length > 0)));
  const reachable = new Set();
  const walk = (n) => { if (reachable.has(n)) return; reachable.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  walk('Manual Test Trigger');
  walk('Daily Snapshot Schedule');
  const unreachable = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reachable.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreachable.length === 0, unreachable.join(', '));

  const httpNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const hubspotNodes = httpNodes.filter((n) => JSON.stringify(n.parameters).includes('HUBSPOT_ACCESS_TOKEN'));
  check('HubSpot HTTP nodes are GET-only (no CRM mutations possible)', hubspotNodes.length === 2 && hubspotNodes.every((n) => (n.parameters.method || 'GET') === 'GET'));
  const authHeaders = httpNodes.flatMap((n) => (n.parameters.headerParameters?.parameters || []).filter((h) => h.name === 'Authorization'));
  check('Every Authorization header is an $env expression', authHeaders.length > 0 && authHeaders.every((h) => /^=Bearer \{\{ \$env\.[A-Z_]+ \}\}$/.test(h.value)));
  check('Workflow defines no stored n8n credentials', workflow.nodes.every((n) => !n.credentials));

  const rawText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const secretPatterns = [
    [/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/i, 'HubSpot private app token'],
    [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained PAT'],
    [/xox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    [/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/, 'Slack webhook URL'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/Bearer [A-Za-z0-9\-_.]{16,}/, 'literal bearer token'],
  ];
  const hits = secretPatterns.filter(([re]) => re.test(rawText)).map(([, l]) => l);
  check('No hardcoded credentials, webhook URLs or keys in workflow.json', hits.length === 0, hits.join(', '));
  const repoText = ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/portal-metadata-fixture.json']
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  const repoHits = secretPatterns.filter(([re]) => re.test(repoText)).map(([, l]) => l);
  check('No credentials in README, DISCLAIMER, .env.example or fixture', repoHits.length === 0, repoHits.join(', '));

  const exprErrors = [];
  const visit = (v, where) => {
    if (typeof v === 'string' && v.startsWith('=')) {
      const re = /\{\{([\s\S]*?)\}\}/g;
      let m;
      while ((m = re.exec(v))) {
        try { new Function('$json', '$env', '$', '$response', `return (${m[1]});`); } catch (e) { exprErrors.push(`${where}: ${e.message}`); }
      }
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${where}.${k}`);
  };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every n8n {{ expression }} is syntactically valid JavaScript', exprErrors.length === 0, exprErrors.join('; '));
  const codeErrors = [];
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    try { new vm.Script(`(async () => {\n${n.parameters.jsCode}\n})`); } catch (e) { codeErrors.push(`${n.name}: ${e.message}`); }
  }
  check('Every Code node compiles', codeErrors.length === 0, codeErrors.join('; '));

  // ------------------------------------------------------- 2. safe defaults
  section('2. Safe-by-default configuration');
  const empty = (await runNode('Config & Safety Gate', { env: {} }))[0].config;
  check('Empty env -> SANDBOX_MODE=true', empty.sandboxMode === true);
  check('Empty env -> DRY_RUN=true', empty.dryRun === true);
  check('Empty env -> Git commits disabled', empty.git.commitsEnabled === false && empty.git.staticCommitBlockers.length > 0);
  check('Empty env -> notifications disabled', empty.notify.allowed === false);
  check('Empty env -> remote Git read disabled', empty.git.remoteReadAllowed === false);
  check('Sandbox forces synthetic portal ID 99000001', empty.portalId === '99000001');
  const typo = (await runNode('Config & Safety Gate', { env: { SANDBOX_MODE: 'flase', DRY_RUN: 'nope', GIT_COMMITS_ENABLED: 'True ', NOTIFICATIONS_ENABLED: 'enabled' } }))[0].config;
  check('Typo values keep SANDBOX_MODE and DRY_RUN on', typo.sandboxMode && typo.dryRun);
  check('Unrecognised "enabled" does not turn notifications on', typo.notify.enabled === false);
  const sandboxPortal = (await runNode('Config & Safety Gate', { env: { HUBSPOT_PORTAL_ID: '12345678' } }))[0].config;
  check('Sandbox ignores a configured real-looking portal ID', sandboxPortal.portalId === '99000001');
  const blocked = (await runNode('Config & Safety Gate', { env: 'BLOCKED' }))[0].config;
  check('Blocked $env access falls back to safe defaults', blocked.envBlocked && blocked.sandboxMode && blocked.dryRun && !blocked.git.commitsEnabled);
  const allOnSandbox = (await runNode('Config & Safety Gate', { env: { ...LIVE_ENV, SANDBOX_MODE: 'true' } }))[0].config;
  check('SANDBOX_MODE=true blocks commits even with every other flag armed', allOnSandbox.git.staticCommitBlockers.some((r) => r.startsWith('SANDBOX_MODE')));
  const outCfgText = JSON.stringify(await runNode('Config & Safety Gate', { env: LIVE_ENV }));
  check('Config output never contains secret values', SECRET_VALUES.every((s) => !outCfgText.includes(s)));

  // ----------------------------------------------------- 3. live refusals
  section('3. Live-mode refusal rules');
  const noTok = await expectThrow(() => runNode('Config & Safety Gate', { env: { SANDBOX_MODE: 'false', HUBSPOT_PORTAL_ID: '99000001' } }), /HUBSPOT_ACCESS_TOKEN/);
  check('Live mode without HUBSPOT_ACCESS_TOKEN throws', noTok.threw && noTok.matches, noTok.message);
  const noPortal = await expectThrow(() => runNode('Config & Safety Gate', { env: { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: 'x' } }), /HUBSPOT_PORTAL_ID/);
  check('Live mode without numeric HUBSPOT_PORTAL_ID throws', noPortal.threw && noPortal.matches, noPortal.message);
  const prot = (await runNode('Config & Safety Gate', { env: { ...LIVE_ENV, GIT_BRANCH: 'main' } }))[0].config;
  check('Protected branch "main" blocks commits by default', prot.git.staticCommitBlockers.some((r) => r.includes('protected')));
  const badRepo = (await runNode('Config & Safety Gate', { env: { ...LIVE_ENV, GITHUB_REPOSITORY: 'https://github.example/x/y' } }))[0].config;
  check('A URL in GITHUB_REPOSITORY is rejected (owner/repo required)', badRepo.git.staticCommitBlockers.some((r) => r.includes('owner/repo')));

  // --------------------------------------------------- 4. fixture parity
  section('4. Embedded fixture parity');
  const embedded = nodesByName['Load Synthetic Fixture'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\n\nconst \{ config \}/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(embedded[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/portal-metadata-fixture.json', parity);
  check('Fixture is flagged synthetic and uses portal 99000001', fixture._meta.synthetic === true && fixture.portalId === '99000001');

  // ---------------------------------------------------------- 5. hashing
  section('5. SHA-256 engines');
  const base = await sandboxPipeline();
  const pure = await sandboxPipeline({ crypto: false });
  check('node:crypto engine selected when crypto is allowed', base.norm.audit.hashEngine === 'node:crypto');
  check('pure-JS engine selected when crypto is blocked', pure.norm.audit.hashEngine === 'pure-js');
  check('Both engines produce the identical bundle checksum', base.norm.snapshot.bundleSha256 === pure.norm.snapshot.bundleSha256);
  check('Both engines produce identical per-file checksums', base.norm.snapshot.files.every((f, i) => f.sha256 === pure.norm.snapshot.files[i].sha256));
  // Known-answer tests for the fallback, executed through the node's own code.
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['Pipeline étape → 🚀', nodeCrypto.createHash('sha256').update('Pipeline étape → 🚀', 'utf8').digest('hex')],
    ['x'.repeat(1000), nodeCrypto.createHash('sha256').update('x'.repeat(1000)).digest('hex')],
  ];
  const fnSrc = nodesByName['Normalization & Checksum Auditor'].parameters.jsCode;
  const extract = (name) => {
    const start = fnSrc.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = fnSrc.indexOf('{', start); i < fnSrc.length; i++) {
      if (fnSrc[i] === '{') depth++;
      if (fnSrc[i] === '}' && --depth === 0) return fnSrc.slice(start, i + 1);
    }
    return '';
  };
  const ctx = {};
  vm.runInNewContext(`${extract('utf8Bytes')}\n${extract('sha256Fallback')}\nthis.f = sha256Fallback;`, ctx);
  const kat = vectors.every(([m, h]) => ctx.f(m) === h);
  check('Pure-JS SHA-256 passes NIST / UTF-8 known-answer vectors', kat);

  // ------------------------------------------------ 6. sandbox end-to-end
  section('6. Sandbox end-to-end run');
  const s = base.norm.snapshot;
  check('Health is HEALTHY', base.norm.audit.health === 'HEALTHY', JSON.stringify(base.norm.audit.errors));
  check('Integrity self-check passed for every file', base.norm.audit.integrity.passed === base.norm.audit.integrity.checked && s.files.length > 0);
  const expectedPaths = [
    'custom-objects/schemas.json', 'custom-objects/vendor_contract/properties.json',
    'pipelines/deals.json', 'pipelines/tickets.json',
    'properties/companies.json', 'properties/contacts.json', 'properties/deals.json', 'properties/tickets.json',
    'property-groups/companies.json', 'property-groups/contacts.json', 'property-groups/deals.json', 'property-groups/tickets.json',
    'workflows/workflows.json',
  ];
  check('Expected 13 snapshot files are produced', JSON.stringify(s.files.map((f) => f.path)) === JSON.stringify(expectedPaths), s.files.map((f) => f.path).join(', '));
  check('Counts: 1 custom object, 3 pipelines, 14 stages, 4 workflows', s.counts.customObjects === 1 && s.counts.pipelines === 3 && s.counts.pipelineStages === 14 && s.counts.workflows === 4, JSON.stringify(s.counts));
  check('HubSpot-defined properties excluded by default (16 custom properties)', s.counts.properties === 16, String(s.counts.properties));
  const allContent = s.files.map((f) => f.content).join('');
  check('User IDs redacted from all files', !/UserId/.test(allContent));
  check('Volatile updatedAt stripped from CRM metadata files', s.files.filter((f) => f.kind !== 'workflows').every((f) => !f.content.includes('"updatedAt"')));
  check('Workflow updatedAt kept (only change signal for metadata-only export)', s.files.find((f) => f.kind === 'workflows').content.includes('"updatedAt"'));
  const contactProps = JSON.parse(s.files.find((f) => f.path === 'properties/contacts.json').content);
  check('Records sorted by name', JSON.stringify(contactProps.map((p) => p.name)) === JSON.stringify([...contactProps.map((p) => p.name)].sort()));
  const lsd = contactProps.find((p) => p.name === 'lead_source_detail');
  check('Enumeration options sorted by value', JSON.stringify(lsd.options.map((o) => o.value)) === JSON.stringify(['legacy_trade_show', 'paid_search', 'partner_referral', 'webinar']));
  check('Object keys are sorted in every file', s.files.every((f) => {
    const ok = (v) => Array.isArray(v) ? v.every(ok) : v && typeof v === 'object' ? JSON.stringify(Object.keys(v)) === JSON.stringify(Object.keys(v).sort()) && Object.values(v).every(ok) : true;
    return ok(JSON.parse(f.content));
  }));
  check('RevOps validation flags the empty "arr_band" picklist', base.norm.audit.warnings.some((w) => w.includes('arr_band')));
  check('Dry-run preview: would commit, blocked by SANDBOX/DRY_RUN', base.preview.wouldCommit === true && base.preview.blockedBy.some((r) => r.startsWith('SANDBOX_MODE')) && base.preview.blockedBy.some((r) => r.startsWith('DRY_RUN')));
  check('First run: every file reported as added', base.diff.diff.added.length === s.files.length && base.diff.diff.modified.length === 0);
  check('Commit message has conventional header and bundle checksum', /^chore\(snapshot\): portal-99000001 v\d{8}T\d{6}Z \[\+13 ~0 -0\]/.test(base.diff.commitMessage) && base.diff.commitMessage.includes(s.bundleSha256));
  check('Summary status CHANGES_PENDING, mode SANDBOX', base.summary.summary.status === 'CHANGES_PENDING' && base.summary.summary.mode === 'SANDBOX');
  check('Slack payload has text and blocks', typeof base.summary.slackPayload.text === 'string' && Array.isArray(base.summary.slackPayload.blocks) && base.summary.slackPayload.blocks.length >= 4);
  check('Run log terminal node reports notification skipped', base.log.logged === true && /skipped/.test(base.log.notification));

  // -------------------------------------------------------- 7. determinism
  section('7. Determinism and on-disk integrity');
  const shuffle = (a) => [...a].reverse();
  const shuffled = clone(base.outputs['Load Synthetic Fixture'][0].raw);
  for (const t of Object.keys(shuffled.properties)) {
    shuffled.properties[t] = shuffle(shuffled.properties[t]).map((p) => ({ ...p, options: p.options ? shuffle(p.options) : p.options }));
  }
  for (const t of Object.keys(shuffled.pipelines)) shuffled.pipelines[t] = shuffle(shuffled.pipelines[t]).map((p) => ({ ...p, stages: shuffle(p.stages) }));
  shuffled.workflows = shuffle(shuffled.workflows);
  shuffled.properties.deals = shuffled.properties.deals.map((p) => ({ ...p, updatedAt: '2030-01-01T00:00:00.000Z', updatedUserId: '1' }));
  const shuf = await sandboxPipeline({ fixtureOverride: shuffled, env: { SNAPSHOT_TIMESTAMP_OVERRIDE: '2027-01-01T00:00:00.000Z' } });
  check('Shuffled arrays + new volatile timestamps + new run time -> same bundle checksum', shuf.norm.snapshot.bundleSha256 === s.bundleSha256);
  const rerun = await sandboxPipeline({ previousManifest: JSON.parse(base.diff.manifestContent) });
  check('Re-run against previous manifest -> no changes, commit not needed', rerun.diff.diff.hasChanges === false && rerun.preview.wouldCommit === false && rerun.diff.commitGate.reasons.some((r) => r.startsWith('No configuration changes')));
  check('Re-run summary status NO_CHANGES', rerun.summary.summary.status === 'NO_CHANGES');

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const outRoot = path.join(OUT_DIR, base.cfg.git.snapshotRoot);
  for (const f of s.files) {
    fs.mkdirSync(path.dirname(path.join(outRoot, f.path)), { recursive: true });
    fs.writeFileSync(path.join(outRoot, f.path), f.content);
  }
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), base.diff.manifestContent);
  fs.writeFileSync(path.join(outRoot, 'SHA256SUMS'), s.sha256sums);
  fs.writeFileSync(path.join(OUT_DIR, 'dry-run-preview.json'), JSON.stringify(base.preview, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(base.summary, null, 2) + '\n');
  const sums = fs.readFileSync(path.join(outRoot, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const diskOk = sums.every((line) => {
    const [hash, rel] = line.split(/\s{2}/);
    return nodeCrypto.createHash('sha256').update(fs.readFileSync(path.join(outRoot, rel))).digest('hex') === hash;
  });
  check(`SHA256SUMS verifies every file written to ${path.relative(ROOT, outRoot)}/`, diskOk && sums.length === s.files.length);
  const manifestDisk = JSON.parse(fs.readFileSync(path.join(outRoot, 'manifest.json'), 'utf8'));
  check('Bundle checksum = sha256(SHA256SUMS)', nodeCrypto.createHash('sha256').update(fs.readFileSync(path.join(outRoot, 'SHA256SUMS'))).digest('hex') === manifestDisk.bundleSha256);

  // ------------------------------------------------------------ 8. diffing
  section('8. Versioned record-level diff');
  const mutated = clone(base.outputs['Load Synthetic Fixture'][0].raw);
  mutated.properties.deals.push({ name: 'renewal_risk_score', label: 'Renewal Risk Score', type: 'number', fieldType: 'number', groupName: 'revops_forecasting', description: 'Mock', displayOrder: 5, hubspotDefined: false, hidden: false, calculated: false, externalOptions: false, hasUniqueValue: false, formField: false, options: [], archived: false });
  mutated.properties.deals.find((p) => p.name === 'deal_tier').options.push({ label: 'Strategic', value: 'strategic', displayOrder: 3, hidden: false });
  mutated.pipelines.deals.find((p) => p.id === '99100001').stages.find((st) => st.id === '99100012').label = 'Renewal Escalated';
  mutated.workflows = mutated.workflows.filter((w) => w.id !== '990000103');
  delete mutated.propertyGroups.tickets;
  const prevManifest = JSON.parse(base.diff.manifestContent);
  const mut = await sandboxPipeline({ fixtureOverride: mutated, previousManifest: prevManifest, env: { SNAPSHOT_TIMESTAMP_OVERRIDE: '2026-11-18T02:15:00.000Z' } });
  const mod = Object.fromEntries(mut.diff.diff.modified.map((m) => [m.path, m]));
  check('properties/deals.json: renewal_risk_score added, deal_tier changed', mod['properties/deals.json'] && mod['properties/deals.json'].recordsAdded.join() === 'renewal_risk_score' && mod['properties/deals.json'].recordsChanged.join() === 'deal_tier');
  check('pipelines/deals.json: pipeline 99100001 changed', mod['pipelines/deals.json'] && mod['pipelines/deals.json'].recordsChanged.join() === '99100001');
  check('workflows/workflows.json: workflow 990000103 removed', mod['workflows/workflows.json'] && mod['workflows/workflows.json'].recordsRemoved.join() === '990000103');
  check('Missing property-groups/tickets.json reported but NOT pruned by default', mut.diff.diff.removed.some((r) => r.path === 'property-groups/tickets.json') && mut.diff.diff.pruneEffective === false);
  check('Exactly 3 files modified, 9 unchanged', mut.diff.diff.modified.length === 3 && mut.diff.diff.unchangedCount === 9, `${mut.diff.diff.modified.length} / ${mut.diff.diff.unchangedCount}`);
  const lineage = JSON.parse(mut.diff.manifestContent).lineage;
  check('Manifest lineage links to previous bundle checksum', lineage.previousBundleSha256 === s.bundleSha256 && lineage.previousSource === 'offline');
  check('Commit message lists record-level changes', mut.diff.commitMessage.includes('~ properties/deals.json | added: renewal_risk_score | changed: deal_tier') && mut.diff.commitMessage.includes('! property-groups/tickets.json'));

  // ------------------------------------------------ 9. live path (mocked)
  section('9. Live export path with mocked HubSpot responses (offline)');
  const live = await livePipeline();
  check('Export requests are GET-only and cover all scoped endpoints (12)', live.reqs.length === 12 && live.reqs.every((r) => r.method === 'GET'), String(live.reqs.length));
  check('Request URLs never embed the token', live.reqs.every((r) => SECRET_VALUES.every((v) => !r.url.includes(v))));
  check('Workflow v4 pages merged (4 workflows across 2 pages)', live.outputs['Assemble Raw Snapshot'][0].raw.workflows.length === 4);
  check('Live snapshot of the same data matches sandbox bundle checksum', live.outputs['Normalization & Checksum Auditor'][0].snapshot.bundleSha256 === s.bundleSha256);
  check('First live run (Git 404) treated as first run and gate opens', live.outputs['Versioned Diff Builder'][0].diff.previousSource === 'git-first-run' && live.tree !== null);

  const degraded = await livePipeline({ failKeys: ['properties:tickets'] });
  const dAudit = degraded.outputs['Normalization & Checksum Auditor'][0].audit;
  check('A failed endpoint yields DEGRADED health with the error recorded', dAudit.health === 'DEGRADED' && dAudit.endpointErrors[0].key === 'properties:tickets');
  check('DEGRADED blocks the commit by default', degraded.tree === null && degraded.outputs['Versioned Diff Builder'][0].commitGate.reasons.some((r) => r.includes('DEGRADED')));
  const degradedAllowed = await livePipeline({ env: { ...LIVE_ENV, GIT_COMMIT_ON_DEGRADED: 'true', GIT_PRUNE_REMOVED_FILES: 'true' }, failKeys: ['properties:tickets'], previousManifestResponse: { encoding: 'base64', content: Buffer.from(base.diff.manifestContent).toString('base64') } });
  check('GIT_COMMIT_ON_DEGRADED=true allows the commit but never prunes the failed file', degradedAllowed.tree === null
    ? degradedAllowed.outputs['Versioned Diff Builder'][0].commitGate.reasons.join() === 'No configuration changes since the previous snapshot' && degradedAllowed.outputs['Versioned Diff Builder'][0].diff.pruneEffective === false
    : degradedAllowed.tree.treeRequest.tree.every((e) => e.sha !== null));

  const optionalFail = await livePipeline({ failKeys: ['accountInfo'] });
  check('Unreadable account-info is a warning, not a failure', optionalFail.outputs['Normalization & Checksum Auditor'][0].audit.health === 'HEALTHY' && optionalFail.outputs['Collect & Verify API Responses'][0].warnings.some((w) => /Portal guard|accountInfo/.test(w)));
  const guard = await expectThrow(() => livePipeline({ portalOverride: 99000002 }), /Portal guard/);
  check('Portal guard stops a token from another portal', guard.threw && guard.matches, guard.message);
  const wfFail = await livePipeline({ workflowPages: [{ error: { message: '403 - Missing workflows-access-public-api' } }] });
  check('Workflows 403 recorded as endpoint error with scope hint', wfFail.outputs['Assemble Raw Snapshot'][0].endpointErrors.some((e) => e.key === 'workflows' && /automation/.test(e.hint)));
  const unreadable = await livePipeline({ previousManifestResponse: { error: { message: '500 - Internal Server Error' } } });
  check('Unreadable previous manifest (non-404) blocks a blind commit', unreadable.tree === null && unreadable.outputs['Versioned Diff Builder'][0].commitGate.reasons.some((r) => r.includes('blind diff')));

  // --------------------------------------------- 10. commit path (mocked)
  section('10. Git commit payload with mocked GitHub responses (offline)');
  const t = live.tree;
  const paths = t.treeRequest.tree.map((e) => e.path);
  const rootPrefix = `snapshots/portal-99000001/`;
  check('Tree based on branch head tree SHA, parent = head commit', t.treeRequest.base_tree === 'b'.repeat(40) && t.commitRequestBase.parents[0] === 'a'.repeat(40));
  check('Tree includes 13 snapshot files + manifest.json + SHA256SUMS', t.entryCount === 15 && paths.includes(rootPrefix + 'manifest.json') && paths.includes(rootPrefix + 'SHA256SUMS'));
  check('Every tree path is inside the portal snapshot root', paths.every((p) => p.startsWith(rootPrefix)));
  check('Every entry is a regular file blob with inline content', t.treeRequest.tree.every((e) => e.mode === '100644' && e.type === 'blob' && typeof e.content === 'string'));
  const contentHashOk = t.treeRequest.tree.filter((e) => !/manifest\.json$|SHA256SUMS$/.test(e.path)).every((e) => {
    const rel = e.path.slice(rootPrefix.length);
    return nodeCrypto.createHash('sha256').update(e.content).digest('hex') === live.outputs['Normalization & Checksum Auditor'][0].snapshot.files.find((f) => f.path === rel).sha256;
  });
  check('Committed blob contents hash to the audited SHA-256 values', contentHashOk);
  check('Commit author is the configured bot identity', t.commitRequestBase.author.email === 'snapshot-bot@example.invalid');
  const badHead = await expectThrow(() => livePipeline({ headCommit: { sha: 'nope' } }), /head commit/);
  check('Malformed GitHub head response aborts before any write', badHead.threw && badHead.matches);

  const prevLive = { encoding: 'base64', content: Buffer.from(base.diff.manifestContent).toString('base64') };
  const mutatedLiveEnv = { ...LIVE_ENV, GIT_PRUNE_REMOVED_FILES: 'true', EXPORT_OBJECT_TYPES: 'contacts,companies,deals' };
  const pruneRun = await livePipeline({ env: mutatedLiveEnv, previousManifestResponse: prevLive });
  const delEntries = pruneRun.tree ? pruneRun.tree.treeRequest.tree.filter((e) => e.sha === null).map((e) => e.path.slice(rootPrefix.length)) : [];
  check('GIT_PRUNE_REMOVED_FILES=true on a HEALTHY run deletes only the dropped files', JSON.stringify(delEntries.sort()) === JSON.stringify(['properties/tickets.json', 'property-groups/tickets.json']), delEntries.join(', '));
  const commitResult = await runNode('Commit Result', {
    input: [{ ref: 'refs/heads/hubspot-config-snapshots', object: { sha: 'c'.repeat(40) } }],
    outputs: { ...live.outputs, 'Git: Create Commit': [{ sha: 'c'.repeat(40) }] },
  });
  check('Commit Result builds a web URL from GIT_REPO_URL', commitResult[0].commit.url === `https://github.example/example-org/hubspot-config-backup/commit/${'c'.repeat(40)}`);
  const committedSummary = await runNode('RevOps Summary Builder', { input: commitResult, outputs: live.outputs });
  check('Committed summary status COMMITTED', committedSummary[0].summary.status === 'COMMITTED');
  const sumText = JSON.stringify(committedSummary);
  check('Summary / Slack payload never contains secret values', SECRET_VALUES.every((v) => !sumText.includes(v)));
  check('Summary / Slack payload never contains file contents', !sumText.includes('"fieldType"'));

  // -------------------------------------------------------------- report
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  console.log(`Snapshot bundle sha256: ${s.bundleSha256}`);
  console.log(`Output written to: ${path.relative(ROOT, OUT_DIR)}/ (git-ignored)`);
  if (failed) {
    console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nSimulator crashed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
