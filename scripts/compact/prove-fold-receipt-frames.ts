#!/usr/bin/env bun
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { CompactBoundaryMessage } = await import('../../src/components/messages/CompactBoundaryMessage.js')
const { SystemTextMessage } = await import('../../src/components/messages/SystemTextMessage.js')
const { createSystemMessage } = await import('../../src/utils/messages/systemMessages.js')
const { overflowRecoveryNotice } = await import('../../src/services/compact/overflowRecovery.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const { formatTokens } = await import('../../src/utils/format.js')
import type { CompactMetadata } from '../../src/types/message.js'

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const pointerId = 'pending:2026-10-16T01:02:03.004Z'
const ledger = { version: 1, epoch: 2, sourceRecordIds: ['a', 'b'], sourceDigest: 'd', operator: [{ sourceId: 'a', bytes: 120, sha256: 'x' }, { sourceId: 'b', bytes: 80, sha256: 'y' }], tools: [], files: [], run: null, openAsks: [] } as unknown as NonNullable<CompactMetadata['ledger']>
const committed = { version: 1, epoch: 2, sessionOrdinal: 3, sourceRange: { firstRecordId: 'a', lastRecordId: 'b', firstTurn: 1, lastTurn: 15 }, contentWitness: { algorithm: 'sha256', digest: 'f'.repeat(64) }, item: { content: 'c', context: 'x', topic: 'project' }, state: 'committed', pointer: { id: pointerId, title: 'pending · project', kind: 'fact', footnotes: {} } } as unknown as NonNullable<CompactMetadata['memory']>
const off = { ...committed, state: 'failed', reason: 'memory is off — nothing was stored' } as unknown as NonNullable<CompactMetadata['memory']>
delete (off as unknown as Record<string, unknown>).pointer
const landing = { input: 57_900 }

type Row = { label: string; meta: CompactMetadata; landing?: { input: number } | null; expect: string[]; absent?: string[] }
const rows: Row[] = [
  { label: 'success', meta: { trigger: 'auto', preTokens: 180_000, postTokens: 58_200, ledger, memory: committed, recentRounds: { requested: 10, kept: 10, tokens: 200_000, reason: 'requested-rounds-fit' } }, expect: ['Context compacted automatically', 'last 10 rounds kept whole', '2 operator messages kept whole', `1 fact moved to memory [${pointerId}]`, 'nothing pruned', `${formatTokens(180_000)} → ${formatTokens(58_200)} tokens (estimate)`] },
  { label: 'landed', meta: { trigger: 'auto', preTokens: 180_000, postTokens: 58_200, ledger, memory: committed, recentRounds: { requested: 10, kept: 10, tokens: 200_000, reason: 'requested-rounds-fit' } }, landing, expect: [`${formatTokens(180_000)} → ${formatTokens(57_900)} tokens (provider)`], absent: ['(estimate)'] },
  { label: 'partial', meta: { trigger: 'auto', preTokens: 990_000, postTokens: 120_000, ledger, memory: committed, recentRounds: { requested: 10, kept: 4, tokens: 90_000, reason: 'request-budget' } }, expect: ['last 4 of 10 rounds kept whole (the request budget)'] },
  { label: 'memory-off', meta: { trigger: 'manual', preTokens: 180_000, postTokens: 58_200, ledger, memory: off, recentRounds: { requested: 10, kept: 10, tokens: 200_000, reason: 'requested-rounds-fit' } }, expect: ['Conversation compacted', 'nothing moved to memory (memory is off — nothing was stored)'], absent: ['fact moved'] },
  { label: 'overflow', meta: { trigger: 'overflow', preTokens: 1_047_974, postTokens: 97_845, ledger, memory: committed, overflow: { source: 'estimate', family: 'unknown', shape: 'estimate', actualTokens: 1_047_974, limitTokens: 1_025_576 } as never, recentRounds: { requested: 10, kept: 10, tokens: 203_976, reason: 'requested-rounds-fit' } }, expect: ['Context overflowed (estimated 1,047,974 tokens > 1,025,576) — folded and retried', 'nothing pruned'] },
  { label: 'older-record', meta: { trigger: 'auto', preTokens: 180_000 }, expect: ['Context compacted automatically', `folded ${formatTokens(180_000)} tokens of history`], absent: ['pruned', 'memory', 'rounds'] },
]
const pruneNotice = overflowRecoveryNotice({ source: 'estimate', family: 'unknown', shape: 'estimate', actualTokens: 1_047_974, limitTokens: 1_025_576 } as never, 'prune', { cleared: 154, tokensSaved: 740_942 })

async function mount(columns: number, terminalRows: number): Promise<string[]> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: terminalRows }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const children = [
    ...rows.map(row => React.createElement(CompactBoundaryMessage, { key: row.label, message: { compactMetadata: row.meta }, landing: row.landing ?? null })),
    React.createElement(SystemTextMessage, { key: 'prune', message: createSystemMessage(pruneNotice, 'warning') as never, addMargin: true }),
  ]
  const node = React.createElement(TerminalSizeContext.Provider, { value: { columns, rows: terminalRows } },
    React.createElement(Box, { flexDirection: 'column', width: columns }, ...children))
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frame.split('\n')
}

const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

for (const [columns, terminalRows] of [[178, 51], [80, 24]] as const) {
  const label = `${columns}x${terminalRows}`
  const lines = await mount(columns, terminalRows)
  if (frameDir) writeFileSync(join(frameDir, `${label}.txt`), lines.join('\n') + '\n')
  console.log(`\n${label}:`)
  for (const line of lines) console.log(line)
  console.log('')
  const joined = lines.map(line => line.trim()).join(' ').replace(/\s+/g, ' ')
  check(`${label}: the frame paints without a render error`, !lines.some(line => line.includes('RENDER ERROR')))
  check(`${label}: no row is wider than the screen`, lines.every(line => stringWidth(line) <= columns), String(Math.max(...lines.map(line => stringWidth(line)))))
  const starts = lines.filter(line => line.trimStart().startsWith('✻ ')).length
  check(`${label}: every boundary row paints once (${rows.length} rows)`, starts === rows.length, String(starts))
  const segments = joined.split('✻ ').slice(1).map(segment => segment.split('▲ ')[0] ?? '')
  rows.forEach((row, index) => {
    const segment = segments[index] ?? ''
    for (const needle of row.expect) check(`${label} ${row.label}: says "${needle}"`, segment.includes(needle), segment.slice(0, 220))
    for (const needle of row.absent ?? []) check(`${label} ${row.label}: never says "${needle}"`, !segment.includes(needle), segment.slice(0, 220))
  })
  const prune = joined.split('▲ ').at(-1) ?? ''
  check(`${label} emergency prune: the notice says 154 bodies were pruned`, prune.includes('pruned 154 superseded tool-result bodies'), prune.slice(-300))
  check(`${label} emergency prune: it identifies Mercury's gross estimate`, prune.includes("about 740,942 tokens by Mercury's estimate, net of placeholders"))
  check(`${label} emergency prune: it asserts no summary and no memory move`, prune.includes('no summary written, nothing moved to memory'))
  check(`${label}: the context-size prune line the owner saw never paints`, !joined.includes('context size (estimated') && !joined.includes('prune threshold'))
}

console.log(`\nfold receipt frames: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
