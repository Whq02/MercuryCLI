import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SessionContractV1 } from '../../daemon/sessionContract.js'
import { CONTRACT_TOOL_NAME, CONTRACT_TOOL_PROMPT, DESCRIPTION } from './prompt.js'

// ============================================================================
//  ContractTool — the ABIDE TOOL (coordinator-tooling ledger T3+T4): the one
//  agent-facing door onto the session's advisory contract, on daemon-hosted
//  sessions only (the MERCURY_CONCOURSE_WORKER role stamp gates it).
//  Encouragement-shaped, never a fence: every action returns words for the
//  agent to judge by; nothing here (or anywhere) blocks on contract state.
//
//  read / check-in / sufficiency read the durable session record directly
//  (the same fail-soft reader every surface uses). acknowledge and
//  close-against WRITE — and writes go only through the daemon's one verb
//  (sessionControl action 'contract'), keeping the record's one-writer law.
//  propose-amend is T3's amendment door: a needs-you obligation through the
//  estate's durable obligations owner — the operator/coordinator amends,
//  the worker re-acknowledges; silent drift and being stuck both retired.
//  close-against files the receipt FIRST through the landed seam
//  (sessionReceipts.appendSessionReceipt, kind 'contract-close' — the
//  receipts estate owns that module; this file only imports and calls),
//  then closes through the verb.
// ============================================================================

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['read', 'acknowledge', 'check-in', 'sufficiency', 'propose-amend', 'close-against'])
      .describe('read · acknowledge (your restatement) · check-in (a move, judged by you) · sufficiency (complete enough? ask-with-the-gap or continue) · propose-amend (the honest stop) · close-against (the closing report)'),
    restatement: z.string().max(20_000).optional().describe('acknowledge: the contract in YOUR OWN words — the restatement is the signature.'),
    about: z.string().max(4_000).optional().describe('check-in: what you are about to do.'),
    proposal: z.string().max(4_000).optional().describe('propose-amend: the clause that does not survive contact, and why.'),
    report: z.string().max(20_000).optional().describe('close-against: the closing report against the contract’s items — delivered, not delivered, and why.'),
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
export type Output = z.infer<OutputSchema>

/** Gate: the daemon stamps MERCURY_CONCOURSE_WORKER=1 on every session
 *  runner it hosts — fixed for the process lifetime, so list membership is
 *  stable (the catalogue-order law). */
export function contractToolHosted(): boolean {
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

async function readOwnContract(): Promise<{ contract: SessionContractV1 | undefined; title: string; found: boolean }> {
  const { readSessionWorkers } = await import('../../daemon/concourseSupervisor.js')
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
      // Exactly-once under a lost reply: the daemon's applied-ops ledger
      // replays the receipt instead of re-running the op.
      clientOpId: `contract-${op}-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`,
    } as never,
    { timeoutMs: 10_000 },
  )) as { ok?: boolean; outcome?: string; detail?: string }
  return { ok: reply.ok === true && (reply.outcome === 'applied' || reply.outcome === 'noop'), ...(reply.detail !== undefined ? { detail: reply.detail } : {}) }
}

const NO_CONTRACT =
  'This session has no contract — that is normal and fine (contracts are advisory and opt-in). Work as briefed; the operator can add one any time with /contract.'

