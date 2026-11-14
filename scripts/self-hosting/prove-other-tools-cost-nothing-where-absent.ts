#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'other-tools-cost-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { enableConfigs } = await import(join(repo, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { getEmptyToolPermissionContext } = await import(join(repo, 'src/Tool.ts'))
const { getInstructionFiles } = await import(join(repo, 'src/services/instructions/engine.ts'))
const { conventionsForProfile } = await import(join(repo, 'src/services/instructions/compositionOrder.ts'))
const { getNestedMemoryAttachmentsForFile } = await import(join(repo, 'src/utils/attachments/nestedMemory.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(repo, 'src/utils/fileStateCache.ts'))
const { getFsImplementation } = await import(join(repo, 'src/utils/fsOperations.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')
const probe = join(process.cwd(), 'a-folder-that-does-not-stand')
const names = [...new Set(conventionsForProfile('auto').filter((c: any) => c.belowHome).flatMap((c: any) => [...c.projectDirFiles(probe), ...c.projectRulesDirs(probe), ...(c.localDirFiles?.(probe) ?? [])]).map((path: string) => relative(probe, path).split(sep)[0]))]
const fs: any = getFsImplementation()
const log: string[] = []
for (const key of Object.keys(fs)) {
  const original = fs[key]
  if (typeof original !== 'function') continue
  fs[key] = (...args: unknown[]) => { log.push(key + ' ' + String(args[0])); return original.apply(fs, args) }
}
const files = await getInstructionFiles()
const atStart = log.length
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const attached: string[] = []
for (const file of plan.touch ?? []) attached.push(...(await getNestedMemoryAttachmentsForFile(file, context as never, state)).map((a: any) => a.path))
writeFileSync(process.argv[2]!, JSON.stringify({ names, log, atStart, files: files.map((f: any) => f.path), attached }))
`)

type Drive = { names: string[]; log: string[]; atStart: number; files: string[]; attached: string[] }

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}

let worlds = 0
function drive(layout: Record<string, string>, start: string, touch: string[] = [], settings?: object): Drive & { home: string; project: string } {
  const world = join(scratch, `world-${++worlds}`)
  const home = join(world, 'home')
  const project = join(home, 'work', 'proj')
  mkdirSync(join(project, start), { recursive: true })
  for (const [rel, content] of Object.entries(layout)) {
    mkdirSync(dirname(join(project, rel)), { recursive: true })
    writeFileSync(join(project, rel), content)
  }
  const config = join(world, 'config')
  seedFirstRun(config, [project])
  if (settings) writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  const result = join(world, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: join(project, start),
    env: { ...env, HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: config, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DRV_PLAN: JSON.stringify({ touch: touch.map(file => join(project, file)) }) },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  return { ...(JSON.parse(readFileSync(result, 'utf8')) as Drive), home, project }
}

const chainOf = (from: string, until: string): string[] => {
  const dirs: string[] = []
  for (let dir = from; dir !== until && dir !== parse(dir).root; dir = dirname(dir)) dirs.push(dir)
  return dirs
}
const about = (d: Drive, dirs: string[], lines: string[] = d.log): string[] =>
  lines.filter(line => {
    const path = line.slice(line.indexOf(' ') + 1)
    return dirs.some(dir => d.names.some(name => path === join(dir, name) || path.startsWith(`${join(dir, name)}${sep}`)))
  })

try {
  console.log('the home folder and the folders above it are asked nothing about the files of other tools')
  const bare = drive({ 'README.md': 'x\n', 'packages/app/src/deep/a.ts': '\n' }, 'packages/app', ['packages/app/src/deep/a.ts'])
  const above = chainOf(bare.home, '')
  check('the names are those of the seven tools', bare.names.length >= 15 && ['.cursor', '.cursorrules', '.github', '.clinerules', '.windsurf', '.devin', 'GEMINI.md', '.agents'].every(name => bare.names.includes(name)), bare.names.join(' '))
  check('the home folder has folders above it here', above.length >= 2 && above[0] === bare.home, above.join(' '))
  check('at start and when a file is read, no call names one of them in the home folder or above', about(bare, above).length === 0, `${about(bare, above).length} call(s): ${about(bare, above).slice(0, 8).join(' | ')}`)

  console.log('below the home folder, a folder that holds none of them is asked whether each name stands, once, and nothing more')
  const below = chainOf(join(bare.project, 'packages/app'), bare.home)
  const atStart = about(bare, below, bare.log.slice(0, bare.atStart))
  const nameItself = (line: string): boolean => below.some(dir => bare.names.some(name => line === `existsSync ${join(dir, name)}`))
  check('the working directory has folders above it below the home folder', below.length === 4, below.join(' '))
  check('at start every call about them is an existence check of a name itself', atStart.length > 0 && atStart.every(nameItself), atStart.filter(line => !nameItself(line)).slice(0, 8).join(' | '))
  check('and each name is asked for once in each folder', atStart.length === below.length * bare.names.length && new Set(atStart).size === atStart.length, `${atStart.length} call(s) for ${below.length} folder(s) and ${bare.names.length} name(s)`)
  const onTheWay = [...below, join(bare.project, 'packages/app/src'), join(bare.project, 'packages/app/src/deep')]
  const atRead = about(bare, onTheWay, bare.log.slice(bare.atStart))
  const anyNameItself = (line: string): boolean => onTheWay.some(dir => bare.names.some(name => line === `existsSync ${join(dir, name)}`))
  check('when a file in a nested folder is read, the folders on the way to it are asked the same and nothing more', atRead.length > 0 && atRead.every(anyNameItself), atRead.filter(line => !anyNameItself(line)).slice(0, 8).join(' | '))

  console.log('a user who keeps a MERCURY.md, or the native profile, is asked nothing at all')
  const everyFolder = (d: { project: string }): string[] => chainOf(join(d.project, 'packages/app/src/deep'), '')
  const decided = drive({ 'MERCURY.md': 'native-needle\n', 'packages/app/src/deep/a.ts': '\n' }, 'packages/app', ['packages/app/src/deep/a.ts'])
  check('under a MERCURY.md no call names one of them in any folder, at start or when a file is read', decided.files.length === 1 && about(decided, everyFolder(decided)).length === 0, `${about(decided, everyFolder(decided)).length} call(s): ${about(decided, everyFolder(decided)).slice(0, 8).join(' | ')}`)
  const native = drive({ 'README.md': 'x\n', 'packages/app/src/deep/a.ts': '\n' }, 'packages/app', ['packages/app/src/deep/a.ts'], { briefs: { profile: 'native' } })
  check('under the native profile no call names one of them in any folder, at start or when a file is read', about(native, everyFolder(native)).length === 0, `${about(native, everyFolder(native)).length} call(s): ${about(native, everyFolder(native)).slice(0, 8).join(' | ')}`)
  const homeAsked = (d: Drive & { home: string }): number => d.log.filter(line => line.slice(line.indexOf(' ') + 1) === d.home).length
  check('and the home folder itself is not looked up for them', homeAsked(native) === homeAsked(decided) && homeAsked(bare) > homeAsked(native), `bare ${homeAsked(bare)}, MERCURY.md ${homeAsked(decided)}, native ${homeAsked(native)}`)

  console.log('where the files stand they are read')
  const held = drive({ 'GEMINI.md': 'guide-needle\n', '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\nalways-needle\n', 'packages/app/src/deep/.cursorrules': 'nested-needle\n', 'packages/app/src/deep/a.ts': '\n' }, 'packages/app', ['packages/app/src/deep/a.ts'])
  check('a guide and a rule in a folder above the working directory load', JSON.stringify(held.files) === JSON.stringify([join(held.project, 'GEMINI.md'), join(held.project, '.cursor/rules/a.mdc')]), held.files.join(' '))
  check('a rule file in a nested folder attaches when a file there is read', JSON.stringify(held.attached) === JSON.stringify([join(held.project, 'packages/app/src/deep/.cursorrules')]), held.attached.join(' '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`other-tools-cost-nothing-where-absent: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
