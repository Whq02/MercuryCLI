#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILE_TOOL_SPELLINGS } from '../identity/forbidden-file-tool.ts'
import { argAfter, bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeWorld, ROOT, TURN_MS } from '../crew/crew-world.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const name = FILE_TOOL_SPELLINGS[0]
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const world = await makeWorld('file-courier-replay', [
  { kind: 'text', text: 'FRESH-DONE', model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: 'FRESH' },
  { kind: 'text', text: 'OLD-RESUMED', model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: 'RESUME-CHECK' },
] as ScriptedTurn[])
type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; input?: unknown; content?: unknown; is_error?: boolean }
type Request = { body: { tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: Block[] | string }> } }
const requests = (): Request[] => world.fixture.messageRequests() as Request[]
const toolNames = (request: Request | undefined): string[] => (request?.body.tools ?? []).map(tool => tool.name)
const json = (value: unknown): string => JSON.stringify(value)
try {
  const fresh = bootLead(world, [], ['Read'])
  try {
    fresh.submit('FRESH: say the word.')
    await fresh.waitFor('the fresh session never answered', () => fresh.stdout().includes('FRESH-DONE'), TURN_MS)
    const request = requests()[0]
    check('C1 a fresh request never offers the file courier', toolNames(request).length > 0 && !toolNames(request).includes(name))
    const bytes = json(request?.body.tools)
    const writePath = argAfter('--write-tools')
    if (writePath) writeFileSync(writePath, bytes)
    const comparePath = argAfter('--compare-tools')
    if (comparePath) check('C1 the fresh request tool definitions are byte-identical to the base recording', bytes === readFileSync(comparePath, 'utf8'), `${Buffer.byteLength(bytes)} bytes now; ${Buffer.byteLength(readFileSync(comparePath, 'utf8'))} bytes at base`)
  } finally {
    await fresh.end()
  }

  const { projectSlug } = await import('../../src/utils/sessionStoragePortable.ts')
  const sessionId = randomUUID()
  const cwd = realpathSync(world.project).normalize('NFC')
  const projectDir = join(world.config, 'projects', projectSlug(cwd))
  mkdirSync(projectDir, { recursive: true })
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
  const at = (offset: number): string => new Date(Date.now() - 60_000 + offset).toISOString()
  const callId = 'toolu_old_file'
  const input = { files: ['/proof/report.pdf'], status: 'normal', caption: 'the saved report' }
  const error = `<tool_use_error>No such tool available: ${name}. It is not in this session's tool list — call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).</tool_use_error>`
  type Row = Record<string, unknown>
  const rows: Row[] = []
  let ordinal = 0
  let parent: string | null = null
  const meta = (metaKind: string, fields: Row): void => {
    ordinal++
    rows.push({ schemaVersion: 1, recordId: randomUUID(), sessionId, threadId: 'main', creationOrdinal: String(ordinal), updateOrdinal: String(ordinal), occurredAt: at(ordinal * 10), actor: { role: 'system' }, source: { channel: 'sdk' }, payload: { kind: 'session-meta', metaKind, fields } })
  }
  const message = (actor: Row, payload: Row, annotations: Row): void => {
    ordinal++
    const id = randomUUID()
    rows.push({ schemaVersion: 1, recordId: id, sessionId, threadId: 'main', creationOrdinal: String(ordinal), updateOrdinal: String(ordinal), occurredAt: at(ordinal * 10), actor, source: { channel: 'sdk' }, payload, ...(parent === null ? {} : { parentId: parent }), annotations: { parentUuid: parent, isSidechain: false, uuid: id, timestamp: at(ordinal * 10), entrypoint: 'headless', cwd, sessionId, version, ...annotations } })
    parent = id
  }
  const usage = { inputTokens: 25, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  meta('mercury-transcript-header', { fileVersion: 1, format: 'mercury-records' })
  message({ role: 'operator' }, { kind: 'input', content: 'name the saved report', meta: { msgRest: { role: 'user' } } }, { permissionMode: 'default' })
  message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'tool-use', callId, name, input }], usage, outcome: { result: 'completed', stopReason: 'tool_use', stopSequence: null }, providerMessageId: 'msg_old_file_1' }, {})
  message({ role: 'operator' }, { kind: 'input', content: [{ kind: 'tool-result', callId, body: error, isError: true }], meta: { msgRest: { role: 'user' } } }, { toolUseResult: `Error: ${error}`, sourceToolAssistantUUID: parent })
  message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'text', text: 'The report is /proof/report.pdf.' }], usage, outcome: { result: 'completed', stopReason: 'end_turn', stopSequence: null }, providerMessageId: 'msg_old_file_2' }, {})
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), rows.map(json).join('\n') + '\n')
  const before = requests().length
  const resumed = bootLead(world, ['--resume', sessionId], ['Read'])
  try {
    resumed.submit('RESUME-CHECK: read the saved row and say the word.')
    await resumed.waitFor('the saved session never answered', () => resumed.stdout().includes('OLD-RESUMED'), TURN_MS)
    const request = requests()[before]
    const blocks = (request?.body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
    const call = blocks.find(block => block.type === 'tool_use' && block.id === callId)
    const result = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === callId)
    check('C2 resume preserves the saved call name, id and input byte for byte', call?.name === name && call?.id === callId && json(call?.input) === json(input), json(call))
    check('C2 resume preserves the saved error result byte for byte', result?.is_error === true && result?.tool_use_id === callId && result?.content === error, json(result))
    check('C2 the resumed request never offers the absent tool again', toolNames(request).length > 0 && !toolNames(request).includes(name))
    check('C2 the saved session answers on the current build', resumed.stdout().includes('OLD-RESUMED'))
  } finally {
    await resumed.end()
  }
} catch (error) {
  check('the fresh and saved session drives complete', false, error instanceof Error ? error.message : String(error))
} finally {
  await closeWorld(world)
}
console.log(failures === 0 ? 'file courier replay: ALL PASS' : `file courier replay: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
