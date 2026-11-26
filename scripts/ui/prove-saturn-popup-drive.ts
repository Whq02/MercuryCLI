#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

const driver = requireCaptureDriver('saturn-popup-drive')
const frameAt = process.argv.indexOf('--frames')
const framesDir = frameAt < 0 ? null : process.argv[frameAt + 1]!
if (framesDir !== null) mkdirSync(framesDir, { recursive: true })

type Mark = { label: string; grid: Array<Array<{ c: string }>> }
const rowsOf = (grid: Array<Array<{ c: string }>>): string[] => grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, ''))
const joined = (rows: string[]): string => rows.join('\n')
const flat = (rows: string[]): string => rows.join(' ').replace(/\s+/g, ' ')

function saveFrame(name: string, rows: string[]): void {
  if (framesDir === null) return
  writeFileSync(join(framesDir, `${name}.txt`), `${rows.join('\n')}\n`)
}

function seedBoxSchedules(home: string, cwd: string): void {
  const dir = join(home, 'daemon')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const payload = {
    version: 1,
    schedules: [
      {
        schema: 1,
        id: 'aaaa1111',
        when: { kind: 'at', atMs: now + 2 * 3_600_000, spelling: 'in 2h' },
        action: { kind: 'birth', birth: { workspaceDir: cwd, modelKey: 'claude-opus-5', presence: 'headless' } },
        account: { family: 'anthropic', source: 'api-key' },
        createdAt: now - 60_000,
        createdBy: 'operator:saturn-screen',
      },
      {
        schema: 1,
        id: 'bbbb2222',
        when: { kind: 'at', atMs: now + 6 * 3_600_000, spelling: 'in 6h' },
        action: { kind: 'birth', birth: { workspaceDir: cwd, modelKey: 'claude-opus-5', presence: 'headless' } },
        account: { family: 'anthropic', source: 'api-key' },
        createdAt: now - 30_000,
        createdBy: 'operator:saturn-screen',
      },
    ],
    heldFires: [],
  }
  writeFileSync(join(dir, 'saturn-box-schedules.json'), JSON.stringify(payload, null, 2))
}

function seedRailWorkerSchedule(home: string, cwd: string): void {
  const dir = join(home, 'daemon')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const payload = {
    version: 1,
    workers: {
      'concourse-w9': {
        runnerId: 'concourse-w9',
        sessionId: '00000000-0000-4000-8000-000000000009',
        workspaceId: cwd,
        title: 'scheduled-lane',
        model: 'claude-opus-5',
        createdAt: now - 120_000,
        parkedAt: now - 60_000,
        schedules: [
          {
            schema: 1,
            id: 'cccc3333',
            when: { kind: 'at', atMs: now + 2 * 3_600_000, spelling: 'in 2h' },
            action: { kind: 'fire', prompt: 'check status' },
            account: { family: 'anthropic', source: 'api-key' },
            createdAt: now - 60_000,
            createdBy: 'operator:saturn-screen',
          },
        ],
        heldFires: [],
      },
    },
  }
  writeFileSync(join(dir, 'concourse-workers.json'), JSON.stringify(payload, null, 2))
}

function popupBox(rows: string[], title: string): { left: number; right: number; top: number; bottom: number } | null {
  const titleRow = rows.findIndex(line => line.includes(title))
  if (titleRow < 1) return null
  const left = rows[titleRow]!.lastIndexOf('│', rows[titleRow]!.indexOf(title))
  if (left < 0) return null
  const top = rows.findIndex((line, y) => y < titleRow && (Array.from(line)[left] ?? '') === '╭')
  if (top < 0) return null
  const topChars = Array.from(rows[top] ?? '')
  const right = topChars.findIndex((ch, x) => x > left && ch === '╮')
  const bottom = rows.findIndex((line, y) => y > titleRow && (Array.from(line)[left] ?? '') === '╰')
  if (right <= left || bottom <= top) return null
  return { left, right, top, bottom }
}

