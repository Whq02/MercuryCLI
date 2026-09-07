#!/usr/bin/env bun
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

await detector.resetForTesting({ debounceMs: 50, stabilityThresholdMs: 120, pollIntervalMs: 100, bunPollIntervalMs: 250 })

console.log('L1 the total case — no skills dir anywhere, the first skill created mid-session applies')
{
  let signals = 0
  const unsubscribe = detector.subscribe(() => {
    signals++
  })
  await detector.initialize()
  await sleep(400)
  const skillDir = join(project, '.mercury', 'skills', 'my-first-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: my-first-skill\ndescription: first\n---\nbody\n')
  const fired = await waitFor(() => signals > 0, 8_000)
  t('creating the first skill fires the change signal', fired, `signals=${signals} after 8s`)
  unsubscribe()
}

console.log('L2 control — an existing skills directory still hot-reloads')
{
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

console.log('L3 the watch-path derivation sees candidates that do not exist')
{
  const missingRoot = join(root, 'elsewhere')
  mkdirSync(missingRoot, { recursive: true })
  const paths = projectConfig.projectConfigCandidatePaths?.(missingRoot, 'skills') as string[] | undefined
  t('projectConfigCandidatePaths exists and derives the missing candidate', Array.isArray(paths) && paths.length > 0 && paths.every((p: string) => p.includes('.mercury')), JSON.stringify(paths ?? null))
}

console.log('L4 the REPL watcher arms for missing candidates too')
{
  const hook = readFileSync(join(SRC, 'hooks/useSkillsChange.ts'), 'utf8')
  t('it derives unfiltered candidates', hook.includes('projectConfigCandidatePaths(cwd,'))
  t('it walks to the nearest existing ancestor for a missing candidate', hook.includes('while (!existsSync(ancestor))'))
  t('a birth re-arms and rescans', hook.includes('if (existsSync(dir)) rescan()'))
}

console.log(failures === 0 ? 'SKILL BIRTH WATCH: ALL PASS' : 'SKILL BIRTH WATCH: RED')
process.exit(failures)
