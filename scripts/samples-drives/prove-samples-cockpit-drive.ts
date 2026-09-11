#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback,
  printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }

const argOf = (name: string): string | undefined => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const dist = argOf('--dist') ?? DIST
const driver = requireCaptureDriver('samples-cockpit')
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))

const CELL = "const kept = await mercury.sample({ name: 'pricing-table', title: 'pricing table', html: '<!doctype html><html><head><meta charset=\"utf-8\"><title>Pricing</title></head><body><h1>Pricing</h1><p>Three plans. Billed monthly, cancel any time.</p></body></html>', ask: 'show me a pricing table' }); console.log('kept v' + kept.version)"
const TURNS = [
  { kind: 'tool_use' as const, name: 'Workshop', input: { cells: [{ language: 'js', title: 'pricing table', code: CELL }] } },
  { kind: 'text' as const, text: 'Here it is.' },
  { kind: 'text' as const, text: 'Noted: the heading grows in the next version.' },
]
const MARKS = { version: 1, pins: [{ x: 0.2, y: 0.1, target: 'h1 "Pricing"', text: 'make it bigger' }], note: 'keep it to three plans', verdict: 'changes-needed' }
const ADDRESS = /http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]{6,32}\?t=[0-9a-f]{32}/
const BAR_TODAY = /^│ ⊞ SESSIONS › │  ▣ this session  │   \/sessions\s+│$/
const BAR_WITH_SAMPLE = /^│ ⊞ SESSIONS › │  ▣ this session  │  ⧉ pricing table · v1  │   \/sessions\s+│$/
const LINE_TODAY = /^\d+ sessions? on · 0 monitors here · 0 agents here\s+⇧← boot face$/
const LINE_WITH_SAMPLE = /^\d+ sessions? on · 0 monitors here · 0 agents here · 1 sample\s+⇧← boot face$/
const LIST_ROW = /❯ ⧉ pricing table          v1 · changes needed · \d+[smh] ago/
const ESC = String.fromCharCode(27)

const shim = join(scratch, 'browser-shim.sh')
writeFileSync(shim, ['#!/bin/sh', 'printf "%s\\n" "$@" >> "$PROOF_BROWSER_LOG"', 'exit 0', ''].join('\n'))
chmodSync(shim, 0o755)

function jsonFilesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (statSync(path).isDirectory()) jsonFilesUnder(path, out)
      else if (name.endsWith('.json')) out.push(path)
    } catch {
    }
  }
  return out
}

function sampleAddressIn(home: string): string | null {
  for (const file of jsonFilesUnder(join(home, 'daemon'))) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('"samples":[{')) continue
    const hit = ADDRESS.exec(text)
    if (hit !== null) return hit[0]
  }
  return null
}

async function postMarksWhenKept(home: string, deadlineMs: number): Promise<{ address: string | null; status: number | null }> {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    const address = sampleAddressIn(home)
    if (address !== null) {
      const marksUrl = address.replace(/\/s\/([a-z0-9]+)\?t=/, '/s/$1/marks?t=')
      try {
        const response = await fetch(marksUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MARKS) })
        return { address, status: response.status }
      } catch {
        return { address, status: null }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return { address: null, status: null }
}

