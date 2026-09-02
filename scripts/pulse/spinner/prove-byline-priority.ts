#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/spinner/prove-byline-priority.ts — + the
//  voice re-tune: the phase byline renders the ACTUAL model +
//  applied effort from the phase detail and sheds right-to-left at narrow
//  widths so the row stays one line. On the LONG steady phases (waiting /
//  thinking) the verb chain's voice HEADS the line and the phase truth rides
//  as meta (the voice law); the brief causal phases keep the whole line.
//
//  Pure (composePhaseByline / formatPhaseElapsed) + source pins for the
//  priority wiring (phase byline ?? legacy chain; operator override and
//  teammate verbs always win; the info-channel spelling survives;
//  the verb threads parent → row → composer; quicksilver cadence keys off
//  the displayed HEAD segment).
//
//  Run: ~/.bun/bin/bun run scripts/pulse/spinner/prove-byline-priority.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringWidth } from '../../../src/ink/stringWidth.js'
import {
  composePhaseByline,
  IDLE_THINKING_TRACKER,
  nextThinkingSpan,
  THINKING_LINGER_MS,
  thinkingPostscript,
} from '../../../src/components/Spinner/pulseByline.js'
import type { PhaseDetail, TurnPhaseName } from '../../../src/utils/pulse/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.PULSE_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const compose = (
  phase: TurnPhaseName,
  detail: PhaseDetail,
  maxWidth = 120,
  activeToolCount = 0,
) => composePhaseByline({ phase, detail, activeToolCount, maxWidth })

const composeV = (
  phase: TurnPhaseName,
  detail: PhaseDetail,
  verb: string,
  maxWidth = 120,
  activeToolCount = 0,
) => composePhaseByline({ phase, detail, activeToolCount, maxWidth, verb })

// ── the target examples, model + effort from the DETAIL (never hardcoded) ──
// the byline carries phase + identity meta ONLY — the
// per-phase elapsed tail is absent; the default strip's single time basis is
// the row's whole-turn timer (one phrase, ONE clock).
check(
  'waiting: model + effort — no clock in the phrase',
  compose('waiting', { model: 'Fable 5', effort: 'high' }) === 'Waiting for Fable 5 · high',
  String(compose('waiting', { model: 'Fable 5', effort: 'high' })),
)
check(
  'waiting: a DIFFERENT model renders (not hardcoded)',
  compose('waiting', { model: 'Sonnet 5', effort: 'max' }) === 'Waiting for Sonnet 5 · max',
)
check('waiting: no model detail degrades honestly', compose('waiting', {}) === 'Waiting')
check('thinking: effort, no clock', compose('thinking', { effort: 'high' }) === 'Thinking · high')
check('preparing reason context', compose('preparing', { reason: 'context' }) === 'Preparing context')
check('preparing reason hooks', compose('preparing', { reason: 'hooks' }) === 'Checking prompt hooks')
check('preparing reason workspace', compose('preparing', { reason: 'workspace' }) === 'Collecting workspace context')
check('preparing reason input', compose('preparing', { reason: 'input' }) === 'Reading input')
check('preparing bare', compose('preparing', {}) === 'Preparing')
check('compacting', compose('compacting', {}) === 'Compacting context')
check('dispatching', compose('dispatching', {}) === 'Sending request')
check('settling', compose('settling', {}) === 'Settling turn')
check('tool-work with 3 tools', compose('tool-work', { toolCount: 3 }) === 'Running 3 tools')
check('tool-work count falls back to activeToolCount', compose('tool-work', {}, 120, 4) === 'Running 4 tools')

// ── the voice law: the verb heads the LONG steady phases ──────
check(
  'waiting + verb: the voice heads, the phase truth rides as meta',
  composeV('waiting', { model: 'Fable 5', effort: 'high' }, 'Slick') ===
    'Slick · waiting for Fable 5 · high',
  String(composeV('waiting', { model: 'Fable 5', effort: 'high' }, 'Slick')),
)
check(
  'thinking + verb',
  composeV('thinking', { effort: 'high' }, 'Molten') === 'Molten · thinking · high',
)
check(
  'waiting + verb, no model detail',
  composeV('waiting', {}, 'Slick') === 'Slick · waiting',
)
check(
  'a task narrator voice heads the same way (the verb chain, not just whimsy)',
  composeV('waiting', { model: 'Opus 4.8' }, 'Fixing the login flow') ===
    'Fixing the login flow · waiting for Opus 4.8',
)
// The causal transitional phases IGNORE the verb — real transition
// information still owns the whole line there.
check('preparing ignores the verb', composeV('preparing', { reason: 'context' }, 'Slick') === 'Preparing context')
check('compacting ignores the verb', composeV('compacting', {}, 'Slick') === 'Compacting context')
check('dispatching ignores the verb', composeV('dispatching', {}, 'Slick') === 'Sending request')
check('settling ignores the verb', composeV('settling', {}, 'Slick') === 'Settling turn')
check('multi-tool ignores the verb', composeV('tool-work', { toolCount: 3 }, 'Slick') === 'Running 3 tools')
check('responding + verb → still null (legacy chain drives alone)', composeV('responding', {}, 'Slick') === null)
{
  // Verb-headed shed: right-to-left, floor = the bare verb.
  const d: PhaseDetail = { model: 'Fable 5', effort: 'high' }
  const full = 'Slick · waiting for Fable 5 · high'
  check('verb shed 0: full', composeV('waiting', d, 'Slick', stringWidth(full)) === full)
  check(
    'verb shed 1: drops effort first (the clock is not in the phrase)',
    composeV('waiting', d, 'Slick', stringWidth(full) - 1) === 'Slick · waiting for Fable 5',
  )
  check('verb shed 2: then the model head', composeV('waiting', d, 'Slick', 15) === 'Slick · waiting')
  check('verb floor: the bare verb', composeV('waiting', d, 'Slick', 6) === 'Slick')
  let allFit = true
  for (let budget = stringWidth('Slick'); budget <= 60; budget++) {
    const s = composeV('waiting', d, 'Slick', budget)
    if (s === null || stringWidth(s) > budget) allFit = false
  }
  check('every budget ≥ the verb width fits (the one-line proxy, voice law)', allFit)
}

