import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  client as acpClientApp,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import { withDeadline } from '../../../platform/async/deadline.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { getPlatform } from '../../../platform/environment/platform.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { getPathsForPermissionCheck } from '../../../platform/files/fsOperations.js'
import { localPath } from '../../../platform/files/path.js'
import { nativePathToShell } from '../../../platform/host-os/paths.js'
import { isRecord } from '../../../platform/primitives/isRecord.js'
import { devinCliChildEnv, subprocessEnv } from '../../../platform/processes/subprocessEnv.js'
import {
  isExternalPermissionOptionKind,
  sanitizeExternalCardText,
  type ExternalPermissionOption,
  type ExternalSeatPermissionAsk,
} from '../../../permissions/cards/externalSeatAsk.js'
import { ruleMatcherFor } from '../../../permissions/rules/filesystem.js'
import { expandTilde } from '../../../permissions/rules/pathValidation.js'
import { applyPermissionRulesToPermissionContext } from '../../../permissions/rules/permissionDoor.js'
import { loadAllPermissionRulesFromDisk } from '../../../permissions/rules/permissionsLoader.js'
import type { ToolPermissionContext } from '../../../tools/kit/tool.js'
import { publishAtomicSync } from '../../../platform/substrate/fileStore.js'
import { stripTerminalControls } from '../../../platform/text/strings.js'
import type { CapabilityKind, CapabilityState } from '../capabilities.js'
import { crewStoreRoot } from '../identity.js'
import type {
  ExternalSeatHostContext,
  ExternalSeatTransport,
  SeatDeliveryOutcome,
  SeatDeliveryRequest,
  SeatEvent,
  SeatHandshakeResult,
  SeatTurnSettlement,
} from '../seatBridge.js'
import { realNdjsonChild, type NdjsonChildLike, type SpawnImpl } from './ndjsonChild.js'

const HANDSHAKE_TIMEOUT_MS = 20_000
const SESSION_NEW_TIMEOUT_MS = 20_000
const MAX_TURN_REPLY_INLINE_CHARS = 4_000
const MAX_TURN_REPLY_OVERFLOW_CHARS = 524_288
type AcpAdapterKind = 'opencode' | 'goose' | 'devin'

interface ActiveTurn {
  gen: number
  sessionId: string | null
  clientMessageId: string
  settled: boolean
  replyChunks: string[]
  replyStoredChars: number
  replyTotalChars: number
}
interface ActiveAsk {
  askId: string
  gen: number
  cancel: (sendReply: boolean) => void
}

interface AcpClientState {
  adapterKind: AcpAdapterKind
  displayName: string
  seatCwd: string
  command: [cmd: string, ...args: string[]]
  spawnImpl: SpawnImpl
  getPermissionContext?: () => ToolPermissionContext
  child: NdjsonChildLike | null
  conn: ClientConnection | null
  childGen: number
  sessionId: string | null
  activeTurn: ActiveTurn | null
  seatCtx: ExternalSeatHostContext | null
  eventSeq: number
  askSeq: number
  activeAsks: Map<string, ActiveAsk>
  eventListeners: Set<(evt: SeatEvent) => void>
  lifecycleListeners: Set<(s: 'connected' | 'disconnected' | 'exited') => void>
  sessionIdentityListeners: Set<(externalSessionId: string) => void>
  turnSettledListeners: Set<(settlement: Omit<SeatTurnSettlement, 'seatId'>) => void>
}

function isValidStopReason(value: unknown): value is StopReason {
  return (
    value === 'end_turn' ||
    value === 'max_tokens' ||
    value === 'max_turn_requests' ||
    value === 'refusal' ||
    value === 'cancelled'
  )
}

