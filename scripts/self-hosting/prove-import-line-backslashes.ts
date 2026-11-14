#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'import-backslashes-')))
const home = join(scratch, 'home')
const root = join(scratch, 'project')
const SEAMS = ['windows', 'macos', 'linux', 'wsl'] as const

type Reading = { includes: string[]; bare: string[] }
type Row = { name: string; line: string; windows: Reading; elsewhere?: Reading }

const B = '\\'
const none: Reading = { includes: [], bare: [] }
const includes = (...spellings: string[]): Reading => ({ includes: spellings, bare: [] })
const bare = (...spellings: string[]): Reading => ({ includes: [], bare: spellings })

const ROWS: Row[] = [
  { name: 'a drive letter', line: `@C:${B}proj${B}AGENTS.md\n`, windows: includes(`C:${B}proj${B}AGENTS.md`) },
  { name: 'a folder whose name begins with a dot', line: `@C:${B}proj${B}.github${B}instructions\n`, windows: includes(`C:${B}proj${B}.github${B}instructions`), elsewhere: bare(`C:${B}proj`) },
  {
    name: 'two import lines of one paragraph',
    line: `@C:${B}proj${B}AGENTS.md\n@C:${B}proj${B}.github${B}instructions\n`,
    windows: includes(`C:${B}proj${B}AGENTS.md`, `C:${B}proj${B}.github${B}instructions`),
    elsewhere: { includes: [`C:${B}proj${B}AGENTS.md`], bare: [`C:${B}proj`] },
  },
  { name: 'a relative path up two folders', line: `@..${B}..${B}shared${B}x.md\n`, windows: includes(`..${B}..${B}shared${B}x.md`), elsewhere: none },
  { name: 'a relative path into a dot folder', line: `@..${B}shared${B}.cursor${B}rules\n`, windows: includes(`..${B}shared${B}.cursor${B}rules`), elsewhere: includes(`..${B}shared`) },
  { name: 'a name that begins with an underscore', line: `@docs${B}_drafts${B}a.md\n`, windows: includes(`docs${B}_drafts${B}a.md`), elsewhere: bare('docs') },
  { name: 'names that begin with a bracket, a dash and a tilde', line: `@C:${B}proj${B}(old)${B}-x${B}~tmp${B}a.md\n`, windows: includes(`C:${B}proj${B}(old)${B}-x${B}~tmp${B}a.md`), elsewhere: bare(`C:${B}proj`) },
  { name: 'a trailing backslash at the end of a line', line: `@C:${B}proj${B}rules${B}\nnext line\n`, windows: bare(`C:${B}proj${B}rules`) },
  { name: 'a trailing backslash at the end of the text', line: `@C:${B}proj${B}rules${B}`, windows: bare(`C:${B}proj${B}rules`) },
  { name: 'a trailing backslash after a dot folder', line: `@C:${B}proj${B}.github${B}\nnext line\n`, windows: includes(`C:${B}proj${B}.github`), elsewhere: bare(`C:${B}proj`) },
  { name: 'a trailing backslash before a space is an escaped space', line: `see @C:${B}proj${B}rules${B} for the rules\n`, windows: bare(`C:${B}proj${B}rules for`) },
  { name: 'a path with a space', line: `@C:${B}My${B} Docs${B}a.md\n`, windows: includes(`C:${B}My Docs${B}a.md`) },
  { name: 'a path with a space and a dot folder', line: `@C:${B}My${B} Docs${B}.notes${B}a.md\n`, windows: includes(`C:${B}My Docs${B}.notes${B}a.md`), elsewhere: bare(`C:${B}My Docs`) },
  {
    name: 'a list item',
    line: `- @C:${B}proj${B}.github${B}instructions\n`,
    windows: includes(`C:${B}proj${B}.github${B}instructions`),
    elsewhere: { includes: [`C:${B}proj${B}.github${B}instructions`], bare: [`C:${B}proj`] },
  },
  { name: 'a sentence that ends after the path', line: `Read @C:${B}proj${B}.github${B}x.md.\n`, windows: includes(`C:${B}proj${B}.github${B}x.md`), elsewhere: bare(`C:${B}proj`) },
  { name: 'a path inside emphasis', line: `*@C:${B}proj${B}.github${B}x.md*\n`, windows: includes(`C:${B}proj${B}.github${B}x.md`), elsewhere: bare(`C:${B}proj`) },
  { name: 'a forward-slash path with an escaped underscore', line: `@docs/my${B}_file.md\n`, windows: includes(`docs/my${B}_file.md`), elsewhere: includes('docs/my') },
  { name: 'a handle with an escaped underscore stays a mention', line: `ask @mary${B}_jane first\n`, windows: bare(`mary${B}_jane`), elsewhere: bare('mary') },
  { name: 'a Windows account name stays a mention', line: `ask @CORP${B}alice first\n`, windows: bare(`CORP${B}alice`) },
  { name: 'an escaped at-sign is no import', line: `write to ${B}@someone here\n`, windows: none },
  { name: 'an escape directly before the at-sign', line: `${B}*@docs/x.md\n`, windows: includes('docs/x.md') },
  { name: 'an escaped space', line: `@./with${B} space.txt\n`, windows: includes('./with space.txt') },
  { name: 'a backslash before a letter', line: `@a${B}b.md\n`, windows: includes(`a${B}b.md`) },
  { name: 'a path in a code span is no import', line: `use \`@C:${B}proj${B}.github${B}x.md\` here\n`, windows: none },
  { name: 'a path in a comment is no import', line: `<!-- @C:${B}proj${B}.github${B}x.md -->\n`, windows: none },
  { name: 'a UNC path', line: `@${B}${B}nohost.invalid${B}share${B}rules${B}a.md\n`, windows: none },
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
const { parseInstructionFileContent } = await import(join(repo, 'src/services/instructions/sourceText.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')
const file = join(plan.root, 'MERCURY.md')
const read: Record<string, Record<string, unknown>> = {}
for (const seam of plan.seams) {
  getPlatform.cache.set(undefined, seam)
  read[seam] = {}
  for (const row of plan.rows) {
    const parsed = parseInstructionFileContent(row.line, file, 'Project', file)
    read[seam][row.name] = { includes: parsed.includePaths, bare: parsed.bareMentionPaths }
  }
}
getPlatform.cache.delete(undefined)
writeFileSync(process.argv[2]!, JSON.stringify(read))
`)

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

const expanded = (spelling: string): string => (spelling.startsWith('~/') ? join(home, spelling.slice(2)) : isAbsolute(spelling) ? normalize(spelling) : resolve(root, spelling)).normalize('NFC')
const paths = (reading: Reading): string => JSON.stringify({ includes: reading.includes.map(expanded).sort(), bare: reading.bare.map(expanded).sort() })
const sorted = (reading: Reading): string => JSON.stringify({ includes: [...reading.includes].sort(), bare: [...reading.bare].sort() })

try {
  mkdirSync(home, { recursive: true })
  mkdirSync(root, { recursive: true })
  const config = join(scratch, 'config')
  mkdirSync(config, { recursive: true })
  const result = join(scratch, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: root,
    env: { ...env, HOME: home, USERPROFILE: home, DRV_HOME: home, MERCURY_CONFIG_DIR: config, DRV_PLAN: JSON.stringify({ root, seams: SEAMS, rows: ROWS.map(({ name, line }) => ({ name, line })) }) },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  const read = JSON.parse(readFileSync(result, 'utf8')) as Record<(typeof SEAMS)[number], Record<string, Reading>>

  console.log('on Windows a backslash inside an @ path does not end the path')
  for (const row of ROWS) check(`Windows: ${row.name}`, sorted(read.windows[row.name]!) === paths(row.windows), `${JSON.stringify(row.line)} read ${sorted(read.windows[row.name]!)}, wanted ${paths(row.windows)}`)

  console.log('on macOS, Linux and WSL every line reads as it did')
  for (const row of ROWS) {
    const wanted = paths(row.elsewhere ?? row.windows)
    const off = SEAMS.filter(seam => seam !== 'windows').filter(seam => sorted(read[seam][row.name]!) !== wanted)
    check(`macOS, Linux and WSL: ${row.name}`, off.length === 0, `${JSON.stringify(row.line)} read ${off.map(seam => `${seam} ${sorted(read[seam][row.name]!)}`).join(' · ')}, wanted ${wanted}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`import-line-backslashes: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
