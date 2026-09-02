/**
 * bench-authority-worker — the Node-side measurement body for
 * scripts/engine-durability/bench-authority.ts.
 *
 * Runs under the PRODUCTION runtime (Node >=24.11) because the durability
 * physics differ by runtime: Node's fsync routes through libuv, whose Darwin
 * implementation issues F_FULLFSYNC; Bun's does not. Numbers taken under the
 * dev runtime would misstate what shipped sessions pay. The worker drives the
 * REAL Mercury operations through a bun-built bundle (KEEL_REAL_OPS): the
 * FileStore kernel's locked mutate (proper-lockfile + durableAtomicPublish),
 * the durable publish primitive itself, publishAtomic, and the caduceus
 * snapshot reader/writer.
 *
 * Every path this worker writes is guarded to stay under KEEL_BENCH_ROOT
 * (the bun-homedir/ambient-write lesson). Every long-running mode carries a
 * hard self-termination deadline — workers are self-terminating, never
 * trap-cleaned.
 *
 * Modes (argv[2]):
 *   probe-fsync <file> <iters>              fsync/fdatasync latency probe (node OR bun)
 *   init-sqlite <db> <workload> <seedN>     schema + WAL + seed rows
 *   commit <arm> <workload> <ops> <deadlineMs> <dir> <id>   timed commit loop
 *   daemon <sock> <workload> <store> <serial|group> <deadlineMs>  single-writer server
 *   crash-commit <arm> <workload> <dir> <faultAfter|0> <faultSpec|->  ack loop until killed
 *   verify <arm> <workload> <dir>           post-crash state audit
 *   build-log <dir> <n> <snapEvery|0>       seed an event log (+ real caduceus snapshots)
 *   fold <log|store|sqlite> ...             restore/read timing
 *   read-rtt <sock> <reps>                  daemon read round-trip
 */
