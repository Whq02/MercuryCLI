#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'notice-way-out-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { Box, Text, render, flushPendingSyncWork } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const notices = await import('../../src/context/notifications.js')
const row = await import('../../src/components/PromptInput/Notifications.js')
const { decideHandshake } = await import('../../src/daemon/handshake.js')
const { olderDaemonRefusalLine, restartDaemonWords } = await import('../../src/daemon/controlSocket.js')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const COLS = 110
const ROWS = 32
const DAEMON = { proto: MERCURY_DAEMON_PROTO - 1, version: '1.0.0-beta.44' }
const hello = (over: Record<string, unknown>): never =>
  ({ ok: true, op: 'hello', proto: DAEMON.proto, minProto: 1, ready: true, version: DAEMON.version, buildTree: 'a91f96d7a74b', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: true, ...over }) as never
const screen = { proto: MERCURY_DAEMON_PROTO, version: '1.0.0-rc.1', buildTree: '0518549998ad' }
const verdict = decideHandshake({ kind: 'hello', reply: hello({}) }, screen)
const honest = verdict.line ?? ''
const refusal = olderDaemonRefusalLine('sessionControl send-now', MERCURY_DAEMON_PROTO, DAEMON)
const RESTART = restartDaemonWords()
const split = typeof notices.splitWayOut === 'function' ? notices.splitWayOut : (line: string): { text: string; wayOut?: string } => ({ text: line })

section('§1 the two lines the field saw at 110 columns are wider than the row, and each names its way out after the last seam')
{
  check('the older-daemon line of the handshake: the daemon, the live count, the wait, then /daemon restart when ready', honest === `daemon v${DAEMON.version} running with 1 live session — new features wait until it restarts · /daemon restart when ready`, honest)
  check('it is wider than 110 columns, so a one-row cut sheds its tail', stringWidth(honest) > COLS, String(stringWidth(honest)))
  check('the refusal of ctrl+s s on that daemon ends with the one restart sentence', refusal.endsWith(RESTART) && refusal.includes('`sessionControl send-now` needs protocol') && stringWidth(refusal) > COLS, refusal)
  const a = split(honest)
  check('splitWayOut keeps the way out of the handshake line whole', a.wayOut === '/daemon restart when ready' && a.text === `daemon v${DAEMON.version} running with 1 live session — new features wait until it restarts`, JSON.stringify(a))
  const b = split(refusal)
  check('splitWayOut keeps the restart sentence of the refusal whole (the seam before it is the house seam)', b.wayOut === RESTART && b.text === `the daemon is an older build (protocol ${DAEMON.proto}, v${DAEMON.version}; this Mercury speaks ${MERCURY_DAEMON_PROTO}): \`sessionControl send-now\` needs protocol ${MERCURY_DAEMON_PROTO}`, JSON.stringify(b))
  check('a line without a seam, a seam at the front and a seam at the end stay one text', JSON.stringify(split('Copied to clipboard')) === '{"text":"Copied to clipboard"}' && JSON.stringify(split(' · x')) === '{"text":" · x"}' && JSON.stringify(split('x · ')) === '{"text":"x · "}')
  check('the row reads the way out off a text notice and nothing off a jsx one or a notice without one', typeof row.noticeRowWayOut === 'function' && row.noticeRowWayOut({ key: 'k', priority: 'high', text: 'a', wayOut: '/daemon' }) === '/daemon' && row.noticeRowWayOut({ key: 'k', priority: 'high', text: 'a' }) === null && row.noticeRowWayOut({ key: 'k', priority: 'high', jsx: React.createElement(Text, null, 'a') }) === null && row.noticeRowWayOut(null) === null)
}

type Painted = { frame: () => string; lines: () => string[]; close: () => void }
async function paint(node: React.ReactNode, columns: number, rows: number): Promise<Painted> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: new NodeEventEmitter(), internal_querier: null }
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(React.createElement(StdinContext.Provider, { value: context }, node), { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    lines: () => stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n'),
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

function footerRow(line: string): React.ReactNode {
  const notice = { key: 'k', priority: 'high' as const, ...split(line) }
  const words = row.noticeRowText(notice)
  const wayOut = typeof row.noticeRowWayOut === 'function' ? row.noticeRowWayOut(notice) : null
  const pair = typeof row.NoticeWords === 'function'
    ? React.createElement(row.NoticeWords, { seam: false, words, wayOut, muted: 'gray' })
    : React.createElement(Text, { dimColor: true, wrap: 'truncate-end' }, words)
  return React.createElement(Box, { flexDirection: 'column', width: COLS }, React.createElement(Box, { flexShrink: 1, minWidth: 0, flexWrap: 'wrap', height: 1, overflow: 'hidden' }, pair))
}

section(`§2 the footer's notice row at ${COLS}×${ROWS}: the front shortens, the way out stays whole`)
for (const [label, line, wayOut] of [
  ['the handshake line', honest, '/daemon restart when ready'],
  ['the ctrl+s s refusal', refusal, RESTART],
] as const) {
  const board = await paint(footerRow(line), COLS, ROWS)
  const rows = board.lines().filter(l => l.trim() !== '')
  const painted = rows[0] ?? ''
  check(`${label}: one row, no wider than ${COLS} columns`, rows.length === 1 && stringWidth(painted) <= COLS, `${rows.length} rows · ${stringWidth(painted)} columns · ${JSON.stringify(painted)}`)
  check(`${label}: the row ends with the way out — ${wayOut}`, painted.trimEnd().endsWith(wayOut), JSON.stringify(painted))
  check(`${label}: the front is the line's own words, shortened with an ellipsis before the seam`, painted.includes('…') && painted.startsWith(line.slice(0, 24)) && painted.includes(' · ' + wayOut), JSON.stringify(painted))
  board.close()
}

section('§3 a notice that fits is painted whole, with no seam of its own')
{
  const board = await paint(footerRow('Copied to clipboard · /help'), COLS, ROWS)
  const painted = board.lines().find(l => l.trim() !== '') ?? ''
  check('the short notice reads as one line, its seam and way out in place', painted.trimEnd() === 'Copied to clipboard · /help', JSON.stringify(painted))
  board.close()
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-notice-way-out: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
