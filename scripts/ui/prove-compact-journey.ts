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
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) })) })
const driver = requireCaptureDriver('compact-journey')
const expectedRequests = [['stream the compact journey'], ['stream the compact journey', 'queued while streaming']]
const results: Array<{ complete: boolean; requests: string[][] }> = []
console.log(`compact journey artifacts: ${scratch}`)
for (const variant of ['resize', 'compact', 'full'] as const) {
  const full = variant === 'full'
  const tag = `compact-journey-${variant}`
  const leg = await startLeg(tag, [
    { kind: 'paced', deltas: Array.from({ length: 240 }, (_, i) => `compact-stream-${String(i).padStart(3, '0')}\n`), gapMs: 250 },
    { kind: 'text', text: 'Queued words delivered.' },
    { kind: 'text', text: 'Finished.' },
  ], null)
  const out = join(scratch, `${tag}.json`)
  const log = join(scratch, `${tag}-engine.log`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const sends = [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
    { atTick: 100, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'draft-alpha' },
    { atTick: 999, awaitText: 'draft-alpha', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'wide' },
    { afterPrevTicks: 6, data: ' bravo' },
    { atTick: 999, awaitText: 'draft-alpha bravo', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u0015stream the compact journey\r', mark: 'typed' },
    { atTick: 999, awaitText: 'compact-stream-003', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'streaming' },
    { afterPrevTicks: 5, data: 'queued while streaming\r' },
    { afterPrevTicks: 3, data: '\u001b', mark: 'queued' },
    { atTick: 999, awaitText: 'Interrupted', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'interrupted' },
    { atTick: 999, awaitText: 'Queued words delivered.', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: 'keep-this-draft' },
    ...(full ? [
      { atTick: 999, awaitText: 'keep-this-draft', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u0014', mark: 'before-toggle' },
      { afterPrevTicks: 4, data: '\u0014', mark: 'toggled' },
      { afterPrevTicks: 4, data: '', mark: 'closed' },
    ] : [
      { atTick: 999, awaitText: 'keep-this-draft', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u0014\r', mark: 'before-detail' },
      { atTick: 999, awaitText: 'Session statistics', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'detail' },
      { afterPrevTicks: 6, data: '\u001b', mark: 'small-detail' },
      { atTick: 999, awaitText: 'keep-this-draft', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'closed' },
    ]),
    { afterPrevTicks: 6, data: 'z', mark: 'tiny' },
    { atTick: 999, awaitText: 'keep-this-draftz', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u001b[5~', mark: 'compact-restored' },
    { afterPrevTicks: 4, data: '', mark: 'scrolled' },
    { afterPrevTicks: 8, data: '', mark: 'full-restored' },
  ]
  const resizes = variant !== 'resize' ? [] : [
    { afterMark: 'wide', afterMs: 300, cols: 80, rows: 24 },
    { afterMark: 'streaming', afterMs: 300, cols: 60, rows: 16 },
    { afterMark: 'detail', afterMs: 300, cols: 40, rows: 10 },
    { afterMark: 'closed', afterMs: 300, cols: 1, rows: 1 },
    { afterMark: 'tiny', afterMs: 400, cols: 80, rows: 24 },
    { afterMark: 'scrolled', afterMs: 300, cols: 120, rows: 40 },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, '--chat'], cwd: ROOT, cols: variant === 'compact' ? 80 : 120, rows: variant === 'compact' ? 24 : 40, sends, resizes, total: 450, readyText: 'keep-this-draftz', readySettleTicks: 2, out }))
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
    const labels = ['boot', 'typed', 'streaming', 'queued', 'interrupted', ...(full ? ['toggled'] : ['detail', 'small-detail']), 'closed', 'tiny', 'compact-restored', 'scrolled', 'full-restored']
    check(`${tag}: every required mark exists`, labels.every(label => marks.has(label)), `missing: ${labels.filter(label => !marks.has(label)).join(', ')}`)
    for (const label of labels) printFrame(`${tag} ${label}`, rowsAt(label))
    check(`${tag}: draft survives the first reflow`, joined(rowsAt('typed')).includes('draft-alpha bravo'))
    check(`${tag}: real streamed text arrived`, joined(rowsAt('streaming')).includes('compact-stream-003') && leg.fixture.pacedEmits.length > 0)
    check(`${tag}: interrupt cut the stream before completion`, leg.fixture.pacedEmits.length > 0 && leg.fixture.pacedEmits.length < 240 && joined(rowsAt('interrupted')).includes('Interrupted'))
    if (!full) {
      const stream = rowsAt('streaming')
      const activity = stream.findIndex(row => row.includes('writing') && row.includes('tokens'))
      const models = stream.map((row, i) => row.includes('Opus 5') ? i : -1).filter(i => i >= 0)
      check(`${tag}: one activity row appears above the single model row`, activity >= 0 && models.length === 1 && activity < models[0]!)
      check(`${tag}: detail actually opened`, joined(rowsAt('detail')).includes('Session statistics'))
      check(`${tag}: Escape closes detail with the nonempty draft intact`, joined(rowsAt('closed')).includes('keep-this-draft') && !joined(rowsAt('closed')).includes('Session statistics'))
      const compactFrame = rowsAt('compact-restored')
      check(`${tag}: compact summary is restored once`, compactFrame.filter(line => /sessions? on/.test(line)).length === 1)
      check(`${tag}: compact has no old top band or miniature art`, compactFrame.length > 0 && !/▚▛▀▜▞|▖▟▆▙▗|▀▀▀▀▀▀▀▀▀/.test(joined(compactFrame)) && !compactFrame.some(line => line.includes('daemon') && line.includes('fleet')))
    } else {
      check(`${tag}: full task toggle never opens compact detail`, rowsAt('toggled').length === 40 && !joined(rowsAt('toggled')).includes('Session statistics') && joined(rowsAt('toggled')).includes('keep-this-draft'))
    }
    check(`${tag}: the final editing key is retained`, joined(rowsAt('compact-restored')).includes('keep-this-draftz'))
    if (variant === 'resize') check('the one-cell stage uses the actual physical geometry', marks.get('tiny')?.grid.length === 1 && marks.get('tiny')?.grid[0]?.length === 1)
    if (variant !== 'compact') check(`${tag}: the final full frame uses the full composition`, rowsAt('full-restored').length === 40 && joined(rowsAt('full-restored')).includes('SESSIONS'))
    check(`${tag}: page up preserves the draft while moving transcript content`, joined(rowsAt('scrolled')).includes('keep-this-draftz') && joined(rowsAt('scrolled')) !== joined(rowsAt('compact-restored')))
    const main = leg.fixture.requests.filter(request => (request.body as { model?: string }).model?.includes('opus'))
    const requests: string[][] = []
    for (const request of main) {
      const body = requestSchema.safeParse(request.body)
      check(`${tag}: a main request has a readable message shape`, body.success)
      if (!body.success) continue
      const words = body.data.messages.filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text ?? '')).filter(text => !text.startsWith('<system-reminder>'))
      requests.push(words)
    }
    check(`${tag}: exactly the submitted and queued user messages reached the fixture`, JSON.stringify(requests) === JSON.stringify(expectedRequests), JSON.stringify(requests))
    check(`${tag}: draft/detail keys never became model requests`, main.length === 2 && main.every(request => !request.raw.includes('keep-this-draft')))
    check(`${tag}: nothing left loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
    results.push({ complete: status === 0 && labels.every(label => marks.has(label)), requests })
  } finally {
    await endLeg(leg)
  }
}
check('resize and both fixed twins complete with the same nonempty semantic requests', results.length === 3 && results.every(result => result.complete && JSON.stringify(result.requests) === JSON.stringify(expectedRequests)), JSON.stringify(results))
finish('compact-journey')
