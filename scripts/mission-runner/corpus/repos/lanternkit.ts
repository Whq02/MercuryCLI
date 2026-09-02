// ============================================================================
//  corpus repo: lanternkit — the cross-platform CLI + update
//  journey pack (family 19). A field-kit ledger CLI with a
//  versioned payload update flow: the REAL producer writes what the REAL
//  reader consumes (the UPDATE-RELIABILITY drift law — no hand-written
//  samples). BASE (main) ships both mission seams stubbed; task/k1 gives
//  paths and asks for the journaled, resumable reader; task/k2 gives the
//  reader and asks for the path discipline. This module is CANONICAL.
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const FILES: FileMap = {
  '.gitignore': `node_modules/
.DS_Store
`,
  'README.md': "# lanternkit\n\nA small cross-platform CLI that keeps a field kit's ledger \u2014 items, counts,\nand a trip log \u2014 under a kit home directory, with a versioned payload\nupdate flow (producer + reader) for shipping kit-profile updates to the\nfield.\n\n## Layout\n\n```\nbin/lantern.mjs      argv dispatch (status \u00b7 add \u00b7 log \u00b7 update-check \u00b7 update-apply \u00b7 update-resume)\nsrc/paths.js         kit-home resolution + path discipline (flag > env > default)\nsrc/kit.js           the ledger: kit.json read/model/write\nsrc/output.js        human + --json result printing\nsrc/update/producer.js   builds a versioned payload from a profile dir (manifest + files + sha256)\nsrc/update/reader.js     verifies, stages, journals and applies a payload; resumes after interruption\ntest/                node --test suite\n```\n\n## The kit home\n\nResolution order: `--home <dir>` flag \u2192 `LANTERN_HOME` env \u2192 `.lantern/`\nunder the current working directory. Homes with spaces, parentheses and\naccented characters are first-class \u2014 field laptops are messy.\n\n## The update flow\n\nA payload directory is produced by `producer.js` (`manifest.json` with\nper-file sha256 + a `files/` tree). `lantern update-apply <payload>`\nverifies every checksum BEFORE writing anything, stages the files, then\nswaps them into the kit home under a journal; an interrupted swap resumes\nexactly (`lantern update-resume`) with no duplicated or lost effects.\n\n## Run\n\n```\nnode bin/lantern.mjs --home \"/tmp/field kit\" status\nnpm test\n```\n",
  'bin/lantern.mjs': `#!/usr/bin/env node
// lantern — the field-kit CLI. Thin argv dispatch over src/; all behaviour
// lives in the modules so the suite drives them directly.
import { resolveHome, kitPaths } from '../src/paths.js'
import { addItem, logNote, readKit, writeKit } from '../src/kit.js'
import { applyPayload, resumeApply } from '../src/update/reader.js'
import { fail, ok, printResult } from '../src/output.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const rest = args.filter(a => a !== '--json')

function flagOf(name) {
  const at = rest.indexOf(name)
  return at >= 0 ? rest[at + 1] : undefined
}

const command = rest.find(a => !a.startsWith('--') && a !== flagOf('--home'))

let result
try {
  const home = resolveHome({ flag: flagOf('--home'), env: process.env.LANTERN_HOME, cwd: process.cwd() })
  const paths = kitPaths(home)
  switch (command) {
    case 'status': {
      const kit = readKit(paths.kitFile)
      result = ok('status', kit.items.length + ' item kinds, ' + kit.log.length + ' log lines', { kit })
      break
    }
    case 'add': {
      const [, id, label, qty] = rest.filter(a => !a.startsWith('--') && a !== flagOf('--home'))
      const kit = addItem(readKit(paths.kitFile), id, label ?? id, Number(qty ?? 1))
      writeKit(paths.kitFile, kit)
      result = ok('add', id)
      break
    }
    case 'log': {
      const note = rest.slice(rest.indexOf('log') + 1).filter(a => !a.startsWith('--')).join(' ')
      const kit = logNote(readKit(paths.kitFile), note)
      writeKit(paths.kitFile, kit)
      result = ok('log', note)
      break
    }
    case 'update-apply':
      result = applyPayload(flagOf('--payload'), home, {})
      break
    case 'update-resume':
      result = resumeApply(home, flagOf('--payload'), {})
      break
    default:
      result = fail('usage', 'lantern [--home DIR] [--json] status|add|log|update-apply --payload DIR|update-resume')
  }
} catch (error) {
  result = fail(command ?? 'usage', error instanceof Error ? error.message : String(error))
}
printResult(result, { json })
process.exit(result.ok ? 0 : 1)
`,
  'package.json': `{
  "name": "lanternkit",
  "version": "0.3.0",
  "type": "module",
  "description": "A field-kit ledger CLI with a versioned self-update flow. Zero dependencies, cross-platform.",
  "bin": { "lantern": "bin/lantern.mjs" },
  "scripts": {
    "test": "node --test"
  }
}
`,
  'src/kit.js': "// The ledger: kit.json read/model/write. Deterministic by construction \u2014\n// log entries carry sequence numbers, never wall clocks (a caller may pass\n// a stamp; the CLI passes none).\nimport { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'\nimport { dirname } from 'node:path'\n\nexport const KIT_SCHEMA = 1\n\nexport function emptyKit(name = 'field kit') {\n  return { schema: KIT_SCHEMA, name, items: [], log: [], seq: 0 }\n}\n\nexport function readKit(kitFile) {\n  if (!existsSync(kitFile)) return emptyKit()\n  const parsed = JSON.parse(readFileSync(kitFile, 'utf8'))\n  if (parsed.schema !== KIT_SCHEMA) {\n    throw new Error('unsupported kit schema: ' + String(parsed.schema))\n  }\n  return parsed\n}\n\nexport function writeKit(kitFile, kit) {\n  mkdirSync(dirname(kitFile), { recursive: true })\n  writeFileSync(kitFile, JSON.stringify(kit, null, 2) + '\\n', 'utf8')\n}\n\nexport function addItem(kit, id, label, qty) {\n  const existing = kit.items.find(item => item.id === id)\n  if (existing) {\n    existing.qty += qty\n  } else {\n    kit.items.push({ id, label, qty })\n  }\n  kit.seq += 1\n  kit.log.push({ seq: kit.seq, note: 'add ' + id + ' x' + String(qty) })\n  return kit\n}\n\nexport function logNote(kit, note) {\n  kit.seq += 1\n  kit.log.push({ seq: kit.seq, note })\n  return kit\n}\n",
  'src/output.js': "// Result printing: one bounded human line per operation, or the full\n// machine-readable object under --json. The VERDICT is never buried \u2014 a\n// caller reading the last line always learns ok/refused and why.\nexport function printResult(result, { json = false } = {}) {\n  if (json) {\n    process.stdout.write(JSON.stringify(result) + '\\n')\n    return\n  }\n  const head = result.ok ? 'ok' : 'refused'\n  const parts = [head, result.op]\n  if (result.detail) parts.push(result.detail)\n  process.stdout.write(parts.join(' \u00b7 ') + '\\n')\n}\n\nexport function fail(op, detail) {\n  return { ok: false, op, detail }\n}\n\nexport function ok(op, detail, extra = {}) {\n  return { ok: true, op, detail, ...extra }\n}\n",
  'src/paths.js': `// Kit-home resolution + path discipline.
//
// MISSION SEAM (task/k2). The contract the tests pin:
//   - resolveHome({ flag, env, cwd }) returns an ABSOLUTE path with the
//     precedence: flag > env > join(cwd, '.lantern');
//   - a relative flag/env value resolves against cwd; '~' is NOT expanded
//     (explicit paths only — a field tool never guesses at home
//     directories);
//   - the returned path is used EXACTLY as given: no trimming, no case
//     folding, no unicode normalization, no separator rewriting beyond
//     node's own path.resolve — homes with spaces, parentheses and accented
//     characters round-trip byte-identically;
//   - kitPaths(home) derives { kitFile, stageDir, journalFile, backupDir }
//     via path.join on that home (never string concatenation);
//   - assertInsideHome(home, target) refuses (typed Error starting
//     'outside kit home:') any target whose resolved path escapes the home
//     — the guard the update reader relies on.
export function resolveHome(options) {
  // TODO(task/k2): implement per the contract above.
  void options
  throw new Error('not implemented: resolveHome')
}

export function kitPaths(home) {
  // TODO(task/k2): implement per the contract above.
  void home
  throw new Error('not implemented: kitPaths')
}

export function assertInsideHome(home, target) {
  // TODO(task/k2): implement per the contract above.
  void home
  void target
  throw new Error('not implemented: assertInsideHome')
}
`,
  'src/update/producer.js': "// Payload producer: builds a versioned update payload from a profile dir.\n// GIVEN and REAL \u2014 the reader in this repo consumes exactly what this\n// writes; tests must always exercise the pair together (a hand-written\n// sample payload can drift; this producer cannot).\nimport { createHash } from 'node:crypto'\nimport { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'\nimport { dirname, join, relative, sep } from 'node:path'\n\nexport const PAYLOAD_SCHEMA = 1\n\nfunction walk(dir) {\n  const out = []\n  for (const entry of readdirSync(dir).sort()) {\n    const full = join(dir, entry)\n    if (statSync(full).isDirectory()) {\n      out.push(...walk(full))\n    } else {\n      out.push(full)\n    }\n  }\n  return out\n}\n\nexport function buildPayload(profileDir, outDir, { version }) {\n  if (!version || !/^\\d+\\.\\d+\\.\\d+$/.test(version)) {\n    throw new Error('producer: version must be semver, got ' + String(version))\n  }\n  const files = []\n  for (const full of walk(profileDir)) {\n    // Manifest paths are ALWAYS posix-style relative paths.\n    const rel = relative(profileDir, full).split(sep).join('/')\n    const bytes = readFileSync(full)\n    files.push({\n      path: rel,\n      bytes: bytes.length,\n      sha256: createHash('sha256').update(bytes).digest('hex'),\n    })\n    const staged = join(outDir, 'files', rel)\n    mkdirSync(dirname(staged), { recursive: true })\n    writeFileSync(staged, bytes)\n  }\n  const manifest = { schema: PAYLOAD_SCHEMA, version, files }\n  mkdirSync(outDir, { recursive: true })\n  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\\n', 'utf8')\n  return manifest\n}\n",
  'src/update/reader.js': `// Payload reader: verify -> stage -> journaled swap -> done; resumable at
// every boundary.
//
// MISSION SEAM (task/k1). The contract the tests pin:
//   - applyPayload(payloadDir, home, opts) reads manifest.json:
//       unknown schema           -> typed refusal 'unsupported payload schema: N'
//       any sha256/bytes mismatch-> typed refusal 'checksum mismatch: <path>'
//                                   VERIFIED BEFORE ANY WRITE — a refused
//                                   apply leaves the home byte-identical;
//   - staging: verified files copy into kitPaths(home).stageDir/<version>/;
//     every target path is checked with assertInsideHome (a manifest path
//     that escapes the home refuses: 'outside kit home: <path>');
//   - the journal (kitPaths(home).journalFile) is written at every phase
//     boundary: { schema: 1, version, phase, steps } with phase one of
//     'staged' | 'swapping' | 'done'; during the swap each file gets a step
//     { path, state: 'pending' | 'backed-up' | 'placed' } updated as it
//     progresses (existing files back up into kitPaths(home).backupDir
//     before replacement);
//   - completion: phase 'done', stage + backups removed, journal retained;
//   - resumeApply(home, payloadDir): journal absent -> { ok: true, op:
//     'update-resume', detail: 'nothing to resume' }; phase 'staged' ->
//     run the swap; 'swapping' -> complete ONLY the steps not yet 'placed'
//     (already-placed files are NEVER re-copied — no duplicate effects);
//     'done' -> no-op; resuming twice is idempotent;
//   - fault injection FOR TESTS: opts.faultAfterJournalWrites = N makes the
//     N+1th journal write throw 'injected fault' — the deterministic
//     interruption the suite drives;
//   - every applied/refused outcome returns the src/output.js result shape.
export function applyPayload(payloadDir, home, opts = {}) {
  // TODO(task/k1): implement per the contract above.
  void payloadDir
  void home
  void opts
  throw new Error('not implemented: applyPayload')
}

export function resumeApply(home, payloadDir, opts = {}) {
  // TODO(task/k1): implement per the contract above.
  void home
  void payloadDir
  void opts
  throw new Error('not implemented: resumeApply')
}
`,
  'test/paths.test.mjs': "// Kit-home path discipline (src/paths.js mission seam).\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { execFileSync } from 'node:child_process'\nimport { mkdtempSync, mkdirSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { basename, isAbsolute, join, sep } from 'node:path'\nimport { resolveHome, kitPaths, assertInsideHome } from '../src/paths.js'\nimport { readKit, writeKit, addItem, emptyKit } from '../src/kit.js'\n\nconst MESSY = 'Caf\u00e9 kit (v2) \u2014 b\u00e9ta'\n\ntest('precedence: flag > env > default, always absolute', () => {\n  const cwd = mkdtempSync(join(tmpdir(), 'lantern-cwd-'))\n  const flagged = resolveHome({ flag: '/tmp/kit-a', env: '/tmp/kit-b', cwd })\n  assert.equal(flagged, join('/tmp', 'kit-a'))\n  const fromEnv = resolveHome({ flag: undefined, env: '/tmp/kit-b', cwd })\n  assert.equal(fromEnv, join('/tmp', 'kit-b'))\n  const fallback = resolveHome({ flag: undefined, env: undefined, cwd })\n  assert.equal(fallback, join(cwd, '.lantern'))\n  for (const p of [flagged, fromEnv, fallback]) assert.ok(isAbsolute(p))\n})\n\ntest('a relative flag resolves against cwd; the string is never massaged', () => {\n  const cwd = mkdtempSync(join(tmpdir(), 'lantern-cwd-'))\n  const rel = resolveHome({ flag: join('deep', MESSY), env: undefined, cwd })\n  assert.equal(rel, join(cwd, 'deep', MESSY))\n  assert.equal(basename(rel), MESSY, 'no trimming, folding or normalization')\n})\n\ntest('kitPaths derives every path via join under the home', () => {\n  const home = join('/tmp', MESSY)\n  const paths = kitPaths(home)\n  for (const p of Object.values(paths)) {\n    assert.ok(p.startsWith(home + sep), p + ' must live under the home')\n  }\n  assert.equal(basename(paths.kitFile), 'kit.json')\n})\n\ntest('a messy home round-trips the ledger byte-identically', () => {\n  const root = mkdtempSync(join(tmpdir(), 'lantern-messy-'))\n  const home = join(root, MESSY)\n  mkdirSync(home, { recursive: true })\n  const paths = kitPaths(home)\n  writeKit(paths.kitFile, addItem(emptyKit(), 'oil', 'lamp oil', 3))\n  const kit = readKit(paths.kitFile)\n  assert.equal(kit.items[0].qty, 3)\n})\n\ntest('assertInsideHome accepts children and refuses escapes with the typed error', () => {\n  const home = join('/tmp', MESSY)\n  assertInsideHome(home, 'profiles/ridge.json')\n  assertInsideHome(home, join(home, 'kit.json'))\n  assert.throws(() => assertInsideHome(home, '../evil'), /^Error: outside kit home:/)\n  assert.throws(() => assertInsideHome(home, '/etc/passwd'), /^Error: outside kit home:/)\n  assert.throws(() => assertInsideHome(home, 'a/../../evil'), /^Error: outside kit home:/)\n})\n\ntest('the CLI works end to end under a messy --home', () => {\n  const root = mkdtempSync(join(tmpdir(), 'lantern-cli-'))\n  const home = join(root, MESSY)\n  const bin = join(import.meta.dirname, '..', 'bin', 'lantern.mjs')\n  const run = args =>\n    JSON.parse(\n      execFileSync(process.execPath, [bin, '--home', home, '--json', ...args], { encoding: 'utf8' })\n        .trim()\n        .split('\\n')\n        .pop(),\n    )\n  const added = run(['add', 'wicks', 'spare-wicks', '5'])\n  assert.equal(added.ok, true)\n  const status = run(['status'])\n  assert.equal(status.ok, true)\n  assert.equal(status.kit.items[0].id, 'wicks')\n})\n",
  'test/producer.test.mjs': "// Producer laws \u2014 GIVEN and green from the start; the reader mission\n// consumes exactly what this writes.\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { createHash } from 'node:crypto'\nimport { buildPayload, PAYLOAD_SCHEMA } from '../src/update/producer.js'\n\nfunction profileFixture() {\n  const dir = mkdtempSync(join(tmpdir(), 'lantern-profile-'))\n  mkdirSync(join(dir, 'profiles'), { recursive: true })\n  writeFileSync(join(dir, 'profiles', 'ridge.json'), '{\"name\":\"ridge\",\"slots\":4}\\n')\n  writeFileSync(join(dir, 'profiles', 'marsh.json'), '{\"name\":\"marsh\",\"slots\":6}\\n')\n  writeFileSync(join(dir, 'CHECKLIST.md'), '# checklist\\n- oil\\n- wicks\\n')\n  return dir\n}\n\ntest('buildPayload writes a schema-1 manifest with exact sha256 rows', () => {\n  const profile = profileFixture()\n  const out = mkdtempSync(join(tmpdir(), 'lantern-payload-'))\n  const manifest = buildPayload(profile, out, { version: '1.2.0' })\n  assert.equal(manifest.schema, PAYLOAD_SCHEMA)\n  assert.equal(manifest.version, '1.2.0')\n  assert.equal(manifest.files.length, 3)\n  for (const row of manifest.files) {\n    const bytes = readFileSync(join(out, 'files', row.path))\n    assert.equal(bytes.length, row.bytes)\n    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256)\n    assert.ok(!row.path.includes('\\\\'), 'manifest paths are posix-style')\n  }\n  const committed = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))\n  assert.deepEqual(committed, manifest)\n})\n\ntest('the producer refuses a non-semver version', () => {\n  const profile = profileFixture()\n  const out = mkdtempSync(join(tmpdir(), 'lantern-payload-'))\n  assert.throws(() => buildPayload(profile, out, { version: 'latest' }), /version must be semver/)\n})\n",
  'test/reader.test.mjs': "// The update journey (src/update/reader.js mission seam): verify-before-\n// write, journaled swap, interruption resume with no duplicate effects.\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { createHash } from 'node:crypto'\nimport {\n  appendFileSync,\n  existsSync,\n  mkdirSync,\n  mkdtempSync,\n  readdirSync,\n  readFileSync,\n  statSync,\n  writeFileSync,\n} from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join, relative, sep } from 'node:path'\nimport { buildPayload } from '../src/update/producer.js'\nimport { applyPayload, resumeApply } from '../src/update/reader.js'\nimport { kitPaths } from '../src/paths.js'\n\nfunction treeDigest(dir) {\n  const rows = []\n  const walk = d => {\n    for (const entry of readdirSync(d).sort()) {\n      const full = join(d, entry)\n      if (statSync(full).isDirectory()) {\n        walk(full)\n      } else {\n        const rel = relative(dir, full).split(sep).join('/')\n        rows.push(rel + ':' + createHash('sha256').update(readFileSync(full)).digest('hex'))\n      }\n    }\n  }\n  walk(dir)\n  return rows.join('\\n')\n}\n\nfunction fixture() {\n  const root = mkdtempSync(join(tmpdir(), 'lantern-upd-'))\n  const profile = join(root, 'profile')\n  mkdirSync(join(profile, 'profiles'), { recursive: true })\n  writeFileSync(join(profile, 'profiles', 'ridge.json'), '{\"name\":\"ridge\",\"slots\":4}\\n')\n  writeFileSync(join(profile, 'profiles', 'marsh.json'), '{\"name\":\"marsh\",\"slots\":6}\\n')\n  writeFileSync(join(profile, 'CHECKLIST.md'), '# v2 checklist\\n- oil\\n- wicks\\n- flint\\n')\n  const payload = join(root, 'payload')\n  buildPayload(profile, payload, { version: '2.0.0' })\n  const home = join(root, 'field kit (main)')\n  mkdirSync(join(home, 'profiles'), { recursive: true })\n  // An older file the update must back up and replace, plus a bystander.\n  writeFileSync(join(home, 'CHECKLIST.md'), '# v1 checklist\\n- oil\\n')\n  writeFileSync(join(home, 'kit.json'), '{\"schema\":1,\"name\":\"field kit\",\"items\":[],\"log\":[],\"seq\":0}\\n')\n  return { root, profile, payload, home }\n}\n\ntest('a clean apply places every file, retains a done journal, cleans stage/backups', () => {\n  const { payload, home } = fixture()\n  const result = applyPayload(payload, home, {})\n  assert.equal(result.ok, true)\n  assert.equal(readFileSync(join(home, 'profiles', 'ridge.json'), 'utf8'), '{\"name\":\"ridge\",\"slots\":4}\\n')\n  assert.match(readFileSync(join(home, 'CHECKLIST.md'), 'utf8'), /flint/)\n  const paths = kitPaths(home)\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  assert.equal(journal.phase, 'done')\n  assert.equal(existsSync(paths.stageDir), false, 'stage removed')\n  assert.equal(existsSync(paths.backupDir), false, 'backups removed')\n  // The bystander survived.\n  assert.match(readFileSync(join(home, 'kit.json'), 'utf8'), /field kit/)\n})\n\ntest('a checksum mismatch refuses BEFORE any write \u2014 the home stays byte-identical', () => {\n  const { payload, home } = fixture()\n  writeFileSync(join(payload, 'files', 'profiles', 'ridge.json'), '{\"name\":\"tampered\"}\\n')\n  const before = treeDigest(home)\n  const result = applyPayload(payload, home, {})\n  assert.equal(result.ok, false)\n  assert.match(result.detail, /checksum mismatch: profiles\\/ridge\\.json/)\n  assert.equal(treeDigest(home), before, 'a refused apply writes NOTHING')\n})\n\ntest('a manifest path escaping the home refuses with the typed error', () => {\n  const { payload, home } = fixture()\n  const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'))\n  const evil = Buffer.from('pwned\\n')\n  mkdirSync(join(payload, 'files'), { recursive: true })\n  writeFileSync(join(payload, 'files', 'evil.txt'), evil)\n  manifest.files.push({\n    path: '../evil.txt',\n    bytes: evil.length,\n    sha256: createHash('sha256').update(evil).digest('hex'),\n  })\n  writeFileSync(join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\\n')\n  const before = treeDigest(home)\n  const result = applyPayload(payload, home, {})\n  assert.equal(result.ok, false)\n  assert.match(result.detail, /outside kit home/)\n  assert.equal(treeDigest(home), before)\n})\n\ntest('an unknown payload schema refuses', () => {\n  const { payload, home } = fixture()\n  const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'))\n  manifest.schema = 9\n  writeFileSync(join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\\n')\n  const result = applyPayload(payload, home, {})\n  assert.equal(result.ok, false)\n  assert.match(result.detail, /unsupported payload schema: 9/)\n})\n\ntest('interrupt at EVERY journal boundary, resume -> identical to the clean apply', () => {\n  // The golden end state.\n  const golden = fixture()\n  applyPayload(golden.payload, golden.home, {})\n  const goldenDigest = treeDigest(golden.home)\n\n  let interruptedRuns = 0\n  for (let fault = 1; fault <= 12; fault++) {\n    const { payload, home } = fixture()\n    let threw = false\n    try {\n      applyPayload(payload, home, { faultAfterJournalWrites: fault })\n    } catch (error) {\n      threw = /injected fault/.test(String(error))\n    }\n    if (!threw) {\n      // The fault budget outlived the whole apply \u2014 nothing to resume.\n      assert.equal(treeDigest(home), goldenDigest)\n      continue\n    }\n    interruptedRuns += 1\n    const resumed = resumeApply(home, payload, {})\n    assert.equal(resumed.ok, true, 'fault ' + fault + ': resume must succeed')\n    assert.equal(treeDigest(home), goldenDigest, 'fault ' + fault + ': resumed home == clean home')\n    // Resuming again is a no-op.\n    const again = resumeApply(home, payload, {})\n    assert.equal(again.ok, true)\n    assert.equal(treeDigest(home), goldenDigest)\n  }\n  assert.ok(interruptedRuns >= 2, 'the fault matrix must actually interrupt (' + interruptedRuns + ')')\n})\n\ntest('already-placed files are never re-copied on resume (no duplicate effects)', () => {\n  const golden = fixture()\n  applyPayload(golden.payload, golden.home, {})\n\n  let exercised = false\n  for (let fault = 1; fault <= 12 && !exercised; fault++) {\n    const { payload, home } = fixture()\n    try {\n      applyPayload(payload, home, { faultAfterJournalWrites: fault })\n    } catch {\n      const paths = kitPaths(home)\n      if (!existsSync(paths.journalFile)) continue\n      const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n      if (journal.phase !== 'swapping') continue\n      const placed = (journal.steps ?? []).filter(s => s.state === 'placed')\n      if (placed.length === 0) continue\n      exercised = true\n      // Scar a placed file; a compliant resume completes the REST only.\n      const scarred = join(home, ...placed[0].path.split('/'))\n      appendFileSync(scarred, '# field scar\\n')\n      const resumed = resumeApply(home, payload, {})\n      assert.equal(resumed.ok, true)\n      assert.match(\n        readFileSync(scarred, 'utf8'),\n        /# field scar/,\n        'resume must not re-copy already-placed files',\n      )\n    }\n  }\n  assert.ok(exercised, 'no fault point yielded a mid-swap journal with a placed step')\n})\n\ntest('resume with no journal is a typed no-op', () => {\n  const { payload, home } = fixture()\n  const result = resumeApply(home, payload, {})\n  assert.equal(result.ok, true)\n  assert.match(result.detail, /nothing to resume/)\n})\n",}

