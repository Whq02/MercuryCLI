#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const J = (...parts: string[]): string => parts.join('')

const NEEDLES: Array<[string, RegExp]> = [
  ['a terminal multiplexer named where no real session is meant', new RegExp(J('\\b', 'tm', 'ux\\b'), 'i')],
  ['the retired member word', new RegExp(J('(?<!/)\\b', 'team', 'mates?\\b'), 'i')],
  ['the retired capitalised group word', new RegExp(J('\\b', 'Team', 's?\\b'))],
  ['the retired launch phrase', new RegExp(J('team', ' launch'), 'i')],
  ['the spawn tool named as copy', new RegExp(J('Team', 'Create'))],
  ['the retired shared-estate word', new RegExp(J('multi', 'player'), 'i')],
  ['the retired seat-estate word', new RegExp(J('(?<!(?:third|first)[- ])\\b', 'party', '\\b'), 'i')],
]

const BARE_TOKEN = /^['"][A-Za-z0-9_./@:-]+['"]$/
const HOLES = /\$\{[^}]*\}/g

const FILES = [
  'src/components/mercury-ui/screens/CrewView.tsx',
  'src/components/mercury-ui/screens/TeammateChatsView.tsx',
  'src/components/mercury-ui/screens/MonitorView.tsx',
  'src/components/HelmLanesRail.tsx',
  'src/components/HelmTelemetryRail.tsx',
  'src/components/tasks/BackgroundTasksDialog.tsx',
  'src/components/tasks/InProcessTeammateDetailDialog.tsx',
  'src/components/tasks/AsyncAgentDetailDialog.tsx',
  'src/components/tasks/taskStatusUtils.tsx',
  'src/components/TaskListV2.tsx',
  'src/components/AgentProgressLine.tsx',
  'src/components/Spinner/TeammateSpinnerLine.tsx',
  'src/components/Spinner/TeammateSpinnerTree.tsx',
  'src/components/MercuryFleetChat.tsx',
  'src/components/MercuryTeammateTree.tsx',
  'src/components/MercuryAgents.tsx',
  'src/components/MercuryTasks.tsx',
  'src/components/FleetMonitor.tsx',
  'src/components/BootAgentsScreen.tsx',
  'src/components/PromptInput/useSwarmBanner.ts',
  'src/commands/teammates/index.ts',
  'src/commands/teammates/teammates.tsx',
  'src/commands/team/index.ts',
  'src/commands/crew/index.ts',
  'src/services/engine-connector/workCounts.ts',
  'src/services/engine-connector/crewFacts.ts',
  'src/utils/cockpit/fleetGauge.ts',
  'src/state/telemetryBus.ts',
  'src/utils/crew/crewClient.ts',
  'src/daemon/crewSpawn.ts',
  'src/utils/healthReport.ts',
]

const ALLOW: Array<[string, string, string]> = [
  ['src/components/PromptInput/useSwarmBanner.ts', 'attach: tmux -L', "the pane backend's own attach line — names the real tmux socket the operator's pane mode created"],
  ['src/utils/healthReport.ts', 'clamped for tmux', 'the colour clamp names the real terminal the session runs inside'],
  ['src/utils/healthReport.ts', 'terminal-overrides', "the same row's remedy for that real terminal"],
  ['src/daemon/crewSpawn.ts', 'You are @${name}, a Mercury crew teammate', "the named agent's own system prompt — model-facing bytes, not operator copy"],
  ['src/daemon/crewSpawn.ts', 'Other teammates may be working', 'the same prompt'],
  ['src/daemon/crewSpawn.ts', "role: 'teammate'", "the team-file member record's role value — a wire spelling"],
]

type Hit = { line: number; text: string; needle: string }

function blankComments(source: string): string {
  const keepNewlines = (m: string): string => m.replace(/[^\n]/g, ' ')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines)
    .replace(/(^|[ \t])\/\/[^\n]*/gm, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

function copyOf(source: string): Array<{ line: number; text: string }> {
  const text = blankComments(source)
  const lines = text.split('\n')
  const out: Array<{ line: number; text: string }> = []
  const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  let m: RegExpExecArray | null
  while ((m = literal.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length
    const lineText = lines[line - 1] ?? ''
    if (/^\s*(import|export)\b/.test(lineText) || /\bfrom\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index))) continue
    if (BARE_TOKEN.test(m[0])) continue
    out.push({ line, text: m[0].startsWith('`') ? m[0].replace(HOLES, ' ') : m[0] })
  }
  const jsx = />([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g
  while ((m = jsx.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length
    out.push({ line, text: m[1]! })
  }
  return out
}

function scan(source: string): Hit[] {
  const hits: Hit[] = []
  for (const piece of copyOf(source)) {
    for (const [needle, re] of NEEDLES) {
      if (re.test(piece.text)) hits.push({ line: piece.line, text: piece.text, needle })
    }
  }
  return hits
}

console.log('— §0 the scanner bites (poison control) —')
{
  const poison = [
    "const a = 'Team launch backend'",
    'const b = `attach: tmux -L ${s} attach`',
    '<Header>Teammates</Header>',
    "const c = 'no teammates yet'",
    "const d = 'a party seat'",
    '// a comment saying teammate never counts',
    "import x from './TeammateChatsView.js'",
    "const e = '/teammates · n new'",
    "const f = 'third-party seat'",
    "const g = kind === 'teammate'",
    'const h = `role ${teammate.identity.agentType}`',
    "const i = 'first-party gating'",
  ].join('\n')
  const hits = scan(poison)
  const lines = [...new Set(hits.map(h => h.line))].sort((a, b) => a - b).join(',')
  check('the poison\'s five sentences are caught, on their own lines', lines === '1,2,3,4,5', lines)
  check(
    'a comment, a module path, the /teammates command spelling, third-/first-party, a bare kind token and a template hole never count',
    !hits.some(h => h.line >= 6),
    hits.filter(h => h.line >= 6).map(h => `${h.line}:${h.text}`).join(' | '),
  )
}

console.log('— §1 the census —')
let allowedCount = 0
for (const rel of FILES) {
  let source: string
  try {
    source = readFileSync(join(ROOT, rel), 'utf8')
  } catch {
    check(`${rel} is present`, false)
    continue
  }
  const lines = source.split('\n')
  const hits = scan(source)
  const unallowed = hits.filter(h => {
    const lineText = lines[h.line - 1] ?? ''
    const allowed = ALLOW.some(([file, fragment]) => file === rel && lineText.includes(fragment))
    if (allowed) allowedCount++
    return !allowed
  })
  check(
    `${rel}: no retired word in its copy`,
    unallowed.length === 0,
    unallowed.map(h => `\n      ${rel}:${h.line} [${h.needle}] ${h.text.slice(0, 100)}`).join(''),
  )
}
console.log(`  (${allowedCount} allowed literal(s) — each with its reason in ALLOW)`)

console.log('— §2 every allowed fragment still exists (no dead exception) —')
for (const [file, fragment, reason] of ALLOW) {
  const present = readFileSync(join(ROOT, file), 'utf8').includes(fragment)
  check(`${file} carries '${fragment}' (${reason})`, present)
}

console.log(failures === 0 ? '\nprove-crew-vocabulary: ALL LAWS HOLD' : `\nprove-crew-vocabulary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
