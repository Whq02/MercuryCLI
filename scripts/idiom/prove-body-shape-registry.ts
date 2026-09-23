#!/usr/bin/env bun
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { BODY_SHAPE_KINDS, bodyShapeIssue, validateRecord } = await import('../../src/fabric/validate.js')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const { ordinalOf } = await import('../../src/fabric/ordinal.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}

const ctx = () => {
  let n = 0
  return {
    sessionId: '00000000-aaaa-4000-8000-000000000001' as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-08-03T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
}
let uuidN = 0
const uuid = (): string => `00000000-bbbb-4000-8000-${String(++uuidN).padStart(12, '0')}`
const attachmentLine = (type: string, fields: Record<string, unknown>): string =>
  JSON.stringify(entryToRecord({ type: 'attachment', uuid: uuid(), timestamp: '2026-08-01T10:00:00.000Z', attachment: { type, ...fields } } as never, ctx() as never))
const noticeLine = (subtype: string, fields: Record<string, unknown>): string =>
  JSON.stringify(entryToRecord({ type: 'system', subtype, uuid: uuid(), timestamp: '2026-08-01T10:00:00.000Z', ...fields } as never, ctx() as never))
type Decoded = { entries: unknown[]; invalid: Array<{ index: number; kind: string; reason: string }>; malformed: unknown[]; totalLines: number }
const decode = (lines: string[]): Decoded => decodeTranscriptBuffer<unknown>(lines.join('\n') + '\n') as Decoded

type Fixture = { good: Record<string, unknown>; bad: Array<{ label: string; field: string; fields: Record<string, unknown> }> }

const ATTACHMENTS: Record<string, Fixture> = {
  task_reminder: {
    good: { content: [{ id: '1', status: 'pending', subject: 's' }], itemCount: 1 },
    bad: [
      { label: 'content is a number', field: 'content', fields: { content: 5, itemCount: 1 } },
      { label: 'content holds a null row', field: 'content', fields: { content: [null], itemCount: 1 } },
    ],
  },
  diagnostics: {
    good: { files: [{ uri: 'file:///a.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm', severity: 1 }] }], isNew: true },
    bad: [
      { label: 'the file list is missing', field: 'files', fields: { isNew: true } },
      { label: 'a file without its diagnostics list', field: 'diagnostics', fields: { files: [{ uri: 'file:///a.ts' }], isNew: true } },
      { label: 'a diagnostic without its range', field: 'range', fields: { files: [{ uri: 'file:///a.ts', diagnostics: [{ message: 'm' }] }], isNew: true } },
    ],
  },
  invoked_skills: { good: { skills: [{ name: 'n', path: 'p', content: 'c' }] }, bad: [{ label: 'skills is text', field: 'skills', fields: { skills: 'n' } }] },
  relevant_memories: { good: { memories: [{ path: 'p', content: 'c', mtimeMs: 1 }] }, bad: [{ label: 'memories is null', field: 'memories', fields: { memories: null } }] },
  nested_memory: { good: { content: { path: 'p', content: 'c' } }, bad: [{ label: 'content is text', field: 'content', fields: { content: 'c' } }] },
  selected_lines_in_ide: {
    good: { ideName: 'x', lineStart: 1, lineEnd: 2, filename: 'f', content: 'text', displayPath: 'f' },
    bad: [{ label: 'content is a list', field: 'content', fields: { ideName: 'x', lineStart: 1, lineEnd: 2, filename: 'f', content: ['t'], displayPath: 'f' } }],
  },
  queued_command: {
    good: { prompt: 'hello' },
    bad: [
      { label: 'a block list holding a null block', field: 'prompt', fields: { prompt: [null] } },
      { label: 'prompt is a bare object', field: 'prompt', fields: { prompt: { text: 'x' } } },
    ],
  },
  teammate_mailbox: {
    good: { messages: [{ from: 'a', text: 't', timestamp: 'now' }] },
    bad: [
      { label: 'messages is text', field: 'messages', fields: { messages: 't' } },
      { label: 'a message without its text', field: 'text', fields: { messages: [{ from: 'a' }] } },
    ],
  },
  agent_roster: {
    good: { rows: [{ taskType: 'local_agent', name: 'n', taskId: 'i', status: 'running', address: null, agents: [{ label: 'l', state: 's' }] }] },
    bad: [
      { label: 'rows is text', field: 'rows', fields: { rows: 'r' } },
      { label: 'a row whose agents is text', field: 'agents', fields: { rows: [{ taskType: 't', name: 'n', taskId: 'i', status: 's', address: null, agents: 'x' }] } },
    ],
  },
  hook_additional_context: {
    good: { content: ['ctx'], hookName: 'h', toolUseID: 't', hookEvent: 'PostToolUse' },
    bad: [{ label: 'content is text', field: 'content', fields: { content: 'ctx', hookName: 'h', toolUseID: 't', hookEvent: 'PostToolUse' } }],
  },
  hook_blocking_error: {
    good: { hookName: 'h', blockingError: { command: 'c', blockingError: 'e' }, toolUseID: 't', hookEvent: 'PreToolUse' },
    bad: [{ label: 'blockingError is text', field: 'blockingError', fields: { hookName: 'h', blockingError: 'e', toolUseID: 't', hookEvent: 'PreToolUse' } }],
  },
  deferred_tools_delta: {
    good: { addedNames: [], addedLines: ['a'], removedNames: [], body: 'b' },
    bad: [
      { label: 'addedLines is text', field: 'addedLines', fields: { addedNames: [], addedLines: 'a', removedNames: [] } },
      { label: 'removedNames is a number', field: 'removedNames', fields: { addedNames: [], addedLines: [], removedNames: 5 } },
      { label: 'addedNames carries a number', field: 'addedNames', fields: { addedNames: [7], addedLines: [], removedNames: [] } },
      { label: 'body is an object', field: 'body', fields: { addedNames: [], addedLines: [], removedNames: [], body: {} } },
    ],
  },
  held_tools: {
    good: { names: ['Read'], body: 'b' },
    bad: [
      { label: 'names is text', field: 'names', fields: { names: 'Read', body: 'b' } },
      { label: 'body is missing', field: 'body', fields: { names: ['Read'] } },
    ],
  },
  agent_listing_delta: {
    good: { addedTypes: [], addedLines: ['a'], removedTypes: [], isInitial: true, showConcurrencyNote: false },
    bad: [{ label: 'removedTypes is null', field: 'removedTypes', fields: { addedTypes: [], addedLines: [], removedTypes: null, isInitial: true, showConcurrencyNote: false } }],
  },
  mcp_instructions_delta: {
    good: { addedNames: [], addedBlocks: ['b'], removedNames: [] },
    bad: [{ label: 'addedBlocks is an object', field: 'addedBlocks', fields: { addedNames: [], addedBlocks: {}, removedNames: [] } }],
  },
  harness_map_delta: { good: { added: ['a'], removed: [] }, bad: [{ label: 'added is text', field: 'added', fields: { added: 'a', removed: [] } }] },
}

