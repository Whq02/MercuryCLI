#!/usr/bin/env bun
/**
 * bench-authority — the durable-state authority decision harness.
 *
 * Measures, with real Mercury operations and realistic payloads, the three
 * candidates for the single durable-state authority:
 *
 *   S  status quo control — per-process writers over JSON stores
 *      (proper-lockfile STORE_LOCK_OPTIONS → read → mutate →
 *      durableAtomicPublish; the REAL FileStore kernel drives the mailbox
 *      workload, the REAL durable primitive drives the sidecar workload)
 *   A  daemon as single writer (unix-socket round trip; 'serial' publishes
 *      per request, 'group' drains the queue behind one durable publish —
 *      group commit is the single-writer's structural advantage, so both are
 *      measured)
 *   B  embedded transactional store (node:sqlite, WAL; synchronous NORMAL /
 *      FULL / FULL+fullfsync — three distinct durability levels)
 *   C  append-only event log as authority (O_APPEND JSONL; none / fdatasync /
 *      fsync per append; projections fold the log — the snapshot arm retired
 *      with the room log it borrowed)
 *
 * What is measured and why it discriminates:
 *   · COMMIT LATENCY at 1/5/10/40 concurrent PROCESSES — the full protocol
 *     (lock acquire → read → mutate → durable publish → release, or the
 *     candidate's equivalent), never just the publish half. Cross-process
 *     contention is the deciding regime (STALE-STEAL-UNDER-DESCHEDULE lives
 *     in the lock path).
 *   · RESTORE/READ COST as history grows (100/1k/10k events, with and
 *     without snapshots) — an append-only log is cheap to write and expensive
 *     to read; a benchmark that omits fold cost is invalid.
 *   · WRITE AMPLIFICATION — bytes written per logical commit (whole-store
 *     rewrite vs delta append vs WAL pages).
 *   · CRASH RECOVERY — SIGKILL at every durable-publish phase (the REAL
 *     MERCURY_FAULT_INJECT seam) and at random points for sqlite/log/daemon;
 *     restart must select the last committed revision and never fabricate an
 *     unacked success.
 *   · DURABILITY LEVEL VALIDITY — on macOS fsync(2) does not flush the drive
 *     cache; F_FULLFSYNC does. The probe measures a C ground truth
 *     (fsync vs F_FULLFSYNC vs F_BARRIERFSYNC) and classifies what Node's and
 *     Bun's fsyncSync actually issue, so every latency table states which
 *     durability level it measured. Workers run under NODE (the production
 *     runtime) because the two runtimes differ here.
 *
 * Payload calibration:
 *   run sidecars  n=286  p50 10.7KB  p90 15.2KB  max 18.5KB (events capped 40)
 *   inboxes       n=17   p50 1.6KB   p90 19.7KB  max 42KB; ~0.7-2KB/message;
 *                 compaction bounds an inbox at ~200 msgs (~200KB worst case)
 *   task bodies   n=33   p50 ~0.4KB
 *
 * Hygiene: scratch-explicit root (mkdtemp under tmpdir(), startsWith guard on
 * every write, workers re-guard via KEEL_BENCH_ROOT); load average recorded
 * beside every timing leg; every child is self-terminating (hard deadline in
 * the worker, parent timeout as backstop, daemons exit on stdin close).
 *
 * Usage:
 *   bun run scripts/engine-durability/bench-authority.ts [--quick] [--keep]
 *       [--phases=probe,ladder,grid,reads,crash]
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2))
const QUICK = args.has('--quick')
const KEEP = args.has('--keep') || process.env.KEEL_BENCH_KEEP === '1'
const phasesArg = [...args].find(a => a.startsWith('--phases='))
const PHASES = new Set(
  (phasesArg ? phasesArg.slice('--phases='.length) : 'probe,ladder,grid,reads,crash').split(','),
)

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
// Node 24 strips types natively (no flag), so the worker is TypeScript like the rest
// of the estate. It still runs under NODE rather than bun: bun's fsyncSync is plain
// fsync(2) (25us) while Node's is F_FULLFSYNC-class (3ms), so a worker on the wrong
// runtime would measure page-cache semantics instead of what ships.
const WORKER = join(REPO_ROOT, 'scripts', 'engine-durability', 'bench-authority-worker.ts')

// ── Scratch root (mkdtemp under tmpdir(); every write guarded) ──────────────
const ROOT = mkdtempSync(join(tmpdir(), 'keel-auth-'))
function within(p: string): string {
  const r = resolve(p)
  if (r !== ROOT && !r.startsWith(ROOT + sep)) {
    throw new Error(`write path escapes bench root: ${p}`)
  }
  return r
}
function freshDir(name: string): string {
  const d = within(join(ROOT, name))
  mkdirSync(d, { recursive: true })
  return d
}

const CHILDREN = new Set<ChildProcess>()
function reap(): void {
  for (const c of CHILDREN) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', () => {
  reap()
  if (!KEEP) {
    try {
      rmSync(within(ROOT), { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})
process.on('SIGINT', () => process.exit(130))

const NODE = Bun.which('node')
if (!NODE) {
  console.error('node not found on PATH — the production runtime is required')
  process.exit(2)
}

// Hermetic worker environment: explicit HOME/TMPDIR inside the bench root so
// nothing can read or write this machine's ambient state through env fallback.
const FAKE_HOME = freshDir('home')
function workerEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: FAKE_HOME,
    TMPDIR: ROOT,
    KEEL_BENCH_ROOT: ROOT,
    KEEL_REAL_OPS: REAL_OPS,
    ...extra,
  }
}

interface RunOut {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  wallMs: number
}

function runChild(
  cmd: string,
  argvv: string[],
  opts: {
    env?: Record<string, string>
    timeoutMs: number
    goAfterSpawn?: boolean
    killAfterMs?: number
  },
): Promise<RunOut> & { child: ChildProcess } {
  const t0 = performance.now()
  const child = spawn(cmd, argvv, { env: opts.env ?? workerEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  CHILDREN.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', d => (stdout += String(d)))
  child.stderr!.on('data', d => (stderr += String(d)))
  const p = new Promise<RunOut>(res => {
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    if (opts.killAfterMs !== undefined) {
      setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs)
    }
    child.on('exit', (code, signal) => {
      clearTimeout(killer)
      CHILDREN.delete(child)
      res({ code, signal, stdout, stderr, wallMs: performance.now() - t0 })
    })
    if (opts.goAfterSpawn) child.stdin!.write('GO\n')
  }) as Promise<RunOut> & { child: ChildProcess }
  p.child = child
  return p
}

function parseDone(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('DONE ')) return JSON.parse(line.slice(5)) as Record<string, unknown>
  }
  return null
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))]!
}

// ── Payload seeding (parent side; mirrors the worker's makers) ──────────────
const PAD = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '
function seedMessage(seq: number, msgBytes: number, read: boolean): Record<string, unknown> {
  const base = {
    from: 'keel-doctor-A',
    text: '',
    timestamp: new Date().toISOString(),
    read,
    color: 'red',
    summary: 'bench payload message row',
    id: randomUUID(),
    seq,
  }
  const overhead = JSON.stringify(base).length
  base.text = PAD.repeat(Math.ceil(Math.max(1, msgBytes - overhead) / PAD.length)).slice(
    0,
    Math.max(1, msgBytes - overhead),
  )
  return base
}
function seedInbox(path: string, n: number, msgBytes: number, daemonShape: boolean): void {
  const msgs = Array.from({ length: n }, (_, i) => seedMessage(i + 1, msgBytes, i % 3 === 0))
  const body = daemonShape ? { writeSeq: n, messages: msgs } : msgs
  writeFileSync(within(path), JSON.stringify(body, null, 2))
}
function seedLog(dir: string, n: number, msgBytes: number): void {
  const lines: string[] = []
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({ t: 'send', msg: seedMessage(i, msgBytes, false), seq: i }))
  }
  writeFileSync(within(join(dir, 'events.jsonl')), lines.join('\n') + (n > 0 ? '\n' : ''))
}
function sizesIn(dir: string): number {
  let total = 0
  for (const f of [
    'inbox.json',
    'bench.run.json',
    'bench.db',
    'bench.db-wal',
    'bench.db-shm',
    'events.jsonl',
    'daemon-store.json',
  ]) {
    try {
      total += statSync(join(dir, f)).size
    } catch {
      /* absent */
    }
  }
  return total
}

