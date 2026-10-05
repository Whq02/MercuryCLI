#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

console.log('============================================================')
console.log(' Glob — a pattern with a slash anchors at the search root, wherever the process stands')
console.log('============================================================')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'glob-anchor-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const root = join(scratch, 'root')
const spaced = join(scratch, 'ro ot')
const stars = join(scratch, 'stars')
const elsewhere = join(scratch, 'elsewhere')
const put = (path: string, secondsAgo = 0): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x')
  if (secondsAgo > 0) {
    const stamp = (Date.now() - secondsAgo * 1000) / 1000
    utimesSync(path, stamp, stamp)
  }
}
put(join(root, 'top.txt'))
put(join(root, 'sub', 'a.txt'))
put(join(root, 'sub', 'deep', 'b.txt'))
put(join(root, 'other', 'c.md'))
put(join(root, 'secrets', 's.txt'))
put(join(root, 'secrets', 't.txt'))
put(join(root, '.hidden', 'h.txt'))
put(join(root, 'ignored.txt'))
put(join(root, 'ordered', 'o1.txt'), 3000)
put(join(root, 'ordered', 'o2.txt'), 2000)
put(join(root, 'ordered', 'o3.txt'), 1000)
put(join(spaced, 'sub', 'a.txt'))
put(join(stars, 'one', 'desktop.ini'))
put(join(stars, 'two', 'desktop.ini'))
writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
mkdirSync(elsewhere)
const at = (...parts: string[]): string => join(root, ...parts)

const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { glob } = await import('../../src/utils/glob.ts')
const { ripGrepAnswer } = await import('../../src/utils/ripgrep.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getCwd, runWithCwdOverride } = await import('../../src/utils/cwd.ts')

type Answer = { data: { numFiles: number; filenames: string[]; truncated: boolean; incomplete?: string } }
const ask = async (input: Record<string, unknown>, options: { deny?: string[]; limit?: number } = {}): Promise<Answer> => {
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: options.deny === undefined ? {} : { userSettings: options.deny } },
    }),
    ...(options.limit === undefined ? {} : { globLimits: { maxResults: options.limit } }),
  } as never
  return (await GlobTool.call(input as never, context)) as Answer
}
const paths = (answer: Answer): string[] => answer.data.filenames.map(name => resolve(getCwd(), name))
const spoken = (answer: Answer): string =>
  String((GlobTool.mapToolResultToToolResultBlockParam(answer.data as never, 'toolu_anchor') as { content: unknown }).content)
const sameFiles = (actual: string[], expected: string[]): boolean => j([...actual].sort()) === j([...expected].sort())
const direct = (pattern: string, searchRoot: string) =>
  glob(pattern, searchRoot, { limit: 100, offset: 0 }, new AbortController().signal, getEmptyToolPermissionContext())
const door = (args: string[], target: string, cwd?: string) =>
  ripGrepAnswer(args, target, new AbortController().signal, cwd === undefined ? {} : { cwd })

