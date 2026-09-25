#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'sleep-row-frames-'))
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { SleepTool } = await import('../../src/tools/SleepTool/SleepTool.tsx')
const { clampWait } = await import('../../src/utils/waitCeiling.js')
const { HELM_BOTH_RAILS_MIN, railPlanAt } = await import('../../src/utils/helmGeometry.js')
const { LAYOUT_BREAKPOINTS } = await import('../../src/hooks/useLayoutTier.js')

let failures = 0
const check = (label: string, pass: boolean, detail = ''): void => {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const TOOL_USE_ID = 'toolu_sleep_row'
const SIZES = [
  [178, 51],
  [80, 21],
] as const
const CASES = [
  { seconds: 0, waited: 1, requested: '0s' },
  { seconds: 4000, waited: 3600, requested: '4000s' },
  { seconds: 30, waited: 30, requested: '30s' },
] as const

const transcriptWidth = (columns: number, rows: number): number =>
  columns >= LAYOUT_BREAKPOINTS.cockpitMin && rows >= LAYOUT_BREAKPOINTS.cockpitMinRows
    ? railPlanAt(columns, columns >= HELM_BOTH_RAILS_MIN).centerCols - 2
    : columns

const targetOf = (seconds: number, waited: number): string => {
  const wait = clampWait('seconds', seconds, 1, 3600, 's')
  return wait.clause === null ? `${waited}s` : `${waited}s · ${wait.clause}`
}

const asBefore = {
  ...SleepTool,
  renderToolUseMessage(input: { seconds?: unknown } | undefined): string {
    const s = input?.seconds
    return typeof s === 'number' ? `${Math.round(s)}s` : ''
  },
}

function lookupsFor(settled: boolean, waited: number): unknown {
  return {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: settled
      ? new Map([[TOOL_USE_ID, { toolUseResult: { message: `Slept for ${waited}s`, slept_seconds: waited, interrupted: false } }]])
      : new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 1,
    resolvedToolUseIDs: new Set(settled ? [TOOL_USE_ID] : []),
    erroredToolUseIDs: new Set(),
    deniedToolUseIDs: new Set(),
  }
}

async function paintRow(tool: unknown, seconds: number, waited: number, settled: boolean, columns: number): Promise<string> {
  const node = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(AssistantToolUseMessage as never, {
      param: { type: 'tool_use', id: TOOL_USE_ID, name: 'Sleep', input: { seconds } },
      tools: [tool],
      verbose: false,
      inProgressToolUseIDs: new Set(settled ? [] : [TOOL_USE_ID]),
      shouldAnimate: false,
      shouldShowDot: true,
      lookups: lookupsFor(settled, waited) as never,
    } as never),
  )
  return (await renderToAnsiString(node as never, columns)).replace(/\n$/, '')
}

const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

console.log('Sleep row — the label names the wait that really happens')
for (const [columns, rows] of SIZES) {
  const width = transcriptWidth(columns, rows)
  const label = `${columns}x${rows}`
  console.log(`\n${label} (transcript ${width} columns)`)
  const plainFrame: string[] = [`terminal ${label} · transcript ${width} columns`, '']
  const ansiFrame: string[] = [...plainFrame]
  for (const { seconds, waited, requested } of CASES) {
    const clamped = seconds !== waited
    const target = targetOf(seconds, waited)
    const activity = SleepTool.getActivityDescription({ seconds }) ?? ''
    for (const settled of [false, true]) {
      const state = settled ? 'settled' : 'pending'
      const raw = await paintRow(SleepTool, seconds, waited, settled, width)
      const plain = stripAnsi(raw)
      plainFrame.push(`Sleep ${seconds} · ${state}`, plain)
      ansiFrame.push(`Sleep ${seconds} · ${state}`, raw)
      const lines = plain.split('\n')
      check(`${label} Sleep ${seconds} ${state}: one row`, lines.length === 1, JSON.stringify(lines))
      check(`${label} Sleep ${seconds} ${state}: the row reads the ${waited} s wait${clamped ? ' and the clamp in the result\'s words' : ''}`,
        plain.includes(`Sleep`) && plain.endsWith(target), `row reads ${JSON.stringify(plain)}`)
      if (clamped) {
        check(`${label} Sleep ${seconds} ${state}: the requested ${requested} is not painted`, !plain.includes(requested), `row reads ${JSON.stringify(plain)}`)
      } else {
        const before = await paintRow(asBefore, seconds, waited, settled, width)
        check(`${label} Sleep ${seconds} ${state}: an unclamped row is byte-identical to the row before`, raw === before, `${JSON.stringify(stripAnsi(raw))} vs ${JSON.stringify(stripAnsi(before))}`)
      }
    }
    plainFrame.push(`Sleep ${seconds} · activity`, activity, '')
    ansiFrame.push(`Sleep ${seconds} · activity`, activity, '')
    check(`${label} Sleep ${seconds} activity: the spinner's words read the ${waited} s wait${clamped ? ' and the clamp' : ''}`,
      activity === `Sleeping for ${target}`, `activity reads ${JSON.stringify(activity)}`)
  }
  for (const line of plainFrame) console.log(`    ${line}`)
  if (frameDir) {
    writeFileSync(join(frameDir, `${label}.txt`), plainFrame.join('\n') + '\n')
    writeFileSync(join(frameDir, `${label}.ansi`), ansiFrame.join('\n') + '\n')
  }
}

console.log(`\nsleep row frames: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
