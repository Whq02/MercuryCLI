#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-session-kit.ts — THE KIT'S MEMORY (ledger L24
// (1)–(5) + L24(6-SUPERSEDED)): the per-session record,
//  its one writer, the birth-facts carrier and the per-repo menu store,
//  pinned at their seams, poison-first.
//
//   W  THE WORKSPACE-KEYED READ/WRITE: the menu store answers (and writes)
//      an EXPLICIT foreign workspace's slice; POISON = the process-cwd-
//      memoized key answering the daemon's (or the boot face's) own cwd.
//      A slice with no kit fields = the empty deltas (everything on); 'on'
//      is the store's ABSENCE and is never written out; the MCP half renders
//      through the disabled semantics, never the raw lists.
//
//  Later sections land with their commits: A additive law (absent ≠ empty)
//  · M malformed refuses typed · R re-stamp · O one writer · S set-kit
//  materializes · C carry (never `kit: null`) · D derivation · H membership
//  handoff · N no world check.
//
//  cpu-pure: record fixtures, the config store in a scratch home, pure
//  seams, a scripted roster that never spawns. Never a daemon, a PTY, or a
//  Mercury boot. The admit-driven pins set DEEPSEEK_API_KEY to the literal
//  'fixture-not-a-key' — a NON-KEY SENTINEL, never a credential: the
//  admit's model validator asks the presence owner whether a family HOLDS
//  a key (existence, never validity) and nothing here ever calls a provider;
//  no sweep may read that value as a credential.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Real paths throughout: macOS's tmpdir is a symlink (/var → /private/var)
// and process.cwd() answers the real spelling — the keys under test must be
// compared like with like (the workspace door realpaths on its own; the
// fixture's cwd-side expectations need the real spelling too).
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'session-kit-')))
const SYMLINKED_TMP = tmpdir()
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// Every store this prover touches lives in scratch — pinned BEFORE any src
// import so a missed dir default can never reach the real home.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
// THIS process's project (the boot cwd — a scratch NON-git folder, so the
// process key is the folder itself) vs a FOREIGN workspace it never cd's to.
const HERE = join(SCRATCH, 'here')
const THERE = join(SCRATCH, 'there')
const REPO = join(SCRATCH, 'repo')
for (const d of [HERE, THERE, join(REPO, 'sub')]) mkdirSync(d, { recursive: true })
process.chdir(HERE)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// M18/S12 re-anchor (the W3/B12/C6 class): the daemon-wire re-registration
// bumped the proto lawfully; these verbs forced no bump — discipline lives in
// prove-protocol-shape. Single-sourced constant, never the literal.
const { MERCURY_DAEMON_PROTO: liveProto } = await import('../../src/daemon/protocol.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function note(label: string): void {
  console.log(`  [NOTE] ${label}`)
}
const SRC_ROOT = resolve(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(SRC_ROOT, rel), 'utf8')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the session-kit prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

console.log('============================================================')
console.log(" the session kit — the record, the writer, the carrier, the store")
console.log('============================================================')