import {
  closeSync,
  fdatasyncSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.KEEL_BENCH_ROOT ?? ''
if (!ROOT) {
  writeSync(2, 'KEEL_BENCH_ROOT is required\n')
  process.exit(2)
}

/** Scratch-containment guard: every path the worker touches for WRITING must
 *  live under the bench root. (bun-homedir ambient-write lesson.) */
function within(p) {
  const r = resolve(p)
  if (r !== ROOT && !r.startsWith(ROOT + sep)) {
    writeSync(2, `path escapes bench root: ${p}\n`)
    process.exit(2)
  }
  return r
}

const argv = process.argv.slice(2)
const mode = argv[0]

// Lazy real-ops import: probe-fsync must run under bun too, where importing
// the node-targeted bundle is unnecessary.
let real = null
async function loadReal() {
  if (!real) real = await import(pathToFileURL(process.env.KEEL_REAL_OPS).href)
  return real
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)
  return sorted[Math.max(0, i)]
}
function summarize(times) {
  const s = [...times].sort((a, b) => a - b)
  return {
    n: s.length,
    p50: +pct(s, 0.5).toFixed(3),
    p95: +pct(s, 0.95).toFixed(3),
    p99: +pct(s, 0.99).toFixed(3),
    max: +(s[s.length - 1] ?? 0).toFixed(3),
    mean: +(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(3),
  }
}

/** Synchronous ack to the parent pipe — survives SIGKILL of this process
 *  (an async console.log buffer would not, and the crash invariant
 *  `state ∈ {acked, acked+1}` depends on acks never lagging commits). */
function ackSync(line) {
  writeSync(1, line + '\n')
}

function waitForGo() {
  return new Promise(resolveGo => {
    let buf = ''
    process.stdin.on('data', d => {
      buf += String(d)
      if (buf.includes('GO')) resolveGo()
    })
    process.stdin.resume()
  })
}

// ── Payloads (calibrated against real stores; see harness header) ──────────
const MSG_PAD = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '
function makeMessage(seq, msgBytes) {
  const base = {
    from: 'keel-doctor-A',
    text: '',
    timestamp: new Date().toISOString(),
    read: false,
    color: 'red',
    summary: 'bench payload message row',
    id: randomUUID(),
    seq,
  }
  const overhead = JSON.stringify(base).length
  base.text = MSG_PAD.repeat(Math.ceil(Math.max(1, msgBytes - overhead) / MSG_PAD.length)).slice(
    0,
    Math.max(1, msgBytes - overhead),
  )
  return base
}

// The real compaction rule (teammateMailbox.ts: MAILBOX_COMPACT_THRESHOLD=200,
// MAILBOX_KEEP_READ=100) — replicated here because the production function is
// module-private; the constants and drop rule are copied verbatim.
function compactMailbox(messages) {
  if (messages.length <= 200) return messages
  let toDrop = messages.filter(m => m.read).length - 100
  if (toDrop <= 0) return messages
  const out = []
  for (const m of messages) {
    if (toDrop > 0 && m.read) {
      toDrop--
      continue
    }
    out.push(m)
  }
  return out
}

function makeRunEvent(i) {
  return {
    t: 'tool-effect',
    name: i % 3 === 0 ? 'Bash' : i % 3 === 1 ? 'Edit' : 'Read',
    detail:
      'effect detail for benchmark event; realistic length matches recorded run events in live sidecars '.slice(
        0,
        96,
      ) + String(i).padStart(8, '0'),
    at: Date.now(),
  }
}

/** Realistic RunSnapshot (shape: src/services/run/runKernel.ts; size targets
 *  the measured live-sidecar band — p50 10.7KB / p90 15.2KB, events capped 40). */
function makeRunSnapshot(owner) {
  const events = []
  for (let i = 0; i < 40; i++) events.push(makeRunEvent(i))
  return {
    schema: 3,
    runId: randomUUID(),
    owner,
    rootMessageId: randomUUID(),
    objective:
      'benchmark objective: measure the durable-state authority commit path with a realistic snapshot document',
    startedAt: Date.now() - 600_000,
    updatedAt: Date.now(),
    lifecycle: 'active',
    substantive: true,
    phase: 'implementation',
    phaseReason: 'benchmark phase reason text of realistic length for the sidecar document',
    deliverables: [
      { id: 'd1', title: 'first deliverable with a realistic title length', state: 'done' },
      { id: 'd2', title: 'second deliverable with a realistic title length', state: 'active' },
      { id: 'd3', title: 'third deliverable with a realistic title length', state: 'pending' },
    ],
    lastAction: 'ran the previous benchmark commit iteration against the durable authority',
    nextAction: 'run the next benchmark commit iteration against the durable authority',
    blocker: null,
    changedPaths: Array.from({ length: 12 }, (_, i) => `src/some/realistic/path/file-${i}.ts`),
    totalChangedPaths: 12,
    recentEffects: Array.from({ length: 10 }, (_, i) => ({
      tool: 'Edit',
      path: `src/some/realistic/path/file-${i}.ts`,
      outcome: 'succeeded',
      at: Date.now(),
    })),
    pendingTools: [],
    unresolvedBadEffects: 0,
    verification: { state: 'stale', detail: 'benchmark verification detail string' },
    contextEpoch: 2,
    lastContextTransition: { kind: 'compaction', reason: 'benchmark', at: Date.now() },
    ideFeedback: { state: 'none', detail: '', at: null },
    continuationCount: 3,
    lastStopDecision: { decision: 'continue', detail: 'benchmark stop decision detail', at: Date.now() },
    recentEvents: events,
    totalEvents: 400,
  }
}

/** The EXACT on-disk wrapper publishRunSidecar writes (runSidecar.ts) —
 *  replicated because the production function resolves its path through
 *  session storage; the byte shape and the durable primitive are identical. */
function sidecarWrapper(writeSeq, snapshot) {
  return JSON.stringify(
    {
      schema: 3,
      writeSeq,
      operationId: randomUUID(),
      committedAt: new Date().toISOString(),
      snapshot,
    },
    null,
    2,
  )
}

function makeTaskBody(id) {
  return JSON.stringify(
    {
      id: String(id),
      subject: 'benchmark task subject with realistic length',
      description:
        'benchmark task description: a couple of sentences of realistic task body content so the payload matches live task files (~400 bytes median).',
      state: 'pending',
      blocks: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )
}

// tasks.ts LOCK_OPTIONS (module-private there; copied verbatim).
const TASKS_LOCK_OPTIONS = { retries: { retries: 30, minTimeout: 5, maxTimeout: 100 } }

// ── Workload/arm plumbing ───────────────────────────────────────────────────
/** Physical bytes actually written per commit (write amplification numerator).
 *  S rewrites the whole store; C writes one line; task-create writes one new
 *  file. B is measured by the parent as file growth; A by the daemon's STATS. */
let PHYS = 0

function parseWorkload(spec) {
  const [kind, a, b] = spec.split(':')
  return { kind, nmsgs: Number(a ?? 20), msgBytes: Number(b ?? 1000) }
}

function foldLogLines(raw) {
  // Torn-tail-tolerant fold: a parse failure on the FINAL line is a torn
  // append (dropped, counted); a parse failure anywhere else is interleaving
  // corruption (counted separately — must be zero for the log candidate to
  // be viable at all).
  const lines = raw.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let torn = 0
  let interleaved = 0
  let maxSeq = 0
  const byId = new Map()
  const list = []
  for (let i = 0; i < lines.length; i++) {
    let ev
    try {
      ev = JSON.parse(lines[i])
    } catch {
      if (i === lines.length - 1) torn++
      else interleaved++
      continue
    }
    if (ev.t === 'send') {
      list.push(ev.msg)
      if (ev.msg.id) byId.set(ev.msg.id, ev.msg)
      if (typeof ev.seq === 'number') maxSeq = Math.max(maxSeq, ev.seq)
    } else if (ev.t === 'read') {
      const m = byId.get(ev.id)
      if (m) m.read = true
    } else if (ev.t === 'task-create') {
      list.push(ev)
      if (typeof ev.seq === 'number') maxSeq = Math.max(maxSeq, ev.seq)
    } else if (ev.t === 'run-event') {
      list.push(ev)
      if (typeof ev.seq === 'number') maxSeq = Math.max(maxSeq, ev.seq)
    }
  }
  return { messages: compactMailbox(list), torn, interleaved, maxSeq, total: list.length }
}

function sqliteOpen(db) {
  // node:sqlite — available unflagged on the supported runtime (>=24.11),
  // emits ExperimentalWarning on stderr (captured by the harness preflight).
  return import('node:sqlite').then(m => new m.DatabaseSync(db))
}

// ── Modes ───────────────────────────────────────────────────────────────────

async function modeProbeFsync() {
  const file = within(argv[1])
  const iters = Number(argv[2] ?? 150)
  const fd = openSync(file, 'w')
  const buf = Buffer.alloc(4096, 120)
  const runtimes = { runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}` }
  const res = { ...runtimes }
  for (const [name, sync] of [
    ['fsync', () => fsyncSync(fd)],
    ['fdatasync', () => fdatasyncSync(fd)],
  ]) {
    const times = []
    for (let i = 0; i < 10; i++) {
      writeSync(fd, buf, 0, 4096, 0)
      sync()
    }
    for (let i = 0; i < iters; i++) {
      writeSync(fd, buf, 0, 4096, 0)
      const t0 = performance.now()
      sync()
      times.push(performance.now() - t0)
    }
    res[name] = summarize(times)
  }
  closeSync(fd)
  console.log('DONE ' + JSON.stringify(res))
}

async function modeInitSqlite() {
  const db = await sqliteOpen(within(argv[1]))
  const workload = parseWorkload(argv[2])
  const seedN = Number(argv[3] ?? 0)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages(
      inbox TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
      sender TEXT NOT NULL, ts TEXT NOT NULL, read INTEGER NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(inbox, seq));
    CREATE TABLE IF NOT EXISTS run_head(
      owner TEXT PRIMARY KEY, write_seq INTEGER NOT NULL,
      lifecycle TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS run_events(
      owner TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL,
      PRIMARY KEY(owner, seq));
    CREATE TABLE IF NOT EXISTS tasks(
      list TEXT NOT NULL, id INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(list, id));
  `)
  if (workload.kind === 'mailbox' && seedN > 0) {
    const ins = db.prepare(
      'INSERT INTO messages(inbox,seq,id,sender,ts,read,body) VALUES(?,?,?,?,?,?,?)',
    )
    db.exec('BEGIN IMMEDIATE')
    for (let i = 1; i <= seedN; i++) {
      const m = makeMessage(i, workload.msgBytes)
      ins.run('bench', i, m.id, m.from, m.timestamp, i % 3 === 0 ? 1 : 0, m.text)
    }
    db.exec('COMMIT')
  }
  if (workload.kind === 'sidecar') {
    db.prepare(
      'INSERT OR REPLACE INTO run_head(owner,write_seq,lifecycle,updated_at) VALUES(?,?,?,?)',
    ).run('bench-owner', 0, 'active', Date.now())
  }
  db.close()
  console.log('DONE {}')
}

/** One commit against one arm. Returns logical delta bytes written. */
async function makeCommitter(armSpec, workload, dir) {
  const [arm, sub] = armSpec.split(':')
  const w = workload

  if (arm === 'S') {
    const r = await loadReal()
    if (w.kind === 'mailbox') {
      // The REAL FileStore kernel: proper-lockfile (STORE_LOCK_OPTIONS) →
      // read → decode → mutate → durableAtomicPublish. Same decode/empty/
      // revisionOf semantics as the production teammate-mailbox store.
      const store = r.defineStore({
        name: 'bench-mailbox',
        path: p => p,
        schemaVersion: 1,
        decode: raw =>
          Array.isArray(raw)
            ? raw.filter(
                m =>
                  !!m &&
                  typeof m === 'object' &&
                  typeof m.from === 'string' &&
                  typeof m.text === 'string' &&
                  typeof m.timestamp === 'string' &&
                  typeof m.read === 'boolean',
              )
            : null,
        empty: () => [],
        onReadFailure: 'empty',
        revisionOf: msgs => msgs.reduce((mx, m) => Math.max(mx, m.seq ?? 0), 0),
      })
      const inboxPath = within(join(dir, 'inbox.json'))
      const handle = store(inboxPath)
      return async () => {
        let bytes = 0
        await handle.mutate(msgs => {
          const maxSeq = msgs.reduce((mx, m) => Math.max(mx, m.seq ?? 0), 0)
          const msg = makeMessage(maxSeq + 1, w.msgBytes)
          bytes = JSON.stringify(msg).length
          return compactMailbox([...msgs, msg])
        })
        PHYS += statSync(inboxPath).size
        return bytes
      }
    }
    if (w.kind === 'sidecar') {
      // saveRunSidecar's exact write: whole-document wrapper through the real
      // durable primitive (runSidecar has no lock — single-owner doctrine).
      const path = within(join(dir, 'bench.run.json'))
      const snapshot = makeRunSnapshot('bench-owner')
      let writeSeq = 0
      return async () => {
        writeSeq++
        snapshot.recentEvents.push(makeRunEvent(writeSeq))
        if (snapshot.recentEvents.length > 40) snapshot.recentEvents.shift()
        snapshot.updatedAt = Date.now()
        snapshot.totalEvents++
        const raw = sidecarWrapper(writeSeq, snapshot)
        await r.durableAtomicPublish(path, raw)
        PHYS += raw.length
        return 250 // logical delta: one run event
      }
    }
    if (w.kind === 'task') {
      // createTask's exact protocol (tasks.ts): list lock → scan for max id →
      // publish body atomically under the lock.
      const tasksDir = within(join(dir, 'tasks'))
      mkdirSync(tasksDir, { recursive: true })
      const lockTarget = join(tasksDir, '.lock')
      writeSync(openSync(lockTarget, 'a'), '')
      return async () => {
        const release = await r.lockfile.lock(lockTarget, TASKS_LOCK_OPTIONS)
        try {
          let max = 0
          for (const f of readdirSync(tasksDir)) {
            if (!f.endsWith('.json')) continue
            const n = Number(f.slice(0, -5))
            if (Number.isFinite(n)) max = Math.max(max, n)
          }
          const id = max + 1
          const body = makeTaskBody(id)
          await r.publishAtomic(join(tasksDir, `${id}.json`), body)
          PHYS += body.length
          return body.length
        } finally {
          await release()
        }
      }
    }
  }

  if (arm === 'B') {
    const db = await sqliteOpen(within(join(dir, 'bench.db')))
    db.exec('PRAGMA busy_timeout=4000')
    db.exec(`PRAGMA synchronous=${sub === 'normal' ? 'NORMAL' : 'FULL'}`)
    if (sub === 'fullfsync') db.exec('PRAGMA fullfsync=ON')
    const txn = async body => {
      for (let attempt = 0; ; attempt++) {
        try {
          db.exec('BEGIN IMMEDIATE')
          break
        } catch (e) {
          if (attempt >= 5) throw e
          await new Promise(res => setTimeout(res, 5 + Math.random() * 40))
        }
      }
      try {
        const bytes = body()
        db.exec('COMMIT')
        return bytes
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw e
      }
    }
    if (w.kind === 'mailbox') {
      const nextSeq = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM messages WHERE inbox=?')
      const ins = db.prepare(
        'INSERT INTO messages(inbox,seq,id,sender,ts,read,body) VALUES(?,?,?,?,?,?,?)',
      )
      return () =>
        txn(() => {
          const seq = nextSeq.get('bench').s
          const m = makeMessage(seq, w.msgBytes)
          ins.run('bench', seq, m.id, m.from, m.timestamp, 0, m.text)
          return JSON.stringify(m).length
        })
    }
    if (w.kind === 'sidecar') {
      const insEv = db.prepare('INSERT INTO run_events(owner,seq,event) VALUES(?,?,?)')
      const updHead = db.prepare(
        'UPDATE run_head SET write_seq=?, updated_at=? WHERE owner=?',
      )
      const nextSeq = db.prepare(
        'SELECT COALESCE(MAX(seq),0)+1 AS s FROM run_events WHERE owner=?',
      )
      return () =>
        txn(() => {
          const seq = nextSeq.get('bench-owner').s
          const ev = JSON.stringify(makeRunEvent(seq))
          insEv.run('bench-owner', seq, ev)
          updHead.run(seq, Date.now(), 'bench-owner')
          return ev.length
        })
    }
    if (w.kind === 'task') {
      const nextId = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS s FROM tasks WHERE list=?')
      const ins = db.prepare('INSERT INTO tasks(list,id,body) VALUES(?,?,?)')
      return () =>
        txn(() => {
          const id = nextId.get('bench').s
          const body = makeTaskBody(id)
          ins.run('bench', id, body)
          return body.length
        })
    }
  }

  if (arm === 'C') {
    // Append-only event log as the authority. Open-per-append matches the one
    // production append-only store of the old fire estate (retired), which
    // also does NOT fsync its appends — sub 'none' is that production shape.
    const log = within(join(dir, 'events.jsonl'))
    let localSeq = 0
    const makeLine = () => {
      localSeq++
      if (w.kind === 'mailbox') {
        return JSON.stringify({ t: 'send', msg: makeMessage(0, w.msgBytes), seq: localSeq })
      }
      if (w.kind === 'sidecar') {
        return JSON.stringify({ t: 'run-event', ev: makeRunEvent(localSeq), seq: localSeq })
      }
      return JSON.stringify({ t: 'task-create', id: randomUUID(), body: makeTaskBody(0), seq: localSeq })
    }
    return async () => {
      const line = makeLine() + '\n'
      const fd = openSync(log, 'a')
      try {
        writeSync(fd, line)
        if (sub === 'fsync') fsyncSync(fd)
        else if (sub === 'fdatasync') fdatasyncSync(fd)
      } finally {
        closeSync(fd)
      }
      PHYS += line.length
      return line.length
    }
  }

  if (arm === 'A') {
    // Daemon single-writer: newline-JSON over a unix socket; latency is the
    // client-observed commit round-trip (send → durable ack).
    const sock = sub
    const conn = connect(sock)
    await new Promise((res, rej) => {
      conn.once('connect', res)
      conn.once('error', rej)
    })
    conn.setNoDelay(true)
    let buf = ''
    const waiters = []
    conn.on('data', d => {
      buf += String(d)
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const wtr = waiters.shift()
        if (wtr) wtr(JSON.parse(line))
      }
    })
    return async () => {
      const payload =
        w.kind === 'mailbox'
          ? { op: 'commit', kind: 'mailbox', msgBytes: w.msgBytes }
          : w.kind === 'sidecar'
            ? { op: 'commit', kind: 'sidecar' }
            : { op: 'commit', kind: 'task' }
      const reply = await new Promise((res, rej) => {
        waiters.push(res)
        conn.write(JSON.stringify(payload) + '\n', err => err && rej(err))
      })
      if (!reply.ok) throw new Error('daemon nack: ' + JSON.stringify(reply))
      return w.kind === 'mailbox' ? w.msgBytes : 250
    }
  }

  throw new Error(`unknown arm ${armSpec} workload ${w.kind}`)
}

