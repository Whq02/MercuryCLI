#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { check, section, finish } from '../lib/proveKit.ts'
import {
  beginPhaseGeneration,
  computeDisplayPhase,
  finishPhaseGeneration,
  getPulseActivity,
  getPulsePhase,
  notePulseStreamActivity,
  projectSpinnerMode,
  setPulseClockForTests,
  setPulsePhase,
  subscribePulsePhase,
  type TurnPhaseName,
} from '../../../src/utils/pulse/turnPhase.ts'

let now = 1000
setPulseClockForTests(() => now)

let gen = 0
function freshTurn(): number {
  gen += 100
  beginPhaseGeneration(gen)
  return gen
}

const PATH_TO: Record<TurnPhaseName, TurnPhaseName[]> = {
  idle: ['settling', 'idle'],
  accepted: [],
  preparing: ['preparing'],
  compacting: ['compacting'],
  dispatching: ['dispatching'],
  waiting: ['dispatching', 'waiting'],
  thinking: ['dispatching', 'waiting', 'thinking'],
  responding: ['dispatching', 'waiting', 'responding'],
  'tool-work': ['dispatching', 'waiting', 'tool-work'],
  settling: ['settling'],
}

const EXPECTED: Record<TurnPhaseName, TurnPhaseName[]> = {
  idle: ['accepted'],
  accepted: ['preparing', 'compacting', 'dispatching', 'settling'],
  preparing: ['preparing', 'compacting', 'dispatching', 'settling'],
  compacting: ['preparing', 'compacting', 'dispatching', 'settling'],
  dispatching: ['waiting', 'settling'],
  waiting: ['thinking', 'responding', 'tool-work', 'settling'],
  thinking: ['thinking', 'responding', 'tool-work', 'settling'],
  responding: ['thinking', 'responding', 'tool-work', 'settling'],
  'tool-work': [
    'preparing',
    'compacting',
    'dispatching',
    'thinking',
    'responding',
    'tool-work',
    'settling',
  ],
  settling: ['idle'],
}

const PHASES = Object.keys(EXPECTED) as TurnPhaseName[]

section('transition table — exhaustive from→to sweep')
{
  let mismatches: string[] = []
  for (const from of PHASES) {
    if (from === 'idle') continue
    for (const to of PHASES) {
      const g = freshTurn()
      for (const step of PATH_TO[from]) {
        if (!setPulsePhase(g, step)) throw new Error(`path setup broke: →${step} from ${getPulsePhase().phase}`)
      }
      if (getPulsePhase().phase !== from) throw new Error(`path setup landed on ${getPulsePhase().phase}, wanted ${from}`)
      const applied = setPulsePhase(g, to)
      const isSelf = from === to
      const expectLegal = isSelf || EXPECTED[from].includes(to)
      const landed = getPulsePhase().phase
      const landedOk = applied ? landed === to : landed === from
      if (applied !== expectLegal || !landedOk) {
        mismatches.push(`${from}→${to}: applied=${applied} expected=${expectLegal} landed=${landed}`)
      }
    }
  }
  check('every from→to pair matches the expected legality table', mismatches.length === 0, mismatches.slice(0, 6).join(' | '))
}

section('lifecycle: begin → tool-work cycle → settling → idle')
{
  const g = freshTurn()
  check('a new generation opens in accepted', getPulsePhase().phase === 'accepted')
  setPulsePhase(g, 'preparing', { reason: 'context' })
  setPulsePhase(g, 'dispatching')
  setPulsePhase(g, 'waiting')
  setPulsePhase(g, 'responding')
  setPulsePhase(g, 'tool-work', { toolCount: 3 })
  check('tool-work reached with detail', getPulsePhase().detail.toolCount === 3)
  check('tool-work → preparing (legal cycle)', setPulsePhase(g, 'preparing'))
  check('… → dispatching', setPulsePhase(g, 'dispatching'))
  check('… → waiting', setPulsePhase(g, 'waiting'))
  check('… → responding', setPulsePhase(g, 'responding'))
  check('responding → settling', setPulsePhase(g, 'settling'))
  finishPhaseGeneration(g)
  check('finishPhaseGeneration closes to idle', getPulsePhase().phase === 'idle')
  finishPhaseGeneration(g + 1)
  check('a stale finish is fenced', getPulsePhase().phase === 'idle')
}

