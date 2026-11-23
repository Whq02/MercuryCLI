import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SystemCompactBoundaryMessage } from '../../src/engine/message-shapes/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const resumed = process.argv[2] === '--resume'
const home = resumed ? process.argv[3]! : mkdtempSync(join(tmpdir(), 'fold-stretches-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'fixture-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const sessionId = resumed ? process.argv[4]! : randomUUID()
switchSession(sessionId as never)
const { getTranscriptPath } = await import('../../src/sessions/transcripts/paths.ts')
const { getProject, recordTranscript } = await import('../../src/sessions/transcripts/writer.ts')
const { decodeTranscriptBuffer } = await import('../../src/sessions/fabric/transcriptDecode.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { compactConversation, partialCompactConversation, buildPostCompactMessages } = await import('../../src/engine/compaction/foldConversation.ts')
const { buildFoldLedger, renderFoldLedger, withKeptLedgerRows } = await import('../../src/engine/compaction/foldLedger.ts')
const { foldReceipt } = await import('../../src/engine/compaction/foldReceipt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId, lane: 'main' })
const context = () => ({
  owner, abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(20), loadedNestedMemoryPaths: new Set(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
}) as never
const { historyLines } = await import('../../src/sessions/transcripts/historyParts.ts')
const boundaries = (): SystemCompactBoundaryMessage[] => {
  const out: SystemCompactBoundaryMessage[] = []
  for (const line of historyLines(getTranscriptPath())) {
    for (const row of decodeTranscriptBuffer<Message>(line).entries) if (row.type === 'system' && row.subtype === 'compact_boundary') out.push(row)
  }
  return out
}
const rounds = 12
function stretch(n: number): Message[] {
  return Array.from({ length: rounds }, (_, i) => {
    const id = `${n}-${i}`
    return [createUserMessage({ content: `Record ${id}.` }),
      createAssistantMessage({ content: [{ type: 'tool_use', name: 'Read', id, input: { file_path: `sample-${id}.ts` } }] }),
      createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: 'observed' }], toolUseResult: { file: { filePath: `sample-${id}.ts`, anchor: 'fa:0123456789ab' } } }),
      createAssistantMessage({ content: `Finished ${id}.` })]
  }).flat()
}
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'The sample files were read and the requested observations are complete. The next request can proceed.' })))
process.env.ANTHROPIC_BASE_URL = api.url
let failed = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log(`PASS ${label}`) } catch (e) { failed++; console.error(`FAIL ${label}: ${(e as Error).message}`) }
}
try {
  if (!resumed) {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/fold-ledger-v1.json', import.meta.url), 'utf8'))
    const marker = (uuid: string, ledger: NonNullable<SystemCompactBoundaryMessage['compactMetadata']['ledger']>): Message => ({ type: 'system', subtype: 'compact_boundary', uuid, compactMetadata: { ledger } } as Message)
    const legacy = fixture.ledger
    const input = (ledger: typeof legacy) => [marker('boundary-1', ledger), fixture.first[0], ...fixture.tail]
    const snapshot = JSON.stringify(legacy)
    const migrated = buildFoldLedger(input(legacy), owner, 2)
    check('a v1 ledger resumes into v2 without copying its closed witnesses or changing the old record', () => {
      assert.equal(migrated.version, 2)
      assert.deepEqual(migrated.sourceRecordIds, ['boundary-1', ...fixture.tail.map((row: Message) => row.uuid)])
      assert.equal(JSON.stringify(legacy), snapshot)
      assert.equal(renderFoldLedger(migrated), fixture.golden)
    })
    check('the uninterrupted model index matches the approved golden byte for byte', () => {
      const first = buildFoldLedger(fixture.first, owner, 1)
      const previous = first.version === 2 ? withKeptLedgerRows(first, [fixture.first[0]]) : first
      const second = buildFoldLedger(input(previous), owner, 2)
      assert.equal(renderFoldLedger(second), fixture.golden)
    })
    check('a kept steer and its later echo are one operator message across folds', () => {
      const ask = createUserMessage({ content: 'Keep this request once.' })
      const steer = { type: 'attachment', uuid: randomUUID(), attachment: { type: 'queued_command', prompt: ask.message.content, source_uuid: ask.uuid } } as Message
      const first = buildFoldLedger([steer], owner, 1)
      const saved = first.version === 2 ? withKeptLedgerRows(first, [steer]) : first
      const bridge = buildFoldLedger([marker('one', saved), steer], owner, 2)
      const next = bridge.version === 2 ? withKeptLedgerRows(bridge, [steer]) : bridge
      const last = buildFoldLedger([marker('two', next), steer, ask], owner, 3)
      assert.deepEqual(foldReceipt({ trigger: 'manual', preTokens: 100, ledger: last }).operator, { messages: 1, bytes: 23 })
    })
    check('pending and background calls survive a fold without results and close exactly once in a later boundary', () => {
      const bridge = buildFoldLedger([marker('bridge', legacy)], owner, 2)
      const final = buildFoldLedger([marker('final', bridge), ...fixture.tail], owner, 3)
      const after = buildFoldLedger([marker('after', final)], owner, 4)
      const receipts = (ledger: typeof final) => [...ledger.tools, ...(ledger.version === 2 ? ledger.carriedTools : [])]
      const a = receipts(final).find(t => t.id === 'running')!
      const b = receipts(final).find(t => t.id === 'late')!
      assert.deepEqual([a.outcome, a.resultId, a.rc, b.outcome, b.resultId], ['ok', 'result-4', 0, 'error', 'result-5'])
      const closed = [bridge, final, after].flatMap(receipts).filter(t => ['running', 'late'].includes(t.id) && ['ok', 'error'].includes(t.outcome))
      assert.deepEqual(closed.map(t => t.id).sort(), ['late', 'running'])
      const idx = JSON.parse(renderFoldLedger(after).split('\n\n')[1]!)
      assert.deepEqual([idx.witnessesInBoundary.deniedFilePaths, idx.witnessesInBoundary.argumentHashes], [2, 5])
    })
  }
  let history: Message[] = resumed ? [boundaries().at(-1)!] : []
  const seen = new Set<string>()
  const counts: number[] = []
  for (const n of resumed ? [7] : [1, 2, 3, 4, 5, 6]) {
    history.push(...stretch(n))
    for (const row of history) seen.add(row.uuid)
    counts.push(seen.size)
    await recordTranscript(history)
    const ctx = context()
    const result = await compactConversation(history, ctx, { systemPrompt: ['fixture'] as never, userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: [] }, true)
    history = buildPostCompactMessages(result)
    await recordTranscript(history)
    await getProject().flush()
  }
  const rows = boundaries()
  assert.equal(rows.length, resumed ? 7 : 6)
  const ledgers = rows.map(row => row.compactMetadata.ledger!)
  const indexes = ledgers.map(ledger => JSON.parse(renderFoldLedger(ledger).split('\n\n')[1]!))
  if (resumed) {
    const last = indexes.at(-1)
    console.log(`fresh process: epoch ${last.epoch}, this stretch ${last.stretch.tools} tools, ${last.operator.messages} asks, ${last.stretch.files} files`)
    assert.equal(last.epoch, indexes[0].epoch)
    assert.deepEqual([last.stretch.tools, last.operator.messages, last.stretch.files, last.earlierFolds.tools], [rounds, rounds, rounds, 6 * rounds])
  } else {
    const sizes = ledgers.map(ledger => Buffer.byteLength(JSON.stringify(ledger)))
    const ids = new Set(rows.map(row => row.uuid))
    const lines: string[] = []
    for (const bytes of historyLines(getTranscriptPath())) {
      const line = bytes.toString('utf8').trimEnd()
      if (ids.has(JSON.parse(line).recordId)) lines.push(line)
    }
    assert.equal(lines.length, rows.length)
    console.log(`durable boundary ledger bytes: ${sizes.join(', ')}; JSONL record bytes with newline: ${lines.map(line => Buffer.byteLength(line) + 1).join(', ')}`)
    check('six equally sized stretches do not store earlier stretches again', () => {
      assert.ok(Math.max(...sizes.slice(1)) < 1.15 * sizes[1]!, `folds 2 through 6: ${sizes.slice(1)}`)
      assert.equal(new Set(ledgers.flatMap(l => l.sourceRecordIds)).size, ledgers.reduce((n, l) => n + l.sourceRecordIds.length, 0))
    })
    check('every boundary reports the cumulative witnesses and preserves them across the file once', () => {
      for (const [i, idx] of indexes.entries()) {
        const n = (i + 1) * rounds
        assert.deepEqual(idx.witnessesInBoundary, { sourceIds: counts[i], operatorHashes: n, argumentHashes: n, deniedFilePaths: 0 })
        assert.deepEqual([idx.earlierFolds.records, idx.earlierFolds.tools, idx.earlierFolds.files, idx.earlierFolds.operatorMessages], [counts[i - 1] ?? 0, n - rounds, n - rounds, n - rounds])
        assert.deepEqual(foldReceipt(rows[i]!.compactMetadata).operator, { messages: n, bytes: Buffer.byteLength(Array.from({ length: i + 1 }, (_, j) => Array.from({ length: rounds }, (_, k) => `Record ${j + 1}-${k}.`).join('')).join('')) })
      }
      assert.equal(ledgers.flatMap(l => l.tools).length, rounds * ledgers.length)
    })
    for (const direction of ['from', 'up_to'] as const) {
      const input = stretch(8)
      const ctx = context()
      const partial = await partialCompactConversation(input, 12, ctx, { systemPrompt: ['fixture'] as never, userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: [] }, undefined, direction)
      check(`the partial ${direction} boundary carries only the actual kept row identities`, () => {
        const ledger = partial.boundaryMarker.compactMetadata.ledger!
        assert.equal(ledger.version, 2)
        assert.deepEqual(ledger.keptRecordIds, partial.messagesToKeep!.map(row => row.uuid))
        const next = buildFoldLedger([partial.boundaryMarker, ...partial.messagesToKeep!], owner, 8)
        assert.deepEqual(next.sourceRecordIds, [partial.boundaryMarker.uuid])
      })
    }
    check('first fold after a real process restart counts only the new stretch', () => {
      const child = spawnSync(process.execPath, [process.argv[1]!, '--resume', home, sessionId], { encoding: 'utf8' })
      console.log(child.stdout.trim())
      assert.equal(child.status, 0, child.stderr)
    })
  }
} finally {
  await api.close()
  if (!resumed) rmSync(home, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
