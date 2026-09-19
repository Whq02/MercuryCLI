import { catalogFirstChat } from '../../utils/bootCardFacts.js'
import { logForDebugging } from '../../utils/debug.js'
import { emitFocusedSessionConnectorChanged, withLanding } from '../engine-connector/focusedConnector.js'
import { armLandingWords, birthModelOf, bootBirthFacts, carriedConsentOf, carriedKitOf, screenBirthModel, settleLandingWords, takeBootTitle, takeWornPresetKit } from './bootBirthFacts.js'
import { hopIntoBoardSession } from './hopIntoSession.js'
import { mintImmediateReceipt } from '../../utils/model/seatReceipts.js'
import { getInitialEffortSetting } from '../../utils/effort.js'
import type { SessionKitV1 } from '../../daemon/sessionKit.js'
import type { BootBirthFacts } from './bootBirthFacts.js'

export type BirthOutcome =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; reason: string }

export interface BirthRequest {
  workspaceDir: string
  model?: string | null
  title?: string | null
  firstPaintMs?: number
  vacatingSessionId?: string
}

export const DAEMON_DID_NOT_START =
  'the daemon that hosts sessions did not become ready — ↵ retries; if it keeps waiting, `mercury daemon stop` clears a daemon that holds the pipe but never answers'

export function bornSession(req: BirthRequest): Promise<BirthOutcome> {
  return withLanding(birth(req))
}

export function operatorFacingBirthReason(reason: string): string {
  return reason
    .replace(/\bask the operator to /g, '')
    .replace(/leave the model out for its newest row \(([^)]+)\), or name '[a-z-]+' to pick that family/g, '/model $1 picks its newest row')
}

async function birth(req: BirthRequest): Promise<BirthOutcome> {
  const facts = bootBirthFacts()
  const screen = screenBirthModel()
  const model = screen === undefined ? undefined : birthModelOf(facts, req.model ?? null, screen)
  const effort = facts.effort ?? getInitialEffortSetting() ?? null
  armLandingWords({ model: model ?? null, effort, permissionMode: facts.permissionMode })
  emitFocusedSessionConnectorChanged()
  try {
    const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
    if (!(await ensureOwnedDaemon())) return { ok: false, reason: DAEMON_DID_NOT_START }
    const title = req.title !== undefined ? (req.title === null || req.title.trim() === '' ? null : req.title.trim()) : takeBootTitle()
    const worn = takeWornPresetKit()
    return await admitAndEnter(req, { model, title, effort, worn, facts })
  } finally {
    settleLandingWords()
  }
}

async function admitAndEnter(
  req: BirthRequest,
  birth: { model: string | undefined; title: string | null; effort: string | null; worn: { name: string; kit: SessionKitV1 } | null; facts: BootBirthFacts },
): Promise<BirthOutcome> {
  const { model, title, effort, worn, facts } = birth
  let reply: Record<string, unknown>
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    reply = (await daemonControlRpc(
      {
        op: 'sessionAdmit',
        workspaceDir: req.workspaceDir,
        isolation: 'shared',
        ...(model !== undefined ? { model } : {}),
        bornBlank: true,
        ...(title !== null ? { title } : {}),
        ...(effort !== null ? { effort } : {}),
        ...(facts.permissionMode !== null ? { permissionMode: facts.permissionMode } : {}),
        ...carriedConsentOf(facts),
        ...(facts.runnerArgv.length > 0 ? { runnerArgv: [...facts.runnerArgv] } : {}),
        ...(worn !== null ? { kit: worn.kit } : carriedKitOf(facts)),
        ...(req.vacatingSessionId !== undefined ? { vacatingSessionId: req.vacatingSessionId } : {}),
      } as never,
      { timeoutMs: 60_000 },
    )) as Record<string, unknown>
  } catch (e) {
    return { ok: false, reason: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
  }
  const sessionId = typeof reply.sessionId === 'string' ? reply.sessionId : undefined
  if (reply.ok !== true || sessionId === undefined) {
    return { ok: false, reason: operatorFacingBirthReason(String(reply.error ?? 'the session could not start')) }
  }
  if (typeof reply.note === 'string' && reply.note !== '') mintImmediateReceipt(`▲ ${reply.note}`, 'warning')
  catalogFirstChat(req.workspaceDir, sessionId)
  const hop = await hopIntoBoardSession(sessionId, req.firstPaintMs !== undefined ? { firstPaintMs: req.firstPaintMs } : undefined)
  if (!hop.ok) {
    logForDebugging(`[switchboard] born session ${sessionId} could not be entered: ${hop.reason}`)
    return { ok: false, reason: operatorFacingBirthReason(hop.reason) }
  }
  return { ok: true, sessionId, title: hop.title }
}