export const ContractTool = buildTool({
  name: CONTRACT_TOOL_NAME,
  searchHint: 'contract / the session work agreement: read, acknowledge, check in, sufficiency, propose amendment, close against',
  maxResultSizeChars: 50_000,
  userFacingName: () => 'Contract',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return contractToolHosted()
  },
  isConcurrencySafe() {
    return false // acknowledge/close order against the record's own writes
  },
  isReadOnly() {
    return false // acknowledge, propose-amend and close-against write
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return CONTRACT_TOOL_PROMPT
  },
  getActivityDescription(input) {
    return input?.action ? `Contract: ${input.action}` : 'Contract'
  },
  renderToolUseMessage(input) {
    return input?.action ?? ''
  },
  renderToolResultMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call({ action, restatement, about, proposal, report }) {
    const { contract, title, found } = await readOwnContract()
    if (!found) {
      // An attached/plain boot has no record to speak for — honest, never
      // fabricated. (The tool is gated to daemon-hosted runs, so this is a
      // record-read failure face, not the normal path.)
      return { data: { message: 'No session record answers for this run — the contract store is unreadable right now. Continue working; nothing gates on it.' } }
    }
    const facts = (c: SessionContractV1): { status: string; text: string; amendments: number } => ({
      status: c.status,
      text: c.text,
      amendments: c.amendments.length,
    })
    switch (action) {
      case 'read': {
        if (contract === undefined) return { data: { message: NO_CONTRACT } }
        const owing =
          contract.status === 'draft' || contract.status === 'amended'
            ? ' It awaits YOUR acknowledgment: restate it in your own words via { action: "acknowledge", restatement } — the restatement is what makes it stick.'
            : contract.status === 'closed'
              ? ' It is closed — kept for the record.'
              : ''
        return { data: { message: `The session's contract, fresh from the record.${owing} Advisory always — it encourages, never blocks.`, ...facts(contract) } }
      }
      case 'acknowledge': {
        if (contract === undefined) return { data: { message: NO_CONTRACT } }
        if ((restatement ?? '').trim().length === 0) {
          throw new Error('acknowledge needs your restatement — the contract in your own words is the signature; never an empty ack.')
        }
        const r = await contractVerb('ack')
        if (!r.ok) return { data: { message: `The acknowledgment did not land — ${r.detail ?? 'the daemon was unreachable'}. The contract stands unchanged; try again or continue (advisory).`, ...facts(contract) } }
        return { data: { message: `Acknowledged — the agreement is in force (your restatement above is the signature, kept in this transcript). Work under it; check-in when unsure; propose-amend when a clause does not survive contact.`, ...facts({ ...contract, status: 'acknowledged' }) } }
      }
      case 'check-in': {
        if (contract === undefined) return { data: { message: `${NO_CONTRACT} Nothing to check against.` } }
        const move = (about ?? '').trim()
        if (move.length === 0) throw new Error('check-in needs `about` — say what you are about to do.')
        return {
          data: {
            message: `You are about to: ${move}\n\nHold that against the agreement below — YOU judge whether it is on-contract; nothing is blocked either way. On-contract: continue. Off-contract but needed: propose-amend with the why, or ask the user.`,
            ...facts(contract),
          },
        }
      }
      case 'sufficiency': {
        if (contract === undefined) {
          return { data: { message: `${NO_CONTRACT} Sufficiency without a contract is your brief and your judgment: if the task in front of you has a material gap, ASK THE USER naming the gap; otherwise CONTINUE.` } }
        }
        return {
          data: {
            message:
              'Assess whether this contract is COMPLETE ENOUGH for the work in front of you. The honest outcomes are exactly two: ASK THE USER — naming the specific gap (propose-amend carries it to them as a needs-you) — or CONTINUE. Never silently fill a material gap with a guess.',
            ...facts(contract),
          },
        }
      }
      case 'propose-amend': {
        const clause = (proposal ?? '').trim()
        if (clause.length === 0) throw new Error('propose-amend needs `proposal` — the clause that does not survive contact, and why.')
        if (contract === undefined) return { data: { message: `${NO_CONTRACT} Nothing to amend — if the BRIEF has the gap, ask the user directly.` } }
        const sessionId = getSessionId()
        const { upsertObligation } = await import('../../services/crew/obligations.js')
        // T3's amendment door: ONE open needs-you per session (the ref is
        // deterministic — a re-proposal updates the row in place, never
        // stacks ghosts), through the estate's durable obligations owner.
        await upsertObligation({
          ref: `contract-amend:${sessionId}`,
          sessionId,
          question: `"${title}" proposes a contract amendment — ${clause.replace(/\s+/g, ' ').slice(0, 200)}`,
          owner: 'operator',
          scope: 'switchboard',
        })
        return {
          data: {
            message:
              'Proposed — the operator/coordinator has a needs-you with your reasoning; they amend, you re-acknowledge. Meanwhile the contract stands as written (advisory): continue what remains on-contract, or end your turn asking the user if nothing does. Silent drift and being stuck are both retired.',
            ...facts(contract),
          },
        }
      }
      case 'close-against': {
        if (contract === undefined) return { data: { message: `${NO_CONTRACT} Nothing to close against — close out with your ordinary summary.` } }
        const closing = (report ?? '').trim()
        if (closing.length === 0) throw new Error('close-against needs `report` — what was delivered against the contract’s items, what was not, and why.')
        const sessionId = getSessionId()
        // The receipt FIRST, through the landed seam (the receipts estate
        // owns the module; the contract estate writes through append), into
        // the transcript's own home — then the verb closes the record. A
        // crash between the two leaves a receipted, still-open contract:
        // benign, re-closable.
        const { appendSessionReceipt } = await import('../../services/switchboard/sessionReceipts.js')
        const { getTranscriptPath } = await import('../../utils/sessionStorage/paths.js')
        const { dirname } = await import('node:path')
        appendSessionReceipt(dirname(getTranscriptPath()), sessionId, {
          at: new Date().toISOString(),
          by: `worker:${sessionId.slice(0, 8)}`,
          kind: 'contract-close',
          summary: closing,
          details: {
            status: contract.status,
            amendments: contract.amendments.length,
            ...(contract.ackAt !== undefined ? { ackAt: contract.ackAt } : {}),
          },
        })
        const r = await contractVerb('close')
        return {
          data: {
            message: r.ok
              ? 'The closing report is filed as a receipt beside the transcript and the contract is closed — text and history kept (never deleted).'
              : `The closing report is filed as a receipt, but the close did not land — ${r.detail ?? 'the daemon was unreachable'}. The contract stays ${contract.status}; close-against again retries the close (the receipt trail is append-only, so the retry files another entry).`,
            ...facts(contract),
          },
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