// ── W: the workspace-keyed read/write ───────────────────────────────────────
console.log('W — the menu store by EXPLICIT workspace (poison: the process-cwd memo)')
{
  const { enableConfigs, getGlobalConfigWriteCount } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getCurrentProjectConfig, getProjectPathForConfig, projectConfigKeyForWorkspace, saveCurrentProjectConfig } = await import(
    '../../src/utils/config/projectConfig.ts'
  )
  const { normalizePathForConfigKey } = await import('../../src/utils/path.ts')
  const { getGlobalMercuryFile } = await import('../../src/utils/env.ts')
  const { isMcpServerDisabled, setMcpServerEnabled } = await import('../../src/services/mcp/config.ts')
  const { disabledMcpServerNamesIn, isMcpServerDisabledIn, withMcpServerEnabled } = await import('../../src/services/mcp/disabledRecord.ts')
  const kit = await import('../../src/services/mcp/kitStore.ts')

  const keyHere = projectConfigKeyForWorkspace(HERE)
  const keyThere = projectConfigKeyForWorkspace(THERE)
  check('W1 the key of a non-git workspace is the folder itself, normalized', keyThere === normalizePathForConfigKey(resolve(THERE)) && keyHere !== keyThere)
  check("W2 the process memo IS the boot cwd's key through the same derivation", getProjectPathForConfig() === keyHere)
  const viaSymlink = SYMLINKED_TMP !== realpathSync(SYMLINKED_TMP) ? join(SYMLINKED_TMP, THERE.slice(realpathSync(SYMLINKED_TMP).length + 1)) : null
  if (viaSymlink !== null) {
    check("W2b a SYMLINKED spelling of the same folder lands on the same key (the runner's own — never a second row for one repo)", projectConfigKeyForWorkspace(viaSymlink) === keyThere && viaSymlink !== THERE, `${viaSymlink} vs ${THERE}`)
  } else {
    note('W2b skipped — this box has no symlinked tmpdir to spell the folder two ways')
  }
  const gitInit = spawnSync('git', ['init', '-q'], { cwd: REPO, stdio: 'ignore' })
  if (gitInit.status === 0) {
    check('W3 inside a repo the key is the canonical root — a subfolder answers the ROOT key', projectConfigKeyForWorkspace(join(REPO, 'sub')) === projectConfigKeyForWorkspace(REPO) && projectConfigKeyForWorkspace(REPO) !== keyHere)
  } else {
    note('W3 skipped — git unavailable in this box (the repo-root key derivation is findCanonicalGitRoot, unchanged)')
  }

  const empty = kit.kitDeltasForWorkspace(THERE)
  check('W4 a slice with no kit fields reads as the EMPTY deltas (absent = on, everything on — the never-nags default)', empty.mcpOff.length === 0 && Object.keys(empty.skillStates).length === 0 && empty.extensionsOff.length === 0)

  // The pens, by workspace — the menu writing a repo the process never cd'd to.
  kit.setMcpServerEnabledForWorkspace(THERE, 'srv-there', false)
  kit.setSkillStateForWorkspace(THERE, 'sk-inv', 'invocable')
  kit.setSkillStateForWorkspace(THERE, 'sk-off', 'off')
  kit.setExtensionStateForWorkspace(THERE, 'ext-there', false)
  const there = kit.kitDeltasForWorkspace(THERE)
  check("W5 the foreign workspace's deltas answer its OWN slice: mcpOff · skillStates (tri-state) · extensionsOff", there.mcpOff.join(',') === 'srv-there' && there.skillStates['sk-inv'] === 'invocable' && there.skillStates['sk-off'] === 'off' && there.extensionsOff.join(',') === 'ext-there', JSON.stringify(there))
  check("W6 POISON armed: the cwd-memoized door never sees the foreign slice (isMcpServerDisabled answers THIS process's project)", isMcpServerDisabled('srv-there') === false && getCurrentProjectConfig().skillStates === undefined && getCurrentProjectConfig().extensionStates === undefined)
  const here = kit.kitDeltasForWorkspace(HERE)
  check("W7 the process's own workspace read stays empty — the write landed under the foreign key alone", here.mcpOff.length === 0 && Object.keys(here.skillStates).length === 0 && here.extensionsOff.length === 0)
  const onDisk = JSON.parse(readFileSync(getGlobalMercuryFile(), 'utf8')) as { projects?: Record<string, Record<string, unknown>> }
  const sliceThere = onDisk.projects?.[keyThere]
  check("W8 on disk the slice sits under the WORKSPACE's key (the daemon and the boot face read the same JSON row)", sliceThere !== undefined && (sliceThere.disabledMcpServers as string[]).includes('srv-there') && (sliceThere.skillStates as Record<string, string>)['sk-off'] === 'off' && (sliceThere.extensionStates as Record<string, string>)['ext-there'] === 'off' && (onDisk.projects?.[keyHere]?.disabledMcpServers === undefined))

  // The cwd door still writes THIS process's slice, beside the foreign one.
  setMcpServerEnabled('srv-here', false)
  check('W9 the cwd pen writes the process slice, never the foreign one (two doors, two rows)', isMcpServerDisabled('srv-here') === true && kit.kitDeltasForWorkspace(HERE).mcpOff.join(',') === 'srv-here' && kit.kitDeltasForWorkspace(THERE).mcpOff.join(',') === 'srv-there')

  // 'on' is the store's ABSENCE.
  kit.setSkillStateForWorkspace(THERE, 'sk-inv', 'on')
  check("W10 'on' DELETES the key — an all-on list is never written out", kit.kitDeltasForWorkspace(THERE).skillStates['sk-inv'] === undefined && kit.kitDeltasForWorkspace(THERE).skillStates['sk-off'] === 'off')
  kit.setSkillStateForWorkspace(THERE, 'sk-off', 'on')
  kit.setExtensionStateForWorkspace(THERE, 'ext-there', true)
  const afterOn = JSON.parse(readFileSync(getGlobalMercuryFile(), 'utf8')) as { projects?: Record<string, Record<string, unknown>> }
  check('W11 the last key turned on drops the field from the slice entirely (the slice reads exactly as a pre-kit slice)', afterOn.projects?.[keyThere]?.skillStates === undefined && afterOn.projects?.[keyThere]?.extensionStates === undefined)

  // Identity: a no-op set writes nothing.
  const writesBefore = getGlobalConfigWriteCount()
  kit.setSkillStateForWorkspace(THERE, 'never-set', 'on')
  kit.setMcpServerEnabledForWorkspace(THERE, 'srv-there', false)
  kit.setExtensionStateForWorkspace(THERE, 'ext-never', true)
  check('W12 setting the state a member already has writes NOTHING (identity return, the store skips)', getGlobalConfigWriteCount() === writesBefore, `writes ${writesBefore} → ${getGlobalConfigWriteCount()}`)

  // Rendered through the disabled semantics, never the raw lists.
  const rendered = disabledMcpServerNamesIn({ disabledMcpServers: ['a', 'b', 'a'], enabledMcpServers: [] })
  check('W13 the MCP half renders through the disabled record (deduplicated names, the opt-in law folded in)', rendered.join(',') === 'a,b' && isMcpServerDisabledIn({ disabledMcpServers: ['a'] }, 'a') === true && isMcpServerDisabledIn({ disabledMcpServers: ['a'] }, 'z') === false)
  const slice = { allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0, disabledMcpServers: ['a'] }
  check('W14 the pure updater returns the input BY IDENTITY when nothing changes', withMcpServerEnabled(slice as never, 'a', false) === slice && withMcpServerEnabled(slice as never, 'a', true) !== slice && kit.withSkillState(slice as never, 'x', 'on') === slice && kit.withExtensionState(slice as never, 'x', true) === slice)

  // Source pins: one semantics, one read, one write.
  const configSrc = read('src/services/mcp/config.ts')
  check('W15 config.ts spells the disabled semantics ONCE — through the leaf (no second reading of the lists)', !configSrc.includes('DEFAULT_DISABLED_BUILTIN_SERVERS.has(') && configSrc.includes('isMcpServerDisabledIn(getCurrentProjectConfig(), name)') && configSrc.includes('withMcpServerEnabled(current, name, enabled)'))
  const leafSrc = read('src/services/mcp/disabledRecord.ts')
  const leafImports = leafSrc.split('\n').filter(l => /^import /.test(l))
  check('W16 the leaf is a leaf: its only import is the schema TYPE (the daemon reads it without the resolution graph)', leafImports.length === 1 && leafImports[0]!.startsWith('import type ') && leafImports[0]!.includes('/utils/config/schema.js'))
  const projSrc = read('src/utils/config/projectConfig.ts')
  check('W17 the cwd pair and the workspace pair share ONE read and ONE write', projSrc.includes('readProjectSlice(getProjectPathForConfig())') && projSrc.includes('readProjectSlice(projectConfigKeyForWorkspace(workspaceDir))') && projSrc.includes('writeProjectSlice(getProjectPathForConfig(), updater)') && projSrc.includes('writeProjectSlice(projectConfigKeyForWorkspace(workspaceDir), updater)') && projSrc.split('saveConfigWithLock(').length === 2)
  const schemaSrc = read('src/utils/config/schema.ts')
  check("W18 the schema carries both halves as opt-out deltas, and the `config set` allowlist (PROJECT_CONFIG_KEYS) does not grow — the menu is the store's door", schemaSrc.includes("skillStates?: Record<string, 'off' | 'invocable'>") && schemaSrc.includes("extensionStates?: Record<string, 'off'>") && !schemaSrc.slice(schemaSrc.indexOf('PROJECT_CONFIG_KEYS = [')).split('] as const')[0]!.includes('skillStates'))
  // No daemon file reaches into services/mcp's resolution graph for this.
  saveCurrentProjectConfig(current => current)
  const storeLines = read('src/services/mcp/kitStore.ts').split('\n')
  check('W19 vocabulary law: the store speaks PRESET for a saved snapshot; "pack" appears only where it is handed back to the extensions estate', storeLines.some(l => /PRESET/.test(l)) && storeLines.filter(l => /\bpacks?\b/i.test(l)).every(l => /extensions estate/.test(l)))
}


