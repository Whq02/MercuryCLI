// ============================================================================
//  scripts/pulse/matrix/scenes.ts — the deterministic scene
//  matrix.
//
//  A scene holds constant: fixture repo dir (fresh hermetic tmp, optionally
//  seeded), prompt, model id (the fresh-boot default — never overridden
//  mid-scene), applied effort (default), context size (seeded turns only),
//  cache state (fresh hermetic home = cold boot; later turns in one session
//  = warm), tool set (full default catalog), attachment state (seeded cwd +
//  MERCURY_PULSE_FIXTURE injections), hook fixture (user settings.json).
//
//  Every scene is fixture-only (ANTHROPIC_BASE_URL → scripts/lib/fixtureApi
//  scripted SSE) — no live provider, no wall-clock stage math here; timing
//  truth comes from the MERCURY_PULSE_DUMP trace (monotonic pulseNow inside
//  the app) plus ptydrive's send/tee logs for PTY-observable laws.
//
//  Send timelines assume the flux-arena boot envelope (prompt ready well
//  before 4.5s at 120x40 — scripts/streaming precedent). Scene assertions live in
//  the prove-*.ts files; this module only DEFINES scenes so provers and the
//  run-matrix explorer share one spelling.
// ============================================================================

import type { PulseArenaOpts } from '../lib/pulseArena.ts'
import { runPulseArena, type PulseRun } from '../lib/pulseArena.ts'

export type SceneStatus = 'runnable' | 'structural' | 'skip'

export interface SceneSpec {
  id: number
  key: string
  title: string
  status: SceneStatus
  /** Which promised integrator seams the ASSERTIONS (not the run) need. */
  requires: ('dump' | 'fixture-producers')[]
  skipReason?: string
  build?: () => PulseArenaOpts
  notes: string
}

/** Distinctive first-delta sentinels (glyph runs the renderer can't produce
 *  by coincidence) — wait-window boundaries + visibility matching. */
export const T1 = '⟦P1⟧'
export const T2 = '⟦P2⟧'

const SLEEP_SESSION_START = 8 // s — still running at the 5.6s submit
const SLEEP_PROMPT_SUBMIT = 2 // s

function hookSettings(event: 'SessionStart' | 'UserPromptSubmit', sleepS: number): string {
  return JSON.stringify({
    hooks: {
      [event]: [{ hooks: [{ type: 'command', command: `sleep ${sleepS}` }] }],
    },
  })
}

