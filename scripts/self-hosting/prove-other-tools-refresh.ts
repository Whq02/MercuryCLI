#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'other-tools-refresh-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { enableConfigs } = await import(join(repo, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { getEmptyToolPermissionContext } = await import(join(repo, 'src/Tool.ts'))
const { getInstructionFiles, getInstructionCompositionState, resetInstructionFilesCache, clearInstructionFileCaches } = await import(join(repo, 'src/services/instructions/engine.ts'))
const { setSessionInstructionProfile } = await import(join(repo, 'src/services/instructions/profile.ts'))
const { getInstructionListing, listingRowWords } = await import(join(repo, 'src/services/instructions/listing.ts'))
const { getUserContext } = await import(join(repo, 'src/context.ts'))
const { getNestedMemoryAttachmentsForFile } = await import(join(repo, 'src/utils/attachments/nestedMemory.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(repo, 'src/utils/fileStateCache.ts'))
const cwd = process.cwd()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const reading = async (file: string): Promise<{ paths: string[]; first: string; composed: boolean; attached: string[]; listed: string[] }> => {
  getUserContext.cache?.clear?.()
  const files = await getInstructionFiles()
  const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
  const attached = (await getNestedMemoryAttachmentsForFile(join(cwd, file), context as never, state)).map((a: any) => a.path)
  const listed = (await getInstructionListing()).map((row: any) => listingRowWords(row, row.path.replace(cwd, '.'), () => false))
  return { paths: files.map((f: any) => f.path), first: (await getUserContext()).instructions ?? '', composed: getInstructionCompositionState().fallbackComposed, attached, listed }
}
const steps: Record<string, unknown> = {}
steps.start = await reading('src/a.ts')
writeFileSync(join(cwd, 'MERCURY.md'), 'native-needle\\n')
steps.unrefreshed = { paths: (await getInstructionFiles()).map((f: any) => f.path) }
resetInstructionFilesCache('session_start')
steps.decided = await reading('src/b.ts')
rmSync(join(cwd, 'MERCURY.md'))
clearInstructionFileCaches()
steps.undecided = await reading('src/c.ts')
setSessionInstructionProfile('native')
clearInstructionFileCaches()
steps.native = await reading('src/d.ts')
setSessionInstructionProfile(null)
clearInstructionFileCaches()
steps.auto = await reading('src/e.ts')
writeFileSync(join(cwd, '.cursor/rules/c-new.mdc'), '---\\nalwaysApply: true\\n---\\nnew-always-needle\\n')
writeFileSync(join(cwd, 'GEMINI.md'), 'edited-guide-needle\\n')
resetInstructionFilesCache('compact')
steps.edited = await reading('src/f.ts')
await new Promise(resolve => setTimeout(resolve, 5200))
clearInstructionFileCaches()
steps.aged = await reading('src/f.ts')
writeFileSync(process.argv[2]!, JSON.stringify(steps))
`)

type Reading = { paths: string[]; first: string; composed: boolean; attached: string[]; listed: string[] }

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

try {
  const project = join(scratch, 'project')
  const layout: Record<string, string> = {
    'AGENTS.md': 'agents-needle\n',
    'GEMINI.md': 'guide-needle\n',
    '.cursor/rules/a-always.mdc': '---\nalwaysApply: true\n---\nalways-needle\n',
    '.cursor/rules/b-scoped.mdc': '---\nglobs: src/**\nalwaysApply: false\n---\nscoped-needle\n',
    ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(name => [`src/${name}.ts`, '\n'])),
  }
  for (const [rel, content] of Object.entries(layout)) {
    mkdirSync(dirname(join(project, rel)), { recursive: true })
    writeFileSync(join(project, rel), content)
  }
  const config = join(scratch, 'config')
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  seedFirstRun(config, [project])
  const result = join(scratch, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: project,
    env: { ...env, HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: config, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  const steps = JSON.parse(readFileSync(result, 'utf8')) as Record<'start' | 'decided' | 'undecided' | 'native' | 'auto' | 'edited' | 'aged', Reading> & { unrefreshed: { paths: string[] } }
  const at = (rel: string): string => join(project, rel)
  const OTHERS = [at('AGENTS.md'), at('GEMINI.md'), at('.cursor/rules/a-always.mdc')]
  const scoped = [at('.cursor/rules/b-scoped.mdc')]
  const same = (got: string[], want: string[]): boolean => JSON.stringify(got) === JSON.stringify(want)
  const loads = (reading: Reading): boolean => same(reading.paths, OTHERS) && reading.composed && same(reading.attached, scoped) && ['agents-needle', 'guide-needle', 'always-needle'].every(needle => reading.first.includes(needle))

  console.log('one session, the instruction caches reset between each step')
  check("at the start the other tools' files load and a matching file attaches the scoped rule", loads(steps.start), JSON.stringify(steps.start).slice(0, 600))
  check('a MERCURY.md written into the project changes nothing until the caches are reset', same(steps.unrefreshed.paths, OTHERS), steps.unrefreshed.paths.join(' '))
  check('after the reset MERCURY.md decides: it alone loads, a matching file attaches nothing, and each other file says which import brings it back', same(steps.decided.paths, [at('MERCURY.md')]) && !steps.decided.composed && steps.decided.attached.length === 0 && steps.decided.first.includes('native-needle') && !steps.decided.first.includes('guide-needle') && steps.decided.listed.length === 3 && steps.decided.listed.every(row => row.includes('not loaded: MERCURY.md decides; import it with @')), JSON.stringify(steps.decided).slice(0, 700))
  check('with MERCURY.md removed and the caches cleared the others load again and the scoped rule attaches again', loads(steps.undecided), JSON.stringify(steps.undecided).slice(0, 600))
  check('switched to the native profile in the session, nothing of another tool loads, attaches or is listed', steps.native.paths.length === 0 && steps.native.first === '' && steps.native.attached.length === 0 && steps.native.listed.length === 0, JSON.stringify(steps.native).slice(0, 600))
  check('switched back, they load again', loads(steps.auto), JSON.stringify(steps.auto).slice(0, 600))
  check('a guide edited is read as edited at the reset a fold makes', steps.edited.first.includes('edited-guide-needle') && steps.edited.composed && same(steps.edited.attached, scoped), JSON.stringify(steps.edited).slice(0, 700))
  check("a rule added to a rules folder is read once the folder's five-second listing has aged, as in Mercury's own rules folder", same(steps.aged.paths, [...OTHERS, at('.cursor/rules/c-new.mdc')]) && steps.aged.first.includes('new-always-needle'), steps.aged.paths.join(' '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`other-tools-refresh: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