function popupInner(rows: string[], box: { left: number; right: number; top: number; bottom: number } | null): string {
  if (box === null) return flat(rows)
  const slice = rows.slice(box.top + 1, box.bottom).map(line => Array.from(line).slice(box.left + 1, box.right).join('').trim())
  return slice.join(' ').replace(/\s+/g, ' ')
}

async function runDrive(
  tag: string,
  cols: number,
  rows: number,
  seedMode: 'empty' | 'box' | 'rail',
  sends: Array<Record<string, unknown>>,
): Promise<{ status: number | null; marks: Map<string, string[]>; output: string }> {
  const leg = await startLeg(tag, [], null)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true }, activity: { tips: { enabled: false } } }))
  if (seedMode === 'box') seedBoxSchedules(leg.home, leg.cwd)
  if (seedMode === 'rail') seedRailWorkerSchedule(leg.home, leg.cwd)
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const finalReady = seedMode === 'rail' ? 'keep-saturn-draft' : 'Type a prompt'
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, '--chat', '--sovereign'], cwd: leg.cwd, cols, rows, sends, resizes: [], total: 500, readyText: finalReady, readySettleTicks: 2, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: leg.cwd, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', FORCE_COLOR: '3' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(500 * 200 + 60_000))
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  const payload = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] } : {}
  const marks = new Map((payload.marks ?? []).map(mark => [mark.label, rowsOf(mark.grid)]))
  await endLeg(leg)
  return { status, marks, output }
}

for (const [cols, rows] of [[120, 40], [80, 24]] as Array<[number, number]>) {
  const tag = `saturn-empty-${cols}x${rows}`
  const res = await runDrive(tag, cols, rows, 'empty', [
    { requireAwait: true, awaitText: FACE_READY, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: ADMITTED, awaitSettleTicks: 2, data: '/schedule' },
    { requireAwait: true, awaitText: 'Schedules (Saturn): the board', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: 'no schedules stand.', awaitSettleTicks: 4, data: '', mark: 'open' },
    { requireAwait: true, awaitText: 'no schedules stand.', awaitSettleTicks: 1, data: '\x1b' },
    { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: '', mark: 'closed' },
  ])
  const open = res.marks.get('open') ?? []
  const closed = res.marks.get('closed') ?? []
  saveFrame(`empty-${cols}x${rows}`, open)
  const box = cols >= 100 ? popupBox(open, 'Mercury — saturn') : null
  const inner = popupInner(open, box)
  check(`${tag}: the drive completed`, res.status === 0 && open.length === rows, `status=${res.status} rows=${open.length} ${res.output.slice(-300)}`)
  check(`${tag}: opens as the Mercury — saturn pop-up with no (>_)`, joined(open).includes('Mercury — saturn') && !joined(open).includes('(>_)'), open.slice(0, 8).join(' | '))
  check(`${tag}: empty state tells both lines from the Boot page`, inner.includes('no schedules stand.') && inner.includes('press a to schedule a session birth'), inner.slice(0, 300))
  if (cols >= 100) {
    const chatLeft = open[0]?.indexOf('╭') ?? -1
    const chatRight = open[0]?.lastIndexOf('╮') ?? -1
    const centered = box !== null && chatLeft >= 0 && chatRight > chatLeft && Math.abs((box.left - chatLeft) - (chatRight - box.right)) <= 1
    check(`${tag}: draws centered inside a rounded pop-up frame`, box !== null && centered, `box=${JSON.stringify(box)} chat=[${chatLeft},${chatRight}]`)
  }
  check(`${tag}: esc closes back to the chat`, joined(closed).includes('Type a prompt') && !joined(closed).includes('Mercury — saturn'), closed.slice(-4).join(' | '))
}