const K1_OVERLAY: BranchOverlay = {
  'src/paths.js': `// Kit-home resolution + path discipline. See test/paths.test.mjs for the
// pinned contract.
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveHome(options) {
  const { flag, env, cwd } = options
  const chosen = flag ?? env
  if (chosen) return resolve(cwd, chosen)
  return join(cwd, '.lantern')
}

export function kitPaths(home) {
  return {
    kitFile: join(home, 'kit.json'),
    stageDir: join(home, '.lantern-stage'),
    journalFile: join(home, '.lantern-journal.json'),
    backupDir: join(home, '.lantern-backup'),
  }
}

export function assertInsideHome(home, target) {
  const resolvedHome = resolve(home)
  const resolvedTarget = resolve(resolvedHome, target)
  const rel = relative(resolvedHome, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('outside kit home: ' + target)
  }
  return resolvedTarget
}
`,
}

const K2_OVERLAY: BranchOverlay = {
  'src/update/reader.js': "// Payload reader: verify -> stage -> journaled swap -> done; resumable at\n// every boundary. See test/reader.test.mjs for the pinned contract.\nimport { createHash } from 'node:crypto'\nimport {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  renameSync,\n  rmSync,\n  writeFileSync,\n} from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { assertInsideHome, kitPaths } from '../paths.js'\nimport { fail, ok } from '../output.js'\nimport { PAYLOAD_SCHEMA } from './producer.js'\n\nconst JOURNAL_SCHEMA = 1\n\nfunction journalWriter(journalFile, opts) {\n  const budget =\n    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity\n  let written = 0\n  return journal => {\n    if (written >= budget) throw new Error('injected fault (journal write ' + String(written + 1) + ')')\n    written += 1\n    mkdirSync(dirname(journalFile), { recursive: true })\n    writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\\n', 'utf8')\n  }\n}\n\nfunction readManifest(payloadDir) {\n  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))\n  if (manifest.schema !== PAYLOAD_SCHEMA) {\n    throw new Error('unsupported payload schema: ' + String(manifest.schema))\n  }\n  return manifest\n}\n\n// The swap engine both apply and resume drive: completes every step not yet\n// 'placed'; already-placed files are never touched again.\nfunction runSwap(journal, writeJournal, payloadDir, home, paths) {\n  journal.phase = 'swapping'\n  writeJournal(journal)\n  for (const step of journal.steps) {\n    if (step.state === 'placed') continue\n    const target = assertInsideHome(home, step.path.split('/').join('/'))\n    if (step.state === 'pending') {\n      if (existsSync(target)) {\n        const backup = join(paths.backupDir, ...step.path.split('/'))\n        mkdirSync(dirname(backup), { recursive: true })\n        copyFileSync(target, backup)\n      }\n      step.state = 'backed-up'\n      writeJournal(journal)\n    }\n    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))\n    if (existsSync(staged)) {\n      mkdirSync(dirname(target), { recursive: true })\n      renameSync(staged, target)\n    } else if (!existsSync(target)) {\n      throw new Error('swap step lost both staged and placed copies: ' + step.path)\n    }\n    // else: the rename landed but its journal write was interrupted \u2014 the\n    // file IS placed; recording that is all that remains.\n    step.state = 'placed'\n    writeJournal(journal)\n  }\n  journal.phase = 'done'\n  writeJournal(journal)\n  rmSync(paths.stageDir, { recursive: true, force: true })\n  rmSync(paths.backupDir, { recursive: true, force: true })\n}\n\nexport function applyPayload(payloadDir, home, opts = {}) {\n  const paths = kitPaths(home)\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  let manifest\n  try {\n    manifest = readManifest(payloadDir)\n  } catch (error) {\n    return fail('update-apply', error instanceof Error ? error.message : String(error))\n  }\n\n  // Verify EVERYTHING before any write into the home.\n  for (const row of manifest.files) {\n    try {\n      assertInsideHome(home, row.path)\n    } catch (error) {\n      return fail('update-apply', error instanceof Error ? error.message : String(error))\n    }\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)\n    const bytes = readFileSync(source)\n    const digest = createHash('sha256').update(bytes).digest('hex')\n    if (bytes.length !== row.bytes || digest !== row.sha256) {\n      return fail('update-apply', 'checksum mismatch: ' + row.path)\n    }\n  }\n\n  // Stage the verified files.\n  for (const row of manifest.files) {\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))\n    mkdirSync(dirname(staged), { recursive: true })\n    copyFileSync(source, staged)\n  }\n\n  const journal = {\n    schema: JOURNAL_SCHEMA,\n    version: manifest.version,\n    phase: 'staged',\n    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),\n  }\n  writeJournal(journal)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')\n}\n\nexport function resumeApply(home, payloadDir, opts = {}) {\n  const paths = kitPaths(home)\n  if (!existsSync(paths.journalFile)) {\n    return ok('update-resume', 'nothing to resume')\n  }\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  if (journal.schema !== JOURNAL_SCHEMA) {\n    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))\n  }\n  if (journal.phase === 'done') {\n    return ok('update-resume', 'already complete: ' + journal.version)\n  }\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-resume', journal.version + ' completed')\n}\n",
}

