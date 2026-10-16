#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' Glob — ignore files apply by default; what they hide is counted in the tail, never listed first')
console.log('============================================================')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'glob-ignore-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const project = join(scratch, 'defu')
const put = (path: string, body = 'x'): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
const PROJECT_TS = ['src/defu.ts', 'src/_utils.ts', 'src/types.ts', 'test/defu.test.ts', 'test/utils.test.ts']
for (const rel of PROJECT_TS) put(join(project, rel))
put(join(project, 'package.json'), '{"name":"defu"}')
put(join(project, 'README.md'), '# defu')
put(join(project, '.gitignore'), 'node_modules\ndist\n')
const IGNORED_TS = 120
for (let i = 0; i < IGNORED_TS; i++) put(join(project, 'node_modules', `pkg-${i % 12}`, `index-${i}.d.ts`))
put(join(project, 'node_modules', 'pkg-0', 'package.json'), '{}')
put(join(project, 'dist', 'defu.mjs'))
execFileSync('git', ['init', '-q', project])
const loose = join(scratch, 'loose')
put(join(loose, 'a.ts'))
put(join(loose, '.gitignore'), 'skipped.ts\n')
put(join(loose, 'skipped.ts'))

const { GlobTool, ignoredPathsLine } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type Answer = { data: { numFiles: number; filenames: string[]; truncated: boolean; ignored?: number; incomplete?: string } }
const ask = async (input: Record<string, unknown>): Promise<Answer> => {
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
  return (await GlobTool.call(input as never, context)) as Answer
}
const spoken = (answer: Answer): string => String((GlobTool.mapToolResultToToolResultBlockParam(answer.data as never, 'toolu_ignore') as { content: unknown }).content)
const j = (v: unknown): string => JSON.stringify(v)

try {
  console.log('\n§1 the pass, step 4: **/*.ts in a project with node_modules (the base answered 100 dependency paths and none of the project\'s)')
  const everyTs = await ask({ pattern: '**/*.ts', path: project })
  const names = everyTs.data.filenames.map(name => name.replace(/\\/g, '/'))
  check('the five project .ts files are the answer, in full', names.length === 5 && PROJECT_TS.every(rel => names.some(name => name.endsWith(rel))), j(names))
  check('no node_modules path is listed', !names.some(name => name.includes('node_modules')), j(names.slice(0, 5)))
  check('the answer is not truncated (nothing to truncate once the dependencies are out)', everyTs.data.truncated === false)
  check(`the ${IGNORED_TS} ignored .ts paths are counted`, everyTs.data.ignored === IGNORED_TS, String(everyTs.data.ignored))
  const words = spoken(everyTs)
  check('the result ends on the one-line count: "· 120 paths under ignore rules not listed" (true for a folder rule and a by-name rule alike)', words.endsWith(ignoredPathsLine(IGNORED_TS)) && words.includes('· 120 paths under ignore rules not listed'), words.split('\n').slice(-2).join(' / '))
  check('the count line comes after the listed files, never first', words.includes('src/defu.ts') && words.includes('· 120 paths') && words.indexOf('src/defu.ts') < words.indexOf('· 120 paths'), words.slice(0, 200))
  check('the line formats thousands and carries the count alone', ignoredPathsLine(1204) === '· 1,204 paths under ignore rules not listed', ignoredPathsLine(1204))
  check('one ignored path reads singular', ignoredPathsLine(1) === '· 1 path under ignore rules not listed')
  const { DESCRIPTION } = await import('../../src/tools/GlobTool/prompt.ts')
  check('the tool\'s description carries the road inside an ignored folder (the tail never claims it)', DESCRIPTION.includes('name an ignored folder as the path to search inside it') && DESCRIPTION.includes('Ignore files apply'), DESCRIPTION)

  console.log('\n§2 the whole tree, and a search that matches only ignored files')
  const everything = await ask({ pattern: '**/*', path: project })
  const everyName = everything.data.filenames.map(name => name.replace(/\\/g, '/')).filter(name => !name.includes('/.git/'))
  const PROJECT_FILES = [...PROJECT_TS, 'package.json', 'README.md', '.gitignore']
  check('**/* (the pattern that whitelists every folder it matches) lists the project\'s own files and nothing under node_modules or dist', everyName.length === PROJECT_FILES.length && PROJECT_FILES.every(rel => everyName.some(name => name.endsWith(rel))) && !everyName.some(name => /node_modules|\/dist\//.test(name)), j(everyName))
  check('its tail counts every hidden path (the dependencies, their package.json, the build output)', everything.data.ignored === IGNORED_TS + 2, String(everything.data.ignored))
  const onlyIgnored = await ask({ pattern: '**/*.mjs', path: project })
  check('a pattern that matches only ignored files answers "No files found" with the count beneath, so the model knows where they are', onlyIgnored.data.numFiles === 0 && spoken(onlyIgnored) === `No files found\n${ignoredPathsLine(1)}`, spoken(onlyIgnored))
  put(join(project, 'src', 'debug.log'))
  put(join(project, 'src', '.env'))
  writeFileSync(join(project, '.gitignore'), 'node_modules\ndist\n*.log\n.env\n')
  const byName = await ask({ pattern: 'src/*', path: project })
  check('files ignored BY NAME (*.log, .env) beside listed files are counted with the same true words — nothing says "folder"', byName.data.numFiles === 3 && byName.data.ignored === 2 && spoken(byName).endsWith('· 2 paths under ignore rules not listed') && !spoken(byName).split('\n').at(-1)!.includes('folder'), spoken(byName))

  console.log('\n§3 the road inside: naming the ignored folder as the path searches it')
  const inside = await ask({ pattern: '**/*.d.ts', path: join(project, 'node_modules', 'pkg-0') })
  check('node_modules/pkg-0 named as the path lists its ten .d.ts files', inside.data.numFiles === 10 && inside.data.filenames.every(name => name.endsWith('.d.ts')), j(inside.data.numFiles))
  check('nothing is counted as hidden there', (inside.data.ignored ?? 0) === 0, String(inside.data.ignored))

  console.log('\n§4 what did not change')
  const flat = await ask({ pattern: 'src/*.ts', path: project })
  check('a folder-anchored pattern answers the same three files', flat.data.numFiles === 3 && (flat.data.ignored ?? 0) === 0, j(flat.data))
  check('a clean answer carries no tail at all', !spoken(flat).includes('under ignored folders'), spoken(flat))
  const outsideGit = await ask({ pattern: '*.ts', path: loose })
  check('outside a git repository a .gitignore has no force (ripgrep\'s own rule): both files list, nothing is counted', outsideGit.data.numFiles === 2 && (outsideGit.data.ignored ?? 0) === 0, j(outsideGit.data))
  const persisted = GlobTool.outputSchema!.safeParse({ durationMs: 1, numFiles: 0, filenames: [], truncated: false, ignored: 3 })
  check('a resumed transcript\'s result with the count parses', persisted.success)
  const before = GlobTool.outputSchema!.safeParse({ durationMs: 1, numFiles: 0, filenames: [], truncated: false })
  check('a result persisted without the count still parses', before.success)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ glob ignore default — ALL PASS' : `\n❌ glob ignore default — ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
