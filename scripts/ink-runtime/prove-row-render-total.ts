#!/usr/bin/env bun
// prove-row-render-total — no message row can end the app (operator sighting
// OP-3: the Skill tool-result render crash). Three layers, each pinned:
//
//   1. SkillTool's result renderer handed BARE STRINGS to Byline; Byline
//      passed children through unwrapped; the string reached a Box and Ink's
//      text invariant threw at the APP ROOT — the session died on "Skill
//      loaded", and the poisoned stored row re-crashed the session on every
//      re-entry. Byline is now TOTAL: any non-element child is wrapped in
//      Text at the component, closing the class for every caller.
//   2. The success-row seam wraps the renderer's RETURNED TREE in the
//      row-scoped SentryErrorBoundary (the call-site try/catch only covered
//      the call): a bad row degrades to one errored line, never the app.
//   3. The boundary itself catches the raw invariant class.
//
//   §1 the operator's exact repro renders (both SkillTool branches).
//   §2 Byline is total over ReactNode.
//   §3 the boundary catches a bare-string-in-Box row.
//   §4 the success-row seam rides the boundary (call-shaped pin).
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import * as React from 'react'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'row-total-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { render } = await import('../../src/ink.ts')
const { Box, Text } = await import('../../src/ink.ts')
const { Byline } = await import('../../src/components/design-system/Byline.tsx')
const { SentryErrorBoundary } = await import('../../src/components/SentryErrorBoundary.tsx')
const SkillUI = await import('../../src/tools/SkillTool/UI.tsx')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

// A minimal write-stream stub the renderer can paint into.
const makeStdout = (): { stream: NodeJS.WriteStream; text: () => string } => {
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
  return { stream: emitter, text: () => buffer }
}

// Render a node; resolve {ok, output} instead of throwing — app-death IS the
// red condition under proof.
const tryRender = async (node: React.ReactNode): Promise<{ ok: boolean; output: string; error?: string }> => {
  const { stream, text } = makeStdout()
  try {
    const instance = await render(node, { stdout: stream })
    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()
    await instance.waitUntilExit().catch(() => {})
    // The fork's APP-ROOT screen ("RENDER ERROR … this view had to close")
    // is the in-product session death; a resolved render showing it is NOT
    // ok. The invariant's own message echoes the probe string, so content
    // needles alone are satisfiable by the crash text — always pair them
    // with this flag.
    const output = text()
    return { ok: !output.includes('RENDER ERROR'), output }
  } catch (error) {
    return { ok: false, output: text(), error: String(error).slice(0, 120) }
  }
}

section('§1 THE OPERATOR REPRO')
{
  const loaded = await tryRender(SkillUI.renderToolResultMessage({ status: 'ok' } as never))
  check('the "Skill loaded" row renders instead of the app-root crash screen', loaded.ok, loaded.error ?? JSON.stringify(loaded.output.slice(0, 80)))
  check('and the byline text paints', loaded.ok && loaded.output.includes('Skill loaded'), JSON.stringify(loaded.output.slice(0, 80)))
  const forked = await tryRender(SkillUI.renderToolResultMessage({ status: 'forked' } as never))
  check('the forked branch ("Done") renders too', forked.ok && forked.output.includes('Done'), forked.error)
}

section('§2 BYLINE IS TOTAL')
{
  const bare = await tryRender(
    React.createElement(Box, null, React.createElement(Byline, null, 'a bare string child')),
  )
  check('a bare string child renders (wrapped in Text at the component)', bare.ok, bare.error ?? JSON.stringify(bare.output.slice(0, 60)))
  check('and paints', bare.ok && bare.output.includes('a bare string child'))
  const mixed = await tryRender(
    React.createElement(
      Box,
      null,
      React.createElement(Byline, null, 'left', React.createElement(Text, null, 'right')),
    ),
  )
  check('mixed string+element children keep the middot separator law', mixed.ok && mixed.output.includes('·'), JSON.stringify(mixed.output.slice(0, 60)))
}

section('§3 THE ROW BOUNDARY')
{
  const caught = await tryRender(
    React.createElement(
      SentryErrorBoundary,
      null,
      React.createElement(Box, null, 'raw string straight into a Box'),
    ),
  )
  check('the boundary catches the raw invariant class (app survives)', caught.ok, caught.error)
  check(
    'and degrades to the one errored line',
    caught.output.includes('could not be rendered'),
    JSON.stringify(caught.output.slice(0, 100)),
  )
}

section('§4 THE SUCCESS-ROW SEAM')
{
  const row = readFileSync(
    join(import.meta.dir, '../../src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx'),
    'utf8',
  )
  check(
    'the rendered tree rides INSIDE the row boundary (call-shaped)',
    /<SentryErrorBoundary>\{rendered \?\? null\}<\/SentryErrorBoundary>/.test(row),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-row-render-total: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-row-render-total: all green')
