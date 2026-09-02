#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-connect-deadline.ts — one connect deadline for EVERY
//  transport, with the honest reason.
//
//  THE LAW: no MCP connect runs without a deadline; a frozen server (accepts,
//  never completes the handshake) settles as a failed row within the deadline;
//  the reason names the TRANSPORT and the SECONDS and points at /mcp retry;
//  a timed-out stdio server leaves no child behind.
//
//    §1 stdio — a child that answers nothing: failed within the deadline,
//       reason `(stdio) did not answer in <n>s`, child gone;
//    §2 sse — a loopback socket that accepts and sends no bytes;
//    §3 http — the same frozen socket under the http transport;
//    §4 sdk — a control channel whose host never responds: the batch
//       settles (the site carries its own deadline race);
//    §5 the roster line: the gauge's failed detail carries the honest
//       reason verbatim (source pin on the message shape);
//    §6 the retry door burns ONE deadline: a cold-memo reconnect spawns
//       exactly one child and settles in about one deadline — never the
//       sequential double the field measured (60.041s printed as "30s",
//       F-4.1: clearServerCache dialing a probe connect to find a client
//       to tear down).
//
//  Poison control (base A/B): on the base, §4 never settles (observed as a
//  bounded race staying pending) and §1–§3 reasons name neither transport
//  nor seconds. For §6, restoring the probe connect inside clearServerCache
//  doubles both the spawn count and the wall clock.
//
//  Hermetic: scratch config home, loopback fixture port from 37000–37099,
//  no live wires. Run:  ~/.bun/bin/bun run scripts/mcp/prove-connect-deadline.ts
// ============================================================================
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
// The deadline under proof: 1.5s (the label law prints "1.5s").
process.env.MCP_TIMEOUT = '1500'
const DEADLINE_LABEL = '1.5s'
const SETTLE_BUDGET_MS = 8_000
// Per-run fixture marker: the reap census greps for it, so it must never
// match another run's (or another agent's) leaked child.
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

/** A loopback socket that ACCEPTS and never sends a byte — the frozen wire.
 *  Fixture port from the 37000–37099 range; first free one wins. */
async function listenFrozen(): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => {
    // Hold the connection open; answer nothing.
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
  // The never-throws door every roster path uses: a failed connect returns a
  // failed row instead of throwing.
  const { client: outcome } = await mcp.reconnectMcpServerImpl(name, scoped)
  return { outcome: outcome as unknown as Record<string, unknown>, wallMs: Date.now() - started }
}

console.log('============================================================')
console.log(' MCP connect deadline — every transport, honest reason')
console.log('============================================================')

// ── §1 stdio ────────────────────────────────────────────────────────────────
section('§1 stdio — frozen child settles failed; reason honest; the WHOLE TREE gone')
{
  // The frozen server FORKS a detached, marked grandchild that writes its
  // pid to a marker file — the w4-f05-02 shape: transport.close() ends the
  // direct child alone, so a never-connected server's grandchildren used to
  // outlive the timeout with no kill owner at all.
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
  // The frozen child is ended by the timed-out transport's close — a staged
  // ladder (stdin EOF grace, then SIGTERM, then SIGKILL), bounded at ~4s.
  // Poll to that bound plus slack rather than sampling inside the grace.
  if (process.platform === 'win32') {
    // The reap census is pgrep-shaped; a silent empty answer here once made
    // this assertion pass vacuously on win32 (field F-4.2). The win32 arm is
    // proven on the field leg (TASK-016 leg 4, via Win32_Process) — skip
    // loudly instead of passing blind.
    console.log('[SKIP] §1 reap census is pgrep-shaped on this host; the win32 arm rides the field leg')
  } else {
    const { execFileSync } = await import('node:child_process')
    // pgrep exits 1 when nothing matches — that IS the clean answer. Any
    // other failure (pgrep missing, exec error) must fail the row rather
    // than read as "no survivors".
    const frozenPids = (): { readable: boolean; pids: string } => {
      try {
        return { readable: true, pids: execFileSync('pgrep', ['-f', FIXTURE_MARK], { encoding: 'utf8' }).trim() }
      } catch (error) {
        if ((error as { status?: number }).status === 1) return { readable: true, pids: '' }
        return { readable: false, pids: `census unreadable: ${(error as Error).message}` }
      }
    }
    // The grandchild's marker proves the fork HAPPENED — without it the
    // tree assertion below would pass vacuously on a fixture whose spawn
    // silently failed.
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

// ── §2 sse ──────────────────────────────────────────────────────────────────
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

// ── §3 http ─────────────────────────────────────────────────────────────────
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

// ── §4 sdk ──────────────────────────────────────────────────────────────────
section('§4 sdk — a control host that never answers settles the batch')
{
  const started = Date.now()
  const settled = await Promise.race([
    mcp.setupSdkMcpClients(
      { 'frozen-sdk': { type: 'sdk' } as never },
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

// ── §5 the roster line carries the reason ───────────────────────────────────
section('§5 the gauge detail carries the failed reason verbatim (source pin)')
{
  const { readFileSync } = await import('node:fs')
  const gauge = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/cockpit/mcpGauge.ts'), 'utf8')
  t('§5 failed detail embeds the connection error', gauge.includes('connection failed${error ? `: ${error}`'))
  const client = readFileSync(join(import.meta.dir, '..', '..', 'src/services/mcp/client.ts'), 'utf8')
  t('§5 every deadline reason shares the one grammar', (client.match(/did not answer in /g) ?? []).length >= 2)
}

// ── §6 the retry door burns ONE deadline ────────────────────────────────────
section('§6 the advertised deadline is the whole truth — one burn per retry')
{
  // The exact field shape (F-4.1): a COLD memo — no prior connect under this
  // name in this process — through reconnectMcpServerImpl, the door the
  // deadline line's own "retry from /mcp" advertises. Each child the door
  // spawns appends its pid to the log, so the count is structural, not
  // inferred from timing: the sequential double (clearServerCache opening a
  // probe connect to find a client to tear down) spawns two children and
  // takes two deadlines; the honest door spawns one and takes one.
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
  // Wall clock corroboration at MCP_TIMEOUT=1500: one burn lands near one
  // deadline; the double measured exactly 2x in the field (60.041s at 30s,
  // 10.045s at 5s). The window [deadline, 2x deadline - margin) separates
  // them with slack for spawn overhead on a loaded box.
  t('§6 wall clock is one deadline, not two', wallMs >= 1400 && wallMs < 2800, `${wallMs}ms`)
  // The retry door's frozen child is reaped by the same bounded ladder §1
  // pins — awaited HERE by exact pid, because the ladder runs after the
  // reject and a prover that exits first cuts it mid-flight and leaks the
  // child (exact-pid poll, so this arm holds on win32 too).
  const spawnedPids = spawns.map(Number).filter(pid => Number.isFinite(pid) && pid > 0)
  let survivors = spawnedPids.filter(alive)
  const reapDeadline = Date.now() + 6_000
  while (survivors.length > 0 && Date.now() < reapDeadline) {
    await new Promise(r => setTimeout(r, 200))
    survivors = spawnedPids.filter(alive)
  }
  t('§6 the retry child dies with the drive (bounded ladder)', survivors.length === 0, `pids: ${survivors.join(', ')}`)
  // Fixture hygiene even on a red row: nothing this section spawned may
  // outlive the prover.
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

console.log(failures === 0 ? '\nPASS prove-connect-deadline' : `\nFAIL prove-connect-deadline (${failures})`)
process.exit(failures === 0 ? 0 : 1)
