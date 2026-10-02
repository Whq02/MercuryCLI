#!/usr/bin/env bun
// gate-watch: src/services/instructions/** src/projectOnboardingState.ts src/utils/cockpit/repoSurfaceMap.ts src/context.ts src/utils/attachments/nestedMemory.ts src/utils/config/trust.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shared-guide-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import(${JSON.stringify(join(repo, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
const { getEmptyToolPermissionContext } = await import(${JSON.stringify(join(repo, 'src/Tool.ts'))})
const { getInstructionFiles, composeInstructionPrompt, getInstructionBundle, isInstructionFilePath } = await import(${JSON.stringify(join(repo, 'src/services/instructions/engine.ts'))})
const { getUserContext } = await import(${JSON.stringify(join(repo, 'src/context.ts'))})
const { getNestedMemoryAttachmentsForFile } = await import(${JSON.stringify(join(repo, 'src/utils/attachments/nestedMemory.ts'))})
const { createFileStateCacheWithSizeLimit } = await import(${JSON.stringify(join(repo, 'src/utils/fileStateCache.ts'))})
const { getSteps } = await import(${JSON.stringify(join(repo, 'src/projectOnboardingState.ts'))})
const { hasOrientationDoc } = await import(${JSON.stringify(join(repo, 'src/utils/cockpit/repoSurfaceMap.ts'))})
const cwd = process.cwd()
const files = await getInstructionFiles()
const composed = composeInstructionPrompt(files)
const bundle = await getInstructionBundle()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const touched = process.env.DRV_TOUCH ? await getNestedMemoryAttachmentsForFile(process.env.DRV_TOUCH, context as never, state) : []
writeFileSync(process.argv[2]!, JSON.stringify({
  paths: files.map(f => f.path),
  composed,
  resolution: bundle.resolution.resolved,
  entries: bundle.entries.map(e => ({ path: e.path, family: e.family, origin: e.origin, parent: e.parent, root: e.root })),
  user: (await getUserContext()).instructions ?? '',
  touched: touched.map(a => a.path),
  guideStepComplete: getSteps().find(s => s.key === 'mercurymd')?.isComplete ?? null,
  oriented: hasOrientationDoc(cwd),
  classified: isInstructionFilePath(join(cwd, 'AGENTS.md')),
}))
`)

type Drive = {
  paths: string[]
  composed: string
  resolution: string
  entries: Array<{ path: string; family: string; origin: string; parent?: string; root?: string }>
  user: string
  touched: string[]
  guideStepComplete: boolean | null
  oriented: boolean
  classified: boolean
}

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

let projects = 0
function project(layout: Record<string, string>): string {
  const root = join(scratch, `project-${++projects}`)
  for (const [rel, content] of Object.entries(layout)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  mkdirSync(root, { recursive: true })
  return root
}

function drive(cwd: string, options: { touch?: string; settings?: object; untrusted?: boolean; trust?: string } = {}): Drive {
  const home = mkdtempSync(join(scratch, 'home-'))
  seedFirstRun(home, options.untrusted ? [] : [options.trust ?? cwd])
  if (options.settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(options.settings))
  const result = join(home, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd,
    env: { ...env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ...(options.touch ? { DRV_TOUCH: options.touch } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  return JSON.parse(readFileSync(result, 'utf8')) as Drive
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

try {
  console.log('§1 a project whose only guide is AGENTS.md composes it')
  const shared = project({ 'AGENTS.md': 'shared-guide-needle\n', 'src/a.ts': 'export const a = 1\n' })
  const s1 = drive(shared)
  check('the default profile resolves as itself (auto)', s1.resolution === 'auto', s1.resolution)
  check('AGENTS.md composes into the project scope', s1.paths.includes(join(shared, 'AGENTS.md')), s1.paths.join(', '))
  check('the composed prompt carries its content once', count(s1.composed, 'shared-guide-needle') === 1, s1.composed.slice(0, 200))
  check('the user context the model reads carries it', s1.user.includes('shared-guide-needle'))
  const entry = s1.entries.find(e => e.path === join(shared, 'AGENTS.md'))
  check('the bundle entry is tagged shared, from the project walk, root-stamped', entry?.family === 'shared' && entry.origin === 'project-walk' && entry.root === shared, JSON.stringify(entry))
  check('the first-run guide step counts the composed AGENTS.md as the project guide', s1.guideStepComplete === true)
  check('the surface-map gate sees the composed guide (no map for a guided repo)', s1.oriented === true)
  check('AGENTS.md classifies as an instruction file (watch, compaction restore)', s1.classified === true)

  console.log('§2 MERCURY.md beside AGENTS.md: MERCURY.md alone')
  const both = project({ 'MERCURY.md': 'native-guide-needle\n', 'AGENTS.md': 'shared-guide-needle\n' })
  const s2 = drive(both)
  check('MERCURY.md composes', s2.composed.includes('native-guide-needle'))
  check('AGENTS.md does not compose when a MERCURY.md exists', !s2.composed.includes('shared-guide-needle'), s2.paths.join(', '))
  check('no shared-family entry in the bundle', s2.entries.every(e => e.family !== 'shared'))
  check('the project scope holds the native guide alone', s2.entries.filter(e => e.origin === 'project-walk').length === 1, JSON.stringify(s2.entries))

  console.log('§3 an explicit @AGENTS.md import in MERCURY.md composes it exactly once')
  const imported = project({ 'MERCURY.md': '@AGENTS.md\nnative-guide-needle\n', 'AGENTS.md': 'shared-guide-needle\n' })
  const s3 = drive(imported)
  check('both needles compose', s3.composed.includes('native-guide-needle') && count(s3.composed, 'shared-guide-needle') === 1, s3.paths.join(', '))
  const viaImport = s3.entries.find(e => e.path === join(imported, 'AGENTS.md'))
  check('the imported AGENTS.md rides the native import chain, parent MERCURY.md', viaImport?.parent === join(imported, 'MERCURY.md') && viaImport.family === 'native', JSON.stringify(viaImport))

  console.log('§4 a MERCURY.md above the working directory keeps AGENTS.md out')
  const parent = project({ 'MERCURY.md': 'parent-guide-needle\n', 'app/AGENTS.md': 'shared-guide-needle\n', 'app/src/a.ts': '\n', 'app/sub/AGENTS.md': 'nested-shared-needle\n', 'app/sub/file.ts': '\n' })
  const s4 = drive(join(parent, 'app'), { trust: parent })
  check('the parent MERCURY.md composes', s4.composed.includes('parent-guide-needle'), s4.paths.join(', '))
  check("the working directory's AGENTS.md does not compose", !s4.composed.includes('shared-guide-needle'))
  check('the guide step stays open: that AGENTS.md is not the project guide', s4.guideStepComplete === false)
  check('the surface-map gate reads the working directory as unguided', s4.oriented === false)

  console.log('§5 the native profile never composes AGENTS.md')
  const s5 = drive(shared, { settings: { briefs: { profile: 'native' } } })
  check('the profile resolves native', s5.resolution === 'native', s5.resolution)
  check('AGENTS.md does not compose', !s5.composed.includes('shared-guide-needle'), s5.paths.join(', '))
  check('the guide step stays open under native', s5.guideStepComplete === false)
  check('the surface-map gate follows the profile: the repo counts as unguided', s5.oriented === false)
  check('AGENTS.md is not an instruction file under native', s5.classified === false)

  console.log('§6 nested AGENTS.md attaches on touch where the directory holds no MERCURY.md')
  const nested = project({ 'AGENTS.md': 'root-shared-needle\n', 'sub/AGENTS.md': 'nested-shared-needle\n', 'sub/file.ts': '\n', 'mixed/MERCURY.md': 'nested-native-needle\n', 'mixed/AGENTS.md': 'nested-shared-needle\n', 'mixed/file.ts': '\n' })
  const s6 = drive(nested, { touch: join(nested, 'sub/file.ts') })
  check('the boot walk does not descend into nested guides', !s6.paths.includes(join(nested, 'sub/AGENTS.md')), s6.paths.join(', '))
  check('touching a file under a directory with only AGENTS.md attaches it', s6.touched.includes(join(nested, 'sub/AGENTS.md')), s6.touched.join(', '))
  const s6b = drive(nested, { touch: join(nested, 'mixed/file.ts') })
  check('a nested directory holding both attaches MERCURY.md only', s6b.touched.includes(join(nested, 'mixed/MERCURY.md')) && !s6b.touched.includes(join(nested, 'mixed/AGENTS.md')), s6b.touched.join(', '))
  const guided = project({ 'MERCURY.md': 'native-guide-needle\n', 'sub/AGENTS.md': 'nested-shared-needle\n', 'sub/file.ts': '\n' })
  const s6c = drive(guided, { touch: join(guided, 'sub/file.ts') })
  check('a project guided by MERCURY.md attaches no nested AGENTS.md on touch', s6c.touched.length === 0, s6c.touched.join(', '))
  const guidedBoth = project({ 'MERCURY.md': 'native-guide-needle\n', 'AGENTS.md': 'shared-guide-needle\n', 'sub/AGENTS.md': 'nested-shared-needle\n', 'sub/file.ts': '\n' })
  const s6d = drive(guidedBoth, { touch: join(guidedBoth, 'sub/file.ts') })
  check('with both guides at the root, MERCURY.md alone: no nested AGENTS.md attaches on touch', s6d.touched.length === 0, s6d.touched.join(', '))
  const s6e = drive(join(parent, 'app'), { trust: parent, touch: join(parent, 'app/sub/file.ts') })
  check('a MERCURY.md above the working directory keeps a nested AGENTS.md out on touch', s6e.touched.length === 0, s6e.touched.join(', '))

  console.log('§7 the exclusion list reaches AGENTS.md')
  const s7 = drive(shared, { settings: { briefs: { exclude: ['**/AGENTS.md'] } } })
  check('an excluded AGENTS.md composes nothing', !s7.composed.includes('shared-guide-needle'), s7.paths.join(', '))
  check('the guide step stays open over an excluded AGENTS.md', s7.guideStepComplete === false)
  check('the surface-map gate reads a repo whose only guide is excluded as unguided', s7.oriented === false)

  console.log('§8 the trust gate applies headless: an untrusted root composes nothing')
  const s8 = drive(shared, { untrusted: true })
  check('no project guide composes in a folder the operator never trusted', !s8.composed.includes('shared-guide-needle') && s8.paths.every(p => !p.startsWith(shared)), s8.paths.join(', '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`shared-guide-composition: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
