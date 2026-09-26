#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = relative(ROOT, import.meta.path)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 1200)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

type Needle = { word: string; test: (line: string) => number; why: string }
const literal = (word: string, why: string): Needle => ({ word, test: line => line.indexOf(word), why })
const pattern = (word: string, re: RegExp, why: string): Needle => ({ word, test: line => line.search(re), why })
const OLD_WORDS: Needle[] = [
  literal('Mercury — model', 'the old title (an em dash); the picker reads "Mercury · model"'),
  literal('CHOOSE A MODEL', 'the retired second line'),
  literal('model IDs are real', 'the retired ids-are-real sentence'),
  literal('model ids are real', 'the retired ids-are-real sentence'),
  literal('○ switch', 'the retired switch glyph; a switchable row has an empty state column'),
  literal('● current', 'the retired current glyph; the current row reads "current"'),
  literal('⦿ current', 'the retired current glyph'),
  literal('[○●⦿]', 'the retired state glyphs'),
  pattern('MERCURY — <FAMILY> MODELS', /MERCURY — [A-Z.& ]+ MODELS/, 'the retired section title; a provider heads "PROVIDER · door · account · N live"'),
  literal('esc collapse', 'the retired door footer word'),
  literal('←→ effort', 'the retired effort keys; e cycles the effort'),
  literal('→ ← effort', 'the retired effort keys; e cycles the effort'),
  literal('catalogueDoor.js', 'the retired expand-in-place module'),
  literal('catalogueDoor.ts', 'the retired expand-in-place module'),
  literal('prove-catalogue-door', 'the retired door proof'),
]

const tracked = execFileSync('git', ['ls-files', '--', 'scripts', 'src', 'docs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(path => path !== '' && /\.(ts|tsx|mts|mjs|js|json|md|sh|py|txt)$/.test(path) && path !== SELF)

function labelSpan(line: string): number {
  const open = /^\s*(?:tally\.)?check\((['"`])/.exec(line)
  if (open === null) return -1
  const quote = open[1]!
  let at = open[0].length
  while (at < line.length) {
    if (line[at] === '\\') { at += 2; continue }
    if (line[at] === quote) return at
    at++
  }
  return line.length
}

function absenceGuard(line: string, at: number, width: number): boolean {
  const before = line.slice(0, at)
  const after = line.slice(at + width)
  if (/!\s*\(?\s*[\w$.()\[\]?'"`\s:-]*\.(?:includes|test|some|match|find|search)\s*\(\s*['"`/]?$/.test(before)) return true
  if (/!\s*\(?\s*[\w$.()\[\]?'"`\s:-]*\.(?:includes|test|some|match|find|search)\s*\([^)]*$/.test(before) && /^[^)]*\)/.test(after)) {
    const negatedCall = /!\s*\(?\s*[\w$.()\[\]?'"`\s:-]*\.(?:includes|test|some|match|find|search)\s*\(/.exec(before)
    if (negatedCall !== null && before.slice(negatedCall.index).split('(').length - before.slice(negatedCall.index).split(')').length >= 1) return true
  }
  if (/^['"`]?\s*\)\s*===\s*(?:''|""|``|0|-1)/.test(after) || /^['"`]?\s*\)\s*(?:<\s*0|===\s*-1)/.test(after)) return true
  if (/^['"`]?\s*\)\s*\)\s*===\s*(?:''|""|``)/.test(after)) return true
  return false
}

section('§1 no reader under scripts/, src/ or docs/ waits on an old word of the model picker')
const readers: string[] = []
const mentions: string[] = []
const guards: string[] = []
for (const path of tracked) {
  const text = readFileSync(join(ROOT, path), 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const needle of OLD_WORDS) {
      let from = 0
      while (from < line.length) {
        const at = needle.test(line.slice(from))
        if (at < 0) break
        const here = from + at
        const width = needle.word.startsWith('MERCURY — <') ? (/MERCURY — [A-Z.& ]+ MODELS/.exec(line.slice(here))?.[0].length ?? 1) : needle.word.length
        from = here + Math.max(1, width)
        const where = `${path}:${index + 1}`
        const trimmed = line.trim()
        if (/^(?:\/\/|\*|\/\*|#|console\.log\()/.test(trimmed) || path.endsWith('.md')) {
          mentions.push(`${where} [${needle.word}]`)
          break
        }
        const label = labelSpan(line)
        if (label >= 0 && here < label) {
          mentions.push(`${where} [${needle.word}] (a check label)`)
          continue
        }
        if (absenceGuard(line, here, width)) {
          guards.push(`${where} [${needle.word}]`)
          continue
        }
        readers.push(`${where} [${needle.word}] — ${needle.why}: ${trimmed.slice(0, 140)}`)
      }
    }
  })
}
console.log(`  census: ${tracked.length} tracked files · ${OLD_WORDS.length} old words · ${guards.length} absence guards · ${mentions.length} comment or label mentions`)
for (const guard of guards) console.log(`    guard: ${guard}`)
for (const mention of mentions) console.log(`    mention: ${mention}`)
for (const reader of readers) console.log(`    READER: ${reader}`)
check('every occurrence of an old picker word is an absence guard, a comment or a check label — never a reader waiting on it', readers.length === 0, `${readers.length} stale reader(s), listed above`)

section('§2 the census has teeth: a planted reader on each old word is caught, and each absence-guard shape clears')
{
  const planted = OLD_WORDS.map(needle => {
    const word = needle.word.startsWith('MERCURY — <') ? 'MERCURY — ANTHROPIC MODELS' : needle.word
    const line = `  check('the picker opened', frame.includes('${word}'))`
    const at = needle.test(line)
    return at >= 0 && !absenceGuard(line, at, word.length) && !(labelSpan(line) >= 0 && at < labelSpan(line))
  })
  check('a positive includes on each old word reads as a reader', planted.every(Boolean), OLD_WORDS.filter((_, k) => !planted[k]).map(needle => needle.word).join(', '))
  const cleared = [
    "  check('the second line is gone', !frame.includes('CHOOSE A MODEL') && !frame.includes('model IDs are real'))",
    "  tally.check('P16 the click closes it', !(m['picker-clicked'] ?? '').includes('Mercury — model') && (m['picker-clicked'] ?? '').includes('Type a prompt'))",
    "  check('no CHOOSE A MODEL line', rowWith(picker, 'CHOOSE A MODEL') === '', picker.slice(3, 6).join(' | '))",
    "const rowLine = (frame: string, id: string): string | undefined => lines(frame).find(line => line.includes(id) && !line.includes('model IDs are real'))",
    "  check('the ids-are-real sentence never paints', !src.includes('model IDs are real, never themed') && !src.includes('model ids are real'))",
  ].map(line => {
    const needle = OLD_WORDS.find(candidate => candidate.test(line) >= 0)!
    const at = line.lastIndexOf(needle.word)
    return absenceGuard(line, at, needle.word.length)
  })
  check('the absence-guard shapes clear: a negated includes, a negated includes on a coalesced frame, an empty-row compare, a filter with a negated includes, a source guard', cleared.every(Boolean), cleared.map(String).join(','))
  const awaited = "      { atTick: 160, awaitText: 'Mercury — model', minTick: 100, awaitSettleTicks: 3, requireAwait: true, mark: 'open', data: CTRL_N },"
  const needle = OLD_WORDS[0]!
  check('a drive that awaits the old title reads as a reader', !absenceGuard(awaited, needle.test(awaited), needle.word.length) && labelSpan(awaited) < 0)
}

console.log(`\nprove-model-picker-reader-census: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
