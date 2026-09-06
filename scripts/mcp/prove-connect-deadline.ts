#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-deadline-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_MCP_TIMEOUT_MS = '1500'
const DEADLINE_LABEL = '1.5s'
const SETTLE_BUDGET_MS = 8_000
const FIXTURE_MARK = `mcp-frozen-fixture-${process.pid}`
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — connect-deadline prover exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const mcp = await import('../../src/services/mcp/client.ts')

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function listenFrozen(): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => {
    socket.on('error', () => {})
  })
  for (let port = 37040; port < 37100; port++) {
    const landed = await new Promise<boolean>(resolve => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (landed) return { server, port }
  }
  throw new Error('no free fixture port in 37000–37099')
}

async function connectOnce(name: string, config: Record<string, unknown>): Promise<{ outcome: Record<string, unknown>; wallMs: number }> {
  const scoped = { ...config, scope: 'local' } as never
  const started = Date.now()
  const { client: outcome } = await mcp.reconnectMcpServerImpl(name, scoped)
  return { outcome: outcome as unknown as Record<string, unknown>, wallMs: Date.now() - started }
}

console.log('============================================================')
console.log(' MCP connect deadline — every transport, honest reason')
console.log('============================================================')

section('§1 stdio — frozen child settles failed; reason honest; the WHOLE TREE gone')
{
  const gcMarker = join(SCRATCH, 'grandchild.pid')
  const grandchildScript = `process.title=${JSON.stringify(`${FIXTURE_MARK}-grandchild`)}; require('fs').writeFileSync(${JSON.stringify(gcMarker)}, String(process.pid)); setInterval(() => {}, 1000)`
  const childScript =
    `process.title=${JSON.stringify(FIXTURE_MARK)}; ` +
    `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: 'ignore' }).unref(); ` +
    `setInterval(() => {}, 1000)`
  const { outcome, wallMs } = await connectOnce('frozen-stdio', {
    type: 'stdio',
    command: process.execPath,
    args: ['-e', childScript],
    env: {},
  })
  t('§1 settles failed (never hangs)', outcome.type === 'failed', `type=${String(outcome.type)}`)
  t('§1 within the deadline + slack', wallMs < SETTLE_BUDGET_MS, `${wallMs}ms`)
  const error = String(outcome.error ?? '')
  t('§1 reason names the transport', error.includes('(stdio)'), error)
  t(`§1 reason names the seconds (${DEADLINE_LABEL})`, error.includes(`did not answer in ${DEADLINE_LABEL}`), error)
  t('§1 reason points at the retry door', error.includes('retry from /mcp'), error)
  t('§1 the deadline sentence stands alone — no close-class tail', !error.includes('before closing') && !error.includes('server stderr'), error)
  if (process.platform === 'win32') {
    console.log('[SKIP] §1 reap census is pgrep-shaped on this host; the win32 arm rides the field leg')
  } else {
    const { execFileSync } = await import('node:child_process')
    const frozenPids = (): { readable: boolean; pids: string } => {
      try {
        return { readable: true, pids: execFileSync('pgrep', ['-f', FIXTURE_MARK], { encoding: 'utf8' }).trim() }
      } catch (error) {
        if ((error as { status?: number }).status === 1) return { readable: true, pids: '' }
        return { readable: false, pids: `census unreadable: ${(error as Error).message}` }
      }
    }
    const { existsSync: markerExists, readFileSync: readMarker } = await import('node:fs')
    let markerSeen = markerExists(gcMarker)
    const markerDeadline = Date.now() + 3_000
    while (!markerSeen && Date.now() < markerDeadline) {
      await new Promise(r => setTimeout(r, 100))
      markerSeen = markerExists(gcMarker)
    }
    t('§1 the frozen server forked its grandchild (the marker landed)', markerSeen, gcMarker)
    let census = frozenPids()
    const reapDeadline = Date.now() + 6_000
    while (census.readable && census.pids !== '' && Date.now() < reapDeadline) {
      await new Promise(r => setTimeout(r, 200))
      census = frozenPids()
    }
    t('§1 no frozen child survives the timeout (bounded ladder)', census.readable && census.pids === '', census.pids)
    const gcPid = markerSeen ? Number(readMarker(gcMarker, 'utf8').trim()) : NaN
    t(
      '§1 the GRANDCHILD died with the tree — a never-connected server has a kill owner (w4-f05-02)',
      Number.isFinite(gcPid) && gcPid > 0 && !alive(gcPid),
      `grandchild pid ${gcPid}`,
    )
  }
}

section('§1b the never-connected tree has ONE kill owner (w4-f05-02, source pins)')
{
  const clientSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'mcp', 'client.ts'), 'utf8')
  t('§1b the one stdio kill owner exists', clientSrc.includes('const endStdioTree = async (): Promise<void> => {'))
  const timeoutAt = clientSrc.indexOf('const timeoutPromise = new Promise<never>')
  const timeoutBody = timeoutAt !== -1 ? clientSrc.slice(timeoutAt, clientSrc.indexOf('}, connectTimeoutMs())', timeoutAt)) : ''
  t(
    '§1b the TIMEOUT arm reaches the owner, with the reject-before-close order intact',
    timeoutBody.includes('reject(') && timeoutBody.indexOf('reject(') !== -1 && timeoutBody.indexOf('reject(') < timeoutBody.indexOf('void transport.close()') && timeoutBody.includes('void endStdioTree()'),
  )
  const catchAt = clientSrc.indexOf("if (type === 'sse') logMCPError(name, `SSE connect failed:")
  const catchBody = catchAt !== -1 ? clientSrc.slice(catchAt, clientSrc.indexOf('throw err', catchAt)) : ''
  t('§1b the connect-failure catch reaches the owner too', catchBody.includes('await endStdioTree()'))
  t('§1b the connected cleanup rides the SAME owner — exactly one graceful walk in the file', (clientSrc.match(/endProcessTree\(pid, 'SIGINT'\)/g) ?? []).length === 1)
}

