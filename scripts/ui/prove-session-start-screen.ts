#!/usr/bin/env bun
// gate-watch: src/components/MercuryHome.tsx src/components/SwitchboardTagBar.tsx src/components/HelmLanesRail.tsx src/components/FullscreenLayout.tsx
// gate-watch: src/ink/frame-writer.ts src/ink/root/screen-session.ts scripts/ui/alt-screen-scroll-audit.py
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback,
  printFrame, productNode, requireCaptureDriver, ROOT, scratch, section, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const PIN = process.argv.includes('--pin')
const pinDir = arg('--pin-dir')
if (pinDir !== undefined) mkdirSync(pinDir, { recursive: true })
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const SIZES = (arg('--sizes') ?? '80x24,120x40').split(',').map(s => s.split('x').map(Number) as [number, number])
const storedPath = (cols: number, rows: number): string => join(ROOT, 'scripts', 'ui', `session-start-frames-${cols}x${rows}.json`)
const PROJECT = 'gridgame'
const REPLY = 'Finished.'
const PROMPT = 'say hi'
const VOLATILE = [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g]
const COUNTS_ROW = /^\d+ sessions? on · .*(⇧← concourse|shift\+← concourse)$/
const mask = (row: string): string => (COUNTS_ROW.test(row) ? row.replace(COUNTS_ROW, '⟪live counts⟫ $1') : VOLATILE.reduce((s, re) => s.replace(re, m => '·'.repeat(m.length)), row))
const trimmed = (grid: Array<Array<{ c: string }>>): string[] => grid.map(r => r.map(c => c.c).join('').replace(/\s+$/, ''))
const untrimmed = (grid: Array<Array<{ c: string }>>): string[] => grid.map(r => r.map(c => c.c).join(''))

const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { mnemeProjectKeyFor } = await import('../../src/mneme/paths.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: dir } })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git('init', '-q', '-b', 'master')
  git('config', 'user.email', 'proof@example.invalid')
  git('config', 'user.name', 'proof')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'game.py'), 'print("grid")\n')
  git('add', 'game.py')
  git('commit', '-q', '-m', 'start: grid, player, score')
  writeFileSync(join(dir, 'MERCURY.md'), '# gridgame\n\nRun the tests with python -m unittest discover tests.\n')
}

function seedHistory(home: string, cwd: string): void {
  process.env.MERCURY_CONFIG_DIR = home
  const prompts = ['can you add walls to the game? a few # squares the player cannot walk through', 'carry on', 'carry on']
  const sessionIds = prompts.map((_, i) => `0000000${i + 1}-aaaa-bbbb-cccc-00000000000${i + 1}`)
  const dir = getProjectDir(cwd)
  mkdirSync(dir, { recursive: true })
  prompts.forEach((prompt, i) => {
    const sid = sessionIds[i]!
    const row = { ...createUserMessage({ content: prompt }), sessionId: sid, cwd, parentUuid: null }
    writeFileSync(join(dir, `${sid}.jsonl`), encodeSeedTranscript([row], sid, `2026-10-12T0${8 + i}:00:00.000Z`))
  })
  const engines = [
    [{ model: 'claude-fable-5-1', at: '2026-10-12T08:44:49.631Z' }, { model: 'claude-sonnet-5-5', at: '2026-10-12T09:04:03.000Z' }],
    [{ model: 'claude-sonnet-5-5', at: '2026-10-12T09:54:32.000Z' }, { model: 'gpt-6-luna', at: '2026-10-12T10:05:10.000Z' }, { model: 'claude-opus-5-5', at: '2026-10-12T10:09:41.000Z' }],
    [{ model: 'claude-opus-5-5', at: '2026-10-12T10:20:00.000Z' }, { model: 'claude-fable-5-1', at: '2026-10-12T10:22:00.000Z' }],
  ]
  const ledger = engines.map((list, i) => JSON.stringify({
    ordinal: i + 1, sessionId: sessionIds[i], startedAt: list[0]!.at, endedAt: i === 2 ? null : '2026-10-12T10:19:00.000Z', engines: list,
    rulings: [], retained: [], corrected: [], files: [join(cwd, 'game.py')], outcome: i === 2 ? null : 'closed',
    handoff: i === 2 ? null : { text: 'the walls are in; tests pass', at: '2026-10-12T10:19:00.000Z' },
  })).join('\n') + '\n'
  const lineageDir = join(home, 'projects', mnemeProjectKeyFor(cwd), 'lineage')
  mkdirSync(lineageDir, { recursive: true })
  writeFileSync(join(lineageDir, 'ledger.jsonl'), ledger)
}

