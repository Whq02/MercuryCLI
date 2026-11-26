#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { checker, waitUntil as waitUntilOpts } from '../engine-durability/harness.ts'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, type Mounted } from '../lib/settingsPopupHarness.ts'

;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

const home = pinScratchHome('acp-seat-client')
const scratch = realpathSync(home)
const mainCwd = join(scratch, 'main-cwd')
const seatCwd = join(scratch, 'seat-workspace')
const binDir = join(scratch, 'bin')
const logsDir = join(scratch, 'logs')
for (const dir of [mainCwd, seatCwd, binDir, logsDir, join(seatCwd, 'secrets'), join(seatCwd, 'private'), join(seatCwd, 'src')]) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(seatCwd, 'secrets', 'token.txt'), 'secret-fixture\n')
writeFileSync(join(seatCwd, 'private', 'key.pem'), 'private-fixture\n')
writeFileSync(join(seatCwd, 'src', 'ok.ts'), 'export const ok = 1\n')

process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_MODEL']) {
  delete process.env[key]
}
const origCwd = process.cwd()
const origPath = process.env.PATH ?? ''
process.chdir(mainCwd)

const stubPath = join(scratch, 'acp-stub-peer.mjs')
writeFileSync(
  stubPath,
  `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.env.STUB_LOG
const scenario = process.env.STUB_SCENARIO || 'full-turn'
const agentName = process.env.STUB_AGENT_NAME || 'stub-acp'
const versionMode = process.env.STUB_VERSION || '1'
const askIdOverride = process.env.STUB_ASK_ID ? Number(process.env.STUB_ASK_ID) : null
const slowSessionNewMs = process.env.STUB_SLOW_NEW_MS ? Number(process.env.STUB_SLOW_NEW_MS) : 0

function record(entry) {
  if (!logFile) return
  appendFileSync(logFile, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + '\\n')
}
function send(msg) {
  record({ dir: 'out', msg })
  process.stdout.write(JSON.stringify(msg) + '\\n')
}

record({
  dir: 'meta',
  event: 'started',
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  hasWindsurfKey: process.env.WINDSURF_API_KEY !== undefined,
  hasMercuryOauth: process.env.MERCURY_OAUTH_TOKEN !== undefined,
  hasAnthropicKey: process.env.ANTHROPIC_API_KEY !== undefined,
})

let sessionSeq = 0
let currentSessionId = null
let activePromptId = null
let nextInboundId = 100
let pendingAsk = null
let unsupportedReplied = 0

const stdOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Deny once', kind: 'reject_once' },
]

function makeAskId() {
  return askIdOverride !== null && Number.isFinite(askIdOverride) ? askIdOverride : ++nextInboundId
}
function finishPrompt(result) {
  if (activePromptId === null) return
  const id = activePromptId
  activePromptId = null
  send({ jsonrpc: '2.0', id, result })
}
function sendPermission(opts) {
  const id = makeAskId()
  pendingAsk = { id, onReply: opts.onReply }
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: opts.sessionId ?? currentSessionId,
      toolCall: opts.toolCall,
      options: opts.options ?? stdOptions,
    },
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  record({ dir: 'in', msg })

  if (typeof msg.method === 'string' && msg.id !== undefined) {
    if (msg.method === 'initialize') {
      const protocolVersion =
        versionMode === '1' ? 1 : versionMode === '2' ? 2 : versionMode === 'str1' ? '1' : versionMode === 'null' ? null : undefined
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          ...(protocolVersion !== undefined ? { protocolVersion } : {}),
          agentInfo: { name: agentName, version: '0.1.0-stub' },
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: false } },
        },
      })
      return
    }
    if (msg.method === 'session/new') {
      const reply = () => {
        currentSessionId = agentName + '-sess-' + (++sessionSeq)
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: currentSessionId } })
      }
      if (slowSessionNewMs > 0) setTimeout(reply, slowSessionNewMs)
      else reply()
      return
    }
    if (msg.method === 'session/prompt') {
      activePromptId = msg.id
      const text = msg.params?.prompt?.[0]?.text ?? ''

      if (scenario === 'full-turn') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'inspect workspace', status: 'in_progress', kind: 'read' } } })
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'checking action' } } } })
        sendPermission({
          toolCall: { toolCallId: 'tc-ask-1', title: '\\u001b[31mRun opaque remote step\\u001b[0m', kind: 'execute', status: 'pending', rawInput: { note: text } },
          onReply: () => {
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' } } })
            finishPrompt({ stopReason: 'end_turn' })
          },
        })
        return
      }
      if (scenario === 'quick-end') {
        if (text === 'overflow-turn') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OVERFLOW:' + 'x'.repeat(4200) } } } })
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ':OVERFLOW-TAIL' } } } })
        } else {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\u001b[32mreply:' + text + ':' + 'z'.repeat(70) + '\\u001b[0m' } } } })
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ':TAIL-' + text.split(' ').at(-1) } } } })
        }
        finishPrompt({ stopReason: 'end_turn' })
        return
      }
      if (scenario === 'missing-stop-reason') {
        finishPrompt({})
        return
      }
      if (scenario === 'deny-relative-path') {
        sendPermission({
          toolCall: { toolCallId: 'tc-deny-rel', title: 'edit relative secret', kind: 'edit', status: 'pending', locations: [{ path: 'secrets/token.txt' }] },
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
      if (scenario === 'deny-multi-location') {
        sendPermission({
          toolCall: { toolCallId: 'tc-deny-multi', title: 'read two files', kind: 'read', status: 'pending', locations: [{ path: 'src/ok.ts' }, { path: 'private/key.pem' }] },
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
      if (scenario === 'allow-unrelated-path' || scenario === 'live-deny-recheck') {
        sendPermission({
          toolCall: { toolCallId: 'tc-ok-path', title: 'edit safe file', kind: 'edit', status: 'pending', locations: [{ path: 'src/ok.ts' }] },
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
      if (scenario === 'opaque-ask') {
        sendPermission({
          toolCall: { toolCallId: 'tc-opaque', title: 'Opaque vendor action (' + text + ')', kind: 'execute', status: 'pending', rawInput: { cmd: 'remote-op' } },
          options: [
            { optionId: 'allow-once', name: 'Approve step', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject step', kind: 'reject_once' },
          ],
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
      if (scenario === 'foreign-option') {
        sendPermission({
          toolCall: { toolCallId: 'tc-foreign', title: 'Foreign option ask', kind: 'execute', status: 'pending' },
          options: [{ optionId: 'bogus', name: 'Bogus foreign', kind: 'not_a_valid_kind' }],
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
      if (scenario === 'mismatched-session-ask') {
        sendPermission({
          sessionId: 'foreign-session-999',
          toolCall: { toolCallId: 'tc-wrong-sess', title: 'Spoofed session ask', kind: 'execute', status: 'pending' },
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
      if (scenario === 'unsupported-methods') {
        unsupportedReplied = 0
        send({ jsonrpc: '2.0', id: 501, method: 'fs/read_text_file', params: { sessionId: currentSessionId, path: 'src/ok.ts' } })
        send({ jsonrpc: '2.0', id: 502, method: 'fs/write_text_file', params: { sessionId: currentSessionId, path: 'src/ok.ts', content: 'bad' } })
        send({ jsonrpc: '2.0', id: 503, method: 'terminal/create', params: { sessionId: currentSessionId, command: 'touch pwned' } })
        return
      }
      if (scenario === 'hold-until-cancel') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: currentSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'permission granted in prose only' } } } })
        sendPermission({
          toolCall: { toolCallId: 'tc-cancel-hold', title: 'Wait for cancel while card open', kind: 'execute', status: 'pending' },
          onReply: () => {},
        })
        return
      }
      if (scenario === 'exit-mid-turn') {
        sendPermission({
          toolCall: { toolCallId: 'tc-exit-mid', title: 'Will crash while card open', kind: 'execute', status: 'pending' },
          onReply: () => {},
        })
        setTimeout(() => process.exit(42), 250)
        return
      }
      if (scenario === 'concurrent-ask') {
        sendPermission({
          toolCall: { toolCallId: 'tc-conc-' + agentName, title: 'Concurrent ask from ' + agentName, kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'allow-' + agentName, name: 'Allow ' + agentName, kind: 'allow_once' },
            { optionId: 'reject-' + agentName, name: 'Reject ' + agentName, kind: 'reject_once' },
          ],
          onReply: () => finishPrompt({ stopReason: 'end_turn' }),
        })
        return
      }
    }
    return
  }

  if (typeof msg.method === 'string' && msg.id === undefined) {
    if (msg.method === 'session/cancel') finishPrompt({ stopReason: 'cancelled' })
    return
  }

  if (msg.id !== undefined) {
    if (scenario === 'unsupported-methods' && (msg.id === 501 || msg.id === 502 || msg.id === 503)) {
      unsupportedReplied++
      if (unsupportedReplied === 3) finishPrompt({ stopReason: 'end_turn' })
      return
    }
    if (pendingAsk && msg.id === pendingAsk.id) {
      const cb = pendingAsk.onReply
      pendingAsk = null
      cb(msg)
    }
  }
})
`,
)