const NOTICES: Record<string, Fixture> = {
  stop_hook_summary: {
    good: { hookCount: 1, hookInfos: [{ command: 'c', durationMs: 1 }], hookErrors: [], preventedContinuation: false, hasOutput: false, level: 'info' },
    bad: [
      { label: 'hookInfos is text', field: 'hookInfos', fields: { hookCount: 'many', hookInfos: 'x', hookErrors: [], preventedContinuation: false, hasOutput: false, level: 'info' } },
      { label: 'hookErrors is a number', field: 'hookErrors', fields: { hookCount: 1, hookInfos: [], hookErrors: 5, preventedContinuation: false, hasOutput: false, level: 'info' } },
    ],
  },
  memory_saved: {
    good: { writtenPaths: ['a/b.md'] },
    bad: [
      { label: 'writtenPaths is text', field: 'writtenPaths', fields: { writtenPaths: 'a/b.md' } },
      { label: 'a path that is a number', field: 'writtenPaths', fields: { writtenPaths: [5] } },
    ],
  },
  permission_retry: { good: { commands: ['ls'] }, bad: [{ label: 'commands is text', field: 'commands', fields: { commands: 'ls' } }] },
}

section('§A the registry and the fixtures name the same kinds, both ways')
const sorted = (xs: readonly string[]): string => [...xs].sort().join(',')
check('every registered attachment kind has a fixture and every fixture is registered', sorted(BODY_SHAPE_KINDS.attachment) === sorted(Object.keys(ATTACHMENTS)), `${sorted(BODY_SHAPE_KINDS.attachment)} vs ${sorted(Object.keys(ATTACHMENTS))}`)
check('every registered notice kind has a fixture and every fixture is registered', sorted(BODY_SHAPE_KINDS.notice) === sorted(Object.keys(NOTICES)), `${sorted(BODY_SHAPE_KINDS.notice)} vs ${sorted(Object.keys(NOTICES))}`)

