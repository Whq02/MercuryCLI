#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const streaming = readFileSync(join(ROOT, 'src/utils/messages/streaming.ts'), 'utf8')
const banned = /flushSync(FromReconciler)?\s*\(|\bbatchSettle\s*\(|\bsetSettleBatcher\b/
t('§1 streaming.ts calls no synchronous reconciler flush at the settle', !banned.test(streaming), banned.exec(streaming)?.[0] ?? '')

const store = readFileSync(join(ROOT, 'src/utils/messages/streamingTailStore.ts'), 'utf8')
t('§2 the tail store exposes the settle-ghost seam (readSettled/dropSettled)', /readSettled\s*\(/.test(store) && /dropSettled\s*\(/.test(store))

console.log(failures === 0 ? 'SETTLE NO SYNC FLUSH: ALL PASS' : 'SETTLE NO SYNC FLUSH: RED')
process.exit(failures)