const driver = requireCaptureDriver('session-start-screen')
const audit = join(ROOT, 'scripts', 'ui', 'alt-screen-scroll-audit.py')
console.log(`session-start artifacts: ${scratch}`)
for (const [cols, rows] of SIZES) {
  const tag = `session-start-${cols}x${rows}`
  section(`${cols}×${rows} — the session-start screen after a switch-heavy history, then the status row after a turn`)
  const cwd = join(scratch, tag, PROJECT)
  gitRepo(cwd)
  const realCwd = realpathSync(cwd)
  const leg = await startLeg(tag, [{ kind: 'text', text: REPLY }], null, realCwd)
  seedHistory(leg.home, realCwd)
  try {
    const grid = join(scratch, `${tag}-grid.json`)
    const cfgPath = join(scratch, `${tag}-vshot.json`)
    const tee = join(scratch, `${tag}.tee`)
    const wide = cols >= 100
    const sends = [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 120, awaitText: wide ? 'ready · Opus 5.5 ·' : '● ready · Opus 5.5', minTick: 5, awaitSettleTicks: 6, requireAwait: true, data: PROMPT, mark: 'chat' },
      { atTick: 160, awaitText: `❯ ${PROMPT}`, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
      { atTick: 220, awaitText: REPLY, minTick: 5, awaitSettleTicks: 8, requireAwait: true, data: '', mark: 'after-turn' },
    ]
    writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST], cwd: realCwd, cols, rows, sends, resizes: [], readyText: REPLY, readySettleTicks: 4, total: 300, out: grid }))
    const env = { ...childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off', MERCURY_REDUCED_MOTION: '1', PATH: process.env.PATH }), VSHOT_TEE: tee }
    const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: realCwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', chunk => { stderr += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const status = await new Promise<number | null>(resolve => {
      const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300 * 200 + 60_000))
      child.once('error', () => { clearTimeout(wall); resolve(null) })
      child.once('exit', code => { clearTimeout(wall); resolve(code) })
    })
    type Grid = Array<Array<{ c: string }>>
    const payload = existsSync(grid) ? JSON.parse(readFileSync(grid, 'utf8')) as { grid: Grid; cursor?: { x: number; y: number }; endReason?: string; marks?: Array<{ label: string; grid: Grid }> } : null
    const marks = new Map((payload?.marks ?? []).map(m => [m.label, m.grid]))
    const chatGrid = marks.get('chat') ?? []
    const turnGrid = marks.get('after-turn') ?? []
    const chat = trimmed(chatGrid)
    const turn = trimmed(turnGrid)
    const chatFull = untrimmed(chatGrid)
    printFrame(`${cols}x${rows} session start`, chat)
    printFrame(`${cols}x${rows} after the turn`, turn)
    if (frameDir !== undefined) {
      writeFileSync(join(frameDir, `${tag}-chat.txt`), chat.join('\n') + '\n')
      writeFileSync(join(frameDir, `${tag}-after-turn.txt`), turn.join('\n') + '\n')
    }
    check(`${cols}x${rows}: the drive reached the chat and the turn ended`, status === 0 && chat.length === rows && turn.length === rows && payload?.endReason === 'ready', `status ${status} end ${payload?.endReason} ${stderr.slice(-500)}`)
    check(`${cols}x${rows}: the grid has the exact physical dimensions and the cursor stays in bounds`, payload !== null && payload.grid.length === rows && payload.grid.every(l => l.length === cols) && payload.cursor !== undefined && payload.cursor.x >= 0 && payload.cursor.x < cols && payload.cursor.y >= 0 && payload.cursor.y < rows)
    check(`${cols}x${rows}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
    const doubled = (frame: string[]): number[] => frame.flatMap((row, i) => (i > 0 && /[╭╰A-Z]/.test(row) && row === frame[i - 1] ? [i] : []))
    check(`${cols}x${rows}: no row of the session-start screen repeats the row above it (the doubled-header shape)`, doubled(chat).length === 0, `rows ${doubled(chat).join(',')}`)
    check(`${cols}x${rows}: no row of the after-turn screen repeats the row above it`, doubled(turn).length === 0, `rows ${doubled(turn).join(',')}`)
    const dirRow = chat.find(r => /\bdir\b/.test(r) && r.includes(PROJECT))
    check(`${cols}x${rows}: the realm row names the project, its branch and its uncommitted state on one row`, wide ? dirRow !== undefined && /gridgame\s+\S\s*master · uncommitted/.test(dirRow) : chat.some(r => r.includes(PROJECT)), dirRow ?? chat.slice(0, 4).join(' | '))
    if (wide) {
      const top = chatFull[0] ?? ''
      check(`${cols}x${rows}: the top row carries the pane's top border — not a copy of the header below it`, top.includes('╭') && top.trimEnd().endsWith('╮') && top.includes('lanes'), chat[0] ?? '')
      const boxTop = chat.findIndex(r => /│╭─+╮│/.test(r))
      const boxBottom = chat.findIndex(r => /│╰─+╯│/.test(r))
      check(`${cols}x${rows}: the critter box has both corners whole, bottom border three rows under the top`, boxTop >= 0 && boxBottom === boxTop + 4, `top ${boxTop} bottom ${boxBottom}`)
      const paneBottom = chat.findIndex(r => /^\s*╰─+╯$/.test(r))
      check(`${cols}x${rows}: the pane's bottom border is one whole row`, paneBottom > boxBottom, `row ${paneBottom}`)
      const edges = chatFull.slice(1, paneBottom).map((r, i) => [i + 1, r[cols - 1]] as const).filter(([, ch]) => ch !== '│')
      check(`${cols}x${rows}: every pane row between the borders ends with the pane's right edge (no tail shifted off its row)`, edges.length === 0, `rows ${edges.map(([i, ch]) => `${i}:${JSON.stringify(ch)}`).join(' ')}`)
      check(`${cols}x${rows}: the hint row is whole on one row`, chat.some(r => r.includes('❯ ↵ sends  ·  /workflows /crewmates /saturn /health /trace')), chat.filter(r => r.includes('sends')).join(' | '))
      check(`${cols}x${rows}: the model row names the model`, chat.some(r => /│\s+model\s+Opus 5\.5/.test(r)), chat.filter(r => r.includes('model')).join(' | '))
      check(`${cols}x${rows}: the memory row says what rode at start and that Recall finds the rest`, chat.some(r => /│\s+memory\s+1 of 1 earlier note rode at start; Recall finds the rest/.test(r)), chat.filter(r => r.includes('memory')).join(' | '))
      const recent = chat.filter(r => /^\s+○ /.test(r))
      check(`${cols}x${rows}: the RECENT lane lists the seeded sessions, newest first`, recent.length === 3 && recent[0]!.includes('carry on') && recent[2]!.includes('can you add walls'), recent.join(' | '))
      const statusRows = turn.filter(r => /← back/.test(r))
      check(`${cols}x${rows}: after the turn exactly one status row stands, it reads ready, and the esc hint is gone`, statusRows.length === 1 && /^\s*ready · Opus 5\.5 · /.test(statusRows[0]!) && !statusRows[0]!.includes('esc interrupts'), statusRows.join(' | '))
      check(`${cols}x${rows}: the status row sits directly under the pane's bottom border, above the composer`, (() => { const s = turn.findIndex(r => /← back/.test(r)); return s > 0 && /^\s*╰─+╯$/.test(turn[s - 1] ?? '') && /^╭─+╮$/.test(turn[s + 1] ?? '') })(), turn.slice(-7).join('\n'))
    } else {
      check(`${cols}x${rows}: the compact header reads ready beside the model`, chat.some(r => r.includes('✶ Mercury') && r.includes('Opus 5.5')), chat.slice(0, 3).join(' | '))
      check(`${cols}x${rows}: after the turn the header reads ready`, turn.some(r => r.includes('● ready') && r.includes('Opus 5.5')), turn.slice(0, 3).join(' | '))
    }
    check(`${cols}x${rows}: no row of the after-turn screen carries the esc hint`, !turn.some(r => r.includes('esc interrupts')), turn.filter(r => r.includes('esc interrupts')).join(' | '))
    const composerTop = turn.findIndex(r => /^╭─+╮$/.test(r))
    check(`${cols}x${rows}: the composer's three rows are whole after the turn`, composerTop > 0 && /^│❯.*│$/.test(turn[composerTop + 1] ?? '') && /^╰─+╯$/.test(turn[composerTop + 2] ?? ''), turn.slice(composerTop, composerTop + 3).join('\n'))
    check(`${cols}x${rows}: the reply landed in the chat`, joined(turn).includes(REPLY))
    const auditRun = spawnSync(driver.python, [audit, tee, String(cols), String(rows)], { encoding: 'utf8' })
    let counts: Record<string, number> | null = null
    try { counts = JSON.parse(auditRun.stdout) as Record<string, number> } catch {}
    check(`${cols}x${rows}: the product's own bytes never scroll the alternate screen — no line feed on the bottom row, no glyph drawn through the wrap at the corner, no SU/SD`, counts !== null && counts.altEntered! >= 1 && counts.lineFeedAtBottomOnAlt === 0 && counts.drawThroughWrapAtBottomOnAlt === 0 && counts.scrollUpDownOnAlt === 0, auditRun.stdout.trim() || auditRun.stderr.trim())
    const stored = storedPath(cols, rows)
    const current = { chat: chat.map(mask), afterTurn: turn.map(mask) }
    if (PIN) {
      const target = pinDir === undefined ? stored : join(pinDir, `session-start-frames-${cols}x${rows}.json`)
      writeFileSync(target, JSON.stringify(current, null, 1) + '\n')
      console.log(`  pinned ${target}`)
    } else {
      const previous = existsSync(stored) ? JSON.parse(readFileSync(stored, 'utf8')) as typeof current : null
      const firstMove = (a: string[], b: string[]): string => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `row ${i}\n   stored: ${a[i] ?? ''}\n   now:    ${b[i] ?? ''}`
        return ''
      }
      check(`${cols}x${rows}: the session-start screen matches the stored frame (scripts/ui/session-start-frames-${cols}x${rows}.json; --pin rewrites it)`, previous !== null && firstMove(previous.chat, current.chat) === '', previous === null ? 'no stored frame' : firstMove(previous.chat, current.chat))
      check(`${cols}x${rows}: the after-turn screen matches the stored frame`, previous !== null && firstMove(previous.afterTurn, current.afterTurn) === '', previous === null ? 'no stored frame' : firstMove(previous.afterTurn, current.afterTurn))
    }
  } finally {
    await endLeg(leg)
  }
}
finish('session-start-screen')
