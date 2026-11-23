import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'kit-freshness-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
const GROUND_A = join(SCRATCH, 'repo-a')
const GROUND_B = join(SCRATCH, 'repo-b')
mkdirSync(join(GROUND_A, '.mercury', 'skills'), { recursive: true })
mkdirSync(join(GROUND_B, '.mercury', 'skills'), { recursive: true })
writeFileSync(join(process.env.MERCURY_CONFIG_DIR, '.mercury.json'), JSON.stringify({ projects: Object.fromEntries([GROUND_A, GROUND_B, realpathSync(GROUND_A), realpathSync(GROUND_B)].map(ground => [ground, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) }))
process.chdir(GROUND_A)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SESSION_KIT
delete process.env.MERCURY_ANTHROPIC_CONNECTORS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — freshness prover exceeded 120s; look for a hung await in enumerateKitCatalogueFresh (src/screen/kit-menu-model/kitCatalogue.ts) or rearmWatchRoots / dispose (src/integrations/skill-watch/skillChangeDetector.ts)')
  process.exit(1)
}, 120_000)
watchdog.unref?.()


console.log('============================================================')
console.log(' KIT freshness — every open reads the estate as it IS')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const writeSkill = (ground: string, name: string): void => {
  mkdirSync(join(ground, '.mercury', 'skills', name), { recursive: true })
  writeFileSync(join(ground, '.mercury', 'skills', name, 'SKILL.md'), `---\ndescription: the ${name} freshness skill\n---\n\nBody of ${name}.\n`)
}
const hasLoaderSkill = (rows: ReadonlyArray<{ kind: string; name?: string }>, base: string): boolean =>
  rows.some(r => r.kind === 'skill' && (r.name === base || r.name?.endsWith(`:${base}`) === true))

section('§1 a created skill appears on the NEXT enumeration — the stale memo is the poison')
{
  const cat = await import('../../src/screen/kit-menu-model/kitCatalogue.ts')
  writeSkill(GROUND_A, 'first')
  const fresh1 = await cat.enumerateKitCatalogueFresh(GROUND_A)
  t('F1 the fresh door lists the estate as it is (skill "first" present on a first open)', hasLoaderSkill(fresh1.rows, 'first'), 'enumerateKitCatalogueFresh in src/screen/kit-menu-model/kitCatalogue.ts must list a skill written under .mercury/skills on its first call; check that refreshKitCatalogueDoors clears the skill caches and that the dirSkills door reads the directory')
  writeSkill(GROUND_A, 'second')
  const stale = await cat.enumerateKitCatalogue(GROUND_A)
  t('F2 POISON proven (the class this fix exists for): WITHOUT the fresh door the memo answers the old estate — "second" missing though it is on disk', !hasLoaderSkill(stale.rows, 'second'), 'enumerateKitCatalogue (src/screen/kit-menu-model/kitCatalogue.ts) listed a skill created after the last fresh read, so the skill memo no longer holds the old estate; this proof needs that memo to stay stale, so restore it or change the proof together with the fix')
  const fresh2 = await cat.enumerateKitCatalogueFresh(GROUND_A)
  t('F3 the next OPEN lists it — a skill-forge creation appears without a restart', hasLoaderSkill(fresh2.rows, 'second') && hasLoaderSkill(fresh2.rows, 'first'), 'enumerateKitCatalogueFresh in src/screen/kit-menu-model/kitCatalogue.ts must clear the skill memo on every call (refreshKitCatalogueDoors) so a skill created since the last open is listed, with the earlier skill still present')
  writeSkill(GROUND_A, 'third')
  const doorsUntouched = await cat.enumerateKitCatalogueFresh(GROUND_A, {
    mcpConfigs: async () => ({ servers: {} }),
    dirSkills: async () => [],
    extensionSkills: () => [],
    activeExtensions: () => [],
  })
  const stillStale = await cat.enumerateKitCatalogue(GROUND_A)
  t('F4 INJECTED doors never trigger the real clears (proofs and stills stay hermetic): the real memo still answers the pre-"third" estate afterwards', doorsUntouched.rows.some(r => r.kind === 'note') && !hasLoaderSkill(stillStale.rows, 'third'), 'enumerateKitCatalogueFresh in src/screen/kit-menu-model/kitCatalogue.ts must call refreshKitCatalogueDoors only when doors is REAL_KIT_DOORS, and an injected-doors catalogue must still carry a note row')
}

section('§2 the ground-move half: the watch roots follow the ground (the frozen-roots class)')
{
  const detector = await import('../../src/integrations/skill-watch/skillChangeDetector.ts')
  await detector.resetForTesting()
  let signalCount = 0
  const unsubscribe = detector.subscribe(() => {
    signalCount += 1
  })
  const { realpathSync } = await import('node:fs')
  const realA = realpathSync(GROUND_A)
  const realB = realpathSync(GROUND_B)
  const rootsA = (await detector.rearmWatchRoots()).map(p => realpathSync(p))
  t('F5 the re-arm derives the CURRENT ground\'s skill dirs (repo-a watched from repo-a)', rootsA.some(p => p.startsWith(realA)), `${rootsA.join(',')} — rearmWatchRoots in src/integrations/skill-watch/skillChangeDetector.ts must return the watch roots derived from the current working directory`)
  process.chdir(GROUND_B)
  const rootsB = (await detector.rearmWatchRoots()).map(p => realpathSync(p))
  t('F6 after a ground move the re-arm watches the NEW repo and drops the old (the frozen watcher was the bug: a skill created in the picked repo never fired the signal)', rootsB.some(p => p.startsWith(realB)) && !rootsB.some(p => p.startsWith(realA)), `${rootsB.join(',')} — rearmWatchRoots in src/integrations/skill-watch/skillChangeDetector.ts must close the old watcher and re-derive roots from the new working directory on each call`)
  t('F7 subscribers survive a re-arm (the signal is kept — only the roots move)', signalCount === 0 && typeof unsubscribe === 'function', 'subscribe in src/integrations/skill-watch/skillChangeDetector.ts must return an unsubscribe function, and rearmWatchRoots must keep the subscribers without firing them; signalCount was ' + signalCount)
  unsubscribe()
  await detector.dispose()
  process.chdir(GROUND_A)
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ KIT FRESHNESS PINS GREEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
