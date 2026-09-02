#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/workbench/folioActions.ts'
const ACTIONS = ['accept', 'mark-reviewed', 'request-revision', 'send-feedback']

t.section('Journey G — folio ACTIONS exist beside the pure projection')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/workbench/folioActions.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — folios are observation-only',
)
const kinds = mod?.FOLIO_ACTION_KINDS as unknown
t.check(
  'FOLIO_ACTION_KINDS carries every decision verb',
  Array.isArray(kinds) && ACTIONS.every(k => (kinds as string[]).includes(k)),
  Array.isArray(kinds) ? (kinds as string[]).join(',') : 'absent',
)
t.check('applyFolioAction exists (idempotent, typed receipts)', typeof mod?.applyFolioAction === 'function')

t.finish('repro-journey-g')