async function modeCommit() {
  const [, armSpec, workloadSpec, opsS, deadlineS, dir, id] = argv
  const ops = Number(opsS)
  const deadlineMs = Number(deadlineS)
  within(dir)
  const hardKill = setTimeout(() => {
    writeSync(2, `worker ${id} hit hard deadline\n`)
    process.exit(3)
  }, deadlineMs + 10_000)
  const commit = await makeCommitter(armSpec, parseWorkload(workloadSpec), dir)
  await waitForGo()
  const start = Date.now()
  const times = []
  let failures = 0
  let logicalBytes = 0
  let truncated = false
  for (let i = 0; i < ops; i++) {
    if (Date.now() - start > deadlineMs) {
      truncated = true
      break
    }
    const t0 = performance.now()
    try {
      logicalBytes += await commit()
      times.push(performance.now() - t0)
    } catch (e) {
      failures++
      writeSync(2, `commit failure (${id}): ${e?.message ?? e}\n`)
    }
  }
  clearTimeout(hardKill)
  console.log(
    'DONE ' +
      JSON.stringify({
        id,
        summary: summarize(times),
        times: times.map(t => +t.toFixed(3)),
        failures,
        logicalBytes,
        physicalBytes: PHYS,
        truncated,
      }),
  )
  process.exit(0)
}

