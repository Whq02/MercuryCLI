#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const WORDS: Array<[string, RegExp]> = [
  ['the box switch', new RegExp(J('[sS]essions', 'Bar\\b'))],
  ['the box module', new RegExp(J('Session', 'Tabs\\b'))],
  ['the title row module', new RegExp(J('HelmCenter', 'Header\\b'))],
  ['the box label', new RegExp(J('(?:⊞ |)SESSIONS', ' ›'))],
  ['the box glyph and label', new RegExp(J('⊞ ', 'SESSIONS\\b'))],
  ['the title row', new RegExp(J('✶ ', 'VIEW\\b'))],
  ['the flip action', new RegExp(J('flip', 'Session\\b'))],
  ['the box command', new RegExp(J('(?<=^|[\\s\'"`(])/', 'view(?=$|[\\s\'"`),.])'))],
  ['the rail module', new RegExp(J('HelmTele', 'metryRail\\b'))],
  ['the rail model', new RegExp(J('helmTele', 'metryModel\\b'))],
  ['the rail bus module', new RegExp(J('tele', 'metryBus\\b'))],
  ['the rail bus hook', new RegExp(J('useTele', 'metry\\b'))],
  ['the rail row id', new RegExp(J('helm:tele', 'metry:'))],
  ['the rail paint mark', new RegExp(J('render:rail-tele', 'metry\\b'))],
  ['the rail header word in a stored frame', new RegExp(J('(?<![A-Za-z_-])TELE', 'METRY(?=  )'))],
  ['the rail title in a stored frame', new RegExp(J('(?:╮|\\\\u256e|❯|\\\\u276f) {1,2}tele', 'metry\\b'))],
]

const EXCLUDED_AREAS: Array<[string, string]> = [
  ['docs/releases/', 'published release pages are history'],
  ['src/constants/changelog.ts', 'past release notes stay as published'],
  ['scripts/interview/baselines/', 'frozen journey capture records'],
  ['scripts/visual-contract/baselines/', 'frozen capture records of earlier screens'],
  ['scripts/agent-experience/baselines/', 'frozen mechanical baselines of earlier prompts'],
  ['scripts/mission-runner/corpus/', 'fixture repositories of foreign source'],
]

const PINS: Array<[string, string]> = [
  ['scripts/identity/prove-view-words-gone.ts', 'this census composes the words it hunts'],
  ['scripts/identity/prove-retired-keys-unknown.ts', 'drives the retired settings key to prove it unknown'],
  ['scripts/ui/prove-view-reaches-status-row.ts', 'pins that no row reads the title row or the box'],
  ['scripts/ui/prove-status-band.ts', 'pins that the layout mounts no title row module'],
  ['scripts/ui/prove-settings-popup-header.ts', 'pins that the framed centre carries no title row module'],
  ['scripts/ui/prove-action-honesty.ts', 'pins that the box module is gone from the tree'],
  ['scripts/ui/prove-chat-compact.ts', 'pins that the cockpit paints no title row and no box'],
  ['scripts/ui/prove-feel-journey.ts', 'pins that the chat paints no title row'],
  ['scripts/ui/prove-session-flip-chord.ts', 'pins that no module registers the flip action'],
  ['scripts/ui/prove-session-name-roads.ts', 'pins that the chat paints no title row'],
  ['scripts/ui/prove-composer-draft-survives-click-drive.ts', 'pins that no box paints above the status row'],
  ['scripts/ui/render-mercuryframe.ts', 'pins that no box paints above the statusbar'],
  ['scripts/journey/prove-rename-hosted-drive.ts', 'reads the title row to prove it absent'],
  ['scripts/journey/prove-header-truth-drive.ts', 'reads the title row to prove it absent'],
  ['scripts/journey/prove-final-journey.ts', 'pins that the box is not painted'],
  ['scripts/samples-drives/prove-samples-cockpit-drive.ts', 'pins that no box paints under the view'],
  ['scripts/critters/prove-critter-mini-drive.ts', 'pins that no title row paints and the box command is unknown'],
  ['scripts/critters/prove-small-critter-estate.ts', 'pins that the box switch, the box and the title row are gone'],
  ['scripts/switchboard/prove-chat-mode-polish.ts', 'pins that the box module is gone'],
  ['scripts/switchboard/prove-surface-truth-drive.ts', 'pins that no frame paints a title row'],
  ['scripts/switchboard/prove-plain-world-command-honesty.ts', 'reads the title rows to prove them absent'],
  ['scripts/switchboard/prove-contract-offer-drive.ts', 'pins that the focused chat paints no title row'],
  ['scripts/engine-connector/prove-header-truth.ts', 'pins that the title row module is gone'],
  ['scripts/visual-contract/prove-paste-safety.ts', 'pins that no row reads the title row'],
  ['scripts/visual-finish/prove-rail-recent-lane.ts', 'reads the box row to prove it absent'],
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the sessions box, the title row, the vitals rail\'s old name and their words are gone: no tracked file spells them outside the pins that prove their absence')
console.log('============================================================')

