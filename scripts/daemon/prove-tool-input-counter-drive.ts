import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureArgv0, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { removeWorld } from './dupline-world.ts'

const repo = resolve(import.meta.dir, '../..')
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const dist = resolve(argument('--dist') ?? join(repo, 'dist/mercury.mjs'))
const frames = argument('--frames')
const scratch = realpathSync(mkdtempSync(join(argument('--scratch-root') ?? tmpdir(), 'tool-input-counter-')))
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const runtime = existsSync(node) ? node : 'node'
const model = 'claude-fable-5-1'
const key = 'proof-key-ci-gate-not-a-real-key'
const opening = 'Input arriving.'
const done = 'Input complete.'
const bodyText = 'abcdefghijklmno\n'.repeat(8192)
const driver = resolveCaptureDriver()
let failures = 0
let checks = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const sse = (response: ServerResponse, type: string, fields: Record<string, unknown> = {}): void => {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
}
type Cell = { c?: string }
type Frame = { label?: string; atMs?: number; cols: number; rows: number; grid: Cell[][] }
const textOf = (frame: Frame): string => frame.grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const tokensOf = (text: string): number | null => {
  const count = /↓\s*~?([\d,.]+)(k?)\s+tokens/.exec(text)
  return count ? Number(count[1]!.replaceAll(',', '')) * (count[2] === 'k' ? 1000 : 1) : null
}

if (!existsSync(dist)) throw new Error(`Built bundle absent: ${dist}`)
if (driver.kind === 'unavailable') throw new Error(`${driver.reason}; ${driver.remedy}`)
const preflight = preflightCaptureDriver(driver, repo)
if (!preflight.ok) throw new Error(describeCapturePreflight(preflight))

