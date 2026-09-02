#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/input-core/composer-document.ts'
const KINDS = ['file', 'image', 'selection', 'large-paste', 'artifact', 'session-ref']

t.section('Journey F — ComposerDocumentV2 + the typed context shelf exist')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/input-core/composer-document.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no scoped composer document',
)
t.check('createComposerDocument exists', typeof mod?.createComposerDocument === 'function')
const kinds = mod?.SHELF_ITEM_KINDS as unknown
t.check(
  'SHELF_ITEM_KINDS carries every required chip kind',
  Array.isArray(kinds) && KINDS.every(k => (kinds as string[]).includes(k)),
  Array.isArray(kinds) ? (kinds as string[]).join(',') : 'absent',
)

t.section('Journey F — the shelf surface is bound (RV-15/16)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check(
    "the Action Graph names no 'composer:shelf' surface (retired with the board)",
    !/['"]composer:shelf['"]/.test(ag),
    'a shelf surface is registered — the retirement regressed',
  )
}

t.finish('repro-journey-f')
