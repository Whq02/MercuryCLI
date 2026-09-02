#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-source-vocabulary.ts — (defect H) laws for the
//  source-state vocabulary itself.
//
//  prove-source-truth is the frozen M0 reproducer: it pins that the five
//  named sites stopped conflating "unreadable" with "empty". It does NOT pin
//  the vocabulary those sites now speak, and two parts of that vocabulary are
//  load-bearing and otherwise untested:
//
//    §1  classifyReadFailure's CODE TABLE. ENOENT is the only code that may
//        mean empty. Get this wrong in either direction and the defect either
//        returns (a real failure read as absence) or inverts (an absent file
//        reported as a fault, which would make every fresh install shout).
//    §2  The fold and its helpers — the flattening seam. valueOr is the only
//        sanctioned way to drop to a fallback, and `stale` must keep its
//        value, or last-known-good silently renders as nothing.
//    §3  The engine's LAST-KNOWN-GOOD upgrade. `stale` is the one arm with a
//        producer that no other proof drives: a source that read once and
//        then fails must degrade to stale-with-its-prior-value, never to a
//        bare unavailable that erases what the operator was looking at — and
//        a source that reads cleanly and holds NOTHING must retire its
//        last-known-good rather than showing deleted rows forever.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('sourcevocab')
const t = checker()

const {
  classifyReadFailure,
  foldSourceState,
  healthOf,
  mapSourceValue,
  reasonOf,
  sourceEmpty,
  sourceReady,
  sourceStale,
  sourceUnavailable,
  valueOr,
  wasObserved,
} = await import('../../src/substrate/sourceState.ts')

