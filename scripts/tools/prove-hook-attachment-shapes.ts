#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import ts from 'typescript'

const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'hook-attachment-shapes-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

import { z } from 'zod/v4'

const ROOT = join(import.meta.dir, '..', '..')
const PRE_CONTEXT = 'PRE-CONTEXT-SENTINEL'
const POST_CONTEXT = 'POST-CONTEXT-SENTINEL'
const FAIL_CONTEXT = 'FAIL-CONTEXT-SENTINEL'
const PRE_STOP = 'PRE-STOP-SENTINEL'
const POST_STOP = 'POST-STOP-SENTINEL'
const OLDER_STOP = 'OLDER-ROW-STOP-SENTINEL'
const TOOL = 'FakeHookShapeTool'

const settle = (ms = 200): Promise<void> => new Promise(r => setTimeout(r, ms))
const guard = setTimeout(() => {
  console.log('\nprove-hook-attachment-shapes: TIMEOUT after 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const thrown = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? `${e.constructor.name}: ${e.message.split('\n')[0]}` : String(e)
  }
}

const command = (json: object): string => `echo '${j(json)}'`
function writeHooks(phase: 'context' | 'stop'): void {
  const pre =
    phase === 'stop'
      ? { continue: false, stopReason: PRE_STOP }
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: PRE_CONTEXT } }
  const post =
    phase === 'stop'
      ? { continue: false, stopReason: POST_STOP }
      : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: POST_CONTEXT } }
  const failure = { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: FAIL_CONTEXT } }
  writeFileSync(
    join(home, 'settings.json'),
    j({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: command(pre) }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: command(post) }] }],
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: command(failure) }] }],
      },
    }),
  )
}
writeHooks('context')

const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { isLoggableMessage } = await import('../../src/utils/sessionStorage/chain.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { bodyShapeIssue, validateRecord } = await import('../../src/fabric/validate.ts')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')

type Attachment = Record<string, unknown> & { type: string }
type AttachmentRow = { type: 'attachment'; uuid: string; timestamp: string; attachment: Attachment }
type Yielded = { message?: { type?: string; attachment?: Attachment } }

function makeTool(fail: boolean): Record<string, unknown> {
  return {
    name: TOOL,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: fail
      ? async () => {
          throw new Error('the tool failed on purpose')
        }
      : async () => ({ data: 'shape ok' }),
  }
}

function makeContext(tool: unknown): Record<string, unknown> {
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as never },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
  }
}

const ASSISTANT = { uuid: 'uuid-shapes', requestId: 'req_shapes', message: { id: 'msg_shapes' } } as never
const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })

async function drive(fail: boolean): Promise<AttachmentRow[]> {
  const tool = makeTool(fail)
  const rows: AttachmentRow[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_shapes', name: TOOL, input: {} } as never,
    ASSISTANT,
    ALLOW as never,
    makeContext(tool) as never,
  )) {
    const message = (update as Yielded).message
    if (message?.type === 'attachment' && message.attachment !== undefined) rows.push(message as AttachmentRow)
  }
  return rows
}

