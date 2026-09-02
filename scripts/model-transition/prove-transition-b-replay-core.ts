#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-b-replay-core.ts — B01/B02/B03/
//  B05/: the replay core.
//
//    §A — arbitrary committed points materialize DETERMINISTICALLY
//       (identical inputs ⇒ identical state ⇒ identical digest), on the
//       fold's OWN full-read path (no precompact-skip import)
//    §B — full replay ≡ snapshot + suffix: the kernel law (prefix fold
//       continued over the tail ≡ full fold) AND the REAL resume-snapshot
//       round-trip (writeResumeSnapshot → tryLoadResumeSnapshot → tail fold)
//       land on the same digest; repeated replay is stable
//    §C — replay performs ZERO side effects: no fetch, no fs writes,
//       no api/tool imports in the materialize module
//    §D — branch manifests preserve immutable lineage: full manifest,
//       byte-identical ancestor, the fork boundary written through the
//       WRITER's encoder round-trips the reserved vocabulary, legacy
//       transcripts refuse typed (NO-MIGRATION)
//    §E — branches retain independent mutable state: mutating one
//       branch moves neither the source nor a sibling
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-b-core-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')
const {
  materializeEntriesAt,
  materializeTranscriptAt,
  materializationDigest,
  readAllTranscriptEntries,
} = await import('../../src/utils/sessionStorage/materialize.js')
const { applyTranscriptEntry } = await import('../../src/utils/sessionStorage/loading.js')
const { writeResumeSnapshot, tryLoadResumeSnapshot } = await import(
  '../../src/utils/sessionStorage/resumeSnapshot.js'
)
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const { createBranchSession, readBranchManifest } = await import(
  '../../src/services/branches/branchManifest.js'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// ── the synthetic vNext transcript (via the WRITER's own encoder) ───────────
const SID = 'b1b1b1b1-c2c2-d3d3-e4e4-f5f5f5f5f5f5'
const SRC = join(HOME, `${SID}.jsonl`)
const N = 12
{
  let text = ''
  for (let i = 1; i <= N; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant'
    const entry = {
      type: role,
      message:
        role === 'user'
          ? { role, content: `turn ${i}` }
          : { role, content: [{ type: 'text', text: `reply ${i}` }] },
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: new Date(1754000000000 + i * 1000).toISOString(),
      sessionId: SID,
    }
    // encodeTranscriptLine probes the FILE to pick the format — write
    // incrementally so line 1 mints the vNext header exactly once.
    writeFileSync(SRC, text, { flag: 'w' })
    const enc = encodeTranscriptLine(SRC, entry as never)
    text += enc.line
  }
  writeFileSync(SRC, text)
}

section('§A B01 — deterministic materialization at arbitrary committed points')
{
  const entries = await readAllTranscriptEntries(SRC)
  // The vNext file HEADER is itself a committed line (entry #1 in the
  // ordinal universe) — the fold skips it semantically but replay counts it.
  check(`the OWN full-read decodes all ${N} messages + the header`, entries.length === N + 1, `got ${entries.length}`)
  for (const ord of [1, 5, N]) {
    const a = materializeEntriesAt(entries, ord)
    const b = materializeEntriesAt(await readAllTranscriptEntries(SRC), ord)
    check(`ordinal ${ord}: identical inputs ⇒ identical digest`, a.digest === b.digest)
    check(`ordinal ${ord}: the fold covers exactly ${ord} entr${ord === 1 ? 'y' : 'ies'}`, a.ordinal === ord)
  }
  const viaFile = await materializeTranscriptAt(SRC, 7)
  const viaEntries = materializeEntriesAt(entries, 7)
  check('file-path and entries-path agree', viaFile.digest === viaEntries.digest)
  const src = readFileSync(join(import.meta.dir, '../../src/utils/sessionStorage/materialize.ts'), 'utf8')
  check('the full-read path never imports the precompact skip', !src.includes('SKIP_PRECOMPACT_THRESHOLD'))
  check('digest canonicalization is map-order-free (sorted entries)', src.includes('entries.sort'))
}

section('§B B02 — full replay ≡ snapshot + suffix (kernel law + the REAL store)')
{
  const entries = await readAllTranscriptEntries(SRC)
  const full = materializeEntriesAt(entries)
  // kernel law: prefix fold continued over the suffix ≡ full fold
  const k = 6
  const prefix = materializeEntriesAt(entries, k)
  for (let i = k; i < entries.length; i++) applyTranscriptEntry(prefix.fold, entries[i]!)
  check('prefix fold + suffix ≡ full fold (digest equality)', materializationDigest(prefix.fold) === full.digest)
  // repeated replay is stable
  check('repeated full replay is digest-stable', materializeEntriesAt(entries).digest === full.digest)
  // the REAL resume-snapshot store round-trip
  const snapPrefix = materializeEntriesAt(entries, k)
  // byte cursor of the prefix: walk raw lines exactly as the branch walk does
  const raw = readFileSync(SRC, 'utf8')
  const lines = raw.split('\n')
  let covered = 0
  let cursor = 0
  for (const line of lines) {
    if (covered >= k) break
    cursor += Buffer.byteLength(line) + 1
    if (line.trim()) covered += decodeTranscriptBuffer(line).entries.length
  }
  writeResumeSnapshot(SRC, snapPrefix.fold, cursor)
  const hit = await tryLoadResumeSnapshot(SRC)
  check('the snapshot store answers (proof-on-read passed)', hit !== null)
  if (hit) {
    const tailEntries = decodeTranscriptBuffer(hit.tail).entries
    for (const e of tailEntries) applyTranscriptEntry(hit.fold, e as never)
    check(
      'snapshot + suffix materialization ≡ the full replay digest',
      materializationDigest(hit.fold) === full.digest,
    )
  }
}

section('§C B03 — replay performs zero side effects')
{
  // Bun's fs namespace is readonly — observe the WORLD instead of patching:
  // the sandboxed home's full recursive listing (+ per-file digests) must be
  // bit-identical across replay, and the fetch spy must never fire.
  const { readdirSync, statSync } = await import('node:fs')
  const worldState = (): string => {
    const rows: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else rows.push(`${p}:${st.size}:${sha(readFileSync(p))}`)
      }
    }
    walk(HOME)
    return sha(rows.join('\n'))
  }
  let fetches = 0
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = ((...a: unknown[]) => {
    fetches++
    return (origFetch as (...x: unknown[]) => unknown)(...a)
  }) as never
  const before = worldState()
  try {
    await materializeTranscriptAt(SRC)
    await materializeTranscriptAt(SRC, 3)
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = origFetch
  }
  check('zero fetches during replay', fetches === 0)
  check('the world is bit-identical after replay (zero fs mutations)', worldState() === before)
  const src = readFileSync(join(import.meta.dir, '../../src/utils/sessionStorage/materialize.ts'), 'utf8')
  check(
    'the module imports no model/tool/agent machinery',
    !/services\/api|tools\/|callModel|Agent|query\//.test(src),
  )
}