// ── Bundle the REAL operations for the Node workers ─────────────────────────
console.log(`bench root: ${ROOT}`)
const ENTRY = within(join(ROOT, 'real-ops-entry.ts'))
writeFileSync(
  ENTRY,
  [
    '// Generated by bench-authority.ts — re-exports the REAL Mercury durable',
    '// operations so the Node workers exercise production code, not replicas.',
    `export { durableAtomicPublish, durableAtomicPublishSync } from '${join(REPO_ROOT, 'src/substrate/durablePublish.ts')}'`,
    `export { defineStore, publishAtomic, STORE_LOCK_OPTIONS } from '${join(REPO_ROOT, 'src/substrate/fileStore.ts')}'`,
    `export * as lockfile from '${join(REPO_ROOT, 'src/utils/lockfile.ts')}'`,
    '',
  ].join('\n'),
)
const REAL_OPS = within(join(ROOT, 'real-ops.mjs'))
{
  const b = spawnSync('bun', ['build', ENTRY, '--target=node', `--outfile=${REAL_OPS}`], {
    encoding: 'utf8',
  })
  if (b.status !== 0) {
    console.error('real-ops bundle failed:\n' + b.stdout + b.stderr)
    process.exit(2)
  }
}

// ── Results accumulator ─────────────────────────────────────────────────────
interface LegRow {
  phase: string
  leg: string
  arm: string
  workload: string
  conc: number
  n: number
  p50: number
  p95: number
  p99: number
  mean: number
  failures: number
  wallMs: number
  load1: number
  physicalBytesPerOp?: number
  logicalBytesPerOp?: number
  note?: string
}
const RESULTS: {
  preflight: Record<string, unknown>
  probe: Record<string, unknown>
  legs: LegRow[]
  reads: Record<string, unknown>[]
  crash: Record<string, unknown>[]
  daemonless: Record<string, unknown>
} = { preflight: {}, probe: {}, legs: [], reads: [], crash: [], daemonless: {} }

function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows]
  const widths = header.map((_, c) => Math.max(...all.map(r => (r[c] ?? '').length)))
  const fmt = (r: string[]) => r.map((v, c) => (v ?? '').padEnd(widths[c]!)).join('  ')
  return [fmt(header), fmt(widths.map(w => '-'.repeat(w))), ...rows.map(fmt)].join('\n')
}

// ── Phase 0: preflight ──────────────────────────────────────────────────────
async function preflight(): Promise<void> {
  const load = loadavg()
  const ps = spawnSync('ps', ['-Ao', 'pcpu=,comm=', '-r'], { encoding: 'utf8' })
  const topProcs = (ps.stdout ?? '')
    .split('\n')
    .slice(0, 5)
    .map(l => l.trim())
    .filter(Boolean)
  const nodeV = spawnSync(NODE!, ['--version'], { encoding: 'utf8' }).stdout.trim()
  const sqliteProbe = spawnSync(
    NODE!,
    ['-e', "const s=require('node:sqlite'); console.log('ok:'+typeof s.DatabaseSync)"],
    { encoding: 'utf8' },
  )
  RESULTS.preflight = {
    date: new Date().toISOString(),
    platform: `${process.platform} ${spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim()}`,
    hw: spawnSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).stdout.trim(),
    cpus: Number(spawnSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' }).stdout.trim()),
    node: nodeV,
    bun: Bun.version,
    loadavg: load.map(x => +x.toFixed(2)),
    topProcs,
    nodeSqlite: {
      loads: sqliteProbe.stdout.includes('ok:function'),
      experimentalWarning:
        sqliteProbe.stderr
          .split('\n')
          .find(l => l.includes('ExperimentalWarning')) ?? null,
    },
  }
  console.log('\n== PREFLIGHT ==')
  console.log(JSON.stringify(RESULTS.preflight, null, 2))
  if (load[0]! > 6) {
    console.log(
      'WARNING: 1-minute load average exceeds 6 on this machine — timing legs are suspect; rerun when quiet.',
    )
  }
}

