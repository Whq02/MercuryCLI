#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { Connection } from 'puppeteer-core/internal/cdp/Connection.js'
import { check, finish, pageOf, requireBrowser, run, serve } from './harness.ts'

await requireBrowser()
process.env.MERCURY_MODEL = 'claude-opus-4-8'
const fixture = await serve(27292, (_req, res) => { res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><title>geometry</title><div style="height:2001px"></div>') })
await run({ op: 'open', url: fixture.origin })
const commands: string[] = []
const rawSend = Connection.prototype._rawSend
Connection.prototype._rawSend = function (this: Connection, ...args: Parameters<typeof rawSend>) { commands.push(args[1]); return rawSend.apply(this, args) } as typeof rawSend
const plain = await run({ op: 'screenshot', label: 'geometry-plain' })
check('a default capture sends only the capture command, as before emulation', JSON.stringify(commands) === '["Page.captureScreenshot"]', JSON.stringify(commands))
check('a default capture has no factor clause', !plain.result.includes('1 image px'), plain.result)
const evaluate = pageOf().evaluate.bind(pageOf())
const size = (result: string): [number, number] => { const data = readFileSync(/screenshot: (\S+\.png)/.exec(result)![1]!); return [data.readUInt32BE(16), data.readUInt32BE(20)] }
for (const scale of [2, 3]) {
  await run({ op: 'viewport', width: 600, height: 400, deviceScaleFactor: scale })
  const answer = await run({ op: 'screenshot', label: `geometry-${scale}` })
  check(`scale ${scale} uses six significant digits`, answer.result.endsWith(`1 image px = ${Number((1 / scale).toPrecision(6))} CSS px`), answer.result)
}
await run({ op: 'viewport', width: 601, height: 401, deviceScaleFactor: 3 })
const realViewport = pageOf().viewport.bind(pageOf())
pageOf().viewport = () => { const held = realViewport()!; return { width: held.width, height: held.height } }
const unrecorded = await run({ op: 'screenshot', label: 'geometry-unrecorded' })
check('when scale is unrecorded the capture supplies it without assuming one', size(unrecorded.result)[0] === 1803 && unrecorded.result.endsWith('1 image px = 0.333333 CSS px'), unrecorded.result)
pageOf().viewport = realViewport
const full = await run({ op: 'screenshot', fullPage: true, label: 'geometry-full' })
check('the full page retains its scale', full.outcome === 'succeeded' && full.result.includes('CSS px: 1 image px = 0.333333 CSS px'), full.result)
Connection.prototype._rawSend = rawSend
await finish('prove-browser-screenshot-geometry')
