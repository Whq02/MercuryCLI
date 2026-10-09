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
const POST_BLOCK = 'POST-BLOCK-SENTINEL'
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
function writeHooks(phase: 'context' | 'stop' | 'block'): void {
  const pre = phase === 'stop' ? { stop: PRE_STOP } : phase === 'block' ? {} : { context: PRE_CONTEXT }
  const post = phase === 'stop' ? { stop: POST_STOP } : phase === 'block' ? { block: POST_BLOCK } : { context: POST_CONTEXT }
  writeFileSync(
    join(home, 'settings.json'),
    j({
      events: {
        hooks: {
          'tool.before': [{ name: 'before', run: command(pre) }],
          'tool.after': [{ name: 'after', run: `read -r line; case "$line" in *'"ok":false'*) ${command({ context: FAIL_CONTEXT })};; *) ${command(post)};; esac` }],
        },
      },
    }),
  )
}
writeHooks('context')

const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { refreshHooksSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { isTranscribable } = await import('../../src/utils/sessionStorage/chain.ts')
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

section('§A the tool road hands a hook context row to the reader on every tool event')
{
  refreshHooksSnapshot()
  const contextRows = [...(await drive(false)), ...(await drive(true))].filter(r => r.attachment.type === 'hook' && r.attachment.outcome === 'context')
  const events = contextRows.map(r => `${r.attachment.event}:${r.attachment.words}`).sort()
  check('the before and after hooks each produce one context row per drive, the failed call carrying the failure context', j(events) === j([`tool.after:${FAIL_CONTEXT}`, `tool.after:${POST_CONTEXT}`, `tool.before:${PRE_CONTEXT}`, `tool.before:${PRE_CONTEXT}`]), j(events))
  for (const row of contextRows) {
    const att = row.attachment
    const sentinel = String(att.words)
    check(`${att.event}: the row names the hook, the event and the call`, att.name === (att.event === 'tool.before' ? 'before' : 'after') && att.callId === 'toolu_shapes', j(att))
    const issue = registryIssue(row)
    check(`${att.event}: the row validates against its registry row`, issue === null, issue ?? '')
    const readerThrow = thrown(() => wireText(att))
    check(`${att.event}: the wire reader never throws on the produced row`, readerThrow === null, readerThrow ?? '')
    check(`${att.event}: the wire text names the hook's context`, readerThrow === null && wireText(att).includes(sentinel), readerThrow ?? wireText(att).slice(0, 160))
    const doorThrow = thrown(() => isTranscribable(row as never))
    check(`${att.event}: the persistence door answers without throwing, and keeps the row`, doorThrow === null && isTranscribable(row as never) === true, doorThrow ?? 'not kept')
    const decoded = decodeLine(recordLineOf(row))
    check(`${att.event}: the persisted line folds on decode`, decoded.entries.length === 1 && decoded.invalid.length === 0, j(decoded.invalid))
  }
}

section('§B a stop answer rides as a hook row with outcome stop, the words in place')
{
  writeHooks('stop')
  refreshHooksSnapshot()
  const stopRows = (await drive(false)).filter(r => r.attachment.type === 'hook' && r.attachment.outcome === 'stop')
  const events = stopRows.map(r => r.attachment.event).sort()
  check('a before stop and an after stop each produce one row', j(events) === j(['tool.after', 'tool.before']), j(events))
  for (const row of stopRows) {
    const att = row.attachment
    const reason = att.event === 'tool.before' ? PRE_STOP : POST_STOP
    check(`${att.event}: words carry the hook's stop reason`, att.words === reason, `words=${j(att.words)}`)
    const issue = registryIssue(row)
    check(`${att.event}: the row validates against its registry row`, issue === null, issue ?? '')
    check(`${att.event}: the model reads nothing from a stop row (the turn ends; the operator sees the line)`, wireText(att) === '', j(wireText(att)))
    check(`${att.event}: the persistence door keeps the row`, isTranscribable(row as never) === true)
    const decoded = decodeLine(recordLineOf(row))
    const back = decoded.entries[0]?.attachment
    check(`${att.event}: the persisted line folds and its projection carries the words`, decoded.invalid.length === 0 && back !== undefined && back.words === reason, j(decoded.invalid))
  }
}

section('§C a tool.after block is the one hook row the model reads as an objection beside the result')
{
  writeHooks('block')
  refreshHooksSnapshot()
  const rows = await drive(false)
  const block = rows.find(r => r.attachment.type === 'hook' && r.attachment.outcome === 'block')
  check('the after block produces one row carrying the words', block !== undefined && block.attachment.event === 'tool.after' && block.attachment.words === POST_BLOCK, j(rows.map(r => r.attachment)))
  if (block) {
    const text = withoutEnvelope(wireText(block.attachment))
    check('the wire text names the hook and the objection', text.includes('after') && text.includes(POST_BLOCK), j(text))
    check('the row validates and persists', registryIssue(block) === null && isTranscribable(block as never) === true)
  }
  const plain = { type: 'hook', outcome: 'text', event: 'tool.after', name: 'after', words: 'plain words', callId: 'toolu_shapes' } as Attachment
  check('a plain-text row on tool.after reads nothing for the model and stays out of the file', wireText(plain) === '' && isTranscribable({ type: 'attachment', uuid: 'u', timestamp: 't', attachment: plain } as never) === false)
  check('a row with no words reads as an empty context, never a throw', thrown(() => wireText({ type: 'hook', outcome: 'context', event: 'tool.before', name: 'h', words: '' } as Attachment)) === null)
}

section('§D the tool road hands the one hook row shape to createAttachmentMessage through the rows writer: no cast, no hand-built literal')
{
  const casts: string[] = []
  let literals = 0
  let viaWriter = 0
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
          if (kind === 'hook') {
            literals++
            if (cast !== null) casts.push(`hook as ${cast} (${rel}:${sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1})`)
          }
        } else if (ts.isIdentifier(inner) && inner.text === 'row' && cast === null) {
          viaWriter++
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  check('no hand-built hook literal reaches createAttachmentMessage on the tool road', literals === 0, `${literals} literal(s)`)
  check('every hook row comes from the rows writer (hookRowsOfResult), uncast', viaWriter >= 3 && casts.length === 0, `${viaWriter} via the writer; casts: ${casts.join(', ')}`)
}

rmSync(home, { recursive: true, force: true })
clearTimeout(guard)
console.log(`\n${failures === 0 ? `prove-hook-attachment-shapes: ALL LAWS HOLD (${checks} checks)` : `prove-hook-attachment-shapes: ${failures} FAILURE(S) of ${checks} checks`}`)
process.exit(failures === 0 ? 0 : 1)
