#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-payload-equivalence.ts — the model-facing
//  payload must stay SEMANTICALLY IDENTICAL across the Slice-4 optimizations
//  ("add payload-equivalence
//  fixtures before and after the optimization").
//
//  STATUS: LIVE — runs against current HEAD (fixture-captured request bodies;
//  no integrator seams needed).
//
//  Modes:
//    --record <baseline.json>   run the corpus, write shape-hashed digests
//    --check  <baseline.json>   run the corpus, compare, LOUD diff on drift
//    (no args)                  self-test: record to scratch, run the corpus
//                               again, check — proves the mechanics AND that
//                               the corpus itself is deterministic
//
//  The integrator workflow: `--record` BEFORE touching the attachment/context
//  path, `--check` after every optimization. The baseline stores shape hashes
//  only (block type + normalized length + sha256) — no prompt text; set
//  PULSE_PAYLOAD_RAW=1 during --record/--check to ALSO write a *.raw.json
//  beside the baseline with the normalized texts for manual diffing (operator
//  debugging aid, deliberately opt-in).
//
//  Normalization before hashing (semantic comparison, not byte comparison):
//  uuids, ISO timestamps, dates, clock times, the hermetic cwd/home paths,
//  and loopback host:port — everything else must match EXACTLY, in order
//  (tool ORDER is cache-law-bound; sorting would hide a real break).
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-payload-equivalence.ts
// ============================================================================

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, section, finish, armWatchdog } from '../lib/proveKit.ts'
import { runPulseArena, type PulseRun } from '../lib/pulseArena.ts'

armWatchdog('PULSE payload equivalence', 240_000)

// ── the corpus scene ────────────────────────────────────────────────────────
// Two plain-text turns over a seeded project (MERCURY.md exercises the
// instruction producer; the second turn exercises the warm/delta path).

async function runCorpus(): Promise<PulseRun> {
  return runPulseArena({
    turns: [
      { kind: 'text', text: 'corpus reply one.' },
      { kind: 'text', text: 'corpus reply two.' },
    ],
    // OBSERVED-READY sends: the
    // old fixed ticks let runs A and B straddle turn one's settle under
    // machine load, so turn two composed DIFFERENT warm/delta payloads —
    // real state divergence, honestly digested. State-anchored sends make
    // the runtime state at each submit deterministic: type after the
    // composer paints (❯), submit after the typed line settles, and turn
    // two only after turn one's reply is ON SCREEN. A needle that never
    // paints never sends — the two-requests check stays the loud failure.
    sends: [
      'after:❯:800:corpus turn one',
      'after:❯:1400:\\r',
      'after:corpus reply one.:1200:corpus turn two',
      'after:corpus reply one.:1800:\\r',
    ],
    seconds: 18,
    seedCwd: {
      'MERCURY.md': '# Corpus project\n\nDeterministic fixture project for payload equivalence.\n',
      'src/main.ts': 'export const answer = 42\n',
    },
  })
}

// ── normalization + digesting ───────────────────────────────────────────────

interface NormalizeCtx {
  cwd: string
  home: string
}

function normalizeText(s: string, ctx: NormalizeCtx): string {
  let out = s
  for (const p of [ctx.cwd, `/private${ctx.cwd}`, ctx.home, `/private${ctx.home}`]) {
    out = out.split(p).join('<hermetic-path>')
    // the projects-dir encoding mangles the path with dashes
    // (…/projects/-private-var-…-pulse-arena-cwd-xxxxxx/…)
    out = out.split(p.replaceAll('/', '-')).join('<hermetic-path-dashed>')
  }
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  out = out.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, '<iso-ts>')
  out = out.replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
  out = out.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/g, '<time>')
  out = out.replace(/127\.0\.0\.1:\d+/g, '<loopback>')
  return out
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

interface BlockDigest {
  type: string
  len: number
  hash: string
  name?: string
}

interface RequestDigest {
  model: string
  maxTokens: number | null
  stream: boolean
  system: BlockDigest[]
  messages: { role: string; blocks: BlockDigest[] }[]
  tools: { name: string; hash: string }[]
}

interface Baseline {
  version: 1
  note: string
  requests: RequestDigest[]
}

function digestContent(content: unknown, ctx: NormalizeCtx, raws: string[]): BlockDigest[] {
  if (typeof content === 'string') {
    const n = normalizeText(content, ctx)
    raws.push(n)
    return [{ type: 'string', len: n.length, hash: sha(n) }]
  }
  if (!Array.isArray(content)) return [{ type: typeof content, len: 0, hash: sha(JSON.stringify(content) ?? 'null') }]
  return content.map((block: Record<string, unknown>) => {
    const type = String(block.type ?? 'unknown')
    // Hash the whole normalized block minus volatile keys so tool_use ids
    // and cache_control placement changes surface as SHAPE drift.
    const clone: Record<string, unknown> = { ...block }
    if (typeof clone.id === 'string') clone.id = '<block-id>'
    if (typeof clone.tool_use_id === 'string') clone.tool_use_id = '<block-id>'
    const n = normalizeText(JSON.stringify(clone), ctx)
    raws.push(n)
    return {
      type,
      len: n.length,
      hash: sha(n),
      ...(typeof block.name === 'string' ? { name: block.name } : {}),
    }
  })
}

