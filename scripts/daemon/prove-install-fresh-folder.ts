#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const DEPLOY = join(REPO, 'scripts', 'ops', 'deploy-runtime.sh')
const PACK_NODE = join(REPO, 'dist', 'vendor', 'node', 'bin', 'node')
if (!existsSync(DIST) || !existsSync(join(REPO, 'dist', 'manifest.json'))) {
  console.error('dist/mercury.mjs or dist/manifest.json missing — run `bun run build.ts` first')
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-install-fresh-folder: the deploy script is a POSIX road — not staged on win32')
  process.exit(0)
}
const NODE = existsSync(PACK_NODE) ? PACK_NODE : (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
const KEEP = process.env.FRESH_FOLDER_KEEP === '1'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {}
    await sleep(everyMs)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-install-fresh-folder exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'install-fresh-folder-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const runtime = join(home, 'runtime')
const oldDist = join(runtime, 'dist')
for (const d of [home, daemonDir, work, join(oldDist, 'vendor', 'node', 'bin'), join(runtime, 'dist.prev')]) mkdirSync(d, { recursive: true })
for (const k of ['MERCURY_HOME', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_LAUNCHER', 'MERCURY_DIST', 'MERCURY_NODE']) delete process.env[k]
spawnSync('git', ['-C', work, 'init', '-q'])
copyFileSync(DIST, join(oldDist, 'mercury.mjs'))
const repoManifest = JSON.parse(readFileSync(join(REPO, 'dist', 'manifest.json'), 'utf8')) as Record<string, unknown>
writeFileSync(join(oldDist, 'manifest.json'), JSON.stringify({ ...repoManifest, buildTree: 'o'.repeat(40) }, null, 2))
copyFileSync(NODE, join(oldDist, 'vendor', 'node', 'bin', 'node'))
spawnSync('chmod', ['+x', join(oldDist, 'vendor', 'node', 'bin', 'node')])
writeFileSync(join(runtime, 'dist.prev', 'mercury.mjs'), 'console.log("Mercury 0.0.0-prev")\n')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const inode = (p: string): number => {
  try {
    return statSync(p).ino
  } catch {
    return -1
  }
}
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
const isRealDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}
const psCommand = (pid: number): string => (spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const deployEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_LAUNCHER: join(home, 'bin', 'mercury'),
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
})
const deploy = (): { rc: number; out: string } => {
  const r = spawnSync('bash', [DEPLOY, '--allow-dirty'], { cwd: REPO, encoding: 'utf8', env: deployEnv(), maxBuffer: 1 << 26 })
  return { rc: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const buildsDir = join(runtime, 'builds')
const buildFolders = (): string[] => (existsSync(buildsDir) ? readdirSync(buildsDir).filter(n => !n.startsWith('.')) : [])
const launcherVersion = (): { rc: number; out: string; dist: string } => {
  const r = spawnSync('bash', ['-x', join(home, 'bin', 'mercury'), '--version'], {
    cwd: SCRATCH,
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_NO_BANNER: '1', MERCURY_SPLASH: 'off', MERCURY_CREDENTIAL_STORE: 'file' },
  })
  const trace = r.stderr ?? ''
  const dist = /MERCURY_DIST=([^\n]*mercury\.mjs)/.exec(trace)?.[1]?.replace(/^['"]|['"]$/g, '') ?? ''
  return { rc: r.status ?? -1, out: (r.stdout ?? '').trim(), dist }
}

const logPath = join(SCRATCH, 'daemon.log')
const daemonScript = join(oldDist, 'mercury.mjs')
const daemonNode = join(oldDist, 'vendor', 'node', 'bin', 'node')
const daemon: ChildProcess = spawn(daemonNode, [daemonScript, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_OWNER_PID: String(process.pid),
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_WARM_RUNNER: '0',
  },
  stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
})
const dpid = daemon.pid ?? 0
let exited = false
daemon.once('exit', () => {
  exited = true
})
const cleanup = async (): Promise<void> => {
  if (!exited) {
    try {
      daemon.kill('SIGTERM')
    } catch {}
    await untilAsync(() => exited, 8_000)
    try {
      daemon.kill('SIGKILL')
    } catch {}
  }
  if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

try {
  section('§1 the layout before this install: runtime/dist is a real folder with a live daemon in it')
  check('the fixture daemon booted from runtime/dist', await untilAsync(() => read(logPath).includes('control socket up'), 60_000), read(logPath).slice(-500))
  const bundleInode = inode(daemonScript)
  const nodeInode = inode(daemonNode)
  const commandBefore = psCommand(dpid)
  check('runtime/dist is a real folder, not a link', isRealDir(oldDist) && !isLink(oldDist))
  check('the daemon runs the bundle and the node of that folder', commandBefore.startsWith(daemonNode) && commandBefore.includes(daemonScript), commandBefore)
  check('a rollback copy of the older layout lies beside it (runtime/dist.prev)', existsSync(join(runtime, 'dist.prev', 'mercury.mjs')))

  section('§2 the install over the running daemon: a fresh folder, a switched pointer, the live folder untouched')
  const first = deploy()
  check('the deploy succeeded', first.rc === 0, first.out.slice(-800))
  console.log(`  ${first.out.split('\n').filter(l => /deployed runtime|left in place|dist\.prev|kept/.test(l)).join('\n  ')}`)
  check('the daemon is still alive after the install', alive(dpid) && !exited, read(logPath).slice(-300))
  check("the daemon's program file is where it was: runtime/dist/vendor/node/bin/node is the same inode", inode(daemonNode) === nodeInode, `before ${nodeInode} after ${inode(daemonNode)}`)
  check("the daemon's bundle is where it was: runtime/dist/mercury.mjs is the same inode (the folder was neither moved nor rewritten)", inode(daemonScript) === bundleInode, `before ${bundleInode} after ${inode(daemonScript)}`)
  check('runtime/dist is still the same real folder (never renamed away from under the daemon)', isRealDir(oldDist) && !isLink(oldDist) && existsSync(join(oldDist, 'manifest.json')) && (JSON.parse(read(join(oldDist, 'manifest.json'))) as { buildTree?: string }).buildTree === 'o'.repeat(40))
  check("the daemon's command line still names the same paths", psCommand(dpid) === commandBefore, psCommand(dpid))
  check('no runtime/dist.prev survives the install: nothing ran from the rollback copy, so it is gone, and the live folder was not renamed into it', !existsSync(join(runtime, 'dist.prev')), readdirSync(runtime).join(', '))
  const folders = buildFolders()
  check('the new build landed in a fresh folder under runtime/builds/<tree>-<bundle>', folders.length === 1 && /^[0-9a-f]{12}-[0-9a-f]{8}$/.test(folders[0] ?? ''), folders.join(', '))
  const fresh = join(buildsDir, folders[0] ?? 'none')
  check('…carrying the bundle, its manifest and the runtime manifest', existsSync(join(fresh, 'mercury.mjs')) && existsSync(join(fresh, 'manifest.json')) && existsSync(join(fresh, 'runtime-manifest.json')))
  const freshManifest = ((): { bundleSha256?: string } => {
    try {
      return JSON.parse(read(join(fresh, 'manifest.json'))) as { bundleSha256?: string }
    } catch {
      return {}
    }
  })()
  check('…with the bytes of the build that was deployed', freshManifest.bundleSha256 === repoManifest.bundleSha256)
  check('runtime/current is a link to that fresh folder', isLink(join(runtime, 'current')) && realpathSync(join(runtime, 'current')) === realpathSync(fresh), `${existsSync(join(runtime, 'current')) ? readlinkSync(join(runtime, 'current')) : 'absent'}`)
  check('the link target is relative (a home that moves keeps working)', isLink(join(runtime, 'current')) && readlinkSync(join(runtime, 'current')) === join('builds', folders[0] ?? ''), isLink(join(runtime, 'current')) ? readlinkSync(join(runtime, 'current')) : 'absent')
  const lv = launcherVersion()
  check('the deploy published the launcher beside the runtime', existsSync(join(home, 'bin', 'mercury')))
  check('the launcher boots and answers Mercury <version>', lv.rc === 0 && /^Mercury \d/.test(lv.out), `rc=${lv.rc} out=${lv.out.slice(0, 80)}`)
  check('…from runtime/current — the new build — while runtime/dist still holds the old folder', lv.dist.includes(`${join(runtime, 'current')}/`), lv.dist || '(no MERCURY_DIST in the trace)')

  section('§3 once nothing runs from the old folder, the next install replaces it with the link')
  daemon.kill('SIGTERM')
  check('the fixture daemon stopped', await untilAsync(() => exited, 15_000))
  const second = deploy()
  check('the second deploy succeeded', second.rc === 0, second.out.slice(-800))
  check('runtime/dist is now a link, the old real folder gone', isLink(oldDist), isRealDir(oldDist) ? 'still a real folder' : 'absent')
  check('runtime/current and runtime/dist name the same build', isLink(join(runtime, 'current')) && isLink(oldDist) && realpathSync(join(runtime, 'current')) === realpathSync(oldDist))
  check('exactly one build folder remains (the deployed bytes; nothing runs from any other)', buildFolders().length === 1, buildFolders().join(', '))
  const lv2 = launcherVersion()
  check('the launcher still boots the deployed build', lv2.rc === 0 && /^Mercury \d/.test(lv2.out) && lv2.dist.includes(`${join(runtime, 'current')}/`), `rc=${lv2.rc} ${lv2.dist}`)

  section('§4 the readers of the old name keep working through the link')
  {
    const launcher = read(join(REPO, 'scripts/ops/launcher-mercury.sh'))
    check('the launcher reads runtime/current first and falls back to runtime/dist', launcher.includes('runtime/current/mercury.mjs') && launcher.includes('MERCURY_RUNTIME_DIR="$MERCURY_HOME/runtime/dist"'))
    const handover = read(join(REPO, 'src/daemon/handover.ts'))
    check("the daemon's deployed-runtime reader walks current, then dist", /RUNTIME_POINTER_NAMES = \['current', 'dist'\]/.test(handover))
    const script = read(DEPLOY)
    check('the deploy switches every pointer by rename(2), never a shell mv over a link', script.includes("python3 -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])'") && !/mv "\$runtime\/dist" "\$runtime\/dist\.prev"/.test(script))
    check('the deploy never renames a folder something runs from', script.includes('runtime_folder_in_use') && !/mv "\$runtime\/dist"/.test(script))
    check('the docs name the layout and the manual rollback', /runtime\/builds\/<tree>-<bundle>/.test(read(join(REPO, 'docs/TERMINAL-RUNTIME.md'))) && /ln -sfn builds\/<older>/.test(read(join(REPO, 'docs/TERMINAL-RUNTIME.md'))))
  }
} finally {
  await cleanup()
}
console.log(`\n${failures === 0 ? '✅ prove-install-fresh-folder: ALL PASS' : `❌ prove-install-fresh-folder: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
