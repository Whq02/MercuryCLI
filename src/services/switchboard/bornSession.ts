import { catalogFirstChat } from '../../utils/bootCardFacts.js'
import { logForDebugging } from '../../utils/debug.js'
import { emitFocusedSessionConnectorChanged, getFocusedSessionConnector, subscribeFocusedSessionConnector, withLanding } from '../engine-connector/focusedConnector.js'
import { armLandingWords, birthFallbackModel, birthModelOf, bootBirthFacts, carriedConsentOf, carriedKitOf, screenBirthModel, settleLandingWords, takeBootTitle, takeWornPresetKit } from './bootBirthFacts.js'
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

function savedDefaultRoad(resolved: string): boolean {
  const { getMainLoopModelOverride } = require('../../bootstrap/state.js') as typeof import('../../bootstrap/state.js')
  if (getMainLoopModelOverride() !== undefined) return false
  const { getSettings_DEPRECATED } = require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
  const { parseUserSpecifiedModel } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
  const saved = getSettings_DEPRECATED().model
  return typeof saved === 'string' && saved.trim() !== '' && parseUserSpecifiedModel(saved) === resolved
}

export function settledCatalogueRefusal(family: string): string | null {
  if (family === 'gemini') {
    const { getGeminiAvailability } = require('../providers/gemini/geminiCatalogue.js') as typeof import('../providers/gemini/geminiCatalogue.js')
    const a = getGeminiAvailability()
    return a.state === 'disabled' && a.why === 'auth-invalid' ? a.reason : null
  }
  if (family === 'openai') {
    const { getGptSeatAvailability } = require('../providers/openai/openaiCatalogue.js') as typeof import('../providers/openai/openaiCatalogue.js')
    const a = getGptSeatAvailability()
    return a.state === 'disabled' && a.why === 'auth-expired' ? a.reason : null
  }
  if (family === 'openrouter') {
    const { getOpenrouterAvailability } = require('../providers/openrouter/openrouterCatalogue.js') as typeof import('../providers/openrouter/openrouterCatalogue.js')
    const a = getOpenrouterAvailability()
    return a.state === 'disabled' && a.why === 'auth-invalid' ? a.reason : null
  }
  if (family === 'huggingface') {
    const { getHuggingfaceAvailability } = require('../providers/huggingface/huggingfaceCatalogue.js') as typeof import('../providers/huggingface/huggingfaceCatalogue.js')
    const a = getHuggingfaceAvailability()
    return a.state === 'disabled' && a.why === 'auth-invalid' ? a.reason : null
  }
  return null
}

function birthModelForSignedInFamily(resolved: string | undefined, screenRoad: boolean): { setting: string | undefined; receipt: string | null } {
  if (resolved === undefined || !screenRoad) return { setting: resolved, receipt: null }
  try {
    if (!savedDefaultRoad(resolved)) return { setting: resolved, receipt: null }
    const { declaredRouteOf, providerDisplayName } = require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    const { computedDefault } = require('../../utils/model/computedDefault.js') as typeof import('../../utils/model/computedDefault.js')
    const decision = computedDefault()
    const fallback =
      decision.source === 'keyless' || decision.provider === null
        ? null
        : { setting: decision.setting, family: decision.provider, row: decision.row }
    const family = declaredRouteOf(resolved)
    const considered = family !== null ? decision.considered.find(c => c.family === family) : undefined
    const refusal = considered === undefined || family === null ? null : settledCatalogueRefusal(family)
    const swap = birthFallbackModel(resolved, {
      family,
      familyWord: family ?? resolved,
      hasCredential: considered !== undefined,
      refusal,
      fallback,
      providerName: providerDisplayName,
    })
    return swap === undefined ? { setting: resolved, receipt: null } : { setting: swap.setting, receipt: swap.receipt }
  } catch {
    return { setting: resolved, receipt: null }
  }
}

async function birth(req: BirthRequest): Promise<BirthOutcome> {
  const facts = bootBirthFacts()
  if (facts.model === null && (req.model ?? null) === null) {
    const { readComputedDefaultCatalogue } = await import('../../utils/model/computedDefault.js')
    await readComputedDefaultCatalogue()
  }
  const screen = screenBirthModel()
  const resolved = screen === undefined ? undefined : birthModelOf(facts, req.model ?? null, screen)
  const born = birthModelForSignedInFamily(resolved, facts.model === null && (req.model ?? null) === null)
  const model = born.setting
  const effort = facts.effort ?? getInitialEffortSetting() ?? null
  armLandingWords({ model: model ?? null, effort, permissionMode: facts.permissionMode })
  emitFocusedSessionConnectorChanged()
  try {
    const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
    if (!(await ensureOwnedDaemon())) return { ok: false, reason: DAEMON_DID_NOT_START }
    const title = req.title !== undefined ? (req.title === null || req.title.trim() === '' ? null : req.title.trim()) : takeBootTitle()
    const worn = takeWornPresetKit()
    return await admitAndEnter(req, { model, title, effort, worn, facts, fallbackNote: born.receipt })
  } finally {
    settleLandingWords()
  }
}

async function admitAndEnter(
  req: BirthRequest,
  birth: { model: string | undefined; title: string | null; effort: string | null; worn: { name: string; kit: SessionKitV1 } | null; facts: BootBirthFacts; fallbackNote: string | null },
): Promise<BirthOutcome> {
  const { model, title, effort, worn, facts, fallbackNote } = birth
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
  if (fallbackNote !== null && fallbackNote !== '') mintOnBornChat(sessionId, fallbackNote)
  return { ok: true, sessionId, title: hop.title }
}

function mintOnBornChat(sessionId: string, text: string): void {
  const paint = (): boolean => {
    const focused = getFocusedSessionConnector()
    if (focused.sessionId() !== sessionId) return false
    mintImmediateReceipt(text, 'warning')
    return true
  }
  if (paint()) return
  const stop = subscribeFocusedSessionConnector(() => {
    if (paint()) stop()
  })
}
