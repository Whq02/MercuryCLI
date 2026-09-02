#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-refusal-fallback.ts — the opt-in server-side
//  refusal fallback (MERCURY_REFUSAL_FALLBACK), never a silent substitute.
//  The registry row names this suite as its evidence.
//
//  §1 THE GATE: a registered opt-in behavioral row whose evidence exists;
//     unset ⇒ the request owner answers null on every model (the wire is
//     byte-identical); '1' ⇒ armed; any other spelling ⇒ off; re-unset ⇒
//     off — a LIVE re-read on every call (the authority-toggles invariant).
//  §2 THE MODELS: armed, the owner answers the beta header plus
//     fallbacks:'default' exactly on the models the refusals page names —
//     Claude Fable 5.1, Fable 5 and Opus 5 (the Mythos mirrors through their
//     canonicals, the [1m] twins through the stripped id) — and null on
//     every other id: Sonnet 5, Opus 4.8, Haiku 4.5, a GPT engine, a
//     carrier-shaped row.
//  §3 THE BYLINE: the serving model outranks the requested one on the
//     waiting line and rides first among the thinking extras, marked
//     '(fallback)'; without a serving model every spelling is unchanged.
//  §4 THE WIRING (call-shaped needles at the owners): the stream pushes the
//     beta and spreads `fallbacks` from the one owner; message_start and
//     the `fallback` block both feed the served-model note; the mint stamps
//     `model` with the serving model; the bill prices a whole-turn rescue at
//     the serving model; the phase detail carries servedBy; the transcript
//     renders the `fallback` block naming both models; the wire vocabulary
//     carries the block, and the API normalizer passes it through untouched
//     so the turn echoes back verbatim (the server validates the boundary).
//
//  Pure: no network, no config home, no build.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

for (const k of [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_REFUSAL_FALLBACK',
]) {
  delete process.env[k]
}

const { FLAG_REGISTRY, flagEnabled } = await import('../../src/substrate/flagRegistry.ts')
const { SERVER_SIDE_FALLBACK_BETA_HEADER } = await import('../../src/constants/betas.ts')
const { modelSupportsServerSideFallback, refusalFallbackEnabled, refusalFallbackRequest } = await import(
  '../../src/utils/model/capabilities.ts'
)
const { composePhaseByline } = await import('../../src/components/Spinner/pulseByline.ts')
const { normalizeContentFromAPI } = await import('../../src/utils/messages.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const repoRoot = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf-8')
const show = (v: unknown): string => JSON.stringify(v)

const ENV = 'MERCURY_REFUSAL_FALLBACK'
const ARMED = { beta: 'server-side-fallback-2026-07-01', fallbacks: 'default' }
const armed = ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-mythos-5-1', 'claude-fable-5', 'claude-fable-5[1m]', 'claude-mythos-5', 'claude-opus-5', 'claude-opus-5[1m]']
const unarmed = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5', 'gpt-5.5', 'openrouter/anthropic/claude-fable-5-1']

