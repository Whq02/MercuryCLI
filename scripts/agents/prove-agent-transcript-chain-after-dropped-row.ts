#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const k of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const) delete process.env[k]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-agent-chain-dropped-row-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const runAgent = (await import('../../src/tools/AgentTool/runAgent.ts')) as Record<string, unknown>
const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { getAgentTranscript } = await import('../../src/utils/sessionStorage/logs.ts')
const { isTranscribable } = await import('../../src/utils/sessionStorage/chain.ts')
type Message = import('../../src/types/message.ts').Message

const land = runAgent.landAgentTranscriptRows as (rows: Message[], agentId: string, parent?: string | null) => Promise<void>
const landStreamed = runAgent.landStreamedAttachment as ((row: Message, agentId: string, parent: string | undefined) => Promise<string | undefined>) | undefined
check('runAgent lands a streamed attachment through a seam that answers the next recorded parent', typeof landStreamed === 'function', 'the base advances lastRecordedUuid for every attachment, written or not (runAgent.ts, the attachment branch)')

if (landStreamed) {
  const agentId = 'agent-chain-proof'
  const seed = createUserMessage({ content: 'the brief' }) as Message
  await land([seed], agentId, null)
  const dropped = createAttachmentMessage({ type: 'diagnostics', files: [], isNew: false } as never) as Message
  check('an empty diagnostics attachment is not transcribable (the writer drops it)', !isTranscribable(dropped))
  const afterDropped = await landStreamed(dropped, agentId, seed.uuid)
  check('a dropped row does not become the next parent', afterDropped === seed.uuid, `parent after the dropped row: ${afterDropped}`)
  const kept = createAttachmentMessage({ type: 'images_left_out', count: 1, images: 1, sidePx: 1024 } as never) as Message
  const afterKept = await landStreamed(kept, agentId, afterDropped)
  check('a written row becomes the next parent', afterKept === kept.uuid, `parent after the kept row: ${afterKept}`)
  const answer = createUserMessage({ content: 'the next turn' }) as Message
  await land([answer], agentId, afterKept)
  const transcript = await getAgentTranscript(agentId as never)
  const uuids = transcript?.messages.map(m => m.uuid) ?? []
  check('the chain read back from the leaf reaches the brief (no severed prefix)', uuids.includes(seed.uuid) && uuids.includes(answer.uuid), `chain: ${uuids.length} rows`)
  check('the chain holds the kept attachment and not the dropped one', uuids.includes(kept.uuid) && !uuids.includes(dropped.uuid))
}

console.log(failures === 0 ? '\nALL AGENT TRANSCRIPT CHAIN PROOFS PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
