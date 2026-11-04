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

const land = runAgent.landAgentTranscriptRows as (rows: Message[], agentId: string, parent?: string | null) => Promise<string | undefined>
const { writtenChainTail } = await import('../../src/utils/sessionStorage/chain.ts')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')

const agentId = 'agent-chain-proof'
const seed = createUserMessage({ content: 'the brief' }) as Message
const seedParent = await land([seed], agentId, null)
check('landing the brief answers its uuid as the next parent', seedParent === seed.uuid)
const dropped = createAttachmentMessage({ type: 'diagnostics', files: [], isNew: false } as never) as Message
check('an empty diagnostics attachment is not transcribable (the writer drops it)', !isTranscribable(dropped))
const afterDropped = await land([dropped], agentId, seedParent)
check('a dropped attachment does not become the next parent', afterDropped === seed.uuid, `parent after the dropped row: ${afterDropped}`)
const empty = createAssistantMessage({ content: [] } as never) as Message
check('the writer also drops an empty-content assistant row, and so does the tail', writtenChainTail([empty], afterDropped) === seed.uuid)
const afterEmpty = await land([empty], agentId, afterDropped)
check('an empty-content assistant row does not become the next parent', afterEmpty === seed.uuid, `parent after the empty row: ${afterEmpty}`)
const kept = createAttachmentMessage({ type: 'images_left_out', count: 1, images: 1, sidePx: 1024 } as never) as Message
const afterKept = await land([kept], agentId, afterEmpty)
check('a written row becomes the next parent', afterKept === kept.uuid, `parent after the kept row: ${afterKept}`)
check('the seed of a batch is its last written row, not its last row', writtenChainTail([seed, dropped]) === seed.uuid)
const answer = createUserMessage({ content: 'the next turn' }) as Message
await land([answer], agentId, afterKept)
const transcript = await getAgentTranscript(agentId as never)
const uuids = transcript?.messages.map(m => m.uuid) ?? []
check('the chain read back from the leaf reaches the brief (no severed prefix)', uuids.includes(seed.uuid) && uuids.includes(answer.uuid), `chain: ${uuids.length} rows`)
check('the chain holds the kept attachment and neither dropped row', uuids.includes(kept.uuid) && !uuids.includes(dropped.uuid) && !uuids.includes(empty.uuid))

console.log(failures === 0 ? '\nALL AGENT TRANSCRIPT CHAIN PROOFS PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
