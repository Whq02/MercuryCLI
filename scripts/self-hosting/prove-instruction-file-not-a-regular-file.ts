#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'instruction-pipe-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
if (homedir() !== process.env.DRV_HOME) throw new Error('the home folder is ' + homedir() + ', not the scratch home of this proof')
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { enableConfigs } = await import(join(repo, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { getEmptyToolPermissionContext } = await import(join(repo, 'src/Tool.ts'))
const { getInstructionFiles } = await import(join(repo, 'src/services/instructions/engine.ts'))
const { getNestedMemoryAttachmentsForFile } = await import(join(repo, 'src/utils/attachments/nestedMemory.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(repo, 'src/utils/fileStateCache.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')
const files = await getInstructionFiles()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const attached: string[] = []
for (const file of plan.touch ?? []) attached.push(...(await getNestedMemoryAttachmentsForFile(file, context as never, state)).map((a: any) => a.path))
writeFileSync(process.argv[2]!, JSON.stringify({ files: files.map((f: any) => f.path), attached }))
`)

type Drive = { answered: boolean; files: string[]; attached: string[]; project: string }
type Plan = { files?: Record<string, string>; pipes?: string[]; links?: Record<string, string>; folders?: Record<string, string>; touch?: string[] }

let passed = 0
let failed = 0
let skipped = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const WIN = process.platform === 'win32'
const havePipe = !WIN
const haveLink = ((): boolean => {
  if (!WIN) return true
  writeFileSync(join(scratch, 'link-target'), '')
  try {
    symlinkSync(join(scratch, 'link-target'), join(scratch, 'link'))
    return true
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    return false
  }
})()

let worlds = 0
function drive({ files = {}, pipes = [], links = {}, folders = {}, touch = [] }: Plan): Drive {
  const world = join(scratch, `world-${++worlds}`)
  const project = join(world, 'project')
  const at = (rel: string): string => {
    mkdirSync(dirname(join(project, rel)), { recursive: true })
    return join(project, rel)
  }
  mkdirSync(project, { recursive: true })
  for (const [rel, content] of Object.entries(files)) writeFileSync(at(rel), content)
  for (const rel of pipes) execFileSync('mkfifo', [at(rel)])
  for (const [rel, target] of Object.entries(links)) symlinkSync(join(project, target), at(rel))
  for (const [rel, target] of Object.entries(folders)) symlinkSync(join(project, target), at(rel), 'junction')
  const config = join(world, 'config')
  const home = join(world, 'home')
  mkdirSync(home, { recursive: true })
  seedFirstRun(config, [project])
  const result = join(world, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: project,
    env: { ...env, HOME: home, USERPROFILE: home, DRV_HOME: home, MERCURY_CONFIG_DIR: config, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DRV_PLAN: JSON.stringify({ touch: touch.map(file => join(project, file)) }) },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (run.status !== 0) return { answered: false, files: [], attached: [], project }
  return { answered: true, ...(JSON.parse(readFileSync(result, 'utf8')) as { files: string[]; attached: string[] }), project }
}
const loads = (rels: string[]) => (d: Drive): boolean => d.answered && JSON.stringify(d.files) === JSON.stringify(rels.map(rel => join(d.project, rel)))
const told = (d: Drive): string => (d.answered ? d.files.join(' ') : 'the load did not answer within 20 s')

function scene(label: string, plan: Plan, holds: (d: Drive) => boolean, said: (d: Drive) => string = told): void {
  const missing = (plan.pipes ?? []).length > 0 && !havePipe ? 'no named pipe on this platform' : Object.keys(plan.links ?? {}).length > 0 && !haveLink ? 'this account may not make a symbolic link to a file (Windows asks for Developer Mode or the link privilege)' : null
  if (missing !== null) {
    skipped++
    console.log(`[SKIP] ${label} — ${missing}`)
    return
  }
  const d = drive(plan)
  check(label, holds(d), said(d))
}

try {
  console.log('a named pipe where an instruction file is looked for is passed over, and the load answers')
  scene("Mercury's own guide as a pipe: the load answers and the personal layer beside it loads", { pipes: ['MERCURY.md'], files: { 'MERCURY.local.md': 'local-needle\n' } }, loads(['MERCURY.local.md']))
  scene('AGENTS.md as a pipe: the load answers and the guide beside it loads', { pipes: ['AGENTS.md'], files: { 'GEMINI.md': 'guide-needle\n' } }, loads(['GEMINI.md']))
  scene("another tool's guides as pipes: the load answers and AGENTS.md loads", { pipes: ['GEMINI.md', '.github/copilot-instructions.md'], files: { 'AGENTS.md': 'agents-needle\n' } }, loads(['AGENTS.md']))
  scene('a link that leads to a pipe: the load answers and AGENTS.md loads', { pipes: ['pipes/guide'], links: { 'GEMINI.md': 'pipes/guide' }, files: { 'AGENTS.md': 'agents-needle\n' } }, loads(['AGENTS.md']))
  scene('an imported file and an imported rule as pipes: the load answers and the import beside them loads', { pipes: ['notes/pipe.md', '.cursor/rules/pipe.mdc'], files: { 'MERCURY.md': 'native-needle\n@notes/pipe.md\n@.cursor/rules/pipe.mdc\n@notes/real.md\n', 'notes/real.md': 'imported-needle\n' } }, loads(['MERCURY.md', 'notes/real.md']))
  scene('rule files as pipes: the load answers and the rule beside them loads', { pipes: ['.cursorrules', '.clinerules', '.cursor/rules/pipe.mdc'], files: { '.cursor/rules/real.mdc': '---\nalwaysApply: true\n---\nalways-needle\n' } }, loads(['.cursor/rules/real.mdc']))
  scene(
    'guides of a nested folder as pipes: reading a file there answers and the rule file beside them attaches',
    { pipes: ['sub/AGENTS.md', 'sub/GEMINI.md'], files: { 'README.md': 'x\n', 'sub/a.ts': '\n', 'sub/.cursorrules': 'nested-needle\n' }, touch: ['sub/a.ts'] },
    d => d.answered && JSON.stringify(d.attached) === JSON.stringify([join(d.project, 'sub/.cursorrules')]),
    d => (d.answered ? d.attached.join(' ') : 'the read did not answer within 20 s'),
  )

  console.log('a link that leads to a regular file still loads')
  scene('the linked guide loads', { files: { 'shared/guide.md': 'linked-needle\n' }, links: { 'GEMINI.md': 'shared/guide.md' } }, loads(['GEMINI.md']))
  scene('a guide reached through a linked folder loads', { files: { 'shared/gemini/GEMINI.md': 'linked-folder-needle\n' }, folders: { '.gemini': 'shared/gemini' } }, loads(['.gemini/GEMINI.md']))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`instruction-file-not-a-regular-file: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
process.exit(failed ? 1 : 0)
