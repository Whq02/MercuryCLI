import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SessionContractV1 } from '../../daemon/sessionContract.js'
import { CONTRACT_TOOL_NAME, CONTRACT_TOOL_PROMPT, DESCRIPTION } from '../../constants/tools/contract.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['read', 'acknowledge', 'check-in', 'sufficiency', 'propose-amend', 'close-against']),
    restatement: z.string().max(20_000).optional().describe('acknowledge: the contract in your own words.'),
    about: z.string().max(4_000).optional().describe('check-in: what you are about to do.'),
    proposal: z.string().max(4_000).optional().describe('propose-amend: clause that does not survive contact, and why.'),
    report: z.string().max(20_000).optional().describe('close-against: what was delivered, what was not, and why.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('The result and the standard to hold yourself to — advisory, never a gate.'),
    status: z.string().optional().describe('The contract’s lifecycle status.'),
    text: z.string().optional().describe('The agreement’s current text.'),
    amendments: z.number().optional().describe('Superseded texts kept in the record’s history.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export function contractToolHosted(): boolean {
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

async function readOwnContract(): Promise<{ contract: SessionContractV1 | undefined; title: string; found: boolean }> {
  const { readSessionWorkers } = await import('../../daemon/concourseWorkers.js')
  const sessionId = getSessionId()
  const rec = Object.values(readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  return { contract: rec?.contract, title: rec?.title ?? sessionId.slice(0, 8), found: rec !== undefined }
}

async function contractVerb(op: 'ack' | 'close'): Promise<{ ok: boolean; detail?: string }> {
  const sessionId = getSessionId()
  const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
  const reply = (await daemonControlRpc(
    {
      op: 'sessionControl',
      action: 'contract',
      sessionId,
      by: `worker:${sessionId.slice(0, 8)}`,
      contract: { op },
      clientOpId: `contract-${op}-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`,
    },
    { timeoutMs: 10_000 },
  )) as { ok?: boolean; outcome?: string; detail?: string }
  return { ok: reply.ok === true && (reply.outcome === 'applied' || reply.outcome === 'noop'), ...(reply.detail !== undefined ? { detail: reply.detail } : {}) }
}

const NO_CONTRACT =
  'This session has no contract — that is normal and fine (contracts are advisory and opt-in). Work as briefed; the operator can add one any time with /contract.'

export const ContractTool: Unbuilt = unbuilt('src/tools/ContractTool/ContractTool.ts:65')
