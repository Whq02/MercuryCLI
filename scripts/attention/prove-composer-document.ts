#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/screen/composer/input-core/composer-document.ts') | null = null
try {
  m = await import('../../src/screen/composer/input-core/composer-document.ts')
} catch {
  m = null
}
if (!m) {
  t.check('src/screen/composer/input-core/composer-document.ts loads', false, 'module absent')
t.finish('prove-composer-document')
}
const C = m!
t.section('§3 — the ONE normalization rule')
{
  const raw = 'a\u001b[31mred\u001b[0m\r\nb\rc\td'
  t.check(
    'strip-ansi + CRLF/CR→LF + tab→4 spaces, exactly the shipped rule',
    C.normalizePastedInput(raw) === 'ared\nb\nc    d',
    JSON.stringify(C.normalizePastedInput(raw)),
  )
  t.check(
    'the line rule alone keeps the tabs: a pasted chip carries the bytes the model reads',
    C.normalizePastedLines(raw) === 'ared\nb\nc\td',
    JSON.stringify(C.normalizePastedLines(raw)),
  )
}

t.finish('prove-composer-document')
