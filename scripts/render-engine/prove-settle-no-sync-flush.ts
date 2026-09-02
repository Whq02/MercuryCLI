#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, section } from './harness.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const streaming = readFileSync(join(ROOT, 'src/utils/messages/streaming.ts'), 'utf8')

section('the stream settle fan-out forces no synchronous commit')

const banned = /flushSync(FromReconciler)?\s*\(|\bbatchSettle\s*\(|\bsetSettleBatcher\b/
check(
  'streaming.ts calls no synchronous reconciler flush at the settle',
  !banned.test(streaming),
  banned.exec(streaming)?.[0] ?? '',
)

const store = readFileSync(join(ROOT, 'src/utils/messages/streamingTailStore.ts'), 'utf8')
check(
  'the tail store exposes the settle-ghost seam (readSettled/dropSettled)',
  /readSettled\s*\(/.test(store) && /dropSettled\s*\(/.test(store),
)

finish()
