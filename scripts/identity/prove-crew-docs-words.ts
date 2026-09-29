#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const WORD = new RegExp(J('(?<![\\w/:.<@-])', 'team', '(?:mate)?s?', '(?![\\w/<>@-])(?!\\.\\w)(?!:\\S)'), 'i')
const DOOR = new RegExp(J('(?<![\\w/:.<@-])/', 'team', 'mates\\b'))
const NOT_THE_CREW: RegExp[] = [
  new RegExp(J('Claude ', 'Team')),
  new RegExp(J('API ', 'team')),
  new RegExp(J('\\bred[ -]', 'team', '\\b'), 'i'),
]

const ROOT_SURFACES = ['README.md', 'AGENTS.md', 'MERCURY.md', 'CONTRIBUTING.md']
type Row = { path: string; fragment: string | null; why: string }
const ALLOW: Row[] = [
  { path: 'docs/releases/', fragment: null, why: 'past release pages stay as published' },
  { path: 'docs/SESSIONS.md', fragment: 'the way a team commits', why: "the people's team committing its config, not the crew" },
]

function pages(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.md')) out.push(relative(ROOT, p).split('\\').join('/'))
    }
  }
  walk(join(ROOT, 'docs'))
  for (const rel of ROOT_SURFACES) if (existsSync(join(ROOT, rel))) out.push(rel)
  return out
}

export function proseLines(markdown: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  let fenced = false
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue }
    if (fenced) continue
    const text = raw.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']')
    out.push({ line: i + 1, text })
  }
  return out
}

function saysCrew(text: string): boolean {
  let rest = text
  for (const re of NOT_THE_CREW) rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ')
  return WORD.test(rest) || DOOR.test(rest)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' crew words in the docs — no page says team or teammate')
console.log('============================================================')

console.log('— §0 the scanner bites (poison control) —')
{
  const poison = [
    'Teammates keep off each other\'s files with leases.',
    'The `/teammates` command opens the Crew view.',
    '```',
    'a fenced block saying team is code',
    '```',
    'the payload carries `team_name` and `teammate_name`',
    'Open the crew view (/teammates) and press x.',
    'The Claude Team plan and the red-team verifier.',
    'See [CREW.md](CREW.md) for the crew.',
    'A team of agents working one project.',
  ].join('\n')
  const lines = proseLines(poison).filter(l => saysCrew(l.text)).map(l => l.line)
  check('the sentences are caught (1,7,10)', [1, 7, 10].every(l => lines.includes(l)), lines.join(','))
  check('a code span, a fenced block, the plan name, the verb and a link target never count', lines.every(l => [1, 7, 10].includes(l)), lines.filter(l => ![1, 7, 10].includes(l)).join(','))
}

console.log('— §1 the census —')
type Hit = { rel: string; line: number; text: string; allowed: Row | null }
const hits: Hit[] = []
let scanned = 0
for (const rel of pages()) {
  scanned++
  const source = readFileSync(join(ROOT, rel), 'utf8')
  if (!/team/i.test(source)) continue
  for (const l of proseLines(source)) {
    if (!saysCrew(l.text)) continue
    const row = ALLOW.find(r => (rel === r.path || rel.startsWith(r.path)) && (r.fragment === null || l.text.includes(r.fragment))) ?? null
    hits.push({ rel, line: l.line, text: l.text.trim(), allowed: row })
  }
}
const unallowed = hits.filter(h => h.allowed === null)
const allowed = hits.filter(h => h.allowed !== null)
console.log(`  scanned ${scanned} pages; ${hits.length} lines say the word, ${allowed.length} of them under a named reason`)
check(
  'no doc line says team or teammate outside the named reasons',
  unallowed.length === 0,
  `${unallowed.length} found:` + unallowed.slice(0, 60).map(h => `\n      ${h.rel}:${h.line} ${h.text.slice(0, 110)}`).join('') + (unallowed.length > 60 ? `\n      … and ${unallowed.length - 60} more` : ''),
)
if (REPORT) {
  for (const row of ALLOW) {
    const under = allowed.filter(h => h.allowed === row)
    console.log(`  ${row.path}${row.fragment ? ` [${row.fragment}]` : ''} — ${row.why}: ${under.length}`)
    for (const h of under) console.log(`      ${h.rel}:${h.line} ${h.text.slice(0, 120)}`)
  }
}
const index = readFileSync(join(ROOT, 'docs/README.md'), 'utf8')
check('the docs index names the crew page', /\bcrew\b/i.test(index.split('\n').find(l => /CREWS\.md|CREW\.md/.test(l)) ?? ''), (index.split('\n').find(l => /CREWS\.md|CREW\.md/.test(l)) ?? '(no row)').trim())
check('every allow row carries its reason', ALLOW.every(r => r.why.trim().length > 0))

console.log(failures === 0 ? '\nprove-crew-docs-words: green' : `\nprove-crew-docs-words: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