// ── A/M/R/N: the record, the wire's narrowing, the re-stamp, no world ───────
console.log('A — the additive law: absent ≠ empty; the admission stamps the CARRIED kit')
const { makeConcourseAdmitHandler, readSessionWorkers, updateConcourseWorkers, reactivateConcourseSession, buildConcourseWorkerSpec } = await import(
  '../../src/daemon/concourseSupervisor.ts'
)
const sessionKit = await import('../../src/daemon/sessionKit.ts')
const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
type WorkerRecord = import('../../src/daemon/concourseSupervisor.ts').ConcourseWorkerRecordV1
type Kit = import('../../src/daemon/sessionKit.ts').SessionKitV1
const DAEMON = process.env.MERCURY_DAEMON_DIR!
const WS = join(SCRATCH, 'ws-kit')
mkdirSync(WS, { recursive: true })
const NOW = Date.now()
// A FIXTURE presence, never a live key: the admit's model validator asks the
// presence owner whether a family HOLDS a credential (existence, never
// validity — providerUsage), and the stub roster below never spawns a
// runner, so a fake DeepSeek key string makes that family dispatchable in
// the scratch home with zero network. Set before the registry is first
// composed. A box where no family answers skips the admit-driven pins with
// a NOTE — their seams are pinned pure beside them.
process.env.DEEPSEEK_API_KEY = 'fixture-not-a-key'
const wm = await import('../../src/services/concourse/workerModels.ts')
const registry = await wm.composeWorkerModelRegistry()
const AVAILABLE = registry.entries.find(e => e.session.availability === 'available')?.modelId
const MODEL = AVAILABLE ?? 'claude-opus-5'
const ADMIT_SKIP = AVAILABLE === undefined ? 'skipped — no dispatchable family in this scratch home (the fixture presence did not land)' : ''
const K1: Kit = { schema: 1, mcp: ['alpha', 'ext:tools-ext:probe'], skills: ['review', 'tools-ext:lint'], invocable: ['deploy'], extensions: { 'tools-ext': 'on', 'old-ext': 'off' } }
const K2: Kit = { schema: 1, mcp: ['beta'], skills: [], invocable: ['review'] }
const EMPTY: Kit = { schema: 1, mcp: [], skills: [], invocable: [] }
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function seedRecord(runnerId: string, sessionId: string, extra: Partial<WorkerRecord> = {}): void {
  updateConcourseWorkers(workers => {
    workers[runnerId] = {
      schema: 1,
      runnerId,
      sessionId,
      workspaceId: WS,
      isolation: 'shared',
      modelKey: MODEL,
      effort: 'low',
      spawnedAt: NOW - 60_000,
      lastLiveAt: NOW - 60_000,
      title: 'the kit session',
      ...extra,
    } as WorkerRecord
  }, DAEMON)
}
const recOf = (runnerId: string): WorkerRecord | undefined => readSessionWorkers(DAEMON)[runnerId]
/** The roster port, scripted: registrations land without a spawn. */
class StubRoster {
  registered: string[] = []
  present = new Set<string>()
  has(short: string): { present: boolean; alive: boolean; ready: boolean } {
    return { present: this.present.has(short), alive: this.present.has(short), ready: true }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present].map(short => ({ short }))
  }
  registerLongLived(short: string, _spec: unknown): { ok: boolean; pid?: number; error?: string } {
    this.registered.push(short)
    this.present.add(short)
    return { ok: true, pid: process.pid }
  }
  kill(short: string): boolean {
    this.present.delete(short)
    return true
  }
}
{
  const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

  // A pre-kit record: the fixture bytes carry no kit; a read and a rewrite keep it that way.
  seedRecord('concourse-w1', 'sess-prekit-0001')
  const prekit = recOf('concourse-w1')
  check('A1 a pre-kit record reads with NO kit (absent — whole-config; the compatibility law needs no migration)', prekit !== undefined && prekit.kit === undefined && !('kit' in prekit))
  updateConcourseWorkers(() => {}, DAEMON)
  const rewritten = JSON.parse(readFileSync(join(DAEMON, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Record<string, unknown>> }
  check('A2 POISON armed: no reader heals absence into an empty kit — the rewrite carries no `kit` key at all', !('kit' in rewritten.workers['concourse-w1']!))
  check('A3 the stamp fragment of NO kit is NOTHING (no `kit: undefined`, no empty kit)', !('kit' in sessionKit.kitStampOf(undefined)) && deepEq(sessionKit.kitStampOf(K2), { kit: K2 }))
  seedRecord('concourse-w2', 'sess-kit-0002', { kit: K1 })
  check('A4 a kit-bearing record round-trips WHOLE (mcp · skills · invocable · extensions)', deepEq(recOf('concourse-w2')?.kit, K1))
  seedRecord('concourse-w3', 'sess-empty-0003', { kit: EMPTY })
  check('A5 an EMPTY kit is a valid kit and stays empty on the record (empty = load NOTHING; never conflated with absent)', deepEq(recOf('concourse-w3')?.kit, EMPTY) && recOf('concourse-w3')?.kit !== undefined)

  // The admission stamps the carried kit — both mints.
  if (ADMIT_SKIP !== '') {
    note(`A6–A9 ${ADMIT_SKIP}`)
  } else {
    const roster = new StubRoster()
    const admit = makeConcourseAdmitHandler({ roster: () => roster as never, dir: DAEMON })
    const bornWith = await admit({ workspaceDir: WS, modelKey: MODEL, bornBlank: true, kit: K1 })
    const bornRec = bornWith.ok ? recOf(bornWith.runnerId) : undefined
    check('A6 the COLD mint stamps the carried kit onto the new record (the admission stamp, writer one of three)', bornWith.ok && bornRec !== undefined && deepEq(bornRec.kit, K1), bornWith.ok ? '' : bornWith.error)
    check('A7 the stamp is a COPY, never an alias of the request (the caller cannot mutate the record through it)', bornRec !== undefined && bornRec.kit !== K1)
    // A fresh plain folder: a second solo session in the SAME plain folder
    // is the git-offer refusal (two sessions there need git), not a birth.
    const WS_BARE = join(SCRATCH, 'ws-bare')
    mkdirSync(WS_BARE, { recursive: true })
    const bornWithout = await admit({ workspaceDir: WS_BARE, modelKey: MODEL, bornBlank: true })
    const bareRec = bornWithout.ok ? recOf(bornWithout.runnerId) : undefined
    check("A8 an admission carrying NO kit mints a DERIVED kit — unresolved, the workspace's menu deltas — never absent and never an empty resolved kit (the fallback every door that never saw a screen gets)", bornWithout.ok && bareRec !== undefined && bareRec.kit !== undefined && bareRec.kit.resolved === false && deepEq(bareRec.kit.deltas, { mcpOff: [], skillStates: {}, extensionsOff: [] }) && bareRec.kit.mcp.length === 0, bornWithout.ok ? '' : bornWithout.error)
    // The warm-claim mint: the pool hands back a runner; the record mints with the kit.
    const warmRoster = new StubRoster()
    const WS_WARM = join(SCRATCH, 'ws-warm')
    mkdirSync(WS_WARM, { recursive: true })
    const warmAdmit = makeConcourseAdmitHandler({
      roster: () => warmRoster as never,
      dir: DAEMON,
      claimWarm: async args => {
        warmRoster.present.add('concourse-w9')
        return { claimed: true, short: 'concourse-w9', pid: process.pid, spec: buildConcourseWorkerSpec({ runnerId: 'concourse-w9', sessionId: args.sessionId, workspaceId: args.workspaceId, modelKey: args.modelKey, effort: args.effort }) }
      },
    })
    const claimed = await warmAdmit({ workspaceDir: WS_WARM, modelKey: MODEL, bornBlank: true, kit: K2 })
    check('A9 the WARM-claim mint stamps the carried kit too (one writer, two mints)', claimed.ok && claimed.runnerId === 'concourse-w9' && deepEq(recOf('concourse-w9')?.kit, K2), claimed.ok ? '' : claimed.error)
  }
}

console.log('M — a malformed kit REFUSES TYPED at the wire (poison: a silent drop births whole-config)')
{
  const v = sessionKit.validateSessionKit
  const refused = (raw: unknown, needle: string): boolean => {
    const r = v(raw)
    return !r.ok && r.reason.includes(needle)
  }
  check('M1 the exact shape is accepted whole', v(K1).ok && deepEq((v(K1) as { kit: Kit }).kit, K1) && v(EMPTY).ok)
  check('M2 not an object / an array refuses', refused(null, 'object') && refused([], 'object') && refused('kit', 'object'))
  check('M3 a foreign schema number refuses by name', refused({ ...K1, schema: 2 }, 'schema'))
  check('M4 a non-array list refuses by field', refused({ ...K1, mcp: 'alpha' }, 'mcp') && refused({ ...K1, skills: {} }, 'skills') && refused({ ...K1, invocable: null }, 'invocable'))
  check('M5 a non-string entry refuses by field', refused({ ...K1, mcp: ['alpha', 7] }, 'mcp'))
  check("M6 the MCP charset is config.ts's addMcpConfig law (letters, digits, hyphen, underscore) or ext:<name>:<server>", refused({ ...K1, mcp: ['bad name'] }, 'mcp') && refused({ ...K1, mcp: ['ext:Bad:x'] }, 'mcp') && v({ ...K1, mcp: ['ok_name-1', 'ext:my-ext:srv'] }).ok)
  check('M7 a skill name with whitespace, a path separator or a control byte refuses; a namespaced one is accepted', refused({ ...K1, skills: ['has space'] }, 'skills') && refused({ ...K1, skills: ['a/b'] }, 'skills') && refused({ ...K1, invocable: ['x' + String.fromCharCode(1)] }, 'invocable') && v({ ...K1, skills: ['ns:base', 'my-ext:skill.v2'], invocable: [] }).ok)
  check('M8 a duplicate within a list refuses', refused({ ...K1, mcp: ['alpha', 'alpha'] }, 'twice'))
  check('M9 a skill listed both ambient and invocable refuses — a skill has ONE state', refused({ ...K1, skills: ['review'], invocable: ['review'] }, 'one state'))
  check('M10 extensions must be a record of on|off keyed by manifest names', refused({ ...K1, extensions: ['x'] }, 'extensions') && refused({ ...K1, extensions: { 'Bad_Name': 'on' } }, 'extension name') && refused({ ...K1, extensions: { ok: 'maybe' } }, 'on'))
  check("M11 `resolved: true` is not a spelling; `deltas` ride only an unresolved kit", refused({ ...K1, resolved: true }, 'resolved') && refused({ ...K1, deltas: { mcpOff: [], skillStates: {}, extensionsOff: [] } }, 'deltas'))
  const unresolved = { schema: 1, mcp: ['alpha'], skills: [], invocable: [], resolved: false, deltas: { mcpOff: ['beta'], skillStates: { deploy: 'invocable', old: 'off' }, extensionsOff: ['old-ext'] } }
  const u = v(unresolved)
  check('M12 an unresolved kit needs its deltas, and carries them whole', u.ok && u.kit.resolved === false && deepEq(u.kit.deltas, unresolved.deltas) && refused({ ...unresolved, deltas: undefined }, 'deltas') && refused({ ...unresolved, deltas: { mcpOff: [], skillStates: { x: 'on' }, extensionsOff: [] } }, 'skillStates'))
  const big = { ...K1, mcp: Array.from({ length: sessionKit.KIT_LIST_CAP + 1 }, (_, i) => `s${i}`) }
  check('M13 a boundless list refuses (a hostile frame never stamps a boundless record)', refused(big, 'cap'))
  const withExtra = v({ ...K1, extra: 'field', nested: { x: 1 } })
  check('M14 unknown sibling fields are DROPPED, never carried onto the record (accept whole or refuse whole)', withExtra.ok && !('extra' in withExtra.kit) && !('nested' in withExtra.kit))
  // The grammars agree with their owners.
  const { NAME_PATTERN } = await import('../../src/extensions/manifest.ts')
  check("M15 the extension-name grammar equals the manifest's NAME_PATTERN (spelled twice, pinned equal)", sessionKit.KIT_EXTENSION_NAME_PATTERN.source === NAME_PATTERN.source)
  check("M16 the MCP-name grammar is config.ts's own regex", read('src/services/mcp/config.ts').includes(sessionKit.KIT_MCP_NAME_PATTERN.source))
  // The server: typed refusal, never a cast-through, never a drop.
  const server = read('src/daemon/controlServer.ts')
  const admitArm = server.slice(server.indexOf("case 'sessionAdmit': {"), server.indexOf("case 'concourseWithdraw': {"))
  check("M17 the sessionAdmit arm validates raw.kit and answers 'kit refused — <reason>' (EUNKNOWN) — no cast-through, no silent drop", admitArm.includes('validateSessionKit(raw.kit)') && admitArm.includes('kit refused — ${verdict.reason}') && admitArm.includes('...(kit !== undefined ? { kit } : {})') && !admitArm.includes('raw.kit as'))
  const protocol = read('src/daemon/protocol.ts')
  const admitOp = protocol.slice(protocol.indexOf("op: 'sessionAdmit'"), protocol.indexOf("op: 'sessionList'"))
  check('M18 the wire TYPE names the kit on sessionAdmit (the type no longer lags the raw frame) at the ONE registered proto', admitOp.includes('kit?: SessionKitV1') && protocol.includes(`export const MERCURY_DAEMON_PROTO = ${liveProto}`))
}

console.log('R — the re-stamp: a reactivation takes the CURRENT menu, the old kit is history (poison: the retained-effort shape applied to the kit)')
{
  const home = getProjectDir(WS)
  seedRecord('concourse-w4', 'sess-parked-0004', { kit: K1, parkedAt: NOW - 30_000, parkedBy: 'operator' })
  // The seam as the supervisor drives it: inside the record's one
  // publication, so the re-stamp lands on disk.
  updateConcourseWorkers(workers => sessionKit.restampSessionKit(workers['concourse-w4']!, K2, 'carried', 'operator'), DAEMON)
  const before = recOf('concourse-w4')!
  check('R1 restampSessionKit replaces the kit with the CURRENT one (a copy — the record never aliases the caller\'s arrays)', deepEq(before.kit, K2) && before.kit !== K2)
  const rows = readSessionReceipts(home, 'sess-parked-0004')
  check("R2 the displaced kit lands on the session receipt as 'kit-restamp' history — was/now/source — never reloaded", rows.length === 1 && rows[0]!.kind === 'kit-restamp' && deepEq(rows[0]!.details?.was, K1) && deepEq(rows[0]!.details?.now, K2) && rows[0]!.details?.source === 'carried' && rows[0]!.by === 'operator')
  check('R3 the model and effort beside it are NOT touched by the re-stamp seam (the retention laws survive the divergence)', before.modelKey === MODEL && before.effort === 'low')
  seedRecord('concourse-w5', 'sess-prekit-0005', { parkedAt: NOW - 30_000 })
  const prekit = recOf('concourse-w5')!
  sessionKit.restampSessionKit(prekit, K2, 'carried', 'operator')
  check('R4 a pre-kit record re-stamps WITHOUT a receipt row (nothing was displaced)', deepEq(prekit.kit, K2) && readSessionReceipts(home, 'sess-prekit-0005').length === 0)

  // THE DOOR: a parked record reactivated with a carried kit re-stamps on the cold road; a live session is a hop and never re-stamps.
  const roster = new StubRoster()
  const back = await reactivateConcourseSession(recOf('concourse-w4')!, { modelKey: MODEL, kit: EMPTY, by: 'operator' }, [], { roster: () => roster as never, dir: DAEMON })
  const afterBack = recOf('concourse-w4')
  check('R5 ↵ on a parked row (the reactivate door with a carried kit) RE-STAMPS the standing record on the cold road', back.ok && afterBack !== undefined && deepEq(afterBack.kit, EMPTY) && afterBack.parkedAt === undefined && roster.registered.includes('concourse-w4'), back.ok ? '' : back.error)
  const rows2 = readSessionReceipts(home, 'sess-parked-0004')
  check("R6 the second receipt row names the kit the row parked with (K2) as history; the record's model stays retained", rows2.length === 2 && deepEq(rows2[1]!.details?.was, K2) && afterBack?.modelKey === MODEL)
  check('R7 the re-stamp arm is EMPTY-honest: an empty carried kit stamps the EMPTY kit (never healed to absent)', afterBack?.kit !== undefined && afterBack.kit.mcp.length === 0)
  seedRecord('concourse-w6', 'sess-attached-0006', { kit: K1, attachedAt: NOW - 1000, attachedBy: 'operator:1' })
  const hop = await reactivateConcourseSession(recOf('concourse-w6')!, { modelKey: MODEL, kit: K2, by: 'operator' }, [], { roster: () => roster as never, dir: DAEMON })
  check('R8 a LIVE session is a hop: the door answers ok and the kit is UNCHANGED (the live-session law)', hop.ok && deepEq(recOf('concourse-w6')?.kit, K1) && readSessionReceipts(home, 'sess-attached-0006').length === 0)
  seedRecord('concourse-w7', 'sess-parked-0007', { kit: K1, parkedAt: NOW - 30_000 })
  const noKit = await reactivateConcourseSession(recOf('concourse-w7')!, { modelKey: MODEL, by: 'operator' }, [], { roster: () => roster as never, dir: DAEMON })
  const derivedRows = readSessionReceipts(home, 'sess-parked-0007')
  check("R9 a reactivation carrying NO kit RE-STAMPS from the DERIVED current menu (unresolved, the workspace's deltas) — the standing kit goes to the receipt as history with source 'derived', never reloaded", noKit.ok && recOf('concourse-w7')?.kit?.resolved === false && deepEq(recOf('concourse-w7')?.kit?.deltas, { mcpOff: [], skillStates: {}, extensionsOff: [] }) && derivedRows.length === 1 && deepEq(derivedRows[0]!.details?.was, K1) && derivedRows[0]!.details?.source === 'derived')
  const sup = read('src/daemon/concourseSupervisor.ts')
  const reactivateFn = sup.slice(sup.indexOf('export async function reactivateConcourseSession('))
  const hopReturn = reactivateFn.indexOf('if (alive || rec.attachedAt !== undefined) {')
  const firstRestamp = reactivateFn.indexOf('restampSessionKit(')
  check('R10 in source the re-stamp sits AFTER the live-hop return, on both roads (warm publication + cold revive)', hopReturn !== -1 && firstRestamp > hopReturn && reactivateFn.split('restampSessionKit(').length === 3)
  const mirror = read('src/components/concourse/SessionMirror.tsx')
  check("R11 the receipt viewer paints the new kind as 'kit: …' (never mislabelled as a contract row)", mirror.includes("e.kind === 'kit-restamp'") && mirror.includes('`kit: ${flat}`'))
}

console.log('N — no world check anywhere in the kit path (the worlds are identical for this estate)')
{
  const files = [
    'src/daemon/sessionKit.ts',
    'src/services/mcp/kitStore.ts',
    'src/services/mcp/disabledRecord.ts',
    'src/utils/config/projectConfig.ts',
    'src/daemon/concourseSupervisor.ts',
    'src/daemon/controlServer.ts',
    'src/daemon/protocol.ts',
    'src/services/switchboard/bootBirthFacts.ts',
    'src/services/switchboard/bornSession.ts',
    'src/services/switchboard/hopIntoSession.ts',
    'src/services/mcp/membership.ts',
  ]
  const dirty = files.filter(f => /chatOnlyBoot|chatBoot\(|MERCURY_SPLASH_CHAT/.test(read(f)))
  check('N1 none of this lane\'s files reads chatOnlyBoot / chatBoot / MERCURY_SPLASH_CHAT (poison: any world predicate in the kit path)', dirty.length === 0, dirty.join(','))
  const kitSites = read('src/daemon/concourseSupervisor.ts').split('\n').filter(l => /\bkit\b/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l))
  check('O0 the supervisor writes the kit only through the two named seams (kitStampOf at the mints, restampSessionKit at the reactivate) — never a bare `.kit =`', !kitSites.some(l => /\.kit\s*=[^=]/.test(l)) && kitSites.filter(l => l.includes('kitStampOf(')).length === 2)
  const bareWrites = ['src/daemon', 'src/services/switchboard', 'src/services/mcp', 'src/components/concourse']
    .flatMap(d => spawnSync('grep', ['-rln', '\\.kit = ', join(SRC_ROOT, d)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean))
    .map(p => p.slice(SRC_ROOT.length + 1))
  check('O1 the only file that assigns a record\'s `.kit` is daemon/sessionKit.ts (the one-writer census)', bareWrites.length === 1 && bareWrites[0] === 'src/daemon/sessionKit.ts', bareWrites.join(','))
}

console.log("S — set-kit, the ONE writer: a pre-kit record MATERIALIZES then edits (poisons: the refusal arm; the silent whole-config arm)")
{
  const { applyConcourseKitOp } = await import('../../src/daemon/sessionKitOp.ts')
  const UNRESOLVED_EMPTY = { schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: { mcpOff: [], skillStates: {}, extensionsOff: [] } }
  seedRecord('concourse-w10', 'sess-dial-0010')
  const first = applyConcourseKitOp('sess-dial-0010', { mcp: [{ name: 'alpha', on: false }] }, 'operator', DAEMON)
  const afterFirst = recOf('concourse-w10')?.kit
  check("S1 the first dial in a PRE-KIT session is APPLIED (never refused): the kit materializes from whole-config reality (unresolved, empty deltas) and the dial edits it", first.outcome === 'applied' && (first.detail ?? '').includes('materialized') && afterFirst !== undefined && afterFirst.resolved === false && deepEq(afterFirst.deltas, { mcpOff: ['alpha'], skillStates: {}, extensionsOff: [] }) && afterFirst.mcp.length === 0, `${first.outcome}: ${first.detail ?? ''}`)
  check('S2 POISON armed: no silent whole-config arm — the record CARRIES the materialized kit after the dial (a record left kit-less would birth whole-config on respawn)', afterFirst !== undefined && 'kit' in recOf('concourse-w10')!)
  const again = applyConcourseKitOp('sess-dial-0010', { mcp: [{ name: 'alpha', on: false }] }, 'operator', DAEMON)
  check('S3 the same dial again is a NOOP and the record is untouched', again.outcome === 'noop' && deepEq(recOf('concourse-w10')?.kit, afterFirst))
  const on = applyConcourseKitOp('sess-dial-0010', { mcp: [{ name: 'alpha', on: true }], skills: [{ name: 'deploy', state: 'invocable' }, { name: 'old', state: 'off' }], extensions: [{ name: 'old-ext', on: false }] }, 'operator', DAEMON)
  const k = recOf('concourse-w10')?.kit
  check('S4 an UNRESOLVED kit edits its DELTAS in one gesture: mcp back on (off-list shrinks) · skill invocable · skill off · extension master off', on.outcome === 'applied' && deepEq(k?.deltas, { mcpOff: [], skillStates: { deploy: 'invocable', old: 'off' }, extensionsOff: ['old-ext'] }))
  const backOn = applyConcourseKitOp('sess-dial-0010', { skills: [{ name: 'deploy', state: 'on' }], extensions: [{ name: 'old-ext', on: true }] }, 'operator', DAEMON)
  check("S5 'on' is the deltas' ABSENCE (the skill key deleted, the extension off-list shrunk)", backOn.outcome === 'applied' && deepEq(recOf('concourse-w10')?.kit?.deltas, { mcpOff: [], skillStates: { old: 'off' }, extensionsOff: [] }))
  seedRecord('concourse-w11', 'sess-dial-0011', { kit: K1 })
  const resolvedEdit = applyConcourseKitOp('sess-dial-0011', { mcp: [{ name: 'alpha', on: false }, { name: 'beta', on: true }], skills: [{ name: 'review', state: 'invocable' }, { name: 'deploy', state: 'off' }, { name: 'fresh', state: 'on' }], extensions: [{ name: 'tools-ext', on: false }, { name: 'new-ext', on: true }] }, 'operator', DAEMON)
  const r = recOf('concourse-w11')?.kit
  check('S6 a RESOLVED kit edits its CLOSED lists: alpha off · beta on · review → invocable (moved, never in both) · deploy off · fresh on · a master row off; an extension the kit never named is already on (absent = on), so its on-dial changes nothing', resolvedEdit.outcome === 'applied' && r !== undefined && r.resolved === undefined && deepEq(r.mcp, ['ext:tools-ext:probe', 'beta']) && deepEq(r.skills, ['tools-ext:lint', 'fresh']) && deepEq(r.invocable, ['review']) && deepEq(r.extensions, { 'tools-ext': 'off', 'old-ext': 'off' }), JSON.stringify(r))
  const backOnExt = applyConcourseKitOp('sess-dial-0011', { extensions: [{ name: 'tools-ext', on: true }] }, 'operator', DAEMON)
  check("S6b a master row dialed back ON reads 'on' on a resolved kit (the row was named; it is not deleted)", backOnExt.outcome === 'applied' && recOf('concourse-w11')?.kit?.extensions?.['tools-ext'] === 'on')
  check('S7 a dial on an unknown session refuses typed', applyConcourseKitOp('no-such-session', { mcp: [{ name: 'alpha', on: false }] }, 'operator', DAEMON).outcome === 'refused')
  check('S8 the pure edit returns its input BY IDENTITY when nothing changes (the writer\'s noop needs no write)', sessionKit.applyKitEdit(K1, { mcp: [{ name: 'alpha', on: true }] }) === K1 && sessionKit.applyKitEdit(UNRESOLVED_EMPTY as never, { skills: [{ name: 'x', state: 'on' }] }) === (UNRESOLVED_EMPTY as never))
  const ve = sessionKit.validateSessionKitEdit
  const refusedEdit = (raw: unknown, needle: string): boolean => {
    const v = ve(raw)
    return !v.ok && v.reason.includes(needle)
  }
  check('S9 the edit grammar refuses typed: not an object · no dial · a bad shape · a bad name · a bad state · a boundless list', refusedEdit(null, 'object') && refusedEdit({}, 'no dial') && refusedEdit({ mcp: [{ name: 'a' }] }, '{ name, on }') && refusedEdit({ mcp: [{ name: 'bad name', on: true }] }, 'mcp name') && refusedEdit({ skills: [{ name: 'x', state: 'maybe' }] }, 'on|invocable|off') && refusedEdit({ extensions: Array.from({ length: sessionKit.KIT_LIST_CAP + 1 }, () => ({ name: 'e', on: true })) }, 'cap') && ve({ skills: [{ name: 'ns:skill', state: 'invocable' }] }).ok)

  // THE WIRE: appended LAST on proto 3, payload outside the action window, one arm, one writer.
  const protocol = read('src/daemon/protocol.ts')
  const actionsAt = protocol.indexOf("op: 'sessionControl'", protocol.indexOf('export type DaemonRequest ='))
  const window = protocol.slice(protocol.indexOf('action:', actionsAt), protocol.indexOf('sessionId: string', actionsAt))
  // S10 AMENDED: 'set-schedule' appended AFTER 'set-kit'
  // — the append-last law holds by ADJACENCY (the ruling-2
  // form): 'set-kit' stays exactly after 'contract', never a mid-union
  // insertion; the new tail is SATURN's and its own prover pins it last.
  check("S10 the wire action 'set-kit' rides exactly after 'contract' (adjacency; never a mid-union insertion)", /\|\s*'contract'\s*\|\s*'set-kit'\s*/m.test(window))
  check("S11 the set-kit payload rides OUTSIDE the shape extractor's action window (after sessionId), typed off SessionKitEditV1", !window.includes('kitEdit') && protocol.includes('kitEdit?: SessionKitEditV1'))
  check('S12 ONE wire proto, single-sourced beside its registered shape (no bump rode this action; discipline is prove-protocol-shape\'s)', (protocol.match(/export const MERCURY_DAEMON_PROTO = /g) ?? []).length === 1 && protocol.includes(`export const MERCURY_DAEMON_PROTO = ${liveProto}`) && protocol.includes("export const DAEMON_PROTO_SHAPE = 'sha256:"))
  const server = read('src/daemon/controlServer.ts')
  const controlArm = server.slice(server.indexOf("case 'sessionControl': {"), server.indexOf("case 'sessionList': {"))
  // S13 needle AMENDED: the requires-string grew
  // '|set-schedule' at its tail — the set-kit clauses pinned here are
  // byte-unmoved.
  check("S13 the server routes the action, narrows the payload through validateSessionKitEdit ('kitEdit refused — <reason>') and passes it typed; the requires-string names set-kit", controlArm.includes("raw.action === 'set-kit'") && controlArm.includes('validateSessionKitEdit(raw.kitEdit)') && controlArm.includes('kitEdit refused — ') && controlArm.includes('...(kitEdit !== undefined ? { kitEdit } : {})') && controlArm.includes('park-all|set-effort|contract|set-kit|set-schedule, sessionId, by }'))
  // S14/S15 AMENDED (the live forward landed): the arm now
  // routes through the SEAT half (setSessionKitDial: idle applies through
  // the one writer and forwards the post-edit kit whole; busy parks with
  // the honest 'queued' line, which must NOT ride the exactly-once ledger —
  // its outcome union has no queued row and a re-parked edit noops at
  // apply), and the writer's callers are the seat's three roads (the idle
  // dial, the idle-edge drain, the respawn drain) — main.ts no longer
  // touches the writer directly.
  const main = read('src/daemon/main.ts')
  const arm = main.slice(main.indexOf("if (action === 'set-kit')"), main.indexOf("if (action === 'set-model')"))
  check('S14 the daemon arm adjudicates through the SEAT half and settles only the adjudicated outcomes (queued rides around the ledger)', arm.includes('setSessionKitDial(sessionId, kitEdit, by, roster)') && /dialed\.outcome === 'queued'\s*\?\s*dialed\s*:\s*settle\(/.test(arm))
  const writers = spawnSync('grep', ['-rln', 'applyConcourseKitOp(', join(SRC_ROOT, 'src')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(p => p.slice(SRC_ROOT.length + 1)).sort()
  check('S15 the one-writer census holds: applyConcourseKitOp is defined in sessionKitOp.ts and called from the seat (sessionSeat.ts) alone', deepEq(writers, ['src/daemon/sessionKitOp.ts', 'src/daemon/sessionSeat.ts']), writers.join(','))
  const bare = ['src/daemon', 'src/services/switchboard', 'src/services/mcp', 'src/components/concourse']
    .flatMap(d => spawnSync('grep', ['-rln', '\\.kit = ', join(SRC_ROOT, d)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean))
    .map(p => p.slice(SRC_ROOT.length + 1))
  check('S16 every `.kit =` assignment in the tree still lives in daemon/sessionKit.ts (the stamp, the re-stamp, the set)', bare.length === 1 && bare[0] === 'src/daemon/sessionKit.ts', bare.join(','))
  const contracts = read('scripts/switchboard/prove-contracts.ts')
  check("S17 prove-contracts B10 was AMENDED with teeth, not dodged: it pins 'contract' after 'set-effort' by adjacency (no end anchor) — this prover pins the tail", contracts.includes("/\\|\\s*'set-effort'\\s*\\|\\s*'contract'/") && !contracts.includes("'contract'\\s*$/m"))
}

console.log("C — the L18 carrier: the menu's kit rides the birth and the resume when set; ABSENT on the wire when null (poison: `kit: null`)")
{
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  facts._resetBootBirthFactsForTesting()
  check('C1 a fresh boot carries NO kit (null): the daemon derives', facts.bootBirthFacts().kit === null)
  check("C2 the carry of a null kit is NOTHING — no `kit` key at all (never `kit: null`, which the server would refuse or, worse, stamp)", !('kit' in facts.carriedKitOf({ kit: null })) && Object.keys(facts.carriedKitOf({ kit: null })).length === 0)
  facts.setNextSessionFacts({ kit: K1 })
  check('C3 setNextSessionFacts({ kit }) is the settings seam — the SAME record, and the kit is STICKY: two reads, one answer', facts.bootBirthFacts().kit === K1 && facts.bootBirthFacts().kit === K1 && deepEq(facts.carriedKitOf(facts.bootBirthFacts()), { kit: K1 }))
  facts.setBootBirthFacts({ title: 'once' })
  facts.takeBootTitle()
  check('C4 the one-shot title consumes nothing else: the kit survives the first birth', facts.bootBirthFacts().kit === K1 && facts.bootBirthFacts().title === null)
  facts.setNextSessionFacts({ kit: null })
  check('C5 the menu can clear it: null again ⇒ the next birth carries none and the daemon derives', facts.bootBirthFacts().kit === null)
  facts._resetBootBirthFactsForTesting()
  const born = read('src/services/switchboard/bornSession.ts')
  const birthBody = born.slice(born.indexOf('async function birth('))
  // C6/C7 AMENDED' landing (the needles, not the law): the
  // doors still spread carriedKitOf's fragment for the STICKY carry, but a
  // WORN one-shot preset (takeWornPresetKit / peekWornPresetKit) OUTRANKS
  // it for exactly one admission — the birth consumes at entry (the
  // takeBootTitle law), the resume consumes only when the daemon actually
  // applied it (`liveHop !== true`; a pure hop never spends the wear).
  check('C6 the birth door spreads the worn-else-carried fragment onto its sessionAdmit (the worn preset consumed at entry outranks the sticky carry) — never a bare kit field', birthBody.includes('...(worn !== null ? { kit: worn.kit } : carriedKitOf(facts)),') && birthBody.includes('const worn = takeWornPresetKit()') && !birthBody.includes('kit: facts.kit') && !birthBody.includes('kit: null'))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const resumeAdmit = hop.slice(hop.indexOf("{ op: 'sessionAdmit', workspaceDir, resumeSessionId: sessionId"), hop.indexOf('} as never,', hop.indexOf("{ op: 'sessionAdmit', workspaceDir, resumeSessionId: sessionId")))
  check("C7 the resume door carries the same worn-else-carried fragment (the re-stamp's carried arm; the wear PEEKED and spent only when applied — a live hop never consumes) — and still never the record's model (a resume is not a birth)", resumeAdmit.includes('worn !== null ? { kit: worn.kit } : carriedKitOf(bootBirthFacts())') && hop.includes('const worn = peekWornPresetKit()') && hop.includes('if (worn !== null && reply.liveHop !== true) takeWornPresetKit()') && !hop.includes('model: bootBirthFacts') && /resumeSessionId: sessionId, isolation: 'shared'/.test(hop))
  const factsSrc = read('src/services/switchboard/bootBirthFacts.ts')
  check('C8 ONE spelling of the carry (carriedKitOf) and the kit is typed SessionKitV1 | null on the facts record', factsSrc.includes('kit: SessionKitV1 | null') && (born.split('carriedKitOf(').length - 1) === 1 && (hop.split('carriedKitOf(').length - 1) === 1)
}

console.log("D — the daemon-side derivation: a birth the screen never saw stamps the workspace's menu deltas, UNRESOLVED (poison: the memoized cwd; a silent default)")
{
  const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  const store = await import('../../src/services/mcp/kitStore.ts')
  const WS_D = join(SCRATCH, 'ws-derive')
  mkdirSync(WS_D, { recursive: true })
  // The menu store for WS_D, written by its own pens; the user scope names two servers.
  saveGlobalConfig(c => ({ ...c, mcpServers: { 'srv-off': { type: 'stdio', command: 'x' }, 'srv-on': { type: 'stdio', command: 'y' } } as never }))
  store.setMcpServerEnabledForWorkspace(WS_D, 'srv-off', false)
  store.setSkillStateForWorkspace(WS_D, 'sk-inv', 'invocable')
  store.setExtensionStateForWorkspace(WS_D, 'ext-off', false)
  const derived = sessionKit.deriveSessionKitForWorkspace(WS_D)
  check("D1 the derivation stamps the workspace's DELTAS under resolved:false, and the config-known MCP names minus the off-record as PROVISIONAL lists (skills/extensions empty — the runner's walk)", derived.resolved === false && deepEq(derived.deltas, { mcpOff: ['srv-off'], skillStates: { 'sk-inv': 'invocable' }, extensionsOff: ['ext-off'] }) && deepEq(derived.mcp, ['srv-on']) && derived.skills.length === 0 && derived.invocable.length === 0, JSON.stringify(derived))
  check('D2 a derived kit is wire-legal (validateSessionKit accepts it whole)', sessionKit.validateSessionKit(derived).ok)
  check("D3 POISON armed: the derivation keys by the WORKSPACE, never the process cwd — the process's own workspace answers ITS slice, the foreign one answers its own", deepEq(sessionKit.deriveSessionKitForWorkspace(HERE).deltas?.mcpOff, ['srv-here']) && deepEq(sessionKit.deriveSessionKitForWorkspace(THERE).deltas?.mcpOff, ['srv-there']) && !deepEq(sessionKit.deriveSessionKitForWorkspace(HERE).deltas, derived.deltas))
  const missing = sessionKit.deriveSessionKitForWorkspace(join(SCRATCH, 'no-such-folder'))
  check('D4 fail-soft: an unreadable or unknown workspace derives the EMPTY deltas (everything on — today\'s behaviour), never a throw', missing.resolved === false && deepEq(missing.deltas, { mcpOff: [], skillStates: {}, extensionsOff: [] }))
  if (ADMIT_SKIP !== '') {
    note(`D5 ${ADMIT_SKIP}`)
  } else {
    const roster = new StubRoster()
    const admit = makeConcourseAdmitHandler({ roster: () => roster as never, dir: DAEMON })
    const born = await admit({ workspaceDir: WS_D, modelKey: MODEL, bornBlank: true })
    const rec = born.ok ? recOf(born.runnerId) : undefined
    check("D5 a birth through the admit with NO carried kit (the coordinator's road) stamps the DERIVED kit with that workspace's deltas", born.ok && rec !== undefined && rec.kit?.resolved === false && deepEq(rec.kit.deltas, derived.deltas) && deepEq(rec.kit.mcp, ['srv-on']), born.ok ? '' : born.error)
  }
  const sup = read('src/daemon/concourseSupervisor.ts')
  // AMENDED (the warm mint joins the hoist): ONE `const kit`
  // hoisted ABOVE the warm-claim block now feeds the claim's kit gate, the
  // spawn-spec carry AND both mints' stamps — the inline warm-mint spelling
  // is gone by design, and record/process/claim share one value.
  // D6/D7 hoist needles AMENDED (the spelling, not the
  // law): the ONE hoisted value now folds the PRESET arm between the
  // carried and derived arms (carried ?? preset ?? derived) — resolved
  // once at the preset door above every road, so gate + spec + stamps
  // still share exactly one value and a hop still never derives.
  check('D6 both mints stamp carried-else-preset-else-derived through the ONE hoisted kit (above the warm claim: gate + spec + both stamps share the value; no inline second derivation)', !sup.includes('kitStampOf(req.kit ?? deriveSessionKitForWorkspace(workspaceId))') && sup.split('const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)').length === 2 && sup.split('kitStampOf(kit),').length === 3 && !sup.includes('kitStampOf(req.kit)') && sup.includes('const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)') && sup.indexOf('const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)') < sup.indexOf('deps.claimWarm !== undefined'))
  const reactivateFn = sup.slice(sup.indexOf('export async function reactivateConcourseSession('))
  const hopReturn = reactivateFn.indexOf('if (alive || rec.attachedAt !== undefined) {')
  const derivedAt = reactivateFn.indexOf('const kit = args.kit ?? args.preset?.kit ?? deriveSessionKitForWorkspace(rec.workspaceId)')
  check('D7 the reactivate computes carried-else-preset-else-derived ONCE, AFTER the live-hop return (a hop never derives), and both roads re-stamp it unguarded', hopReturn !== -1 && derivedAt > hopReturn && reactivateFn.split('restampSessionKit(next, kit, kitSource, args.by)').length === 2 && reactivateFn.split('restampSessionKit(w, kit, kitSource, args.by)').length === 2 && !reactivateFn.includes('if (args.kit !== undefined)'))
  // Restore the global user scope for the sections after this one.
  saveGlobalConfig(c => ({ ...c, mcpServers: {} as never }))
}

console.log("H — the membership handoff: kitMembership consulted BY the one owner (KIT-RUNNER's swap, landed) (poison: an unresolved kit's lists read as membership; the live record consulted for a kit-bearing session)")
{
  const membership = await import('../../src/services/mcp/membership.ts')
  // The cwd store still has 'srv-here' off (§W wrote it through the cwd pen).
  check("H1 NO kit ⇒ today's record predicate, unchanged (a pre-kit record, a warm boot before its claim)", membership.kitMembership(undefined, 'srv-here') === false && membership.kitMembership(undefined, 'alpha') === true && membership.isMcpCatalogueMember('srv-here') === false)
  check('H2 a RESOLVED kit ⇒ the listed names ARE the members and nothing else is', membership.kitMembership(K1, 'alpha') === true && membership.kitMembership(K1, 'ext:tools-ext:probe') === true && membership.kitMembership(K1, 'zeta') === false)
  check('H3 an EMPTY resolved kit admits NOTHING (empty ≠ absent — the deadliest confusion, pinned at the predicate)', membership.kitMembership(EMPTY, 'alpha') === false && membership.kitMembership(undefined, 'alpha') === true)
  const listsSrvHere: Kit = { schema: 1, mcp: ['srv-here'], skills: [], invocable: [] }
  check("H4 POISON armed (the live-session law): a resolved kit never consults the live record — the record has 'srv-here' off, the kit lists it, the answer is the kit's", membership.kitMembership(listsSrvHere, 'srv-here') === true)
  const unresolvedOff: Kit = { schema: 1, mcp: ['a'], skills: [], invocable: [], resolved: false, deltas: { mcpOff: ['a'], skillStates: {}, extensionsOff: [] } }
  const unresolvedEmpty: Kit = { schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: { mcpOff: [], skillStates: {}, extensionsOff: [] } }
  check("H5 POISON armed (the lead-ruled law): an UNRESOLVED kit's lists are NEVER read as membership — its provisional list names 'a' yet the delta says off ⇒ not a member; an empty provisional list is not 'nothing' ⇒ a member", membership.kitMembership(unresolvedOff, 'a') === false && membership.kitMembership(unresolvedEmpty, 'zeta') === true)
  check("H6 an unresolved kit reads its OWN deltas, never the live record ('srv-here' is off on the record, absent from the deltas ⇒ a member)", membership.kitMembership(unresolvedEmpty, 'srv-here') === true)
  const src = read('src/services/mcp/membership.ts')
  check("H7 THE SWAP LANDED (this pin flipped deliberately with that lane): the owner consults the process latch — kit absent ⇒ today's record predicate verbatim; kit present ⇒ organs, then kitMembership", src.includes('THE SWAP POINT (landed') && src.includes('const kit = sessionKitOf') && src.includes('if (kit === undefined) return recordMembership(name)') && src.includes('return isMcpOrgan(name) || kitMembership(kit, name)') && src.includes('return !isMcpServerDisabled(name)') && src.includes('export function kitMembership('))
  const callers = spawnSync('grep', ['-rln', 'kitMembership(', join(SRC_ROOT, 'src')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(p => p.slice(SRC_ROOT.length + 1)).sort()
  // H8 re-amended: the dial's reconcile delta (kitDial.ts) is
  // the THIRD lawful speaker — the live connect/disconnect delta must speak
  // the SAME predicate the owner and the composer speak (a second spelling
  // of membership at the reconcile would be the poison this census exists
  // to catch). Still no connect road among them: every connect road follows
  // through isMcpCatalogueMember.
  check("H8 kitMembership has exactly THREE speakers and no connect road among them: the owner's own body (the swap), the completion composer, and the dial's reconcile delta (kitDial REUSES the one predicate — a re-spelling there would be the poison); every connect road still follows through isMcpCatalogueMember", deepEq(callers, ['src/services/mcp/kitCompletion.ts', 'src/services/mcp/kitDial.ts', 'src/services/mcp/membership.ts']), callers.join(','))
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nsession-kit: GREEN' : `\nsession-kit: RED (${failures} failing)`)
process.exit(failures === 0 ? 0 : 1)
