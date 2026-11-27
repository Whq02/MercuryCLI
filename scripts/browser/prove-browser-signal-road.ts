#!/usr/bin/env bun
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '..', '..'))
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

if (process.argv[2] === 'session') {
  const [notes = '', mark = '', endpoint = '', kind = ''] = process.argv.slice(3)
  const note = (line: string): void => appendFileSync(notes, `${line}\n`)
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { setSessionTrustAccepted } = await import(join(ROOT, 'src/boot/process-state/processState.ts'))
  setSessionTrustAccepted(true)
  const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
  enableConfigs()
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR ?? '', 'settings.json'), JSON.stringify({ events: { hooks: { 'session.end': [{ name: 'the witness', run: `echo ended >> '${mark}'` }] } } }))
  const { refreshHooksSnapshot } = await import(join(ROOT, 'src/integrations/event-hooks/hooksConfigSnapshot.ts'))
  refreshHooksSnapshot()
  if (kind !== 'bare') {
    const { setupGracefulShutdown } = await import(join(ROOT, 'src/platform/processes/gracefulShutdown.ts'))
    setupGracefulShutdown()
  }
  const sessions = await import(join(ROOT, 'src/integrations/browser/browserSession.ts'))
  const { BrowserTool } = await import(join(ROOT, 'src/tools/browser/BrowserTool.ts'))
  const { processOwnerForLane } = await import(join(ROOT, 'src/engine/run-owner/resolveOwner.ts'))
  const page = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>signal</title><h1>a local page</h1>')
  })
  await new Promise<void>(done => page.listen(0, '127.0.0.1', () => done()))
  const call = async (input: Record<string, unknown>): Promise<string> => {
    const { data } = await BrowserTool.call(input as never, {} as never)
    return `${data.outcome}: ${String(data.result).split('\n')[0]}`
  }
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  if (kind === 'bare') for (const signal of SIGNALS) process.removeAllListeners(signal)
  note(`listeners ${SIGNALS.map(signal => process.listenerCount(signal)).join(' ')}`)
  note(endpoint === '' ? `opened ${await call({ op: 'open', url: `http://127.0.0.1:${(page.address() as AddressInfo).port}/` })}` : `attached ${await call({ op: 'attach', endpoint })}`)
  const browser: ChildProcess | null = sessions.activeSession(processOwnerForLane(null))?.browser.process() ?? null
  browser?.once('exit', (code, signal) => note(`browser-exit ${code} ${signal}`))
  process.on('exit', code => note(`session-exit ${code}`))
  note(`ready ${browser?.pid ?? 0}`)
  await new Promise<never>(() => undefined)
}

const { check, finish, requireBrowser, run, section, sessions } = await import('./harness.ts')
await requireBrowser()

