#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('__SUITE_SKIPPED restart-starts-installed-daemon: dist/mercury.mjs absent — build first')
  process.exit(0)
}
const NODE = (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
if (NODE === '') {
  console.error('no node on PATH')
  process.exit(1)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'restart-installed-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const build = join(home, 'runtime', 'builds', 'installed')
for (const d of [home, daemonDir, work, build]) mkdirSync(d, { recursive: true })
const TREE = '777766665555'.padEnd(40, '0')
copyFileSync(DIST, join(build, 'mercury.mjs'))
const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8')) as Record<string, unknown>
manifest.buildTree = TREE
writeFileSync(join(build, 'manifest.json'), JSON.stringify(manifest, null, 2))
writeFileSync(join(work, 'README.md'), '# fixture\n')

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DAEMON_PERMISSION_MODE = 'sovereign'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_PARTY = '0'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const commandLineOf = (pid: number): string => (spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()

console.log('============================================================')
console.log(' /restart with no daemon serving starts the INSTALLED build\'s own daemon')
console.log(' the caller is a source process here (bun on this proof), as a screen of an older build would be — the daemon it starts must run the installed bundle, never the caller\'s own script')
console.log('============================================================')

const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { handshakeDaemon } = await import('../../src/daemon/handshake.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const restart = await import('../../src/commands/restart/restart.ts')
const { sameBuildTree } = await import('../../src/daemon/planeBoot.ts')

try {
  const before = await handshakeDaemon({ timeoutMs: 500 })
  check('no daemon serves before the restart road runs', before.state === 'absent', before.state)
  const installed = { script: join(build, 'mercury.mjs'), buildTree: TREE, dir: build, node: NODE, layout: 'source' as const, version: null }
  const verdict = await runWithCwdOverride(work, () => restart.startInstalledDaemon(installed))
  const pid = verdict.daemon?.pid ?? null
  check('a daemon answers the handshake within the wait', verdict.daemon !== null && verdict.state !== 'starting' && verdict.state !== 'absent', `${verdict.state} · ${verdict.line ?? ''}`)
  check('…and it is the installed build (its tree), not another', verdict.daemon !== null && sameBuildTree(verdict.daemon.buildTree, TREE), String(verdict.daemon?.buildTree))
  const command = pid === null ? '' : commandLineOf(pid)
  check('…its process runs the installed bundle, not the calling process\'s script', command.includes(join(build, 'mercury.mjs')) && !command.includes('prove-restart-starts-installed-daemon'), command.slice(0, 200))
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 8_000 })
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500))
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-restart-starts-installed-daemon: ALL LAWS HOLD' : `\nprove-restart-starts-installed-daemon: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
