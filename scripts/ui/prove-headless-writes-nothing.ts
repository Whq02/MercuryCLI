#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const PROBE_TEXT = 'headless probe frame'

if (process.argv[2] === '--child') {
  const outDir = process.argv[3]!
  process.chdir(ROOT)
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'headless-home-'))
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  for (const pin of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
    process.env[pin] = '0'
  }
  process.env.FORCE_COLOR = '3'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR, 'settings.json'), JSON.stringify({ activity: { progress: true } }))
  process.env.MERCURY_OASIS_BG = '0'
  const React = (await import('react')).default
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { render, Text, useApp } = await import('../../src/screen/themedRenderer.ts')
  const { useTabRing } = await import('../../src/screen/renderer/terminalWrite.ts')
  const { useTerminalTitle } = await import('../../src/screen/renderer/bindings/use-terminal-title.ts')
  const { cleanupTerminalModes } = await import('../../src/screen/renderer/terminal-session/shutdownRestoration.ts')
  let bytes = ''
  const stream = new PassThrough()
  stream.on('data', (chunk: Buffer | string) => {
    bytes += chunk.toString()
  })
  ;(stream as unknown as { columns?: number }).columns = 80
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    unref() { return this },
    ref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream
  function Probe(): React.ReactNode {
    const { exit } = useApp()
    useTabRing(true)
    useTerminalTitle('headless probe title')
    React.useLayoutEffect(() => {
      const t = setTimeout(() => setTimeout(() => exit(), 0), 0)
      return () => clearTimeout(t)
    }, [exit])
    return React.createElement(Text, null, PROBE_TEXT)
  }
  const instance = await render(React.createElement(Probe), {
    stdout: stream as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  await instance.waitUntilExit()
  writeFileSync(join(outDir, 'stream.bin'), bytes)
  cleanupTerminalModes()
  process.exit(0)
}

let failures = 0
const headlessWriteHint = (label: string): string =>
  /ring|title/.test(label) && !label.includes('stream carries')
    ? 'the mode ledger is src/screen/renderer/root/terminalModeLedger.ts (shutdownReleaseObligations, noteModeAcquired, noteModeReleased) and the ring is createTabRing in src/screen/renderer/terminalWrite.ts: a ring or title must be an open obligation only while held, and be released with its own clear'
    : 'a headless render must write only the frame: check useTabRing in src/screen/renderer/terminalWrite.ts, useTerminalTitle in src/screen/renderer/bindings/use-terminal-title.ts and cleanupTerminalModes in src/screen/renderer/terminal-session/shutdownRestoration.ts so none of them writes to a stream that is not a live terminal; rerun the child with bun run scripts/ui/prove-headless-writes-nothing.ts --child <dir> to see its own error'
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} | ` : ''}${headlessWriteHint(label)}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'headless-'))
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
const escapeSequences = (s: string): string[] => s.match(/\x1b(?:\[[0-9;?<>=]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|.)/g) ?? []

section('a headless render inside a terminal process: the stream carries the frame alone, the exit releases nothing')
{
  const dir = join(scratch, 'sink')
  mkdirSync(dir, { recursive: true })
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['NODE_ENV', 'WT_SESSION', 'TMUX', 'STY']) delete childEnv[k]
  const res = spawnSync(BUN, ['run', import.meta.path, '--child', dir], { encoding: 'utf8', env: childEnv, timeout: 120_000 })
  check('the child ran (exit 0)', res.status === 0, `status=${res.status} stderr=${JSON.stringify((res.stderr ?? '').slice(-300))}`)
  const path = join(dir, 'stream.bin')
  const stream = existsSync(path) ? readFileSync(path, 'utf8') : ''
  check('the render stream carries the frame', stripAnsi(stream).includes(PROBE_TEXT), JSON.stringify(stream.slice(0, 120)))
  const foreign = escapeSequences(stream).filter(seq => !/^\x1b\[[0-9;]*m$/.test(seq) && !/^\x1b\[\?2026[hl]$/.test(seq))
  check('the stream carries nothing but the frame — no OSC (ring, title), no cursor, no mode toggle', foreign.length === 0, `${foreign.length} foreign sequence(s): ${JSON.stringify(foreign.slice(0, 4))}`)
  check("the process's own stdout saw no byte during the render and the exit-time restoration (a process that armed nothing releases nothing)", (res.stdout ?? '') === '', `${(res.stdout ?? '').length} byte(s): ${JSON.stringify((res.stdout ?? '').slice(0, 80))}`)
  check("the process's stderr is silent", (res.stderr ?? '') === '', JSON.stringify((res.stderr ?? '').slice(-200)))
}

section('the exit-time restoration follows the ledger: a ring or a title this process armed is cleared, once')
{
  const { _resetTerminalModeLedgerForTesting, noteModeAcquired, noteModeReleased, shutdownReleaseObligations } = await import('../../src/screen/renderer/root/terminalModeLedger.ts')
  const { createTabRing } = await import('../../src/screen/renderer/terminalWrite.ts')
  _resetTerminalModeLedgerForTesting()
  const written: string[] = []
  const ring = createTabRing(s => written.push(s), () => true)
  const token = Symbol('holder')
  ring.hold(token, true)
  check('a ring that rang is an open obligation', shutdownReleaseObligations().includes('progress-ring'), JSON.stringify(shutdownReleaseObligations()))
  ring.release(token)
  check('…released with its own clear', !shutdownReleaseObligations().includes('progress-ring') && written.length === 2, JSON.stringify({ written: written.length, open: shutdownReleaseObligations() }))
  noteModeAcquired('terminal-title', 'terminal-title')
  check('a set title is an open obligation', shutdownReleaseObligations().includes('terminal-title'))
  noteModeReleased('terminal-title', 'terminal-title')
  _resetTerminalModeLedgerForTesting()
}

if (failures === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`[forensics] scratch kept: ${scratch}`)
console.log(failures === 0 ? '\nprove-headless-writes-nothing: ALL LAWS HOLD' : `\nprove-headless-writes-nothing: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