const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const scoped = files.filter(f => /^(src|scripts|docs|design-system|assets|integrations|sdk)\//.test(f) || ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md'].includes(f))
const textual = (f: string): boolean => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonl|md|txt|tsv|csv|sh|bash|py|yml|yaml|toml|sed|html|css|svg|xml|plist|ps1|cfg|ini)$/.test(f)

type Hit = { file: string; line: number; word: string; text: string }
const hits: Hit[] = []
const pinned = new Map<string, number>()
let scanned = 0
for (const rel of scoped) {
  if (!textual(rel)) continue
  if (EXCLUDED_AREAS.some(([p]) => rel === p || rel.startsWith(p))) continue
  const text = readFileSync(join(ROOT, rel), 'utf8')
  scanned++
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const [word, re] of WORDS) {
      if (!re.test(line)) continue
      if (PINS.some(([p]) => p === rel)) {
        pinned.set(rel, (pinned.get(rel) ?? 0) + 1)
        continue
      }
      hits.push({ file: rel, line: i + 1, word, text: line.trim().slice(0, 140) })
    }
  }
}

console.log(`  scanned ${scanned} files; ${hits.length} line(s) still spell a retired word; ${pinned.size} pin(s) hold one`)
check(
  'no line under src, scripts, docs or the design system spells the box switch, the box module, the title row module, the box label, the title row, the flip action, the box command, or the vitals rail\'s old module, model, bus, hook, row id, paint mark or painted header, outside the pins that prove their absence',
  hits.length === 0,
  `${hits.length} found:` + hits.slice(0, 60).map(h => `\n      ${h.file}:${h.line} (${h.word}) ${h.text}`).join('') + (hits.length > 60 ? `\n      … and ${hits.length - 60} more` : ''),
)
const productPins = PINS.filter(([p]) => p.startsWith('src/'))
check('no product file is a pin: the product carries none of the words', productPins.length === 0, productPins.map(([p]) => p).join(', '))
const missingPins = PINS.filter(([p]) => !files.includes(p)).map(([p]) => p)
check('every pin exists', missingPins.length === 0, missingPins.join(', '))
const idlePins = PINS.filter(([p]) => files.includes(p) && !pinned.has(p)).map(([p]) => p)
check('every pin still names a retired word (a pin that names none is not a pin)', idlePins.length === 0, idlePins.join(', '))
const modules = ['src/components/mercury-ui/SessionTabs.tsx', 'src/utils/cockpit/sessionsBar.ts', 'src/components/HelmCenterHeader.tsx', 'src/commands/view', 'src/commands/view.ts', J('src/components/HelmTele', 'metryRail.tsx'), J('src/state/tele', 'metryBus.ts'), J('src/utils/cockpit/helmTele', 'metryModel.ts')]
const standing = modules.filter(p => existsSync(join(ROOT, p)))
check('the box module, its switch, the title row module, the box command module and the vitals rail\'s old module, model and bus are gone from the tree', standing.length === 0, standing.join(', '))

if (REPORT) {
  for (const [p, why] of [...EXCLUDED_AREAS, ...PINS]) console.log(`  ${p} — ${why}`)
}

console.log(failures === 0 ? '\nview words gone: green' : `\nview words gone: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