function acpDeclaredCapabilities(
  init: InitializeResponse,
): Partial<Record<CapabilityKind, { state: CapabilityState; source: string }>> {
  const caps = isRecord(init.agentCapabilities) ? init.agentCapabilities : {}
  const prompt = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {}
  return {
    'start-turn': { state: 'supported', source: 'acp:session/prompt (v1)' },
    'hold-next': { state: 'unknown', source: 'acp:no queued-delivery vocabulary — Mercury-local holds are a separate fact' },
    'steer-current': { state: 'unsupported', source: 'acp:no mid-turn injection method in v1' },
    'cancel-turn': { state: 'supported', source: 'acp:session/cancel (v1)' },
    'attach-file': { state: 'supported', source: 'acp:resource_link content' },
    'attach-image': {
      state: prompt.image === true ? 'supported' : 'unsupported',
      source: `acp:promptCapabilities.image=${String(prompt.image ?? 'absent')}`,
    },
    'attach-selection': {
      state: prompt.embeddedContext === true ? 'supported' : 'unsupported',
      source: `acp:promptCapabilities.embeddedContext=${String(prompt.embeddedContext ?? 'absent')}`,
    },
    'resume-session': {
      state: caps.loadSession === true ? 'supported' : 'unsupported',
      source: `acp:agentCapabilities.loadSession=${String(caps.loadSession ?? 'absent')}`,
    },
    'set-title': { state: 'unknown', source: 'acp:no title method in the stable v1 surface' },
    'structured-activity': { state: 'supported', source: 'acp:session/update tool_call notifications' },
    'usage-totals': { state: 'unknown', source: 'acp:usage_update is not in every agent — unnegotiated' },
    'artifact-replies': { state: 'unsupported', source: 'acp:no artifact-thread vocabulary in v1' },
  }
}

function streamOfNdjsonChild(c: NdjsonChildLike): Stream {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let unsubLine: (() => void) | null = null
  let unsubExit: (() => void) | null = null
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        unsubLine?.()
        unsubExit?.()
        try {
          controller.close()
        } catch (error) {
          passedOver(error)
        }
      }
      unsubLine = c.onLine(line => {
        if (closed) return
        controller.enqueue(encoder.encode(line.endsWith('\n') ? line : `${line}\n`))
      })
      unsubExit = c.onExit(() => close())
    },
    cancel() {
      unsubLine?.()
      unsubExit?.()
    },
  })
  let outBuffer = ''
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      outBuffer += decoder.decode(chunk, { stream: true })
      let nl = outBuffer.indexOf('\n')
      while (nl >= 0) {
        const line = outBuffer.slice(0, nl)
        outBuffer = outBuffer.slice(nl + 1)
        if (line.trim() !== '' && c.write(line) === false) {
          throw new Error('ACP child stdin is closed')
        }
        nl = outBuffer.indexOf('\n')
      }
    },
    close() {
      const tail = (outBuffer + decoder.decode()).trim()
      outBuffer = ''
      if (tail !== '' && c.write(tail) === false) {
        throw new Error('ACP child stdin is closed')
      }
    },
  })
  return ndJsonStream(output, input)
}

function parsePermissionOptions(raw: RequestPermissionRequest['options']): ExternalPermissionOption[] {
  const seen = new Set<string>()
  const out: ExternalPermissionOption[] = []
  for (const item of raw) {
    if (typeof item.optionId !== 'string' || item.optionId.trim() === '') continue
    if (!isExternalPermissionOptionKind(item.kind)) continue
    if (seen.has(item.optionId)) continue
    seen.add(item.optionId)
    out.push({
      optionId: item.optionId,
      name: sanitizeExternalCardText(item.name, 80) || item.kind,
      kind: item.kind,
    })
  }
  return out
}

function failClosedResponse(options: readonly ExternalPermissionOption[]): RequestPermissionResponse {
  const rejectOnce = options.find(opt => opt.kind === 'reject_once')
  if (rejectOnce) return { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } }
  const rejectAlways = options.find(opt => opt.kind === 'reject_always')
  if (rejectAlways) return { outcome: { outcome: 'selected', optionId: rejectAlways.optionId } }
  return { outcome: { outcome: 'cancelled' } }
}