const codecContext = () => {
  let n = 0
  return {
    sessionId: '00000000-aaaa-4000-8000-000000000001' as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-08-03T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
}
function recordLineOf(row: AttachmentRow): string {
  return j(entryToRecord(row as never, codecContext() as never))
}
function registryIssue(row: AttachmentRow): string | null {
  const validated = validateRecord(JSON.parse(recordLineOf(row)))
  if (!validated.ok) return `record: ${j(validated.issues)}`
  const issue = bodyShapeIssue(validated.record)
  return issue === null ? null : `${issue.path}: ${issue.message}`
}
type Decoded = { entries: Array<{ attachment?: Attachment }>; invalid: Array<{ kind: string; reason: string }> }
const decodeLine = (line: string): Decoded => decodeTranscriptBuffer<unknown>(line + '\n') as Decoded
const wireText = (attachment: Attachment): string =>
  normalizeAttachmentForAPI(attachment as never)
    .map(m => {
      const content = (m as { message: { content: unknown } }).message.content
      return typeof content === 'string' ? content : j(content)
    })
    .join('\n')
const withoutEnvelope = (text: string): string => text.replace(/<\/?system-reminder>/g, '').trim()

section('§A the tool road hands hook_additional_context to the reader as the list its type declares, on every event')
{
  const contextRows = [...(await drive(false)), ...(await drive(true))].filter(r => r.attachment.type === 'hook_additional_context')
  const events = contextRows.map(r => r.attachment.hookEvent).sort()
  check('the three tool events each produce one context row (PreToolUse twice, once per drive)', j(events) === j(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'PreToolUse']), j(events))
  const sentinelOf: Record<string, string> = { PreToolUse: PRE_CONTEXT, PostToolUse: POST_CONTEXT, PostToolUseFailure: FAIL_CONTEXT }
  for (const row of contextRows) {
    const att = row.attachment
    const event = String(att.hookEvent)
    const sentinel = sentinelOf[event] ?? '?'
    const content = att.content
    check(
      `${event}: content is a list of strings carrying the hook's context`,
      Array.isArray(content) && content.every(s => typeof s === 'string') && content.join('\n').includes(sentinel),
      `content=${j(content)}`,
    )
    const issue = registryIssue(row)
    check(`${event}: the row validates against its registry row`, issue === null, issue ?? '')
    const readerThrow = thrown(() => wireText(att))
    check(`${event}: the wire reader never throws on the produced row`, readerThrow === null, readerThrow ?? '')
    check(`${event}: the wire text names the hook's context`, readerThrow === null && wireText(att).includes(sentinel), readerThrow ?? wireText(att).slice(0, 160))
    const doorThrow = thrown(() => isLoggableMessage(row as never))
    check(`${event}: the persistence door answers without throwing, and keeps the row`, doorThrow === null && isLoggableMessage(row as never) === true, doorThrow ?? 'not loggable')
    const decoded = decodeLine(recordLineOf(row))
    check(`${event}: the persisted line folds on decode`, decoded.entries.length === 1 && decoded.invalid.length === 0, j(decoded.invalid))
  }
}

section('§B the tool road hands hook_stopped_continuation to the reader with the reason in message, as its type declares')
{
  writeHooks('stop')
  updateHooksConfigSnapshot()
  const stopRows = (await drive(false)).filter(r => r.attachment.type === 'hook_stopped_continuation')
  const events = stopRows.map(r => r.attachment.hookEvent).sort()
  check('a pre-tool stop and a post-tool stop each produce one row', j(events) === j(['PostToolUse', 'PreToolUse']), j(events))
  const reasonOf: Record<string, string> = { PreToolUse: PRE_STOP, PostToolUse: POST_STOP }
  for (const row of stopRows) {
    const att = row.attachment
    const event = String(att.hookEvent)
    const reason = reasonOf[event] ?? '?'
    check(`${event}: message carries the hook's stop reason`, att.message === reason, `message=${j(att.message)}`)
    check(`${event}: the row carries no content field (the reader reads message)`, !('content' in att), `content=${j(att.content)}`)
    const issue = registryIssue(row)
    check(`${event}: the row validates against its registry row`, issue === null, issue ?? '')
    const text = withoutEnvelope(wireText(att))
    check(`${event}: the wire text carries the reason after the label`, text.endsWith(`hook stopped continuation: ${reason}`), j(text))
    const decoded = decodeLine(recordLineOf(row))
    const back = decoded.entries[0]?.attachment
    check(`${event}: the persisted line folds and its projection carries the reason`, decoded.invalid.length === 0 && back !== undefined && withoutEnvelope(wireText(back)).endsWith(reason), j(decoded.invalid) + ' ' + j(back))
  }
}