const errWith = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code} induced`), { code })

t.section('§1 — classifyReadFailure: ENOENT is the ONLY absence')
{
  t.check(
    'ENOENT ⇒ empty (a file that is not there is a real emptiness)',
    classifyReadFailure(errWith('ENOENT')).state === 'empty',
  )
  for (const code of ['EISDIR', 'ENOTDIR', 'EACCES', 'EPERM']) {
    const c = classifyReadFailure(errWith(code))
    t.check(
      `${code} ⇒ unavailable, NOT retryable`,
      c.state === 'unavailable' && c.retryable === false,
      `state=${c.state}`,
    )
  }
  for (const code of ['EIO', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE']) {
    const c = classifyReadFailure(errWith(code))
    t.check(
      `${code} ⇒ unavailable and RETRYABLE`,
      c.state === 'unavailable' && c.retryable === true,
      `state=${c.state} retryable=${c.state === 'unavailable' ? c.retryable : 'n/a'}`,
    )
  }
  const unknown = classifyReadFailure(new Error('no code at all'))
  t.check(
    'an unrecognised failure is unavailable and NOT retryable',
    unknown.state === 'unavailable' && unknown.retryable === false,
    'guessing "try again" about a failure we cannot name is how a spin loop is written',
  )
  const coded = classifyReadFailure(errWith('EISDIR'))
  t.check(
    'the reason names the code, so a gate failure is attributable',
    coded.state === 'unavailable' && coded.reason.includes('EISDIR'),
  )
}

t.section('§2 — the fold and the flattening seam')
{
  t.check('valueOr yields the value when ready', valueOr(sourceReady([1, 2]), []).length === 2)
  t.check(
    'valueOr yields the LAST-KNOWN-GOOD when stale (never the fallback)',
    valueOr(sourceStale([7], 'store went away'), []).length === 1,
  )
  t.check('valueOr falls back when unavailable', valueOr(sourceUnavailable('x'), [9]).length === 1)
  t.check('valueOr falls back when empty', valueOr(sourceEmpty(), [9]).length === 1)

  t.check('healthOf drops the payload', !('value' in healthOf(sourceReady([1]))))
  t.check('healthOf keeps the state', healthOf(sourceStale([1], 'r')).state === 'stale')
  t.check('reasonOf is undefined for a healthy read', reasonOf(healthOf(sourceReady(1))) === undefined)
  t.check('reasonOf carries the failure text', reasonOf(healthOf(sourceUnavailable('boom'))) === 'boom')

  t.check(
    'mapSourceValue reshapes ready without losing the state',
    (() => {
      const m = mapSourceValue(sourceReady([1, 2, 3]), v => v.length)
      return m.state === 'ready' && m.value === 3
    })(),
  )
  t.check(
    'mapSourceValue preserves a failure arm untouched',
    mapSourceValue(sourceUnavailable('gone'), () => 1).state === 'unavailable',
  )

  // wasObserved is the predicate every surface branches on before printing a
  // count. Getting `stale` wrong here would hide last-known-good rows.
  t.check('wasObserved: ready', wasObserved(sourceReady(1)))
  t.check('wasObserved: empty (a real, measured zero)', wasObserved(sourceEmpty()))
  t.check('wasObserved: stale (we hold a prior value)', wasObserved(sourceStale(1, 'r')))
  t.check('NOT observed: unavailable', !wasObserved(sourceUnavailable('r')))

  const arms = [
    sourceReady(1),
    sourceEmpty(),
    sourceStale(1, 'r'),
    sourceUnavailable('r'),
  ].map(s =>
    foldSourceState(s, {
      ready: () => 'ready',
      empty: () => 'empty',
      stale: () => 'stale',
      recoverable: () => 'recoverable',
      unavailable: () => 'unavailable',
    }),
  )
  t.check(
    'foldSourceState dispatches each arm to its own branch',
    arms.join(',') === 'ready,empty,stale,unavailable',
    arms.join(','),
  )
}

t.section('§3 — a source that read once degrades to STALE, not to nothing')
{
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()

  let sid: string | null = null
  try {
    sid = bootstrap.getSessionId()
  } catch {
    sid = null
  }

  const projection = await import('../../src/services/workbench/projection.ts')
  const lanesRoot = join(ROOT, 'lanes')

  // A readable lanes directory holding one real lane ⇒ the source READS.
  mkdirSync(guardWrite(ROOT, lanesRoot), { recursive: true })
  writeFileSync(
    guardWrite(ROOT, join(lanesRoot, 'lane-keel.json')),
    JSON.stringify({
      schema: 1,
      id: 'lane-keel',
      parentSessionId: sid ?? 'parent',
      childSessionId: 'child',
      goal: 'prove the stale path',
      selectedContextRefs: [],
      excludedState: [],
      createdAt: 1,
      status: 'active',
      boundaryRevision: 1,
      updatedAt: 1,
    }),
  )

  // The engine's history map, passed explicitly — the same seam refreshOnce
  // uses. The one-shot resolve deliberately has none, which is what keeps
  // prove-source-truth's `unavailable` deterministic.
  const lastGood = new Map<string, unknown>()

  const first = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'a readable lanes store reports ready',
    first.sources.contextLanes.state === 'ready',
    `state=${first.sources.contextLanes.state}`,
  )

  // Now break it exactly as the M0 reproducer does: a FILE where the
  // directory was. It exists, and enumerating it is ENOTDIR.
  rmSync(lanesRoot, { recursive: true, force: true })
  writeFileSync(guardWrite(ROOT, lanesRoot), 'not a directory')

  const second = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'the failed re-read degrades to STALE, not unavailable',
    second.sources.contextLanes.state === 'stale',
    `state=${second.sources.contextLanes.state}`,
  )
  t.check(
    'the last-known-good lane is still carried, not erased',
    second.contextLanes.length === 1 && second.contextLanes[0]?.id === 'lane-keel',
    `lanes=${JSON.stringify(second.contextLanes)}`,
  )
  t.check(
    'the stale row still names WHY it went stale',
    (reasonOf(second.sources.contextLanes) ?? '').includes('ENOTDIR'),
    reasonOf(second.sources.contextLanes) ?? '(none)',
  )

  // A clean read that finds NOTHING must retire the memory — continuing to
  // show deleted rows as "stale" is the same lie pointing the other way.
  rmSync(lanesRoot, { recursive: true, force: true })
  mkdirSync(guardWrite(ROOT, lanesRoot), { recursive: true })
  const third = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'an empty-but-readable store reports empty',
    third.sources.contextLanes.state === 'empty',
    `state=${third.sources.contextLanes.state}`,
  )

  rmSync(lanesRoot, { recursive: true, force: true })
  writeFileSync(guardWrite(ROOT, lanesRoot), 'not a directory')
  const fourth = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'after an honest empty, a later failure is unavailable — the retired memory does not return',
    fourth.sources.contextLanes.state === 'unavailable',
    `state=${fourth.sources.contextLanes.state}`,
  )
}

t.finish('prove-source-vocabulary')