function extractConcretePaths(toolCall: RequestPermissionRequest['toolCall']): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  for (const loc of toolCall.locations ?? []) push(loc.path)
  for (const item of toolCall.content ?? []) {
    if (item.type === 'diff') push(item.path)
  }
  if (isRecord(toolCall.rawInput)) {
    for (const key of ['file_path', 'path', 'filePath', 'old_path', 'new_path', 'target_path', 'destination', 'source']) {
      push(toolCall.rawInput[key])
    }
    if (Array.isArray(toolCall.rawInput.paths)) {
      for (const entry of toolCall.rawInput.paths) push(entry)
    }
  }
  return out
}

function readLivePermissionContext(
  getPermissionContext: (() => ToolPermissionContext | null | undefined) | undefined,
): ToolPermissionContext | null {
  if (getPermissionContext === undefined) return null
  let base: ToolPermissionContext | null | undefined
  try {
    base = getPermissionContext()
  } catch (error) {
    passedOver(error)
    return null
  }
  if (base === null || base === undefined) return null
  try {
    return applyPermissionRulesToPermissionContext(base, loadAllPermissionRulesFromDisk())
  } catch (error) {
    passedOver(error)
    return null
  }
}

function isDeniedByMercuryRules(
  rawPaths: readonly string[],
  toolKind: string | undefined,
  seatCwd: string,
  context: ToolPermissionContext,
): boolean {
  if (rawPaths.length === 0) return false
  const platform = getPlatform()
  const workingForms = [
    ...new Set(getPathsForPermissionCheck(seatCwd).map(form => nativePathToShell(form, platform))),
  ]
  const families: Array<'read' | 'edit'> =
    toolKind === 'read' || toolKind === 'search' ? ['read'] : ['edit', 'read']
  const matchers = families
    .map(family => ruleMatcherFor(context, family, 'deny', workingForms))
    .filter((fn): fn is NonNullable<ReturnType<typeof ruleMatcherFor>> => fn !== null)
  if (matchers.length === 0) return false
  for (const rawPath of rawPaths) {
    const expanded = expandTilde(rawPath)
    const absolute = isAbsolute(expanded) ? expanded : resolvePath(seatCwd, expanded)
    for (const candidate of getPathsForPermissionCheck(localPath(absolute), seatCwd)) {
      for (const match of matchers) {
        if (match(candidate, false).length > 0) return true
      }
    }
  }
  return false
}

function sanitizeRawInputDetail(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) return undefined
  try {
    const text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
    if (!text || text === '{}' || text === '[]') return undefined
    const cleaned = sanitizeExternalCardText(text, 300)
    return cleaned === '' ? undefined : cleaned
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function buildPromptBlocks(
  req: SeatDeliveryRequest,
  seatCwd: string,
): {
  prompt: ContentBlock[]
  attachments: Array<{ attachmentId: string; outcome: 'accepted' | 'rejected'; reason?: string }>
} {
  const prompt: ContentBlock[] = [{ type: 'text', text: req.instruction }]
  const attachments: Array<{ attachmentId: string; outcome: 'accepted' | 'rejected'; reason?: string }> = []
  for (const att of req.attachments) {
    if (att.kind === 'file') {
      const ref = att.ref.trim()
      if (ref === '') {
        attachments.push({ attachmentId: att.attachmentId, outcome: 'rejected', reason: 'empty file reference' })
        continue
      }
      const uri = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)
        ? ref
        : pathToFileURL(isAbsolute(ref) ? ref : resolvePath(seatCwd, ref)).href
      prompt.push({ type: 'resource_link', uri, name: att.label || basename(ref) })
      attachments.push({ attachmentId: att.attachmentId, outcome: 'accepted' })
    } else if (att.kind === 'selection') {
      prompt.push({
        type: 'resource',
        resource: { uri: `mercury://selection/${att.attachmentId}`, text: att.ref },
      })
      attachments.push({ attachmentId: att.attachmentId, outcome: 'accepted' })
    } else {
      attachments.push({
        attachmentId: att.attachmentId,
        outcome: 'rejected',
        reason: `acp transport does not encode '${att.kind}' attachments`,
      })
    }
  }
  return { prompt, attachments }
}