const ROAD = 'the launch in src/integrations/browser/session/launch.ts must hand the driver handleSIGINT, handleSIGTERM and handleSIGHUP as false where the process holds a listener for that signal, so that on a signal the product’s own shutdown (gracefulShutdown in src/platform/processes/gracefulShutdown.ts, installed by setupGracefulShutdown) is the one road: it asks the browser to quit and waits'
const BARE = 'the launch in src/integrations/browser/session/launch.ts must leave the driver its own handler for a signal the process holds no listener for (process.listenerCount of it is 0): such a process dies by the signal’s default action and runs no exit listener, so there the driver’s handler is what ends the browser'
const base = join(process.env.MERCURY_CONFIG_DIR ?? '', 'signal-road')
const NO_PROOF_BROWSER_WRAPPER = { MERCURY_SUITE_BROWSER_CLEANER: '1' }
const linesOf = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
const alive = (pid: number): boolean => {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface Ran {
  code: number | null
  signal: string | null
  notes: string[]
  hook: boolean
  exitMs: number | null
  goneMs: number | null
  outlived: boolean
  aliveLater: boolean
  onHome: number
  said: string
}

async function ranUnder(label: string, signal: NodeJS.Signals, how: { frozen?: boolean; endpoint?: string; bare?: boolean } = {}): Promise<Ran> {
  const home = join(base, label)
  mkdirSync(home, { recursive: true })
  const notes = join(home, 'notes.txt')
  const mark = join(home, 'hook-ran.txt')
  const session = spawn(process.execPath, [import.meta.path, 'session', notes, mark, how.endpoint ?? '', how.bare ? 'bare' : ''], { env: { ...process.env, ...NO_PROOF_BROWSER_WRAPPER, MERCURY_CONFIG_DIR: home, MERCURY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  session.stdout?.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
  session.stderr?.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
  const over = (): boolean => session.exitCode !== null || session.signalCode !== null
  const ready = (): string | undefined => linesOf(notes).find(line => line.startsWith('ready '))
  const started = Date.now()
  while (ready() === undefined && !over() && Date.now() - started < 90_000) await sleep(50)
  const browserPid = Number(ready()?.split(' ')[1] ?? 0)
  if (ready() === undefined) {
    if (!over()) session.kill('SIGKILL')
    return { code: session.exitCode, signal: session.signalCode, notes: linesOf(notes), hook: false, exitMs: null, goneMs: null, outlived: false, aliveLater: false, onHome: 0, said: `the session never came up: ${said.slice(-600)}` }
  }
  if (how.frozen) process.kill(browserPid, 'SIGSTOP')
  const sent = Date.now()
  session.kill(signal)
  let exitMs: number | null = null
  let goneMs: number | null = null
  for (;;) {
    const now = Date.now() - sent
    if (goneMs === null && browserPid > 0 && !alive(browserPid)) goneMs = now
    if (exitMs === null && over()) exitMs = now
    if (exitMs !== null && now - exitMs >= 1000) break
    if (exitMs === null && now >= (how.bare ? 3000 : 20_000)) break
    await sleep(10)
  }
  const outlived = !over()
  if (outlived) {
    session.kill('SIGKILL')
    while (!over()) await sleep(10)
  }
  const aliveLater = alive(browserPid)
  const found = spawnSync('pgrep', ['-f', home], { encoding: 'utf8' })
  const onHome = found.status === 0 ? found.stdout.split('\n').filter(Boolean).length : 0
  if (aliveLater) {
    try {
      process.kill(browserPid, 'SIGKILL')
    } catch (error) {
      said += ` (the browser this scene left could not be ended: ${String(error)})`
    }
  }
  return { code: session.exitCode, signal: session.signalCode, notes: linesOf(notes), hook: existsSync(mark), exitMs, goneMs, outlived, aliveLater, onHome, said }
}

section('S1 at the launch the driver is handed no handler of its own for a signal the process listens for, and keeps its own for one it does not')
{
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const own = SIGNALS.map(signal => process.listeners(signal))
  const held = (): void => undefined
  const handedWhen = async (listening: boolean): Promise<Record<string, unknown> | null> => {
    for (const signal of SIGNALS) {
      process.removeAllListeners(signal)
      if (listening) process.on(signal, held)
    }
    const handed: { options: Record<string, unknown> | null } = { options: null }
    sessions.setBrowserLaunchDriverForProof(async (options: Record<string, unknown>) => {
      handed.options ??= options
      throw new Error('no browser is started for this look')
    })
    await run({ op: 'open', url: 'http://127.0.0.1:9/' })
    sessions.setBrowserLaunchDriverForProof(null)
    for (const signal of SIGNALS) process.removeAllListeners(signal)
    return handed.options
  }
  const listened = await handedWhen(true)
  const unheard = await handedWhen(false)
  SIGNALS.forEach((signal, at) => {
    for (const listener of own[at] ?? []) process.on(signal, listener as () => void)
  })
  const three = (seen: Record<string, unknown> | null): string => (seen === null ? 'the launch was not reached' : JSON.stringify({ handleSIGINT: seen.handleSIGINT, handleSIGTERM: seen.handleSIGTERM, handleSIGHUP: seen.handleSIGHUP }))
  check('a process that listens for the three signals: handleSIGINT, handleSIGTERM and handleSIGHUP are false at the launch', listened !== null && listened.handleSIGINT === false && listened.handleSIGTERM === false && listened.handleSIGHUP === false, `${three(listened)} — change: ${ROAD}`)
  check('a process that listens for none of them: the driver keeps its own three, none is handed as false', unheard !== null && unheard.handleSIGINT !== false && unheard.handleSIGTERM !== false && unheard.handleSIGHUP !== false, `${three(unheard)} — change: ${BARE}`)
}

if (process.platform === 'win32') {
  console.log('\n  a signal a process can answer is a POSIX road: S2 to S5 do not run on win32')
} else {
  section('S2 a signal to a session with a browser up: the product’s own shutdown ends the browser by asking, runs its end hook, and exits with its own code')
  console.log('    each session runs without the proof machinery’s browser wrapper (scripts/lib/proofBrowser.cjs turns a kill of a proof’s browser into a protocol close): what is read here is how the product itself ends its browser; a browser a scene leaves is ended by its pid')
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as Array<[NodeJS.Signals, number]>) {
    const ran = await ranUnder(signal.toLowerCase(), signal)
    const browserEnd = ran.notes.find(line => line.startsWith('browser-exit '))?.slice('browser-exit '.length) ?? 'not seen by the session'
    const told = `${JSON.stringify(ran.notes)} ${ran.said.slice(-300)}`
    console.log(`    ${signal}: the browser’s own end: ${browserEnd}, gone ${ran.goneMs}ms after the signal; the session exited ${ran.code ?? ran.signal} after ${ran.exitMs}ms; its end hook ${ran.hook ? 'ran' : 'did not run'}`)
    check(`${signal}: the browser ends by its own quit (exit code 0), not by a kill`, browserEnd === '0 null', `${told} — change: ${ROAD}`)
    check(`${signal}: the session’s end hook has run when the session exits`, ran.hook && ran.notes.some(line => line.startsWith('session-exit ')), `${told} — change: ${ROAD}`)
    check(`${signal}: the session exits with the product’s own code for it (${code})`, ran.code === code && ran.signal === null, `${ran.code} ${ran.signal} ${told}`)
    check(`${signal}: no browser process of that session is alive a second after its exit`, !ran.aliveLater && ran.onHome === 0 && ran.goneMs !== null, `alive=${ran.aliveLater} processes on its home=${ran.onHome} ${told} — change: ${ROAD}`)
  }

  section('S3 a process that holds no listener of its own for a signal: the driver’s own handler stands there, as it always did, and the browser is gone within a second of the signal')
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
    const ran = await ranUnder(`bare-${signal.toLowerCase()}`, signal, { bare: true })
    const counts = ran.notes.find(line => line.startsWith('listeners ')) ?? 'not noted'
    const told = `${JSON.stringify(ran.notes)} ${ran.said.slice(-300)}`
    console.log(`    ${signal}: ${counts} at the launch; the browser was gone ${ran.goneMs}ms after the signal; the process ${ran.outlived ? 'was still running three seconds on' : `ended (${ran.code ?? ran.signal}) after ${ran.exitMs}ms`}`)
    check(`${signal}: the process held no listener for the three signals when it launched`, counts === 'listeners 0 0 0', told)
    check(`${signal}: its browser is gone within a second of the signal, and none of it is alive after`, ran.goneMs !== null && ran.goneMs <= 1000 && !ran.aliveLater && ran.onHome === 0, `gone=${ran.goneMs}ms alive=${ran.aliveLater} processes on its home=${ran.onHome} ${told} — change: ${BARE}`)
  }

  section('S4 a browser that cannot answer the ask (stopped): the session still ends inside its own bound, and that browser is killed as it goes')
  {
    const ran = await ranUnder('frozen', 'SIGTERM', { frozen: true })
    const told = `${JSON.stringify(ran.notes)} ${ran.said.slice(-300)}`
    console.log(`    SIGTERM with the browser stopped: the session exited ${ran.code ?? ran.signal} after ${ran.exitMs}ms; that browser was gone ${ran.goneMs}ms after the signal`)
    check('the session ends with its own code inside six seconds', ran.code === 143 && ran.exitMs !== null && ran.exitMs < 6000, `${ran.code} after ${ran.exitMs}ms ${told}`)
    check('the browser that would not quit is gone a second after the session: the driver’s listener for the process’s own exit kills it', !ran.aliveLater && ran.onHome === 0 && ran.goneMs !== null, `alive=${ran.aliveLater} processes on its home=${ran.onHome} ${told}`)
  }

  section('S5 the control: a browser the user started is not ended by a signal to the session that attached to it')
  {
    const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))
    const profile = join(base, 'user-profile')
    mkdirSync(profile, { recursive: true })
    const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--use-mock-keychain', '--password-store=basic', '--no-default-browser-check', 'about:blank']
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox')
    const user = spawn((resolveBrowser() as { executablePath: string }).executablePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] })
    let printed = ''
    user.stderr?.on('data', (chunk: Buffer) => { printed += chunk.toString('utf8') })
    const listening = (): string | undefined => /DevTools listening on (ws:\/\/\S+)/.exec(printed)?.[1]
    const started = Date.now()
    while (listening() === undefined && user.exitCode === null && Date.now() - started < 30_000) await sleep(50)
    const socket = listening()
    if (socket === undefined) check('the user’s browser came up', false, printed.slice(-400))
    else {
      const endpoint = `http://127.0.0.1:${new URL(socket).port}`
      const ran = await ranUnder('attached', 'SIGTERM', { endpoint })
      const answers = await fetch(`${endpoint}/json/version`).then(response => response.ok, () => false)
      console.log(`    SIGTERM to a session attached to the user’s browser: the session exited ${ran.code ?? ran.signal} after ${ran.exitMs}ms; the user’s browser ${user.exitCode === null && answers ? 'still answers' : 'IS GONE'}`)
      check('the session attached, and exits with its own code', ran.notes.some(line => line.startsWith('attached succeeded')) && ran.code === 143, `${JSON.stringify(ran.notes)} ${ran.said.slice(-300)}`)
      check('the user’s browser still runs and still answers a second after the session’s exit', user.exitCode === null && user.signalCode === null && answers, `exit=${user.exitCode} signal=${user.signalCode} answers=${answers}`)
    }
    if (user.exitCode === null && user.signalCode === null) {
      user.kill('SIGKILL')
      while (user.exitCode === null && user.signalCode === null) await sleep(20)
    }
  }
}

await finish('prove-browser-signal-road')
