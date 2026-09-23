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
const scratch = realpathSync(mkdtempSync(join(argument('--scratch-root') ?? tmpdir(), 'turn-output-tokens-')))
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const runtime = existsSync(node) ? node : 'node'
const model = 'claude-fable-5-1'
const key = 'proof-key-ci-gate-not-a-real-key'
const firstLeg = 'First leg done.'
const secondLeg = 'Second leg done.'
const thought = 'weighing the ask.. '
const firstThinkDeltas = 15
const secondThinkDeltas = 60
const firstWireTokens = 777
const secondWireTokens = 555
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
const figureOf = (text: string): { count: number; estimate: boolean } | null => {
  const found = /↓\s*(~?)([\d,.]+)(k?)\s+tokens/.exec(text)
  if (!found) return null
  return { count: Number(found[2]!.replaceAll(',', '')) * (found[3] === 'k' ? 1000 : 1), estimate: found[1] === '~' }
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
  const notes = join(cwd, 'notes.txt')
  writeFileSync(notes, 'one line of notes\n')
  const toolInput = JSON.stringify({ file_path: notes })
  const wireFile = join(home, 'wire.jsonl')
  writeFileSync(wireFile, '')
  type Wire = { kind: string; at: number; chars?: number }
  const wire: Wire[] = []
  const record = (entry: Omit<Wire, 'at'>): void => {
    const row = { ...entry, at: Date.now() }
    wire.push(row)
    appendFileSync(wireFile, `${JSON.stringify(row)}\n`)
  }
  let streamedChars = 0
  const open = (response: ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(response, 'message_start', { message: { id: `msg_tokens_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } })
  }
  const close = (response: ServerResponse, stop: string, outputTokens: number): void => {
    sse(response, 'message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } })
    sse(response, 'message_stop')
    response.end()
    record({ kind: 'usage', chars: outputTokens })
  }
  const think = async (response: ServerResponse, deltas: number): Promise<boolean> => {
    sse(response, 'content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
    for (let i = 0; i < deltas; i++) {
      await pause(vshotBudgetMs(100))
      if (response.destroyed) return false
      sse(response, 'content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thought } })
      streamedChars += thought.length
      record({ kind: 'think', chars: streamedChars })
    }
    sse(response, 'content_block_stop', { index: 0 })
    return true
  }
  const say = (response: ServerResponse, index: number, text: string): void => {
    sse(response, 'content_block_start', { index, content_block: { type: 'text', text: '' } })
    sse(response, 'content_block_delta', { index, delta: { type: 'text_delta', text } })
    sse(response, 'content_block_stop', { index })
    streamedChars += text.length
    record({ kind: 'text', chars: streamedChars })
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
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string; content: unknown }> }
      const messages = JSON.stringify(body.messages ?? [])
      if (!messages.includes('count the wire')) {
        open(response)
        say(response, 0, 'Ready.')
        close(response, 'end_turn', 3)
        return
      }
      if (messages.includes('tool_result')) {
        record({ kind: 'second-request' })
        open(response)
        if (!(await think(response, secondThinkDeltas))) return
        say(response, 1, secondLeg)
        close(response, 'end_turn', secondWireTokens)
        return
      }
      record({ kind: 'first-request' })
      open(response)
      if (!(await think(response, firstThinkDeltas))) return
      say(response, 1, firstLeg)
      sse(response, 'content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_notes', name: 'Read', input: {} } })
      sse(response, 'content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: toolInput } })
      sse(response, 'content_block_stop', { index: 2 })
      streamedChars += toolInput.length
      record({ kind: 'tool-input', chars: streamedChars })
      close(response, 'tool_use', firstWireTokens)
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
  const samples: Array<{ at: number; turnChars: number; turnOutputTokens: number | null; streamBlock: string | null }> = []
  const sampler = setInterval(() => {
    const folder = join(daemonDir, 'session-tail')
    if (!existsSync(folder)) return
    for (const name of readdirSync(folder).filter(name => name.endsWith('.json'))) {
      try {
        const tail = JSON.parse(readFileSync(join(folder, name), 'utf8')) as { turnChars?: number; turnOutputTokens?: number; streamBlock?: string }
        samples.push({ at: Date.now(), turnChars: tail.turnChars ?? 0, turnOutputTokens: typeof tail.turnOutputTokens === 'number' ? tail.turnOutputTokens : null, streamBlock: tail.streamBlock ?? null })
      } catch {
        return
      }
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
      { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'count the wire\r' },
      { requireAwait: true, awaitText: ' tokens · ', awaitSettleTicks: 3, data: '', mark: 'estimate' },
      { requireAwait: true, awaitText: firstLeg, awaitSettleTicks: 12, data: '', mark: 'fact' },
      { requireAwait: true, awaitText: secondLeg, awaitSettleTicks: 5, data: '', mark: 'complete' },
    ]
    writeFileSync(config, JSON.stringify({ argv: [resolveCaptureArgv0(runtime, driver), dist, '--model', model, '--permission-mode', 'default'], cwd, cols, rows, sends, out, total: 300, readyText: secondLeg, readySettleTicks: 2, liveSeat: true, ...(process.platform === 'win32' ? { hostProfile: 'wt' } : {}) }))
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
    const estimateAt = payload.sendReceipts?.[2]?.ts ?? startedAt
    const factAt = payload.sendReceipts?.[3]?.ts ?? startedAt
    const estimateText = marks.estimate ? textOf(marks.estimate) : ''
    const factText = marks.fact ? textOf(marks.fact) : ''
    writeFileSync(join(home, 'estimate.txt'), `${estimateText}\n`)
    writeFileSync(join(home, 'fact.txt'), `${factText}\n`)
    const firstUsageAt = wire.find(row => row.kind === 'usage' && row.chars === firstWireTokens)?.at ?? Number.POSITIVE_INFINITY
    const estimateFigure = figureOf(estimateText)
    const charsByEstimate = wire.filter(row => row.chars !== undefined && row.kind !== 'usage' && row.at <= estimateAt).at(-1)?.chars ?? 0
    check(`${geometry} estimate: the mark landed before the first usage frame`, estimateAt < firstUsageAt, `mark=${estimateAt} usage=${firstUsageAt}`)
    check(`${geometry} estimate: before any usage frame the row paints the characters-over-four figure with its ~ mark`, estimateFigure !== null && estimateFigure.estimate && estimateFigure.count <= Math.floor(charsByEstimate / 4) + (cols >= 100 ? 50 : 0), JSON.stringify({ figure: estimateFigure, chars: charsByEstimate }))
    const factFigure = figureOf(factText)
    const secondUsageAt = wire.find(row => row.kind === 'usage' && row.chars === secondWireTokens)?.at ?? Number.POSITIVE_INFINITY
    check(`${geometry} fact: the mark landed after the first usage frame and before the second`, factAt > firstUsageAt && factAt < secondUsageAt, `mark=${factAt} first=${firstUsageAt} second=${secondUsageAt}`)
    check(`${geometry} fact: the row's figure IS the wire's output tokens for the first message (${firstWireTokens}), told as a fact`, factFigure !== null && !factFigure.estimate && factFigure.count === firstWireTokens, JSON.stringify(factFigure))
    const factSample = samples.filter(sample => sample.at <= factAt).at(-1)
    check(`${geometry} fact: the tail projection carries the wire figure beside the character count`, factSample !== undefined && factSample.turnOutputTokens === firstWireTokens && factSample.turnChars > 0, JSON.stringify(factSample))
    check(`${geometry}: the Read ran and the second request arrived with its result`, wire.some(row => row.kind === 'second-request'))
    const completeText = marks.complete ? textOf(marks.complete) : ''
    check(`${geometry}: the second leg painted after the turn`, completeText.includes(secondLeg))
    const last = samples.at(-1)
    check(`${geometry}: the result clears the wire figure with the character count`, last !== undefined && last.turnOutputTokens === null && last.turnChars === 0, JSON.stringify(last))
    const peak = samples.filter(sample => sample.turnOutputTokens !== null).map(sample => sample.turnOutputTokens!)
    check(`${geometry}: the projection's figure only ever names a wire total (${firstWireTokens} or ${firstWireTokens + secondWireTokens}), never a partial estimate`, peak.length > 0 && peak.every(value => value === firstWireTokens || value === firstWireTokens + secondWireTokens), JSON.stringify([...new Set(peak)]))
    writeFileSync(join(home, 'tail-samples.json'), `${JSON.stringify(samples, null, 2)}\n`)
    writeFileSync(join(home, 'measurements.json'), `${JSON.stringify({ dist, scratch: home, geometry, estimateAt, factAt, firstUsageAt, secondUsageAt, estimateFigure, factFigure, charsByEstimate }, null, 2)}\n`)
    if (frames) {
      const destination = join(resolve(frames), geometry)
      mkdirSync(destination, { recursive: true })
      for (const name of ['capture.json', 'grid.json', 'estimate.txt', 'fact.txt', 'wire.jsonl', 'measurements.json', 'tail-samples.json']) {
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
