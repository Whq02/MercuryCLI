#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.tsx?$/.test(name)) yield full
  }
}

function codeOnly(raw: string): string {
  const blanked = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  return blanked
    .split('\n')
    .map(line => {
      const t = line.trim()
      return t.startsWith('//') || t.startsWith('*') ? '' : line
    })
    .join('\n')
}

function callSites(code: string, callee: string): number[] {
  const out: number[] = []
  code.split('\n').forEach((line, i) => {
    if (line.includes(`${callee}(`) && !/^\s*import\b/.test(line) && !line.includes(`function ${callee}(`)) out.push(i + 1)
  })
  return out
}

function functionBody(code: string, name: string): string | null {
  const lines = code.split('\n')
  const start = lines.findIndex(line => new RegExp(`function ${name}\\(`).test(line))
  if (start < 0) return null
  const end = lines.findIndex((line, i) => i > start && line === '}')
  return lines.slice(start, end < 0 ? lines.length : end + 1).join('\n')
}

const DAEMON = join(ROOT, 'src', 'daemon')
const SEAM = join(DAEMON, 'daemonHome.ts')
const read = (path: string): string => codeOnly(readFileSync(path, 'utf8'))
const rel = (path: string): string => relative(ROOT, path)

console.log('============================================================')
console.log(' the daemon-home writers census: the seam is the one publish door under src/daemon')
console.log('============================================================')

console.log('\n1 no file under src/daemon publishes through the durable primitive directly')
{
  const offenders: string[] = []
  for (const file of walk(DAEMON)) {
    const code = read(file)
    for (const callee of ['durableAtomicPublishSync', 'durableAtomicPublish']) {
      for (const line of callSites(code, callee)) offenders.push(`${rel(file)}:${line} ${callee}`)
    }
  }
  check('1 every durable publish under src/daemon goes through daemonHome.ts', offenders.length === 0, offenders.join(', ') || 'clean')
}

