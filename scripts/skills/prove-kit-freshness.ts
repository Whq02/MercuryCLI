// ============================================================================
//  prove-kit-freshness — the MCPs & Skills screen never shows a stale list
//  (operator ruling; this prover verifies the seam and never edits it).
//
//  THE CLASS (proven as the poison): the screen's real doors answer through
//  process-lifetime memos — the per-cwd skill loader above all — so an
//  enumeration without the fresh door keeps answering the FIRST read's
//  estate; a skill created afterwards (skill-forge → .mercury/skills/<name>)
//  never appears without a restart. THE FIX: enumerateKitCatalogueFresh
//  drops the loader/extension/connector/active-set memos before reading
//  (every open), and the screen re-arms the skill change-watcher on the
//  CURRENT ground (a projects-picker move never leaves it watching the old
//  repo) and re-enumerates on its signal while open.
//
//  Hermetic and cpu-pure: scratch config home + scratch grounds; real
//  loader doors; the watcher is armed over scratch dirs and disposed —
//  nothing spawns, no live FS event is awaited (event delivery is the
//  chat's own landed machinery; the ROOTS are what this lane changed).
//  Run:  ~/.bun/bin/bun run scripts/skills/prove-kit-freshness.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = mkdtempSync(join(tmpdir(), 'kit-freshness-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
const GROUND_A = join(SCRATCH, 'repo-a')
const GROUND_B = join(SCRATCH, 'repo-b')
mkdirSync(join(GROUND_A, '.mercury', 'skills'), { recursive: true })
mkdirSync(join(GROUND_B, '.mercury', 'skills'), { recursive: true })
process.chdir(GROUND_A)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SESSION_KIT
delete process.env.MERCURY_CLAUDEAI_MCP
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — freshness prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' KIT freshness — every open reads the estate as it IS')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const writeSkill = (ground: string, name: string): void => {
  mkdirSync(join(ground, '.mercury', 'skills', name), { recursive: true })
  writeFileSync(join(ground, '.mercury', 'skills', name, 'SKILL.md'), `---\ndescription: the ${name} freshness skill\n---\n\nBody of ${name}.\n`)
}
const hasLoaderSkill = (rows: ReadonlyArray<{ kind: string; name?: string }>, base: string): boolean =>
  rows.some(r => r.kind === 'skill' && (r.name === base || r.name?.endsWith(`:${base}`) === true))

// ── §1 the fresh door vs the stale memo (the operator's exact example) ──────
section('§1 a created skill appears on the NEXT enumeration — the stale memo is the poison')
{
  const cat = await import('../../src/services/kitMenu/kitCatalogue.ts')
  writeSkill(GROUND_A, 'first')
  const fresh1 = await cat.enumerateKitCatalogueFresh(GROUND_A)
  t('F1 the fresh door lists the estate as it is (skill "first" present on a first open)', hasLoaderSkill(fresh1.rows, 'first'))
  writeSkill(GROUND_A, 'second')
  const stale = await cat.enumerateKitCatalogue(GROUND_A)
  t('F2 POISON proven (the class this fix exists for): WITHOUT the fresh door the memo answers the old estate — "second" missing though it is on disk', !hasLoaderSkill(stale.rows, 'second'))
  const fresh2 = await cat.enumerateKitCatalogueFresh(GROUND_A)
  t('F3 the next OPEN lists it — a skill-forge creation appears without a restart', hasLoaderSkill(fresh2.rows, 'second') && hasLoaderSkill(fresh2.rows, 'first'))
  writeSkill(GROUND_A, 'third')
  const doorsUntouched = await cat.enumerateKitCatalogueFresh(GROUND_A, {
    mcpConfigs: async () => ({ servers: {} }),
    dirSkills: async () => [],
    extensionSkills: () => [],
    activeExtensions: () => [],
  })
  const stillStale = await cat.enumerateKitCatalogue(GROUND_A)
  t('F4 INJECTED doors never trigger the real clears (proofs and stills stay hermetic): the real memo still answers the pre-"third" estate afterwards', doorsUntouched.rows.some(r => r.kind === 'note') && !hasLoaderSkill(stillStale.rows, 'third'))
}

// ── §2 the watcher re-arms on the CURRENT ground ────────────────────────────
section('§2 the ground-move half: the watch roots follow the ground (the frozen-roots class)')
{
  const detector = await import('../../src/utils/skills/skillChangeDetector.ts')
  await detector.resetForTesting()
  let signalCount = 0
  const unsubscribe = detector.subscribe(() => {
    signalCount += 1
  })
  // macOS: mkdtemp answers /var/…, the derived roots realpath to
  // /private/var/… — compare canonical spellings (the symlink class).
  const { realpathSync } = await import('node:fs')
  const realA = realpathSync(GROUND_A)
  const realB = realpathSync(GROUND_B)
  const rootsA = (await detector.rearmWatchRoots()).map(p => realpathSync(p))
  t('F5 the re-arm derives the CURRENT ground\'s skill dirs (repo-a watched from repo-a)', rootsA.some(p => p.startsWith(realA)), rootsA.join(','))
  process.chdir(GROUND_B)
  const rootsB = (await detector.rearmWatchRoots()).map(p => realpathSync(p))
  t('F6 after a ground move the re-arm watches the NEW repo and drops the old (the frozen watcher was the bug: a skill created in the picked repo never fired the signal)', rootsB.some(p => p.startsWith(realB)) && !rootsB.some(p => p.startsWith(realA)), rootsB.join(','))
  t('F7 subscribers survive a re-arm (the signal is kept — only the roots move)', signalCount === 0 && typeof unsubscribe === 'function')
  unsubscribe()
  await detector.dispose()
  process.chdir(GROUND_A)
}

// ── §3 the wiring needles (the screen and the doors) ────────────────────────
section('§3 the seams stand in source')
{
  const screen = readFileSync(join(REPO, 'src', 'components', 'KitMenuScreen.tsx'), 'utf8')
  t('F8 the screen enumerates through the FRESH door on every open, re-arms the watcher on the current ground, subscribes while open and unsubscribes on close', screen.includes('enumerateKitCatalogueFresh(process.cwd())') && screen.includes('skillChangeDetector.rearmWatchRoots()') && screen.includes('skillChangeDetector.subscribe(enumerate)') && screen.includes('unsubscribe()'))
  const catalogue = readFileSync(join(REPO, 'src', 'services', 'kitMenu', 'kitCatalogue.ts'), 'utf8')
  t('F9 the fresh door drops all four memos (loader skills · extension catalogues · connector fetch · active set) and only for the REAL doors', catalogue.includes('clearSkillCaches()') && catalogue.includes('clearExtensionCommandCaches()') && catalogue.includes('clearClaudeAIMcpConfigsCache()') && catalogue.includes('publishActiveSet(null)') && catalogue.includes('doors === REAL_KIT_DOORS'))
  const det = readFileSync(join(REPO, 'src', 'utils', 'skills', 'skillChangeDetector.ts'), 'utf8')
  t('F10 the re-arm keeps the signal and the dynamic-skills registration (only the proof-reset clears them) and never double-registers the cleanup', !/rearmWatchRoots[\s\S]{0,400}changeSignal\.clear/.test(det) && det.includes('if (unregisterCleanup === null)') && det.includes('registerDynamicSkillsOnce()'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ KIT FRESHNESS PINS GREEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