function digestRun(run: PulseRun, raws: string[]): RequestDigest[] {
  const ctx: NormalizeCtx = { cwd: run.paths.cwd, home: run.paths.home }
  return run.fixture.messageRequests().map(req => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : []
    const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : []
    return {
      model: String(body.model ?? ''),
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
      stream: body.stream === true,
      system: digestContent(body.system, ctx, raws),
      messages: messages.map(m => ({
        role: String(m.role ?? ''),
        blocks: digestContent(m.content, ctx, raws),
      })),
      tools: tools.map(t => ({
        name: String(t.name ?? ''),
        hash: sha(normalizeText(JSON.stringify(t), ctx)),
      })),
    }
  })
}

// ── comparison with a loud diff ─────────────────────────────────────────────

function diffDigests(a: RequestDigest[], b: RequestDigest[]): string[] {
  const out: string[] = []
  if (a.length !== b.length) out.push(`request COUNT drift: ${a.length} → ${b.length}`)
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const walk = (pa: unknown, pb: unknown, path: string): void => {
      if (out.length >= 24) return
      if (typeof pa !== 'object' || pa === null || typeof pb !== 'object' || pb === null) {
        if (JSON.stringify(pa) !== JSON.stringify(pb)) {
          out.push(`requests[${i}]${path}: ${JSON.stringify(pa)} → ${JSON.stringify(pb)}`)
        }
        return
      }
      const keys = new Set([...Object.keys(pa), ...Object.keys(pb)])
      for (const k of keys) {
        walk(
          (pa as Record<string, unknown>)[k],
          (pb as Record<string, unknown>)[k],
          `${path}.${k}`,
        )
      }
    }
    walk(a[i], b[i], '')
  }
  return out
}

// ── modes ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const mode = args[0]

if (mode === '--record' || mode === '--check') {
  const file = args[1]
  if (!file) {
    console.error(`usage: prove-payload-equivalence.ts ${mode} <baseline.json>`)
    process.exit(1)
  }
  const run = await runCorpus()
  const raws: string[] = []
  const digests = digestRun(run, raws)
  run.cleanup()
  if (process.env.PULSE_PAYLOAD_RAW) {
    writeFileSync(`${file}.raw.json`, JSON.stringify(raws, null, 2))
    console.log(`raw normalized texts → ${file}.raw.json`)
  }
  if (mode === '--record') {
    const baseline: Baseline = {
      version: 1,
      note: 'PULSE payload-equivalence baseline — record BEFORE Slice-4 optimizations, check after.',
      requests: digests,
    }
    writeFileSync(file, JSON.stringify(baseline, null, 2))
    console.log(`✅ recorded ${digests.length} request digests → ${file}`)
    process.exit(0)
  }
  const baseline = JSON.parse(readFileSync(file, 'utf8')) as Baseline
  const drift = diffDigests(baseline.requests, digests)
  section(`check against ${file}`)
  check('request count preserved', baseline.requests.length === digests.length, `${baseline.requests.length} → ${digests.length}`)
  check('payload digests semantically identical', drift.length === 0)
  if (drift.length > 0) {
    console.log('\n  DRIFT (semantic payload change — Slice-4 must not do this):')
    for (const d of drift) console.log(`    ${d}`)
    console.log('  (re-run both sides with PULSE_PAYLOAD_RAW=1 to diff the normalized texts)')
  }
  finish('PULSE payload equivalence (check)')
}

// self-test: record + independent re-run must digest identically.
section('self-test — mechanics + corpus determinism (two independent runs)')
{
  const scratch = mkdtempSync(join(tmpdir(), 'pulse-payload-'))
  const runA = await runCorpus()
  const digestsA = digestRun(runA, [])
  runA.cleanup()
  check('corpus run A produced two requests', digestsA.length === 2, String(digestsA.length))
  writeFileSync(join(scratch, 'baseline.json'), JSON.stringify({ version: 1, requests: digestsA }))

  const runB = await runCorpus()
  const digestsB = digestRun(runB, [])
  runB.cleanup()
  check('corpus run B produced two requests', digestsB.length === 2, String(digestsB.length))

  const drift = diffDigests(digestsA, digestsB)
  check('two independent corpus runs digest IDENTICALLY', drift.length === 0)
  if (drift.length > 0) for (const d of drift.slice(0, 24)) console.log(`    ${d}`)

  check(
    'the digest actually discriminates (a mutated tool name is caught)',
    (() => {
      const mutated: RequestDigest[] = JSON.parse(JSON.stringify(digestsB)) as RequestDigest[]
      if (mutated[0] && mutated[0].tools[0]) mutated[0].tools[0].name = '__mutant__'
      else if (mutated[0]) mutated[0].model = '__mutant__'
      return diffDigests(digestsA, mutated).length > 0
    })(),
  )
}

finish('PULSE payload equivalence (self-test)')
