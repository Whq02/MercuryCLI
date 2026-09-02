#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/gen-scale-corpus.ts — the
//  deterministic scale-transcript generator (1k / 10k / 100k turns; the
//  100k file is the 151MB-class body budget named and never
//  measured).
//
//  Determinism law: byte-identical output for (size, seed) on every run and
//  platform — uuids are counter-derived, timestamps derive from a fixed
//  epoch, prose from a seeded PRNG over a fixed word table, '\n' endings.
//  The bench receipt (docs/benchmarks/continuum/ctm0-scale-baseline.json)
//  pins sha256 digests; prove-transition-g07-corpus.ts regenerates and compares —
//  the corpus itself is NEVER committed (regenerate anywhere, provably
//  identical).
//
//  Shape (record lines over the entry field diet the loader
//  handles today; boundary-FREE so a cold parse measures the honest
//  full-history worst case, never the precompact skip):
//    turn = user ask → assistant reply (text + every-3rd tool_use) →
//           user tool_result (fat every 40th: 16KB; every 1000th: 256KB) +
//           occasional assistant thinking block (every 7th) and an
//           image-bearing user message (every 250th) — the exact block mix
//           the cross-provider encode-loss inventory classifies.
//
//  Usage: bun scripts/model-transition/gen-scale-corpus.ts [--turns N] [--out FILE]
//         (library: generateCorpus(turns, outFile))
// ============================================================================
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { entryToRecord } from '../../src/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/fabric/ordinal.ts'

// ── deterministic primitives ────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'session record fold ordinal provider transition snapshot suffix reconnect cursor branch lineage context plan closure reduction pointer receipt boundary settle canonical durable replay materialize digest epoch capability catalogue quota window posture handoff'.split(
    ' ',
  )

const EPOCH = Date.parse('2026-08-01T00:00:00.000Z')

function uuidAt(n: number): string {
  const hex = n.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

export interface CorpusSpec {
  turns: number
  seed?: number
}

/** Stream-write one deterministic transcript; returns line count. */
export async function generateCorpus(spec: CorpusSpec, outFile: string): Promise<number> {
  const rand = mulberry32(spec.seed ?? 0xc0ffee)
  const sentence = (words: number): string => {
    const parts: string[] = []
    for (let w = 0; w < words; w++) parts.push(WORDS[Math.floor(rand() * WORDS.length)]!)
    return parts.join(' ')
  }
  mkdirSync(dirname(outFile), { recursive: true })
  const stream = createWriteStream(outFile, { encoding: 'utf8' })
  let lines = 0
  let id = 0
  let parent: string | null = null
  // The durable format: every line is a MercuryRecord envelope, encoded
  // through the one codec with a deterministic ordinal clock.
  let ord = 0
  const ctx = {
    sessionId: 'continuum-corpus' as never,
    nextOrdinal: () => ordinalOf(++ord) as never,
    observedAt: new Date(EPOCH).toISOString(),
    source: { channel: 'sdk' } as const,
  }
  const write = (obj: Record<string, unknown>): Promise<void> | void => {
    lines++
    const ok = stream.write(JSON.stringify(entryToRecord(obj, ctx as never)) + '\n')
    if (!ok) return new Promise<void>(r => stream.once('drain', () => r()))
  }
  for (let t = 0; t < spec.turns; t++) {
    const ts = (n: number) => new Date(EPOCH + t * 45_000 + n * 1_000).toISOString()
    // 1) the user ask (every 250th carries an image block — the modality leg)
    const userUuid = uuidAt(id++)
    const userContent =
      t % 250 === 249
        ? [
            { type: 'text', text: `turn ${t}: ${sentence(24)}` },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(64) },
            },
          ]
        : `turn ${t}: ${sentence(36)}`
    await write({
      type: 'user',
      uuid: userUuid,
      parentUuid: parent,
      timestamp: ts(0),
      sessionId: 'continuum-corpus',
      message: { role: 'user', content: userContent },
    })
    parent = userUuid

    // 2) the assistant reply (+ thinking every 7th; + tool_use every 3rd)
    const asstUuid = uuidAt(id++)
    const toolUseId = `toolu_corpus_${t.toString(16).padStart(8, '0')}`
    const content: Record<string, unknown>[] = []
    if (t % 7 === 6) {
      content.push({ type: 'thinking', thinking: sentence(60), signature: 'corpus-sig-' + t })
    }
    content.push({ type: 'text', text: sentence(48) })
    if (t % 3 === 2) {
      content.push({
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command: `echo ${sentence(6).replace(/ /g, '-')}` },
      })
    }
    await write({
      type: 'assistant',
      uuid: asstUuid,
      parentUuid: parent,
      timestamp: ts(1),
      sessionId: 'continuum-corpus',
      requestId: `req_corpus_${t}`,
      message: {
        id: `msg_corpus_${t}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-fable-5',
        content,
        stop_reason: t % 3 === 2 ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 100 + (t % 900), output_tokens: 80 + (t % 400) },
      },
    })
    parent = asstUuid

    // 3) the tool_result (fat every 40th — 16KB; whale every 1000th — 256KB)
    if (t % 3 === 2) {
      const fat = t % 1000 === 999 ? 256 * 1024 : t % 40 === 39 ? 16 * 1024 : 0
      const body =
        fat > 0
          ? sentence(12) + '\n' + 'x'.repeat(fat)
          : sentence(30 + Math.floor(rand() * 40))
      const trUuid = uuidAt(id++)
      await write({
        type: 'user',
        uuid: trUuid,
        parentUuid: parent,
        timestamp: ts(2),
        sessionId: 'continuum-corpus',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body }],
        },
        toolUseResult: { stdout: fat > 0 ? '(persisted)' : body, stderr: '', interrupted: false },
      })
      parent = trUuid
    }
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
  return lines
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2)
  const turnsIdx = args.indexOf('--turns')
  const outIdx = args.indexOf('--out')
  const turns = turnsIdx >= 0 ? Number(args[turnsIdx + 1]) : 1000
  const out =
    outIdx >= 0
      ? args[outIdx + 1]!
      : join(tmpdir(), 'mercury-continuum-corpus', `corpus-${turns}t.jsonl`)
  const t0 = performance.now()
  const lines = await generateCorpus({ turns }, out)
  const { statSync } = await import('node:fs')
  const bytes = statSync(out).size
  console.log(
    `corpus: ${turns} turns → ${lines} lines · ${(bytes / 1024 / 1024).toFixed(1)} MB · ${(performance.now() - t0).toFixed(0)}ms → ${out}`,
  )
}