for (const [cols, rows] of [[120, 40], [80, 24]] as Array<[number, number]>) {
  const tag = `saturn-rows-${cols}x${rows}`
  const res = await runDrive(tag, cols, rows, 'box', [
    { requireAwait: true, awaitText: FACE_READY, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: ADMITTED, awaitSettleTicks: 2, data: '/schedule' },
    { requireAwait: true, awaitText: 'Schedules (Saturn): the board', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 4, data: '', mark: 'open' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 1, data: '\x1b[B' },
    { requireAwait: true, awaitText: 'bbbb2222', awaitSettleTicks: 2, data: '', mark: 'down' },
    { requireAwait: true, awaitText: 'bbbb2222', awaitSettleTicks: 1, data: '\x1b[A' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 2, data: 'p' },
    { requireAwait: true, awaitText: "paused 'aaaa1111'", awaitSettleTicks: 2, data: '', mark: 'paused' },
    { requireAwait: true, awaitText: "paused 'aaaa1111'", awaitSettleTicks: 1, data: 'p' },
    { requireAwait: true, awaitText: "resumed 'aaaa1111'", awaitSettleTicks: 2, data: '', mark: 'resumed' },
    { requireAwait: true, awaitText: "resumed 'aaaa1111'", awaitSettleTicks: 1, data: 'n' },
    { requireAwait: true, awaitText: 'run-now takes fire schedules', awaitSettleTicks: 2, data: '', mark: 'run-now' },
    { requireAwait: true, awaitText: 'run-now takes fire schedules', awaitSettleTicks: 1, data: 'r' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 2, data: '', mark: 'refreshed' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 1, data: 'a' },
    { requireAwait: true, awaitText: 's schedule it', awaitSettleTicks: 2, data: '', mark: 'form' },
    { requireAwait: true, awaitText: 's schedule it', awaitSettleTicks: 1, data: '\x1b' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 2, data: 'x' },
    { requireAwait: true, awaitText: "removed 'aaaa1111'", awaitSettleTicks: 2, data: '', mark: 'deleted' },
    { requireAwait: true, awaitText: "removed 'aaaa1111'", awaitSettleTicks: 1, data: '\x1b' },
    { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: '', mark: 'closed' },
  ])
  const open = res.marks.get('open') ?? []
  const down = res.marks.get('down') ?? []
  const paused = res.marks.get('paused') ?? []
  const resumed = res.marks.get('resumed') ?? []
  const runNow = res.marks.get('run-now') ?? []
  const refreshed = res.marks.get('refreshed') ?? []
  const form = res.marks.get('form') ?? []
  const deleted = res.marks.get('deleted') ?? []
  const closed = res.marks.get('closed') ?? []
  saveFrame(`rows-${cols}x${rows}`, open)
  const box = cols >= 100 ? popupBox(open, 'Mercury — saturn') : null
  const inner = popupInner(open, box)
  check(`${tag}: the drive completed every gesture`, res.status === 0 && open.length === rows && closed.length === rows, `status=${res.status} open=${open.length} closed=${closed.length} ${res.output.slice(-300)}`)
  check(`${tag}: opens as the Mercury — saturn pop-up with no (>_)`, joined(open).includes('Mercury — saturn') && !joined(open).includes('(>_)'), open.slice(0, 8).join(' | '))
  check(`${tag}: lists both schedules and the action legend`, inner.includes('aaaa1111') && inner.includes('bbbb2222') && inner.includes('a schedule birth') && inner.includes('x delete') && inner.includes('n run-now') && inner.includes('p pause/resume') && inner.includes('r refresh') && inner.includes('esc close'), inner.slice(0, 400))
  if (cols >= 100) {
    const chatLeft = open[0]?.indexOf('╭') ?? -1
    const chatRight = open[0]?.lastIndexOf('╮') ?? -1
    const centered = box !== null && chatLeft >= 0 && chatRight > chatLeft && Math.abs((box.left - chatLeft) - (chatRight - box.right)) <= 1
    check(`${tag}: draws centered inside a rounded pop-up frame`, box !== null && centered, `box=${JSON.stringify(box)} chat=[${chatLeft},${chatRight}]`)
  }
  check(`${tag}: ↓ moves the cursor onto the second schedule`, down.some(line => /❯.*bbbb2222/.test(line)), down.filter(line => line.includes('2222') || line.includes('1111')).join(' | '))
  check(`${tag}: p pauses then resumes the schedule`, flat(paused).includes("paused 'aaaa1111'") && flat(resumed).includes("resumed 'aaaa1111'"), `paused=${flat(paused).slice(-120)} resumed=${flat(resumed).slice(-120)}`)
  check(`${tag}: n invokes run-now on the selected row`, flat(runNow).includes('run-now takes fire schedules'), flat(runNow).slice(-160))
  check(`${tag}: r refreshes and clears the prior note`, !flat(refreshed).includes('run-now takes fire schedules') && joined(refreshed).includes('aaaa1111'), flat(refreshed).slice(-160))
  check(`${tag}: a opens the birth form and esc returns to the list`, flat(form).includes('When') && flat(form).includes('s schedule it'), flat(form).slice(0, 240))
  check(`${tag}: x deletes the selected schedule`, flat(deleted).includes("removed 'aaaa1111'") && !joined(deleted).includes('in 2h') && joined(deleted).includes('bbbb2222'), flat(deleted).slice(0, 240))
  check(`${tag}: esc closes the pop-up back to the chat`, joined(closed).includes('Type a prompt') && !joined(closed).includes('Mercury — saturn'), closed.slice(-5).join(' | '))
}

