#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep, win32 } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'share-import-')))
const B = '\\'
const HOST = 'nohost.invalid'
const ROADS = ['load', 'question', 'headless', 'resumed', 'compacted', 'memory', 'orient', 'nested', 'health'] as const
const ROAD_WORDS: Record<(typeof ROADS)[number], string> = {
  load: 'the load a session starts with and its first request',
  question: 'the question asked before the approval dialog, and the list the dialog shows',
  headless: 'the load of a headless session',
  resumed: 'a session started again in the same folder',
  compacted: 'the load after a compaction',
  memory: '/memory files',
  orient: '/orient',
  nested: 'a file read in a nested folder',
  health: "/health's instruction row",
}

type Road = (typeof ROADS)[number]
type Reading = {
  roads: Record<Road, string[]>
  loaded: string[]
  first: string
  heldByLoad: string[]
  asks: boolean
  heldByQuestion: string[]
  listed: string[]
  attached: string[]
  reloads: string[][]
}
type Scene = { seam: 'windows' | 'macos'; layout: Record<string, string>; approved?: boolean; silent?: boolean; personal?: string; outside?: Record<string, string> }

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
const { getPlatform } = await import(join(repo, 'src/utils/platform.ts'))
const { setIsInteractive } = await import(join(repo, 'src/bootstrap/state.ts'))
const { getFsImplementation } = await import(join(repo, 'src/utils/fsOperations.ts'))
const { getEmptyToolPermissionContext } = await import(join(repo, 'src/Tool.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(repo, 'src/utils/fileStateCache.ts'))
const engine = await import(join(repo, 'src/services/instructions/engine.ts'))
const listing = await import(join(repo, 'src/services/instructions/listing.ts'))
const { getUserContext } = await import(join(repo, 'src/context.ts'))
const { getNestedMemoryAttachmentsForFile } = await import(join(repo, 'src/utils/attachments/nestedMemory.ts'))
const orient = await import(join(repo, 'src/commands/orient/orient.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')

const fs: any = getFsImplementation()
const calls: string[] = []
const onShare = (path: string): boolean => path.includes(plan.host)
const watched = (path: string): boolean => plan.watch.some((part: string) => path.includes(part))
const words = (path: string): Buffer => Buffer.from('share-needle-' + path.slice(path.length - 4, path.length - 3) + '\\n')
const no = (): boolean => false
const stands = { isFile: () => true, isDirectory: no, isFIFO: no, isSocket: no, isCharacterDevice: no, isBlockDevice: no, isSymbolicLink: no, size: 16, mtimeMs: 1 }
const answers: Record<string, (path: string, options?: any) => unknown> = {
  existsSync: () => true,
  statSync: () => stands,
  lstatSync: () => stands,
  stat: async () => stands,
  lstat: async () => stands,
  realpathSync: path => path,
  realpath: async path => path,
  readFileBytes: async path => words(path),
  readFileBytesSync: path => words(path),
  readFileSync: path => words(path).toString('utf8'),
  readFile: async path => words(path).toString('utf8'),
  readSync: (path, options) => ({ buffer: words(path).subarray(0, options.length), bytesRead: Math.min(options.length, words(path).length) }),
}
for (const key of Object.keys(fs)) {
  const original = fs[key]
  if (typeof original !== 'function') continue
  fs[key] = (...args: unknown[]) => {
    const path = String(args[0])
    if (watched(path)) calls.push(key + ' ' + path)
    if (!onShare(path)) return original.apply(fs, args)
    const answer = plan.silent ? (key === 'existsSync' ? no : undefined) : answers[key]
    if (answer === undefined) throw Object.assign(new Error('ENOENT: ' + key + ' ' + path), { code: 'ENOENT' })
    return answer(path, args[1])
  }
}

const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const held = (): string[] => engine.getInstructionCompositionState().diagnostics.filter((d: any) => d.kind === 'external-import-blocked').map((d: any) => d.path)
const roads: Record<string, string[]> = {}

getPlatform.cache.set(undefined, plan.seam)
setIsInteractive(true)
const files = await engine.getInstructionFiles()
const first = (await getUserContext()).instructions ?? ''
roads.load = calls.splice(0)
const heldByLoad = held()

const asks = await engine.shouldShowExternalInstructionIncludesWarning()
const heldByQuestion = held()
const listed = engine.getExternalInstructionIncludes(await engine.getInstructionFiles(true)).map((include: any) => include.path)
roads.question = calls.splice(0)

const reloads: string[][] = []
const reload = async (): Promise<void> => { reloads.push((await engine.getInstructionFiles()).map((f: any) => f.path)) }
setIsInteractive(false)
engine.resetInstructionFilesCache('session_start')
await reload()
setIsInteractive(true)
roads.headless = calls.splice(0)

engine.resetInstructionFilesCache('session_start')
await reload()
await engine.shouldShowExternalInstructionIncludesWarning()
roads.resumed = calls.splice(0)

engine.resetInstructionFilesCache('compact')
await reload()
roads.compacted = calls.splice(0)

engine.clearInstructionFileCaches()
await reload()
listing.getInstructionListing.cache.clear()
await listing.getInstructionListing()
roads.memory = calls.splice(0)

await orient.default.getPromptForCommand()
roads.orient = calls.splice(0)

const attached = (await getNestedMemoryAttachmentsForFile(join(process.cwd(), 'sub', 'a.ts'), context as never, state)).map((a: any) => a.path)
roads.nested = calls.splice(0)

await engine.getInstructionBundle()
roads.health = calls.splice(0)

getPlatform.cache.delete(undefined)
writeFileSync(process.argv[2]!, JSON.stringify({ roads, loaded: files.map((f: any) => f.path), first, heldByLoad, asks, heldByQuestion, listed, attached, reloads }))
`)

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

let worlds = 0
function read(scene: Scene): Reading & { project: string; outside: string } {
  const world = join(scratch, `world-${++worlds}`)
  const project = join(world, 'project')
  const outside = join(world, 'outside')
  const home = join(world, 'home')
  const config = join(world, 'config')
  const put = (root: string, files: Record<string, string>): void => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
  }
  mkdirSync(home, { recursive: true })
  put(project, scene.layout)
  put(outside, scene.outside ?? {})
  seedFirstRun(config, [project])
  if (scene.approved) {
    const saved = JSON.parse(readFileSync(join(config, '.mercury.json'), 'utf8')) as { projects: Record<string, object> }
    for (const key of Object.keys(saved.projects)) saved.projects[key] = { ...saved.projects[key], hasExternalIncludesApproved: true }
    writeFileSync(join(config, '.mercury.json'), JSON.stringify(saved))
  }
  if (scene.personal !== undefined) writeFileSync(join(config, 'MERCURY.md'), scene.personal)
  const result = join(world, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: project,
    env: { ...env, HOME: home, USERPROFILE: home, DRV_HOME: home, MERCURY_CONFIG_DIR: config, MERCURY_LOCAL_PROBE_TARGETS: 'none', DRV_PLAN: JSON.stringify({ seam: scene.seam, silent: scene.silent === true, host: HOST, watch: [HOST, `${sep}outside${sep}`] }) },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  return { ...(JSON.parse(readFileSync(result, 'utf8')) as Reading), project, outside }
}

const layoutWith = (line: (name: string) => string): Record<string, string> => ({
  'MERCURY.md': `native-needle\n\n@notes/inside.md\n\n${line('a')}\n`,
  'notes/inside.md': `inside-needle\n\n${line('b')}\n`,
  'MERCURY.local.md': `local-needle\n\n${line('c')}\n`,
  '.mercury/rules/always.md': `rule-needle\n\n${line('d')}\n`,
  'sub/MERCURY.md': `nested-needle\n\n${line('e')}\n`,
  'sub/a.ts': '\n',
})
const SPELLINGS: Array<{ name: string; line: (name: string) => string; path: (name: string) => string }> = [
  { name: 'written with forward slashes', line: name => `@//${HOST}/share/rules/${name}.md`, path: name => win32.normalize(`//${HOST}/share/rules/${name}.md`) },
  { name: 'written with backslashes', line: name => `@${B}${B}${HOST}${B}share${B}rules${B}${name}.md`, path: name => win32.normalize(`//${HOST}/share/rules/${name}.md`) },
  { name: 'in the WebDAV form', line: name => `@${B}${B}${HOST}@SSL@443${B}share${B}rules${B}${name}.md`, path: name => win32.normalize(`//${HOST}@SSL@443/share/rules/${name}.md`) },
]
const same = (got: string[], wanted: string[]): boolean => JSON.stringify([...got].sort()) === JSON.stringify([...wanted].sort())
const kinds = (calls: string[]): string => [...new Set(calls.map(call => call.split(' ')[0]))].join(', ')

try {
  for (const spelling of SPELLINGS) {
    console.log(`on Windows a project's import of a share, ${spelling.name}, is never looked up before outside imports are approved`)
    const r = read({ seam: 'windows', layout: layoutWith(spelling.line) })
    const atStart = ['a', 'b', 'c', 'd'].map(spelling.path)
    const reported = ['a', 'b', 'c'].map(spelling.path)
    for (const road of ROADS) check(`${ROAD_WORDS[road]}: no file-system call names the share`, r.roads[road].length === 0, r.roads[road].join(' | '))
    const own = ['MERCURY.md', 'notes/inside.md', '.mercury/rules/always.md', 'MERCURY.local.md'].map(rel => join(r.project, rel))
    check("the load reads the project's four files, holds every import of the share, the three of a guide file as external-import-blocked and the rule file's with no report as before, and nothing of the share reaches the first request", same(r.loaded, own) && same(r.heldByLoad, reported) && r.first.includes('native-needle') && !r.first.includes('share-needle'), JSON.stringify({ held: r.heldByLoad, loaded: r.loaded }))
    check('the headless load, the session started again, the load after a compaction and /memory files read the same four files', r.reloads.length === 4 && r.reloads.every(paths => same(paths, own)), JSON.stringify(r.reloads))
    check('the question before the dialog holds them exactly as the load does', same(r.heldByQuestion, reported), JSON.stringify(r.heldByQuestion))
    check('a folder whose only outside imports are on a share is asked, and the dialog lists each by its path, once', r.asks === true && same(r.listed, atStart), JSON.stringify({ asks: r.asks, listed: r.listed }))
    check("the nested folder's guide attaches and its own import of the share stays held", same(r.attached, [join(r.project, 'sub', 'MERCURY.md')]), JSON.stringify(r.attached))
  }

  console.log('a share that does not answer is held and listed all the same')
  const backslashes = SPELLINGS[1]!
  const silent = read({ seam: 'windows', layout: layoutWith(backslashes.line), silent: true })
  check('no road names it, and the folder is asked with every path in the list', ROADS.every(road => silent.roads[road].length === 0) && silent.asks === true && same(silent.listed, ['a', 'b', 'c', 'd'].map(backslashes.path)), JSON.stringify({ roads: ROADS.filter(road => silent.roads[road].length > 0), asks: silent.asks, listed: silent.listed }))

  console.log('once outside imports are approved the share is read as it was')
  const approved = read({ seam: 'windows', layout: layoutWith(backslashes.line), approved: true })
  check('the load asks the file system about the share and reads it', kinds(approved.roads.load).includes('readFileBytes') && same(approved.loaded.filter(path => path.includes(HOST)), ['a', 'b', 'c', 'd'].map(backslashes.path)), `${kinds(approved.roads.load)} ${JSON.stringify(approved.loaded)}`)
  check("the share's words reach the first request and nothing is held", ['a', 'b', 'c', 'd'].every(name => approved.first.includes(`share-needle-${name}`)) && approved.heldByLoad.length === 0, `${approved.first.slice(0, 300)} ${JSON.stringify(approved.heldByLoad)}`)
  check('nothing is asked again', approved.asks === false, String(approved.asks))

  console.log('an outside import that is no share is looked up as it was')
  const beside = read({ seam: 'windows', layout: { 'MERCURY.md': 'native-needle\n\n@../outside/notes.md\n' }, outside: { 'notes.md': 'outside-needle\n' } })
  const notes = join(beside.outside, 'notes.md')
  check('the load holds it, and only the lookup that resolves its path names it', same(beside.heldByLoad, [notes]) && !beside.first.includes('outside-needle') && beside.roads.load.length > 0 && beside.roads.load.every(call => /^(lstatSync|realpathSync) /.test(call)), `${JSON.stringify(beside.heldByLoad)} ${beside.roads.load.join(' | ')}`)
  check('the question before the dialog reads it, asks, and the dialog lists it', kinds(beside.roads.question).includes('readFileBytes') && beside.asks === true && same(beside.listed, [notes]) && beside.heldByQuestion.length === 0, `${kinds(beside.roads.question)} ${JSON.stringify({ asks: beside.asks, listed: beside.listed, held: beside.heldByQuestion })}`)

  console.log("the operator's own instruction file imports a share as it imports any outside file")
  const personal = read({ seam: 'windows', layout: { 'MERCURY.md': 'native-needle\n' }, personal: `own-needle\n\n${backslashes.line('u')}\n` })
  check('it is read with no approval of the project, as before', kinds(personal.roads.load).includes('readFileBytes') && personal.first.includes('share-needle-u') && personal.asks === false, `${kinds(personal.roads.load)} ${personal.first.slice(0, 200)} ${personal.asks}`)

  console.log('on macOS, Linux and WSL the same line names a local path')
  if (process.platform === 'win32') {
    console.log('[SKIP] the line read as a local path — on a Windows host its lookup would leave for the network')
  } else {
    const local = read({ seam: 'macos', layout: { 'MERCURY.md': `native-needle\n\n${SPELLINGS[0]!.line('a')}\n` } })
    check('it is held by the load and read by the question before the dialog, as it was', same(local.heldByLoad, [`/${HOST}/share/rules/a.md`]) && kinds(local.roads.question).includes('readFileBytes') && local.asks === true && local.heldByQuestion.length === 0, `${JSON.stringify(local.heldByLoad)} ${kinds(local.roads.question)} ${local.asks}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`share-import-waits-for-approval: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
