#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-team-charter.ts — TeamCreate as a CHARTERED operation
//
//
//    §1 charter derivation: deterministic, structured-fields-win, honest
//       fallback when nothing was stated
//    §2 charter parsing: v1 round-trips; foreign shapes and pre-charter
//       team files return null (migration tolerance)
//    §3 legacy team files still READ (no charter field required)
//    §4 creation is atomic: the unwind path removes the team directory and
//       every leader registration — disk and UI never disagree
//    §5 the prompt teaches the two-independent-lanes rule and generates the
//       roster from the LIVE registry; the "when in doubt, prefer a team"
//       doctrine and the stale generic role examples are absent
//    §6 the tool has a real user-facing name and a structured result card
//
//  Run: ~/.bun/bin/bun run scripts/agents/prove-team-charter.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Team charter — derivation, migration, atomicity, doctrine')
console.log('============================================================')

// Hermetic teams home BEFORE any team helper is used.
const TEAMS_DIR = mkdtempSync(join(tmpdir(), 'charter-teams-'))
process.env.MERCURY_TEAMS_DIR = TEAMS_DIR

const charter = await import('../../src/utils/swarm/teamCharter.js')

section('§1 — derivation')
{
  const a = charter.deriveTeamCharter({
    teamName: 't1',
    description: 'ship the refactor',
    createdAt: 1000,
  })
  const b = charter.deriveTeamCharter({
    teamName: 't1',
    description: 'ship the refactor',
    createdAt: 1000,
  })
  check('deterministic: same inputs ⇒ equal charters', JSON.stringify(a) === JSON.stringify(b))
  check('objective derives from description', a.objective === 'ship the refactor')
  check('synthesis owner defaults to the lead', a.synthesisOwner === 'team-lead')

  const c = charter.deriveTeamCharter({
    teamName: 't1',
    description: 'ignored',
    objective: 'split checkout into two services',
    successCriteria: ['payment suite green'],
    createdAt: 1000,
  })
  check('structured objective wins over description', c.objective === 'split checkout into two services')
  check('success criteria carried', c.successCriteria.length === 1 && c.successCriteria[0] === 'payment suite green')

  const d = charter.deriveTeamCharter({ teamName: 'bare', createdAt: 5 })
  check('nothing stated ⇒ honest underspecified objective (never invented goals)', d.objective.includes('no objective was stated'))
}

section('§2 — parsing (migration tolerance)')
{
  const good = charter.deriveTeamCharter({ teamName: 'x', description: 'd', createdAt: 1 })
  check('v1 charter round-trips through JSON', charter.parseTeamCharter(JSON.parse(JSON.stringify(good)))?.objective === 'd')
  check('null ⇒ null', charter.parseTeamCharter(null) === null)
  check('pre-charter shape (undefined) ⇒ null', charter.parseTeamCharter(undefined) === null)
  check('foreign version ⇒ null', charter.parseTeamCharter({ ...good, version: 99 }) === null)
  check('junk criteria filtered, not fatal', (charter.parseTeamCharter({ ...good, successCriteria: ['ok', 42, null] })?.successCriteria ?? []).join() === 'ok')
}

section('§3 — legacy team files still read')
{
  const helpers = await import('../../src/utils/swarm/teamHelpers.js')
  const legacy = {
    name: 'legacy-team',
    createdAt: 123,
    leadAgentId: 'team-lead@legacy-team',
    members: [
      { agentId: 'team-lead@legacy-team', name: 'team-lead', joinedAt: 123, tmuxPaneId: '', cwd: '/', subscriptions: [] },
    ],
  }
  mkdirSync(join(TEAMS_DIR, 'legacy-team'), { recursive: true })
  writeFileSync(join(TEAMS_DIR, 'legacy-team', 'config.json'), JSON.stringify(legacy))
  const read = await helpers.readTeamFileAsync('legacy-team')
  check('pre-charter team file parses', read?.name === 'legacy-team' && read.members.length === 1)
  check('absent charter stays absent (no fabrication)', read?.charter === undefined)
  check('parseTeamCharter on the absent field ⇒ null', charter.parseTeamCharter(read?.charter) === null)
}