async function modeDaemon() {
  const [, sock, workloadSpec, storePath, batchMode, deadlineS] = argv
  const w = parseWorkload(workloadSpec)
  within(storePath)
  within(sock)
  const r = await loadReal()
  const deadline = Number(deadlineS)
  setTimeout(() => {
    writeSync(2, 'daemon hit hard deadline\n')
    process.exit(3)
  }, deadline)
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.resume()

  // Boot restore — the daemon's own recovery path: read the last committed
  // store (torn-impossible via atomic publish) or start empty.
  let state
  let writeSeq = 0
  try {
    const raw = readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (w.kind === 'mailbox') state = Array.isArray(parsed) ? parsed : (parsed.messages ?? [])
    else state = parsed.snapshot ?? makeRunSnapshot('bench-owner')
    writeSeq = parsed.writeSeq ?? state.reduce?.((mx, m) => Math.max(mx, m.seq ?? 0), 0) ?? 0
  } catch {
    state = w.kind === 'mailbox' ? [] : makeRunSnapshot('bench-owner')
  }

  let publishes = 0
  let publishedBytes = 0
  const faultAfter = Number(process.env.KEEL_FAULT_AFTER ?? 0)
  const faultSpec = process.env.KEEL_FAULT_SPEC ?? ''

  async function publish() {
    let raw
    if (w.kind === 'mailbox') {
      raw = JSON.stringify({ writeSeq, messages: state }, null, 2)
    } else {
      raw = sidecarWrapper(writeSeq, state)
    }
    publishes++
    if (faultAfter > 0 && publishes > faultAfter && faultSpec) {
      // Arm the REAL fault seam (durablePublish.faultPoint) mid-run: the next
      // publish dies at the configured phase with SIGKILL.
      process.env.MERCURY_FAULT_INJECT = faultSpec
      process.env.MERCURY_FAULT_INJECT = faultSpec
    }
    await r.durableAtomicPublish(storePath, raw)
    publishedBytes += raw.length
  }

  const queue = []
  let pumping = false
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        // 'group' drains everything queued behind ONE durable publish (group
        // commit — the single-writer's structural advantage); 'serial'
        // publishes per request (the naive shape).
        const batch = batchMode === 'group' ? queue.splice(0) : queue.splice(0, 1)
        for (const item of batch) {
          writeSeq++
          if (w.kind === 'mailbox') {
            const m = makeMessage(writeSeq, item.req.msgBytes ?? w.msgBytes)
            state = compactMailbox([...state, m])
          } else {
            state.recentEvents.push(makeRunEvent(writeSeq))
            if (state.recentEvents.length > 40) state.recentEvents.shift()
            state.updatedAt = Date.now()
            state.totalEvents++
          }
          item.seq = writeSeq
        }
        await publish()
        for (const item of batch) {
          item.conn.write(JSON.stringify({ ok: true, seq: item.seq }) + '\n')
        }
      }
    } finally {
      pumping = false
    }
  }

  const server = createServer(conn => {
    conn.setNoDelay(true)
    let buf = ''
    conn.on('data', d => {
      buf += String(d)
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        let req
        try {
          req = JSON.parse(line)
        } catch {
          continue
        }
        if (req.op === 'read') {
          conn.write(JSON.stringify({ ok: true, writeSeq, state }) + '\n')
          continue
        }
        queue.push({ conn, req })
        void pump()
      }
    })
    conn.on('error', () => {})
  })
  server.listen(sock, () => {
    console.log('READY')
  })
  process.on('exit', () => {
    writeSync(2, 'STATS ' + JSON.stringify({ publishes, publishedBytes }) + '\n')
  })
}

