#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, childEnv, DIST, endLeg, FACE_READY, finish, netlines, nonLoopback, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }

const driver = requireCaptureDriver('contract-card-fits')
const TITLE = 'Start with a contract?'
const QUESTION = 'Do you want to proceed?'
const YES = 'Yes — write it here'
const NO = 'No, start it plain (esc)'
const KEYS_HEAD = '↑↓ choose · ↵ confirm'
const FIELD_QUESTION = 'What is the contract?'
const PLACEHOLDER = 'what this session is for…'
const FIELD_KEYS = '↵ starts the session under it'
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
const rowOf = (rows: string[], needle: string): number => rows.findIndex(r => r.includes(needle))

async function capture(cols: number, rows: number): Promise<{ marks: Map<string, Mark>; status: number | null; log: string; leg: Awaited<ReturnType<typeof startLeg>> }> {
  const tag = `contract-card-${cols}x${rows}`
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const log = join(scratch, `${tag}-engine.log`)
  const sends = [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\u001b[1;2C', mark: 'boot' },
    { atTick: 100, awaitText: 'new session', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: 'n', mark: 'board' },
    { atTick: 160, awaitText: TITLE, minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: '', mark: 'offer' },
    { afterPrevTicks: 2, data: '\r' },
    { atTick: 999, awaitText: FIELD_QUESTION, minTick: 2, awaitSettleTicks: 3, requireAwait: true, data: '', mark: 'field' },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST], cwd: ROOT, cols, rows, sends, resizes: [], total: 240, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_CRITTER: 'clam' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(240 * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(log, output)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    for (const mark of payload.marks ?? []) marks.set(mark.label, mark)
  }
  return { marks, status, log, leg }
}

console.log(`contract card artifacts: ${scratch} (dist: ${DIST})`)

for (const [cols, rows] of [[80, 14], [82, 17], [80, 21]] as const) {
  const tag = `${cols}x${rows}`
  const run = await capture(cols, rows)
  try {
    check(`${tag}: the board opened, the offer stood and Yes opened the field (engine exit 0)`, run.status === 0 && run.marks.has('offer') && run.marks.has('field'), `exit=${run.status}; ${run.log}`)
    const offer = run.marks.get('offer')
    const field = run.marks.get('field')
    if (offer !== undefined) {
      const text = textRows(offer.grid)
      printFrame(`${tag} the offer`, text)
      const title = rowOf(text, TITLE)
      const question = rowOf(text, QUESTION)
      const yes = rowOf(text, YES)
      const no = rowOf(text, NO)
      const keys = rowOf(text, KEYS_HEAD)
      const composer = text.findIndex((r, i) => i > title && /^│.*╭/.test(r) && r.includes('╮ │'))
      check(`${tag} offer: the title, the question and the Yes/No rows are on the pane, in order`, title >= 0 && question > title && yes === question + 1 && no === yes + 1, JSON.stringify({ title, question, yes, no }))
      check(`${tag} offer: the keys row stands under the Yes/No rows`, keys > no, JSON.stringify({ no, keys }))
      const bottom = text.findIndex((r, i) => i > keys && r.includes('╰') && r.includes('╯') && !r.includes('╭'))
      check(`${tag} offer: the card closes with its own frame above the composer`, keys > 0 && bottom > keys && bottom <= keys + 2 && (composer < 0 || bottom < composer), JSON.stringify({ keys, bottom, composer }))
      if (cols === 80 && rows === 14) check(`${tag} offer: the keys row stands right under the Yes/No rows — the gap yielded`, keys === no + 1, JSON.stringify({ no, keys }))
      else check(`${tag} offer: the gap above the keys stands`, keys === no + 2, JSON.stringify({ no, keys }))
    }
    if (field !== undefined) {
      const text = textRows(field.grid)
      printFrame(`${tag} the field`, text)
      const question = rowOf(text, FIELD_QUESTION)
      const placeholder = rowOf(text, PLACEHOLDER)
      const keys = rowOf(text, FIELD_KEYS)
      check(`${tag} field: the question, the field and its keys are on the pane, in order`, question > 0 && placeholder > question && keys > placeholder, JSON.stringify({ question, placeholder, keys }))
      const bottom = text.findIndex((r, i) => i > keys && r.includes('╰') && r.includes('╯') && !r.includes('╭'))
      check(`${tag} field: the card closes with its own frame`, keys > 0 && bottom > keys && bottom <= keys + 2, JSON.stringify({ keys, bottom }))
    }
    check(`${tag}: the drive stayed on loopback`, nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    await endLeg(run.leg)
  }
}

finish('contract-card-fits')
