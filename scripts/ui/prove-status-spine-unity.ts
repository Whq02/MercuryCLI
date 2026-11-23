#!/usr/bin/env bun
import { join } from 'node:path'
import { cardTone } from '../../src/screen/widgets/toolCardGrammar.ts'
import { STATE_STYLE } from '../../src/screen/widgets/theme.ts'

let failures = 0
const spineFixHint = 'change the state-to-mark mapping in cardTone and cardToneOf in src/screen/widgets/toolCardGrammar.ts so it uses STATE_STYLE from src/screen/widgets/theme.ts'
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok ? ` — ${detail ? detail + '; ' : ''}${spineFixHint}` : ''}`)
  if (!ok) failures = 1
}


for (const word of ['succeeded', 'ok', 'ready', 'completed']) {
  const c = cardTone(word)
  t(`§2 '${word}' wears the spine's settled-good mark`, c.glyph === STATE_STYLE.ready.glyph && c.tone === STATE_STYLE.ready.color, `${c.glyph}`)
}
for (const word of ['failed', 'error', 'timed-out', 'absent']) {
  const c = cardTone(word)
  t(`§2 '${word}' wears the spine's failure mark`, c.glyph === STATE_STYLE.failed.glyph && c.tone === STATE_STYLE.failed.color, `${c.glyph}`)
}
for (const word of ['queued', 'starting', 'running', 'waiting', 'stopping']) {
  const c = cardTone(word)
  t(`§2 '${word}' stays the motion mark`, c.glyph === STATE_STYLE.starting.glyph, `${c.glyph}`)
}
{
  const all = ['succeeded', 'ok', 'ready', 'completed', 'failed', 'error', 'timed-out', 'absent', 'queued', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'cancelled', 'unavailable', 'busy', 'expired', 'indeterminate']
  t('§2 the retired marks appear for NO state', all.every(w => cardTone(w).glyph !== '✓' && cardTone(w).glyph !== '×'))
}

{
  const stopped = cardTone('stopped')
  t("§3 'stopped' is the spine's neutral ○", stopped.glyph === STATE_STYLE.off.glyph && stopped.tone === STATE_STYLE.off.color, `${stopped.glyph}`)
  t("§3 'stopped' is never success-toned", stopped.tone !== STATE_STYLE.ready.color)
  const expired = cardTone('expired')
  t("§3 'expired' reads as the spine's staleness", expired.glyph === STATE_STYLE.stale.glyph)
}

{
  const fb = cardTone('__unknown__')
  t("§4 unknown states read neutral '·', never invented", fb.glyph === '·')
}

{
  const { cardToneOf } = await import('../../src/screen/widgets/toolCardGrammar.ts')
  const { resolveMercuryTokens } = await import('../../src/screen/theme/mercuryTokens.ts')
  const { TERRA } = await import('../../src/screen/theme/mercuryPalette.ts')
  const dark = resolveMercuryTokens('dark', TERRA)
  const words = [
    'succeeded', 'ok', 'ready', 'completed', 'failed', 'error', 'absent', 'timed-out',
    'queued', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'cancelled',
    'busy', 'expired', 'unavailable', 'indeterminate', '__unknown__',
  ]
  t(
    '§5 dark tokens ≡ the fixed palette for EVERY card word (glyph and tone)',
    words.every(w => {
      const fixed = cardTone(w)
      const adaptive = cardToneOf(dark, w)
      return fixed.glyph === adaptive.glyph && fixed.tone === adaptive.tone
    }),
    words.filter(w => JSON.stringify(cardTone(w)) !== JSON.stringify(cardToneOf(dark, w))).join(','),
  )
}

console.log(failures === 0 ? 'STATUS SPINE UNITY: ALL PASS' : 'STATUS SPINE UNITY: RED')
process.exit(failures)
