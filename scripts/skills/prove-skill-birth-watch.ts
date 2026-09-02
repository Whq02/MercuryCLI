#!/usr/bin/env bun
// ============================================================================
//  prove-skill-birth-watch — a skills directory that does not exist yet is
//  watched into existence: creating the FIRST skill mid-session applies
//  without a restart (release-hardening audit rank 28).
//
//  The gap: armWatcher added a path only through an existsSync gate, and
//  getProjectSkillsWatchPaths delegated to a derivation that itself
//  filtered on existence. Nothing watched the parent .mercury directory or
//  the project root, so the creation of <project>/.mercury/skills produced
//  no event: the new skill was never announced, never entered the command
//  table, and /name and the Skill tool answered "Unknown skill" for the
//  rest of the session. In the total case (no user-level skills or
//  commands directories either) targets was empty, armWatcher returned
//  early while initialize() had latched, and NO watcher existed at all —
//  no later skill edit anywhere refreshed the catalogue. The REPL's second
//  watcher (useSkillsChange) had the same existsSync hole.
//
//   L1 the total case: a fresh home with no skills dirs and a project with
//      no .mercury — creating <proj>/.mercury/skills/<name>/SKILL.md
//      mid-session fires the change signal (pre-fix: no watcher at all)
//   L2 control: an EXISTING skills directory still hot-reloads a touched
//      SKILL.md (the road that always worked)
//   L3 the watch-path derivation no longer filters on existence
//      (module-driven: a missing candidate is still derived)
//   L4 the REPL's second watcher arms for missing candidates too
//      (structural: the birth arm in useSkillsChange)
//
//  Real chokidar, real filesystem, tightened timing seams. PROVE_SRC names
//  another checkout's src (the A/B control: L1, L3 and L4 read red there).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

const root = mkdtempSync(join(tmpdir(), 'skill-birth-'))
const home = join(root, 'home')
const project = join(root, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.chdir(project)

const detector = await import(join(SRC, 'utils/skills/skillChangeDetector.ts'))
const projectConfig = await import(join(SRC, 'utils/projectConfig.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await sleep(100)
  }
  return pred()
}

// Tight timing for the proof (coarse defaults would stretch it to minutes).
await detector.resetForTesting({ debounceMs: 50, stabilityThresholdMs: 120, pollIntervalMs: 100, bunPollIntervalMs: 250 })

// ── L1: the total case ─────────────────────────────────────────────────────
console.log('L1 the total case — no skills dir anywhere, the first skill created mid-session applies')
{
  let signals = 0
  const unsubscribe = detector.subscribe(() => {
    signals++
  })
  await detector.initialize()
  await sleep(400) // the watcher settles on its (birth-only) roots
  const skillDir = join(project, '.mercury', 'skills', 'my-first-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: my-first-skill\ndescription: first\n---\nbody\n')
  const fired = await waitFor(() => signals > 0, 8_000)
  t('creating the first skill fires the change signal', fired, `signals=${signals} after 8s`)
  unsubscribe()
}

// ── L2: control — an existing dir still hot-reloads ────────────────────────
console.log('L2 control — an existing skills directory still hot-reloads')
{
  // Re-arm on the current ground (the dir now exists; L1 already re-armed,
  // but make it explicit and generation-fresh).
  await detector.rearmWatchRoots()
  let signals = 0
  const unsubscribe = detector.subscribe(() => {
    signals++
  })
  await sleep(400)
  writeFileSync(join(project, '.mercury', 'skills', 'my-first-skill', 'SKILL.md'), '---\nname: my-first-skill\ndescription: edited\n---\nnew body\n')
  const fired = await waitFor(() => signals > 0, 8_000)
  t('touching an existing SKILL.md fires the change signal', fired, `signals=${signals} after 8s`)
  unsubscribe()
}
await detector.dispose()

// ── L3: the derivation ─────────────────────────────────────────────────────
console.log('L3 the watch-path derivation sees candidates that do not exist')
{
  const missingRoot = join(root, 'elsewhere')
  mkdirSync(missingRoot, { recursive: true })
  const paths = projectConfig.projectConfigCandidatePaths?.(missingRoot, 'skills') as string[] | undefined
  t('projectConfigCandidatePaths exists and derives the missing candidate', Array.isArray(paths) && paths.length > 0 && paths.every((p: string) => p.includes('.mercury')), JSON.stringify(paths ?? null))
}

// ── L4: the REPL's second watcher (structural) ─────────────────────────────
console.log('L4 the REPL watcher arms for missing candidates too')
{
  const hook = readFileSync(join(SRC, 'hooks/useSkillsChange.ts'), 'utf8')
  t('it derives unfiltered candidates', hook.includes('projectConfigCandidatePaths(cwd,'))
  t('it walks to the nearest existing ancestor for a missing candidate', hook.includes('while (!existsSync(ancestor))'))
  t('a birth re-arms and rescans', hook.includes('if (existsSync(dir)) rescan(true)'))
}

console.log(failures === 0 ? 'SKILL BIRTH WATCH: ALL PASS' : 'SKILL BIRTH WATCH: RED')
process.exit(failures)
