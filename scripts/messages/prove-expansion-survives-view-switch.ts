#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'expansion-view-switch-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const strip = (x: string): string => x.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
const settle = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms))

const React = await import('react')
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const { Box, Text } = await import('../../src/ink.ts')

type Clickable = { onItemClick?: (msg: unknown) => void; isItemClickable?: (msg: unknown) => boolean; isItemExpanded?: (msg: unknown) => boolean; messages: unknown[]; renderItem: (msg: unknown, i: number) => React.ReactNode }
const lists = new Map<string, Clickable>()
mock.module('../../src/components/VirtualMessageList.tsx', () => ({
  VirtualMessageList: (props: Clickable & { itemKey: (m: unknown) => string }) => {
    const first = props.messages[0] as { uuid?: string } | undefined
    const key = props.itemKey(first ?? {})
    lists.set(key.slice(key.indexOf(':') + 1), props)
    return h(Box as never, { flexDirection: 'column' }, ...props.messages.map((m, i) => h(Box as never, { key: props.itemKey(m) }, props.renderItem(m, i))))
  },
  default: () => null,
}))

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(true)
const { render } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { Messages } = await import('../../src/components/Messages.tsx')
const { CrewmatePlateContext } = await import('../../src/components/messages/TranscriptNameplate.tsx')
const { THINKING_LABEL } = await import('../../src/components/messages/thinkingGrammar.tsx')

const BODY = 'the reasoning body the operator opened by a click'
const at = (s: number): string => new Date(Date.UTC(2026, 9, 5, 12, 0, s)).toISOString()
const prompt = { type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: at(1), message: { role: 'user', content: 'summarise the plan' } }
const thought = { type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000002', timestamp: at(2), requestId: 'req_1', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'thinking', thinking: BODY, signature: 'sig' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }
const reply = { type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000003', timestamp: at(3), requestId: 'req_1', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'The plan has three steps.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }
const leadRows = [prompt, thought, reply]
const crewRows = [{ ...prompt, uuid: 'bbbbbbbb-0000-4000-8000-000000000001' }, { ...reply, uuid: 'bbbbbbbb-0000-4000-8000-000000000003', message: { ...reply.message, content: [{ type: 'text', text: 'the crewmate answers' }] } }]

const scrollRef = React.createRef<unknown>()
const common = { tools: [], commands: [], toolJSX: null, toolUseConfirmQueue: [], inProgressToolUseIDs: new Set<string>(), isMessageSelectorVisible: false, screen: 'prompt', streamingToolUses: [], showAllInTranscript: false, isLoading: false, streamingThinking: null, streamingTail: null, scrollRef }
let setViewOuter: ((view: 'lead' | 'crewmate') => void) | null = null
function Swap(): React.ReactNode {
  const [view, setView] = React.useState<'lead' | 'crewmate'>('lead')
  setViewOuter = setView
  if (view === 'lead') return h(Box as never, { flexDirection: 'column' }, h(Messages as never, { ...common, messages: leadRows, verbose: false, conversationId: 'lead-session' }))
  return h(CrewmatePlateContext.Provider as never, { value: { agent: 'scout', user: 'you → scout' } }, h(Box as never, { flexDirection: 'column' }, h(Messages as never, { ...common, messages: crewRows, verbose: true, conversationId: 'crewmate:scout', disableRenderCap: true })))
}

let frame = ''
const stdout = Object.assign(new Writable({ write(chunk: Buffer, _enc, cb) { frame = chunk.toString(); cb() } }), { columns: 100, rows: 40, isTTY: false }) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(Swap as never, {})), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
await settle(150)

section('§1 the lead view: a collapsed thinking row opens on the click road')
const lead = lists.get('lead-session')
check('the lead transcript mounted virtualised with its click road', lead !== undefined && typeof lead.onItemClick === 'function', JSON.stringify([...lists.keys()]))
check('the thinking row paints collapsed (label, no body)', strip(frame).includes(THINKING_LABEL) && !strip(frame).includes(BODY), strip(frame).slice(0, 300))
const thoughtRow = lead?.messages.find(m => (m as { uuid: string }).uuid === thought.uuid)
check('the row is clickable (a non-empty thought under verbose off)', thoughtRow !== undefined && lead?.isItemClickable?.(thoughtRow) === true)
lead?.onItemClick?.(thoughtRow)
await settle()
check('the click opens it: the body paints', strip(frame).includes(BODY), strip(frame).slice(0, 400))

section('§2 lead → crewmate → lead: the element type at the swap changes twice, the opened row stays open')
setViewOuter?.('crewmate')
await settle(150)
check('the crewmate view painted in its place', strip(frame).includes('the crewmate answers') && !strip(frame).includes(BODY), strip(frame).slice(0, 300))
setViewOuter?.('lead')
await settle(150)
const leadAgain = lists.get('lead-session')
check('the lead transcript was remounted (a fresh list instance behind the same view)', leadAgain !== undefined && leadAgain !== lead)
check('RED ON THE BASE: the row the operator opened is still open after the round trip', strip(frame).includes(BODY), strip(frame).split('\n').filter(l => l.trim()).slice(0, 8).join(' | '))
const thoughtAgain = leadAgain?.messages.find(m => (m as { uuid: string }).uuid === thought.uuid)
check('…and the list reads it expanded', thoughtAgain !== undefined && leadAgain?.isItemExpanded?.(thoughtAgain) === true)

section('§3 the memory is the view\'s own: the crewmate view opened nothing, and a second click folds the lead\'s row again')
const crew = lists.get('crewmate:scout')
check('the crewmate list carried no expansion of its own', crew !== undefined && crew.messages.every(m => crew.isItemExpanded?.(m) !== true))
leadAgain?.onItemClick?.(thoughtAgain)
await settle()
check('the second click folds it (one toggle, the same key)', !strip(frame).includes(BODY) && strip(frame).includes(THINKING_LABEL))

section('§4 the slice anchor rides the same memory (source pin)')
const source = readFileSync(join(ROOT, 'src/components/Messages.tsx'), 'utf8')
check('the render-cap anchor is the view\'s remembered one, never a fresh ref per mount', source.includes('const anchorRef = transcriptMemoryOf(conversationId).anchor'))
check('the expansion set is read from the view\'s memory through the one store road', source.includes('useSyncExternalStore(subscribeExpansion, readExpansion, readExpansion)') && source.includes('toggleExpandedRow(conversationId, expansionKeyOf(message))'))

instance.unmount?.()
await settle(30)
console.log(`\n${failures === 0 ? '✅ prove-expansion-survives-view-switch: an opened row stays open across a lead ↔ crewmate switch' : `❌ prove-expansion-survives-view-switch: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