function validateInitialize(
  displayName: string,
  result: InitializeResponse,
): { ok: true; init: InitializeResponse; revision: string } | { ok: false; reason: string } {
  if (!isRecord(result)) {
    return {
      ok: false,
      reason: `${displayName} ACP handshake refused: malformed initialize result (Mercury requires numeric ACP v1)`,
    }
  }
  const version: unknown = result.protocolVersion
  if (typeof version !== 'number' || version !== 1) {
    const got = version === undefined ? 'absent' : JSON.stringify(version)
    return {
      ok: false,
      reason: `${displayName} ACP handshake refused: unsupported protocolVersion ${got} (Mercury requires numeric ACP v1)`,
    }
  }
  const info = isRecord(result.agentInfo) ? result.agentInfo : null
  const name = typeof info?.name === 'string' && info.name.trim() !== '' ? info.name.trim() : displayName
  const ver = typeof info?.version === 'string' && info.version.trim() !== '' ? info.version.trim() : 'unknown'
  return { ok: true, init: result, revision: `${name}/${ver}` }
}

function clearPendingAsks(state: AcpClientState, sendCancelReply: boolean): void {
  for (const ask of [...state.activeAsks.values()]) {
    state.activeAsks.delete(ask.askId)
    ask.cancel(sendCancelReply)
  }
}

function appendTurnReplyChunk(turn: ActiveTurn, rawText: string): void {
  const clean = stripTerminalControls(rawText).replace(/\r\n?/g, '\n')
  if (clean === '') return
  turn.replyTotalChars += clean.length
  const remaining = MAX_TURN_REPLY_OVERFLOW_CHARS - turn.replyStoredChars
  if (remaining <= 0) return
  const kept = clean.length <= remaining ? clean : clean.slice(0, remaining)
  turn.replyChunks.push(kept)
  turn.replyStoredChars += kept.length
}

function finalizeTurnReply(
  state: AcpClientState,
  turn: ActiveTurn,
): Pick<
  SeatTurnSettlement,
  'reply' | 'replyChars' | 'replySavedChars' | 'replyOmittedChars' | 'replyTruncated' | 'replyOverflowPath' | 'replySaveError'
> {
  if (turn.replyTotalChars === 0) return {}
  const full = turn.replyChunks.join('')
  if (turn.replyTotalChars <= MAX_TURN_REPLY_INLINE_CHARS) {
    return { reply: full, replyChars: turn.replyTotalChars }
  }
  const inline = full.slice(0, MAX_TURN_REPLY_INLINE_CHARS)
  const omitted = Math.max(0, turn.replyTotalChars - full.length)
  let replyOverflowPath: string | undefined
  let replySaveError: string | undefined
  try {
    const safeSeat = (state.seatCtx?.seatId ?? state.adapterKind).replace(/[^A-Za-z0-9._-]/g, '_')
    const safeMsg = turn.clientMessageId.replace(/[^A-Za-z0-9._-]/g, '_')
    const target = join(crewStoreRoot(), 'replies', `${safeSeat}-${safeMsg}.txt`)
    publishAtomicSync(target, full, { mode: 0o600 })
    replyOverflowPath = target
  } catch (error) {
    passedOver(error)
    replySaveError = error instanceof Error ? error.message : String(error)
  }
  return {
    reply: inline,
    replyChars: turn.replyTotalChars,
    replySavedChars: replyOverflowPath !== undefined ? full.length : 0,
    replyOmittedChars: replyOverflowPath !== undefined ? omitted : turn.replyTotalChars - inline.length,
    replyTruncated: true,
    ...(replyOverflowPath !== undefined ? { replyOverflowPath } : {}),
    ...(replySaveError !== undefined ? { replySaveError } : {}),
  }
}