export const LANTERNKIT_REPO: HelixRepoSpec = {
  id: 'lanternkit',
  seed: 'inline',
  files: FILES,
  branches: { 'task/k1': K1_OVERLAY, 'task/k2': K2_OVERLAY },
}

/** LK1 reference: the journaled, resumable reader (proved green on the
 *  composed task/k1 state — including the interruption matrix that caught a
 *  real crash-window bug during authoring). */
export const LANTERNKIT_K1_REFERENCE: FileMap = {
  'src/update/reader.js': "// Payload reader: verify -> stage -> journaled swap -> done; resumable at\n// every boundary. See test/reader.test.mjs for the pinned contract.\nimport { createHash } from 'node:crypto'\nimport {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  renameSync,\n  rmSync,\n  writeFileSync,\n} from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { assertInsideHome, kitPaths } from '../paths.js'\nimport { fail, ok } from '../output.js'\nimport { PAYLOAD_SCHEMA } from './producer.js'\n\nconst JOURNAL_SCHEMA = 1\n\nfunction journalWriter(journalFile, opts) {\n  const budget =\n    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity\n  let written = 0\n  return journal => {\n    if (written >= budget) throw new Error('injected fault (journal write ' + String(written + 1) + ')')\n    written += 1\n    mkdirSync(dirname(journalFile), { recursive: true })\n    writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\\n', 'utf8')\n  }\n}\n\nfunction readManifest(payloadDir) {\n  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))\n  if (manifest.schema !== PAYLOAD_SCHEMA) {\n    throw new Error('unsupported payload schema: ' + String(manifest.schema))\n  }\n  return manifest\n}\n\n// The swap engine both apply and resume drive: completes every step not yet\n// 'placed'; already-placed files are never touched again.\nfunction runSwap(journal, writeJournal, payloadDir, home, paths) {\n  journal.phase = 'swapping'\n  writeJournal(journal)\n  for (const step of journal.steps) {\n    if (step.state === 'placed') continue\n    const target = assertInsideHome(home, step.path.split('/').join('/'))\n    if (step.state === 'pending') {\n      if (existsSync(target)) {\n        const backup = join(paths.backupDir, ...step.path.split('/'))\n        mkdirSync(dirname(backup), { recursive: true })\n        copyFileSync(target, backup)\n      }\n      step.state = 'backed-up'\n      writeJournal(journal)\n    }\n    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))\n    if (existsSync(staged)) {\n      mkdirSync(dirname(target), { recursive: true })\n      renameSync(staged, target)\n    } else if (!existsSync(target)) {\n      throw new Error('swap step lost both staged and placed copies: ' + step.path)\n    }\n    // else: the rename landed but its journal write was interrupted \u2014 the\n    // file IS placed; recording that is all that remains.\n    step.state = 'placed'\n    writeJournal(journal)\n  }\n  journal.phase = 'done'\n  writeJournal(journal)\n  rmSync(paths.stageDir, { recursive: true, force: true })\n  rmSync(paths.backupDir, { recursive: true, force: true })\n}\n\nexport function applyPayload(payloadDir, home, opts = {}) {\n  const paths = kitPaths(home)\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  let manifest\n  try {\n    manifest = readManifest(payloadDir)\n  } catch (error) {\n    return fail('update-apply', error instanceof Error ? error.message : String(error))\n  }\n\n  // Verify EVERYTHING before any write into the home.\n  for (const row of manifest.files) {\n    try {\n      assertInsideHome(home, row.path)\n    } catch (error) {\n      return fail('update-apply', error instanceof Error ? error.message : String(error))\n    }\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)\n    const bytes = readFileSync(source)\n    const digest = createHash('sha256').update(bytes).digest('hex')\n    if (bytes.length !== row.bytes || digest !== row.sha256) {\n      return fail('update-apply', 'checksum mismatch: ' + row.path)\n    }\n  }\n\n  // Stage the verified files.\n  for (const row of manifest.files) {\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))\n    mkdirSync(dirname(staged), { recursive: true })\n    copyFileSync(source, staged)\n  }\n\n  const journal = {\n    schema: JOURNAL_SCHEMA,\n    version: manifest.version,\n    phase: 'staged',\n    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),\n  }\n  writeJournal(journal)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')\n}\n\nexport function resumeApply(home, payloadDir, opts = {}) {\n  const paths = kitPaths(home)\n  if (!existsSync(paths.journalFile)) {\n    return ok('update-resume', 'nothing to resume')\n  }\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  if (journal.schema !== JOURNAL_SCHEMA) {\n    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))\n  }\n  if (journal.phase === 'done') {\n    return ok('update-resume', 'already complete: ' + journal.version)\n  }\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-resume', journal.version + ' completed')\n}\n",
}

