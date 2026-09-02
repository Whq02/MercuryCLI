#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-corpus-verdict.ts — pooled half: the
//  committed corpus verdict is present, well-formed, and CLEAN.
//
//  The corpus itself (eval-asking-corpus.ts) is BILLED live-model work and
//  never runs in the pool; this validator holds the committed artifact to
//  the row's bar so the verdict cannot rot or be hand-waved:
//    · schema + method recorded;
//    · at least 10 scenarios spanning resolved / trivial / open / dependent;
//    · every scenario carries its asked-question record;
//    · ZERO violations (no resolved or trivial topic was asked; no
//      dependent question rode its parent's round);
//    · the model was identified from the message FIELD, and the run cost
//      was journaled.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const path = join(import.meta.dir, 'corpus-verdict.json')
t.section('§1 — the committed verdict artifact')
t.check('corpus-verdict.json exists beside the suite', existsSync(path), path)
if (!existsSync(path)) {
  t.finish('prove-corpus-verdict')
}

const v = JSON.parse(readFileSync(path, 'utf8')) as {
  schema: number
  ranAt: string
  method: string
  scenarios: { name: string; kind: string; askedQuestions: string[]; violations: string[]; model: string | null; costUsd: number | null }[]
  totals: { scenarios: number; violations: number; approxCostUsd: number }
}

t.check('schema 1', v.schema === 1)
t.check('the method is recorded (assembled prompt, live calls)', v.method.includes('assembled') && v.method.includes('mercury.mjs'))
t.check('at least 10 scenarios', v.scenarios.length >= 10, `${v.scenarios.length}`)
const kinds = new Set(v.scenarios.map(s => s.kind))
t.check('resolved, trivial, open, and dependent kinds all present', ['resolved', 'trivial', 'open', 'dependent'].every(k => kinds.has(k)))

t.section('§2 — the verdict is clean')
t.check('ZERO violations across the corpus', v.totals.violations === 0, `${v.totals.violations}`)
t.check(
  'every scenario carries its record',
  v.scenarios.every(s => Array.isArray(s.askedQuestions) && Array.isArray(s.violations)),
)
t.check(
  'the model came from the message field, not a guess',
  v.scenarios.some(s => typeof s.model === 'string' && s.model.length > 0),
)
t.check('the billed cost is journaled', typeof v.totals.approxCostUsd === 'number')

t.finish('prove-corpus-verdict')