{
  const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
  const res = await runDrive('saturn-mouse-120x40', 120, 40, 'box', [
    { requireAwait: true, awaitText: FACE_READY, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: ADMITTED, awaitSettleTicks: 2, data: '/schedule' },
    { requireAwait: true, awaitText: 'Schedules (Saturn): the board', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: 'aaaa1111', awaitSettleTicks: 4, data: '', mark: 'open' },
    { requireAwait: true, awaitText: 'bbbb2222', awaitSettleTicks: 1, targetText: 'bbbb2222', targetDx: 2, data: CLICK },
    { requireAwait: true, awaitText: 'bbbb2222', awaitSettleTicks: 2, data: '', mark: 'clicked-row' },
    { requireAwait: true, awaitText: 'bbbb2222', awaitSettleTicks: 1, data: 'p' },
    { requireAwait: true, awaitText: "paused '", awaitSettleTicks: 2, data: '', mark: 'clicked-paused' },
    { requireAwait: true, awaitText: "paused '", awaitSettleTicks: 1, data: 'a' },
    { requireAwait: true, awaitText: 'Opening mission', awaitSettleTicks: 2, targetText: 'Opening mission', targetDx: 2, data: CLICK },
    { requireAwait: true, awaitText: 'Opening mission', awaitSettleTicks: 2, data: '', mark: 'form-selected' },
    { requireAwait: true, awaitText: 'Opening mission', awaitSettleTicks: 1, targetText: 'Opening mission', targetDx: 2, data: CLICK },
    { requireAwait: true, awaitText: 'review', awaitSettleTicks: 2, data: '', mark: 'pick-open' },
    { requireAwait: true, awaitText: 'review', awaitSettleTicks: 1, targetText: 'review', targetDx: 2, data: CLICK },
    { requireAwait: true, awaitText: 'review', awaitSettleTicks: 2, data: '', mark: 'pick-selected' },
    { requireAwait: true, awaitText: 'review', awaitSettleTicks: 1, targetText: 'review', targetDx: 2, data: CLICK },
    { requireAwait: true, awaitText: 'Review the recent work', awaitSettleTicks: 2, data: '', mark: 'form-picked' },
    { requireAwait: true, awaitText: 'Review the recent work', awaitSettleTicks: 1, data: '\x1b' },
    { requireAwait: true, awaitText: 'bbbb2222', awaitSettleTicks: 2, data: '\x1b' },
    { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: '', mark: 'closed' },
  ])
  const clickedRow = res.marks.get('clicked-row') ?? []
  const clickedPaused = res.marks.get('clicked-paused') ?? []
  const formSelected = res.marks.get('form-selected') ?? []
  const pickOpen = res.marks.get('pick-open') ?? []
  const pickSelected = res.marks.get('pick-selected') ?? []
  const formPicked = res.marks.get('form-picked') ?? []
  const rowA = clickedPaused.find(line => line.includes('aaaa1111')) ?? ''
  const rowB = clickedPaused.find(line => line.includes('bbbb2222')) ?? ''
  check('saturn-mouse-120x40: clicking the second schedule moves the cursor onto bbbb2222', clickedRow.some(line => /❯.*bbbb2222/.test(line)) && !clickedRow.some(line => /❯.*aaaa1111/.test(line)), clickedRow.filter(line => line.includes('1111') || line.includes('2222')).join(' | '))
  check('saturn-mouse-120x40: pausing after clicking bbbb2222 pauses only bbbb2222', flat(clickedPaused).includes("paused 'bbbb2222'") && rowB.includes('paused') && rowA.includes('in 2h') && !rowA.includes('paused'), `rowA=${rowA.trim()} rowB=${rowB.trim()}`)
  check('saturn-mouse-120x40: clicking a birth form row selects then opens its picker', formSelected.some(line => /❯.*Opening mission/.test(line)) && flat(pickOpen).includes('Mercury — saturn · opening') && flat(pickOpen).includes('review'), `selected=${formSelected.find(l => l.includes('Opening')) ?? ''} pick=${flat(pickOpen).slice(0, 180)}`)
  check('saturn-mouse-120x40: clicking a picker option selects then applies it to the birth form', res.status === 0 && pickSelected.some(line => /❯.*review/.test(line)) && formPicked.some(line => line.includes('Opening mission') && line.includes('Review the recent work')), `status=${res.status} picked=${formPicked.find(l => l.includes('Opening')) ?? ''} ${res.output.slice(-220)}`)
}