async function modeCrashCommit() {
  const [, armSpec, workloadSpec, dir, faultAfterS, faultSpec] = argv
  within(dir)
  const faultAfter = Number(faultAfterS ?? 0)
  const commit = await makeCommitter(armSpec, parseWorkload(workloadSpec), dir)
  setTimeout(() => process.exit(3), 60_000) // self-terminating backstop
  for (let i = 1; i <= 100_000; i++) {
    if (faultAfter > 0 && i === faultAfter + 1 && faultSpec && faultSpec !== '-') {
      process.env.MERCURY_FAULT_INJECT = faultSpec
      process.env.MERCURY_FAULT_INJECT = faultSpec
    }
    await commit()
    ackSync('ACK ' + i)
  }
}

async function modeVerify() {
  const [, armSpec, workloadSpec, dir] = argv
  const [arm] = armSpec.split(':')
  const w = parseWorkload(workloadSpec)
  const out = { arm, ok: false }
  try {
    if (arm === 'S' || arm === 'A') {
      const file =
        arm === 'A'
          ? join(dir, 'daemon-store.json')
          : w.kind === 'mailbox'
            ? join(dir, 'inbox.json')
            : join(dir, 'bench.run.json')
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) // throws on a torn file = FAIL (atomicity broken)
      if (w.kind === 'mailbox') {
        const msgs = Array.isArray(parsed) ? parsed : parsed.messages
        out.maxSeq = msgs.reduce((mx, m) => Math.max(mx, m.seq ?? 0), 0)
        out.count = msgs.length
        out.writeSeq = parsed.writeSeq ?? out.maxSeq
      } else {
        out.writeSeq = parsed.writeSeq
        out.eventsLen = parsed.snapshot?.recentEvents?.length
      }
      // Leftover exclusive temps from the killed publish (swept at next boot
      // by the recovery orchestrator; reported here as evidence).
      out.orphanTemps = readdirSync(dir).filter(n => n.endsWith('.tmp')).length
      out.ok = true
    } else if (arm === 'B') {
      const db = await sqliteOpen(within(join(dir, 'bench.db')))
      out.integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check
      if (w.kind === 'mailbox') {
        const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS m, COUNT(*) AS c FROM messages WHERE inbox=?').get('bench')
        out.maxSeq = row.m
        out.count = row.c
        out.contiguous = row.m === row.c
      } else {
        out.maxSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE owner=?').get('bench-owner').m
        out.headSeq = db.prepare('SELECT write_seq AS s FROM run_head WHERE owner=?').get('bench-owner')?.s
      }
      db.close()
      out.ok = out.integrity === 'ok'
    } else if (arm === 'C') {
      const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      const folded = foldLogLines(raw)
      out.maxSeq = folded.maxSeq
      out.torn = folded.torn
      out.interleaved = folded.interleaved
      out.total = folded.total
      out.ok = folded.interleaved === 0 && folded.torn <= 1
    }
  } catch (e) {
    out.error = String(e?.message ?? e)
  }
  console.log('DONE ' + JSON.stringify(out))
}

