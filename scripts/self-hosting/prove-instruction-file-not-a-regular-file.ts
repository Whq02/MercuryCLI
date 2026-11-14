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
type Plan = { files?: Record<string, string>; pipes?: string[]; links?: Record<string, string>; touch?: string[] }

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

let worlds = 0
function drive({ files = {}, pipes = [], links = {}, touch = [] }: Plan): Drive {
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
const loads = (d: Drive, rels: string[]): boolean => d.answered && JSON.stringify(d.files) === JSON.stringify(rels.map(rel => join(d.project, rel)))
const told = (d: Drive): string => (d.answered ? d.files.join(' ') : 'the load did not answer within 20 s')

try {
  console.log('a named pipe where an instruction file is looked for is passed over, and the load answers')
  const native = drive({ pipes: ['MERCURY.md'], files: { 'MERCURY.local.md': 'local-needle\n' } })
  check("Mercury's own guide as a pipe: the load answers and the personal layer beside it loads", loads(native, ['MERCURY.local.md']), told(native))
  const shared = drive({ pipes: ['AGENTS.md'], files: { 'GEMINI.md': 'guide-needle\n' } })
  check('AGENTS.md as a pipe: the load answers and the guide beside it loads', loads(shared, ['GEMINI.md']), told(shared))
  const other = drive({ pipes: ['GEMINI.md', '.github/copilot-instructions.md'], files: { 'AGENTS.md': 'agents-needle\n' } })
  check("another tool's guides as pipes: the load answers and AGENTS.md loads", loads(other, ['AGENTS.md']), told(other))
  const linked = drive({ pipes: ['pipes/guide'], links: { 'GEMINI.md': 'pipes/guide' }, files: { 'AGENTS.md': 'agents-needle\n' } })
  check('a link that leads to a pipe: the load answers and AGENTS.md loads', loads(linked, ['AGENTS.md']), told(linked))
  const imported = drive({ pipes: ['notes/pipe.md', '.cursor/rules/pipe.mdc'], files: { 'MERCURY.md': 'native-needle\n@notes/pipe.md\n@.cursor/rules/pipe.mdc\n@notes/real.md\n', 'notes/real.md': 'imported-needle\n' } })
  check('an imported file and an imported rule as pipes: the load answers and the import beside them loads', loads(imported, ['MERCURY.md', 'notes/real.md']), told(imported))
  const rules = drive({ pipes: ['.cursorrules', '.clinerules', '.cursor/rules/pipe.mdc'], files: { '.cursor/rules/real.mdc': '---\nalwaysApply: true\n---\nalways-needle\n' } })
  check('rule files as pipes: the load answers and the rule beside them loads', loads(rules, ['.cursor/rules/real.mdc']), told(rules))
  const nested = drive({ pipes: ['sub/AGENTS.md', 'sub/GEMINI.md'], files: { 'README.md': 'x\n', 'sub/a.ts': '\n', 'sub/.cursorrules': 'nested-needle\n' }, touch: ['sub/a.ts'] })
  check('guides of a nested folder as pipes: reading a file there answers and the rule file beside them attaches', nested.answered && JSON.stringify(nested.attached) === JSON.stringify([join(nested.project, 'sub/.cursorrules')]), nested.answered ? nested.attached.join(' ') : 'the read did not answer within 20 s')

  console.log('a link that leads to a regular file still loads')
  const real = drive({ files: { 'shared/guide.md': 'linked-needle\n' }, links: { 'GEMINI.md': 'shared/guide.md' } })
  check('the linked guide loads', loads(real, ['GEMINI.md']), told(real))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`instruction-file-not-a-regular-file: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