{
  const DRAFT = 'keep-saturn-draft'
  const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
  const res = await runDrive('saturn-draft-120x40', 120, 40, 'rail', [
    { requireAwait: true, awaitText: FACE_READY, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: ADMITTED, awaitSettleTicks: 2, data: DRAFT },
    { requireAwait: true, awaitText: DRAFT, awaitSettleTicks: 2, targetText: 'in 2h', targetDx: 1, data: CLICK },
    { requireAwait: true, awaitText: '❯ ◐', awaitSettleTicks: 1, data: '\r' },
    { requireAwait: true, awaitText: 'Mercury — saturn', awaitSettleTicks: 4, data: '', mark: 'open' },
    { requireAwait: true, awaitText: 'Mercury — saturn', awaitSettleTicks: 1, data: '\x1b' },
    { requireAwait: true, awaitText: DRAFT, awaitSettleTicks: 2, data: '', mark: 'closed' },
  ])
  const open = res.marks.get('open') ?? []
  const closed = res.marks.get('closed') ?? []
  check('saturn-draft-120x40: clicking the saturn rail opens Mercury — saturn over a typed draft', res.status === 0 && joined(open).includes('Mercury — saturn') && joined(open).includes('cccc3333') && joined(open).includes(DRAFT) && !joined(open).includes('(>_)'), `status=${res.status} ${res.output.slice(-260)}`)
  check('saturn-draft-120x40: esc closes back to the chat with the typed draft intact', joined(closed).includes(DRAFT) && !joined(closed).includes('Mercury — saturn'), closed.slice(-5).join(' | '))
}

finish('saturn-popup-drive')
