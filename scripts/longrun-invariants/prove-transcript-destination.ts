#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'transcript-destination-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { resolveAgentTranscriptFile, agentTranscriptFile } = await import(
  '../../src/utils/crew/agentTranscriptReader.js'
)
const { recordSidechainTranscript, registerAgentTranscriptDestination, getProject } =
  await import('../../src/utils/sessionStorage/writer.js')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.js')
const { asAgentId } = await import('../../src/types/ids.js')

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
  registerAgentTranscriptDestination(agentId, captured)
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
  check('the sidechain write landed at the CAPTURED destination', existsSync(captured))
  const derived = getAgentTranscriptPath(asAgentId(agentId))
  check('…not at the live-derived path', !existsSync(derived), derived)

  const oldDir = mkdtempSync(join(tmpdir(), 'transcript-destination-old-'))
  const newDir = mkdtempSync(join(tmpdir(), 'transcript-destination-new-'))
  writeFileSync(agentTranscriptFile(oldDir, 'agX'), '{"type":"user"}\n')
  check(
    'the reader falls back to the OLD destination when the primary is empty',
    resolveAgentTranscriptFile([newDir, oldDir], 'agX') === agentTranscriptFile(oldDir, 'agX'),
  )
  check(
    'with no file anywhere the primary path is still named (honest missing state)',
    resolveAgentTranscriptFile([newDir, oldDir], 'agY') === agentTranscriptFile(newDir, 'agY'),
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
