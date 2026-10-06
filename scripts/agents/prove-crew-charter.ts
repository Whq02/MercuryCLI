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
console.log(' Crew charter — derivation, migration, atomicity, doctrine')
console.log('============================================================')

const CREWS_DIR = mkdtempSync(join(tmpdir(), 'charter-crews-'))
process.env.MERCURY_CREWS_DIR = CREWS_DIR
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'charter-home-'))
;(await import('../../src/utils/config/globalConfig.js')).enableConfigs()

const charter = await import('../../src/utils/crew/crewCharter.js')

section('§1 — derivation')
{
  const a = charter.deriveCrewCharter({
    crewName: 't1',
    description: 'ship the refactor',
    createdAt: 1000,
  })
  const b = charter.deriveCrewCharter({
    crewName: 't1',
    description: 'ship the refactor',
    createdAt: 1000,
  })
  check('deterministic: same inputs ⇒ equal charters', JSON.stringify(a) === JSON.stringify(b))
  check('objective derives from description', a.objective === 'ship the refactor')
  check('synthesis owner defaults to the lead', a.synthesisOwner === 'crew-lead')

  const c = charter.deriveCrewCharter({
    crewName: 't1',
    description: 'ignored',
    objective: 'split checkout into two services',
    successCriteria: ['payment suite green'],
    createdAt: 1000,
  })
  check('structured objective wins over description', c.objective === 'split checkout into two services')
  check('success criteria carried', c.successCriteria.length === 1 && c.successCriteria[0] === 'payment suite green')

  const d = charter.deriveCrewCharter({ crewName: 'bare', createdAt: 5 })
  check('nothing stated ⇒ honest underspecified objective (never invented goals)', d.objective.includes('no objective was stated'))
}

section('§2 — parsing (migration tolerance)')
{
  const good = charter.deriveCrewCharter({ crewName: 'x', description: 'd', createdAt: 1 })
  check('v1 charter round-trips through JSON', charter.parseCrewCharter(JSON.parse(JSON.stringify(good)))?.objective === 'd')
  check('null ⇒ null', charter.parseCrewCharter(null) === null)
  check('pre-charter shape (undefined) ⇒ null', charter.parseCrewCharter(undefined) === null)
  check('foreign version ⇒ null', charter.parseCrewCharter({ ...good, version: 99 }) === null)
  check('junk criteria filtered, not fatal', (charter.parseCrewCharter({ ...good, successCriteria: ['ok', 42, null] })?.successCriteria ?? []).join() === 'ok')
}

section('§3 — legacy crew files still read')
{
  const helpers = await import('../../src/utils/crew/crewHelpers.js')
  const legacy = {
    name: 'legacy-crew',
    createdAt: 123,
    leadAgentId: 'crew-lead@legacy-crew',
    members: [
      { agentId: 'crew-lead@legacy-crew', name: 'crew-lead', joinedAt: 123, tmuxPaneId: '', cwd: '/', subscriptions: [] },
    ],
  }
  mkdirSync(join(CREWS_DIR, 'legacy-crew'), { recursive: true })
  writeFileSync(join(CREWS_DIR, 'legacy-crew', 'config.json'), JSON.stringify(legacy))
  const read = await helpers.readCrewFileAsync('legacy-crew')
  check('pre-charter crew file parses', read?.name === 'legacy-crew' && read.members.length === 1)
  check('absent charter stays absent (no fabrication)', read?.charter === undefined)
  check('parseCrewCharter on the absent field ⇒ null', charter.parseCrewCharter(read?.charter) === null)
}

section('§4 — the crew is born with the session and founded in ONE publish: nothing is half-made, nothing is unwound')
{
  const helpers = await import('../../src/utils/crew/crewHelpers.js')
  const crewmate = await import('../../src/utils/crewmate.js')
  const state = await import('../../src/bootstrap/state.js')
  const birth = await import('../../src/utils/crew/crewBirth.js')
  const sid = String(state.getSessionId())
  const crew = birth.sessionCrewName(sid)
  check('a lead session registers its crew at birth (the brief and the coordination server resolve it)', birth.birthSessionCrew(sid) === crew && crewmate.getLeadCrewFallback() === crew)
  check('precondition: no roster file before the first join', !existsSync(join(CREWS_DIR, crew, 'config.json')))
  await helpers.appendCrewMember(crew, { agentId: `alpha@${crew}`, name: 'alpha', joinedAt: 1, tmuxPaneId: 'in-process', cwd: '/', subscriptions: [] } as never)
  const founded = await helpers.readCrewFileAsync(crew)
  check('the first join founds the whole roster at once: the lead and the member, led by this session', founded !== null && founded.leadSessionId === sid && founded.members.map(m => m.name).join(',') === 'crew-lead,alpha')
  check('the founding is one atomic publish: no journal, no temp left beside the roster', !existsSync(join(CREWS_DIR, '.journal')) && !existsSync(join(CREWS_DIR, crew, 'inboxes')))
  const helpersSrc = src('utils', 'crew', 'crewHelpers.ts')
  check('nothing in the roster owner removes a crew directory or a worktree any more (structural)', !/cleanupCrewDirectories|destroyWorktree|'worktree', 'remove'/.test(helpersSrc))
  const operations = src('utils', 'crew', 'crewOperations.ts')
  check('the crews journal keeps parsing an older build\'s create/delete records and removes nothing (structural)', /'crew-create'/.test(operations) && /'crew-delete'/.test(operations) && !/cleanupCrewDirectories|rm\(/.test(operations))
}

section('§5 — the model-facing text names the crewmate road, not a create step')
{
  const agentTool = src('tools', 'AgentTool', 'AgentTool.tsx')
  check('the Agent tool names the crewmate road (a name), apart from an agent type', !agentTool.includes('crew_name') && agentTool.includes('Name for a long-lived crewmate'))
  const doctrine = src('utils', 'messages', 'attachmentText.ts')
  check('neither the Agent tool nor the attachment text names a CrewCreate tool', !doctrine.includes('TeamCreate') && !agentTool.includes('TeamCreate'))
}

section('§6 — tool surface')
{
  const { getAllBaseTools } = await import('../../src/tools.js')
  const names = getAllBaseTools().map(t => t.name)
  check('no CrewCreate or CrewDelete tool is registered', !names.includes('TeamCreate') && !names.includes('TeamDelete'))
  check('the tool folders are gone', !existsSync(join(ROOT, 'src', 'tools', 'CrewCreateTool')) && !existsSync(join(ROOT, 'src', 'tools', 'CrewDeleteTool')))
  const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.js')
  check('an old transcript\'s CrewCreate row still resolves a render shim under its name', findToolForRender(getAllBaseTools(), 'TeamCreate').name === 'TeamCreate')
}

rmSync(CREWS_DIR, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CREW-CHARTER PROOFS PASS')
else {
  console.log(`❌ ${failures} CREW-CHARTER PROOF(S) FAILED`)
  process.exit(1)
}
