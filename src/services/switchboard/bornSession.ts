import { catalogFirstChat } from '../../utils/bootCardFacts.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { logForDebugging } from '../../utils/debug.js'
import { withLanding } from '../engine-connector/focusedConnector.js'
import { birthModelOf, bootBirthFacts, carriedKitOf, takeBootTitle, takeWornPresetKit } from './bootBirthFacts.js'
import { hopIntoBoardSession } from './hopIntoSession.js'

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

async function birth(req: BirthRequest): Promise<BirthOutcome> {
  const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
  if (!(await ensureOwnedDaemon())) return { ok: false, reason: DAEMON_DID_NOT_START }
  const facts = bootBirthFacts()
  const title = req.title !== undefined ? (req.title === null || req.title.trim() === '' ? null : req.title.trim()) : takeBootTitle()
  const worn = takeWornPresetKit()
  const model = birthModelOf(facts, req.model ?? null, getMainLoopModel())
  let reply: Record<string, unknown>
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    reply = (await daemonControlRpc(
      {
        op: 'sessionAdmit',
        workspaceDir: req.workspaceDir,
        isolation: 'shared',
        model,
        bornBlank: true,
        ...(title !== null ? { title } : {}),
        ...(facts.effort !== null ? { effort: facts.effort } : {}),
        ...(facts.permissionMode !== null ? { permissionMode: facts.permissionMode } : {}),
        ...(facts.runnerArgv.length > 0 ? { runnerArgv: [...facts.runnerArgv] } : {}),
        ...(worn !== null ? { kit: worn.kit } : carriedKitOf(facts)),
        ...(req.vacatingSessionId !== undefined ? { vacatingSessionId: req.vacatingSessionId } : {}),
      } as never,
      { timeoutMs: 30_000 },
    )) as Record<string, unknown>
  } catch (e) {
    return { ok: false, reason: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
  }
  const sessionId = typeof reply.sessionId === 'string' ? reply.sessionId : undefined
  if (reply.ok !== true || sessionId === undefined) {
    return { ok: false, reason: String(reply.error ?? 'the session could not start') }
  }
  catalogFirstChat(req.workspaceDir, sessionId)
  const hop = await hopIntoBoardSession(sessionId, req.firstPaintMs !== undefined ? { firstPaintMs: req.firstPaintMs } : undefined)
  if (!hop.ok) {
    logForDebugging(`[switchboard] born session ${sessionId} could not be entered: ${hop.reason}`)
    return { ok: false, reason: hop.reason }
  }
  return { ok: true, sessionId, title: hop.title }
}