section('§D B05 — branch manifests preserve immutable lineage')
{
  const before = sha(readFileSync(SRC))
  const res = createBranchSession({
    sourceTranscriptPath: SRC,
    forkOrdinal: 8,
    boundaryKind: 'fork',
    cwd: '/tmp/project',
    providerOrigin: 'anthropic claude-opus-5',
  })
  check('branch creation succeeds on a vNext source', res.ok, res.ok ? '' : res.reason)
  if (res.ok) {
    check('the ancestor stays byte-identical', sha(readFileSync(SRC)) === before)
    const m = res.manifest
    check(
      'the manifest names the full lineage',
      m.parentSessionId === SID &&
        m.forkOrdinal === 8 &&
        m.boundaryKind === 'fork' &&
        m.sourceSnapshotDigest.length === 64 &&
        m.project.cwd === '/tmp/project' &&
        m.providerOrigin.includes('opus') &&
        m.receipt.includes('ordinal 8'),
    )
    check('the manifest round-trips from disk', readBranchManifest(res.branchTranscriptPath)?.branchSessionId === m.branchSessionId)
    const branchEntries = decodeTranscriptBuffer(readFileSync(res.branchTranscriptPath)).entries as Array<Record<string, unknown>>
    check('the branch head is the fork prefix + ONE boundary', branchEntries.length === 9, `got ${branchEntries.length}`)
    const boundary = branchEntries[8]!
    check(
      "the boundary projects as the reserved 'fork' vocabulary",
      boundary.type === 'system' && boundary.subtype === 'fork_boundary',
      JSON.stringify(boundary).slice(0, 120),
    )
    // the branch prefix materializes to the SAME digest the manifest sealed
    const branchPoint = materializeEntriesAt(branchEntries as never, 8)
    check('the branch prefix materializes to the sealed source digest', branchPoint.digest === m.sourceSnapshotDigest)
  }
  // legacy refusal (NO-MIGRATION)
  const LEGACY = join(HOME, 'legacy.jsonl')
  writeFileSync(
    LEGACY,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'old' }, uuid: '00000000-0000-4000-8000-00000000aaaa', timestamp: new Date(1754000000000).toISOString(), sessionId: 'legacy' }) + '\n',
  )
  const ref = createBranchSession({
    sourceTranscriptPath: LEGACY,
    forkOrdinal: 1,
    boundaryKind: 'fork',
    cwd: '/tmp/project',
    providerOrigin: 'anthropic',
  })
  check('a legacy transcript refuses TYPED (never silent migration)', !ref.ok && String(!ref.ok && ref.reason).includes('unsupported-for-branch'))
}