// ── §1 the gate ─────────────────────────────────────────────────────────────
section('§1 the gate: a registered opt-in behavioral row, read live on every call')
{
  const row = FLAG_REGISTRY.find(f => f.env === ENV)
  check(
    'the registry row: opt-in · behavioral · evidenced by this suite · consumed by capabilities.ts',
    row?.kind === 'opt-in' &&
      row?.tier === 'behavioral' &&
      row?.evidence === 'scripts/model-registry/run-all.sh' &&
      row?.consumer === 'src/utils/model/capabilities.ts',
    show(row),
  )
  check('the named evidence exists on disk', Boolean(row?.evidence) && existsSync(join(repoRoot, row!.evidence!)))
  check(
    'the beta header constant is the fallbacks:default form of the refusals page',
    SERVER_SIDE_FALLBACK_BETA_HEADER === ARMED.beta,
    SERVER_SIDE_FALLBACK_BETA_HEADER,
  )

  delete process.env[ENV]
  check('unset ⇒ off (the gate reader and the owner agree)', !flagEnabled(ENV) && !refusalFallbackEnabled())
  check(
    'unset ⇒ null on every model, armed or not (a byte-identical wire)',
    [...armed, ...unarmed].every(m => refusalFallbackRequest(m) === null),
  )
  process.env[ENV] = '1'
  check("'1' ⇒ armed (live re-read)", flagEnabled(ENV) && refusalFallbackEnabled())
  process.env[ENV] = 'true'
  check("'true' ⇒ off (an opt-in reads exactly '1')", !refusalFallbackEnabled())
  process.env[ENV] = '0'
  check("'0' ⇒ off", !refusalFallbackEnabled() && refusalFallbackRequest('claude-fable-5-1') === null)
  delete process.env[ENV]
  check('re-unset ⇒ off again', !refusalFallbackEnabled())
}

// ── §2 the models ───────────────────────────────────────────────────────────
section('§2 armed, the owner arms exactly the models the refusals page names')
{
  process.env[ENV] = '1'
  for (const m of armed) {
    check(`${m}: server-side fallback supported`, modelSupportsServerSideFallback(m))
    check(`${m}: beta + fallbacks:'default'`, show(refusalFallbackRequest(m)) === show(ARMED), show(refusalFallbackRequest(m)))
  }
  for (const m of unarmed) {
    check(`${m}: server-side fallback unsupported`, !modelSupportsServerSideFallback(m))
    check(`${m}: null even when armed`, refusalFallbackRequest(m) === null, show(refusalFallbackRequest(m)))
  }
  check(
    "the owner never carries a target list (fallbacks is the scalar 'default')",
    refusalFallbackRequest('claude-fable-5-1')?.fallbacks === 'default',
  )
  delete process.env[ENV]
}

// ── §3 the byline ───────────────────────────────────────────────────────────
section('§3 the byline names the serving model, marked (fallback), never silently')
{
  const wide = 200
  const served = { model: 'Fable 5.1', servedBy: 'Opus 5', effort: 'high' }
  const plain = { model: 'Fable 5.1', effort: 'high' }
  const line = (phase: 'waiting' | 'thinking', detail: typeof served | typeof plain, verb?: string, maxWidth = wide): string | null =>
    composePhaseByline({ phase, detail, activeToolCount: 0, maxWidth, verb })

  check(
    'waiting + verb: the serving model outranks the requested one',
    line('waiting', served, 'Pondering') === 'Pondering · waiting for Opus 5 (fallback) · high',
    String(line('waiting', served, 'Pondering')),
  )
  check(
    'waiting + verb, no serving model: the requested spelling is unchanged',
    line('waiting', plain, 'Pondering') === 'Pondering · waiting for Fable 5.1 · high',
    String(line('waiting', plain, 'Pondering')),
  )
  check(
    'waiting, no verb: the causal spelling names the serving model',
    line('waiting', served) === 'Waiting for Opus 5 (fallback) · high',
    String(line('waiting', served)),
  )
  check(
    'thinking + verb: the serving model rides first among the extras',
    line('thinking', served, 'Pondering') === 'Pondering · thinking · Opus 5 (fallback) · high',
    String(line('thinking', served, 'Pondering')),
  )
  check(
    'thinking, no verb: the same order without the verb',
    line('thinking', served) === 'Thinking · Opus 5 (fallback) · high',
    String(line('thinking', served)),
  )
  check(
    'thinking, no serving model: the extras are the effort alone',
    line('thinking', plain, 'Pondering') === 'Pondering · thinking · high',
    String(line('thinking', plain, 'Pondering')),
  )
  check(
    'a narrow row sheds the serving model with the rest of the tail (never a truncated name)',
    line('waiting', served, 'Pondering', 30) === 'Pondering · waiting · high',
    String(line('waiting', served, 'Pondering', 30)),
  )
}

