#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const OLD = new RegExp(J('t', 'eam'), 'i')

const EXCLUDED_AREAS: Array<[string, string]> = [
  ['src/tools/WorkflowTool/', 'workflows do not change in any way'],
  ['scripts/workflows/', 'workflow proofs do not change in any way'],
  ['docs/releases/', 'published release pages are history'],
  ['src/constants/changelog.ts', 'past release notes stay as published'],
  ['scripts/mission-runner/corpus/', 'fixture repositories of foreign source'],
  ['scripts/interview/baselines/', 'frozen journey capture records'],
  ['scripts/visual-contract/baselines/', 'frozen capture records of earlier screens'],
  ['scripts/agent-experience/baselines/', 'frozen mechanical baselines of earlier prompts'],
]

const ALIAS_TABLES: Array<[string, string]> = []

const ALIAS_PINS: Array<[string, string]> = [
  ['scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', 'holds old transcript rows, records and files by design'],
  ['scripts/switchboard/prove-crewmates-command.ts', 'pins that the old command name is no command and no alias: the palette answers it unknown'],
  ['scripts/ui/prove-old-transcript-rows.ts', 'holds old transcript rows by design'],
  ['scripts/ui/prove-crew-screens-unchanged.ts', 'reads the stored frames of the earlier screens through a table of the old words'],
  ['scripts/identity/prove-no-old-spelling-remains.ts', 'this census composes the word it hunts'],
  ['scripts/identity/prove-crew-words.ts', 'composes the word it hunts'],
  ['scripts/identity/prove-crew-docs-words.ts', 'composes the word it hunts'],
  ['scripts/engine-connector/prove-crew-vocabulary.ts', 'composes the word it hunts'],
  ['scripts/builtin-tools/prove-builtin-tools-census.ts', 'names the retired tools it hunts'],
]

const MESSAGE_ROW_READERS = ['src/utils/attachments/types.ts', 'src/fabric/validate.ts', 'scripts/transcript-rows/prove-crew-messages-kind.ts', 'scripts/tools/prove-runaway-output-seams.ts', 'scripts/idiom/prove-body-shape-registry.ts', 'scripts/crew/prove-crew-messages-row.ts', 'scripts/attachments/goldens.json']

const XAI_BILLING_SURFACES = new Set([
  'docs/ENGINES.md',
  'scripts/providers/fixtures/xai-subscription-contract.json',
  'scripts/providers/lib/xai-usage-fixture.ts',
  'scripts/providers/prove-usage-owner-per-family.ts',
  'scripts/providers/prove-xai-usage.ts',
  'scripts/settings/prove-provider-neutral-surfaces.ts',
  'scripts/settings/prove-xai-usage-popup.ts',
  'scripts/ui/fixtures/face-logins/logins-120x40-key-xai-management.txt',
  'scripts/ui/fixtures/face-logins/logins-80x24-key-xai-management.txt',
  'src/components/RouterKeyEntry.tsx',
  'src/components/Settings/Usage.tsx',
  'src/services/providers/providerUsage.ts',
  'src/services/providers/xai/xaiLogin.ts',
  'src/services/providers/xai/xaiUsageState.ts',
  'src/skills/bundled/provider-apis/references/chat-completions.md',
  'src/substrate/flagRegistry.ts',
])
const XAI_BILLING_WORDS = /\bpersonal-team-blocked:spending-limit\b|team(?:_id|Id|-fixture|-cycle)|\/teams\/|\/team\/default\/management-keys|\bteam (?:usage|balance|permissions|meter|credits|record|spend|lookup|billing)|team[’']s prepaid credits|prepaid-only teams|identifies the team|optional management key for the (?:API )?team\b(?:[’']s)?|xAI's team|These are team/i
const NOT_THE_CREW: Array<[RegExp, string, ((rel: string) => boolean)?]> = [
  [XAI_BILLING_WORDS, "xAI's billing account and documented wire fields, not a Mercury crew", rel => XAI_BILLING_SURFACES.has(rel)],
  [new RegExp(J('s', 'team'), 'i'), 'Steam, the games store the Aseprite and Godot bridges look in'],
  [new RegExp(J('(?:\\b', 'team', ": ')?[Cc]laude[ _]", 'Team'), ''), 'the Claude Team plan, the provider\'s name for it, and the plan table row keyed by its wire value'],
  [new RegExp(J('claude_', 'team'), ''), 'the plan on the wire'],
  [new RegExp(J("'", 'team', "'"), ''), 'the plan tier or the memory scope as a wire value'],
  [new RegExp(J('\\b[Rr]ed[- ]', 'team'), ''), 'the adversarial verb'],
  [new RegExp(J('Team', 'Mem\\b|TEAM', 'MEM\\b|team', 'Memory'), ''), 'team memory: the memory of the people who share a repository'],
  [new RegExp(J('team', 'work'), 'i'), 'a plain English word'],
  [new RegExp(J('your ', 'team'), ''), 'the people whose code it is (the trust question, the memory file header)'],
  [new RegExp(J('The ', 'team', ' scope'), ''), 'the memory scope of the people who share a repository'],
  [new RegExp(J("'max'/'pro'/'", 'team', "'"), ''), 'the plan tiers'],
  [new RegExp(J('max/enterprise/', 'team'), ''), 'the plan tiers'],
  [new RegExp(J('team', 'mate_mailbox'), ''), 'the old kind of the message row: the attachment types read it through their own table, the validator keeps its shape row, the pins drive it', rel => MESSAGE_ROW_READERS.includes(rel)],
]