// ── Phase 1: durability primitive probe ────────────────────────────────────
async function probeDurability(): Promise<void> {
  console.log('\n== DURABILITY PRIMITIVE PROBE ==')
  const iters = QUICK ? 60 : 200
  const dir = freshDir('probe')

  // C ground truth: what do fsync(2) / F_FULLFSYNC / F_BARRIERFSYNC cost on
  // THIS volume? This anchors the classification of what each runtime issues.
  const cSrc = join(dir, 'probe.c')
  writeFileSync(
    within(cSrc),
    `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#ifndef F_FULLFSYNC
#define F_FULLFSYNC 51
#endif
#ifndef F_BARRIERFSYNC
#define F_BARRIERFSYNC 85
#endif
static double now_us(void){struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);return ts.tv_sec*1e6+ts.tv_nsec/1e3;}
static int cmp(const void*a,const void*b){double x=*(const double*)a,y=*(const double*)b;return x<y?-1:(x>y?1:0);}
int main(int argc,char**argv){
  int iters=atoi(argv[2]); if(iters>4000)iters=4000;
  int fd=open(argv[1],O_RDWR|O_CREAT,0644);
  char buf[4096]; memset(buf,'x',sizeof buf);
  const char*names[3]={"fsync","F_FULLFSYNC","F_BARRIERFSYNC"};
  printf("{");
  for(int m=0;m<3;m++){
    double t[4000]; int fails=0;
    for(int i=0;i<8;i++){pwrite(fd,buf,4096,0);if(m==0)fsync(fd);else fcntl(fd,m==1?F_FULLFSYNC:F_BARRIERFSYNC);}
    for(int i=0;i<iters;i++){
      pwrite(fd,buf,4096,0);
      double t0=now_us(); int r;
      if(m==0)r=fsync(fd); else r=fcntl(fd,m==1?F_FULLFSYNC:F_BARRIERFSYNC);
      t[i]=now_us()-t0; if(r!=0)fails++;
    }
    qsort(t,iters,sizeof(double),cmp);
    printf("%s\\"%s\\":{\\"p50_us\\":%.1f,\\"p95_us\\":%.1f,\\"fails\\":%d}",m?",":"",names[m],t[iters/2],t[(int)(iters*0.95)],fails);
  }
  printf("}\\n"); return 0;
}
`,
  )
  let cTruth: Record<string, { p50_us: number; p95_us: number; fails: number }> | null = null
  const cc = spawnSync('cc', ['-O2', '-o', join(dir, 'probe'), cSrc], { encoding: 'utf8' })
  if (cc.status === 0) {
    const run = spawnSync(join(dir, 'probe'), [join(dir, 'probe.dat'), String(iters)], {
      encoding: 'utf8',
    })
    try {
      cTruth = JSON.parse(run.stdout.trim())
    } catch {
      console.log('C probe produced unparseable output: ' + run.stdout + run.stderr)
    }
  } else {
    console.log('cc unavailable — skipping syscall ground truth (classification falls back to magnitude)')
  }

  const nodeProbe = await runChild(NODE!, [WORKER, 'probe-fsync', join(dir, 'node.dat'), String(iters)], {
    timeoutMs: 120_000,
  })
  const bunProbe = await runChild('bun', [WORKER, 'probe-fsync', join(dir, 'bun.dat'), String(iters)], {
    timeoutMs: 120_000,
  })
  const nodeRes = parseDone(nodeProbe.stdout)
  const bunRes = parseDone(bunProbe.stdout)

  // Classification: match each runtime's fsyncSync median to the nearest
  // syscall ground truth (when available), else use magnitude.
  function classify(p50ms: number): string {
    if (cTruth) {
      const d = (x: number) => Math.abs(Math.log(Math.max(1e-3, p50ms * 1000) / Math.max(1e-3, x)))
      const candidates: Array<[string, number]> = [
        ['fsync(2) — page cache only', cTruth.fsync!.p50_us],
        ['F_FULLFSYNC — drive cache flushed', cTruth.F_FULLFSYNC!.p50_us],
        ['F_BARRIERFSYNC — barrier, not full flush', cTruth.F_BARRIERFSYNC!.p50_us],
      ]
      candidates.sort((a, b) => d(a[1]) - d(b[1]))
      return candidates[0]![0]
    }
    return p50ms >= 2 ? 'full-flush-like (magnitude heuristic)' : 'page-cache-like (magnitude heuristic)'
  }
  const nodeFsyncP50 = (nodeRes?.fsync as { p50: number } | undefined)?.p50 ?? NaN
  const nodeFdataP50 = (nodeRes?.fdatasync as { p50: number } | undefined)?.p50 ?? NaN
  const bunFsyncP50 = (bunRes?.fsync as { p50: number } | undefined)?.p50 ?? NaN
  RESULTS.probe = {
    cTruth,
    node: nodeRes,
    bun: bunRes,
    nodeFsyncClass: classify(nodeFsyncP50),
    nodeFdatasyncClass: classify(nodeFdataP50),
    bunFsyncClass: classify(bunFsyncP50),
  }
  console.log(JSON.stringify(RESULTS.probe, null, 2))
}

// ── Commit-leg runner ───────────────────────────────────────────────────────
let sockCounter = 0
interface LegSpec {
  phase: string
  leg: string
  arm: string // S | S0 | A-serial | A-group | A-group0 | B:normal|full|fullfsync | C:none|fdatasync|fsync
  workload: string // sidecar | mailbox:N:BYTES | task
  conc: number
  ops: number
  note?: string
}

