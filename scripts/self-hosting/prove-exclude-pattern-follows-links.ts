#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'exclude-links-')))
const home = join(scratch, 'home')
const SEAMS = ['windows', 'macos', 'linux', 'wsl'] as const
const B = '\\'
const SHARE = `${B}${B}nohost.invalid${B}share`

const LINKS: Record<string, string> = {
  '/x/rules/linked-dir': '/x/targets/rule-pack',
  '/x/rules/linked-file.md': '/x/targets/actual-rule.md',
  'C:/x/rules/linked-dir': `C:${B}x${B}targets${B}rule-pack`,
  'C:/x/rules/linked-file.md': `C:${B}x${B}targets${B}actual-rule.md`,
  'C:': `C:${B}work`,
  '//nohost.invalid/share/rules/linked-dir': `${SHARE}${B}targets${B}rule-pack`,
}

type Row = { name: string; file: string; pattern: string; windows: boolean; elsewhere: boolean }

const ROWS: Row[] = [
  { name: 'a pattern that starts with a slash and names a linked folder', file: '/x/targets/rule-pack/packed.md', pattern: '/x/rules/linked-dir/**', windows: true, elsewhere: true },
  { name: 'a pattern that starts with a slash and names a linked file', file: '/x/targets/actual-rule.md', pattern: '/x/rules/linked-file.md', windows: true, elsewhere: true },
  { name: 'a pattern that starts with a drive letter and names a linked folder', file: `C:${B}x${B}targets${B}rule-pack${B}packed.md`, pattern: `C:${B}x${B}rules${B}linked-dir/**`, windows: true, elsewhere: false },
  { name: 'a pattern that starts with a drive letter and names a linked file', file: `C:${B}x${B}targets${B}actual-rule.md`, pattern: `C:${B}x${B}rules${B}linked-file.md`, windows: true, elsewhere: false },
  { name: "a pattern at a drive's root", file: `C:${B}work${B}notes.md`, pattern: `C:${B}*.md`, windows: false, elsewhere: false },
  { name: 'a pattern on a share that names the folder itself', file: `${SHARE}${B}targets${B}rule-pack${B}packed.md`, pattern: `${SHARE}${B}targets${B}**`, windows: true, elsewhere: true },
  { name: 'a pattern on a share that names a link', file: `${SHARE}${B}targets${B}rule-pack${B}packed.md`, pattern: `${SHARE}${B}rules${B}linked-dir/**`, windows: false, elsewhere: true },
]

const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
if (homedir() !== process.env.DRV_HOME) throw new Error('the home folder is ' + homedir() + ', not the scratch home of this proof')
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { getPlatform } = await import(join(repo, 'src/utils/platform.ts'))
const { getFsImplementation, setFsImplementation } = await import(join(repo, 'src/utils/fsOperations.ts'))
const { matchesInstructionExcludes, clearExcludeResolutionMemo } = await import(join(repo, 'src/services/instructions/discovery.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')
const real = getFsImplementation()
const asked: string[] = []
const absent = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
const not = (): boolean => false
setFsImplementation({
  ...real,
  lstatSync: (path: string) => { asked.push(path); return path in plan.links ? { isFIFO: not, isSocket: not, isCharacterDevice: not, isBlockDevice: not } : absent() },
  realpathSync: (path: string) => (path in plan.links ? plan.links[path] : absent()),
} as never)
const read: Record<string, Record<string, unknown>> = {}
for (const seam of plan.seams) {
  getPlatform.cache.set(undefined, seam)
  read[seam] = {}
  for (const row of plan.rows) {
    clearExcludeResolutionMemo()
    asked.length = 0
    read[seam][row.name] = { excluded: matchesInstructionExcludes(row.file, [row.pattern]), asked: [...asked] }
  }
}
getPlatform.cache.delete(undefined)
setFsImplementation(real)
writeFileSync(process.argv[2]!, JSON.stringify(read))
`)

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

try {
  mkdirSync(home, { recursive: true })
  const config = join(scratch, 'config')
  mkdirSync(config, { recursive: true })
  const result = join(scratch, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: scratch,
    env: { ...env, HOME: home, USERPROFILE: home, DRV_HOME: home, MERCURY_CONFIG_DIR: config, DRV_PLAN: JSON.stringify({ links: LINKS, seams: SEAMS, rows: ROWS }) },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  const read = JSON.parse(readFileSync(result, 'utf8')) as Record<(typeof SEAMS)[number], Record<string, { excluded: boolean; asked: string[] }>>
  const said = (row: Row, seam: (typeof SEAMS)[number]): string => `${row.pattern} against ${row.file} on ${seam}: ${JSON.stringify(read[seam][row.name])}`

  console.log('on Windows an exclude pattern that names a link is followed, whether it starts with a slash or with a drive letter')
  for (const row of ROWS) check(`Windows: ${row.name} ${row.windows ? 'excludes the file' : 'excludes nothing'}`, read.windows[row.name]!.excluded === row.windows, said(row, 'windows'))
  const drive = read.windows["a pattern at a drive's root"]!
  check("Windows: the drive's root is asked about, never the drive's current folder", drive.asked.includes('C:/') && !drive.asked.includes('C:'), JSON.stringify(drive.asked))
  const shared = ROWS.filter(row => row.file.startsWith(SHARE)).flatMap(row => read.windows[row.name]!.asked)
  check('Windows: a pattern on a share is matched as written and nothing is asked of the share', shared.length === 0, JSON.stringify(shared))

  console.log('on macOS, Linux and WSL every pattern reads as it did')
  for (const row of ROWS) {
    const off = SEAMS.filter(seam => seam !== 'windows').filter(seam => read[seam][row.name]!.excluded !== row.elsewhere)
    check(`macOS, Linux and WSL: ${row.name} ${row.elsewhere ? 'excludes the file' : 'excludes nothing'}`, off.length === 0, off.map(seam => said(row, seam)).join(' · '))
  }
  const lettered = SEAMS.filter(seam => seam !== 'windows').flatMap(seam => ROWS.filter(row => row.pattern.startsWith('C:')).flatMap(row => read[seam][row.name]!.asked.filter(path => path.startsWith('C:/') || path === 'C:')))
  check('macOS, Linux and WSL: nothing is asked about a pattern that starts with a drive letter', lettered.length === 0, JSON.stringify(lettered))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`exclude-pattern-follows-links: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
