import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { waitFor } from '../lib/settingsPopupHarness.ts'

const ROOT = resolve(import.meta.dir, '../..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const homeRoot = process.env.MERCURY_CONFIG_DIR
if (!homeRoot) throw new Error('MERCURY_CONFIG_DIR must name a scratch home')
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_NPM_REGISTRY_BASE = 'http://127.0.0.1:1'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
delete process.env.NO_COLOR
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', IS_DEV: false }

const sceneNeedle = (scene: string): string => scene === 'still' ? 'compacting context' : scene === 'crew-view' ? 'layout' : scene === 'permission-ask' ? 'Yes' : scene === 'provider-error' ? 'Fixture provider unavailable' : '↓'
const states = ['thinking', 'thinking-frame', 'reply-streaming', 'long-prefill', 'one-tool', 'several-tools', 'waiting-on-crewmates', 'crew-view', 'reconnect', 'permission-ask', 'compaction', 'still', 'streaming-hold', 'provider-error']
const noise = /reading the prompt|reading \d+k tokens of context|waiting for the first token|still waiting|first.byte budget|first byte expected|\bthinking\b|\bwriting\b|summarising|micro-compaction|restoring|↻/
const child = arg('--child')
if (child) {
  const home = mkdtempSync(join(homeRoot, 'quiet-child-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
  mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ activity: { verbs: { mode: 'replace', verbs: ['Fencing the wolves'] }, tips: { enabled: false } } }))
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const React = await import('react')
  const { render, Box, Text } = await import('../../src/ink.ts')
  const { App } = await import('../../src/components/App.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { SpinnerWithVerb } = await import('../../src/components/Spinner.tsx')
  const { StreamingHoldRow } = await import('../../src/components/Spinner/StreamingHoldRow.tsx')
  const { FoldStatusRow } = await import('../../src/components/FoldStatusRow.tsx')
  const { MercuryFrame } = await import('../../src/components/MercuryFrame.tsx')
  const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
  const { PermissionRequest } = await import('../../src/components/permissions/PermissionRequest.tsx')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
  const { SystemAPIErrorMessage } = await import('../../src/components/messages/SystemAPIErrorMessage.tsx')
  const { waitingStatusWords, statusLine } = await import('../../src/components/SwitchboardTagBar.tsx')
  const { WorkCapsuleContext } = await import('../../src/components/mercury-ui/WorkCapsule.tsx')
  const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
  const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const { beginFoldStatus, foldStatusOnEvent } = await import('../../src/services/compact/foldStatus.ts')
  const { ERROR_MESSAGE_PROMPT_TOO_LONG } = await import('../../src/services/compact/compact.ts')
  const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  type Facts = import('../../src/components/Spinner/liveCounterWords.ts').LiveCounterFacts
  type Props = Parameters<typeof SpinnerWithVerb>[0]
  const started = Date.now()
  const fresh = (): Facts => ({ phase: 'waiting', sentAtMs: started - 65_000, firstByteAtMs: null, replyChars: 0, thinkingChars: 0, wireOutputTokens: null, wait: null })
  const streaming = fresh()
  let thinking = fresh()
  let prefill = fresh()
  let requests = 0
  const timers = new Set<ReturnType<typeof setInterval>>()
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      const send = (delta: unknown): void => { res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`) }
      setTimeout(() => {
        if (res.destroyed) return
        send({ reasoning_content: 'think '.repeat(800) })
        setTimeout(() => {
          if (res.destroyed) return
          const timer = setInterval(() => { if (!res.destroyed) send({ content: 'reply '.repeat(25) }) }, 100)
          timers.add(timer)
          res.on('close', () => { clearInterval(timer); timers.delete(timer) })
        }, 200)
      }, 200)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const controller = new AbortController()
  const fetch0 = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (!String(input).startsWith(base)) throw new Error('fixture refused non-loopback request')
    return fetch0(input as never, init)
  }) as typeof fetch
  const consume = (async () => {
    const profile = { lane: 'openai-compat', providerLabel: 'Fixture', requestUrl: () => `${base}/chat/completions`, resolveCredential: () => ({}), credentialHint: '', wireModelId: () => 'fixture', buildExtras: () => ({}) }
    const params = { messages: [createUserMessage({ content: 'fixture' })], systemPrompt: ['fixture'], thinkingConfig: { type: 'enabled', budgetTokens: 8192 }, tools: [], signal: controller.signal, options: { model: 'fixture', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max', onWait: (wait: Facts['wait']) => { streaming.wait = wait; if (wait?.kind === 'first-byte') prefill = { ...streaming } } } }
    for await (const item of compatChatCallModel(profile as never, params as never)) {
      if (item.type !== 'stream_event' || item.event.type !== 'content_block_delta') continue
      const delta = item.event.delta
      streaming.firstByteAtMs ??= Date.now()
      streaming.lastByteAtMs = Date.now()
      if (delta.type === 'thinking_delta') {
        streaming.thinkingChars += delta.thinking.length
        streaming.phase = 'thinking'
        thinking = { ...streaming, sentAtMs: started - 12_000 }
      }
      if (delta.type === 'text_delta') {
        streaming.replyChars += delta.text.length
        streaming.phase = 'writing'
      }
    }
  })()
  await waitFor(() => streaming.replyChars > 0 && streaming.phase === 'writing', 4000)
  const frozen = { ...streaming }
  const reconnect: Facts = { ...prefill, sentAtMs: started - 130_000, wait: { kind: 'retry', attempt: 2, of: 5, sinceMs: started, delayMs: 1000, reason: 'no tokens for 2 min', reconnecting: true, silentMs: 120_000 } }
  let fold = foldStatusOnEvent(beginFoldStatus({ trigger: 'auto', startedAtMs: started - 20_000, sessionMemory: false, microcompaction: true }), { type: 'compact_start' })
  fold = foldStatusOnEvent(fold, { type: 'summary_progress', chars: 4800 })
  const live = { inFlight: true, phase: child === 'thinking-frame' ? 'thinking' as const : 'waiting' as const, agentsWaiting: 2, inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: started }
  const initialState = getDefaultAppState()
  const noop = () => {}
  const toolUseContext = { getAppState: () => initialState, abortController: new AbortController(), messages: [] }
  const confirm = { tool: BashTool, toolUseID: 'fixture-permission', description: 'Run fixture command', input: { command: "printf 'fixture\\n'" }, toolUseContext, permissionResult: { behavior: 'ask' }, permissionPromptStartTimeMs: started, cwd: '/fixture', onUserInteraction: noop, onAbort: noop, onAllow: noop, onReject: noop, recheckPermission: async () => {}, assistantMessage: { type: 'assistant', message: { role: 'assistant', content: [] } } }
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
  updateConcourseWorkers(workers => { workers['quiet-fixture'] = { schema: 1, runnerId: 'quiet-fixture', sessionId: 'quiet-fixture', workspaceId: 'fixture', isolation: 'exclusive', modelKey: 'fixture', effort: 'max', spawnedAt: started, attachedAt: started, lastLiveAt: started, worktree: ROOT } as never }, process.env.MERCURY_DAEMON_DIR)
  const connector = noSessionConnector()
  const roster = { ...connector.workRoster(), rows: [
    { id: 'lane-a', agentId: 'lane-a', kind: 'agent', name: 'layout', status: 'running', model: 'fixture', startTime: started - 30000, activity: 'Reading fixture.ts', contextTokens: 1200, totalTokens: 1200, inputTokens: 1000, outputTokens: 200, pendingAsks: 0 },
    { id: 'lane-b', agentId: 'lane-b', kind: 'agent', name: 'checks', status: 'running', model: 'fixture', startTime: started - 22000, activity: 'Run fixture command', contextTokens: 800, totalTokens: 800, inputTokens: 700, outputTokens: 100, pendingAsks: 1 },
  ] }
  const asks = [{ id: 'fixture-permission', confirm, toolName: 'Bash', agentId: 'lane-b', askedAt: started }]
  setFocusedSessionConnector(Object.assign(connector, { carrier: 'daemon', sessionId: () => 'quiet-fixture', live: () => live, subscribeLive: () => noop, status: () => ({ wait: null, stuck: false, quietMs: 3000, phaseMs: 12000 }), tail: () => ({}), fold: () => fold, subscribeFold: () => noop, workRoster: () => roster, asks: () => asks }) as never)
  const ref = <T,>(current: T) => ({ current })
  const props = (f: Facts, over: Partial<Props> = {}): Props => ({ mode: f.phase === 'thinking' ? 'thinking' : f.phase === 'writing' ? 'responding' : 'requesting', loadingStartTimeRef: ref(f.sentAtMs!), totalPausedMsRef: ref(0), pauseStartTimeRef: ref<number | null>(null), responseLengthRef: { get current() { return f.thinkingChars + f.replyChars } }, liveTurnFactsRef: ref(f), verbose: true, hasActiveTools: false, activeToolCount: 0, ...over })
  const h = React.createElement
  const node = (label: string, f: Facts, over: Partial<Props> = {}) => h(Box, { flexDirection: 'column', marginBottom: 1, key: label }, h(Text, { dimColor: true }, label), h(SpinnerWithVerb, props(f, over)))
  const holdProps = props(frozen)
  const compact = Number(process.stdout.columns) === 80
  const spin = (f: Facts, over: Partial<Props> = {}) => h(SpinnerWithVerb, props(f, { compact, ...over }))
  const beforeWait = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8').includes('const viewDelegationWait =')
  const content = child === 'thinking' ? spin(thinking)
    : child === 'thinking-frame' ? h(Box, { flexDirection: 'column' }, spin(thinking), h(MercuryFrame, { model: 'fixture' }))
    : child === 'reply-streaming' ? spin(streaming, { overrideMessage: 'Hashing the oasis' })
    : child === 'long-prefill' ? spin(prefill, { overrideMessage: 'Parsing the dunes' })
    : child === 'one-tool' || child === 'several-tools' ? spin(frozen, { mode: 'tool-use', hasActiveTools: true, activeToolCount: child === 'one-tool' ? 1 : 3, activeToolLabel: 'Reading fixture.ts' })
    : child === 'waiting-on-crewmates' ? spin(frozen, { mode: 'requesting', compactWarning: beforeWait && compact, overrideMessage: beforeWait ? compact ? statusLine(live, { wait: null } as never, null, true) : waitingStatusWords(live) : null })
    : child === 'crew-view' ? h(CrewView, { onClose: noop, popup: true })
    : child === 'reconnect' ? spin(reconnect, { overrideMessage: 'Parsing the dunes' })
    : child === 'permission-ask' ? h(PermissionRequest, { toolUseConfirm: confirm, toolUseContext, onDone: noop, onReject: noop, verbose: false, workerBadge: { name: 'checks', color: 'blue' } } as never)
    : child === 'compaction' ? h(FoldStatusRow, { rows: [], conversationId: 'quiet-fixture' })
    : child === 'still' ? spin(prefill, { overrideMessage: 'compacting context', still: true })
    : child === 'streaming-hold' ? h(StreamingHoldRow, holdProps)
    : child === 'provider-error' ? h(SystemAPIErrorMessage, { message: { retryAttempt: 2, maxRetries: 5, error: new Error('Fixture provider unavailable'), retryInMs: 10000 }, verbose: false } as never)
    : child === 'turns' ? [node('Normal work', thinking), node('Reply', streaming, { overrideMessage: 'Hashing the oasis' }), node('Long prefill', prefill, { overrideMessage: 'Parsing the dunes' }), node('Active tool', frozen, { mode: 'tool-use', hasActiveTools: true, activeToolCount: 3, activeToolLabel: 'Reading fixture.ts' }), node('Compact-width reply', streaming, { compact: true, overrideMessage: 'Hashing the oasis' })]
    : [node('Recovery', reconnect, { overrideMessage: 'Parsing the dunes' }), node('Compact-width recovery', reconnect, { compact: true, overrideMessage: 'Parsing the dunes' }), h(StreamingHoldRow, holdProps), h(FoldStatusRow, { rows: [], conversationId: 'quiet-fixture' }), node('Still', prefill, { overrideMessage: 'compacting context', still: true }), node('Compact still', prefill, { compact: true, overrideMessage: 'compacting context', still: true }), h(Text, { color: 'error' }, ERROR_MESSAGE_PROMPT_TOO_LONG)]
  const instance = await render(h(App, { initialState, getFpsMetrics: () => undefined }, h(WorkCapsuleContext.Provider, { value: true }, h(Box, { flexDirection: 'column', width: '100%' }, content))))
  if (child === 'attention' || child === 'streaming-hold') {
    const realNow = Date.now
    setTimeout(() => { Date.now = () => realNow() + 11_000 }, 500)
  }
  setTimeout(async () => {
    controller.abort()
    await consume
    for (const timer of timers) clearInterval(timer)
    server.closeAllConnections()
    server.close()
    instance.unmount()
    rmSync(home, { recursive: true, force: true })
    const receipt = { requests, thinkingChars: thinking.thinkingChars, replyChars: streaming.replyChars, prefillFirstByte: prefill.firstByteAtMs, aborted: controller.signal.aborted }
    writeFileSync(arg('--receipt')!, JSON.stringify(receipt))
    process.exit(requests === 1 && thinking.thinkingChars === 4800 && streaming.replyChars > 0 && prefill.firstByteAtMs === null ? 0 : 1)
  }, 4500)
} else {
  const out = arg('--out')
  if (!out) throw new Error('--out must name a scratch capture directory')
  mkdirSync(out, { recursive: true })
  const before = process.argv.includes('--before')
  const { gridToPng } = await import('./gridToPng.ts')
  let failed = 0
  const check = (label: string, ok: boolean): void => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`); if (!ok) failed++ }
  for (const [cols, rows] of [[80, 24], [120, 40]].filter(([cols]) => !arg('--cols') || cols === Number(arg('--cols')))) {
    for (const scene of arg('--state') ? [arg('--state')!] : states) {
      const stem = join(out, `${before ? 'before' : 'after'}-${scene}-${cols}x${rows}`)
      writeFileSync(`${stem}.cfg.json`, JSON.stringify({ argv: [process.execPath, resolve(import.meta.path), '--child', scene, '--receipt', `${stem}.receipt.json`], cwd: ROOT, cols, rows, total: 40, sends: [{ mark: 'scene', data: '', atTick: 999, awaitText: sceneNeedle(scene), requireAwait: true }], out: `${stem}.json` }))
      const capture = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), `${stem}.cfg.json`], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 45_000 })
      if (capture.status !== 0) throw new Error(capture.stderr || capture.stdout || `capture exited ${capture.status}`)
      const receipt = JSON.parse(readFileSync(`${stem}.receipt.json`, 'utf8'))
      check(`${cols} ${scene}: one loopback stream delivered separate reasoning/reply counts and was aborted at cleanup`, receipt.requests === 1 && receipt.thinkingChars === 4800 && receipt.replyChars > 0 && receipt.prefillFirstByte === null && receipt.aborted === true)
      const payload = JSON.parse(readFileSync(`${stem}.json`, 'utf8')) as { grid: Array<Array<{ c: string }>> }
      const text = payload.grid.map(row => row.map(cell => cell.c).join('')).join('\n')
      writeFileSync(`${stem}.txt`, text)
      await gridToPng(`${stem}.json`, `${stem}.png`)
      console.log(`${stem}.png`)
      check(`${cols} ${scene}: rendered nonblank without a render fault`, text.trim().length > 0 && !text.includes('RENDER ERROR'))
      if (['crew-view', 'permission-ask', 'provider-error'].includes(scene)) {
        if (scene === 'crew-view') check(`${cols}: both running lanes and pending ask remain`, text.includes('layout') && text.includes('checks') && /ask|permission|waiting for your answer/.test(text))
        if (scene === 'permission-ask') check(`${cols}: consent choices remain`, text.includes('Yes') && text.includes('No') && text.includes('fixture'))
        if (scene === 'provider-error') check(`${cols}: provider failure and recovery remain`, text.includes('Fixture provider unavailable') && text.includes('Retrying'))
      } else if (before) {
        const expectedNoise = !['still', 'reconnect', 'waiting-on-crewmates'].includes(scene) || scene === 'still' && cols === 80
        if (expectedNoise) check(`${cols} ${scene}: old narration visible`, noise.test(text))
        if (scene === 'waiting-on-crewmates') check(`${cols}: former delegation sentence visible`, text.includes('waiting on'))
      } else {
        check(`${cols} ${scene}: no routine phase or heartbeat narration`, !noise.test(text))
        if (scene !== 'still') check(`${cols} ${scene}: counters remain`, /↓ (?:~)?[0-9]/.test(text))
        if (scene === 'reply-streaming') check(`${cols}: streaming rate appears`, /tok\/s/.test(text))
        if (scene === 'long-prefill') check(`${cols}: known zero survives`, text.includes('↓ 0'))
        if (scene === 'reconnect') check(`${cols}: actual recovery remains`, text.includes('reconnecting 2 of 5'))
        if (scene === 'waiting-on-crewmates') check(`${cols}: verb replaces delegation sentence`, text.includes('Fencing the wolves') && !text.includes('waiting on'))
        if (scene === 'still') check(`${cols}: still row stays bare`, text.trim() === '✶ compacting context')
      }
    }
  }
  process.exit(failed ? 1 : 0)
}
