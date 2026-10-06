#!/usr/bin/env bun

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

  const workspace = join(ROOT, 'workspace')
  mkdirSync(guardWrite(ROOT, workspace), { recursive: true })
  bootstrap.setOriginalCwd(workspace)
  bootstrap.setCwdState(workspace)

  const store = await import('../../src/utils/artifacts/reviewStore.ts')
  const projection = await import('../../src/services/workbench/projection.ts')
  const artifactsRoot = guardWrite(ROOT, store.reviewArtifactsRoot())

  const made = store.createReviewArtifact({
    kind: 'plan',
    title: 'prove the stale path',
    producer: { sessionId: 'source-vocabulary' },
    workspace: { roots: [workspace] },
    body: { kind: 'plan', markdown: '# plan\n\nprove the stale path' },
  })
  t.check('one real artifact for this workspace lands in the store', made.ok, made.ok ? '' : made.reason)

  const lastGood = new Map<string, unknown>()

  const first = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'a readable artifacts store reports ready',
    first.sources.artifacts.state === 'ready',
    `state=${first.sources.artifacts.state}`,
  )

  rmSync(artifactsRoot, { recursive: true, force: true })
  writeFileSync(artifactsRoot, 'not a directory')

  const second = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'the failed re-read degrades to STALE, not unavailable',
    second.sources.artifacts.state === 'stale',
    `state=${second.sources.artifacts.state}`,
  )
  t.check(
    'the last-known-good artifact is still carried, not erased',
    second.artifacts.length === 1 && second.artifacts[0]?.title === 'prove the stale path',
    `artifacts=${JSON.stringify(second.artifacts)}`,
  )
  t.check(
    'the stale row still names WHY it went stale',
    (reasonOf(second.sources.artifacts) ?? '').includes('ENOTDIR'),
    reasonOf(second.sources.artifacts) ?? '(none)',
  )

  rmSync(artifactsRoot, { recursive: true, force: true })
  mkdirSync(artifactsRoot, { recursive: true })
  const third = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'an empty-but-readable store reports empty',
    third.sources.artifacts.state === 'empty',
    `state=${third.sources.artifacts.state}`,
  )

  rmSync(artifactsRoot, { recursive: true, force: true })
  writeFileSync(artifactsRoot, 'not a directory')
  const fourth = await projection.gatherWorkbenchInputs({ lastGood })
  t.check(
    'after an honest empty, a later failure is unavailable — the retired memory does not return',
    fourth.sources.artifacts.state === 'unavailable',
    `state=${fourth.sources.artifacts.state}`,
  )
}

t.finish('prove-source-vocabulary')