function settleTurn(
  state: AcpClientState,
  turn: ActiveTurn,
  status: SeatTurnSettlement['status'],
  extra: { stopReason?: string; reason?: string } = {},
): void {
  if (turn.settled) return
  turn.settled = true
  if (state.activeTurn === turn) state.activeTurn = null
  clearPendingAsks(state, false)
  const replyFields = finalizeTurnReply(state, turn)
  const settlement: Omit<SeatTurnSettlement, 'seatId'> = {
    ...(turn.sessionId !== null ? { sessionId: turn.sessionId } : {}),
    clientMessageId: turn.clientMessageId,
    status,
    ...(extra.stopReason !== undefined ? { stopReason: extra.stopReason } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...replyFields,
    atMs: Date.now(),
  }
  for (const l of [...state.turnSettledListeners]) {
    try {
      l(settlement)
    } catch (error) {
      passedOver(error)
    }
  }
}

async function stopChild(
  state: AcpClientState,
  c: NdjsonChildLike | null,
  conn: ClientConnection | null,
  gen: number,
): Promise<void> {
  if (gen === state.childGen) {
    state.childGen++
    state.child = null
    state.conn = null
    state.sessionId = null
  }
  clearPendingAsks(state, false)
  try {
    conn?.close()
  } catch (error) {
    passedOver(error)
  }
  if (c) await (c.killAndWait?.() ?? Promise.resolve(c.kill()))
}

function handlePermissionRequest(
  state: AcpClientState,
  c: NdjsonChildLike,
  gen: number,
  reqId: string | number | null,
  params: RequestPermissionRequest,
  signal: AbortSignal,
): Promise<RequestPermissionResponse> {
  const options = parsePermissionOptions(params.options)
  const boundTurn = state.activeTurn
  if (
    gen !== state.childGen ||
    state.child !== c ||
    state.sessionId === null ||
    params.sessionId !== state.sessionId ||
    boundTurn === null ||
    boundTurn.settled ||
    boundTurn.gen !== gen ||
    boundTurn.sessionId !== params.sessionId
  ) {
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  }

  const toolKind =
    typeof params.toolCall.kind === 'string'
      ? sanitizeExternalCardText(params.toolCall.kind, 40)
      : undefined
  const concretePaths = extractConcretePaths(params.toolCall)
  const permContext = readLivePermissionContext(state.getPermissionContext)
  if (permContext === null) {
    return Promise.resolve(failClosedResponse(options))
  }
  if (isDeniedByMercuryRules(concretePaths, toolKind, state.seatCwd, permContext)) {
    return Promise.resolve(failClosedResponse(options))
  }
  if (options.length === 0) {
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  }
  if (!state.seatCtx || !state.seatCtx.hasAskConsumer()) {
    return Promise.resolve(failClosedResponse(options))
  }

  const rawTitle =
    typeof params.toolCall.title === 'string' && params.toolCall.title.trim() !== ''
      ? params.toolCall.title
      : typeof params.toolCall.name === 'string' && params.toolCall.name.trim() !== ''
        ? params.toolCall.name
        : 'External agent action'
  const title = sanitizeExternalCardText(rawTitle, 160) || 'External agent action'
  const toolCallId =
    typeof params.toolCall.toolCallId === 'string' && params.toolCall.toolCallId.trim() !== ''
      ? params.toolCall.toolCallId
      : `acp-call-${String(reqId ?? state.askSeq)}`
  const targets = concretePaths.slice(0, 6).map(p => sanitizeExternalCardText(p, 160))
  const detail = sanitizeRawInputDetail(params.toolCall.rawInput)
  const askId = `acp-ask:${state.seatCtx.seatId}:${gen}:${String(reqId ?? 'x')}:${++state.askSeq}`

  return new Promise<RequestPermissionResponse>(resolve => {
    let settled = false
    let withdraw = (): void => {}
    const finish = (response: RequestPermissionResponse): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      state.activeAsks.delete(askId)
      withdraw()
      resolve(response)
    }
    const onAbort = (): void => finish({ outcome: { outcome: 'cancelled' } })
    signal.addEventListener('abort', onAbort, { once: true })

    const ask: ExternalSeatPermissionAsk = {
      kind: 'external-acp',
      askId,
      seatId: state.seatCtx!.seatId,
      agentId: state.seatCtx!.agentId,
      adapterKind: state.adapterKind,
      displayName: state.displayName,
      sessionId: params.sessionId,
      toolCallId,
      title,
      ...(toolKind !== undefined ? { toolKind } : {}),
      targets,
      ...(detail !== undefined ? { detail } : {}),
      cwd: state.seatCwd,
      options,
      askedAt: Date.now(),
      onSelect: optionId => {
        const chosen = options.find(opt => opt.optionId === optionId)
        if (
          !chosen ||
          gen !== state.childGen ||
          state.child !== c ||
          state.activeTurn !== boundTurn ||
          boundTurn.settled ||
          state.sessionId !== params.sessionId
        ) {
          finish({ outcome: { outcome: 'cancelled' } })
          return
        }
        if (chosen.kind === 'allow_once' || chosen.kind === 'allow_always') {
          const liveCtx = readLivePermissionContext(state.getPermissionContext)
          if (liveCtx === null || isDeniedByMercuryRules(concretePaths, toolKind, state.seatCwd, liveCtx)) {
            finish(failClosedResponse(options))
            return
          }
        }
        finish({ outcome: { outcome: 'selected', optionId } })
      },
      onCancel: () => finish({ outcome: { outcome: 'cancelled' } }),
    }

    withdraw = state.seatCtx!.postAsk(ask)
    state.activeAsks.set(askId, {
      askId,
      gen,
      cancel: () => finish({ outcome: { outcome: 'cancelled' } }),
    })
  })
}