async function modeBuildLog() {
  const [, dir, nS, snapEveryS] = argv
  const n = Number(nS)
  const snapEvery = Number(snapEveryS ?? 0)
  const r = snapEvery > 0 ? await loadReal() : null
  within(dir)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'events.jsonl')
  const fd = openSync(log, 'w')
  let offset = 0
  let folded = []
  const byId = new Map()
  for (let seq = 1; seq <= n; seq++) {
    const m = makeMessage(seq, 700)
    const lines = [JSON.stringify({ t: 'send', msg: m, seq })]
    byId.set(m.id, m)
    // ~60% of messages get marked read two events later — keeps the folded
    // projection realistic (compaction has read messages to drop).
    if (seq % 5 !== 0 && byId.size > 2) {
      const olderId = [...byId.keys()][Math.max(0, byId.size - 3)]
      lines.push(JSON.stringify({ t: 'read', id: olderId }))
    }
    for (const line of lines) {
      const b = Buffer.from(line + '\n')
      writeSync(fd, b)
      offset += b.length
    }
    if (snapEvery > 0 && seq % snapEvery === 0) {
      folded = foldLogLines(readFileSync(log, 'utf8')).messages
      // (the room-log snapshot arm retired with the multiplayer estate —
      // snapEvery now folds WITHOUT persisting a snapshot)
    }
  }
  closeSync(fd)
  console.log('DONE ' + JSON.stringify({ bytes: offset, events: n }))
}

