#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SUITE_DEADLINE_MS = 120_000
const suiteAlarm = setTimeout(() => {
  console.error(`\n✗ DEADLINE: the suite exceeded ${SUITE_DEADLINE_MS}ms wall clock; the last section header printed above shows what was awaited (server start, initialize, session/new or its child process); look at the acp server under src/integrations/acp/acpServer.ts and its child spawn in src/integrations/acp/childSession.ts`)
  process.exit(1)
}, SUITE_DEADLINE_MS)

const DIST = realpathSync(process.env.ACP_OWN_BUILD_DIST ?? join(process.cwd(), 'dist', 'mercury.mjs'))
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'acp-own-build-'))
const configHome = join(scratch, 'config')
const projDir = join(scratch, 'proj')
const daemonDir = join(scratch, 'daemon')
for (const dir of [configHome, projDir, daemonDir]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configHome

const runtime = join(scratch, 'runtime')
const builds = join(runtime, 'builds')
mkdirSync(builds, { recursive: true })
symlinkSync(dirname(DIST), join(builds, 'live'))
const nextBuild = join(builds, 'next')
mkdirSync(nextBuild)
const marker = join(scratch, 'next-build-ran')
writeFileSync(
  join(nextBuild, 'mercury.mjs'),
  `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' ') + '\\n')\nsetTimeout(() => process.exit(0), 200)\n`,
)
const current = join(runtime, 'current')
symlinkSync(join('builds', 'live'), current)
const pointerScript = join(current, 'mercury.mjs')

const servers: ChildProcess[] = []
process.on('exit', () => {
  for (const s of servers) {
    try {
      s.kill('SIGKILL')
    } catch {
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
  }
})

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configHome, [projDir])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([{ kind: 'text', text: 'never asked' }])
const acp = await import('@agentclientprotocol/sdk')

function childPids(serverPid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(serverPid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}
function argvOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
async function untilTrue(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return cond()
}

section('(1) the server starts through the runtime pointer')
const node = process.execPath.includes('bun') ? 'node' : process.execPath
const server = spawn(node, [pointerScript, 'acp'], {
  cwd: projDir,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configHome,
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CACHE_CLOCK: '0',
  },
})
servers.push(server)
const app = acp.client({ name: 'own-build-proof' })
const stream = acp.ndJsonStream(
  Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>,
)
const conn = app.connect(stream)
const init = await conn.agent.request('initialize', {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
})
check('the server answers initialize', init.protocolVersion === acp.PROTOCOL_VERSION, `${String(init.protocolVersion)} — the acp server (mercury acp, the initialize handler in src/integrations/acp/server/sessionRequests.ts) must answer initialize with the SDK protocol version`)
check('the server itself runs through the pointer path', argvOf(server.pid!).includes(pointerScript), `${argvOf(server.pid!)} — the server process must be started as node <runtime pointer>/mercury.mjs acp; this fixture launch is in section (1) of this proof`)

section('(2) the runtime pointer moves to another build')
const tmpLink = join(runtime, 'current.next')
symlinkSync(join('builds', 'next'), tmpLink)
renameSync(tmpLink, current)
check('the pointer now names the other build', realpathSync(pointerScript) === realpathSync(join(nextBuild, 'mercury.mjs')), `${realpathSync(pointerScript)} — the renameSync swap of the current link in section (2) of this proof did not land; check the runtime link setup at the top of this file`)

section('(3) session/new spawns the build the server booted from')
const created = await conn.agent.request('session/new', { cwd: projDir, mcpServers: [] })
check('a session is created', typeof created.sessionId === 'string' && created.sessionId.length >= 8, `${String(created.sessionId)} — session/new must return a session id of at least 8 characters; look at src/integrations/acp/server/sessionRequests.ts`)
const sawChild = await untilTrue(() => childPids(server.pid!).some(pid => argvOf(pid).includes('mercury.mjs')), 15_000)
const children = childPids(server.pid!).map(pid => argvOf(pid)).filter(line => line.includes('mercury.mjs'))
check('a child session process is running under the server', sawChild && children.length > 0, `${JSON.stringify(children)} — session/new must spawn a child process running mercury.mjs under the server; look at the spawn in src/integrations/acp/childSession.ts`)
check(
  "the child's script is the server's own build (the realpath the link named at boot)",
  children.length > 0 && children.every(line => line.includes(DIST)),
  `${JSON.stringify(children)} — the child must run the script the server booted from; the script comes from selfScriptPath() in src/daemon/control/daemonBuild.ts, passed by src/integrations/acp/server/state.ts to src/integrations/acp/childSession.ts`,
)
check("the child's script is not the pointer path", children.every(line => !line.includes(pointerScript)), `${JSON.stringify(children)} — the child must be spawned with the resolved real path, not the runtime pointer; look at selfScriptPath() in src/daemon/control/daemonBuild.ts and src/integrations/acp/childSession.ts`)
await new Promise(r => setTimeout(r, 1500))
check('the other build never ran', !existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8').trim() + ' — the build the pointer moved to ran; the server must keep spawning its own build (selfScriptPath() in src/daemon/control/daemonBuild.ts, used by src/integrations/acp/childSession.ts) and never re-resolve the runtime pointer' : '')


conn.close()
server.kill('SIGTERM')
await new Promise(r => setTimeout(r, 300))
clearTimeout(suiteAlarm)
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ acp own build: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ acp own build: the editor child runs the build its server started from')
process.exit(0)
