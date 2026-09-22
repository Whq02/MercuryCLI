#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

console.log('============================================================')
console.log(' Grep — the search root reaches ripgrep as its real path, so an anchored glob matches under a symlinked folder')
console.log('============================================================')

const { GrepTool, realSearchRoot } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const base = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-symlink-')))
const real = join(base, 'real')
mkdirSync(join(real, 'sub'), { recursive: true })
writeFileSync(join(real, 'target.txt'), 'needle at the root\n')
writeFileSync(join(real, 'sub', 'inner.ts'), 'needle below\n')
writeFileSync(join(real, 'sub', 'other.md'), 'nothing here\n')
const link = join(base, 'link')
symlinkSync(real, link)
const previousCwd = process.cwd()
process.chdir(link)
const context = {
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
} as never
type Answer = { data: { numFiles: number; filenames: string[]; incomplete?: string } }
const search = async (input: Record<string, unknown>): Promise<Answer> => (await GrepTool.call({ pattern: 'needle', ...input } as never, context)) as Answer
const names = (answer: Answer): string[] => answer.data.filenames.map(f => f.split(/[\\/]/).pop() ?? f).sort()

try {
  console.log('\n§1 the session stands in the symlinked spelling of its folder; a root-anchored glob names the root file')
  check('entered through the symlinked spelling, the working directory the system reports is the real path (where ripgrep roots an anchored glob)', process.cwd() === real, process.cwd())
  const rootViaReal = await search({ path: real, glob: '/target.txt' })
  check('the real spelling as the root finds the root file (the control)', rootViaReal.data.numFiles === 1 && names(rootViaReal)[0] === 'target.txt', j(rootViaReal.data))
  const rootViaLink = await search({ path: link, glob: '/target.txt' })
  check('the symlinked spelling as the root finds it too', rootViaLink.data.numFiles === 1 && names(rootViaLink)[0] === 'target.txt', j(rootViaLink.data))

  console.log('\n§2 a directory-anchored glob under the symlinked spelling')
  const belowViaLink = await search({ path: link, glob: 'sub/*.ts' })
  check('the file under the anchored directory is found', belowViaLink.data.numFiles === 1 && names(belowViaLink)[0] === 'inner.ts', j(belowViaLink.data))

  console.log('\n§3 the answer keeps the spelling the search was given, so a later Edit finds the lines the search showed')
  const plainViaLink = await search({ path: link })
  check('a search with no glob finds both files', plainViaLink.data.numFiles === 2 && j(names(plainViaLink)) === j(['inner.ts', 'target.txt']), j(plainViaLink.data))
  check('every listed path is spelled under the root as it was given (the symlinked spelling)', plainViaLink.data.filenames.every(f => f.startsWith(link) && !f.startsWith(real)), j(plainViaLink.data.filenames))
  check('…and so is the root file found through the anchored glob', rootViaLink.data.filenames[0] === join(link, 'target.txt'), j(rootViaLink.data.filenames))
  const content = (await GrepTool.call({ pattern: 'needle', path: link, glob: '/target.txt', output_mode: 'content' } as never, context)) as { data: { content?: string; numLines?: number } }
  check('a content answer through the anchored glob names the file in the given spelling with its line', typeof content.data.content === 'string' && content.data.content.includes(`${join(link, 'target.txt')}:1:needle at the root`), j(content.data))
  check('the walk finished', [rootViaLink, belowViaLink, plainViaLink].every(a => a.data.incomplete === undefined))

  console.log('\n§4 a decomposed Unicode target keeps its filesystem identity')
  const unicodeTarget = join(base, 'cafe\u0301')
  mkdirSync(unicodeTarget)
  writeFileSync(join(unicodeTarget, 'target.txt'), 'needle in the Unicode target\n')
  const unicodeLink = join(base, 'unicode-link')
  symlinkSync(unicodeTarget, unicodeLink)
  const exactRoot = realpathSync(unicodeLink)
  check('the real path differs from its NFC spelling', exactRoot !== exactRoot.normalize('NFC'), j(exactRoot))
  check('the search root is byte-equal to the filesystem answer', Buffer.from(realSearchRoot(unicodeLink)).equals(Buffer.from(exactRoot)), j({ actual: realSearchRoot(unicodeLink), expected: exactRoot }))
  check('a nonexistent root keeps its given spelling', realSearchRoot(join(base, 'missing')) === join(base, 'missing'))
  const unicodeFiles = await search({ path: unicodeLink })
  check('the Unicode search succeeds and spells the answer under the given root', unicodeFiles.data.numFiles === 1 && unicodeFiles.data.filenames[0] === join(unicodeLink, 'target.txt') && unicodeFiles.data.incomplete === undefined, j(unicodeFiles.data))
  for (const output_mode of ['content', 'count'] as const) {
    const answer = (await GrepTool.call({ pattern: 'needle', path: unicodeLink, output_mode } as never, context)) as { data: { content?: string; incomplete?: string } }
    check(`${output_mode} also spells the Unicode answer under the given root`, answer.data.content?.startsWith(`${join(unicodeLink, 'target.txt')}:`) === true && answer.data.incomplete === undefined, j(answer.data))
  }
} catch (error) {
  failures++
  console.log(`  [FAIL] the proof threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  process.chdir(previousCwd)
  rmSync(base, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n  ALL PASS' : `\n  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