const previousCwd = process.cwd()
try {
  process.chdir(elsewhere)

  console.log('\n§1 the process stands in a folder that is not the search root; a directory-anchored pattern names the file')
  check('the process folder is not the search root (the condition of the defect)', process.cwd() === elsewhere && process.cwd() !== root, process.cwd())
  const anchored = await ask({ pattern: 'sub/*.txt', path: root })
  check('sub/*.txt under the root finds sub/a.txt', sameFiles(paths(anchored), [at('sub', 'a.txt')]), spoken(anchored))
  check('the answer the model reads is the path, not "No files found"', spoken(anchored) === at('sub', 'a.txt'), spoken(anchored))
  const platformSeparator = await ask({ pattern: ['sub', '*.txt'].join(sep), path: root })
  check('the same pattern spelled with the platform separator finds it too', sameFiles(paths(platformSeparator), [at('sub', 'a.txt')]), spoken(platformSeparator))
  const literal = await ask({ pattern: 'sub/deep/b.txt', path: root })
  check('a literal two-folder path finds its file', sameFiles(paths(literal), [at('sub', 'deep', 'b.txt')]), spoken(literal))
  const starFolder = await ask({ pattern: '*/a.txt', path: root })
  check('a star folder before the name (*/a.txt) finds sub/a.txt', sameFiles(paths(starFolder), [at('sub', 'a.txt')]), spoken(starFolder))
  const recursiveTail = await ask({ pattern: 'sub/**/*.txt', path: root })
  check('a recursive tail after a folder (sub/**/*.txt) finds both files below it', sameFiles(paths(recursiveTail), [at('sub', 'a.txt'), at('sub', 'deep', 'b.txt')]), spoken(recursiveTail))
  const absoluteStar = await ask({ pattern: join(stars, '*', 'desktop.ini') })
  check(
    'an absolute pattern with a star folder (the C:\\Users\\*\\desktop.ini shape) lists every match under its base folder',
    sameFiles(paths(absoluteStar), [join(stars, 'one', 'desktop.ini'), join(stars, 'two', 'desktop.ini')]),
    spoken(absoluteStar),
  )
  const spacedRoot = await ask({ pattern: 'sub/*.txt', path: spaced })
  check('a search root with a space in its name anchors the same way', sameFiles(paths(spacedRoot), [join(spaced, 'sub', 'a.txt')]), spoken(spacedRoot))

  console.log('\n§2 the session folder is not the process folder; a pattern without a path anchors at the session folder')
  const bySession = await runWithCwdOverride(root, async () => {
    const answer = await ask({ pattern: 'sub/*.txt' })
    return { found: paths(answer), said: spoken(answer) }
  })
  check('with the session folder elsewhere than the process folder, sub/*.txt with no path finds the file', sameFiles(bySession.found, [at('sub', 'a.txt')]), bySession.said)

  console.log('\n§3 what already worked is unchanged')
  const flat = await ask({ pattern: '*.txt', path: at('sub') })
  check('a bare pattern under a sub folder (the control) finds the file', sameFiles(paths(flat), [at('sub', 'a.txt')]), spoken(flat))
  const rootLevel = await ask({ pattern: '*.txt', path: root })
  check('a bare pattern still reads only the search root level', sameFiles(paths(rootLevel), [at('top.txt'), at('ignored.txt')]), spoken(rootLevel))
  const anywhere = await ask({ pattern: '**/a.txt', path: root })
  check('a recursive name pattern finds the nested file at any depth', sameFiles(paths(anywhere), [at('sub', 'a.txt')]), spoken(anywhere))
  const everything = await ask({ pattern: '**/*.txt', path: root })
  const everyTxt = ['top.txt', 'sub/a.txt', 'sub/deep/b.txt', 'secrets/s.txt', 'secrets/t.txt', '.hidden/h.txt', 'ignored.txt', 'ordered/o1.txt', 'ordered/o2.txt', 'ordered/o3.txt'].map(p => at(...p.split('/')))
  check('a recursive pattern still lists hidden and ignored files', sameFiles(paths(everything), everyTxt), spoken(everything))
  process.chdir(root)
  const inside = await ask({ pattern: 'sub/*.txt', path: root })
  process.chdir(elsewhere)
  check('with the process standing in the search root the anchored pattern finds the file (it always did)', sameFiles(paths(inside), [at('sub', 'a.txt')]), spoken(inside))
  check('…and the answer is the same wherever the process stands', spoken(inside) === spoken(anchored), `${spoken(inside)} | ${spoken(anchored)}`)

  console.log('\n§4 order, limits and spelling are what they were')
  const newestFirst = [at('ordered', 'o3.txt'), at('ordered', 'o2.txt'), at('ordered', 'o1.txt')]
  const orderedFlat = await ask({ pattern: '**/o*.txt', path: root })
  check('a recursive pattern answers newest first (the control)', j(paths(orderedFlat)) === j(newestFirst), spoken(orderedFlat))
  const orderedAnchored = await ask({ pattern: 'ordered/*.txt', path: root })
  check('the anchored pattern answers in the same newest-first order', j(paths(orderedAnchored)) === j(newestFirst), spoken(orderedAnchored))
  const limited = await ask({ pattern: 'ordered/*.txt', path: root }, { limit: 2 })
  check('a limit of two keeps the two newest and says the list was truncated', j(paths(limited)) === j(newestFirst.slice(0, 2)) && limited.data.truncated === true, spoken(limited))
  const spelled = root.replace(/\\/g, '/')
  const spelledAnchored = await direct('sub/a.txt', spelled)
  const spelledBare = await direct('**/a.txt', spelled)
  check(
    'a root spelled with forward slashes is echoed in that spelling, anchored or not',
    spelledAnchored.files.length === 1 && j(spelledAnchored.files) === j(spelledBare.files) && spelledAnchored.files[0]!.startsWith(spelled),
    j({ anchored: spelledAnchored.files, bare: spelledBare.files }),
  )

  console.log('\n§5 the process stands above the search root, and deny-read globs are never loosened')
  process.chdir(root)
  const deeper = await ask({ pattern: 'deep/*.txt', path: at('sub') })
  const fromProcessFolder = await ask({ pattern: 'sub/deep/*.txt', path: at('sub') })
  process.chdir(elsewhere)
  check('with the process above the search root a directory-anchored pattern anchors at the search root', sameFiles(paths(deeper), [at('sub', 'deep', 'b.txt')]), spoken(deeper))
  check('…so a pattern spelled from the process folder no longer matches under the deeper root', paths(fromProcessFolder).length === 0, spoken(fromProcessFolder))
  const slashFreeDeny = await ask({ pattern: 'secrets/*.txt', path: root }, { deny: ['Read(s.txt)'] })
  check('a slash-free deny glob rides along: the other file is listed, the denied one is not', sameFiles(paths(slashFreeDeny), [at('secrets', 't.txt')]), spoken(slashFreeDeny))
  process.chdir(root)
  const anchoredDenyInside = await ask({ pattern: '**/*.txt', path: root }, { deny: ['Read(secrets/**)'] })
  const coveredDeeper = await ask({ pattern: 'deep/*.txt', path: at('sub') }, { deny: ['Read(sub/deep/**)'] })
  const coveredRecursive = await ask({ pattern: '**/*.txt', path: at('sub') }, { deny: ['Read(sub/deep/**)'] })
  process.chdir(elsewhere)
  check(
    'standing in the search root an anchored deny glob hides its folder',
    sameFiles(paths(anchoredDenyInside), everyTxt.filter(p => !p.startsWith(at('secrets') + sep))),
    spoken(anchoredDenyInside),
  )
  check('a file an anchored deny rule covers is not listed through an anchored pattern under a deeper root', !paths(coveredDeeper).includes(at('sub', 'deep', 'b.txt')), spoken(coveredDeeper))
  check('…nor through a recursive pattern', sameFiles(paths(coveredRecursive), [at('sub', 'a.txt')]), spoken(coveredRecursive))

  console.log('\n§6 a folder that cannot host the walk answers as before')
  const missing = join(scratch, 'no-such-folder')
  const missingRoot = await direct('sub/*.txt', missing)
  check(
    'a missing root keeps the engine diagnostic and the incomplete marker (no spawn error, no "binary not found")',
    missingRoot.files.length === 0 && /os error 2/.test(missingRoot.incomplete ?? '') && !/was not found/.test(missingRoot.incomplete ?? ''),
    j(missingRoot),
  )
  const fileRoot = await direct('*.txt', at('top.txt'))
  check('a file named as the root is listed as it always was', j(fileRoot.files) === j([at('top.txt')]) && fileRoot.incomplete === undefined, j(fileRoot))
  const viaDoor = await door(['--files', '--glob', 'sub/*.txt'], root, root)
  check('the engine door run from the root folder matches a directory-anchored glob', viaDoor.complete && sameFiles(viaDoor.lines, [at('sub', 'a.txt')]), j(viaDoor))
  const inherited = await door(['--files', '--glob', 'sub/*.txt'], root)
  process.chdir(root)
  const inheritedInside = await door(['--files', '--glob', 'sub/*.txt'], root)
  process.chdir(elsewhere)
  check(
    'the engine door given no folder still runs where the process stands (every other caller is untouched)',
    inherited.complete && inherited.lines.length === 0 && inheritedInside.lines.length === 1,
    j({ inherited, inheritedInside }),
  )
  const viaMissingDoor = await door(['--files'], missing, missing)
  check('the engine door given a folder that does not exist answers with the engine diagnostic', !viaMissingDoor.complete && /os error 2/.test(viaMissingDoor.reason ?? '') && !/was not found/.test(viaMissingDoor.reason ?? ''), j(viaMissingDoor))

  console.log('\n§7 the process folder is never moved')
  const before = process.cwd()
  await ask({ pattern: 'sub/*.txt', path: root })
  check('a Glob call leaves the process folder where it stood', process.cwd() === before && before === elsewhere, process.cwd())
} catch (error) {
  failures++
  console.log(`  [FAIL] the proof threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-glob-search-root-anchor: all green' : `\nprove-glob-search-root-anchor: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