// ── §4 the wiring ───────────────────────────────────────────────────────────
section('§4 the wiring at the owners: request, note, mint, bill, phase, transcript, echo')
{
  const stream = src('src/services/providers/anthropic/streamCore.ts')
  const caps = src('src/utils/model/capabilities.ts')
  const phase = src('src/utils/pulse/turnPhase.ts')
  const byline = src('src/components/Spinner/pulseByline.ts')
  const message = src('src/components/Message.tsx')
  const wire = src('src/types/wire.ts')

  check(
    'capabilities.ts owns the request additions and reads the gate through the registry reader',
    caps.includes('export function refusalFallbackRequest') &&
      caps.includes("flagEnabled('MERCURY_REFUSAL_FALLBACK')") &&
      caps.includes('export function modelSupportsServerSideFallback'),
  )
  check(
    'the stream asks the one owner, pushes its beta once and spreads its fallbacks',
    stream.includes('refusalFallbackRequest(options.model)') &&
      stream.includes('betasParams.push(refusalFallback.beta)') &&
      stream.includes('...(refusalFallback && { fallbacks: refusalFallback.fallbacks })'),
  )
  check(
    'the stream learns the serving model at message_start and at the fallback block',
    stream.includes("noteServedModel(part.message?.model, 'start')") &&
      stream.includes("(part.content_block.type as string) === 'fallback'") &&
      /noteServedModel\(\s*\(part\.content_block as \{ to\?: \{ model\?: string \} \}\)\.to\?\.model,\s*'block',\s*\)/.test(stream),
  )
  check(
    'the non-streaming responses note their serving model too',
    (stream.match(/noteServedModel\(\s*result\.model,/g) ?? []).length === 2,
  )
  check(
    'the mint stamps the serving model on every minted assistant message',
    stream.includes('...(servedModel && { model: servedModel }),'),
  )
  check(
    'the bill prices and records a whole-turn rescue at the serving model',
    stream.includes('calculateUSDCost(pricingModel(), usage)') &&
      stream.includes('addToTotalSessionCost(costUSDForPart, usage, pricingModel())') &&
      stream.includes('servedModel && servedWholeTurn ? servedModel : resolvedModel'),
  )
  check(
    'the served model is compared by canonical family (a dated alias is never a substitute)',
    stream.includes('if (getCanonicalName(model) === getCanonicalName(requestedWire)) return'),
  )
  check(
    'the phase detail carries servedBy and a change of it repaints',
    phase.includes('servedBy?: string') && phase.includes('a.servedBy !== b.servedBy'),
  )
  check(
    'the byline reads servedBy on the waiting and thinking phases',
    byline.includes('detail.servedBy ? `${detail.servedBy} (fallback)` : detail.model') &&
      byline.includes("...(detail.servedBy ? [`${detail.servedBy} (fallback)`] : [])"),
  )
  check(
    'the transcript renders the fallback block naming both models',
    message.includes("case 'fallback':") &&
      message.includes('served by ${to}') &&
      message.includes('${from} declined'),
  )
  check(
    'the wire vocabulary carries the fallback block in the assistant content union',
    wire.includes("type: 'fallback'") && wire.includes('| FallbackBlock'),
  )

  // The echo-back: a fallback block survives the API normalizer untouched, so
  // the next request carries it in its original position.
  const block = {
    type: 'fallback',
    from: { model: 'claude-fable-5-1' },
    to: { model: 'claude-opus-5' },
    trigger: { type: 'refusal', category: 'cyber' },
  }
  const out = normalizeContentFromAPI([block] as never, [] as never)
  check('the API normalizer passes the fallback block through byte-for-byte', show(out) === show([block]), show(out))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} refusal-fallback check(s) failed`)
  process.exit(1)
}
console.log(' ALL REFUSAL-FALLBACK PROOFS PASS')
