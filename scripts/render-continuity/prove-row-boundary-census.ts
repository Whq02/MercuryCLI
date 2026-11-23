#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'row-boundary-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { Box, Text, render } = await import('../../src/screen/themedRenderer.ts')
const { renderMessageRow } = await import('../../src/screen/messages-list/row.tsx')
const { sessionMirrorView } = await import('../../src/screen/concourse/session-mirror/sessionMirrorView.tsx')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const tryRender = async (node: React.ReactNode): Promise<{ ok: boolean; output: string; error?: string }> => {
  const emitter = new EventEmitter() as NodeJS.WriteStream & EventEmitter
  let buffer = ''
  Object.assign(emitter, {
    columns: 100,
    rows: 40,
    isTTY: false,
    write(chunk: string | Uint8Array): boolean {
      buffer += String(chunk)
      return true
    },
  })
  try {
    const inst = await render(node, { stdout: emitter })
    await new Promise(resolve => setTimeout(resolve, 40))
    inst.unmount()
    await inst.waitUntilExit().catch(() => {})
    const clean = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    return { ok: !clean.includes('RENDER ERROR'), output: clean }
  } catch (error) {
    return { ok: false, output: buffer, error: String(error).slice(0, 160) }
  }
}

const poison = {
  uuid: 'poison-1',
  type: 'assistant',
  get message() {
    throw new Error('poisoned row')
  },
} as never

const lookups = {
  resolvedToolUseIDs: new Set<string>(),
  erroredToolUseIDs: new Set<string>(),
  toolResultsById: new Map(),
  toolUseById: new Map(),
} as never

const listRow = await tryRender(
  React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(() =>
      renderMessageRow({
        rows: [poison],
        msg_8: poison,
        index: 0,
        canAnimate: false,
        columns: 100,
        conversationId: 'conv-1' as never,
        cursor: null,
        expandedKeys: new Set(),
        expansionKeyOf: (m: { uuid: string }) => m.uuid,
        inProgressToolUseIDs: new Set(),
        isItemExpanded: () => false,
        isLoading: false,
        isTranscriptMode: false,
        lastThinkingBlockId: null,
        latestBashOutputUUID: null,
        lookups,
        screen: 'prompt' as never,
        streamingTail: null,
        streamingTextSuppressed: false,
        tools: [],
        verbose: false,
        withheldDisclosure: { byRow: new Map(), hidden: new Set() },
      }),
    ),
    React.createElement(Text, null, 'sibling-survived'),
  ),
)
t(
  'messagesList/row contains a throwing MessageRow inside RowErrorBoundary and keeps sibling output',
  listRow.ok && listRow.output.includes('could not be rendered') && listRow.output.includes('sibling-survived'),
  listRow.error ?? JSON.stringify(listRow.output.trim().slice(0, 160)),
)

const mirrorRow = await tryRender(
  React.createElement(() =>
    sessionMirrorView({
      t: {
        textPrimary: 'white',
        textSecondary: 'gray',
        textMuted: 'gray',
        textInstruction: 'cyan',
        failureText: 'red',
        success: 'green',
        info: 'blue',
      } as never,
      identityInk: 'white',
      fold: { shed: 0 } as never,
      classifyAttribution: () => null as never,
      tools: [] as never,
      derived: { collapsed: [poison], inProgress: new Set(), lookups } as never,
      turnLive: false,
      canAnimate: false,
      scrollRef: { current: null },
      away: false,
      jumpNewest: () => {},
      newSince: 0,
      receiptsNewestFirst: [],
      receiptPlan: null,
      hintVisible: false,
      noteView: undefined,
      noteText: null,
      clusterReserve: 20,
      titleShown: 'mirror-title',
      factsShown: '',
      nowShown: null,
      paneSize: { columns: 100, rows: 20 },
      paneRows: 20,
      paneWidth: 100,
      focused: false,
      onEnter: undefined,
      state: 'idle',
      bare: false,
      liveTailLine: null,
      idScope: 'mirror-1',
      receiptRowText: () => '',
    }),
  ),
)
t(
  'sessionMirrorView contains a throwing MessageRow inside RowErrorBoundary and keeps the mirror frame',
  mirrorRow.ok && mirrorRow.output.includes('could not be rendered') && mirrorRow.output.includes('mirror-title'),
  mirrorRow.error ?? JSON.stringify(mirrorRow.output.trim().slice(0, 160)),
)

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? 'ROW-BOUNDARY CENSUS: ALL PASS' : 'ROW-BOUNDARY CENSUS: RED')
process.exit(failures)
