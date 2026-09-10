#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback,
  printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

const gridSchema = z.array(z.array(z.object({ c: z.string() })).min(1)).min(1)
const artifactSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  grid: gridSchema,
  endReason: z.string(),
  marks: z.array(z.object({ label: z.string(), grid: gridSchema, cursor: z.object({ x: z.number(), y: z.number() }).optional() })).optional(),
})
const driver = requireCaptureDriver('compact-journey')
const results: Array<{ mainRequests: number; words: string[] }> = []
console.log(`compact journey artifacts: ${scratch}`)
for (const twin of [false, true]) {
  const tag = twin ? 'compact-twin' : 'compact-journey'
  const leg = await startLeg(tag, [
    { kind: 'paced', deltas: Array.from({ length: 240 }, (_, i) => `compact-stream-${String(i).padStart(3, '0')}\n`), gapMs: 250 },
    { kind: 'text', text: 'Queued words delivered.' },
    { kind: 'text', text: 'Finished.' },
  ], null)
  const out = join(scratch, `${tag}.json`)
  const log = join(scratch, `${tag}-engine.log`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const sends = [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 100, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'draft-alpha' },
    { atTick: 999, awaitText: 'draft-alpha', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'wide' },
    { afterPrevTicks: 6, data: ' bravo' },
    { atTick: 999, awaitText: 'draft-alpha bravo', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u0015stream the compact journey\r', mark: 'typed' },
    { atTick: 999, awaitText: 'compact-stream-003', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'streaming' },
    { afterPrevTicks: 5, data: 'queued while streaming\r' },
    { afterPrevTicks: 3, data: '\u001b', mark: 'queued' },
    { atTick: 999, awaitText: 'interrupted', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'keep-this-draft', mark: 'interrupted' },
    { atTick: 999, awaitText: 'keep-this-draft', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u0014\r', mark: 'before-detail' },
    { atTick: 999, awaitText: 'Session statistics', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'detail' },
    { afterPrevTicks: 6, data: '\u001b', mark: 'small-detail' },
    { atTick: 999, awaitText: 'keep-this-draft', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'closed' },
    { afterPrevTicks: 6, data: 'z', mark: 'tiny' },
    { atTick: 999, awaitText: 'keep-this-draftz', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u001b[5~', mark: 'compact-restored' },
    { afterPrevTicks: 4, data: '', mark: 'scrolled' },
    { afterPrevTicks: 8, data: '', mark: 'full-restored' },
  ]
  const resizes = twin ? [] : [
    { afterMark: 'wide', afterMs: 300, cols: 80, rows: 24 },
    { afterMark: 'streaming', afterMs: 300, cols: 60, rows: 16 },
    { afterMark: 'detail', afterMs: 300, cols: 40, rows: 10 },
    { afterMark: 'closed', afterMs: 300, cols: 1, rows: 1 },
    { afterMark: 'tiny', afterMs: 400, cols: 80, rows: 24 },
    { afterMark: 'scrolled', afterMs: 300, cols: 120, rows: 40 },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, '--chat'], cwd: ROOT, cols: twin ? 80 : 120, rows: twin ? 24 : 40, sends, resizes, total: 450, out }))
  writeFileSync(log, '')
  try {
    const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_COMPUTER_USE: undefined }), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => appendFileSync(log, chunk))
    child.stderr.on('data', chunk => appendFileSync(log, chunk))
    const status = await new Promise<number | null>(resolve => {
      const wall = setTimeout(() => { appendFileSync(log, '\ncapture deadline exceeded\n'); child.kill('SIGKILL') }, vshotBudgetMs(150_000))
      child.once('error', error => appendFileSync(log, `\n${String(error)}\n`))
      child.once('close', code => { clearTimeout(wall); resolve(code) })
    })
    writeFileSync(join(scratch, `${tag}-requests.json`), JSON.stringify({ status, requests: leg.fixture.requests, pacedEmits: leg.fixture.pacedEmits }, null, 2))
    check(`${tag}: the complete send sequence ran`, status === 0, `exit=${status}; complete engine output: ${log}; artifact: ${out}`)
    if (status !== 0) console.error(readFileSync(log, 'utf8'))
    check(`${tag}: the captured artifact exists`, existsSync(out))
    if (!existsSync(out)) continue
    let raw: unknown
    try { raw = JSON.parse(readFileSync(out, 'utf8')) } catch (error) {
      check(`${tag}: the artifact is valid JSON`, false, `${String(error)}; ${out}`)
      continue
    }
    const parsed = artifactSchema.safeParse(raw)
    check(`${tag}: the artifact has the capture schema`, parsed.success, parsed.success ? '' : `${parsed.error.message}; ${out}`)
    if (!parsed.success) continue
    const payload = parsed.data
    check(`${tag}: the final grid matches its declared geometry`, payload.grid.length === payload.rows && payload.grid.every(row => row.length === payload.cols))
    const marks = new Map((payload.marks ?? []).map(mark => [mark.label, mark]))
    const rowsAt = (label: string): string[] => (marks.get(label)?.grid ?? []).map(row => row.map(c => c.c).join('').trimEnd())
    const labels = ['typed', 'streaming', 'queued', 'interrupted', 'detail', 'small-detail', 'closed', 'tiny', 'compact-restored', 'full-restored']
    check(`${tag}: every required mark exists`, labels.every(label => marks.has(label)), `missing: ${labels.filter(label => !marks.has(label)).join(', ')}`)
    for (const label of labels) printFrame(`${tag} ${label}`, rowsAt(label))
    check(`${tag}: draft survives the first reflow`, joined(rowsAt('typed')).includes('draft-alpha bravo'))
    check(`${tag}: real streamed text arrived`, joined(rowsAt('streaming')).includes('compact-stream-003') && leg.fixture.pacedEmits.length > 0)
    check(`${tag}: interrupt cut the stream before completion`, leg.fixture.pacedEmits.length < 240 && joined(rowsAt('interrupted')).includes('interrupted'))
    check(`${tag}: detail actually opened`, joined(rowsAt('detail')).includes('Session statistics'))
    check(`${tag}: Escape closes detail with the nonempty draft intact`, joined(rowsAt('closed')).includes('keep-this-draft') && !joined(rowsAt('closed')).includes('Session statistics'))
    check(`${tag}: the tiny-stage key is retained after enlargement`, joined(rowsAt('compact-restored')).includes('keep-this-draftz'))
    const compactFrame = rowsAt('compact-restored')
    check(`${tag}: compact summary is restored once`, compactFrame.filter(line => /sessions? on/.test(line)).length === 1)
    check(`${tag}: compact has no old top band or miniature art`, !/▚▛▀▜▞|▖▟▆▙▗|▀▀▀▀▀▀▀▀▀/.test(joined(compactFrame)) && !compactFrame.some(line => line.includes('daemon') && line.includes('fleet')))
    if (!twin) {
      check('the one-cell stage uses the actual physical geometry', marks.get('tiny')?.grid.length === 1 && marks.get('tiny')?.grid[0]?.length === 1)
      check('the restored full frame uses the unchanged full composition', rowsAt('full-restored').length === 40 && joined(rowsAt('full-restored')).includes('SESSIONS'))
    }
    const main = leg.fixture.requests.filter(request => (request.body as { model?: string }).model?.includes('opus'))
    check(`${tag}: draft/detail keys never became model requests`, main.length > 0 && main.every(request => !request.raw.includes('keep-this-draft')))
    check(`${tag}: queued words were not duplicated across requests`, main.filter(request => request.raw.includes('queued while streaming')).length <= 1)
    check(`${tag}: nothing left loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
    results.push({ mainRequests: main.length, words: main.map(request => request.raw.includes('queued while streaming') ? 'queued while streaming' : 'stream the compact journey') })
  } finally {
    await endLeg(leg)
  }
}
check('journey and fixed compact twin delivered the same semantic request sequence', results.length === 2 && JSON.stringify(results[0]) === JSON.stringify(results[1]), JSON.stringify(results))
finish('compact-journey')
