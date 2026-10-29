#!/usr/bin/env bun

import { checker } from '../engine-durability/harness.ts'
import { rowsBinding, shippedKeyForms } from '../lib/shippedKeyForms.ts'

const t = checker()

t.section('CS-27 — the Constellation actions live in the one key atlas')
const withoutConcourse = shippedKeyForms()
  .filter(form => rowsBinding([form], action => action.startsWith('concourse:')).length === 0)
  .map(form => form.form)
t.check(
  "the atlas carries a 'concourse:' action family",
  withoutConcourse.length === 0,
  withoutConcourse.length > 0 ? `no concourse action on ${withoutConcourse.join(' · ')}` : '',
)

t.section('CS-27 — disposition visibility is prover-pinned')
let dispatch: Record<string, unknown> | null = null
try {
  dispatch = (await import('../../src/services/crew/dispatch.ts')) as Record<string, unknown>
} catch {
  dispatch = null
}
t.check(
  'the visible target+disposition label renderer exists (dispositionLabelOf)',
  typeof dispatch?.dispositionLabelOf === 'function',
  'no one owner renders `Steer X now` / `Hold for X next` / `Start a turn with X`',
)

t.finish('repro-input')