function crewRemainder(rel: string, line: string): string {
  let rest = line
  for (const [re, , where] of NOT_THE_CREW) {
    if (where !== undefined && !where(rel)) continue
    rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ')
  }
  return rest
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' no old spelling remains: every tracked file says crew, except the alias tables and the excluded areas')
console.log('============================================================')

check('the xAI billing vocabulary is excused only on its named surfaces',
  !OLD.test(crewRemainder('src/services/providers/xai/xaiUsageState.ts', 'team_id teamId /teams/ team usage')) &&
    OLD.test(crewRemainder('src/utils/crew/agentLaunchPlan.ts', 'team usage')))
check('a crew spelling beside xAI billing words still trips',
  OLD.test(crewRemainder('src/services/providers/xai/xaiUsageState.ts', 'team usage; ask a teammate')))
check('the xAI spending refusal stays literal only on its recorded billing surfaces',
  ['scripts/providers/fixtures/xai-subscription-contract.json', 'src/substrate/flagRegistry.ts'].every(rel =>
    !OLD.test(crewRemainder(rel, 'personal-team-blocked:spending-limit')) &&
      OLD.test(crewRemainder(rel, 'personal-team-blocked:spending-limit; ask a teammate'))) &&
    OLD.test(crewRemainder('src/utils/crew/agentLaunchPlan.ts', 'personal-team-blocked:spending-limit')))
check('the API billing possessive stays scoped to its documented account',
  !OLD.test(crewRemainder('docs/ENGINES.md', "an optional management key for the API team's")) &&
    OLD.test(crewRemainder('src/utils/crew/agentLaunchPlan.ts', "an optional management key for the API team's")) &&
    OLD.test(crewRemainder('docs/ENGINES.md', 'an optional management key for the API teammate')))

const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const scoped = files.filter(f => /^(src|scripts|docs|design-system|assets|integrations)\//.test(f) || ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md'].includes(f))
const textual = (f: string): boolean => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonl|md|txt|tsv|csv|sh|bash|py|yml|yaml|toml|sed|html|css|svg|xml|plist|ps1|cfg|ini)$/.test(f) || f.endsWith('members.txt')

type Hit = { file: string; line: number; text: string }
const hits: Hit[] = []
const namesWithOld: string[] = []
const excusedFiles = new Map<string, number>()
let scanned = 0
for (const rel of scoped) {
  if (OLD.test(rel) && !EXCLUDED_AREAS.some(([p]) => rel === p || rel.startsWith(p)) && !NOT_THE_CREW.some(([re, , where]) => re.test(rel) && (where === undefined || where(rel)))) namesWithOld.push(rel)
  if (!textual(rel)) continue
  const excluded = EXCLUDED_AREAS.find(([p]) => rel === p || rel.startsWith(p))
  const aliasTable = ALIAS_TABLES.find(([p]) => rel === p)
  const aliasPin = ALIAS_PINS.find(([p]) => rel === p)
  if (excluded || aliasTable || aliasPin) {
    if (aliasTable || aliasPin) excusedFiles.set(rel, (excusedFiles.get(rel) ?? 0) + 1)
    if (rel !== 'src/substrate/flagRegistry.ts') continue
  }
  scanned++
  const text = readFileSync(join(ROOT, rel), 'utf8')
  if (!OLD.test(text)) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!OLD.test(line)) continue
    const rest = crewRemainder(rel, line)
    if (!OLD.test(rest)) continue
    hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 140) })
  }
}

console.log(`  scanned ${scanned} files; ${hits.length} line(s) still say the old word; ${namesWithOld.length} path(s) still carry it`)
check('no tracked file name or folder name carries the old word outside the excluded areas', namesWithOld.length === 0, namesWithOld.slice(0, 20).join(', '))
check(
  'no line says the old word outside the alias tables, the alias pins and the excluded areas (the plan tier, the memory scope, Steam, red-team and the people\'s team excused by name)',
  hits.length === 0,
  `${hits.length} found:` + hits.slice(0, 60).map(h => `\n      ${h.file}:${h.line} ${h.text}`).join('') + (hits.length > 60 ? `\n      … and ${hits.length - 60} more` : ''),
)
const missingTables = ALIAS_TABLES.filter(([p]) => !files.includes(p)).map(([p]) => p)
check('every alias table exists', missingTables.length === 0, missingTables.join(', '))
const tablesSayOld = ALIAS_TABLES.filter(([p]) => files.includes(p) && !OLD.test(readFileSync(join(ROOT, p), 'utf8'))).map(([p]) => p)
check('every alias table still names an old spelling (a table with no old spelling is not a table)', tablesSayOld.length === 0, tablesSayOld.join(', '))

if (REPORT) {
  for (const [p, why] of [...EXCLUDED_AREAS, ...ALIAS_TABLES, ...ALIAS_PINS]) console.log(`  ${p} — ${why}`)
  for (const [re, why] of NOT_THE_CREW) console.log(`  not the crew: /${re.source}/ — ${why}`)
}

console.log(failures === 0 ? '\nno old spelling remains: green' : `\nno old spelling remains: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
