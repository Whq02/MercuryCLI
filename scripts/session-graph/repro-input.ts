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

t.finish('repro-input')
