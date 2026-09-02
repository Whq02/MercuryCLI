#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'continuation-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { recordSidechainTranscript, recordTranscript, getProject } = await import(
  '../../src/utils/sessionStorage/writer.js'
)
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.js')
const { asAgentId } = await import('../../src/types/ids.js')
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { ordinalOf } = await import('../../src/fabric/ordinal.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const msg = (uuid: string, text: string, parent: string | null): Record<string, unknown> => ({
  type: 'user',
  uuid,
  parentUuid: parent,
  isSidechain: true,
  message: { role: 'user', content: text },
  timestamp: new Date(1700000000000).toISOString(),
})

const lineCount = (p: string): number =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .filter(l => !l.includes('"metaKind":"mercury-transcript-header"')).length
    : 0

section('§A continuation rounds append only the NEW tail (per-file dedup)')
{
  const agentId = 'a-cont-growth-1'
  const file = getAgentTranscriptPath(asAgentId(agentId))
  const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  await recordSidechainTranscript([msg(u(1), 'one', null), msg(u(2), 'two', u(1))] as never, agentId)
  await getProject().flush()
  check('round 1 lands 2 lines', lineCount(file) === 2, String(lineCount(file)))

  await recordSidechainTranscript(
    [msg(u(1), 'one', null), msg(u(2), 'two', u(1)), msg(u(3), 'three', u(2))] as never,
    agentId,
  )
  await getProject().flush()
  check(
    'round 2 re-records the restored prefix — only the new tail lands (3 lines, not 5)',
    lineCount(file) === 3,
    String(lineCount(file)),
  )

  for (let round = 4; round <= 8; round++) {
    const all = Array.from({ length: round }, (_, i) =>
      msg(u(i + 1), `m${i + 1}`, i === 0 ? null : u(i)),
    )
    await recordSidechainTranscript(all as never, agentId)
  }
  await getProject().flush()
  check(
    'after 8 rounds the file holds exactly 8 rows (linear, never quadratic)',
    lineCount(file) === 8,
    String(lineCount(file)),
  )
}

section('§B fork-inherited UUIDs still land in the agent file once')
{
  const agentId = 'a-cont-growth-2'
  const file = getAgentTranscriptPath(asAgentId(agentId))
  const shared = '00000000-0000-4000-8000-777700000001'
  await recordTranscript([
    {
      type: 'user',
      uuid: shared,
      parentUuid: null,
      message: { role: 'user', content: 'main-thread turn' },
      timestamp: new Date(1700000000000).toISOString(),
    },
  ] as never)
  await getProject().flush()
  await recordSidechainTranscript([msg(shared, 'inherited copy', null)] as never, agentId)
  await getProject().flush()
  check(
    'a UUID already in the MAIN transcript still lands in the agent file (fork law)',
    lineCount(file) === 1,
    String(lineCount(file)),
  )
  await recordSidechainTranscript([msg(shared, 'inherited copy', null)] as never, agentId)
  await getProject().flush()
  check('…but only once (per-file dedup)', lineCount(file) === 1, String(lineCount(file)))
}

section('§C the per-file set seeds from DISK (fresh-process resume shape)')
{
  const agentId = 'a-cont-growth-3'
  const file = getAgentTranscriptPath(asAgentId(agentId))
  const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(11, '0')}9`
  mkdirSync(dirname(file), { recursive: true })
  let ordinal = 0
  const priorProcess = {
    sessionId: agentId as never,
    nextOrdinal: () => ordinalOf(++ordinal),
    observedAt: new Date(1700000000000).toISOString(),
    source: { channel: 'sdk' } as const,
  }
  writeFileSync(
    file,
    [msg(u(1), 'old-one', null), msg(u(2), 'old-two', u(1))]
      .map(entry => JSON.stringify(entryToRecord(entry, priorProcess as never)))
      .join('\n') + '\n',
  )
  await recordSidechainTranscript(
    [msg(u(1), 'old-one', null), msg(u(2), 'old-two', u(1)), msg(u(3), 'fresh', u(2))] as never,
    agentId,
  )
  await getProject().flush()
  check(
    'a fresh process dedups against what the file already holds (3 rows, not 5)',
    lineCount(file) === 3,
    String(lineCount(file)),
  )
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} CONTINUATION-GROWTH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CONTINUATION-GROWTH PROOFS PASS')
process.exit(0)
