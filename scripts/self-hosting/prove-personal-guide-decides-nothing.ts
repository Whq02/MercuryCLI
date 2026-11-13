#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'personal-guide-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import(${JSON.stringify(join(repo, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
const { getEmptyToolPermissionContext } = await import(${JSON.stringify(join(repo, 'src/Tool.ts'))})
const { getInstructionFiles, composeInstructionPrompt, getInstructionBundle, getInstructionCompositionState, isInstructionFilePath } = await import(${JSON.stringify(join(repo, 'src/services/instructions/engine.ts'))})
const { getNestedMemoryAttachmentsForFile } = await import(${JSON.stringify(join(repo, 'src/utils/attachments/nestedMemory.ts'))})
const { createFileStateCacheWithSizeLimit } = await import(${JSON.stringify(join(repo, 'src/utils/fileStateCache.ts'))})
const { getSteps } = await import(${JSON.stringify(join(repo, 'src/projectOnboardingState.ts'))})
const { composedGuideFilesAt } = await import(${JSON.stringify(join(repo, 'src/services/instructions/adapters/index.ts'))})
const { getMercuryHome } = await import(${JSON.stringify(join(repo, 'src/utils/envUtils.ts'))})
const cwd = process.cwd()
const files = await getInstructionFiles()
const bundle = await getInstructionBundle()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const touched = process.env.DRV_TOUCH ? await getNestedMemoryAttachmentsForFile(process.env.DRV_TOUCH, context as never, state) : []
writeFileSync(process.argv[2]!, JSON.stringify({
  home: getMercuryHome(),
  paths: files.map(f => f.path),
  composed: composeInstructionPrompt(files),
  entries: bundle.entries.map(e => ({ path: e.path, type: e.type, family: e.family })),
  fallbackComposed: getInstructionCompositionState().fallbackComposed,
  touched: touched.map(a => a.path),
  guideStepComplete: getSteps().find(s => s.key === 'mercurymd')?.isComplete ?? null,
  guides: composedGuideFilesAt(cwd),
  classified: isInstructionFilePath(join(cwd, 'AGENTS.md')),
}))
`)

type Drive = {
  home: string
  paths: string[]
  composed: string
  entries: Array<{ path: string; type: string; family: string }>
  fallbackComposed: boolean
  touched: string[]
  guideStepComplete: boolean | null
  guides: string[]
  classified: boolean
}

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

let worlds = 0
function world(layout: Record<string, string>): string {
  const home = join(scratch, `world-${++worlds}`, 'home')
  mkdirSync(home, { recursive: true })
  for (const [rel, content] of Object.entries(layout)) {
    const path = join(home, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return home
}

function drive(home: string, cwd: string, options: { configHome?: string; touch?: string; spelledHome?: string } = {}): Drive {
  const configHome = options.configHome ?? join(home, '.mercury')
  seedFirstRun(configHome, [cwd])
  const result = join(mkdtempSync(join(scratch, 'result-')), 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const spelled = options.spelledHome ?? home
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd,
    env: {
      ...env,
      HOME: spelled,
      USERPROFILE: spelled,
      ...(options.configHome ? { MERCURY_CONFIG_DIR: options.configHome } : {}),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      ...(options.touch ? { DRV_TOUCH: options.touch } : {}),
    },
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
  console.log('§1 the default home: a personal MERCURY.md, a project under home whose only guide is AGENTS.md')
  const home1 = world({ '.mercury/MERCURY.md': 'personal-needle\n', 'work/proj/AGENTS.md': 'shared-needle\n', 'work/proj/sub/AGENTS.md': 'nested-shared-needle\n', 'work/proj/sub/file.ts': '\n' })
  const proj1 = join(home1, 'work/proj')
  const d1 = drive(home1, proj1)
  check('the config home is the default one under that home', d1.home === join(home1, '.mercury'), d1.home)
  check('the personal guide composes, once, as the user layer', count(d1.composed, 'personal-needle') === 1 && d1.entries.find(e => e.path === join(home1, '.mercury/MERCURY.md'))?.type === 'User', JSON.stringify(d1.entries))
  check("the project's AGENTS.md composes: the personal guide decides nothing", count(d1.composed, 'shared-needle') === 1, d1.paths.join(', '))
  check('the chain chose the shared guide', d1.fallbackComposed === true)
  check('the personal layer composes before the project guide', d1.paths.indexOf(join(home1, '.mercury/MERCURY.md')) < d1.paths.indexOf(join(proj1, 'AGENTS.md')) && d1.paths.indexOf(join(home1, '.mercury/MERCURY.md')) >= 0, d1.paths.join(', '))
  check('the first-run guide step counts that AGENTS.md as the project guide', d1.guideStepComplete === true)
  check('the guide list of the working directory names it', JSON.stringify(d1.guides) === JSON.stringify([join(proj1, 'AGENTS.md')]), JSON.stringify(d1.guides))
  check('that AGENTS.md classifies as an instruction file', d1.classified === true)
  const d1t = drive(home1, proj1, { touch: join(proj1, 'sub/file.ts') })
  check('a nested AGENTS.md attaches when a file beside it is touched', d1t.touched.includes(join(proj1, 'sub/AGENTS.md')), d1t.touched.join(', '))

  console.log('§2 the control: the same files under a relocated config home')
  const home2 = world({ 'cfg/MERCURY.md': 'personal-needle\n', 'work/proj/AGENTS.md': 'shared-needle\n' })
  const d2 = drive(home2, join(home2, 'work/proj'), { configHome: join(home2, 'cfg') })
  check('the config home is the relocated one', d2.home === join(home2, 'cfg'), d2.home)
  check('both compose, each once', count(d2.composed, 'personal-needle') === 1 && count(d2.composed, 'shared-needle') === 1, d2.paths.join(', '))
  check('the chain chose the shared guide', d2.fallbackComposed === true)

  console.log("§3 a project's own MERCURY.md still decides under the default home")
  const home3 = world({ '.mercury/MERCURY.md': 'personal-needle\n', 'work/proj/MERCURY.md': 'native-needle\n', 'work/proj/AGENTS.md': 'shared-needle\n' })
  const d3 = drive(home3, join(home3, 'work/proj'))
  check('the personal and the project guide compose; AGENTS.md does not', d3.composed.includes('personal-needle') && d3.composed.includes('native-needle') && !d3.composed.includes('shared-needle'), d3.paths.join(', '))
  check('the chain did not choose the shared guide', d3.fallbackComposed === false)

  console.log('§4 a MERCURY.md in a folder between home and the project still decides')
  const home4 = world({ '.mercury/MERCURY.md': 'personal-needle\n', 'work/MERCURY.md': 'workspace-needle\n', 'work/proj/AGENTS.md': 'shared-needle\n' })
  const d4 = drive(home4, join(home4, 'work/proj'))
  check('the workspace guide composes and AGENTS.md does not', d4.composed.includes('workspace-needle') && !d4.composed.includes('shared-needle'), d4.paths.join(', '))

  console.log("§5 a guide kept in the project's own .mercury folder still decides")
  const home5 = world({ '.mercury/MERCURY.md': 'personal-needle\n', 'work/proj/.mercury/MERCURY.md': 'housed-needle\n', 'work/proj/AGENTS.md': 'shared-needle\n' })
  const d5 = drive(home5, join(home5, 'work/proj'))
  check('the housed guide composes and AGENTS.md does not', d5.composed.includes('housed-needle') && !d5.composed.includes('shared-needle'), d5.paths.join(', '))
  check('the chain did not choose the shared guide', d5.fallbackComposed === false)

  console.log('§6 the working directory is the home folder itself')
  const home6 = world({ '.mercury/MERCURY.md': 'personal-needle\n', 'AGENTS.md': 'shared-needle\n' })
  const d6 = drive(home6, home6)
  check('the personal guide composes once and stays the user layer', count(d6.composed, 'personal-needle') === 1 && d6.entries.find(e => e.path === join(home6, '.mercury/MERCURY.md'))?.type === 'User', JSON.stringify(d6.entries))
  check("the folder's AGENTS.md composes", count(d6.composed, 'shared-needle') === 1, d6.paths.join(', '))
  check('the guide list names the AGENTS.md, not the personal guide', JSON.stringify(d6.guides) === JSON.stringify([join(home6, 'AGENTS.md')]), JSON.stringify(d6.guides))

  if (process.platform !== 'win32') {
    console.log('§7 a home spelled through a link is the same home')
    const home7 = world({ '.mercury/MERCURY.md': 'personal-needle\n', 'work/proj/AGENTS.md': 'shared-needle\n' })
    const link = join(home7, '..', 'home-link')
    symlinkSync(home7, link)
    const d7 = drive(home7, join(home7, 'work/proj'), { spelledHome: link })
    check('the config home is spelled through the link', d7.home === join(link, '.mercury'), d7.home)
    check("the project's AGENTS.md composes beside the personal guide", count(d7.composed, 'shared-needle') === 1 && count(d7.composed, 'personal-needle') === 1, d7.paths.join(', '))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`personal-guide-decides-nothing: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
