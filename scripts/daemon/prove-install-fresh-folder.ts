#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

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
const NODE = existsSync(PACK_NODE) ? PACK_NODE : nodeBinPath()
const KEEP = process.env.FRESH_FOLDER_KEEP === '1'
let failures = 0
const failureHint = 'fix scripts/ops/deploy-runtime.sh (how it lays out runtime/builds, runtime/current and runtime/dist beside a live daemon), then rerun; FRESH_FOLDER_KEEP=1 keeps the scratch folder'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? `${detail ? ` — ${detail}` : ''} · ${failureHint}` : ''}`)
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
  console.log('\n❌ TIMEOUT — prove-install-fresh-folder exceeded 240s; it waits for the fixture daemon log to say control socket up and for the deploy to finish, so read the scratch folder daemon.log and scripts/ops/deploy-runtime.sh')
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
const deploy = (extraEnv: Record<string, string> = {}): { rc: number; out: string } => {
  const r = spawnSync('bash', [DEPLOY, '--allow-dirty'], { cwd: REPO, encoding: 'utf8', env: { ...deployEnv(), ...extraEnv }, maxBuffer: 1 << 26 })
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
const dummies: ChildProcess[] = []
const killChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {}
  await untilAsync(() => child.exitCode !== null || child.signalCode !== null, 5_000, 50)
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}
const cleanup = async (): Promise<void> => {
  await Promise.all(dummies.map(killChild))
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

  section('§4 swarm ps road: 40 live processes carrying a build path keep that folder under pipefail (no SIGPIPE false-free)')
  {
    const swarmBuild = join(buildsDir, 'aaaaaaaaaaaa-11111111')
    mkdirSync(swarmBuild, { recursive: true })
    writeFileSync(join(swarmBuild, 'manifest.json'), JSON.stringify({ ...repoManifest, buildTree: 'a'.repeat(40) }, null, 2))
    writeFileSync(join(swarmBuild, 'mercury.mjs'), 'console.log("Mercury 0.0.0-swarm")\n')
    const holdBin = join(swarmBuild, 'hold-node')
    copyFileSync(NODE, holdBin)
    spawnSync('chmod', ['+x', holdBin])
    const swarmChildren: ChildProcess[] = []
    const pad = 'p'.repeat(300)
    for (let i = 0; i < 40; i++) {
      const child = spawn(holdBin, ['-e', 'setTimeout(() => {}, 120000)', pad, String(i)], { stdio: 'ignore' })
      swarmChildren.push(child)
      dummies.push(child)
    }
    const allUp = await untilAsync(() => swarmChildren.every(c => c.pid !== undefined && alive(c.pid) && psCommand(c.pid).includes(`${swarmBuild}/`)), 10_000, 50)
    check('40 dummy processes started carrying the build folder path', allUp && swarmChildren.length === 40)
    const third = deploy()
    check('deploy over 40 matching processes succeeded', third.rc === 0, third.out.slice(-800))
    check('the build folder with 40 live processes is KEPT (never pruned by SIGPIPE under pipefail)', existsSync(swarmBuild) && existsSync(holdBin), `builds: ${buildFolders().join(', ')}`)
    check('the deploy log says kept for the 40-process build folder', third.out.includes(`kept`) && third.out.includes(swarmBuild) && third.out.includes('a daemon or session still runs from it'), third.out.split('\n').filter(l => /kept|deployed/.test(l)).join(' | '))
    await Promise.all(swarmChildren.map(killChild))
  }

  section('§5 lsof road: a copied binary running with manifest.json unopened keeps its build folder (no partial-open exit-1 false-free)')
  {
    const lsofBuild = join(buildsDir, 'bbbbbbbbbbbb-22222222')
    const lsofBinDir = join(lsofBuild, 'vendor', 'node', 'bin')
    mkdirSync(lsofBinDir, { recursive: true })
    writeFileSync(join(lsofBuild, 'manifest.json'), JSON.stringify({ ...repoManifest, buildTree: 'b'.repeat(40) }, null, 2))
    writeFileSync(join(lsofBuild, 'mercury.mjs'), 'console.log("Mercury 0.0.0-lsof")\n')
    const lsofNode = join(lsofBinDir, 'node')
    copyFileSync(NODE, lsofNode)
    spawnSync('chmod', ['+x', lsofNode])
    const holder = spawn('./node', ['-e', 'setTimeout(() => {}, 120000)'], { cwd: lsofBinDir, stdio: 'ignore' })
    dummies.push(holder)
    const holderPid = holder.pid ?? 0
    const holderReady = await untilAsync(() => holderPid > 0 && alive(holderPid) && psCommand(holderPid).includes('./node'), 5_000, 50)
    check('copied vendor/node/bin/node started with relative ./node command line (not carrying build path in ps)', holderReady && !psCommand(holderPid).includes(lsofBuild), psCommand(holderPid))
    const fourth = deploy()
    check('deploy over lsof-only live build succeeded', fourth.rc === 0, fourth.out.slice(-800))
    check('the lsof-only build folder is KEPT while its manifest.json is open in no process', existsSync(lsofBuild) && existsSync(lsofNode), `builds: ${buildFolders().join(', ')}`)
    check('the deploy log says kept for the lsof-only build folder', fourth.out.includes(`kept`) && fourth.out.includes(lsofBuild) && fourth.out.includes('a daemon or session still runs from it'), fourth.out.split('\n').filter(l => /kept|deployed/.test(l)).join(' | '))
    await killChild(holder)
    check('the previous 40-process folder (now free) was pruned once its processes exited', !existsSync(join(buildsDir, 'aaaaaaaaaaaa-11111111')), buildFolders().join(', '))
  }

  section('§6 inventory fallbacks and fail-closed reason: POSIX ps fallback prunes unused and keeps live shell; failed inventory keeps with honest reason')
  {
    const basePath = process.env.PATH ?? '/usr/bin:/bin'
    const realPs = (spawnSync('which', ['ps'], { encoding: 'utf8' }).stdout ?? '').trim() || '/bin/ps'
    const makeStubs = (dirName: string, tools: Record<string, string>): string => {
      const dir = join(SCRATCH, dirName)
      mkdirSync(dir, { recursive: true })
      for (const [tool, body] of Object.entries(tools)) {
        const p = join(dir, tool)
        writeFileSync(p, `#!/bin/sh\n${body}\n`)
        spawnSync('chmod', ['+x', p])
      }
      return `${dir}:${basePath}`
    }
    const seedBuild = (name: string, fill: string): string => {
      const dir = join(buildsDir, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...repoManifest, buildTree: fill.repeat(40) }, null, 2))
      writeFileSync(join(dir, 'mercury.mjs'), `console.log("Mercury 0.0.0-${name}")\n`)
      return dir
    }
    const keptLineFor = (out: string, dir: string): string => out.split('\n').find(l => l.includes('kept') && l.includes(dir)) ?? ''
    const holderReason = '(a daemon or session still runs from it)'
    const unknownReason = '(could not tell whether a process still runs from it)'

    const posixOnlyPsPath = makeStubs('stub-ps-posix', {
      ps: `if [ "$1" = "-axo" ]; then exit 1; fi\nexec "${realPs}" "$@"`,
    })
    const shellBuild = seedBuild('dddddddddddd-44444444', 'd')
    const shellBinDir = join(shellBuild, 'vendor', 'bash', 'host')
    mkdirSync(shellBinDir, { recursive: true })
    const shellBin = join(shellBinDir, 'bash')
    copyFileSync(NODE, shellBin)
    spawnSync('chmod', ['+x', shellBin])
    const shellHolder = spawn(shellBin, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
    dummies.push(shellHolder)
    const shellPid = shellHolder.pid ?? 0
    const shellReady = await untilAsync(() => shellPid > 0 && alive(shellPid) && psCommand(shellPid).includes(`${shellBuild}/vendor/bash/`), 5_000, 50)
    check('live vendor/bash holder started (a file lsof is not asked about)', shellReady)

    const rPosixLive = deploy({ PATH: posixOnlyPsPath })
    const posixLiveLine = keptLineFor(rPosixLive.out, shellBuild)
    check('POSIX-only ps keeps a live vendor/bash folder with the holder reason', rPosixLive.rc === 0 && existsSync(shellBuild) && posixLiveLine.includes(holderReason), `rc=${rPosixLive.rc} exists=${existsSync(shellBuild)} line=${posixLiveLine}`)

    const psFailPath = makeStubs('stub-ps-fail', { ps: 'exit 1' })
    const rPsFailShell = deploy({ PATH: psFailPath })
    const psFailShellLine = keptLineFor(rPsFailShell.out, shellBuild)
    check('failing ps with working lsof still keeps a live vendor/bash folder and logs could-not-tell', rPsFailShell.rc === 0 && existsSync(shellBuild) && psFailShellLine.includes(unknownReason), `rc=${rPsFailShell.rc} exists=${existsSync(shellBuild)} line=${psFailShellLine}`)

    await killChild(shellHolder)
    const rPosixPrune = deploy({ PATH: posixOnlyPsPath })
    check('POSIX-only ps prunes the unused folder once the shell holder exits', rPosixPrune.rc === 0 && !existsSync(shellBuild), `rc=${rPosixPrune.rc} builds=${buildFolders().join(', ')}`)

    const lsofOnlyBuild = seedBuild('eeeeeeeeeeee-55555555', 'e')
    const lsofOnlyBinDir = join(lsofOnlyBuild, 'vendor', 'node', 'bin')
    mkdirSync(lsofOnlyBinDir, { recursive: true })
    const lsofOnlyNode = join(lsofOnlyBinDir, 'node')
    copyFileSync(NODE, lsofOnlyNode)
    spawnSync('chmod', ['+x', lsofOnlyNode])
    const relHolder = spawn('./node', ['-e', 'setTimeout(() => {}, 120000)'], { cwd: lsofOnlyBinDir, stdio: 'ignore' })
    dummies.push(relHolder)
    const relPid = relHolder.pid ?? 0
    await untilAsync(() => relPid > 0 && alive(relPid) && psCommand(relPid).includes('./node'), 5_000, 50)
    const rPsFailRel = deploy({ PATH: psFailPath })
    const psFailRelLine = keptLineFor(rPsFailRel.out, lsofOnlyBuild)
    check('failing ps with working lsof keeps a live ./node holder with the holder reason', rPsFailRel.rc === 0 && existsSync(lsofOnlyBuild) && psFailRelLine.includes(holderReason), `rc=${rPsFailRel.rc} exists=${existsSync(lsofOnlyBuild)} line=${psFailRelLine}`)
    await killChild(relHolder)

    const probeBuild = seedBuild('cccccccccccc-33333333', 'c')
    const rPs = deploy({ PATH: psFailPath })
    const psLine = keptLineFor(rPs.out, probeBuild)
    check('failing ps keeps the build folder and logs could-not-tell instead of holder', rPs.rc === 0 && existsSync(probeBuild) && psLine.includes(unknownReason), `rc=${rPs.rc} exists=${existsSync(probeBuild)} line=${psLine}`)

    const bothFailPath = makeStubs('stub-ps-and-lsof-fail', { ps: 'exit 1', lsof: 'exit 2' })
    const rBoth = deploy({ PATH: bothFailPath })
    const bothLine = keptLineFor(rBoth.out, probeBuild)
    check('failing ps and failing lsof exit 2 keeps the build folder with could-not-tell reason', rBoth.rc === 0 && existsSync(probeBuild) && bothLine.includes(unknownReason), `rc=${rBoth.rc} exists=${existsSync(probeBuild)} line=${bothLine}`)

    const lsofFail2Path = makeStubs('stub-lsof-fail2', { lsof: 'exit 2' })
    const rLsof2 = deploy({ PATH: lsofFail2Path })
    const lsof2Line = keptLineFor(rLsof2.out, probeBuild)
    check('unexpected lsof exit 2 keeps the build folder with could-not-tell reason', rLsof2.rc === 0 && existsSync(probeBuild) && lsof2Line.includes(unknownReason), `rc=${rLsof2.rc} exists=${existsSync(probeBuild)} line=${lsof2Line}`)

    const lsofErr1Path = makeStubs('stub-lsof-err1', { lsof: 'echo "lsof: unexpected permission failure" >&2; exit 1' })
    const rLsof1 = deploy({ PATH: lsofErr1Path })
    const lsof1Line = keptLineFor(rLsof1.out, probeBuild)
    check('unexpected lsof stderr with exit 1 keeps the build folder with could-not-tell reason', rLsof1.rc === 0 && existsSync(probeBuild) && lsof1Line.includes(unknownReason), `rc=${rLsof1.rc} exists=${existsSync(probeBuild)} line=${lsof1Line}`)

    rmSync(oldDist, { recursive: true, force: true })
    mkdirSync(oldDist, { recursive: true })
    writeFileSync(join(oldDist, 'manifest.json'), JSON.stringify({ ...repoManifest, buildTree: 'f'.repeat(40) }, null, 2))
    writeFileSync(join(oldDist, 'mercury.mjs'), 'console.log("Mercury 0.0.0-legacy-dist")\n')
    const distPrev = join(runtime, 'dist.prev')
    mkdirSync(distPrev, { recursive: true })
    writeFileSync(join(distPrev, 'mercury.mjs'), 'console.log("Mercury 0.0.0-legacy-prev")\n')
    const rLegacyFail = deploy({ PATH: psFailPath })
    const distLine = rLegacyFail.out.split('\n').find(l => l.startsWith('runtime/dist ')) ?? ''
    const distPrevLine = rLegacyFail.out.split('\n').find(l => l.startsWith('runtime/dist.prev ')) ?? ''
    check('failing ps keeps legacy runtime/dist and logs could-not-tell instead of daemon running', rLegacyFail.rc === 0 && isRealDir(oldDist) && !isLink(oldDist) && distLine.includes('could not tell whether a process still runs from it'), `rc=${rLegacyFail.rc} line=${distLine}`)
    check('failing ps keeps legacy runtime/dist.prev and logs could-not-tell instead of process running', rLegacyFail.rc === 0 && isRealDir(distPrev) && !isLink(distPrev) && distPrevLine.includes('could not tell whether a process still runs from it'), `rc=${rLegacyFail.rc} line=${distPrevLine}`)

    const rNormal = deploy()
    check('normal deploy prunes the unused folders and restores runtime/dist once ps and lsof succeed', rNormal.rc === 0 && !existsSync(probeBuild) && !existsSync(lsofOnlyBuild) && isLink(oldDist) && !existsSync(distPrev), `rc=${rNormal.rc} builds=${buildFolders().join(', ')}`)
  }
} finally {
  await cleanup()
}
console.log(`\n${failures === 0 ? '✅ prove-install-fresh-folder: ALL PASS' : `❌ prove-install-fresh-folder: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