section('§B per kind: a well-formed body folds; a body that fails its shape is thinned and named with the kind and the field')
const goodLines: string[] = []
const badLines: string[] = []
for (const [family, fixtures, line] of [
  ['attachment', ATTACHMENTS, attachmentLine],
  ['notice', NOTICES, noticeLine],
] as const) {
  for (const [kind, fixture] of Object.entries(fixtures)) {
    const good = line(kind, fixture.good)
    goodLines.push(good)
    const g = decode([good])
    check(`${family} ${kind}: the well-formed body folds`, g.entries.length === 1 && g.invalid.length === 0, JSON.stringify(g.invalid))
    for (const bad of fixture.bad) {
      const b = line(kind, bad.fields)
      badLines.push(b)
      const d = decode([b])
      const first = d.invalid[0]
      check(
        `${family} ${kind}: ${bad.label} is thinned and named`,
        d.entries.length === 0 && d.invalid.length === 1 && first?.kind === 'body-invalid' && first.reason.includes(`${family} ${kind}`) && first.reason.includes(bad.field),
        JSON.stringify(d.invalid),
      )
    }
  }
}

section('§C the retention law: an unregistered kind folds whatever its body; a registered kind keeps fields the shape does not name')
{
  const unknownAttachment = decode([attachmentLine('never_seen_kind', { content: 5, files: 'x' })])
  check('an unregistered attachment kind with a strange body folds', unknownAttachment.entries.length === 1 && unknownAttachment.invalid.length === 0, JSON.stringify(unknownAttachment.invalid))
  const unknownNotice = decode([noticeLine('never_seen_notice', { hookInfos: 'x', writtenPaths: 5 })])
  check('an unregistered notice kind with a strange body folds', unknownNotice.entries.length === 1 && unknownNotice.invalid.length === 0, JSON.stringify(unknownNotice.invalid))
  const extra = decode([attachmentLine('task_reminder', { content: [], itemCount: 0, laterField: { anything: true } })])
  check('a registered kind with an extra field the shape does not name folds', extra.entries.length === 1 && extra.invalid.length === 0, JSON.stringify(extra.invalid))
  const projected = extra.entries[0] as { attachment?: { laterField?: unknown } }
  check('and the extra field reaches the entry as it was', JSON.stringify(projected.attachment?.laterField) === '{"anything":true}', JSON.stringify(projected))
}

section('§D a whole buffer keeps its accounting: every line is an entry or a named invalid, nothing vanishes')
{
  const all = decode([...goodLines, ...badLines])
  check(
    'entries + invalid == the input lines, goods folded, bads thinned',
    all.entries.length === goodLines.length && all.invalid.length === badLines.length && all.malformed.length === 0 && all.totalLines === goodLines.length + badLines.length,
    `entries=${all.entries.length} invalid=${all.invalid.length} malformed=${all.malformed.length} total=${all.totalLines}`,
  )
  check('every invalid carries the body-invalid kind', all.invalid.every(i => i.kind === 'body-invalid'))
}

section('§E the issue reader answers null for a record that has no body of a registered kind')
{
  const input = validateRecord(JSON.parse(JSON.stringify(entryToRecord({ type: 'user', uuid: uuid(), timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'x' } } as never, ctx() as never))))
  check('an input record has no body issue', input.ok && bodyShapeIssue(input.record) === null)
  const good = validateRecord(JSON.parse(attachmentLine('diagnostics', ATTACHMENTS.diagnostics!.good)))
  check('a well-formed diagnostics body has no issue', good.ok && bodyShapeIssue(good.record) === null)
  const bad = validateRecord(JSON.parse(attachmentLine('diagnostics', { files: 'x', isNew: true })))
  const issue = bad.ok ? bodyShapeIssue(bad.record) : null
  check('a malformed diagnostics body names the kind and the field on its path', issue !== null && issue.path === 'attachment diagnostics.files', JSON.stringify(issue))
}

console.log(`\n${failures === 0 ? 'prove-body-shape-registry: ALL LAWS HOLD' : `prove-body-shape-registry: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