section('§4 — atomic creation: the unwind leaves nothing behind')
{
  const helpers = await import('../../src/utils/swarm/teamHelpers.js')
  const tasks = await import('../../src/utils/tasks.js')
  const teammate = await import('../../src/utils/teammate.js')
  const tool = await import('../../src/tools/TeamCreateTool/TeamCreateTool.js')

  // Simulate the creation steps up to the failure point…
  const name = 'doomed-team'
  await helpers.writeTeamFileAsync(name, {
    name,
    createdAt: 1,
    leadAgentId: `team-lead@${name}`,
    members: [],
  } as never)
  helpers.registerTeamForSessionCleanup(name)
  tasks.setLeaderTeamName(name)
  teammate.setLeadTeamFallback(name)
  let appState: { teamContext?: { teamName: string } } = { teamContext: { teamName: name } }
  check('precondition: team dir exists', existsSync(join(TEAMS_DIR, name, 'config.json')))

  // …then unwind, exactly as a mid-creation failure does.
  await tool.unwindTeamCreation(name, (f: (p: typeof appState) => typeof appState) => {
    appState = f(appState)
  })
  check('team directory removed', !existsSync(join(TEAMS_DIR, name)))
  check('lead-team fallback cleared', teammate.getLeadTeamFallback() === null)
  check('teamContext cleared from app state', appState.teamContext === undefined)
  check('unwind clears the leader task-list registration (structural)', /clearLeaderTeamName\(\)/.test(src('tools', 'TeamCreateTool', 'TeamCreateTool.ts')))
  void tasks

  // The call path wires the unwind: structural anchor.
  const toolSrc = src('tools', 'TeamCreateTool', 'TeamCreateTool.ts')
  check('call() unwinds on post-file failure', /catch \(e\) \{\s*\n\s*await unwindTeamCreation\(finalTeamName, setAppState\)/.test(toolSrc))
  check('failure message names the unwound state', /The team was unwound/.test(toolSrc))
}

section('§5 — prompt doctrine + generated roster')
{
  const { getPrompt } = await import('../../src/tools/TeamCreateTool/prompt.js')
  const fakeAgents = [
    { agentType: 'mercury-scout', whenToUse: 'Read-only search agent for broad fan-out searches. Long tail here.', tools: ['Read', 'Grep', 'Glob'], source: 'built-in' },
    { agentType: 'general-purpose', whenToUse: 'General-purpose agent for complex tasks.', source: 'built-in' },
  ] as never[]
  const p = getPrompt(fakeAgents as never)
  check('two-independent-lanes rule present', p.includes('TWO OR MORE genuinely independent lanes'))
  check('"when in doubt, prefer a team" is GONE', !/when in doubt/i.test(p))
  check('anti-default: do not create a team just in case', p.includes('Do not create a team "just in case"'))
  check('roster generated from the registry (scout line)', p.includes('**mercury-scout** (read-only)'))
  check('roster capability derived from tool contract', p.includes('**general-purpose** (full-capability)'))
  check('charter-before-spawn: synthesis owner + owned surface + deliverable', p.includes('synthesis owner') && p.includes('owned surface') && p.includes('deliverable'))
  check('decomposition by ownership, not job titles', p.includes('not by vague job titles'))
  check('no periodic file re-reading doctrine', p.includes('Do not re-read team/task files each turn'))
  check('atomicity promised where taught', p.includes('Creation is atomic'))
  check('stale generic examples gone ("researcher", "test-runner")', !p.includes('"researcher"') && !p.includes('"test-runner"'))

  const toolSrc = src('tools', 'TeamCreateTool', 'TeamCreateTool.ts')
  check('schema no longer teaches generic role names', !toolSrc.includes('"researcher", "test-runner"'))
  check('schema carries objective/success_criteria', /objective:/.test(toolSrc) && /success_criteria:/.test(toolSrc))
}

section('§6 — tool surface')
{
  const tool = await import('../../src/tools/TeamCreateTool/TeamCreateTool.js')
  check('userFacingName is real', tool.TeamCreateTool.userFacingName(undefined) === 'TeamCreate')
  const ui = src('tools', 'TeamCreateTool', 'UI.tsx')
  check('use line carries the objective', /input\.objective \?\? input\.description/.test(ui))
  check('result card: team + lead + backend', /lead \$\{output\.lead_agent_id\}/.test(ui) && /getResolvedTeammateMode\(\)/.test(ui))
  check('result card names the next useful action', /next: TaskCreate the work lanes/.test(ui))
  check('search text extracts the objective', /objective: \$\{output\.objective\}/.test(ui))
}

rmSync(TEAMS_DIR, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TEAM-CHARTER PROOFS PASS')
else {
  console.log(`❌ ${failures} TEAM-CHARTER PROOF(S) FAILED`)
  process.exit(1)
}