/** LK2 reference: the path discipline (proved green on task/k2). */
export const LANTERNKIT_K2_REFERENCE: FileMap = {
  'src/paths.js': `// Kit-home resolution + path discipline. See test/paths.test.mjs for the
// pinned contract.
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveHome(options) {
  const { flag, env, cwd } = options
  const chosen = flag ?? env
  if (chosen) return resolve(cwd, chosen)
  return join(cwd, '.lantern')
}

export function kitPaths(home) {
  return {
    kitFile: join(home, 'kit.json'),
    stageDir: join(home, '.lantern-stage'),
    journalFile: join(home, '.lantern-journal.json'),
    backupDir: join(home, '.lantern-backup'),
  }
}

export function assertInsideHome(home, target) {
  const resolvedHome = resolve(home)
  const resolvedTarget = resolve(resolvedHome, target)
  const rel = relative(resolvedHome, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('outside kit home: ' + target)
  }
  return resolvedTarget
}
`,
}

export const LANTERNKIT_K1_FALSIFY: Array<{ name: string; files: FileMap }> = [
  { name: 'stage-before-verify', files: { 'src/update/reader.js': "// Payload reader: verify -> stage -> journaled swap -> done; resumable at\n// every boundary. See test/reader.test.mjs for the pinned contract.\nimport { createHash } from 'node:crypto'\nimport {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  renameSync,\n  rmSync,\n  writeFileSync,\n} from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { assertInsideHome, kitPaths } from '../paths.js'\nimport { fail, ok } from '../output.js'\nimport { PAYLOAD_SCHEMA } from './producer.js'\n\nconst JOURNAL_SCHEMA = 1\n\nfunction journalWriter(journalFile, opts) {\n  const budget =\n    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity\n  let written = 0\n  return journal => {\n    if (written >= budget) throw new Error('injected fault (journal write ' + String(written + 1) + ')')\n    written += 1\n    mkdirSync(dirname(journalFile), { recursive: true })\n    writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\\n', 'utf8')\n  }\n}\n\nfunction readManifest(payloadDir) {\n  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))\n  if (manifest.schema !== PAYLOAD_SCHEMA) {\n    throw new Error('unsupported payload schema: ' + String(manifest.schema))\n  }\n  return manifest\n}\n\n// The swap engine both apply and resume drive: completes every step not yet\n// 'placed'; already-placed files are never touched again.\nfunction runSwap(journal, writeJournal, payloadDir, home, paths) {\n  journal.phase = 'swapping'\n  writeJournal(journal)\n  for (const step of journal.steps) {\n    if (step.state === 'placed') continue\n    const target = assertInsideHome(home, step.path.split('/').join('/'))\n    if (step.state === 'pending') {\n      if (existsSync(target)) {\n        const backup = join(paths.backupDir, ...step.path.split('/'))\n        mkdirSync(dirname(backup), { recursive: true })\n        copyFileSync(target, backup)\n      }\n      step.state = 'backed-up'\n      writeJournal(journal)\n    }\n    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))\n    if (existsSync(staged)) {\n      mkdirSync(dirname(target), { recursive: true })\n      renameSync(staged, target)\n    } else if (!existsSync(target)) {\n      throw new Error('swap step lost both staged and placed copies: ' + step.path)\n    }\n    // else: the rename landed but its journal write was interrupted \u2014 the\n    // file IS placed; recording that is all that remains.\n    step.state = 'placed'\n    writeJournal(journal)\n  }\n  journal.phase = 'done'\n  writeJournal(journal)\n  rmSync(paths.stageDir, { recursive: true, force: true })\n  rmSync(paths.backupDir, { recursive: true, force: true })\n}\n\nexport function applyPayload(payloadDir, home, opts = {}) {\n  const paths = kitPaths(home)\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  let manifest\n  try {\n    manifest = readManifest(payloadDir)\n  } catch (error) {\n    return fail('update-apply', error instanceof Error ? error.message : String(error))\n  }\n\n  // Stage eagerly, verifying as we go.\n  for (const row of manifest.files) {\n    try {\n      assertInsideHome(home, row.path)\n    } catch (error) {\n      return fail('update-apply', error instanceof Error ? error.message : String(error))\n    }\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)\n    const bytes = readFileSync(source)\n    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))\n    mkdirSync(dirname(staged), { recursive: true })\n    copyFileSync(source, staged)\n    const digest = createHash('sha256').update(bytes).digest('hex')\n    if (bytes.length !== row.bytes || digest !== row.sha256) {\n      return fail('update-apply', 'checksum mismatch: ' + row.path)\n    }\n  }\n\n  const journal = {\n    schema: JOURNAL_SCHEMA,\n    version: manifest.version,\n    phase: 'staged',\n    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),\n  }\n  writeJournal(journal)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')\n}\n\nexport function resumeApply(home, payloadDir, opts = {}) {\n  const paths = kitPaths(home)\n  if (!existsSync(paths.journalFile)) {\n    return ok('update-resume', 'nothing to resume')\n  }\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  if (journal.schema !== JOURNAL_SCHEMA) {\n    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))\n  }\n  if (journal.phase === 'done') {\n    return ok('update-resume', 'already complete: ' + journal.version)\n  }\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-resume', journal.version + ' completed')\n}\n" } },
  { name: 'journal-less', files: { 'src/update/reader.js': `// Payload reader: verify -> stage -> journaled swap -> done; resumable at
// every boundary. See test/reader.test.mjs for the pinned contract.
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { assertInsideHome, kitPaths } from '../paths.js'
import { fail, ok } from '../output.js'
import { PAYLOAD_SCHEMA } from './producer.js'

const JOURNAL_SCHEMA = 1

function journalWriter(journalFile, opts) {
  const budget =
    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity
  let written = 0
  return journal => {
    // Journals proved noisy in the field; state lives in the tree itself.
    void journal
    void written
    void budget
    void journalFile
  }
}

function readManifest(payloadDir) {
  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))
  if (manifest.schema !== PAYLOAD_SCHEMA) {
    throw new Error('unsupported payload schema: ' + String(manifest.schema))
  }
  return manifest
}

// The swap engine both apply and resume drive: completes every step not yet
// 'placed'; already-placed files are never touched again.
function runSwap(journal, writeJournal, payloadDir, home, paths) {
  journal.phase = 'swapping'
  writeJournal(journal)
  for (const step of journal.steps) {
    if (step.state === 'placed') continue
    const target = assertInsideHome(home, step.path.split('/').join('/'))
    if (step.state === 'pending') {
      if (existsSync(target)) {
        const backup = join(paths.backupDir, ...step.path.split('/'))
        mkdirSync(dirname(backup), { recursive: true })
        copyFileSync(target, backup)
      }
      step.state = 'backed-up'
      writeJournal(journal)
    }
    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))
    if (existsSync(staged)) {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(staged, target)
    } else if (!existsSync(target)) {
      throw new Error('swap step lost both staged and placed copies: ' + step.path)
    }
    // else: the rename landed but its journal write was interrupted — the
    // file IS placed; recording that is all that remains.
    step.state = 'placed'
    writeJournal(journal)
  }
  journal.phase = 'done'
  writeJournal(journal)
  rmSync(paths.stageDir, { recursive: true, force: true })
  rmSync(paths.backupDir, { recursive: true, force: true })
}

export function applyPayload(payloadDir, home, opts = {}) {
  const paths = kitPaths(home)
  const writeJournal = journalWriter(paths.journalFile, opts)
  let manifest
  try {
    manifest = readManifest(payloadDir)
  } catch (error) {
    return fail('update-apply', error instanceof Error ? error.message : String(error))
  }

  // Verify EVERYTHING before any write into the home.
  for (const row of manifest.files) {
    try {
      assertInsideHome(home, row.path)
    } catch (error) {
      return fail('update-apply', error instanceof Error ? error.message : String(error))
    }
    const source = join(payloadDir, 'files', ...row.path.split('/'))
    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)
    const bytes = readFileSync(source)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== row.bytes || digest !== row.sha256) {
      return fail('update-apply', 'checksum mismatch: ' + row.path)
    }
  }

  // Stage the verified files.
  for (const row of manifest.files) {
    const source = join(payloadDir, 'files', ...row.path.split('/'))
    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))
    mkdirSync(dirname(staged), { recursive: true })
    copyFileSync(source, staged)
  }

  const journal = {
    schema: JOURNAL_SCHEMA,
    version: manifest.version,
    phase: 'staged',
    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),
  }
  writeJournal(journal)
  runSwap(journal, writeJournal, payloadDir, home, paths)
  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')
}

export function resumeApply(home, payloadDir, opts = {}) {
  const paths = kitPaths(home)
  if (!existsSync(paths.journalFile)) {
    return ok('update-resume', 'nothing to resume')
  }
  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))
  if (journal.schema !== JOURNAL_SCHEMA) {
    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))
  }
  if (journal.phase === 'done') {
    return ok('update-resume', 'already complete: ' + journal.version)
  }
  const writeJournal = journalWriter(paths.journalFile, opts)
  runSwap(journal, writeJournal, payloadDir, home, paths)
  return ok('update-resume', journal.version + ' completed')
}
` } },
  { name: 'copy-swap-recopy', files: { 'src/update/reader.js': "// Payload reader: verify -> stage -> journaled swap -> done; resumable at\n// every boundary. See test/reader.test.mjs for the pinned contract.\nimport { createHash } from 'node:crypto'\nimport {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  renameSync,\n  rmSync,\n  writeFileSync,\n} from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { assertInsideHome, kitPaths } from '../paths.js'\nimport { fail, ok } from '../output.js'\nimport { PAYLOAD_SCHEMA } from './producer.js'\n\nconst JOURNAL_SCHEMA = 1\n\nfunction journalWriter(journalFile, opts) {\n  const budget =\n    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity\n  let written = 0\n  return journal => {\n    if (written >= budget) throw new Error('injected fault (journal write ' + String(written + 1) + ')')\n    written += 1\n    mkdirSync(dirname(journalFile), { recursive: true })\n    writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\\n', 'utf8')\n  }\n}\n\nfunction readManifest(payloadDir) {\n  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))\n  if (manifest.schema !== PAYLOAD_SCHEMA) {\n    throw new Error('unsupported payload schema: ' + String(manifest.schema))\n  }\n  return manifest\n}\n\n// The swap engine both apply and resume drive: completes every step not yet\n// 'placed'; already-placed files are never touched again.\nfunction runSwap(journal, writeJournal, payloadDir, home, paths) {\n  journal.phase = 'swapping'\n  writeJournal(journal)\n  for (const step of journal.steps) {\n    if (step.state === 'placed') continue\n    const target = assertInsideHome(home, step.path.split('/').join('/'))\n    if (step.state === 'pending') {\n      if (existsSync(target)) {\n        const backup = join(paths.backupDir, ...step.path.split('/'))\n        mkdirSync(dirname(backup), { recursive: true })\n        copyFileSync(target, backup)\n      }\n      step.state = 'backed-up'\n      writeJournal(journal)\n    }\n    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))\n    if (existsSync(staged)) {\n      mkdirSync(dirname(target), { recursive: true })\n      copyFileSync(staged, target)\n    } else if (!existsSync(target)) {\n      throw new Error('swap step lost both staged and placed copies: ' + step.path)\n    }\n    // else: the rename landed but its journal write was interrupted \u2014 the\n    // file IS placed; recording that is all that remains.\n    step.state = 'placed'\n    writeJournal(journal)\n  }\n  journal.phase = 'done'\n  writeJournal(journal)\n  rmSync(paths.stageDir, { recursive: true, force: true })\n  rmSync(paths.backupDir, { recursive: true, force: true })\n}\n\nexport function applyPayload(payloadDir, home, opts = {}) {\n  const paths = kitPaths(home)\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  let manifest\n  try {\n    manifest = readManifest(payloadDir)\n  } catch (error) {\n    return fail('update-apply', error instanceof Error ? error.message : String(error))\n  }\n\n  // Verify EVERYTHING before any write into the home.\n  for (const row of manifest.files) {\n    try {\n      assertInsideHome(home, row.path)\n    } catch (error) {\n      return fail('update-apply', error instanceof Error ? error.message : String(error))\n    }\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)\n    const bytes = readFileSync(source)\n    const digest = createHash('sha256').update(bytes).digest('hex')\n    if (bytes.length !== row.bytes || digest !== row.sha256) {\n      return fail('update-apply', 'checksum mismatch: ' + row.path)\n    }\n  }\n\n  // Stage the verified files.\n  for (const row of manifest.files) {\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))\n    mkdirSync(dirname(staged), { recursive: true })\n    copyFileSync(source, staged)\n  }\n\n  const journal = {\n    schema: JOURNAL_SCHEMA,\n    version: manifest.version,\n    phase: 'staged',\n    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),\n  }\n  writeJournal(journal)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')\n}\n\nexport function resumeApply(home, payloadDir, opts = {}) {\n  const paths = kitPaths(home)\n  if (!existsSync(paths.journalFile)) {\n    return ok('update-resume', 'nothing to resume')\n  }\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  if (journal.schema !== JOURNAL_SCHEMA) {\n    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))\n  }\n  if (journal.phase === 'done') {\n    return ok('update-resume', 'already complete: ' + journal.version)\n  }\n  // Simplest correctness: restart the whole swap from scratch.\n  for (const step of journal.steps) step.state = 'pending'\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-resume', journal.version + ' completed')\n}\n" } },
  { name: 'schema-blind', files: { 'src/update/reader.js': "// Payload reader: verify -> stage -> journaled swap -> done; resumable at\n// every boundary. See test/reader.test.mjs for the pinned contract.\nimport { createHash } from 'node:crypto'\nimport {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  renameSync,\n  rmSync,\n  writeFileSync,\n} from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { assertInsideHome, kitPaths } from '../paths.js'\nimport { fail, ok } from '../output.js'\nimport { PAYLOAD_SCHEMA } from './producer.js'\n\nconst JOURNAL_SCHEMA = 1\n\nfunction journalWriter(journalFile, opts) {\n  const budget =\n    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity\n  let written = 0\n  return journal => {\n    if (written >= budget) throw new Error('injected fault (journal write ' + String(written + 1) + ')')\n    written += 1\n    mkdirSync(dirname(journalFile), { recursive: true })\n    writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\\n', 'utf8')\n  }\n}\n\nfunction readManifest(payloadDir) {\n  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))\n  void PAYLOAD_SCHEMA\n  return manifest\n}\n\n// The swap engine both apply and resume drive: completes every step not yet\n// 'placed'; already-placed files are never touched again.\nfunction runSwap(journal, writeJournal, payloadDir, home, paths) {\n  journal.phase = 'swapping'\n  writeJournal(journal)\n  for (const step of journal.steps) {\n    if (step.state === 'placed') continue\n    const target = assertInsideHome(home, step.path.split('/').join('/'))\n    if (step.state === 'pending') {\n      if (existsSync(target)) {\n        const backup = join(paths.backupDir, ...step.path.split('/'))\n        mkdirSync(dirname(backup), { recursive: true })\n        copyFileSync(target, backup)\n      }\n      step.state = 'backed-up'\n      writeJournal(journal)\n    }\n    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))\n    if (existsSync(staged)) {\n      mkdirSync(dirname(target), { recursive: true })\n      renameSync(staged, target)\n    } else if (!existsSync(target)) {\n      throw new Error('swap step lost both staged and placed copies: ' + step.path)\n    }\n    // else: the rename landed but its journal write was interrupted \u2014 the\n    // file IS placed; recording that is all that remains.\n    step.state = 'placed'\n    writeJournal(journal)\n  }\n  journal.phase = 'done'\n  writeJournal(journal)\n  rmSync(paths.stageDir, { recursive: true, force: true })\n  rmSync(paths.backupDir, { recursive: true, force: true })\n}\n\nexport function applyPayload(payloadDir, home, opts = {}) {\n  const paths = kitPaths(home)\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  let manifest\n  try {\n    manifest = readManifest(payloadDir)\n  } catch (error) {\n    return fail('update-apply', error instanceof Error ? error.message : String(error))\n  }\n\n  // Verify EVERYTHING before any write into the home.\n  for (const row of manifest.files) {\n    try {\n      assertInsideHome(home, row.path)\n    } catch (error) {\n      return fail('update-apply', error instanceof Error ? error.message : String(error))\n    }\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)\n    const bytes = readFileSync(source)\n    const digest = createHash('sha256').update(bytes).digest('hex')\n    if (bytes.length !== row.bytes || digest !== row.sha256) {\n      return fail('update-apply', 'checksum mismatch: ' + row.path)\n    }\n  }\n\n  // Stage the verified files.\n  for (const row of manifest.files) {\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))\n    mkdirSync(dirname(staged), { recursive: true })\n    copyFileSync(source, staged)\n  }\n\n  const journal = {\n    schema: JOURNAL_SCHEMA,\n    version: manifest.version,\n    phase: 'staged',\n    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),\n  }\n  writeJournal(journal)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')\n}\n\nexport function resumeApply(home, payloadDir, opts = {}) {\n  const paths = kitPaths(home)\n  if (!existsSync(paths.journalFile)) {\n    return ok('update-resume', 'nothing to resume')\n  }\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  if (journal.schema !== JOURNAL_SCHEMA) {\n    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))\n  }\n  if (journal.phase === 'done') {\n    return ok('update-resume', 'already complete: ' + journal.version)\n  }\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-resume', journal.version + ' completed')\n}\n" } },
  { name: 'escape-blind', files: { 'src/update/reader.js': "// Payload reader: verify -> stage -> journaled swap -> done; resumable at\n// every boundary. See test/reader.test.mjs for the pinned contract.\nimport { createHash } from 'node:crypto'\nimport {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  readFileSync,\n  renameSync,\n  rmSync,\n  writeFileSync,\n} from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { assertInsideHome, kitPaths } from '../paths.js'\nimport { fail, ok } from '../output.js'\nimport { PAYLOAD_SCHEMA } from './producer.js'\n\nconst JOURNAL_SCHEMA = 1\n\nfunction journalWriter(journalFile, opts) {\n  const budget =\n    typeof opts.faultAfterJournalWrites === 'number' ? opts.faultAfterJournalWrites : Infinity\n  let written = 0\n  return journal => {\n    if (written >= budget) throw new Error('injected fault (journal write ' + String(written + 1) + ')')\n    written += 1\n    mkdirSync(dirname(journalFile), { recursive: true })\n    writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\\n', 'utf8')\n  }\n}\n\nfunction readManifest(payloadDir) {\n  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'))\n  if (manifest.schema !== PAYLOAD_SCHEMA) {\n    throw new Error('unsupported payload schema: ' + String(manifest.schema))\n  }\n  return manifest\n}\n\n// The swap engine both apply and resume drive: completes every step not yet\n// 'placed'; already-placed files are never touched again.\nfunction runSwap(journal, writeJournal, payloadDir, home, paths) {\n  journal.phase = 'swapping'\n  writeJournal(journal)\n  for (const step of journal.steps) {\n    if (step.state === 'placed') continue\n    const target = assertInsideHome(home, step.path.split('/').join('/'))\n    if (step.state === 'pending') {\n      if (existsSync(target)) {\n        const backup = join(paths.backupDir, ...step.path.split('/'))\n        mkdirSync(dirname(backup), { recursive: true })\n        copyFileSync(target, backup)\n      }\n      step.state = 'backed-up'\n      writeJournal(journal)\n    }\n    const staged = join(paths.stageDir, journal.version, ...step.path.split('/'))\n    if (existsSync(staged)) {\n      mkdirSync(dirname(target), { recursive: true })\n      renameSync(staged, target)\n    } else if (!existsSync(target)) {\n      throw new Error('swap step lost both staged and placed copies: ' + step.path)\n    }\n    // else: the rename landed but its journal write was interrupted \u2014 the\n    // file IS placed; recording that is all that remains.\n    step.state = 'placed'\n    writeJournal(journal)\n  }\n  journal.phase = 'done'\n  writeJournal(journal)\n  rmSync(paths.stageDir, { recursive: true, force: true })\n  rmSync(paths.backupDir, { recursive: true, force: true })\n}\n\nexport function applyPayload(payloadDir, home, opts = {}) {\n  const paths = kitPaths(home)\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  let manifest\n  try {\n    manifest = readManifest(payloadDir)\n  } catch (error) {\n    return fail('update-apply', error instanceof Error ? error.message : String(error))\n  }\n\n  // Verify EVERYTHING before any write into the home.\n  for (const row of manifest.files) {\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    if (!existsSync(source)) return fail('update-apply', 'checksum mismatch: ' + row.path)\n    const bytes = readFileSync(source)\n    const digest = createHash('sha256').update(bytes).digest('hex')\n    if (bytes.length !== row.bytes || digest !== row.sha256) {\n      return fail('update-apply', 'checksum mismatch: ' + row.path)\n    }\n  }\n\n  // Stage the verified files.\n  for (const row of manifest.files) {\n    const source = join(payloadDir, 'files', ...row.path.split('/'))\n    const staged = join(paths.stageDir, manifest.version, ...row.path.split('/'))\n    mkdirSync(dirname(staged), { recursive: true })\n    copyFileSync(source, staged)\n  }\n\n  const journal = {\n    schema: JOURNAL_SCHEMA,\n    version: manifest.version,\n    phase: 'staged',\n    steps: manifest.files.map(row => ({ path: row.path, state: 'pending' })),\n  }\n  writeJournal(journal)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-apply', manifest.version + ' (' + String(manifest.files.length) + ' files)')\n}\n\nexport function resumeApply(home, payloadDir, opts = {}) {\n  const paths = kitPaths(home)\n  if (!existsSync(paths.journalFile)) {\n    return ok('update-resume', 'nothing to resume')\n  }\n  const journal = JSON.parse(readFileSync(paths.journalFile, 'utf8'))\n  if (journal.schema !== JOURNAL_SCHEMA) {\n    return fail('update-resume', 'unsupported journal schema: ' + String(journal.schema))\n  }\n  if (journal.phase === 'done') {\n    return ok('update-resume', 'already complete: ' + journal.version)\n  }\n  const writeJournal = journalWriter(paths.journalFile, opts)\n  runSwap(journal, writeJournal, payloadDir, home, paths)\n  return ok('update-resume', journal.version + ' completed')\n}\n" } },
]