section('§E B06 — branches retain independent mutable state')
{
  const b1 = createBranchSession({ sourceTranscriptPath: SRC, forkOrdinal: 4, boundaryKind: 'fork', cwd: '/x', providerOrigin: 'p' })
  const b2 = createBranchSession({ sourceTranscriptPath: SRC, forkOrdinal: 10, boundaryKind: 'rewind', cwd: '/x', providerOrigin: 'p' })
  check('two simultaneous branches mint distinct identities', b1.ok && b2.ok && b1.manifest.branchSessionId !== b2.manifest.branchSessionId)
  if (b1.ok && b2.ok) {
    check("the second branch carries the 'rewind' vocabulary", b2.manifest.boundaryKind === 'rewind')
    const srcBefore = sha(readFileSync(SRC))
    const b2Before = sha(readFileSync(b2.branchTranscriptPath))
    // mutate branch 1 through the writer's encoder
    const enc = encodeTranscriptLine(b1.branchTranscriptPath, {
      type: 'user',
      message: { role: 'user', content: 'branch-only work' },
      uuid: '00000000-0000-4000-8000-00000000bbbb',
      timestamp: new Date(1754000100000).toISOString(),
      sessionId: b1.manifest.branchSessionId,
    } as never)
    appendFileSync(b1.branchTranscriptPath, enc.line)
    check('mutating branch 1 never moves the source', sha(readFileSync(SRC)) === srcBefore)
    check('mutating branch 1 never moves branch 2', sha(readFileSync(b2.branchTranscriptPath)) === b2Before)
    const g1 = materializeEntriesAt(decodeTranscriptBuffer(readFileSync(b1.branchTranscriptPath)).entries as never)
    const g2 = materializeEntriesAt(decodeTranscriptBuffer(readFileSync(b2.branchTranscriptPath)).entries as never)
    check('the branches materialize to independent states', g1.digest !== g2.digest)
  }
}

console.log(
  failures === 0
    ? '\n ✅ REPLAY CORE — deterministic points, snapshot+suffix law, zero side effects, immutable lineage, independent branches'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