function ensureChild(state: AcpClientState): { c: NdjsonChildLike; conn: ClientConnection; gen: number } {
  if (state.child && state.conn) return { c: state.child, conn: state.conn, gen: state.childGen }
  const [cmd, ...args] = state.command
  const gen = ++state.childGen
  const env = state.adapterKind === 'devin' ? devinCliChildEnv() : subprocessEnv()
  const c = state.spawnImpl(cmd, args, { cwd: state.seatCwd, env })
  const app = acpClientApp({ name: 'mercury' })
    .onRequest('session/request_permission', ctx =>
      handlePermissionRequest(state, c, gen, ctx.requestId, ctx.params, ctx.signal),
    )
    .onNotification('session/update', ctx => {
      if (gen !== state.childGen || state.child !== c) return
      if (state.sessionId !== null && ctx.params.sessionId !== state.sessionId) return
      const update = ctx.params.update
      if (
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        state.activeTurn !== null &&
        !state.activeTurn.settled &&
        state.activeTurn.gen === gen &&
        state.activeTurn.sessionId === ctx.params.sessionId
      ) {
        appendTurnReplyChunk(state.activeTurn, update.content.text)
      }
      const evt: SeatEvent = {
        sourceEventId: `session/update-${++state.eventSeq}`,
        kind: 'session/update',
        payload: ctx.params,
        atMs: Date.now(),
      }
      for (const l of [...state.eventListeners]) l(evt)
    })
  const conn = app.connect(streamOfNdjsonChild(c))
  state.child = c
  state.conn = conn
  state.sessionId = null
  c.onExit((code, reason) => {
    if (gen !== state.childGen) return
    state.child = null
    state.conn = null
    state.sessionId = null
    const why = reason ?? `child exited (code ${String(code)})`
    clearPendingAsks(state, false)
    if (state.activeTurn && state.activeTurn.gen === gen) {
      settleTurn(state, state.activeTurn, 'exited', { reason: why })
    }
    try {
      conn.close(new Error(why))
    } catch (error) {
      passedOver(error)
    }
    for (const l of [...state.lifecycleListeners]) l('exited')
  })
  return { c, conn, gen }
}