async function drive(cols: number, rows: number): Promise<void> {
  const tag = `samples-${cols}x${rows}`
  const full = cols >= 100 && rows >= 26
  const leg = await startLeg(tag, TURNS, null)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Workshop'] } }))
  const browserLog = join(scratch, `${tag}-browser.log`)
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const engineLog = join(scratch, `${tag}-engine.log`)
  const sends = [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
    { atTick: 100, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '' },
    { atTick: 999, awaitText: full ? '? for shortcuts' : '0 agents here', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'idle' },
    { afterPrevTicks: 3, data: 'show me a pricing table\r' },
    { atTick: 999, awaitText: 'Here it is.', minTick: 5, awaitSettleTicks: 3, requireAwait: true, data: '' },
    { atTick: 999, awaitText: full ? 'pricing table · v1' : '1 sample', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'sample' },
    { atTick: 999, awaitText: 'Marks on pricing table v1', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'marks' },
    { atTick: 999, awaitText: 'the heading grows', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '' },
    { afterPrevTicks: 3, data: '/samples\r' },
    { atTick: 999, awaitText: 'SAMPLES · this session', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'list' },
    { afterPrevTicks: 3, data: '\r', mark: 'open' },
    { afterPrevTicks: 8, data: ESC },
    { atTick: 999, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'back' },
  ]
  const total = 800
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), dist, '--chat'], cwd: ROOT, cols, rows, sends, resizes: [], total, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], {
    cwd: ROOT,
    env: childEnv(leg, { MERCURY_COMPUTER_USE: undefined, BROWSER: shim, PROOF_BROWSER_LOG: browserLog }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const marksJob = postMarksWhenKept(leg.home, vshotBudgetMs(150_000))
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(total * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(engineLog, output)
  const posted = await marksJob
  await endLeg(leg)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    for (const mark of payload.marks ?? []) marks.set(mark.label, mark)
  }
  check(`${tag}: the journey ran as written (engine exit 0)`, status === 0 && marks.has('back'), `exit=${status}; ${output.slice(-600)}`)
  const at = (label: string): string[] | null => {
    const mark = marks.get(label)
    return mark === undefined ? null : textRows(mark.grid)
  }
  for (const label of ['idle', 'sample', 'marks', 'list', 'open', 'back']) {
    const text = at(label)
    if (text !== null) printFrame(`${tag} ${label}`, text)
  }
  const idle = at('idle') ?? []
  const sample = at('sample') ?? []
  const marksText = at('marks') ?? []
  const list = at('list') ?? []
  const back = at('back') ?? []
  const last = (text: string[]): string => text[text.length - 1] ?? ''
  if (full) {
    check(`${tag}: with no sample the SESSIONS bar is the bar of today`, idle.some(row => BAR_TODAY.test(row)), JSON.stringify(idle.find(row => row.includes('SESSIONS')) ?? ''))
    check(`${tag}: the sample takes a berth beside this session: its glyph, its name, its version`, sample.some(row => BAR_WITH_SAMPLE.test(row)), JSON.stringify(sample.find(row => row.includes('SESSIONS')) ?? ''))
    check(`${tag}: the bar keeps one row and the screen its height`, idle.length === sample.length && sample.filter(row => row.includes('SESSIONS')).length === 1)
  } else {
    check(`${tag}: with no sample the count line is the line of today`, LINE_TODAY.test(last(idle)), JSON.stringify(last(idle)))
    check(`${tag}: the count line gains · 1 sample`, LINE_WITH_SAMPLE.test(last(sample)), JSON.stringify(last(sample)))
    check(`${tag}: the count line stays the last row at the full width`, last(sample).length === cols, String(last(sample).length))
  }
  check(`${tag}: the marks were posted to the address the runner relayed with its facts`, posted.address !== null && posted.status === 200, JSON.stringify(posted))
  const marksJoined = joined(marksText)
  check(`${tag}: the marks arrive as one message from the operator, in the approved words`, marksJoined.includes('Marks on pricing table v1: 1 pin · 1 note · changes needed') && marksJoined.includes('- at h1 "Pricing": make it bigger') && marksJoined.includes('keep it to three plans'), marksJoined.slice(0, 400))
  check(`${tag}: the model answered the marks in the normal turn`, joined(list.concat(marksText)).includes('the heading grows'))
  check(`${tag}: /samples lists the session's samples: name, version, state, age`, list.some(row => row.includes('SAMPLES · this session · 1')) && list.some(row => LIST_ROW.test(row)), JSON.stringify(list.filter(row => row.includes('pricing table'))))
  check(`${tag}: the list's header carries the keys`, list.some(row => row.includes('SAMPLES · this session · 1') && row.includes('↵ open · esc back')), JSON.stringify(list.find(row => row.includes('SAMPLES')) ?? ''))
  const opened = existsSync(browserLog) ? readFileSync(browserLog, 'utf8').split('\n').filter(line => line.trim() !== '') : []
  check(`${tag}: ↵ on the sample opened its address in the operator's browser, once`, opened.length === 1 && opened[0] === posted.address, JSON.stringify({ opened, address: posted.address }))
  check(`${tag}: esc returns to the chat`, joined(back).includes(ADMITTED) && !joined(back).includes('SAMPLES · this session'))
  check(`${tag}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0, nonLoopback(netlines(leg.netlog)).slice(0, 3).join(' | '))
  console.log(`\n${tag}: the poison — the comparators bite on the frame without a sample`)
  if (full) {
    check(`${tag}: P the berth law fails on the bar of today`, !idle.some(row => BAR_WITH_SAMPLE.test(row)))
  } else {
    check(`${tag}: P the count law fails on the line of today`, !LINE_WITH_SAMPLE.test(last(idle)))
  }
  check(`${tag}: P the list law fails on the chat`, !sample.some(row => LIST_ROW.test(row)))
}

console.log(`samples cockpit drive artifacts: ${scratch} (dist: ${dist})`)
await drive(120, 40)
await drive(82, 17)
finish('samples-cockpit-drive')
