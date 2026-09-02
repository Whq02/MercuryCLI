#!/usr/bin/env bun
// prove-settle-no-sync-flush — E11 corollary: the stream's settle swap must
// not force a SYNCHRONOUS React commit.
//
//   The settle fan-out clears the streaming tail and appends the settled
//   message. Pairing those inside the reconciler's flushSync (to make them
//   one frame) was measured to MULTIPLY retained row subtrees 6.4× over
//   thirty turns — React re-entered a synchronous commit mid-fan-out and
//   orphaned the streaming-tail subtree without running its effects'
//   cleanup, so its store subscriptions stayed registered and the whole
//   detached generation lived (paint-hardening wave, the target-0 bisect:
//   39,556 fibers with the flush vs 8,050 without). The swap's on-screen
//   atomicity is the tail store's SETTLE GHOST instead (the tail keeps
//   painting the retired text in place until the rendered transcript shows
//   the reply) — no synchronous flush required.
//
//   This pins the seam structurally: the stream fan-out must never reach a
//   synchronous reconciler flush. A source pin, not a drive — it catches
//   the exact regression the bisect named at zero cost.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, section } from './harness.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const streaming = readFileSync(join(ROOT, 'src/utils/messages/streaming.ts'), 'utf8')

section('the stream settle fan-out forces no synchronous commit')

// flushSyncFromReconciler / flushSync / a settleBatch shim in the fan-out are
// all the same regression: a synchronous commit mid-settle.
const banned = /flushSync(FromReconciler)?\s*\(|\bbatchSettle\s*\(|\bsetSettleBatcher\b/
check(
  'streaming.ts calls no synchronous reconciler flush at the settle',
  !banned.test(streaming),
  banned.exec(streaming)?.[0] ?? '',
)

// The settle ghost is the mechanism that replaces it: the tail store must
// expose the retained-text seam the fan-out relies on.
const store = readFileSync(join(ROOT, 'src/utils/messages/streamingTailStore.ts'), 'utf8')
check(
  'the tail store exposes the settle-ghost seam (readSettled/dropSettled)',
  /readSettled\s*\(/.test(store) && /dropSettled\s*\(/.test(store),
)

finish()