section('§C an older persisted stopped-continuation row (the reason under content) still reads: the migration read, at the wire and on the transcript row')
const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { AttachmentMessage } = await import(join(ROOT, 'src/components/messages/AttachmentMessage.tsx'))
const { MessageMetaProvider } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
async function paint(attachment: Attachment): Promise<string> {
  let written = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    }),
    { columns: 100, rows: 30, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const body = h(AttachmentMessage as never, { attachment, addMargin: false, verbose: false })
  const instance = await render(
    h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(MessageMetaProvider as never, { message: { type: 'attachment', timestamp: '2026-06-19T12:00:07.000Z' } }, body)),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  instance.unmount?.()
  await settle(50)
  return strip(written).replace(/\s+/g, ' ')
}
{
  const olderRow: AttachmentRow = {
    type: 'attachment',
    uuid: '00000000-cccc-4000-8000-000000000001',
    timestamp: '2026-08-01T10:00:00.000Z',
    attachment: { type: 'hook_stopped_continuation', content: OLDER_STOP, hookName: `PreToolUse:${TOOL}`, toolUseID: 'toolu_older', hookEvent: 'PreToolUse' },
  }
  const decoded = decodeLine(recordLineOf(olderRow))
  const back = decoded.entries[0]?.attachment
  check('the older line folds on decode (the registry row keeps message optional for it)', decoded.invalid.length === 0 && back !== undefined && back.content === OLDER_STOP, j(decoded.invalid))
  const text = back === undefined ? '' : withoutEnvelope(wireText(back))
  check('the wire reader hands back the older row\'s reason', text.endsWith(`hook stopped continuation: ${OLDER_STOP}`), j(text))
  check('the persistence door keeps the older row', isLoggableMessage(olderRow as never) === true)
  const painted = await paint(olderRow.attachment)
  check('the transcript row paints the older row\'s reason', painted.includes(`stopped continuation: ${OLDER_STOP}`), painted.slice(0, 200))
  const typedRow: Attachment = { type: 'hook_stopped_continuation', message: PRE_STOP, hookName: `PreToolUse:${TOOL}`, toolUseID: 'toolu_typed', hookEvent: 'PreToolUse' }
  const paintedTyped = await paint(typedRow)
  check('the transcript row paints a typed row\'s reason', paintedTyped.includes(`stopped continuation: ${PRE_STOP}`), paintedTyped.slice(0, 200))
  check('a row with neither field reads as an empty reason, never a throw', thrown(() => wireText({ type: 'hook_stopped_continuation', hookName: 'h', toolUseID: 't', hookEvent: 'PreToolUse' })) === null)
}

section('§D the two tool-road producers hand the union\'s own shape to createAttachmentMessage: no cast on either kind')
{
  const KINDS = new Set(['hook_additional_context', 'hook_stopped_continuation'])
  const casts: string[] = []
  let literals = 0
  for (const rel of ['src/services/tools/toolHooks.ts', 'src/services/tools/toolExecution.ts']) {
    const full = join(ROOT, rel)
    const sf = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createAttachmentMessage' && node.arguments[0] !== undefined) {
        let inner: ts.Expression = node.arguments[0]
        let cast: string | null = null
        while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner)) {
          if (ts.isAsExpression(inner)) cast = inner.type.getText(sf)
          inner = inner.expression
        }
        if (ts.isObjectLiteralExpression(inner)) {
          const typeProperty = inner.properties.find(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'type')
          const kind = typeProperty !== undefined && ts.isPropertyAssignment(typeProperty) && ts.isStringLiteral(typeProperty.initializer) ? typeProperty.initializer.text : null
          if (kind !== null && KINDS.has(kind)) {
            literals++
            if (cast !== null) casts.push(`${kind} as ${cast} (${rel}:${sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1})`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  check('the five producer literals are found (three context, two stopped)', literals === 5, `${literals} literal(s)`)
  check('none sits under a cast', casts.length === 0, `${casts.length}: ${casts.join(', ')}`)
}

rmSync(home, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${failures === 0 ? `prove-hook-attachment-shapes: ALL LAWS HOLD (${checks} checks)` : `prove-hook-attachment-shapes: ${failures} FAILURE(S) of ${checks} checks`}`)
process.exit(failures === 0 ? 0 : 1)
