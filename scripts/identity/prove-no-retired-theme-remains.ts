#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')

const FAMILY_NAMES = new RegExp(J('(?:light|dark)[-_](?:an', 'si|dalton', 'ized)|dalton', 'ized|\\bAN', 'SI only\\b'), 'i')
const QUOTED_LIGHT = new RegExp(J("(['\"`])", 'li', 'ght', '\\1'))
const THEME_WORD = /theme|famil|appearance|palette|tokens|oasis|syntax/i
const LIGHT_PIN = new RegExp(J('THEME_PIN\\s*[:=]\\s*[\'"`]?', 'li', 'ght\\b'))
const LIGHT_GRID = new RegExp(J('--', 'li', 'ght', '--'))
const REMOVAL_ROW = /^design-system\/live\/grids\/[^\t]+\.grid\.json\tremoved with the family/

const EXCUSED: Array<[string, string]> = [
  ['docs/releases/', 'published release pages are history'],
  ['src/constants/changelog.ts', 'past release notes stay as published'],
  ['scripts/engine-pass/contract-59a987410.json', "the recorded contract of the engine pass's base, a snapshot never rewritten"],
  ['scripts/ui/prove-theme-roster.ts', 'drives each retired name to prove it resolves as an unknown name does'],
  ['scripts/identity/prove-no-retired-theme-remains.ts', 'this census composes the names it hunts'],
]
const ROW_EXCUSED: Array<[string, RegExp, string]> = [
  ['scripts/engine-pass/frames-moved.tsv', REMOVAL_ROW, 'a removal row names the removed grid by its path'],
]

function retired(line: string): boolean {
  return FAMILY_NAMES.test(line) || LIGHT_PIN.test(line) || LIGHT_GRID.test(line) || (QUOTED_LIGHT.test(line) && THEME_WORD.test(line))
}

function hits(rel: string, text: string): Array<{ line: number; text: string }> {
  const rows = ROW_EXCUSED.filter(([path]) => path === rel)
  const out: Array<{ line: number; text: string }> = []
  text.split('\n').forEach((line, index) => {
    if (!retired(line)) return
    if (rows.some(([, row]) => row.test(line))) return
    out.push({ line: index + 1, text: line.trim().slice(0, 140) })
  })
  return out
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' no retired theme remains: the tree names two appearances, dark and true-black')
console.log('============================================================')

const trips = [
  J("getTheme('", 'li', 'ght', "')"),
  J("theme: '", 'li', 'ght', "'"),
  J('{"theme":"', 'li', 'ght', '"}'),
  J("for (const family of ['", 'li', 'ght', "'])"),
  J('MERCURY_THEME_PIN=', 'li', 'ght'),
  J('MERCURY_THEME_PIN: "', 'li', 'ght', '"'),
  J('frame--120x40--', 'li', 'ght', '--truecolor--full'),
  J('dark-', 'an', 'si'),
  J('li', 'ght-', 'an', 'si'),
  J('dark-', 'dalton', 'ized'),
  J('li', 'ght-', 'dalton', 'ized'),
  J('DARK_', 'AN', 'SI'),
  J('LIGHT_', 'DALTON', 'IZED'),
  J('const is', 'Dalton', 'ized = true'),
  J("'Dark (AN", "SI only)'"),
]
check('every retired spelling trips', trips.every(retired), trips.filter(line => !retired(line)).join(' | '))
const quiet = [
  'INPUT.depth === "light"',
  "'lava', 'lea', 'ledge', 'lichen', 'light', 'lily'",
  'highlight the light grounds',
  'design-system/live/grids/frame--120x40--dark--ansi--full.grid.json',
  "colorize(text, 'ansi:redBright')",
  "theme: 'not-a-theme'",
  "MERCURY_THEME_PIN: 'dark'",
  'under NO_COLOR/colorblind a failed server read like a benign dim hint',
]
check('the living words stay quiet', quiet.every(line => !retired(line)), quiet.filter(retired).join(' | '))
const removal = J('design-system/live/grids/frame--120x40--dark-', 'an', 'si--truecolor--full.grid.json\tremoved with the family: x\tthemes\tabc')
const moved = J('design-system/live/grids/frame--120x40--dark-', 'an', 'si--truecolor--full.grid.json\tthe eyes\teyes\tabc')
check(
  "the movement record excuses a removal row only, never another row naming a retired grid",
  hits('scripts/engine-pass/frames-moved.tsv', removal).length === 0 && hits('scripts/engine-pass/frames-moved.tsv', moved).length === 1 && hits('scripts/ui/x.ts', removal).length === 1,
)

const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const scoped = files.filter(f => /^(src|scripts|docs|design-system|assets|integrations)\//.test(f) || ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md'].includes(f))
const textual = (f: string): boolean => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonl|md|txt|tsv|csv|sh|bash|py|yml|yaml|toml|sed|html|css|svg|xml|plist|ps1|cfg|ini)$/.test(f)
const found: string[] = []
let scanned = 0
for (const rel of scoped) {
  if (!textual(rel)) continue
  if (EXCUSED.some(([path]) => rel === path || rel.startsWith(path))) continue
  scanned++
  for (const hit of hits(rel, readFileSync(join(ROOT, rel), 'utf8'))) found.push(`${rel}:${hit.line}: ${hit.text}`)
}
check(`no tracked file outside the excused records spells a retired theme family (${scanned} files read)`, found.length === 0, `\n    ${found.slice(0, 40).join('\n    ')}${found.length > 40 ? `\n    … ${found.length - 40} more` : ''}`)
for (const [path, why] of EXCUSED) console.log(`  [EXCUSED] ${path} — ${why}`)
for (const [path, , why] of ROW_EXCUSED) console.log(`  [EXCUSED ROWS] ${path} — ${why}`)

console.log(`\nno retired theme remains: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