async function ensureSession(
  state: AcpClientState,
  c: NdjsonChildLike,
  conn: ClientConnection,
  gen: number,
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
  if (state.sessionId !== null && gen === state.childGen) {
    return { ok: true, sessionId: state.sessionId }
  }
  try {
    const res = await withDeadline(
      conn.agent.request('session/new', { cwd: state.seatCwd, mcpServers: [] }),
      SESSION_NEW_TIMEOUT_MS,
      () => {
        throw new Error(`no response to session/new within ${SESSION_NEW_TIMEOUT_MS}ms`)
      },
      { unref: true },
    )
    const sid = isRecord(res) && typeof res.sessionId === 'string' ? res.sessionId.trim() : ''
    if (sid === '') return { ok: false, reason: `${state.displayName} returned no sessionId from session/new` }
    if (gen !== state.childGen || state.child !== c) {
      return { ok: false, reason: `${state.displayName} process closed during session/new` }
    }
    state.sessionId = sid
    for (const l of [...state.sessionIdentityListeners]) {
      try {
        l(sid)
      } catch (error) {
        passedOver(error)
      }
    }
    return { ok: true, sessionId: sid }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

interface AcpSeatOptions {
  command: [cmd: string, ...args: string[]]
  cwd?: string
  spawnImpl?: SpawnImpl
  getPermissionContext?: () => ToolPermissionContext
}

export function acpSeatTransport(
  adapterKind: AcpAdapterKind,
  displayName: string,
  opts: AcpSeatOptions,
): ExternalSeatTransport {
  const state: AcpClientState = {
    adapterKind,
    displayName,
    seatCwd: resolvePath(opts.cwd ?? getCwd()),
    command: opts.command,
    spawnImpl: opts.spawnImpl ?? realNdjsonChild,
    ...(opts.getPermissionContext !== undefined ? { getPermissionContext: opts.getPermissionContext } : {}),
    child: null,
    conn: null,
    childGen: 0,
    sessionId: null,
    activeTurn: null,
    seatCtx: null,
    eventSeq: 0,
    askSeq: 0,
    activeAsks: new Map(),
    eventListeners: new Set(),
    lifecycleListeners: new Set(),
    sessionIdentityListeners: new Set(),
    turnSettledListeners: new Set(),
  }

  return {
    adapterKind,
    displayName,
    mercuryOwnsProcess: true,
    bindSeat(ctx) {
      state.seatCtx = ctx
    },
    async handshake(): Promise<SeatHandshakeResult> {
      const { c, conn, gen } = ensureChild(state)
      let res: InitializeResponse
      try {
        res = await withDeadline(
          conn.agent.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: 'mercury', version: '1.0' },
          }),
          HANDSHAKE_TIMEOUT_MS,
          () => {
            throw new Error(`no response to initialize within ${HANDSHAKE_TIMEOUT_MS}ms`)
          },
          { unref: true },
        )
      } catch (e) {
        await stopChild(state, c, conn, gen)
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`${displayName} ACP handshake failed: ${msg}`)
      }
      const checked = validateInitialize(displayName, res)
      if (!checked.ok) {
        await stopChild(state, c, conn, gen)
        throw new Error(checked.reason)
      }
      return {
        protocol: 'acp@1',
        revision: checked.revision,
        declared: acpDeclaredCapabilities(checked.init),
        raw: {
          agentInfo: checked.init.agentInfo,
          agentCapabilities: checked.init.agentCapabilities,
        },
      }
    },
    async deliver(req: SeatDeliveryRequest): Promise<SeatDeliveryOutcome> {
      if (req.disposition !== 'start-turn') {
        return {
          result: 'rejected',
          reason: `${displayName} ACP transport supports start-turn only (not ${req.disposition})`,
        }
      }
      const c = state.child
      const conn = state.conn
      const gen = state.childGen
      if (!c || !conn) {
        return { result: 'rejected', reason: `${displayName} process is not connected` }
      }
      if (state.activeTurn !== null && !state.activeTurn.settled) {
        return {
          result: 'rejected',
          reason: `${displayName} already has a turn in progress — cancel or wait for it to settle`,
        }
      }
      const turn: ActiveTurn = {
        gen,
        sessionId: state.sessionId,
        clientMessageId: req.clientMessageId,
        settled: false,
        replyChunks: [],
        replyStoredChars: 0,
        replyTotalChars: 0,
      }
      state.activeTurn = turn
      const session = await ensureSession(state, c, conn, gen)
      if (!session.ok) {
        if (state.activeTurn === turn) state.activeTurn = null
        turn.settled = true
        return { result: 'rejected', reason: session.reason }
      }
      if (gen !== state.childGen || state.child !== c || state.activeTurn !== turn || turn.settled) {
        if (state.activeTurn === turn) state.activeTurn = null
        turn.settled = true
        return { result: 'rejected', reason: `${displayName} disconnected before prompt dispatch` }
      }
      turn.sessionId = session.sessionId
      const { prompt, attachments } = buildPromptBlocks(req, state.seatCwd)
      const promptWork = conn.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt,
      })
      void promptWork.then(
        result => {
          const stopReason = isRecord(result) ? result.stopReason : undefined
          if (!isValidStopReason(stopReason)) {
            settleTurn(state, turn, 'failed', {
              reason: `${displayName} returned missing or invalid stopReason from session/prompt`,
            })
            return
          }
          settleTurn(state, turn, stopReason === 'cancelled' ? 'cancelled' : 'completed', {
            stopReason,
          })
        },
        error => {
          const msg = error instanceof Error ? error.message : String(error)
          settleTurn(state, turn, 'failed', { reason: msg })
        },
      )
      return {
        result: 'accepted',
        disposition: 'started-turn',
        attachments,
        adapterOutcome: 'acp:prompt-dispatched',
      }
    },
    async cancelTurn(): Promise<SeatDeliveryOutcome> {
      const c = state.child
      const conn = state.conn
      const gen = state.childGen
      const turn = state.activeTurn
      if (!c || !conn || !turn || turn.gen !== gen || turn.settled || turn.sessionId === null) {
        return { result: 'rejected', reason: `no active ${displayName} turn in flight` }
      }
      clearPendingAsks(state, true)
      try {
        await conn.agent.notify('session/cancel', { sessionId: turn.sessionId })
        return {
          result: 'accepted',
          disposition: 'steered-current',
          attachments: [],
          adapterOutcome: 'acp:session/cancel',
        }
      } catch (e) {
        return {
          result: 'unknown',
          reason: `${displayName} cancel notification failed (${e instanceof Error ? e.message : String(e)})`,
        }
      }
    },
    onEvent(listener) {
      state.eventListeners.add(listener)
      return () => state.eventListeners.delete(listener)
    },
    onLifecycle(listener) {
      state.lifecycleListeners.add(listener)
      return () => state.lifecycleListeners.delete(listener)
    },
    onSessionIdentity(listener) {
      state.sessionIdentityListeners.add(listener)
      return () => state.sessionIdentityListeners.delete(listener)
    },
    onTurnSettled(listener) {
      state.turnSettledListeners.add(listener)
      return () => state.turnSettledListeners.delete(listener)
    },
    async detach(): Promise<void> {
      const c = state.child
      const conn = state.conn
      const gen = state.childGen
      const turn = state.activeTurn
      if (c && conn && turn && turn.gen === gen && !turn.settled && turn.sessionId !== null) {
        clearPendingAsks(state, true)
        await conn.agent.notify('session/cancel', { sessionId: turn.sessionId }).catch(passedOver)
      }
      if (turn && turn.gen === gen) {
        settleTurn(state, turn, 'cancelled', { reason: 'seat detached' })
      }
      await stopChild(state, c, conn, gen)
    },
  }
}