console.log("\n2 the seam itself: a latch read, a must-stand publish through the authority's door, ENOENT trips the latch")
{
  const seam = read(SEAM)
  check('2 daemonHome.ts exports publishInDaemonHome', /export function publishInDaemonHome\(/.test(seam))
  check("2 the seam publishes with parent 'must-stand'", seam.includes("parent: 'must-stand'"))
  check("2 the seam publishes through the durable-state authority's sync door (fileStore.publishAtomicSync), never the primitive", callSites(seam, 'publishAtomicSync').length >= 1 && seam.includes("from '../substrate/fileStore.js'") && !seam.includes('durablePublish'))
  check("2 the seam reads ENOENT off the publish failure", seam.includes("'ENOENT'"))
}

console.log("\n3 the primitive carries the option and the default keeps every non-daemon caller's shape")
{
  const primitive = read(join(ROOT, 'src', 'substrate', 'durablePublish.ts'))
  check("3 DurablePublishOptions declares parent?: 'create' | 'must-stand'", /parent\?: 'create' \| 'must-stand'/.test(primitive))
  const guarded = primitive.split('\n').filter(line => /mkdir(Sync)?\(dir, \{ recursive: true \}\)/.test(line))
  check('3 both twins create the parent only when the option is not must-stand', guarded.length === 2 && guarded.every(line => line.includes("'must-stand'")), guarded.join(' | ') || 'no mkdir of the parent found')
}

console.log('\n4 the writers that took private roads now publish through the seam')
{
  const control = read(join(DAEMON, 'controlSocket.ts'))
  const asksCode = read(join(DAEMON, 'permissionAsks.ts'))
  const routed: Array<{ file: string; code: string; fn: string }> = [
    { file: 'controlSocket.ts', code: control, fn: 'writeSupervisorState' },
    { file: 'controlSocket.ts', code: control, fn: 'markSupervisorStoppingSync' },
    { file: 'controlSocket.ts', code: control, fn: 'reassertControlKey' },
    { file: 'permissionAsks.ts', code: asksCode, fn: 'writeGitInitAsks' },
  ]
  for (const r of routed) {
    const body = functionBody(r.code, r.fn)
    const privateRoads = body === null ? ['function not found'] : ['writeFile(', 'writeFileSync(', 'mkdir(', 'mkdirSync(', 'renameSync(', 'renameWithWin32RetrySync('].filter(road => body.includes(road))
    check(`4 ${r.file} ${r.fn} publishes through publishInDaemonHome and takes no private write road`, body !== null && body.includes('publishInDaemonHome(') && privateRoads.length === 0, privateRoads.join(', ') || 'no publishInDaemonHome call')
  }
}

console.log('\n5 the directory creators under the armed watch never mkdir -p into the home')
{
  const worktrees = read(join(DAEMON, 'concourseWorktrees.ts'))
  const boxes = read(join(DAEMON, 'saturnBoxSchedules.ts'))
  check('5 concourseWorktrees.ts does not create the worktree root with a recursive mkdir', !/mkdirSync\(workerWorktreeRoot\(dir\), \{ recursive: true \}\)/.test(worktrees))
  check('5 saturnBoxSchedules.ts does not recreate the daemon dir for the box lock or the box file with a recursive mkdir', !/mkdirSync\(dirname\((lock|p)\), \{ recursive: true \}\)/.test(boxes))
}

console.log('\n6 the plane heal reads the latch before it re-binds')
{
  const main = read(join(DAEMON, 'main.ts'))
  const rebindLines = main.split('\n').filter(line => line.includes('controlServer?.rebind()'))
  check('6 main.ts has one rebind of the control socket', rebindLines.length === 1, `${rebindLines.length} rebind lines`)
  check('6 the rebind line reads daemonHomeStands first', rebindLines.every(line => line.includes('daemonHomeStands(')), rebindLines.map(l => l.trim()).join(' | ') || 'none')
}

console.log('\n7 the daemon-home writers outside src/daemon publish through the seam: the trails append through it, the projections rename through it')
{
  const seam = read(SEAM)
  check('7 daemonHome.ts exports appendInDaemonHome (a trail appends one row; the publish door replaces whole files)', /export function appendInDaemonHome\(/.test(seam))
  check('7 daemonHome.ts exports publishTransientInDaemonHome (a boot-wiped projection renames without the durable fsync)', /export function publishTransientInDaemonHome\(/.test(seam))
  const ledger = read(join(ROOT, 'src', 'utils', 'spawnLedger.ts'))
  const projections = read(join(ROOT, 'src', 'services', 'engine-connector', 'seatProjections.ts'))
  const routed: Array<{ file: string; code: string; fn: string; door: string }> = [
    { file: 'spawnLedger.ts', code: ledger, fn: 'appendTrail', door: 'appendInDaemonHome' },
    { file: 'seatProjections.ts', code: projections, fn: 'publishSessionFacts', door: 'publishTransientInDaemonHome' },
    { file: 'seatProjections.ts', code: projections, fn: 'publishSessionAsks', door: 'publishTransientInDaemonHome' },
    { file: 'seatProjections.ts', code: projections, fn: 'publishSessionTail', door: 'publishTransientInDaemonHome' },
    { file: 'seatProjections.ts', code: projections, fn: 'publishSessionProgress', door: 'publishTransientInDaemonHome' },
  ]
  const roads = ['writeFile(', 'writeFileSync(', 'appendFileSync(', 'mkdir(', 'mkdirSync(', 'renameSync(', 'publishAtomic(', 'publishOrdered(']
  for (const r of routed) {
    const body = functionBody(r.code, r.fn)
    const privateRoads = body === null ? ['function not found'] : roads.filter(road => body.includes(road))
    check(`7 ${r.file} ${r.fn} publishes through ${r.door} and takes no private write road`, body !== null && body.includes(`${r.door}(`) && privateRoads.length === 0, privateRoads.join(', ') || `no ${r.door} call`)
  }
  for (const fn of ['publishSessionFacts', 'publishSessionAsks', 'publishSessionTail', 'publishSessionProgress']) {
    const body = functionBody(projections, fn) ?? ''
    check(`7 seatProjections.ts ${fn} creates its subdirectory through ensureDirInDaemonHome`, body.includes('ensureDirInDaemonHome('), 'no ensureDirInDaemonHome call')
  }
  check('7 seatProjections.ts carries no publish road of its own', !projections.includes("from '../../substrate/fileStore.js'") && !/\bpublishAtomic\b/.test(projections), 'imports publishAtomic from the authority')
  check('7 seatProjections.ts takes no durable road for its projections (a boot-wiped projection never costs the daemon loop a fsync)', !projections.includes('publishInDaemonHome('), 'publishInDaemonHome')
  check('7 spawnLedger.ts keeps the worker law where it was born: a daemon-marked worker never creates the forensics directory', /parseWorkerParentPid\(\) === null \? 'create' : 'must-stand'/.test(ledger), 'no marker-keyed parent option')
}

console.log(failures === 0 ? '\nprove-daemon-home-census: ALL LAWS HOLD' : `\nprove-daemon-home-census: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
