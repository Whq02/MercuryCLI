#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const app = { identity: 'com.example.Editor', name: 'Editor', pid: 123, windowId: 'editor', title: 'Document', bounds: { x: 0, y: 0, width: 400, height: 300 } }
const scene = join(scratchDir('sequence-lines'), 'scene.json')
writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 400, height: 300, scale: 2, primary: true }], frontmost: app, cursor: { x: 50, y: 50 }, lines: ['Editor proof'], tree: [{ role: 'AXButton', title: 'Save', frame: { x: 100, y: 80, width: 40, height: 20 } }] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
let controller = new AbortController()
let context = toolContext({ controller })
session.forgetDesktopOwner(ownerOf(context))
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`sequence-lines-${++serial}`, 'Computer', input) as never))
const target = { role: 'AXButton', name: 'Save' }
const keyTaps = () => driver.acts.filter(a => a.act === 'keyTap').length
const SKIPPED = 'screenshot step skipped (capture: false)'

section('a screenshot step under the sequence\'s capture: false leaves a line saying it was skipped, where the step stood')
{
  const keysBefore = keyTaps()
  const skipped = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'screenshot' }, { action: 'key', key: 'Enter' }], capture: false })
  const lines = skipped.result.split('\n')
  const clickAt = lines.findIndex(line => line.startsWith('click AXButton "Save"'))
  const skippedAt = lines.indexOf(SKIPPED)
  const keyAt = lines.findIndex(line => line.startsWith('key Enter'))
  check('the sequence completes image-free, the key step ran, and the skipped step says so', skipped.outcome === 'succeeded' && skipped.result.includes('sequence 3/3 completed') && skipped.imagePath === undefined && lines.includes(SKIPPED) && keyTaps() === keysBefore + 1, skipped.result)
  check("the skipped line stands between the click's line and the key's, where the step stood", clickAt >= 0 && skippedAt > clickAt && keyAt > skippedAt, `click ${clickAt} · skipped ${skippedAt} · key ${keyAt}\n${skipped.result}`)
  check('no capture was taken for the skipped step', !driver.acts.some(a => a.act === 'capture'), driver.acts.map(a => a.act).join(','))
  const taken = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'screenshot' }], capture: true })
  check('with capture on, the step takes its screenshot and no skipped line appears', taken.outcome === 'succeeded' && taken.imagePath !== undefined && !taken.result.includes(SKIPPED) && taken.result.includes('screenshot: '), taken.result)
}

session.forgetDesktopOwner(ownerOf(context))
finish('prove-computer-sequence-lines')