section('§2 sse — frozen loopback settles failed with the honest reason')
{
  const { server, port } = await listenFrozen()
  const { outcome, wallMs } = await connectOnce('frozen-sse', { type: 'sse', url: `http://127.0.0.1:${port}/sse` })
  server.close()
  t('§2 settles failed (never hangs)', outcome.type === 'failed', `type=${String(outcome.type)}`)
  t('§2 within the deadline + slack', wallMs < SETTLE_BUDGET_MS, `${wallMs}ms`)
  const error = String(outcome.error ?? '')
  t('§2 reason names transport + seconds', error.includes('(sse)') && error.includes(`did not answer in ${DEADLINE_LABEL}`), error)
}

section('§3 http — frozen loopback settles failed with the honest reason')
{
  const { server, port } = await listenFrozen()
  const { outcome, wallMs } = await connectOnce('frozen-http', { type: 'http', url: `http://127.0.0.1:${port}/mcp` })
  server.close()
  t('§3 settles failed (never hangs)', outcome.type === 'failed', `type=${String(outcome.type)}`)
  t('§3 within the deadline + slack', wallMs < SETTLE_BUDGET_MS, `${wallMs}ms`)
  const error = String(outcome.error ?? '')
  t('§3 reason names transport + seconds', error.includes('(http)') && error.includes(`did not answer in ${DEADLINE_LABEL}`), error)
}

section('§4 sdk — a control host that never answers settles the batch')
{
  const started = Date.now()
  const settled = await Promise.race([
    mcp.setupSdkMcpClients(
      { 'frozen-sdk': { type: 'host' } as never },
      () => new Promise(() => {}),
    ),
    new Promise<null>(r => setTimeout(() => r(null), SETTLE_BUDGET_MS)),
  ])
  const wallMs = Date.now() - started
  t('§4 the batch settles (the deadline exists at the sdk site)', settled !== null, `still pending after ${wallMs}ms`)
  if (settled !== null) {
    const rows = (settled as { clients: Array<Record<string, unknown>> }).clients
    t('§4 the row is failed', rows.length === 1 && rows[0]!.type === 'failed', JSON.stringify(rows.map(r => r.type)))
    const error = String(rows[0]?.error ?? '')
    t('§4 reason names transport + seconds', error.includes('(sdk)') && error.includes(`did not answer in ${DEADLINE_LABEL}`), error)
  }
}

section('§5 the gauge detail carries the failed reason verbatim (source pin)')
{
  const { readFileSync } = await import('node:fs')
  const gauge = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/cockpit/mcpGauge.ts'), 'utf8')
  t('§5 failed detail embeds the connection error', gauge.includes('connection failed${error ? `: ${error}`'))
  const client = readFileSync(join(import.meta.dir, '..', '..', 'src/services/mcp/client.ts'), 'utf8')
  t('§5 every deadline reason shares the one grammar', (client.match(/did not answer in /g) ?? []).length >= 2)
}

section('§6 the advertised deadline is the whole truth — one burn per retry')
{
  const spawnLog = join(SCRATCH, 'retry-spawn-log.txt')
  const { outcome, wallMs } = await connectOnce('frozen-retry', {
    type: 'stdio',
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').appendFileSync(process.env.MCP_SPAWN_LOG, process.pid + '\\n'); process.title=${JSON.stringify(FIXTURE_MARK)}; setInterval(() => {}, 1000)`,
    ],
    env: { MCP_SPAWN_LOG: spawnLog },
  })
  t('§6 settles failed (never hangs)', outcome.type === 'failed', `type=${String(outcome.type)}`)
  const error = String(outcome.error ?? '')
  t(`§6 the line advertises ${DEADLINE_LABEL}`, error.includes(`did not answer in ${DEADLINE_LABEL}`), error)
  const spawns = ((): string[] => {
    try {
      return readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  })()
  t('§6 one retry spawns ONE child (no probe connect inside the disconnect)', spawns.length === 1, `spawned ${spawns.length}: ${spawns.join(', ')}`)
  t('§6 wall clock is one deadline, not two', wallMs >= 1400 && wallMs < 2800, `${wallMs}ms`)
  const spawnedPids = spawns.map(Number).filter(pid => Number.isFinite(pid) && pid > 0)
  let survivors = spawnedPids.filter(alive)
  const reapDeadline = Date.now() + 6_000
  while (survivors.length > 0 && Date.now() < reapDeadline) {
    await new Promise(r => setTimeout(r, 200))
    survivors = spawnedPids.filter(alive)
  }
  t('§6 the retry child dies with the drive (bounded ladder)', survivors.length === 0, `pids: ${survivors.join(', ')}`)
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
}

console.log(failures === 0 ? '\nPASS prove-connect-deadline' : `\nFAIL prove-connect-deadline (${failures})`)
process.exit(failures === 0 ? 0 : 1)
