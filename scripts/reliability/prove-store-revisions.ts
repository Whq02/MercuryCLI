// prove-store-revisions — revisioned FileStore snapshots + honest recovery
//
//
//   §1 a successful mutation advances the monotonic `_rev` EXACTLY once,
//      committed in the SAME rename as the value (object stores)
//   §2 legacy unstamped bytes read as revision:null and upgrade on first commit
//   §3 readResult is typed: missing ≠ recoverable ≠ ready
//   §4 the FC5 guard: a locked mutation over damaged bytes QUARANTINES the
//      only copy + records the recovery + resumes from last-good when known
//   §5 subscribeChanges: local commits arrive as 'local-commit' with the
//      committed revision and zero skips
//   §6 cross-process skip accounting: coalesced commits arrive as ONE
//      'catch-up' emission with the PROVABLE skipped count
//   §7 array stores derive revisions via revisionOf (bare on disk)
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'hermes-storerev-'))
const home = join(tmp, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home // recovery ledger isolation

const { defineStore } = await import('../../src/substrate/fileStore.ts')
const { readStoreRecoveryEvents } = await import('../../src/substrate/storeRecovery.ts')
const BUN = process.execPath

type Counter = { n: number }
const counterAt = (p: string) =>
  defineStore<Counter, []>({
    name: 'rev-counter',
    path: () => p,
    schemaVersion: 2,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as Counter).n === 'number'
        ? { n: (raw as Counter).n }
        : null,
    empty: () => ({ n: 0 }),
    onReadFailure: 'empty',
  })()

// ── §1 monotonic revision, exactly once per mutation ─────────────────────────
{
  const p = join(tmp, 's1.json')
  const s = counterAt(p)
  await s.write({ n: 1 })
  await s.mutate(v => ({ n: v.n + 1 }))
  await s.update(v => ({ next: { n: v.n + 1 }, result: null }))
  const rr = await s.readResult()
  ok(
    rr.state === 'ready' && rr.revision?.revision === 3,
    `§1 three mutations ⇒ revision 3 (${rr.state === 'ready' ? rr.revision?.revision : rr.state})`,
  )
  const onDisk = JSON.parse(readFileSync(p, 'utf8'))
  ok(
    onDisk._v === 2 && onDisk._rev?.revision === 3 && typeof onDisk._rev?.operationId === 'string' && typeof onDisk._rev?.digest === 'string',
    '§1 `_rev` rides beside `_v` in the same atomic publication',
  )
  // No-op mutation must NOT advance the revision.
  await s.mutate(v => v)
  const rr2 = await s.readResult()
  ok(
    rr2.state === 'ready' && rr2.revision?.revision === 3,
    '§1 a no-op mutation does not advance the revision',
  )
}

// ── §2 legacy unstamped bytes ────────────────────────────────────────────────
{
  const p = join(tmp, 's2.json')
  writeFileSync(p, JSON.stringify({ n: 5, _v: 1 }))
  const s = counterAt(p)
  const rr = await s.readResult()
  ok(
    rr.state === 'ready' && rr.revision === null && rr.value.n === 5,
    '§2 legacy bytes read ready with revision:null (never fabricated)',
  )
  await s.mutate(v => ({ n: v.n + 1 }))
  const rr2 = await s.readResult()
  ok(
    rr2.state === 'ready' && rr2.revision?.revision === 1,
    '§2 the first commit upgrades a legacy store to revision 1',
  )
}

// ── §3 typed read states ─────────────────────────────────────────────────────
{
  const missing = counterAt(join(tmp, 's3-absent.json'))
  const m = await missing.readResult()
  ok(m.state === 'missing' && m.value.n === 0, '§3 absent store reads as missing(empty)')
  const damagedPath = join(tmp, 's3-damaged.json')
  writeFileSync(damagedPath, 'NOT JSON {{{')
  const damaged = counterAt(damagedPath)
  const d = await damaged.readResult()
  ok(
    d.state === 'recoverable' && d.path === damagedPath && d.reason.length > 0,
    '§3 damaged store reads as recoverable (reason + path), never silently empty',
  )
}