async function runCommitLeg(spec: LegSpec): Promise<void> {
  const dir = freshDir(`leg-${spec.phase}-${spec.leg}`.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const [wkind, wa, wb] = spec.workload.split(':')
  const nmsgs = Number(wa ?? 20)
  const msgBytes = Number(wb ?? 1000)
  const fsyncOff = spec.arm === 'S0' || spec.arm.endsWith('0')
  const envExtra: Record<string, string> = fsyncOff
    ? { MERCURY_DURABLE_FSYNC: '0', MERCURY_DURABLE_FSYNC: '0' }
    : {}

  let workerArm = spec.arm === 'S0' ? 'S' : spec.arm
  let daemon: ReturnType<typeof runChild> | null = null
  const deadlineMs = (QUICK ? 45_000 : spec.conc >= 40 ? 150_000 : 90_000)

  if (spec.arm.startsWith('A')) {
    const sock = join(ROOT, `d${sockCounter++}.sock`)
    if (sock.length > 100) throw new Error(`socket path too long for AF_UNIX: ${sock}`)
    const storePath = join(dir, 'daemon-store.json')
    if (wkind === 'mailbox') seedInbox(storePath, nmsgs, msgBytes, true)
    const mode = spec.arm.startsWith('A-group') ? 'group' : 'serial'
    daemon = runChild(
      NODE!,
      [WORKER, 'daemon', sock, spec.workload, storePath, mode, String(deadlineMs + 30_000)],
      { env: workerEnv(envExtra), timeoutMs: deadlineMs + 40_000 },
    )
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('daemon never became READY')), 15_000)
      daemon!.child.stdout!.on('data', d => {
        if (String(d).includes('READY')) {
          clearTimeout(t)
          res()
        }
      })
    })
    workerArm = 'A:' + sock
  } else if (spec.arm.startsWith('B')) {
    const init = await runChild(
      NODE!,
      [WORKER, 'init-sqlite', join(dir, 'bench.db'), spec.workload, String(wkind === 'mailbox' ? nmsgs : 0)],
      { timeoutMs: 30_000 },
    )
    if (!parseDone(init.stdout)) throw new Error('sqlite init failed: ' + init.stderr)
  } else if (spec.arm.startsWith('C')) {
    if (wkind === 'mailbox') seedLog(dir, nmsgs, msgBytes)
  } else {
    if (wkind === 'mailbox') seedInbox(join(dir, 'inbox.json'), nmsgs, msgBytes, false)
  }

  const bytesBefore = sizesIn(dir)
  const load1 = loadavg()[0]!
  const t0 = performance.now()
  const workers = Array.from({ length: spec.conc }, (_, i) =>
    runChild(
      NODE!,
      [WORKER, 'commit', workerArm, spec.workload, String(spec.ops), String(deadlineMs), dir, `w${i}`],
      { env: workerEnv(envExtra), timeoutMs: deadlineMs + 20_000, goAfterSpawn: true },
    ),
  )
  const outs = await Promise.all(workers)
  const wallMs = performance.now() - t0
  const bytesAfter = sizesIn(dir)

  let daemonPhysical = 0
  if (daemon) {
    daemon.child.stdin!.end()
    const dOut = await daemon
    const stats = dOut.stderr.split('\n').find(l => l.startsWith('STATS '))
    if (stats) {
      const s = JSON.parse(stats.slice(6)) as { publishedBytes: number }
      daemonPhysical = s.publishedBytes
    }
  }

  const times: number[] = []
  let failures = 0
  let logicalBytes = 0
  let physicalBytes = 0
  let truncated = false
  for (const o of outs) {
    const d = parseDone(o.stdout) as
      | { times: number[]; failures: number; logicalBytes: number; physicalBytes?: number; truncated: boolean }
      | null
    if (!d) {
      failures += spec.ops
      console.log(`  worker produced no DONE (${spec.leg}): exit=${o.code}/${o.signal} stderr=${o.stderr.slice(0, 300)}`)
      continue
    }
    times.push(...d.times)
    failures += d.failures
    logicalBytes += d.logicalBytes
    physicalBytes += d.physicalBytes ?? 0
    truncated ||= d.truncated
  }
  if (daemonPhysical > 0) physicalBytes = daemonPhysical
  if (spec.arm.startsWith('B')) physicalBytes = Math.max(0, bytesAfter - bytesBefore)
  const s = [...times].sort((a, b) => a - b)
  const row: LegRow = {
    phase: spec.phase,
    leg: spec.leg,
    arm: spec.arm,
    workload: spec.workload,
    conc: spec.conc,
    n: s.length,
    p50: +pct(s, 0.5).toFixed(2),
    p95: +pct(s, 0.95).toFixed(2),
    p99: +pct(s, 0.99).toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(2),
    failures,
    wallMs: Math.round(wallMs),
    load1: +load1.toFixed(2),
    logicalBytesPerOp: s.length ? Math.round(logicalBytes / s.length) : undefined,
    physicalBytesPerOp: s.length && physicalBytes ? Math.round(physicalBytes / s.length) : undefined,
    note: [spec.note, truncated ? 'TRUNCATED-BY-DEADLINE' : null].filter(Boolean).join('; ') || undefined,
  }
  RESULTS.legs.push(row)
  console.log(
    `  ${spec.phase}/${spec.leg}: n=${row.n} p50=${row.p50}ms p95=${row.p95}ms p99=${row.p99}ms fail=${failures} load1=${row.load1}${row.note ? ' [' + row.note + ']' : ''}`,
  )

  // Log-arm integrity: cross-process O_APPEND interleaving must be zero for
  // the log candidate to be viable at all.
  if (spec.arm.startsWith('C') && spec.conc > 1) {
    const v = await runChild(NODE!, [WORKER, 'verify', 'C', spec.workload, dir], { timeoutMs: 60_000 })
    const vd = parseDone(v.stdout) as { interleaved?: number; torn?: number } | null
    row.note = [row.note, `appendInterleaved=${vd?.interleaved ?? '?'} torn=${vd?.torn ?? '?'}`]
      .filter(Boolean)
      .join('; ')
  }
}