section('detail merge without churn')
{
  const g = freshTurn()
  let notifies = 0
  const unsub = subscribePulsePhase(() => notifies++)
  setPulsePhase(g, 'preparing', { reason: 'hooks' })
  check('a real transition notifies once', notifies === 1, String(notifies))
  setPulsePhase(g, 'preparing', { reason: 'hooks' })
  check('same phase + same detail ⇒ ZERO notify', notifies === 1, String(notifies))
  setPulsePhase(g, 'preparing', { reason: 'context' })
  check('a detail refinement notifies', notifies === 2, String(notifies))
  setPulsePhase(g, 'dispatching', { model: 'Opus 4.8', effort: 'high' })
  check('detail MERGES across transitions (reason survives)', getPulsePhase().detail.reason === 'context')
  check('…and the new keys land', getPulsePhase().detail.model === 'Opus 4.8')
  const before = notifies
  setPulsePhase(g - 1, 'settling')
  check('a stale write never notifies', notifies === before)
  unsub()
}

section('notePulseStreamActivity never notifies (pull-based cadence)')
{
  const g = freshTurn()
  setPulsePhase(g, 'dispatching')
  setPulsePhase(g, 'waiting')
  let notifies = 0
  const unsub = subscribePulsePhase(() => notifies++)
  now = 5000
  notePulseStreamActivity(g, 'chunk')
  now = 5100
  notePulseStreamActivity(g, 'thinking')
  now = 5200
  notePulseStreamActivity(g, 'text')
  check('zero subscriber notifications from stream cadence', notifies === 0, String(notifies))
  const a = getPulseActivity()
  check('firstChunkAt latched at the first event', a.firstChunkAt === 5000, String(a.firstChunkAt))
  check('firstThinkingAt latched', a.firstThinkingAt === 5100)
  check('firstTextAt latched', a.firstTextAt === 5200)
  check('lastEventAt tracks the newest event', a.lastEventAt === 5200)
  now = 5300
  notePulseStreamActivity(g, 'thinking')
  check('first stamps LATCH (second thinking does not move firstThinkingAt)', getPulseActivity().firstThinkingAt === 5100)
  notePulseStreamActivity(g - 1, 'text')
  check('stale-generation activity dropped', getPulseActivity().lastEventAt === 5300)
  unsub()
}

section('computeDisplayPhase dwell/hysteresis (view-side only)')
{
  const g = freshTurn()
  now = 10_000
  setPulsePhase(g, 'preparing', { reason: 'context' })
  const snap = getPulsePhase()
  check('under dwell from idle ⇒ generic accepted', computeDisplayPhase('idle', snap, 10_050) === 'accepted')
  check('under dwell holds the prior displayed label', computeDisplayPhase('accepted', snap, 10_050) === 'accepted')
  check('past dwell the honest subphase shows', computeDisplayPhase('accepted', snap, 10_250) === 'preparing')
  check('internal snapshot stays honest regardless of the view', snap.phase === 'preparing' && snap.enteredAt === 10_000)
  setPulsePhase(g, 'dispatching')
  setPulsePhase(g, 'waiting')
  const waitSnap = getPulsePhase()
  check('non-detail phases show immediately (no dwell)', computeDisplayPhase('accepted', waitSnap, now + 1) === 'waiting')
}

section('projectSpinnerMode projection')
{
  check('pre-token phases project to requesting', projectSpinnerMode('accepted') === 'requesting')
  check('preparing → requesting', projectSpinnerMode('preparing') === 'requesting')
  check('compacting → requesting', projectSpinnerMode('compacting') === 'requesting')
  check('dispatching → requesting', projectSpinnerMode('dispatching') === 'requesting')
  check('waiting → requesting', projectSpinnerMode('waiting') === 'requesting')
  check('thinking → thinking', projectSpinnerMode('thinking') === 'thinking')
  check('responding → responding', projectSpinnerMode('responding') === 'responding')
  check('responding + tool-input kind → tool-input', projectSpinnerMode('responding', 'tool-input') === 'tool-input')
  check('tool-work → tool-use', projectSpinnerMode('tool-work') === 'tool-use')
  check('settling → responding', projectSpinnerMode('settling') === 'responding')
}

setPulseClockForTests(null)
finish('PULSE phase laws')