// ── §4 the FC5 guard: quarantine + last-good resume ─────────────────────────
{
  const p = join(tmp, 's4.json')
  const s = counterAt(p)
  await s.write({ n: 7 }) // the runtime now KNOWS a committed value (rev 1)
  const DAMAGE = '{"the only": damaged copy!!'
  writeFileSync(p, DAMAGE)
  await s.mutate(v => ({ n: v.n + 1 }))
  const after = JSON.parse(readFileSync(p, 'utf8'))
  ok(after.n === 8, `§4 mutation resumed from LAST-GOOD (7+1=8, got ${after.n}) — not from empty`)
  const quarantines = readdirSync(tmp).filter(
    f => f.startsWith('s4.json.damaged-') && f.endsWith('.recovered'),
  )
  ok(quarantines.length === 1, '§4 the damaged bytes are preserved in a bounded quarantine copy')
  ok(
    quarantines.length === 1 &&
      readFileSync(join(tmp, quarantines[0]!), 'utf8') === DAMAGE,
    '§4 the quarantine holds the exact damaged bytes',
  )
  const events = await readStoreRecoveryEvents()
  const ev = events.find(e => e.path === p)
  ok(
    !!ev && ev.resumedFrom === 'last-good' && ev.quarantinePath !== null,
    '§4 the recovery is recorded in the ledger (resumedFrom last-good)',
  )
  ok(after._rev?.revision === 2, '§4 revision continuity survives the recovery (1 → 2)')
  // A cold process (no in-memory witness) resumes from empty — but still
  // quarantines first. Drive it via a child so the runtime is truly cold.
  const coldPath = join(tmp, 's4-cold.json')
  writeFileSync(coldPath, 'ALSO NOT JSON')
  const res = spawnSync(
    BUN,
    ['run', join(import.meta.dir, 'helpers', 'storeMutateChild.ts')],
    { env: { ...process.env, RELIA_STORE: coldPath }, encoding: 'utf8', timeout: 20_000 },
  )
  const coldQuarantines = readdirSync(tmp).filter(f => f.startsWith('s4-cold.json.damaged-'))
  ok(
    res.status === 0 && coldQuarantines.length === 1,
    '§4 a cold-runtime mutation still quarantines before proceeding from empty',
  )
}

// ── §5 local-commit change events ────────────────────────────────────────────
{
  const p = join(tmp, 's5.json')
  const s = counterAt(p)
  const changes: Array<{ cause: string; rev: number | null; skipped: number }> = []
  const unsub = s.subscribeChanges(
    c => changes.push({ cause: c.cause, rev: c.revision?.revision ?? null, skipped: c.skippedRevisions }),
    { immediate: false },
  )
  await s.write({ n: 1 })
  await sleep(150) // let the watcher echo arrive (it must DEDUP by op id)
  unsub()
  ok(
    changes.length === 1 &&
      changes[0]!.cause === 'local-commit' &&
      changes[0]!.rev === 1 &&
      changes[0]!.skipped === 0,
    `§5 one local-commit emission (rev 1, skipped 0) — watcher echo deduped by operation id (${JSON.stringify(changes)})`,
  )
}

// ── §6 cross-process provable skip accounting ────────────────────────────────
{
  const p = join(tmp, 's6.json')
  const s = defineStore<Counter, []>({
    name: 'rev-counter-s6',
    path: () => p,
    schemaVersion: 2,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as Counter).n === 'number'
        ? { n: (raw as Counter).n }
        : null,
    empty: () => ({ n: 0 }),
    onReadFailure: 'empty',
    watchDebounceMs: 400, // deterministic coalescing of the child's two commits
  })()
  await s.write({ n: 0 }) // baseline rev 1 — the subscriber's provable start
  let pinned = false
  let observed: Array<{ rev: number | null; skipped: number; cause: string }> = []
  for (let round = 0; round < 3 && !pinned; round++) {
    observed = []
    const unsub = s.subscribeChanges(
      c => observed.push({ rev: c.revision?.revision ?? null, skipped: c.skippedRevisions, cause: c.cause }),
      { immediate: false },
    )
    await sleep(800) // watcher attach (any catch-up lands here)
    observed = []
    const res = spawnSync(
      BUN,
      ['run', join(import.meta.dir, 'helpers', 'storeDoublePublishChild.ts')],
      { env: { ...process.env, RELIA_STORE: p }, encoding: 'utf8', timeout: 20_000 },
    )
    await sleep(1400)
    unsub()
    const last = observed.at(-1)
    pinned =
      res.status === 0 &&
      observed.length === 1 &&
      last?.cause === 'catch-up' &&
      last.skipped === 1 &&
      typeof last.rev === 'number'
    if (!pinned) await s.write({ n: 0 })
  }
  ok(
    pinned,
    `§6 two coalesced commits arrive as ONE catch-up emission with skippedRevisions=1 (${JSON.stringify(observed)})`,
  )
}

// ── §7 array stores derive revisions via revisionOf ─────────────────────────
{
  type Msg = { text: string; seq: number }
  const p = join(tmp, 's7.json')
  const s = defineStore<Msg[], []>({
    name: 'rev-array',
    path: () => p,
    schemaVersion: 1,
    decode: raw =>
      Array.isArray(raw)
        ? raw.filter((m): m is Msg => !!m && typeof (m as Msg).text === 'string')
        : null,
    empty: () => [],
    onReadFailure: 'empty',
    revisionOf: msgs => msgs.reduce((mx, m) => Math.max(mx, m.seq ?? 0), 0),
  })()
  await s.mutate(msgs => [...msgs, { text: 'a', seq: 1 }])
  await s.mutate(msgs => [...msgs, { text: 'b', seq: 2 }])
  const rr = await s.readResult()
  ok(
    rr.state === 'ready' && rr.revision?.revision === 2 && rr.revision.writerId === 'derived',
    '§7 array revision derives from revisionOf (bare array on disk)',
  )
  const onDisk = JSON.parse(readFileSync(p, 'utf8'))
  ok(Array.isArray(onDisk), '§7 the on-disk shape stays a BARE ARRAY (mixed-version compat)')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-store-revisions' : `\nFAIL prove-store-revisions (${failures})`)
process.exit(failures === 0 ? 0 : 1)
