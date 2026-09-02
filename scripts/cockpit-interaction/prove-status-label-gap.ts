#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-status-label-gap.ts — the /status fact
//  column always keeps a gap between label and value (FC-127). The label
//  padded to a FIXED 12 cells with no separator: the two ruled provider
//  display names that are exactly 12 cells rendered as one run-on word
//  (Hugging Facenot logged in · /logins connects) and the 15-cell Custom
//  endpoint lost itself to an ellipsis. The column now derives from the
//  longest on-screen label plus one guaranteed separator cell.
//
//  Real mount: SettingsStatusView under staticRender with the ruled
//  provider labels among ordinary facts.
//
//  Run: ~/.bun/bin/bun run scripts/cockpit-interaction/prove-status-label-gap.ts
// ============================================================================
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'statgap-home-')))
process.env.NODE_ENV = 'test'
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { SettingsStatusView } = await import('../../src/components/mercury-ui/screens/SettingsStatusView.js')

// Four rows: the pane windows the fact list to ~4 rows at the static
// mount's default height, and every leg's row must stay inside it.
const facts = [
  { k: 'Version', v: '1.0.0' },
  { k: 'Hugging Face', v: 'not logged in · /logins connects' },
  { k: 'Local models', v: 'not logged in · /logins connects' },
  { k: 'Custom endpoint', v: 'not logged in · /logins connects' },
]
const frame = await renderToString(
  React.createElement(SettingsStatusView, {
    onClose: () => {},
    facts,
    mcp: [],
  } as never),
  120,
)

console.log('§1 the 12-cell ruled names keep their gap')
{
  check(
    "no run-on 'Hugging Facenot' anywhere in the frame",
    frame.includes('Hugging Face') && !frame.includes('Facenot'),
    frame.split('\n').find(l => l.includes('Hugging')) ?? '(no row)',
  )
  check(
    "'Local models' keeps its gap too",
    !frame.includes('modelsnot'),
    frame.split('\n').find(l => l.includes('Local')) ?? '(no row)',
  )
}

console.log('\n§2 the 15-cell ruled name renders WHOLE')
{
  check(
    "'Custom endpoint' is not truncated to an ellipsis",
    frame.includes('Custom endpoint') && !frame.includes('Custom endp…'),
    frame.split('\n').find(l => l.includes('Custom')) ?? '(no row)',
  )
}

console.log('\n§3 short labels still column-align with the long ones')
{
  const rowOf = (label: string): string => frame.split('\n').find(l => l.includes(label)) ?? ''
  const valueCol = (line: string, value: string): number => line.indexOf(value)
  const a = valueCol(rowOf('Version'), '1.0.0')
  const b = valueCol(rowOf('Hugging Face'), 'not logged in')
  check('the value column is one shared column', a > 0 && b > 0 && a === b, `Version@${a} vs HF@${b}`)
}

console.log(failures === 0 ? '\nprove-status-label-gap: all green' : `\nprove-status-label-gap: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