// ── Phase 2: durability ladder (C=1) ────────────────────────────────────────
async function ladder(): Promise<void> {
  console.log('\n== DURABILITY LADDER (single process, per-arm durability levels) ==')
  const ops = QUICK ? 20 : 100
  const opsLarge = QUICK ? 10 : 60
  const opsTask = QUICK ? 15 : 80
  const variants: Array<[string, string]> = [
    ['S', 'fsync barriers ON (production default)'],
    ['S0', 'MERCURY_DURABLE_FSYNC=0 (rename-only)'],
    ['B:normal', 'WAL synchronous=NORMAL'],
    ['B:full', 'WAL synchronous=FULL'],
    ['B:fullfsync', 'WAL FULL + fullfsync=ON'],
    ['C:none', 'append, no sync (fire-ledger parity)'],
    ['C:fdatasync', 'append + fdatasync'],
    ['C:fsync', 'append + fsync'],
    ['A-serial', 'daemon, publish per request'],
  ]
  for (const [arm, note] of variants) {
    for (const workload of ['sidecar', 'mailbox:20:1000']) {
      await runCommitLeg({ phase: 'ladder', leg: `${arm}-${workload.split(':')[0]}`, arm, workload, conc: 1, ops, note })
    }
  }
  for (const arm of ['S', 'B:full', 'B:fullfsync', 'C:fsync']) {
    await runCommitLeg({
      phase: 'ladder',
      leg: `${arm}-mailboxLARGE`,
      arm,
      workload: 'mailbox:200:900',
      conc: 1,
      ops: opsLarge,
      note: 'near-compaction inbox (~180KB store)',
    })
  }
  for (const arm of ['S', 'B:full', 'C:fsync', 'A-serial']) {
    await runCommitLeg({ phase: 'ladder', leg: `${arm}-task`, arm, workload: 'task', conc: 1, ops: opsTask })
  }
}

// ── Phase 3: cross-process contention grid ──────────────────────────────────
function matchedBVariant(): string {
  // Pick the sqlite durability level that matches what the JSON-store arms
  // actually pay (Node fsync class), so the grid compares like with like.
  const cls = String((RESULTS.probe as { nodeFsyncClass?: string }).nodeFsyncClass ?? '')
  return cls.includes('FULLFSYNC') ? 'B:fullfsync' : 'B:full'
}

async function grid(): Promise<void> {
  console.log('\n== CONTENTION GRID (cross-process, mailbox:20:1000) ==')
  const opsFor = (c: number) => (QUICK ? { 1: 30, 5: 12, 10: 8, 40: 4 } : { 1: 150, 5: 60, 10: 40, 40: 15 })[c]!
  const bMatched = matchedBVariant()
  console.log(`  matched sqlite variant for the durable grid: ${bMatched}`)
  for (const conc of [1, 5, 10, 40]) {
    for (const arm of ['S', 'A-serial', 'A-group', bMatched, 'C:fsync']) {
      await runCommitLeg({
        phase: 'grid-durable',
        leg: `${arm}-c${conc}`,
        arm,
        workload: 'mailbox:20:1000',
        conc,
        ops: opsFor(conc),
      })
    }
  }
  for (const conc of [1, 5, 10, 40]) {
    for (const arm of ['S0', 'A-group0', 'B:normal', 'C:none']) {
      await runCommitLeg({
        phase: 'grid-oscrash',
        leg: `${arm}-c${conc}`,
        arm,
        workload: 'mailbox:20:1000',
        conc,
        ops: opsFor(conc),
        note: 'os-crash durability level (no drive flush)',
      })
    }
  }
}

// ── Phase 4: restore/read cost as history grows ─────────────────────────────
async function reads(): Promise<void> {
  console.log('\n== RESTORE / READ COST ==')
  const sizes = QUICK ? [100, 1000] : [100, 1000, 10_000]
  for (const n of sizes) {
    const reps = QUICK ? 5 : n >= 10_000 ? 10 : n >= 1000 ? 20 : 30
    const dir = freshDir(`read-log-${n}`)
    const build = await runChild(NODE!, [WORKER, 'build-log', dir, String(n), '200'], {
      timeoutMs: 300_000,
    })
    const built = parseDone(build.stdout)
    if (!built) throw new Error('build-log failed: ' + build.stderr.slice(0, 400))

    for (const [label, argvv] of [
      [`log-fold-nosnap-${n}`, ['fold', 'log', dir, 'nosnap', String(reps)]],
      [`log-fold-snap-${n}`, ['fold', 'log', dir, 'snap', String(reps)]],
    ] as Array<[string, string[]]>) {
      const out = await runChild(NODE!, [WORKER, ...argvv], { timeoutMs: 120_000 })
      const d = parseDone(out.stdout)
      RESULTS.reads.push({ label, events: n, logBytes: built.bytes, ...d })
      console.log(`  ${label}: ${JSON.stringify(d)}`)
    }

    const dbDir = freshDir(`read-db-${n}`)
    const init = await runChild(
      NODE!,
      [WORKER, 'init-sqlite', join(dbDir, 'bench.db'), 'mailbox:0:700', String(n)],
      { timeoutMs: 300_000 },
    )
    if (!parseDone(init.stdout)) throw new Error('read-db init failed: ' + init.stderr.slice(0, 400))
    const sq = await runChild(NODE!, [WORKER, 'fold', 'sqlite', join(dbDir, 'bench.db'), String(reps)], {
      timeoutMs: 120_000,
    })
    RESULTS.reads.push({ label: `sqlite-open+select-${n}`, events: n, ...parseDone(sq.stdout) })
    console.log(`  sqlite-open+select-${n}: ${JSON.stringify(parseDone(sq.stdout))}`)

    // JSON store: compaction bounds the store at ~200 messages, so its read
    // is O(bounded projection), NOT O(history) — that asymmetry is the point.
    const sDir = freshDir(`read-store-${n}`)
    seedInbox(join(sDir, 'inbox.json'), Math.min(n, 200), 700, false)
    const st = await runChild(NODE!, [WORKER, 'fold', 'store', join(sDir, 'inbox.json'), String(reps)], {
      timeoutMs: 60_000,
    })
    RESULTS.reads.push({
      label: `json-store-read-${n}`,
      events: n,
      note: 'store bounded at min(n,200) messages by compaction',
      ...parseDone(st.stdout),
    })
    console.log(`  json-store-read-${n}: ${JSON.stringify(parseDone(st.stdout))}`)
  }

  // Sidecar restore (the /resume path): one committed 12KB doc.
  const scDir = freshDir('read-sidecar')
  await runCommitLeg({
    phase: 'reads',
    leg: 'seed-sidecar',
    arm: 'S',
    workload: 'sidecar',
    conc: 1,
    ops: 3,
    note: 'seed for restore timing',
  })
  const legDir = join(ROOT, 'leg-reads-seed-sidecar')
  const sc = await runChild(
    NODE!,
    [WORKER, 'fold', 'store', join(legDir, 'bench.run.json'), String(QUICK ? 10 : 30)],
    { timeoutMs: 60_000 },
  )
  RESULTS.reads.push({ label: 'sidecar-restore-12KB', ...parseDone(sc.stdout) })
  console.log(`  sidecar-restore-12KB: ${JSON.stringify(parseDone(sc.stdout))}`)
  rmSync(within(scDir), { recursive: true, force: true })

  // Daemon read RTT (state already in daemon memory — the read is a socket
  // round trip plus serialization of the full state).
  const dDir = freshDir('read-daemon')
  const sock = join(ROOT, `d${sockCounter++}.sock`)
  seedInbox(join(dDir, 'daemon-store.json'), 20, 1000, true)
  const daemon = runChild(
    NODE!,
    [WORKER, 'daemon', sock, 'mailbox:20:1000', join(dDir, 'daemon-store.json'), 'serial', '60000'],
    { timeoutMs: 70_000 },
  )
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('read-daemon never READY')), 15_000)
    daemon.child.stdout!.on('data', d => {
      if (String(d).includes('READY')) {
        clearTimeout(t)
        res()
      }
    })
  })
  const rtt = await runChild(NODE!, [WORKER, 'read-rtt', sock, String(QUICK ? 15 : 50)], {
    timeoutMs: 60_000,
  })
  daemon.child.stdin!.end()
  await daemon
  RESULTS.reads.push({ label: 'daemon-read-rtt-20msg', ...parseDone(rtt.stdout) })
  console.log(`  daemon-read-rtt-20msg: ${JSON.stringify(parseDone(rtt.stdout))}`)
}

