#!/usr/bin/env bun
// ============================================================================
//  scripts/messages/prove-compact-boundary-row.ts — the compact-boundary row
//  paints on the DEFAULT path and speaks the fold's facts (FN-016 R13).
//
//  THE DEFECT: Message.tsx returned null for a compact_boundary record
//  whenever isFullscreenEnvEnabled() — which defaults TRUE — so on a stock
//  install the fold point was unmarked: every pre-fold message stays on
//  screen in fullscreen (the index>=boundary filter belongs to the inline
//  path), the receipt at the bottom says "Compacted" and the summary card
//  reads as a restatement of a conversation sitting immediately above it,
//  with no line separating what the model still holds from what it no
//  longer does. Operator-sighted live: "it says compacted but not what".
//
//   §1 the row renders through Message on the DEFAULT (fullscreen) path —
//      the defect pin — and on the inline path: BOTH modes, one row;
//   §2 the row speaks the fold's own facts: the trigger word (manual /
//      auto / overflow) and the folded token weight; an absent count does
//      not speak (never a fabricated number);
//   §3 the microcompact boundary keeps its deliberate null (micro folds
//      stay invisible — this row is the FULL fold's marker).
//
//  Run: ~/.bun/bin/bun run scripts/messages/prove-compact-boundary-row.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

// A scratch config home so the theme provider's config read stays off the
// operator's own (the face-prover boot shape: enableConfigs then render).
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'compact-row-home-'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/utils/staticRender.tsx'))
const { Message } = await import(join(ROOT, 'src/components/Message.tsx'))
const { createCompactBoundaryMessage, createMicrocompactBoundaryMessage } = await import(
  join(ROOT, 'src/utils/messages/systemMessages.ts')
)

const renderRow = async (msg: unknown): Promise<string> =>
  renderToString(
    React.createElement(Message as never, {
      message: msg,
      messages: [],
      tools: [],
      commands: [],
      verbose: false,
      addMargin: false,
      shouldAnimate: false,
      shouldShowDot: false,
      isTranscriptMode: false,
      isStatic: false,
      inProgressToolUseIDs: new Set<string>(),
      streamingToolUseIDs: new Set<string>(),
      progressMessagesForMessage: [],
      lookups: {
        recoveredStreamFaultUuids: new Set<string>(),
      },
      width: 100,
    } as never),
    100,
  )

section('§1 the row renders on BOTH paths — the fullscreen default included')
{
  const boundary = createCompactBoundaryMessage('manual', 45_000)
  const saved = process.env.MERCURY_FULLSCREEN
  process.env.MERCURY_FULLSCREEN = '1'
  try {
    const fullscreen = await renderRow(boundary)
    check(
      'THE DEFECT PIN: the fullscreen (default) path paints the boundary row',
      fullscreen.includes('Conversation compacted'),
      JSON.stringify(fullscreen.slice(0, 120)),
    )
    check('…with the history door named beside it', fullscreen.includes('for history'))
  } finally {
    if (saved === undefined) delete process.env.MERCURY_FULLSCREEN
    else process.env.MERCURY_FULLSCREEN = saved
  }
  const savedOff = process.env.MERCURY_FULLSCREEN
  process.env.MERCURY_FULLSCREEN = '0'
  try {
    const inline = await renderRow(boundary)
    check('the inline path keeps its row (unchanged)', inline.includes('Conversation compacted'))
  } finally {
    if (savedOff === undefined) delete process.env.MERCURY_FULLSCREEN
    else process.env.MERCURY_FULLSCREEN = savedOff
  }
}

section("§2 the row speaks the fold's own facts")
{
  const manual = await renderRow(createCompactBoundaryMessage('manual', 45_000))
  check('a manual fold: the plain head plus the folded weight', manual.includes('Conversation compacted') && manual.includes('folded') && manual.includes('tokens of history'), JSON.stringify(manual.slice(0, 160)))
  const auto = await renderRow(createCompactBoundaryMessage('auto', 128_000))
  check("the automatic threshold names itself ('Context compacted automatically')", auto.includes('Context compacted automatically'))
  const overflow = await renderRow(createCompactBoundaryMessage('overflow', 200_000))
  check("an overflowed request names the recovery ('Context overflowed — folded and retried')", overflow.includes('Context overflowed'))
  const countless = await renderRow(createCompactBoundaryMessage('manual', 0))
  check('an absent count does not speak (no fabricated number)', countless.includes('Conversation compacted') && !countless.includes('folded'), JSON.stringify(countless.slice(0, 160)))
}

section('§3 the microcompact boundary keeps its deliberate null')
{
  const micro = createMicrocompactBoundaryMessage('auto', 10_000, 4_000, [], [])
  const frame = await renderRow(micro)
  check('a micro fold paints nothing (this row is the FULL fold marker)', frame.trim() === '', JSON.stringify(frame.slice(0, 80)))
}

console.log(failures === 0 ? '\nprove-compact-boundary-row: ALL LAWS HOLD' : `\nprove-compact-boundary-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