export const SCENES: SceneSpec[] = [
  {
    id: 1,
    key: 'warm-plain',
    title: 'warm plain-text turn, no submit hooks',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        { kind: 'text', text: `${T1} one done.` },
        { kind: 'text', text: `${T1} two done.` },
        { kind: 'text', text: `${T1} three done.` },
        { kind: 'text', text: `${T1} four done.` },
      ],
      sends: [
        '5000:hi one', '5600:\\r',
        '8600:hi two', '9200:\\r',
        '12200:hi three', '12800:\\r',
        '15800:hi four', '16400:\\r',
      ],
      seconds: 20,
    }),
    notes: 'turn 1 = cold boot; turns 2-4 = warm samples (idle gap seconds). The perf-law scene.',
  },
  {
    id: 2,
    key: 'hook-session-start',
    title: 'first turn with a delayed SessionStart hook',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [{ kind: 'text', text: `${T1} hooked boot done.` }],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 18,
      seedConfig: {
        'settings.json': hookSettings('SessionStart', SLEEP_SESSION_START),
      },
    }),
    notes: `sleep ${SLEEP_SESSION_START} SessionStart hook still pending at the 5.6s submit — the first-turn wait must land INSIDE the trace.`,
  },
  {
    id: 3,
    key: 'hook-prompt-submit',
    title: 'delayed UserPromptSubmit hook',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [{ kind: 'text', text: `${T1} submit-hooked done.` }],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 16,
      seedConfig: {
        'settings.json': hookSettings('UserPromptSubmit', SLEEP_PROMPT_SUBMIT),
      },
    }),
    notes: `sleep ${SLEEP_PROMPT_SUBMIT} UserPromptSubmit hook — user_prompt_hooks stage ≥ ~2s in the trace.`,
  },
  {
    id: 4,
    key: 'producer-slow',
    title: 'slow cooperative attachment producer (1500ms)',
    status: 'runnable',
    requires: ['dump', 'fixture-producers'],
    build: () => ({
      turns: [{ kind: 'text', text: `${T1} slow producer done.` }],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 16,
      extraEnv: { MERCURY_PULSE_FIXTURE: 'slow-producer=1500' },
    }),
    notes: 'cooperative: resolves after 1500ms, honors abort — recorded with duration + outcome.',
  },
  {
    id: 5,
    key: 'producer-stuck',
    title: 'producer that ignores cancellation (2500ms)',
    status: 'runnable',
    requires: ['dump', 'fixture-producers'],
    build: () => ({
      turns: [{ kind: 'text', text: `${T1} stuck producer survived.` }],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 16,
      extraEnv: { MERCURY_PULSE_FIXTURE: 'stuck-producer=2500' },
    }),
    notes: 'ignores AbortSignal entirely — must surface as a timeout outcome under a REAL deadline while the turn completes.',
  },
  {
    id: 6,
    key: 'autocompact',
    title: 'autocompact-triggered turn',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      // Turn 1 REPORTS 97k of usage; the registered percent override pins the
      // auto-compact threshold at 9% of the effective window (≈90k of the main
      // model's 1M), so the second submit trips decideCompaction, the compactor
      // makes its own summarization call (scripted turn 2), then the real
      // turn dispatches (turn 3). (The window-floor env rung retired with the
      // compat estate; settings.autoCompactWindow and the percent override are
      // the two seams left.)
      turns: [
        { kind: 'text', text: `${T1} fat turn done.`, usage: { input_tokens: 97_000 } },
        { kind: 'text', text: 'Summary of the session so far: fixture summary body.' },
        { kind: 'text', text: `${T2} post-compact done.` },
      ],
      sends: ['5000:hi big', '5600:\\r', '9600:hi after', '10200:\\r'],
      seconds: 22,
      extraEnv: { MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '9' },
    }),
    notes: 'deterministic via reported usage + the registered percent override (autoCompact.ts: threshold = 9% of the effective window; the fixture reports 97k).',
  },
  {
    id: 7,
    key: 'provider-header-delay',
    title: 'provider delay before headers (4s)',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        {
          kind: 'stream',
          blocks: [{ type: 'text', deltas: [`${T1} `, 'slow ', 'headers ', 'answer.'] }],
          gapMs: 40,
          headerDelayMs: 4000,
        },
      ],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 18,
    }),
    notes: 'the whole response (headers included) held 4s — a pure provider wait; must attribute to providerWaitMs and stay visually neutral.',
  },
  {
    id: 8,
    key: 'provider-first-chunk-delay',
    title: 'provider delay between headers and first chunk (4s)',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        {
          kind: 'stream',
          blocks: [{ type: 'text', deltas: [`${T1} `, 'slow ', 'chunk ', 'answer.'] }],
          gapMs: 40,
          firstChunkDelayMs: 4000,
        },
      ],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 18,
    }),
    notes: 'headers answer immediately; the first SSE byte is held 4s — the headers→first-chunk gap the trace must separate.',
  },
  {
    id: 9,
    key: 'thinking-first',
    title: 'thinking-first stream',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        {
          kind: 'stream',
          blocks: [
            { type: 'thinking', deltas: ['pondering the fixture ', 'quite hard '] },
            { type: 'text', deltas: [`${T1} `, 'thought-first ', 'answer.'] },
          ],
          gapMs: 60,
        },
      ],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 16,
    }),
    notes: 'first_thinking_event must stamp BEFORE first_text_delta; firstVisibleMs keys off the thinking event.',
  },
  {
    id: 10,
    key: 'text-first',
    title: 'text-first stream',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        {
          kind: 'stream',
          blocks: [{ type: 'text', deltas: [`${T1} `, 'text-first ', 'answer.'] }],
          gapMs: 60,
        },
      ],
      sends: ['5000:hello', '5600:\\r'],
      seconds: 16,
    }),
    notes: 'no thinking block: first_thinking_event absent; firstVisibleMs keys off first_text_terminal_write.',
  },
  {
    id: 11,
    key: 'cancel-resubmit',
    title: 'cancellation (ESC) + immediate resubmit',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        { kind: 'hang', deltas: [`${T1} working on it`] },
        { kind: 'text', text: `${T2} second answer done.` },
      ],
      sends: ['5000:first ask', '5600:\\r', '8600:\\x1b', '9600:again please', '10200:\\r'],
      seconds: 18,
    }),
    notes: 'turn 1 hangs mid-stream, ESC cancels at +3s, resubmit lands turn 2 — no stale-generation bleed.',
  },
  {
    id: 12,
    key: 'queued-steering',
    title: 'queued steering (submit while a turn runs)',
    status: 'runnable',
    requires: ['dump'],
    build: () => ({
      turns: [
        {
          kind: 'stream',
          blocks: [
            {
              type: 'text',
              deltas: Array.from({ length: 30 }, (_, i) => (i === 0 ? `${T1} long ` : 'answer ')),
            },
          ],
          gapMs: 200,
        },
        { kind: 'text', text: `${T2} steered reply done.` },
      ],
      sends: ['5000:long one', '5600:\\r', '8000:steer note', '8600:\\r'],
      seconds: 20,
    }),
    notes: 'the steer submit lands ~2.5s into a ~6s stream — queued, then dispatched as its own traced turn.',
  },
  {
    id: 13,
    key: 'tandem-activity',
    title: 'teammate/Tandem activity',
    status: 'skip',
    requires: [],
    skipReason:
      'HONEST SKIP: teammate activity needs a live crew/party daemon and a second seated agent; ' +
      'no deterministic loopback fixture exists for that today and inventing a fake teammate stream ' +
      'would violate the no-fabrication floor. Needs an integrator-owned teammate fixture seam.',
    notes: 'documented skip — loudly reported by run-matrix and the coverage table; not silently capped.',
  },
  {
    id: 14,
    key: 'provider-adapters',
    title: 'each currently integrated provider adapter',
    status: 'structural',
    requires: [],
    notes:
      'the 1P Anthropic path is the adapter every PTY scene exercises ' +
      '(ANTHROPIC_BASE_URL → fixture). openai/zai run uncredentialed here — honest ' +
      'unavailable slots, pinned structurally by prove-provider-adapters.ts.',
  },
]

export function sceneByKey(key: string): SceneSpec {
  const s = SCENES.find(x => x.key === key || String(x.id) === key)
  if (!s) throw new Error(`unknown scene: ${key}`)
  return s
}

export async function runScene(spec: SceneSpec, extra?: Partial<PulseArenaOpts>): Promise<PulseRun> {
  if (!spec.build) throw new Error(`scene ${spec.key} is ${spec.status} — not runnable`)
  const opts = spec.build()
  return runPulseArena({ ...opts, ...extra, extraEnv: { ...opts.extraEnv, ...extra?.extraEnv } })
}