// ── Phase 5: crash recovery ─────────────────────────────────────────────────
function lastAck(stdout: string): number {
  let last = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('ACK ')) last = Number(line.slice(4))
  }
  return last
}

async function crashLeg(opts: {
  name: string
  arm: string
  workload: string
  faultAfter?: number
  faultSpec?: string
  killAfterMs?: number
  expect: (acked: number, verify: Record<string, unknown>) => { pass: boolean; detail: string }
  dirOverride?: string
  keepDir?: boolean
}): Promise<string | undefined> {
  const dir = opts.dirOverride ?? freshDir(`crash-${opts.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const [wkind, wa, wb] = opts.workload.split(':')
  if (!opts.dirOverride) {
    if (opts.arm.startsWith('B')) {
      await runChild(
        NODE!,
        [WORKER, 'init-sqlite', join(dir, 'bench.db'), opts.workload, String(wkind === 'mailbox' ? Number(wa ?? 20) : 0)],
        { timeoutMs: 30_000 },
      )
    } else if (opts.arm.startsWith('C') && wkind === 'mailbox') {
      seedLog(dir, Number(wa ?? 20), Number(wb ?? 1000))
    } else if (opts.arm === 'S' && wkind === 'mailbox') {
      seedInbox(join(dir, 'inbox.json'), Number(wa ?? 20), Number(wb ?? 1000), false)
    }
  }
  const out = await runChild(
    NODE!,
    [
      WORKER,
      'crash-commit',
      opts.arm,
      opts.workload,
      dir,
      String(opts.faultAfter ?? 0),
      opts.faultSpec ?? '-',
    ],
    { timeoutMs: 70_000, killAfterMs: opts.killAfterMs },
  )
  const acked = lastAck(out.stdout)
  const v = await runChild(NODE!, [WORKER, 'verify', opts.arm.split(':')[0]!, opts.workload, dir], {
    timeoutMs: 60_000,
  })
  const verify = (parseDone(v.stdout) ?? {}) as Record<string, unknown>
  const verdict = opts.expect(acked, verify)
  RESULTS.crash.push({
    name: opts.name,
    arm: opts.arm,
    workload: opts.workload,
    acked,
    exit: `${out.code}/${out.signal}`,
    verify,
    pass: verdict.pass,
    detail: verdict.detail,
  })
  console.log(`  ${opts.name}: acked=${acked} ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.detail} ${JSON.stringify(verify)}`)
  return opts.keepDir ? dir : undefined
}

async function crash(): Promise<void> {
  console.log('\n== CRASH RECOVERY (SIGKILL at commit phases and at random) ==')
  // S sidecar: kill at EVERY durable-publish phase via the REAL fault seam.
  const phaseExpect: Record<string, (a: number) => number> = {
    'create-temp': a => a,
    write: a => a,
    'flush-file': a => a,
    rename: a => a, // faultPoint fires BEFORE the rename executes
    'flush-dir': a => a + 1, // rename already landed; the op was never acked
  }
  for (const phase of ['create-temp', 'write', 'flush-file', 'rename', 'flush-dir']) {
    await crashLeg({
      name: `S-sidecar-phase-${phase}`,
      arm: 'S',
      workload: 'sidecar',
      faultAfter: 5,
      faultSpec: `${phase}@bench.run.json:kill`,
      expect: (acked, v) => {
        const want = phaseExpect[phase]!(acked)
        const got = v.writeSeq as number
        return {
          pass: v.ok === true && got === want,
          detail: `writeSeq=${got} want=${want} (valid JSON=${v.ok === true})`,
        }
      },
    })
  }
  for (let i = 0; i < (QUICK ? 1 : 2); i++) {
    await crashLeg({
      name: `S-sidecar-randomkill-${i}`,
      arm: 'S',
      workload: 'sidecar',
      killAfterMs: 120 + Math.random() * 300,
      expect: (acked, v) => ({
        pass: v.ok === true && (v.writeSeq as number) >= acked && (v.writeSeq as number) <= acked + 1,
        detail: `writeSeq=${v.writeSeq} acked=${acked} (∈{acked,acked+1})`,
      }),
    })
  }
  for (const phase of ['flush-file', 'rename']) {
    await crashLeg({
      name: `S-mailbox-phase-${phase}`,
      arm: 'S',
      workload: 'mailbox:20:1000',
      faultAfter: 4,
      faultSpec: `${phase}@inbox.json:kill`,
      expect: (acked, v) => {
        const want = 20 + phaseExpect[phase]!(acked)
        return {
          pass: v.ok === true && (v.maxSeq as number) === want,
          detail: `maxSeq=${v.maxSeq} want=${want}`,
        }
      },
    })
  }
  for (let i = 0; i < (QUICK ? 2 : 4); i++) {
    await crashLeg({
      name: `B-mailbox-randomkill-${i}`,
      arm: 'B:full',
      workload: 'mailbox:20:1000',
      killAfterMs: 100 + Math.random() * 350,
      expect: (acked, v) => ({
        pass:
          v.ok === true &&
          v.integrity === 'ok' &&
          (v.maxSeq as number) >= 20 + acked &&
          (v.maxSeq as number) <= 20 + acked + 1 &&
          v.contiguous === true,
        detail: `integrity=${v.integrity} maxSeq=${v.maxSeq} acked+seed=${20 + acked} contiguous=${v.contiguous}`,
      }),
    })
  }
  for (let i = 0; i < (QUICK ? 2 : 4); i++) {
    await crashLeg({
      name: `C-mailbox-randomkill-${i}`,
      arm: 'C:fsync',
      workload: 'mailbox:20:1000',
      killAfterMs: 100 + Math.random() * 350,
      expect: (acked, v) => ({
        pass: v.ok === true && (v.total as number) >= 20 + acked && (v.interleaved as number) === 0,
        detail: `total=${v.total} >= seed+acked=${20 + acked}, torn=${v.torn} interleaved=${v.interleaved}`,
      }),
    })
  }

  // Daemon: kill the SERVER at durable-publish phases while a client commits.
  for (const phase of ['rename', 'flush-dir']) {
    const dir = freshDir(`crash-A-${phase}`)
    const sock = join(ROOT, `d${sockCounter++}.sock`)
    const storePath = join(dir, 'daemon-store.json')
    seedInbox(storePath, 20, 1000, true)
    const daemon = runChild(
      NODE!,
      [WORKER, 'daemon', sock, 'mailbox:20:1000', storePath, 'serial', '60000'],
      {
        env: workerEnv({
          KEEL_FAULT_AFTER: '4',
          KEEL_FAULT_SPEC: `${phase}@daemon-store.json:kill`,
        }),
        timeoutMs: 70_000,
      },
    )
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('crash daemon never READY')), 15_000)
      daemon.child.stdout!.on('data', d => {
        if (String(d).includes('READY')) {
          clearTimeout(t)
          res()
        }
      })
    })
    const client = runChild(NODE!, [WORKER, 'crash-commit', `A:${sock}`, 'mailbox:20:1000', dir, '0', '-'], {
      timeoutMs: 30_000,
      killAfterMs: 8000,
    })
    const dOut = await daemon
    // The daemon is dead; the client hangs on its in-flight op — reap it.
    client.child.kill('SIGKILL')
    const cOut = await client
    const acked = lastAck(cOut.stdout)
    const v = await runChild(NODE!, [WORKER, 'verify', 'A', 'mailbox:20:1000', dir], { timeoutMs: 30_000 })
    const verify = (parseDone(v.stdout) ?? {}) as Record<string, unknown>
    const want = phase === 'flush-dir' ? 20 + acked + 1 : 20 + acked
    const pass = verify.ok === true && (verify.writeSeq as number) === want
    RESULTS.crash.push({
      name: `A-daemonkill-${phase}`,
      arm: 'A-serial',
      workload: 'mailbox:20:1000',
      acked,
      daemonExit: `${dOut.code}/${dOut.signal}`,
      verify,
      pass,
      detail: `store writeSeq=${verify.writeSeq} want=${want}; unacked in-flight op is honestly ambiguous`,
    })
    console.log(`  A-daemonkill-${phase}: acked=${acked} ${pass ? 'PASS' : 'FAIL'} store=${verify.writeSeq} want=${want}`)

    // Restart the daemon on the same store: restore must serve the committed state.
    const sock2 = join(ROOT, `d${sockCounter++}.sock`)
    const daemon2 = runChild(NODE!, [WORKER, 'daemon', sock2, 'mailbox:20:1000', storePath, 'serial', '30000'], {
      timeoutMs: 40_000,
    })
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('restart daemon never READY')), 15_000)
      daemon2.child.stdout!.on('data', d => {
        if (String(d).includes('READY')) {
          clearTimeout(t)
          res()
        }
      })
    })
    const rtt = await runChild(NODE!, [WORKER, 'read-rtt', sock2, '1'], { timeoutMs: 15_000 })
    daemon2.child.stdin!.end()
    await daemon2
    const restartOk = parseDone(rtt.stdout) !== null
    RESULTS.crash.push({ name: `A-restart-after-${phase}`, pass: restartOk, detail: 'daemon restart serves committed state' })
    console.log(`  A-restart-after-${phase}: ${restartOk ? 'PASS' : 'FAIL'}`)
  }
}

// ── Phase 6: daemonless behaviour + cold start (candidate-a product criterion)
async function daemonless(): Promise<void> {
  console.log('\n== DAEMONLESS BEHAVIOUR + COLD START (candidate a) ==')
  // No daemon running: what does a committing session experience?
  const dir = freshDir('daemonless')
  const ghost = join(ROOT, 'no-daemon.sock')
  const t0 = performance.now()
  const out = await runChild(NODE!, [WORKER, 'commit', `A:${ghost}`, 'mailbox:5:500', '1', '5000', dir, 'w0'], {
    timeoutMs: 15_000,
    goAfterSpawn: true,
  })
  const refuseMs = performance.now() - t0
  const refused = out.code !== 0
  // Cold start: spawn daemon → READY → first commit acked.
  const colds: number[] = []
  for (let i = 0; i < (QUICK ? 1 : 3); i++) {
    const cDir = freshDir(`coldstart-${i}`)
    const sock = join(ROOT, `d${sockCounter++}.sock`)
    seedInbox(join(cDir, 'daemon-store.json'), 20, 1000, true)
    const t1 = performance.now()
    const daemon = runChild(
      NODE!,
      [WORKER, 'daemon', sock, 'mailbox:20:1000', join(cDir, 'daemon-store.json'), 'serial', '30000'],
      { timeoutMs: 40_000 },
    )
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('coldstart daemon never READY')), 15_000)
      daemon.child.stdout!.on('data', d => {
        if (String(d).includes('READY')) {
          clearTimeout(t)
          res()
        }
      })
    })
    const first = await runChild(NODE!, [WORKER, 'commit', `A:${sock}`, 'mailbox:20:1000', '1', '10000', cDir, 'w0'], {
      timeoutMs: 20_000,
      goAfterSpawn: true,
    })
    const total = performance.now() - t1
    daemon.child.stdin!.end()
    await daemon
    if (parseDone(first.stdout)) colds.push(total)
  }
  RESULTS.daemonless = {
    noDaemonCommitRefusedMs: +refuseMs.toFixed(1),
    refusedCleanly: refused,
    coldStartToFirstCommitMs: colds.map(c => +c.toFixed(1)),
    note:
      'This models a MINIMAL single-purpose writer process. The real Mercury daemon boots ' +
      'far more (scheduler, roster, sockets policy); its cold start is a lower bound here. ' +
      'Foreground and headless sessions are daemonless today — candidate (a) as the SOLE ' +
      'authority either makes every such session spawn/keep a daemon (product change) or ' +
      'needs a second, direct write path (which reintroduces the multi-writer problem group commit exists to kill).',
  }
  console.log(JSON.stringify(RESULTS.daemonless, null, 2))
}

// ── Report ──────────────────────────────────────────────────────────────────
function report(): void {
  console.log('\n\n================= BENCH-AUTHORITY REPORT =================')
  console.log('\n-- durability primitive (what a "sync" actually buys on this volume) --')
  console.log(JSON.stringify(RESULTS.probe, null, 2))

  const fmtLeg = (r: LegRow) => [
    r.phase,
    r.arm,
    r.workload,
    String(r.conc),
    String(r.n),
    String(r.p50),
    String(r.p95),
    String(r.p99),
    String(r.failures),
    r.physicalBytesPerOp !== undefined ? String(r.physicalBytesPerOp) : '-',
    r.logicalBytesPerOp !== undefined ? String(r.logicalBytesPerOp) : '-',
    String(r.load1),
    r.note ?? '',
  ]
  const header = ['phase', 'arm', 'workload', 'conc', 'n', 'p50ms', 'p95ms', 'p99ms', 'fail', 'physB/op', 'logB/op', 'load1', 'note']
  for (const phase of ['ladder', 'grid-durable', 'grid-oscrash']) {
    const rows = RESULTS.legs.filter(l => l.phase === phase)
    if (rows.length === 0) continue
    console.log(`\n-- ${phase} --`)
    console.log(table(rows.map(fmtLeg), header))
  }
  if (RESULTS.reads.length > 0) {
    console.log('\n-- restore/read --')
    for (const r of RESULTS.reads) console.log('  ' + JSON.stringify(r))
  }
  if (RESULTS.crash.length > 0) {
    console.log('\n-- crash recovery --')
    for (const r of RESULTS.crash) {
      console.log(`  ${(r.pass ? 'PASS' : 'FAIL') as string}  ${r.name as string}: ${r.detail as string}`)
    }
  }
  console.log('\n-- daemonless / cold start --')
  console.log(JSON.stringify(RESULTS.daemonless, null, 2))

  console.log(`
-- Windows filesystem behaviour (NOT measured here — no Windows host) --
  S/A (durableAtomicPublish): dir-fsync is impossible on Windows (skipped by
    design, durablePublish.ts flush-dir); rename-over-target fails with
    EPERM/EACCES while ANY reader holds the destination without
    FILE_SHARE_DELETE — the retry/backoff burden is on callers. proper-lockfile
    holds mkdir-based locks (works, but stale detection rides mtime).
  B (node:sqlite): SQLite's Windows VFS is its most battle-tested non-POSIX
    port (locking via LockFileEx byte ranges; WAL supported); no rename in the
    commit path at all — the strongest candidate on Windows semantics.
  C (append log): O_APPEND maps to FILE_APPEND_DATA (atomic appends);
    snapshot writes still rename. Torn-tail handling identical.
  A daemon transport: AF_UNIX exists on Windows 10+; named pipes otherwise.
  This section is design analysis, not measurement — pin it with the durability
  Windows regression session before acting on it.`)

  const resultsPath = within(join(ROOT, 'results.json'))
  writeFileSync(resultsPath, JSON.stringify(RESULTS, null, 2))
  console.log(`\nRESULTS-JSON: ${resultsPath}${KEEP ? ' (kept)' : ' (deleted at exit — pass --keep to retain)'}`)
}

// ── Main ────────────────────────────────────────────────────────────────────
await preflight()
if (PHASES.has('probe')) await probeDurability()
if (PHASES.has('ladder')) await ladder()
if (PHASES.has('grid')) await grid()
if (PHASES.has('reads')) await reads()
if (PHASES.has('crash')) await crash()
if (PHASES.has('crash') || PHASES.has('grid')) await daemonless()
report()
process.exit(0)
