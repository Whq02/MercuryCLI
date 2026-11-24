#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const k of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const) delete process.env[k]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-resume-parity-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const storage = (await import('../../src/sessions/transcripts/sessionStorage.js')) as typeof import('../../src/sessions/transcripts/sessionStorage.js')
const agent = (await import('../../src/models/catalogue/agentModel.js')) as typeof import('../../src/models/catalogue/agentModel.js')
const record = (await import('../../src/crew/crewmates/crewmateRecord.js')) as typeof import('../../src/crew/crewmates/crewmateRecord.js')

console.log('============================================================')
console.log(' Launch parity across resume — proof')
console.log('============================================================')

section('§1 the metadata carrier (round-trip, hermetic home)')
{
  const id = 'resume-parity-proof-agent'
  await storage.writeCrewmateMetadata(id as Parameters<typeof storage.writeCrewmateMetadata>[0], {
    agentType: 'mercury-crew',
    description: 'proof',
    model: 'glm-5.2',
    effortOverride: 'high',
  })
  const back = await storage.readCrewmateMetadata(id as Parameters<typeof storage.readCrewmateMetadata>[0])
  check('model round-trips', back?.model === 'glm-5.2', JSON.stringify(back) + ' · fix writeAgentMetadata and readAgentMetadata in src/sessions/transcripts/sessionStorage.ts')
  check('effortOverride round-trips', back?.effortOverride === 'high', JSON.stringify(back) + ' · fix writeAgentMetadata and readAgentMetadata in src/sessions/transcripts/sessionStorage.ts')
  check('agentType/description intact', back?.agentType === 'mercury-crew' && back?.description === 'proof', JSON.stringify(back) + ' · fix writeAgentMetadata and readAgentMetadata in src/sessions/transcripts/sessionStorage.ts')
}

section('§2 the restore chain (getAgentModel is id-stable)')
{
  const parent = 'claude-opus-4-8[1m]'
  check(
    "restored 'claude-sonnet-5' dispatches claude-sonnet-5 (not the parent)",
    agent.getCrewmateModel('inherit', parent, 'claude-sonnet-5' as never) === 'claude-sonnet-5',
    agent.getCrewmateModel('inherit', parent, 'claude-sonnet-5' as never) + ' · fix getAgentModel in src/models/catalogue/agentModel.ts',
  )
  check(
    "restored 'glm-5.2' dispatches glm-5.2 (the zai transport — no silent provider switch)",
    agent.getCrewmateModel('inherit', parent, 'glm-5.2' as never) === 'glm-5.2',
    agent.getCrewmateModel('inherit', parent, 'glm-5.2' as never) + ' · fix getAgentModel in src/models/catalogue/agentModel.ts',
  )
  const haikuRestore = agent.getCrewmateModel('inherit', parent, 'haiku' as never)
  check('a restored haiku alias dispatches as the haiku row', /haiku/i.test(haikuRestore), haikuRestore + ' · fix getAgentModel in src/models/catalogue/agentModel.ts')
  check(
    'absent persisted model ⇒ legacy re-resolution (inherit → parent)',
    agent.getCrewmateModel('inherit', parent, undefined) === parent,
    'fix getAgentModel in src/models/catalogue/agentModel.ts to return the parent model when no persisted model is given',
  )
}

  {
    const fresh = { agentType: 'mercury-crew', swarm: false }
    const withOverride = record.recordAtRunStart(null, { model: 'sonnet', effortOverride: 'high' }, { fresh, model: 'claude-sonnet-5', effortOverride: 'high', effort: 'high' })
    const without = record.recordAtRunStart(null, { model: undefined, effortOverride: undefined }, { fresh, model: 'claude-sonnet-5', effortOverride: undefined, effort: undefined })
    check(
      'the run-start merge writes the dispatched model and the effort override the run resolved, and no effortOverride key when none was given (crewmateRecord)',
      withOverride.model === 'claude-sonnet-5' && withOverride.effortOverride === 'high' && withOverride.effort === 'high'
        && without.model === 'claude-sonnet-5' && !('effortOverride' in without) && !('effort' in without),
      JSON.stringify({ withOverride, without }) + ' · fix recordAtRunStart in src/crew/crewmates/crewmateRecord.ts',
    )
  }

console.log('')
if (failures > 0) {
  console.log(`❌ resume-parity: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ resume-parity: launch parity survives the resume boundary')