async function modeFold() {
  const kind = argv[1]
  const reps = Number(argv[argv.length - 1])
  const times = []
  let detail = {}
  if (kind === 'log') {
    const dir = argv[2]
    if (argv[3] === 'snap') {
      throw new Error('the snapshot fold arm retired with the room log it borrowed (the multiplayer retirement) — run the plain log fold')
    }
    const log = join(dir, 'events.jsonl')
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now()
      {
        const folded = foldLogLines(readFileSync(log, 'utf8'))
        detail = { messages: folded.messages.length, total: folded.total }
      }
      times.push(performance.now() - t0)
    }
  } else if (kind === 'store') {
    const path = argv[2]
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now()
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const arr = Array.isArray(parsed) ? parsed : (parsed.messages ?? parsed.snapshot?.recentEvents ?? [])
      detail = { records: arr.length }
      times.push(performance.now() - t0)
    }
  } else if (kind === 'sqlite') {
    const path = argv[2]
    const sqlite = await import('node:sqlite')
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now()
      // Restore semantics: a fresh session opens the DB and materializes the
      // projection (open cost included — that IS the read path for a new
      // process).
      const db = new sqlite.DatabaseSync(path, { readOnly: true })
      const rows = db.prepare('SELECT seq,id,sender,ts,read,body FROM messages WHERE inbox=? ORDER BY seq').all('bench')
      db.close()
      detail = { records: rows.length }
      times.push(performance.now() - t0)
    }
  }
  console.log('DONE ' + JSON.stringify({ summary: summarize(times), ...detail }))
}

