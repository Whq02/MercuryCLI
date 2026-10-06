#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const WORDS: Array<[string, RegExp]> = [
  ['the crew kill flag', new RegExp(J('MERCURY_', 'CREW(?![A-Z_])'))],
  ['the crew child identity stamp', new RegExp(J("(?:env\\.|['\"])MERCURY_", "CREW_AGENT(?![A-Z_])"))],
  ['the crew daemon provenance flag', new RegExp(J('MERCURY_DAEMON_', 'CREW\\b'))],
  ['the crew home override', new RegExp(J('MERCURY_', 'CREWS_DIR\\b'))],
  ['the crew surfaces enable', new RegExp(J('MERCURY_', 'CREWMATES\\b'))],
  ['the bus envelopes flag', new RegExp(J('MERCURY_DAEMON_', 'BUS\\b'))],
  ['the carry-forward flag', new RegExp(J('MERCURY_CARRY_', 'FORWARD\\b'))],
  ['the badge tint stamp', new RegExp(J('MERCURY_AGENT_', 'COLOR\\b'))],
  ['the crew gate module', new RegExp(J('crew', 'Enabled\\b'))],
  ['the crewmate settings key', new RegExp(J('crewmate', 'DefaultModel\\b'))],
  ['the spinner tree key', new RegExp(J('showSpinner', 'Tree\\b'))],
  ['the idle hook event', new RegExp(J('Crewmate', 'Idle\\b'))],
  ['the preview chord action', new RegExp(J('toggleCrewmate', 'Preview\\b'))],
  ['the in-process task kind', new RegExp(J('InProcess', 'Crewmate'))],
  ['the role resolver', new RegExp(J('role', 'Resolver\\b'))],
  ['the crew charter', new RegExp(J('crew', 'Charter\\b'))],
  ['the crew helpers', new RegExp(J('crew', 'Helpers\\b'))],
  ['the crew birth', new RegExp(J('birthSession', 'Crew\\b'))],
  ['the crew home reader', new RegExp(J('getCrews', 'Dir\\b'))],
  ['the session class', new RegExp(J('isCrew', 'Session\\b'))],
  ['the chats view', new RegExp(J('CrewmateChats', 'View\\b'))],
  ['the crew client', new RegExp(J('crew', 'Client\\b'))],
  ['the live comms store', new RegExp(J('live', 'Comms\\b'))],
  ['the coordination service', new RegExp(J('coordination', 'Service\\b'))],
  ['the bus envelopes module', new RegExp(J('bus', 'Envelopes\\b'))],
  ['the crew spawn verb', new RegExp(J('crew', 'Spawn\\b'))],
  ['the crew daemon starter', new RegExp(J('ensureCrew', 'Daemon\\b'))],
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
  ['scripts/identity/prove-crewmate-words-gone.ts', 'this census composes the words it hunts'],
  ['scripts/agents/prove-agent-one-kind.ts', 'pins that the Agent tool prompt reads no crewmate identity'],
  ['scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', 'pins that the crew home reader, the roster modules and the preview chord are gone'],
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the rostered crewmate and its words are gone: no tracked file spells its flags, keys, kinds or modules outside the pins that prove their absence')
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
  'no line under src, scripts, docs or the design system spells a retired crew flag, settings key, hook event, chord action, task kind or module, outside the pins',
  hits.length === 0,
  `${hits.length} found:` + hits.slice(0, 80).map(h => `\n      ${h.file}:${h.line} (${h.word}) ${h.text}`).join('') + (hits.length > 80 ? `\n      … and ${hits.length - 80} more` : ''),
)
const productPins = PINS.filter(([p]) => p.startsWith('src/'))
check('no product file is a pin: the product carries none of the words', productPins.length === 0, productPins.map(([p]) => p).join(', '))
const missingPins = PINS.filter(([p]) => !files.includes(p)).map(([p]) => p)
check('every pin exists', missingPins.length === 0, missingPins.join(', '))
const idlePins = PINS.filter(([p]) => files.includes(p) && !pinned.has(p)).map(([p]) => p)
check('every pin still names a retired word (a pin that names none is not a pin)', idlePins.length === 0, idlePins.join(', '))
const modules = [
  'src/utils/crewmate.ts',
  'src/utils/crewmateContext.ts',
  'src/utils/crewEnabled.ts',
  'src/utils/sessionClass.ts',
  'src/utils/commandHierarchy.ts',
  'src/utils/crew/crewHelpers.ts',
  'src/utils/crew/crewBirth.ts',
  'src/utils/crew/crewConvert.ts',
  'src/utils/crew/crewCharter.ts',
  'src/utils/crew/crewOperations.ts',
  'src/utils/crew/crewPhases.ts',
  'src/utils/crew/roleResolver.ts',
  'src/utils/crew/crewClient.ts',
  'src/utils/crew/busEnvelopes.ts',
  'src/services/crew/liveComms.ts',
  'src/services/crew/liveMessages.ts',
  'src/services/crew/roster.ts',
  'src/services/coordination',
  'src/tasks/InProcessCrewmateTask',
  'src/components/mercury-ui/screens/CrewmateChatsView.tsx',
  'src/daemon/crewSpawn.ts',
]
const standing = modules.filter(p => existsSync(join(ROOT, p)))
check('the rostered crewmate modules are gone from the tree', standing.length === 0, standing.join(', '))

if (REPORT) {
  for (const [p, why] of [...EXCLUDED_AREAS, ...PINS]) console.log(`  ${p} — ${why}`)
}

console.log(failures === 0 ? '\ncrewmate words gone: green' : `\ncrewmate words gone: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