export const LANTERNKIT_K2_FALSIFY: Array<{ name: string; files: FileMap }> = [
  { name: 'env-over-flag', files: { 'src/paths.js': `// Kit-home resolution + path discipline. See test/paths.test.mjs for the
// pinned contract.
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveHome(options) {
  const { flag, env, cwd } = options
  const chosen = env ?? flag
  if (chosen) return resolve(cwd, chosen)
  return join(cwd, '.lantern')
}

export function kitPaths(home) {
  return {
    kitFile: join(home, 'kit.json'),
    stageDir: join(home, '.lantern-stage'),
    journalFile: join(home, '.lantern-journal.json'),
    backupDir: join(home, '.lantern-backup'),
  }
}

export function assertInsideHome(home, target) {
  const resolvedHome = resolve(home)
  const resolvedTarget = resolve(resolvedHome, target)
  const rel = relative(resolvedHome, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('outside kit home: ' + target)
  }
  return resolvedTarget
}
` } },
  { name: 'unicode-fold', files: { 'src/paths.js': `// Kit-home resolution + path discipline. See test/paths.test.mjs for the
// pinned contract.
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveHome(options) {
  const { flag, env, cwd } = options
  const chosen = flag ?? env
  if (chosen) return resolve(cwd, chosen.normalize('NFD'))
  return join(cwd, '.lantern')
}

export function kitPaths(home) {
  return {
    kitFile: join(home, 'kit.json'),
    stageDir: join(home, '.lantern-stage'),
    journalFile: join(home, '.lantern-journal.json'),
    backupDir: join(home, '.lantern-backup'),
  }
}

export function assertInsideHome(home, target) {
  const resolvedHome = resolve(home)
  const resolvedTarget = resolve(resolvedHome, target)
  const rel = relative(resolvedHome, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('outside kit home: ' + target)
  }
  return resolvedTarget
}
` } },
  { name: 'cwd-default-relative', files: { 'src/paths.js': `// Kit-home resolution + path discipline. See test/paths.test.mjs for the
// pinned contract.
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveHome(options) {
  const { flag, env, cwd } = options
  const chosen = flag ?? env
  if (chosen) return resolve(cwd, chosen)
  return '.lantern'
}

export function kitPaths(home) {
  return {
    kitFile: join(home, 'kit.json'),
    stageDir: join(home, '.lantern-stage'),
    journalFile: join(home, '.lantern-journal.json'),
    backupDir: join(home, '.lantern-backup'),
  }
}

export function assertInsideHome(home, target) {
  const resolvedHome = resolve(home)
  const resolvedTarget = resolve(resolvedHome, target)
  const rel = relative(resolvedHome, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('outside kit home: ' + target)
  }
  return resolvedTarget
}
` } },
  { name: 'dotdot-only-guard', files: { 'src/paths.js': `// Kit-home resolution + path discipline. See test/paths.test.mjs for the
// pinned contract.
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveHome(options) {
  const { flag, env, cwd } = options
  const chosen = flag ?? env
  if (chosen) return resolve(cwd, chosen)
  return join(cwd, '.lantern')
}

export function kitPaths(home) {
  return {
    kitFile: join(home, 'kit.json'),
    stageDir: join(home, '.lantern-stage'),
    journalFile: join(home, '.lantern-journal.json'),
    backupDir: join(home, '.lantern-backup'),
  }
}

export function assertInsideHome(home, target) {
  if (String(target).includes('..')) {
    throw new Error('outside kit home: ' + target)
  }
  return resolve(resolve(home), target)
}
` } },
]