for (const [cols, rows] of [[80, 21], [80, 14], [82, 17], [120, 40]] as const) {
  const geometry = `${cols}x${rows}`
  const home = join(scratch, geometry)
  const cwd = join(scratch, `work-${geometry}`)
  const daemonDir = join(home, 'daemon')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(daemonDir, { recursive: true })
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    hasSeenAutoDefaultNotice: true,
    hasSeenAutoDefaultNudge: true,
    projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
  }))
  writeFileSync(join(home, 'settings.json'), '{}')
  const target = join(cwd, 'output.txt')
  const input = JSON.stringify({ file_path: target, content: bodyText })
  const wireFile = join(home, 'wire.jsonl')
  writeFileSync(wireFile, '')
  type Wire = { kind: string; at: number; chars?: number; emitted?: number }
  const wire: Wire[] = []
  const record = (entry: Omit<Wire, 'at'>): void => {
    const row = { ...entry, at: Date.now() }
    wire.push(row)
    appendFileSync(wireFile, `${JSON.stringify(row)}\n`)
  }
  const open = (response: ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(response, 'message_start', { message: { id: `msg_input_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } })
  }
  const close = (response: ServerResponse, stop: string): void => {
    sse(response, 'message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } })
    sse(response, 'message_stop')
    response.end()
  }
  const answer = (response: ServerResponse, text: string): void => {
    open(response)
    sse(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    sse(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    sse(response, 'content_block_stop', { index: 0 })
    close(response, 'end_turn')
  }
  const fixture = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', async () => {
      if (request.method !== 'POST' || !(request.url ?? '').split('?')[0]!.endsWith('/v1/messages')) {
        response.writeHead(404)
        response.end('{}')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string; content: unknown }>; stream?: boolean }
      const messages = JSON.stringify(body.messages ?? [])
      if (!messages.includes('stream the input')) return answer(response, 'Ready.')
      if (messages.includes('tool_result')) {
        record({ kind: 'tool-result' })
        return answer(response, done)
      }
      record({ kind: 'stream-start' })
      open(response)
      sse(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      sse(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: opening } })
      sse(response, 'content_block_stop', { index: 0 })
      sse(response, 'content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_input', name: 'Write', input: {} } })
      for (let offset = 0; offset < input.length; offset += 1024) {
        await pause(vshotBudgetMs(100))
        if (response.destroyed) return
        const partial = input.slice(offset, offset + 1024)
        sse(response, 'content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: partial } })
        record({ kind: 'input', chars: partial.length, emitted: offset + partial.length })
      }
      sse(response, 'content_block_stop', { index: 1 })
      close(response, 'tool_use')
      record({ kind: 'stream-end', emitted: input.length })
    })
  })
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_CACHE_HOME: join(home, 'xdg-cache'),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetMs(1000) / 1000),
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_CONNECTOR_TRACE: join(home, 'connector-trace.jsonl'),
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
    BROWSER: '/usr/bin/true',
  }
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_DAEMON_DIR = daemonDir
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  let daemon: ChildProcess | undefined
  let capture: ChildProcess | undefined
  let daemonLog = ''
  let captureLog = ''
  const samples: Array<{ at: number; turnChars: number; text: string | null; streamBlock: string | null }> = []
  const sampler = setInterval(() => {
    const folder = join(daemonDir, 'session-tail')
    if (!existsSync(folder)) return
    for (const name of readdirSync(folder).filter(name => name.endsWith('.json'))) {
      const tail = JSON.parse(readFileSync(join(folder, name), 'utf8')) as { turnChars?: number; text: string | null; streamBlock?: string }
      samples.push({ at: Date.now(), turnChars: tail.turnChars ?? 0, text: tail.text, streamBlock: tail.streamBlock ?? null })
    }
  }, 100)
  try {
    daemon = spawn(runtime, [dist, 'daemon', 'run', cwd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    daemon.stdout?.on('data', chunk => { daemonLog += String(chunk) })
    daemon.stderr?.on('data', chunk => { daemonLog += String(chunk) })
    const until = Date.now() + vshotBudgetMs(30_000)
    let ready = false
    while (!ready && Date.now() < until) {
      try { ready = (await daemonControlRpc({ op: 'ping' })).ok } catch { }
      if (!ready) await pause(100)
    }
    check(`${geometry}: the scratch daemon serves`, ready)
    if (!ready) throw new Error(daemonLog)
    const out = join(home, 'grid.json')
    const config = join(home, 'capture.json')
    const sends = [
      { requireAwait: true, awaitText: 'choose', awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'stream the input\r' },
      { requireAwait: true, awaitText: opening, awaitSettleTicks: 10, data: '', mark: 'early' },
      { afterPrevTicks: 25, data: '', mark: 'later' },
      { requireAwait: true, awaitText: 'Do you want to create output.txt?', awaitSettleTicks: 2, data: '\r', mark: 'approval' },
      { requireAwait: true, awaitText: done, awaitSettleTicks: 5, data: '', mark: 'complete' },
    ]
    writeFileSync(config, JSON.stringify({ argv: [resolveCaptureArgv0(runtime, driver), dist, '--model', model, '--permission-mode', 'default'], cwd, cols, rows, sends, out, total: 300, readyText: done, readySettleTicks: 2, liveSeat: true, ...(process.platform === 'win32' ? { hostProfile: 'wt' } : {}) }))
    const startedAt = Date.now()
    const status = await new Promise<number | null>((resolve, reject) => {
      capture = spawn(driver.python, [captureEngineEntry(driver, repo), config], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => capture?.kill('SIGKILL'), vshotBudgetMs(70_000))
      capture.stdout?.on('data', chunk => { captureLog += String(chunk) })
      capture.stderr?.on('data', chunk => { captureLog += String(chunk) })
      capture.on('error', reject)
      capture.on('close', code => { clearTimeout(timer); resolve(code) })
    })
    check(`${geometry}: the real-terminal journey completes`, status === 0 && existsSync(out), `exit=${status}`)
    if (!existsSync(out)) throw new Error(captureLog)
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Frame & { marks?: Frame[]; sendReceipts?: Array<{ ts: number }>; endReason: string }
    check(`${geometry}: all sends reached their observed state`, payload.sendReceipts?.length === sends.length && payload.endReason === 'ready', `sends=${payload.sendReceipts?.length}, end=${payload.endReason}`)
    const marks = Object.fromEntries((payload.marks ?? []).map(frame => [frame.label!, frame]))
    const measured: Record<string, unknown>[] = []
    for (const label of ['early', 'later']) {
      const frame = marks[label]
      const text = frame ? textOf(frame) : ''
      const markAt = payload.sendReceipts?.[label === 'early' ? 2 : 3]?.ts ?? startedAt
      const emitted = wire.filter(row => row.kind === 'input' && row.at <= markAt).at(-1)?.emitted ?? 0
      const stillStreaming = wire.some(row => row.kind === 'input' && row.at > markAt)
      const tokens = tokensOf(text)
      const rate = /([\d,.]+)\s*tok\/s/.exec(text)?.[1] ?? null
      check(`${geometry} ${label}: tool input is arriving before completion`, emitted >= 8192 && stillStreaming, `chars=${emitted}`)
      const rounding = cols >= 100 ? 50 : 0
      check(`${geometry} ${label}: the spinner counts more than the opening prose without overtaking the rounded wire count`, tokens !== null && tokens > Math.floor(opening.length / 4) && tokens <= Math.floor((emitted + opening.length) / 4) + rounding, `tokens=${tokens}, inputChars=${emitted}`)
      if (cols >= 100) {
        check(`${geometry} ${label}: the token rate grows on the same stream`, rate !== null && Number(rate.replaceAll(',', '')) > 0, `rate=${rate}`)
        const recentCounts = wire.filter(row => row.kind === 'input' && row.at <= markAt && row.at >= markAt - vshotBudgetMs(1000)).map(row => Math.floor((row.emitted! + opening.length) / 4))
        check(`${geometry} ${label}: the wide counter shows a raw count from the last second, rounded for display`, tokens !== null && recentCounts.some(count => Math.abs(tokens - count) <= rounding), `tokens=${tokens}, recentRawTokens=${JSON.stringify(recentCounts)}`)
      }
      const sample = samples.filter(sample => sample.at <= markAt).at(-1)
      check(`${geometry} ${label}: the published count is an exact input prefix without exposing it as prose`, sample !== undefined && sample.turnChars > opening.length && wire.some(row => row.kind === 'input' && row.at <= sample.at && row.emitted === sample.turnChars - opening.length) && sample.text === null && sample.streamBlock === 'tool_use', JSON.stringify(sample))
      measured.push({ label, markAt, emitted, tokens, rate, stillStreaming, sample })
      writeFileSync(join(home, `${label}.txt`), `${text}\n`)
    }
    const early = marks.early ? tokensOf(textOf(marks.early)) : null
    const later = marks.later ? tokensOf(textOf(marks.later)) : null
    check(`${geometry}: the counter grows between the two streaming frames`, early !== null && later !== null && later > early, `${early} -> ${later}`)
    const approvalAt = payload.sendReceipts?.[4]?.ts ?? 0
    const inputComplete = samples.filter(sample => sample.at <= approvalAt).at(-1)
    check(`${geometry}: the complete input counts exactly once before execution`, inputComplete?.turnChars === opening.length + input.length, JSON.stringify(inputComplete))
    check(`${geometry}: the Write executes its complete payload`, existsSync(target) && readFileSync(target, 'utf8') === bodyText)
    check(`${geometry}: the short final reply paints after the tool result`, Boolean(marks.complete && textOf(marks.complete).includes(done)) && wire.some(row => row.kind === 'tool-result'))
    check(`${geometry}: result clears the live count`, samples.at(-1)?.turnChars === 0, JSON.stringify(samples.at(-1)))
    writeFileSync(join(home, 'tail-samples.json'), `${JSON.stringify(samples, null, 2)}\n`)
    writeFileSync(join(home, 'measurements.json'), `${JSON.stringify({ dist, scratch: home, geometry, inputChars: input.length, measured }, null, 2)}\n`)
    if (frames) {
      const destination = join(resolve(frames), geometry)
      mkdirSync(destination, { recursive: true })
      for (const name of ['capture.json', 'grid.json', 'early.txt', 'later.txt', 'wire.jsonl', 'measurements.json', 'tail-samples.json']) {
        const file = join(home, name)
        if (existsSync(file)) writeFileSync(join(destination, name), readFileSync(file))
      }
    }
  } catch (error) {
    check(`${geometry}: the drive ran without an infrastructure error`, false, String(error))
  } finally {
    clearInterval(sampler)
    capture?.kill('SIGTERM')
    if (daemon) {
      const child = daemon
      const stopped = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('The scratch daemon did not finish shutting down'))
        }, vshotBudgetMs(10_000))
        child.once('close', () => { clearTimeout(timer); resolve() })
      })
      try { await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never) } catch { }
      await stopped
    }
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
    writeFileSync(join(home, 'daemon.log'), daemonLog)
    writeFileSync(join(home, 'capture.log'), captureLog)
  }
}
if (failures === 0 && frames === undefined) await removeWorld(scratch)
console.log(`${checks} checks, ${failures} failures; scratch=${scratch}`)
process.exitCode = failures === 0 ? 0 : 1
