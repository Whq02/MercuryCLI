#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'transcript-destination-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/engine/tasks/tasks.js')
const { resolveCrewmateTranscriptFile, crewmateTranscriptFileIn } = await import(
  '../../src/crew/crewmates/agentTranscriptReader.js'
)
const { recordSidechainTranscript, registerCrewmateTranscriptDestination, getProject } =
  await import('../../src/sessions/transcripts/writer.js')
const { getCrewmateTranscriptPath } = await import('../../src/sessions/transcripts/paths.js')
const { asAgentId } = await import('../../src/sessions/transcripts/ids.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('the destination is captured at launch; readers fall back across dirs')
{
  const agentId = 'a-dest-capture'
  const captured = join(mkdtempSync(join(tmpdir(), 'transcript-destination-dest-')), 'agent-a-dest-capture.jsonl')
  registerCrewmateTranscriptDestination(agentId, captured)
  await recordSidechainTranscript(
    [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-000000000077',
        parentUuid: null,
        isSidechain: true,
        message: { role: 'user', content: 'captured-destination row' },
        timestamp: new Date(1700000000000).toISOString(),
      },
    ] as never,
    agentId,
  )
  await getProject().flush()
  check('the sidechain write landed at the CAPTURED destination', existsSync(captured),
    `no file at ${captured}; the write path in src/sessions/transcripts/writer.ts (recordSidechainTranscript, agentTranscriptDestinations lookup near lines 492 and 508) must use the path given to registerAgentTranscriptDestination`)
  const derived = getCrewmateTranscriptPath(asAgentId(agentId))
  check('…not at the live-derived path', !existsSync(derived), `${derived} exists; src/sessions/transcripts/writer.ts must prefer the registered destination over getAgentTranscriptPath`)

  const oldDir = mkdtempSync(join(tmpdir(), 'transcript-destination-old-'))
  const newDir = mkdtempSync(join(tmpdir(), 'transcript-destination-new-'))
  writeFileSync(crewmateTranscriptFileIn(oldDir, 'agX'), '{"type":"user"}\n')
  check(
    'the reader falls back to the OLD destination when the primary is empty',
    resolveCrewmateTranscriptFile([newDir, oldDir], 'agX') === crewmateTranscriptFileIn(oldDir, 'agX'),
    'resolveAgentTranscriptFile in src/crew/crewmates/agentTranscriptReader.ts must return the first dir in the list whose agent-<id>.jsonl exists',
  )
  check(
    'with no file anywhere the primary path is still named (honest missing state)',
    resolveCrewmateTranscriptFile([newDir, oldDir], 'agY') === crewmateTranscriptFileIn(newDir, 'agY'),
    'resolveAgentTranscriptFile in src/crew/crewmates/agentTranscriptReader.ts must return the first dir path when no dir holds the file',
  )
  rmSync(oldDir, { recursive: true, force: true })
  rmSync(newDir, { recursive: true, force: true })
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} TRANSCRIPT-DESTINATION PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TRANSCRIPT-DESTINATION PROOFS PASS')
process.exit(0)
