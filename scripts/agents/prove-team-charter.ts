#!/usr/bin/env bun
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

const TEAMS_DIR = mkdtempSync(join(tmpdir(), 'charter-teams-'))
process.env.MERCURY_TEAMS_DIR = TEAMS_DIR
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'charter-home-'))
;(await import('../../src/utils/config/globalConfig.js')).enableConfigs()

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

section('§4 — the crew is born with the session and founded in ONE publish: nothing is half-made, nothing is unwound')
{
  const helpers = await import('../../src/utils/swarm/teamHelpers.js')
  const teammate = await import('../../src/utils/teammate.js')
  const state = await import('../../src/bootstrap/state.js')
  const birth = await import('../../src/utils/crew/crewBirth.js')
  const sid = String(state.getSessionId())
  const crew = birth.sessionCrewName(sid)
  check('a lead session registers its crew at birth (the brief and the coordination server resolve it)', birth.birthSessionCrew(sid) === crew && teammate.getLeadTeamFallback() === crew)
  check('precondition: no roster file before the first join', !existsSync(join(TEAMS_DIR, crew, 'config.json')))
  await helpers.appendTeamMember(crew, { agentId: `alpha@${crew}`, name: 'alpha', joinedAt: 1, tmuxPaneId: 'in-process', cwd: '/', subscriptions: [] } as never)
  const founded = await helpers.readTeamFileAsync(crew)
  check('the first join founds the whole roster at once: the lead and the member, led by this session', founded !== null && founded.leadSessionId === sid && founded.members.map(m => m.name).join(',') === 'team-lead,alpha')
  check('the founding is one atomic publish: no journal, no temp left beside the roster', !existsSync(join(TEAMS_DIR, '.journal')) && !existsSync(join(TEAMS_DIR, crew, 'inboxes')))
  const helpersSrc = src('utils', 'swarm', 'teamHelpers.ts')
  check('nothing in the roster owner removes a team directory or a worktree any more (structural)', !/cleanupTeamDirectories|destroyWorktree|'worktree', 'remove'/.test(helpersSrc))
  const operations = src('utils', 'swarm', 'teamOperations.ts')
  check('the teams journal keeps parsing an older build\'s create/delete records and removes nothing (structural)', /'team-create'/.test(operations) && /'team-delete'/.test(operations) && !/cleanupTeamDirectories|rm\(/.test(operations))
}

section('§5 — the delegation doctrine names crewmates, not a create step')
{
  const doctrine = src('utils', 'messages', 'attachmentText.ts')
  check('the doctrine names the crewmate road (the Agent tool with a name and a team_name)', doctrine.includes('the Agent tool with a name and a team_name'))
  check('the doctrine says every session has a crew from the moment it starts', doctrine.includes('every session has a crew from the moment it starts'))
  check('the doctrine names no TeamCreate tool', !doctrine.includes('TeamCreate'))
}

section('§6 — tool surface')
{
  const { getAllBaseTools } = await import('../../src/tools.js')
  const names = getAllBaseTools().map(t => t.name)
  check('no TeamCreate or TeamDelete tool is registered', !names.includes('TeamCreate') && !names.includes('TeamDelete'))
  check('the tool folders are gone', !existsSync(join(ROOT, 'src', 'tools', 'TeamCreateTool')) && !existsSync(join(ROOT, 'src', 'tools', 'TeamDeleteTool')))
  const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.js')
  check('an old transcript\'s TeamCreate row still resolves a render shim under its name', findToolForRender(getAllBaseTools(), 'TeamCreate').name === 'TeamCreate')
}

rmSync(TEAMS_DIR, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TEAM-CHARTER PROOFS PASS')
else {
  console.log(`❌ ${failures} TEAM-CHARTER PROOF(S) FAILED`)
  process.exit(1)
}