// Positioned read helper (fs.readSync with position).
import { readSync as fsReadSync } from 'node:fs'
function readIntoSync(fd, buf, bufOffset, filePos) {
  return fsReadSync(fd, buf, bufOffset, buf.length - bufOffset, filePos)
}

async function modeReadRtt() {
  const [, sock, repsS] = argv
  const reps = Number(repsS)
  const conn = connect(sock)
  await new Promise((res, rej) => {
    conn.once('connect', res)
    conn.once('error', rej)
  })
  conn.setNoDelay(true)
  let buf = ''
  const waiters = []
  conn.on('data', d => {
    buf += String(d)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      waiters.shift()?.(line)
    }
  })
  const times = []
  let bytes = 0
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now()
    const line = await new Promise(res => {
      waiters.push(res)
      conn.write('{"op":"read"}\n')
    })
    times.push(performance.now() - t0)
    bytes = line.length
  }
  conn.end()
  console.log('DONE ' + JSON.stringify({ summary: summarize(times), stateBytes: bytes }))
}

const modes = {
  'probe-fsync': modeProbeFsync,
  'init-sqlite': modeInitSqlite,
  commit: modeCommit,
  daemon: modeDaemon,
  'crash-commit': modeCrashCommit,
  verify: modeVerify,
  'build-log': modeBuildLog,
  fold: modeFold,
  'read-rtt': modeReadRtt,
}

const fn = modes[mode]
if (!fn) {
  writeSync(2, `unknown mode: ${mode}\n`)
  process.exit(2)
}
fn().then(
  () => {
    if (mode !== 'daemon' && mode !== 'crash-commit') process.exit(0)
  },
  e => {
    writeSync(2, `worker ${mode} failed: ${e?.stack ?? e}\n`)
    process.exit(1)
  },
)
