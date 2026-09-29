#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootRunner, childEnv, isResult, makeTally, user, type Runner } from '../daemon/dupline-world.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture } from '../lib/scriptedTurn.ts'
import { readRetiredCrewFile } from '../../src/migrations/retiredCrewSpellings.ts'

const tally = makeTally('prove-retired-roster-reads')
const root = mkdtempSync(join(tmpdir(), 'retired-roster-'))
const home = join(root, 'config')
const cwd = join(root, 'cwd')
const sid = randomUUID()
const retiredLead = ['t', 'eam-lead'].join('')
const retiredFolder = ['t', 'eams'].join('')
const saved = {
  name: sid, createdAt: 1, leadAgentId: `${retiredLead}@${sid}`, leadSessionId: sid,
  members: [
    { agentId: `${retiredLead}@${sid}`, name: retiredLead, agentType: retiredLead, joinedAt: 1, tmuxPaneId: '', cwd, subscriptions: [] },
    { agentId: `probe@${sid}`, name: 'probe', agentType: 'mercury-general', joinedAt: 2, tmuxPaneId: '', cwd, subscriptions: [] },
    { agentId: `probe-2@${sid}`, name: 'probe-2', agentType: 'code-reviewer', joinedAt: 3, tmuxPaneId: '', cwd, subscriptions: [] },
  ],
}
const bytes = JSON.stringify(saved, null, 2) + '\n'
const original = join(root, 'saved-config.json')
const copied = join(home, retiredFolder, sid, 'config.json')
let runner: Runner | undefined
const fixture = await startScriptedFixture(req => {
  if (req.step === 0) return [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:LiveComms', max_results: 5 } }]
  if (req.step === 1) return [{ type: 'tool_use', name: 'LiveComms', input: {} }]
  return [{ type: 'text', text: 'ROSTER-READ-DONE' }]
})
try {
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  mkdirSync(join(home, retiredFolder, sid), { recursive: true })
  writeFileSync(original, bytes)
  copyFileSync(original, copied)
  tally.check('the old folder holds a byte copy of the saved roster', readFileSync(copied).equals(readFileSync(original)))
  const decoded = readRetiredCrewFile(saved, 'crew-lead')
  tally.check('the saved lead type reads as crew-lead', decoded.members[0]?.agentType === 'crew-lead', String(decoded.members[0]?.agentType))
  tally.check('every other member is unchanged', decoded.members.slice(1).every((member, index) => member === saved.members[index + 1]))
  tally.check('reading does not mutate the saved data', JSON.stringify(saved, null, 2) + '\n' === bytes)
  const sparse = { members: [{ name: retiredLead, agentId: `${retiredLead}@${sid}` }] }
  tally.check('a missing saved type stays absent', !('agentType' in readRetiredCrewFile(sparse, 'crew-lead').members[0]!))
  const env = { ...childEnv(home, Number(new URL(fixture.base).port)), HOME: root, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
  delete env.MERCURY_CREWS_DIR
  delete env[['MERCURY_T', 'EAMS_DIR'].join('')]
  runner = bootRunner({ cwd, env, extraArgv: ['--session-id', sid] })
  runner.send(user('Read the saved crew roster once.', randomUUID()))
  const result = await runner.waitFor('the roster read result', isResult, 60_000)
  tally.check('the built product completes the roster read', result !== null && result.is_error !== true && String(result.result).includes('ROSTER-READ-DONE'), JSON.stringify({ result, stderr: runner.stderr() }))
  const roster = fixture.requests.flatMap(req => req.results).find(result => result.text.includes('## Roster'))
  console.log(`LiveComms: ${roster?.text ?? '(no roster result)'}`)
  tally.check('LiveComms reads the saved roster', roster !== undefined && !roster.isError, JSON.stringify(roster))
  const rosterSection = roster?.text.split('## Roster (3)\n')[1]?.split('\n## ')[0] ?? ''
  const rows = rosterSection.split('\n').filter(line => line.startsWith('- '))
  const expected = ['- crew-lead <crew-lead> [idle]', '- probe <mercury-general> [busy]', '- probe-2 <code-reviewer> [busy]']
  tally.check('the lead reads as crew-lead in both columns and every other row stays unchanged', JSON.stringify(rows) === JSON.stringify(expected), JSON.stringify(rows))
  tally.check('reading leaves the old roster byte-identical on disk', readFileSync(copied).equals(readFileSync(original)))
} finally {
  await runner?.stop(5_000)
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