for (const name of ['devin', 'opencode', 'goose']) {
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${stubPath}" %*\r\n`)
  } else {
    const shim = join(binDir, name)
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`)
    chmodSync(shim, 0o755)
  }
}
const execDir = dirname(process.execPath)
process.env.PATH = [binDir, execDir, ...(process.platform === 'win32' ? origPath.split(delimiter).filter(Boolean) : ['/usr/bin', '/bin'])].join(delimiter)

interface StubEntry {
  dir: 'in' | 'out' | 'meta'
  pid: number
  at: number
  hasWindsurfKey?: boolean
  hasMercuryOauth?: boolean
  hasAnthropicKey?: boolean
  msg?: {
    id?: string | number
    method?: string
    params?: Record<string, unknown>
    result?: Record<string, unknown>
    error?: { code?: number; message?: string }
  }
}

function readStubLog(path: string): StubEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as StubEntry)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  return waitUntilOpts(pred, { tries: Math.max(1, Math.ceil(timeoutMs / 25)), everyMs: 25 })
}

const t = checker()
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const React = await import('react')
const h = React.createElement
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { useAppStateStore } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { useChatAsks, useChatAsksCard } = await import('../../src/screen/chat/useChatAsks.tsx')
const crewMod = await import('../../src/commands/crew/index.ts')
const bridge = await import('../../src/crew/crewmates/seatBridge.ts')
const caps = await import('../../src/crew/crewmates/capabilities.ts')
const dispatch = await import('../../src/crew/crewmates/dispatch.ts')
const activity = await import('../../src/crew/crewmates/activity.ts')
const { acpSeatTransport } = await import('../../src/crew/crewmates/adapters/acpProfile.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { applyPermissionRulesToPermissionContext } = await import('../../src/permissions/rules/permissionDoor.ts')
const { permissionRuleValueFromString } = await import('../../src/permissions/rules/permissionRuleParser.ts')

type TurnSettlement = import('../../src/crew/crewmates/seatBridge.ts').SeatTurnSettlement

function makePermissionContext(
  mode: 'default' | 'implement' | 'flow' | 'sovereign',
  denyRules: string[],
  allowRules: string[] = [],
) {
  return applyPermissionRulesToPermissionContext({ ...getEmptyToolPermissionContext(), mode }, [
    ...denyRules.map(raw => ({ source: 'session' as const, ruleBehavior: 'deny' as const, ruleValue: permissionRuleValueFromString(raw) })),
    ...allowRules.map(raw => ({ source: 'session' as const, ruleBehavior: 'allow' as const, ruleValue: permissionRuleValueFromString(raw) })),
  ])
}

async function mountCardHost(initialCtx: ReturnType<typeof makePermissionContext>): Promise<{
  view: Mounted
  getPermissionContext: () => ReturnType<typeof makePermissionContext>
  setPermissionContext: (ctx: ReturnType<typeof makePermissionContext>) => void
  screen: () => string
  unmount: () => void
}> {
  let appStore: ReturnType<typeof useAppStateStore> | null = null
  function CardHost(): React.ReactNode {
    const store = useAppStateStore()
    appStore = store
    const asks = useChatAsks({ setAppState: updater => store.setState(updater), addNotification: () => {} })
    const focused = asks.toolUseConfirmQueue.length + asks.externalSeatAsks.length > 0 ? 'tool-permission' : undefined
    const card = useChatAsksCard({
      focusedInputDialog: focused,
      repinToBottom: () => {},
      toolUseConfirmQueue: asks.toolUseConfirmQueue,
      externalSeatAsks: asks.externalSeatAsks,
      resolvedConsentCount: asks.resolvedConsentCount,
      resolveHeadPermission: asks.resolveHeadPermission,
      chatSurfaceCovered: false,
      verbose: false,
    })
    return h(React.Fragment, null, card.permissionOverlay)
  }
  const view = await mountOffscreen(
    h(App, { initialState: { ...getDefaultAppState(), toolPermissionContext: initialCtx }, getFpsMetrics: () => undefined, children: h(KeybindingSetup, null, h(CardHost)) }),
    110,
    28,
  )
  await settle(150)
  return {
    view,
    getPermissionContext: () => appStore?.getState().toolPermissionContext ?? initialCtx,
    setPermissionContext: ctx => appStore?.setState(prev => ({ ...prev, toolPermissionContext: ctx })),
    screen: () => view.lines().join('\n'),
    unmount: () => view.unmount(),
  }
}

const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')
type LocalJSXCommandContext = import('../../src/commands/catalogue/command.ts').LocalJSXCommandContext

function makeLocalCommandContext(getCtx: () => ReturnType<typeof makePermissionContext>): LocalJSXCommandContext {
  return {
    options: {
      commands: [],
      debug: false,
      verbose: false,
      engineModel: 'claude-sonnet-4-6',
      tools: getAllBaseTools(),
      mcpClients: [],
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      theme: 'dark',
    },
    startTurn: () => {
      throw new Error('no turn loop in crew command context')
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    getAppState: () => ({ ...getDefaultAppState(), toolPermissionContext: getCtx() }),
    setAppState: () => {},
    messages: [],
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    setMessages: () => {},
    onChangeAPIKey: () => {},
  }
}

const localCallContext = makeLocalCommandContext(() => makePermissionContext('default', []))
let logSeq = 0
const nextLog = (label: string): string => join(logsDir, `${++logSeq}-${label}.jsonl`)
function setStubEnv(opts: { log: string; scenario: string; agentName: string; version?: string; askId?: number; slowNewMs?: number }): void {
  process.env.STUB_LOG = opts.log
  process.env.STUB_SCENARIO = opts.scenario
  process.env.STUB_AGENT_NAME = opts.agentName
  process.env.STUB_VERSION = opts.version ?? '1'
  if (opts.askId !== undefined) process.env.STUB_ASK_ID = String(opts.askId)
  else delete process.env.STUB_ASK_ID
  if (opts.slowNewMs !== undefined) process.env.STUB_SLOW_NEW_MS = String(opts.slowNewMs)
  else delete process.env.STUB_SLOW_NEW_MS
}

const permOutcomeOf = (entries: StubEntry[]) =>
  entries.find(e => e.dir === 'in' && e.msg?.method === undefined && e.msg?.result && 'outcome' in e.msg.result)?.msg?.result

let missingProfiles = 0
let missingDeliveries = 0
let invalidVersionsAccepted = 0

try {
  t.section('§1 — real /crew operator path: attach devin/opencode/goose, env isolation, send, activity, seats, detach')
  {
    bridge._resetSeatBridgeForTesting()
    caps._resetCapabilitiesForTesting()
    activity._resetActivityFeedForTesting()
    const { call } = await crewMod.default.load()
    process.env.WINDSURF_API_KEY = 'synthetic-ambient-marker'
    process.env.MERCURY_OAUTH_TOKEN = 'synthetic-mercury-oauth-marker'
    try {
      for (const [kind, label] of [['devin', 'Devin'], ['opencode', 'OpenCode'], ['goose', 'goose']] as const) {
        const log = nextLog(`crew-${kind}`)
        setStubEnv({ log, scenario: 'quick-end', agentName: kind })
        const attachRes = await call(`attach ${kind}`, localCallContext)
        const attachText = attachRes.type === 'text' ? attachRes.value : ''
        const okAttach = attachText.includes(`attached ${label}`) && attachText.includes('acp@1')
        if (!okAttach) missingProfiles++
        t.check(`/crew attach ${kind} succeeds and states own tools/permissions once`, okAttach && /own tools/i.test(attachText) && /permission/i.test(attachText), attachText)

        const seat = bridge.listAttachedSeats().find(s => s.adapterKind === kind)
        t.check(
          `${kind}: declares start-turn/cancel-turn supported, steer-current unsupported, hold-next unknown`,
          seat !== undefined &&
            caps.capabilityStateOf(seat.seatId, 'start-turn').state === 'supported' &&
            caps.capabilityStateOf(seat.seatId, 'cancel-turn').state === 'supported' &&
            caps.capabilityStateOf(seat.seatId, 'steer-current').state === 'unsupported' &&
            caps.capabilityStateOf(seat.seatId, 'hold-next').state === 'unknown',
        )
        if (seat) {
          const settled: TurnSettlement[] = []
          const unsub = bridge.onSeatTurnSettled(seat.seatId, s => settled.push(s))
          const sendRes = await call(`send ${seat.seatId} hello   verbatim ${kind}`, localCallContext)
          const sendText = sendRes.type === 'text' ? sendRes.value : ''
          if (!sendText.includes('dispatched')) missingDeliveries++
          await waitUntil(() => settled.length === 1, 4000)
          const seatsRes1 = await call('seats', localCallContext)
          const seatsText1 = seatsRes1.type === 'text' ? seatsRes1.value : ''
          await call(`send ${seat.seatId} second turn-${kind}`, localCallContext)
          await waitUntil(() => settled.length === 2, 4000)
          const seatsRes2 = await call('seats', localCallContext)
          const seatsText2 = seatsRes2.type === 'text' ? seatsRes2.value : ''
          t.check(
            `/crew send -> /crew seats delivers sanitized >60-char chunked reply and distinct second turn for ${kind}`,
            sendText.includes('dispatched') &&
              settled[0]?.stopReason === 'end_turn' &&
              seatsText1.includes(`reply:hello   verbatim ${kind}`) &&
              seatsText1.includes(`:TAIL-${kind}`) &&
              !seatsText1.includes('\u001b[32m') &&
              seatsText2.includes(`:TAIL-turn-${kind}`) &&
              !seatsText2.includes(`hello   verbatim ${kind}`) &&
              seatsText2.includes(`last turn [${settled[1]?.clientMessageId}]: completed (end_turn)`),
            JSON.stringify({ sendText, settled: settled.map(s => ({ id: s.clientMessageId, status: s.status, chars: s.replyChars })), seatsText2: seatsText2.slice(0, 300) }),
          )
          if (kind === 'devin') {
            await call(`send ${seat.seatId} overflow-turn`, localCallContext)
            await waitUntil(() => settled.length === 3, 4000)
            const overRes = await call('seats', localCallContext)
            const overText = overRes.type === 'text' ? overRes.value : ''
            const overPath = settled[2]?.replyOverflowPath
            const savedFull = overPath && existsSync(overPath) ? readFileSync(overPath, 'utf8') : ''
            t.check(
              'devin: >4000-char reply truncates inline with exact saved overflow pointer containing full tail',
              settled[2]?.replyTruncated === true &&
                overPath !== undefined &&
                overText.includes('reply truncated') &&
                overText.includes(overPath) &&
                savedFull.endsWith(':OVERFLOW-TAIL'),
              JSON.stringify({ truncated: settled[2]?.replyTruncated, overPath, tailOk: savedFull.endsWith(':OVERFLOW-TAIL') }),
            )
          }
          const entries = readStubLog(log)
          const meta = entries.find(e => e.dir === 'meta')
          const initCaps = entries.find(e => e.dir === 'in' && e.msg?.method === 'initialize')?.msg?.params?.clientCapabilities as
            | { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean }
            | undefined
          t.check(
            `${kind}: initialize advertises fs=false/terminal=false and scrubs Mercury OAuth${kind === 'devin' ? ' + WINDSURF_API_KEY + provider keys' : ''}`,
            initCaps?.fs?.readTextFile === false &&
              initCaps?.fs?.writeTextFile === false &&
              initCaps?.terminal === false &&
              meta?.hasMercuryOauth === false &&
              (kind !== 'devin' || (meta?.hasWindsurfKey === false && meta?.hasAnthropicKey === false)),
            JSON.stringify({ initCaps, meta }),
          )
          unsub()
          const pid = meta?.pid
          await call(`detach ${seat.seatId}`, localCallContext)
          t.check(`${kind}: detach stops child with 0 orphan PID`, pid ? await waitUntil(() => !pidAlive(pid), 4000) : true)
        }
      }
    } finally {
      delete process.env.WINDSURF_API_KEY
      delete process.env.MERCURY_OAUTH_TOKEN
    }
  }

  t.section('§2 — strict numeric ACP v1 handshake enforcement before session/new')
  {
    bridge._resetSeatBridgeForTesting()
    caps._resetCapabilitiesForTesting()
    const dir = join(scratch, 'store-v1')
    for (const [label, versionMode] of [['absent', 'absent'], ['string "1"', 'str1'], ['numeric 2', '2'], ['null', 'null']] as const) {
      const log = nextLog(`v1-${versionMode}`)
      setStubEnv({ log, scenario: 'quick-end', agentName: 'opencode', version: versionMode })
      let refused = false
      let seatId: string | null = null
      try {
        seatId = (await bridge.attachExternalSeat(acpSeatTransport('opencode', 'OpenCode', { command: ['opencode', 'acp'], cwd: seatCwd }), { dir })).seatId
        invalidVersionsAccepted++
      } catch {
        refused = true
      }
      if (seatId) await bridge.detachExternalSeat(seatId)
      const entries = readStubLog(log)
      const pid = entries[0]?.pid
      const dead = pid ? await waitUntil(() => !pidAlive(pid), 4000) : true
      const newCount = entries.filter(e => e.dir === 'in' && e.msg?.method === 'session/new').length
      t.check(`refuses ${label} protocolVersion and stops child before session/new`, refused && dead && newCount === 0, `refused=${refused} dead=${dead} new=${newCount}`)
    }
  }

  t.section('§3 — turn reservation race during session/new, missing stopReason refusal, full card turn')
  {
    bridge._resetSeatBridgeForTesting()
    caps._resetCapabilitiesForTesting()
    activity._resetActivityFeedForTesting()
    const dir = join(scratch, 'store-turn')
    const host = await mountCardHost(makePermissionContext('sovereign', []))
    try {
      const raceLog = nextLog('race-session-new')
      setStubEnv({ log: raceLog, scenario: 'quick-end', agentName: 'devin', slowNewMs: 120 })
      const raceSeat = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd }), { dir })
      const raceSettled: TurnSettlement[] = []
      const unsubRace = bridge.onSeatTurnSettled(raceSeat.seatId, s => raceSettled.push(s))
      const [r1, r2] = await Promise.all([
        dispatch.dispatchToAgent({ clientMessageId: 'race-1', requestedAddress: { agentId: raceSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'first', attachments: [] }, { dir }),
        dispatch.dispatchToAgent({ clientMessageId: 'race-2', requestedAddress: { agentId: raceSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'second', attachments: [] }, { dir }),
      ])
      await waitUntil(() => raceSettled.length === 1, 4000)
      const raceEntries = readStubLog(raceLog)
      const raceNews = raceEntries.filter(e => e.dir === 'in' && e.msg?.method === 'session/new')
      const racePrompts = raceEntries.filter(e => e.dir === 'in' && e.msg?.method === 'session/prompt')
      const deliveredCount = [r1, r2].filter(r => r.state === 'delivered').length
      const rejectedCount = [r1, r2].filter(r => r.state === 'not-delivered').length
      const winnerId = r1.state === 'delivered' ? 'race-1' : 'race-2'
      t.check(
        'two concurrent deliveries while session/new is in flight send 1 session/new + 1 prompt and settle the sole winner cleanly',
        deliveredCount === 1 &&
          rejectedCount === 1 &&
          raceNews.length === 1 &&
          racePrompts.length === 1 &&
          raceSettled.length === 1 &&
          raceSettled[0]?.clientMessageId === winnerId,
        JSON.stringify({ r1: r1.state, r2: r2.state, news: raceNews.length, prompts: racePrompts.length, raceSettled }),
      )
      unsubRace()
      await bridge.detachExternalSeat(raceSeat.seatId)

      const noStopLog = nextLog('missing-stop-reason')
      setStubEnv({ log: noStopLog, scenario: 'missing-stop-reason', agentName: 'devin' })
      const noStopSeat = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd }), { dir })
      const noStopSettled: TurnSettlement[] = []
      const unsubNoStop = bridge.onSeatTurnSettled(noStopSeat.seatId, s => noStopSettled.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: 'nostop-1', requestedAddress: { agentId: noStopSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'empty result', attachments: [] }, { dir })
      await waitUntil(() => noStopSettled.length === 1, 4000)
      t.check(
        'session/prompt returning {} (missing stopReason) settles as failed, never fabricated end_turn',
        noStopSettled[0]?.status === 'failed' && noStopSettled[0]?.stopReason === undefined,
        JSON.stringify(noStopSettled),
      )
      unsubNoStop()
      await bridge.detachExternalSeat(noStopSeat.seatId)

      activity._resetActivityFeedForTesting()
      const log = nextLog('devin-full-turn')
      setStubEnv({ log, scenario: 'full-turn', agentName: 'devin' })
      const seat = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd, getPermissionContext: host.getPermissionContext }), { dir })
      const settlements: TurnSettlement[] = []
      const unsub = bridge.onSeatTurnSettled(seat.seatId, s => settlements.push(s))
      const rec = await dispatch.dispatchToAgent({ clientMessageId: 'msg-full-1', requestedAddress: { agentId: seat.agentId }, requestedDisposition: 'start-turn', instruction: 'audit workspace', attachments: [] }, { dir })
      t.check('accepted dispatch returns started-turn BEFORE terminal completion', rec.state === 'delivered' && rec.disposition === 'started-turn' && settlements.length === 0)
      const shown = await waitUntil(() => host.screen().includes('Run opaque remote step'), 5000)
      t.check('opaque ask opens sanitized Mercury card with trusted semantics badges even in sovereign mode', shown && !host.screen().includes('\u001b[31m') && host.screen().includes('Devin') && host.screen().includes('[allow once] Allow once') && host.screen().includes('[deny once] Deny once'))
      await settle(150)
      host.view.push(KEY.enter)
      await waitUntil(() => settlements.length === 1, 5000)
      const entries = readStubLog(log)
      const methods = entries.filter(e => e.dir === 'in' && e.msg?.method).map(e => e.msg?.method)
      const newCwd = entries.find(e => e.dir === 'in' && e.msg?.method === 'session/new')?.msg?.params?.cwd
      const feedRows = activity.activityRows(activity.cachedActivityFeed())
      t.check(
        'full turn: initialize -> session/new(seatCwd) -> prompt, exact reply once, collapsed tool_call + chunk updates, end_turn settlement',
        JSON.stringify(methods.slice(0, 3)) === JSON.stringify(['initialize', 'session/new', 'session/prompt']) &&
          newCwd === seatCwd &&
          JSON.stringify(permOutcomeOf(entries)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }) &&
          settlements[0]?.status === 'completed' &&
          settlements[0]?.stopReason === 'end_turn' &&
          feedRows.some(r => r.class === 'tool' && r.objectLabel.includes('inspect workspace') && r.phase === 'succeeded') &&
          feedRows.some(r => r.class === 'message' && r.objectLabel.includes('checking action')),
        JSON.stringify({ methods, newCwd, perm: permOutcomeOf(entries), settlements }),
      )
      unsub()
      await bridge.detachExternalSeat(seat.seatId)
    } finally {
      host.unmount()
    }
  }

  t.section('§4 — permissions release gate: deny rules, multi-location, live recheck, foreign/mismatched/missing-card fail closed, unsupported methods')
  {
    bridge._resetSeatBridgeForTesting()
    caps._resetCapabilitiesForTesting()
    const dir = join(scratch, 'store-perm')
    const host = await mountCardHost(makePermissionContext('sovereign', ['Edit(secrets/token.txt)', 'Read(private/**)'], ['Edit(secrets/token.txt)', 'Edit(src/ok.ts)']))
    const runPerm = async (
      scenario: string,
      id: string,
      act?: () => Promise<void>,
      ctxGetter?: () => ReturnType<typeof makePermissionContext>,
    ) => {
      const log = nextLog(`perm-${scenario}`)
      setStubEnv({ log, scenario, agentName: 'devin' })
      const seat = await bridge.attachExternalSeat(
        acpSeatTransport('devin', 'Devin', {
          command: ['devin', 'acp'],
          cwd: seatCwd,
          ...(ctxGetter ? { getPermissionContext: ctxGetter } : {}),
        }),
        { dir },
      )
      const settled: TurnSettlement[] = []
      const unsub = bridge.onSeatTurnSettled(seat.seatId, s => settled.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: id, requestedAddress: { agentId: seat.agentId }, requestedDisposition: 'start-turn', instruction: scenario, attachments: [] }, { dir })
      if (act) await act()
      await waitUntil(() => settled.length === 1, 5000)
      unsub()
      await bridge.detachExternalSeat(seat.seatId)
      return readStubLog(log)
    }
    try {
      t.check('relative named path against seatCwd denied (deny beats allow + sovereign)', JSON.stringify(permOutcomeOf(await runPerm('deny-relative-path', 'p-rel', undefined, host.getPermissionContext))) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }))
      t.check('multi-location with one denied path denies entire request', JSON.stringify(permOutcomeOf(await runPerm('deny-multi-location', 'p-multi', undefined, host.getPermissionContext))) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }))

      const okEntries = await runPerm('allow-unrelated-path', 'p-ok', async () => {
        await waitUntil(() => host.screen().includes('edit safe file'), 5000)
        await settle(150)
        host.view.push(KEY.enter)
      }, host.getPermissionContext)
      t.check('unrelated path approved via real operator card', JSON.stringify(permOutcomeOf(okEntries)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }))

      const sessionADenies = makePermissionContext('sovereign', ['Edit(src/ok.ts)'])
      const sessionBAllows = makePermissionContext('sovereign', [])
      const isoDenied = await runPerm('allow-unrelated-path', 'p-iso-a', undefined, () => sessionADenies)
      const isoAllowed = await runPerm('allow-unrelated-path', 'p-iso-b', async () => {
        await waitUntil(() => host.screen().includes('edit safe file'), 5000)
        await settle(150)
        host.view.push(KEY.enter)
      }, () => sessionBAllows)
      t.check(
        'two seats keep independent origin-bound policies (no global last-reader bleed)',
        JSON.stringify(permOutcomeOf(isoDenied)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }) &&
          JSON.stringify(permOutcomeOf(isoAllowed)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
      )

      const goneOrigin = await runPerm('allow-unrelated-path', 'p-gone', undefined, () => {
        throw new Error('originating session closed')
      })
      t.check('seat whose originating policy reader disappears fails closed with no card', JSON.stringify(permOutcomeOf(goneOrigin)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }))

      const noOrigin = await runPerm('allow-unrelated-path', 'p-noorigin')
      t.check('seat attached without an origin policy reader fails closed even while screen is mounted', JSON.stringify(permOutcomeOf(noOrigin)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }))

      const liveRecheckEntries = await runPerm('live-deny-recheck', 'p-recheck', async () => {
        await waitUntil(() => host.screen().includes('edit safe file'), 5000)
        host.setPermissionContext(makePermissionContext('sovereign', ['Edit(src/ok.ts)']))
        await settle(150)
        host.view.push(KEY.enter)
      }, host.getPermissionContext)
      t.check('live deny rule added while card is open blocks approval on recheck', JSON.stringify(permOutcomeOf(liveRecheckEntries)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }), JSON.stringify(permOutcomeOf(liveRecheckEntries)))
      host.setPermissionContext(makePermissionContext('sovereign', ['Edit(secrets/token.txt)', 'Read(private/**)']))

      const opaqueDenyEntries = await runPerm('opaque-ask', 'p-odeny', async () => {
        await waitUntil(() => host.screen().includes('Approve step'), 5000)
        await settle(150)
        host.view.push(KEY.down)
        await settle(80)
        host.view.push(KEY.enter)
      }, host.getPermissionContext)
      t.check('opaque explicitly denied via Down+Enter sends exact reject optionId', JSON.stringify(permOutcomeOf(opaqueDenyEntries)) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }))

      const opaqueEscEntries = await runPerm('opaque-ask', 'p-oesc', async () => {
        await waitUntil(() => host.screen().includes('Approve step'), 5000)
        await settle(150)
        host.view.push(KEY.esc)
      }, host.getPermissionContext)
      t.check('opaque cancelled via Esc sends ACP cancelled outcome', JSON.stringify(permOutcomeOf(opaqueEscEntries)) === JSON.stringify({ outcome: { outcome: 'cancelled' } }))

      const mismatchEntries = await runPerm('mismatched-session-ask', 'p-mismatch', undefined, host.getPermissionContext)
      t.check('permission request for mismatched sessionId fails closed with no card', JSON.stringify(permOutcomeOf(mismatchEntries)) === JSON.stringify({ outcome: { outcome: 'cancelled' } }))

      const foreignEntries = await runPerm('foreign-option', 'p-foreign', undefined, host.getPermissionContext)
      const foreignErr = foreignEntries.find(e => e.dir === 'in' && e.msg?.error !== undefined)
      t.check('foreign/invalid option kind rejected fail-closed by ACP SDK schema (-32602)', foreignErr?.msg?.error?.code === -32602, JSON.stringify(foreignErr?.msg))

      const unsupEntries = await runPerm('unsupported-methods', 'p-unsup', undefined, host.getPermissionContext)
      const unsupErrs = unsupEntries.filter(e => e.dir === 'in' && (e.msg?.id === 501 || e.msg?.id === 502 || e.msg?.id === 503))
      t.check('unsupported fs/* and terminal/* rejected with -32601 and zero local command execution', unsupErrs.length === 3 && unsupErrs.every(r => r.msg?.error?.code === -32601) && !existsSync(join(seatCwd, 'pwned')) && !existsSync(join(mainCwd, 'pwned')))
    } finally {
      host.unmount()
    }

    const noCardEntries = await runPerm('opaque-ask', 'p-nocard')
    const noCardOutcome = permOutcomeOf(noCardEntries) as { outcome?: { outcome?: string; optionId?: string } } | undefined
    t.check('missing operator/card path and unavailable live policy fail closed', noCardOutcome?.outcome?.outcome === 'cancelled' || noCardOutcome?.outcome?.optionId === 'reject-once', JSON.stringify(noCardOutcome))
  }

  t.section('§5 — cancel mid-card, exit mid-turn, concurrent seats, mixed native+external queue')
  {
    bridge._resetSeatBridgeForTesting()
    caps._resetCapabilitiesForTesting()
    const dir = join(scratch, 'store-cc')
    const host = await mountCardHost(makePermissionContext('default', []))
    try {
      const cLog = nextLog('cancel-mid-card')
      setStubEnv({ log: cLog, scenario: 'hold-until-cancel', agentName: 'devin' })
      const cSeat = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd, getPermissionContext: host.getPermissionContext }), { dir })
      const cSettled: TurnSettlement[] = []
      const unsubC = bridge.onSeatTurnSettled(cSeat.seatId, s => cSettled.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: 'msg-c-1', requestedAddress: { agentId: cSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'hold', attachments: [] }, { dir })
      t.check('prose update never answers ask; card stays open', await waitUntil(() => host.screen().includes('Wait for cancel while card open'), 5000))
      const replay = await dispatch.dispatchToAgent({ clientMessageId: 'msg-c-1', requestedAddress: { agentId: cSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'hold', attachments: [] }, { dir })
      const cancelOutcome = await bridge.cancelSeatTurn(cSeat.seatId)
      const cDone = await waitUntil(() => cSettled.length === 1, 5000)
      const cardGone = await waitUntil(() => !host.screen().includes('Wait for cancel while card open'), 4000)
      const cEntries = readStubLog(cLog)
      t.check(
        'cancel during open card withdraws card, sends cancelled reply + session/cancel, settles cancelled, 1 prompt total',
        replay.state === 'delivered' &&
          cancelOutcome.result === 'accepted' &&
          cDone &&
          cSettled[0]?.status === 'cancelled' &&
          cardGone &&
          cEntries.filter(e => e.dir === 'in' && e.msg?.method === 'session/prompt').length === 1 &&
          cEntries.filter(e => e.dir === 'in' && e.msg?.method === 'session/cancel').length === 1 &&
          JSON.stringify(permOutcomeOf(cEntries)) === JSON.stringify({ outcome: { outcome: 'cancelled' } }),
      )
      unsubC()
      await bridge.detachExternalSeat(cSeat.seatId)

      const eLog = nextLog('exit-mid-turn')
      setStubEnv({ log: eLog, scenario: 'exit-mid-turn', agentName: 'goose' })
      const eSeat = await bridge.attachExternalSeat(acpSeatTransport('goose', 'goose', { command: ['goose', 'acp'], cwd: seatCwd, getPermissionContext: host.getPermissionContext }), { dir })
      const eSettled: TurnSettlement[] = []
      const unsubE = bridge.onSeatTurnSettled(eSeat.seatId, s => eSettled.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: 'msg-e-1', requestedAddress: { agentId: eSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'crash', attachments: [] }, { dir })
      await waitUntil(() => host.screen().includes('Will crash while card open'), 5000)
      const eDone = await waitUntil(() => eSettled.length === 1, 5000)
      const eGone = await waitUntil(() => !host.screen().includes('Will crash while card open'), 4000)
      t.check('child exit mid-turn settles exited, withdraws card, expires capabilities', eDone && eSettled[0]?.status === 'exited' && eGone && bridge.attachedSeatOf(eSeat.seatId)?.lifecycle === 'exited' && bridge.attachedSeatOf(eSeat.seatId)?.capabilities.invalidatedAt !== undefined)
      unsubE()
      await bridge.detachExternalSeat(eSeat.seatId)

      const logA = nextLog('conc-oc')
      setStubEnv({ log: logA, scenario: 'concurrent-ask', agentName: 'opencode', askId: 42 })
      const seatA = await bridge.attachExternalSeat(acpSeatTransport('opencode', 'OpenCode', { command: ['opencode', 'acp'], cwd: seatCwd, getPermissionContext: host.getPermissionContext }), { dir })
      const logB = nextLog('conc-devin')
      setStubEnv({ log: logB, scenario: 'concurrent-ask', agentName: 'devin', askId: 42 })
      const seatB = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd, getPermissionContext: host.getPermissionContext }), { dir })
      const sA: TurnSettlement[] = []
      const sB: TurnSettlement[] = []
      const uA = bridge.onSeatTurnSettled(seatA.seatId, s => sA.push(s))
      const uB = bridge.onSeatTurnSettled(seatB.seatId, s => sB.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: 'ca-1', requestedAddress: { agentId: seatA.agentId }, requestedDisposition: 'start-turn', instruction: 'A', attachments: [] }, { dir })
      await waitUntil(() => host.screen().includes('Concurrent ask from opencode'), 5000)
      await dispatch.dispatchToAgent({ clientMessageId: 'cb-1', requestedAddress: { agentId: seatB.agentId }, requestedDisposition: 'start-turn', instruction: 'B', attachments: [] }, { dir })
      await settle(150)
      host.view.push(KEY.enter)
      await waitUntil(() => sA.length === 1, 5000)
      t.check('concurrent seat A settles while seat B stays open (no cross-leak)', sA.length === 1 && sB.length === 0)
      await waitUntil(() => host.screen().includes('Concurrent ask from devin'), 5000)
      await settle(150)
      host.view.push(KEY.down)
      await settle(80)
      host.view.push(KEY.enter)
      await waitUntil(() => sB.length === 1, 5000)
      const rA = readStubLog(logA).find(e => e.dir === 'in' && e.msg?.id === 42)
      const rB = readStubLog(logB).find(e => e.dir === 'in' && e.msg?.id === 42)
      t.check('same ask id 42 on concurrent seats routes each reply strictly to its own child', JSON.stringify(rA?.msg?.result) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-opencode' } }) && JSON.stringify(rB?.msg?.result) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-devin' } }))
      uA()
      uB()
      await bridge.detachExternalSeat(seatA.seatId)
      await bridge.detachExternalSeat(seatB.seatId)
    } finally {
      host.unmount()
    }

    const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/engine/connector/focusedConnector.ts')
    const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
    const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
    type EngineConnectorV1 = import('../../src/engine/connector/types.ts').EngineConnectorV1
    type SessionAskV1 = import('../../src/engine/connector/types.ts').SessionAskV1
    let nativeAsks: SessionAskV1[] = []
    const nativeListeners = new Set<() => void>()
    const nativeAnswered: string[] = []
    const emitNative = (): void => { for (const l of nativeListeners) l() }
    const settleNative = (id: string): void => { nativeAsks = nativeAsks.filter(a => a.id !== id); emitNative() }
    const answerNative = (id: string, answer: 'allow' | 'deny'): void => { nativeAnswered.push(`${answer} ${id}`); settleNative(id) }
    const nativeAsk = (id: string, command: string): SessionAskV1 => ({
      id,
      toolName: 'Bash',
      askedAt: Date.now(),
      confirm: {
        assistantMessage: createAssistantMessage({ content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command } }] }),
        tool: getAllBaseTools().find(tool => tool.name === 'Bash')!,
        description: `Run ${command}`,
        input: { command },
        toolUseContext: {
          options: { commands: [], debug: false, verbose: false, engineModel: 'claude-sonnet-4-6', tools: getAllBaseTools(), mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
          startTurn: () => { throw new Error('unused') },
          abortController: new AbortController(),
          readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
          getAppState: () => getDefaultAppState(),
          setAppState: () => {},
          messages: [],
          setResponseLength: () => {},
          updateFileHistoryState: () => {},
        },
        toolUseID: `toolu_${id}`,
        permissionResult: { behavior: 'ask', message: 'Bash asks to run' },
        permissionPromptStartTimeMs: Date.now(),
        onUserInteraction: () => {},
        onAbort: () => {},
        onAllow: () => answerNative(id, 'allow'),
        onReject: () => answerNative(id, 'deny'),
        recheckPermission: async () => {},
      },
    })
    const baseConn: EngineConnectorV1 = new NoSessionConnector()
    setFocusedSessionConnector(
      Object.assign(Object.create(Object.getPrototypeOf(baseConn)), baseConn, {
        asks: (): readonly SessionAskV1[] => nativeAsks,
        subscribeAsks: (l: () => void): (() => void) => { nativeListeners.add(l); return () => nativeListeners.delete(l) },
        settleAsk: settleNative,
      }),
    )
    const repliesTo = (log: string, askId: number): StubEntry[] => readStubLog(log).filter(e => e.dir === 'in' && e.msg?.id === askId && e.msg?.method === undefined)
    const mixedHost = await mountCardHost(makePermissionContext('default', []))
    try {
      nativeAsks = [nativeAsk('native-1', 'echo native-first')]
      emitNative()
      await waitUntil(() => mixedHost.screen().includes('echo native-first'), 4000)
      const mLog = nextLog('mixed-ext')
      setStubEnv({ log: mLog, scenario: 'opaque-ask', agentName: 'devin' })
      const mSeat = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd, getPermissionContext: mixedHost.getPermissionContext }), { dir })
      const mSettled: TurnSettlement[] = []
      const uM = bridge.onSeatTurnSettled(mSeat.seatId, s => mSettled.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: 'mixed-1', requestedAddress: { agentId: mSeat.agentId }, requestedDisposition: 'start-turn', instruction: 'behind native', attachments: [] }, { dir })
      await waitUntil(() => bridge.listExternalSeatAsks().length === 1, 4000)
      await settle(150)
      t.check('mixed queue holds native head (1/2) while external ask waits behind it', mixedHost.screen().includes('echo native-first') && mixedHost.screen().includes('1/2'))
      mixedHost.view.push(KEY.enter)
      await waitUntil(() => nativeAnswered.includes('allow native-1'), 4000)
      const extUp = await waitUntil(() => mixedHost.screen().includes('Approve step'), 4000)
      t.check(
        'allowing the native head, which leaves the list at its answer, keeps the external ask waiting unanswered and paints its card',
        extUp && bridge.listExternalSeatAsks().length === 1 && permOutcomeOf(readStubLog(mLog)) === undefined && mSettled.length === 0,
        `card=${extUp} waiting=${bridge.listExternalSeatAsks().length} reply=${JSON.stringify(permOutcomeOf(readStubLog(mLog)))} settled=${mSettled.length}`,
      )
      await settle(150)
      mixedHost.view.push(KEY.enter)
      await waitUntil(() => mSettled.length === 1, 4000)
      t.check(
        'answering the external card reaches its own agent, settles end_turn and drains the queue',
        mSettled[0]?.stopReason === 'end_turn' && bridge.listExternalSeatAsks().length === 0 && JSON.stringify(permOutcomeOf(readStubLog(mLog))) === JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
        `stop=${mSettled[0]?.stopReason} reply=${JSON.stringify(permOutcomeOf(readStubLog(mLog)))}`,
      )
      nativeAsks = [nativeAsk('native-2', 'echo native-after')]
      emitNative()
      await waitUntil(() => mixedHost.screen().includes('echo native-after'), 4000)
      await settle(150)
      mixedHost.view.push(KEY.enter)
      await waitUntil(() => nativeAnswered.includes('allow native-2'), 4000)
      t.check(
        'a native ask, an external ask and a native ask answered in that order each reach their own asker once',
        JSON.stringify(nativeAnswered) === JSON.stringify(['allow native-1', 'allow native-2']) && mSettled.length === 1 && repliesTo(mLog, 101).length === 1,
        `${JSON.stringify(nativeAnswered)} externalReplies=${repliesTo(mLog, 101).length}`,
      )
      uM()
      await bridge.detachExternalSeat(mSeat.seatId)

      nativeAsks = [nativeAsk('native-3', 'echo native-denied')]
      emitNative()
      await waitUntil(() => mixedHost.screen().includes('echo native-denied'), 4000)
      const dLogA = nextLog('deny-oc')
      setStubEnv({ log: dLogA, scenario: 'concurrent-ask', agentName: 'opencode', askId: 42 })
      const dSeatA = await bridge.attachExternalSeat(acpSeatTransport('opencode', 'OpenCode', { command: ['opencode', 'acp'], cwd: seatCwd, getPermissionContext: mixedHost.getPermissionContext }), { dir })
      const dLogB = nextLog('deny-devin')
      setStubEnv({ log: dLogB, scenario: 'concurrent-ask', agentName: 'devin', askId: 42 })
      const dSeatB = await bridge.attachExternalSeat(acpSeatTransport('devin', 'Devin', { command: ['devin', 'acp'], cwd: seatCwd, getPermissionContext: mixedHost.getPermissionContext }), { dir })
      const dA: TurnSettlement[] = []
      const dB: TurnSettlement[] = []
      const uDA = bridge.onSeatTurnSettled(dSeatA.seatId, s => dA.push(s))
      const uDB = bridge.onSeatTurnSettled(dSeatB.seatId, s => dB.push(s))
      await dispatch.dispatchToAgent({ clientMessageId: 'deny-a-1', requestedAddress: { agentId: dSeatA.agentId }, requestedDisposition: 'start-turn', instruction: 'A', attachments: [] }, { dir })
      await waitUntil(() => bridge.listExternalSeatAsks().length === 1, 5000)
      await dispatch.dispatchToAgent({ clientMessageId: 'deny-b-1', requestedAddress: { agentId: dSeatB.agentId }, requestedDisposition: 'start-turn', instruction: 'B', attachments: [] }, { dir })
      await waitUntil(() => bridge.listExternalSeatAsks().length === 2, 5000)
      await settle(150)
      t.check('two seats ask behind a native head (1/3)', mixedHost.screen().includes('echo native-denied') && mixedHost.screen().includes('1/3'))
      mixedHost.view.push(KEY.esc)
      await waitUntil(() => nativeAnswered.includes('deny native-3'), 4000)
      const firstUp = await waitUntil(() => mixedHost.screen().includes('Concurrent ask from opencode'), 4000)
      t.check(
        "denying the native head removes neither seat's ask and answers neither",
        firstUp && bridge.listExternalSeatAsks().length === 2 && dA.length === 0 && dB.length === 0 && repliesTo(dLogA, 42).length === 0 && repliesTo(dLogB, 42).length === 0,
        `answered=${JSON.stringify(nativeAnswered)} card=${firstUp} waiting=${bridge.listExternalSeatAsks().length} settled=${dA.length}+${dB.length} replies=${repliesTo(dLogA, 42).length}+${repliesTo(dLogB, 42).length}`,
      )
      await settle(150)
      mixedHost.view.push(KEY.enter)
      await waitUntil(() => dA.length === 1, 5000)
      const secondUp = await waitUntil(() => mixedHost.screen().includes('Concurrent ask from devin'), 5000)
      await settle(150)
      mixedHost.view.push(KEY.down)
      await settle(80)
      mixedHost.view.push(KEY.enter)
      await waitUntil(() => dB.length === 1, 5000)
      t.check(
        'the two seats are then answered in the order they asked, each reply to its own child',
        secondUp &&
          JSON.stringify(repliesTo(dLogA, 42).map(e => e.msg?.result)) === JSON.stringify([{ outcome: { outcome: 'selected', optionId: 'allow-opencode' } }]) &&
          JSON.stringify(repliesTo(dLogB, 42).map(e => e.msg?.result)) === JSON.stringify([{ outcome: { outcome: 'selected', optionId: 'reject-devin' } }]) &&
          bridge.listExternalSeatAsks().length === 0,
        `A=${JSON.stringify(repliesTo(dLogA, 42).map(e => e.msg?.result))} B=${JSON.stringify(repliesTo(dLogB, 42).map(e => e.msg?.result))} waiting=${bridge.listExternalSeatAsks().length}`,
      )
      uDA()
      uDB()
      await bridge.detachExternalSeat(dSeatA.seatId)
      await bridge.detachExternalSeat(dSeatB.seatId)
    } finally {
      mixedHost.unmount()
      _resetFocusedSessionConnectorForTesting()
    }
  }
} finally {
  console.log(`\nruntime counts: missingProfiles=${missingProfiles} missingDeliveries=${missingDeliveries} invalidVersionsAccepted=${invalidVersionsAccepted}`)
  bridge._resetSeatBridgeForTesting()
  caps._resetCapabilitiesForTesting()
  process.chdir(origCwd)
  process.env.PATH = origPath
  releaseScratchHome(home)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('prove-acp-seat-client')