// ── the legacy chain keeps its states (whimsy survives ONLY as fallback) ───
check('responding → null (task narrator / whimsy chain drives)', compose('responding', {}) === null)
check('idle → null', compose('idle', {}) === null)
check('tool-work with exactly 1 tool → null (the specific activeToolLabel verb wins)', compose('tool-work', { toolCount: 1 }) === null)
check('tool-work with 0 in flight → null', compose('tool-work', { toolCount: 0 }) === null)

// ── narrow-width shed: right-to-left, one line, floor = the head label ─────
{
  const full = 'Waiting for Fable 5 · high'
  const d: PhaseDetail = { model: 'Fable 5', effort: 'high' }
  check('wide: the full composition', compose('waiting', d, stringWidth(full)) === full)
  check('shed 1: drops effort first', compose('waiting', d, stringWidth(full) - 1) === 'Waiting for Fable 5')
  check('shed 2: then the model (head fallback keeps right-to-left order)', compose('waiting', d, 15) === 'Waiting · high')
  check('floor: the bare head', compose('waiting', d, 8) === 'Waiting')
  let allFit = true
  for (let budget = 7; budget <= 60; budget++) {
    const s = compose('waiting', d, budget)
    if (s === null || stringWidth(s) > budget) allFit = false
  }
  check('every budget ≥ the head width fits (the one-line proxy)', allFit)
}

// ── the thinking postscript projection ──
{
  const t0 = 100_000
  let tr = IDLE_THINKING_TRACKER
  tr = nextThinkingSpan(tr, 'waiting', t0)
  check('postscript: none before any thinking', thinkingPostscript(tr, t0 + 100) === null)
  tr = nextThinkingSpan(tr, 'thinking', t0 + 1_000)
  check('postscript: none WHILE thinking (the byline owns the live label)', thinkingPostscript(tr, t0 + 3_000) === null)
  tr = nextThinkingSpan(tr, 'responding', t0 + 6_400)
  check(
    'postscript: "thought for Ns" after the exit (span = 5.4s → 5s)',
    thinkingPostscript(tr, t0 + 6_500) === 'thought for 5s',
    String(thinkingPostscript(tr, t0 + 6_500)),
  )
  check(
    'postscript: lingers under THINKING_LINGER_MS on the SAME clock',
    thinkingPostscript(tr, t0 + 6_400 + THINKING_LINGER_MS - 1) === 'thought for 5s',
  )
  check(
    'postscript: gone at the linger boundary',
    thinkingPostscript(tr, t0 + 6_400 + THINKING_LINGER_MS) === null,
  )
  const trShort = nextThinkingSpan(
    nextThinkingSpan(IDLE_THINKING_TRACKER, 'thinking', t0),
    'responding',
    t0 + 300,
  )
  check('postscript: sub-second spans round up to 1s', thinkingPostscript(trShort, t0 + 400) === 'thought for 1s')
  const tr2 = nextThinkingSpan(nextThinkingSpan(tr, 'thinking', t0 + 10_000), 'settling', t0 + 12_000)
  check('postscript: a NEWER span wins', thinkingPostscript(tr2, t0 + 12_100) === 'thought for 2s')
  check('tracker: unchanged sample is identity (no per-frame churn)', nextThinkingSpan(tr2, 'settling', t0 + 13_000) === tr2)
}

// ── priority wiring pins (the row + the parent) ─────────────────────────────
{
  const row = readFileSync(join(root, 'src/components/Spinner/SpinnerAnimationRow.tsx'), 'utf8')
  const spinner = readFileSync(join(root, 'src/components/Spinner.tsx'), 'utf8')
  check('row: phase byline outranks the passed verb, with honest fallback', row.includes('phaseByline ?? messageProp'))
  check('row: byline budget rides the live columns (sheds with the terminal)', /maxWidth: Math\.max\(10, columns - 9\)/.test(row))
  check('row: the voice threads into the composer (verb: bylineVerb)', /verb: bylineVerb/.test(row))
  check('row: quicksilver cadence keys off the displayed HEAD segment', /message\.split\(' · '\)\[0\]!\.replace/.test(row) && /isQuicksilverLine\(displayedHead\)/.test(row))
  check('parent: the ellipsis-free verb rides down (bylineVerb={effectiveVerb})', /bylineVerb=\{effectiveVerb\}/.test(spinner))
  check('parent: operator override + teammate verb always win', /phaseBylineEligible = !overrideMessage && !\(foregroundedTeammate && !foregroundedTeammate\.isIdle\)/.test(spinner))
  check("parent: AURORA info-channel spelling survives (requesting ? 'info' : 'brand')", /requesting \? 'info' : 'brand'/.test(spinner))
  check('parent: TTFT reads the ACTIVE pulse trace (api_request_sent → first chunk)', spinner.includes("'api_request_sent'") && spinner.includes("'first_stream_chunk_received'"))
  check('parent: the dead ant-only TTFT gate is gone', !spinner.includes('("external" as string)'))
  check('row: still-waiting suffix is dim/quiet (restrained treatment)', /<Text dimColor italic=\{true\} key="stillWaiting">/.test(row))
}

if (failures > 0) {
  console.log(`\n❌ prove-byline-priority: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ byline-priority — the voice heads the steady phases; causal labels own transitions; detail-driven; sheds to one line')
