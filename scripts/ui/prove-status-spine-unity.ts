#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cardTone } from '../../src/components/mercury-ui/toolCardGrammar.ts'
import { STATE_STYLE } from '../../src/components/mercury-ui/theme.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const src = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/toolCardGrammar.ts'), 'utf8')

t('§1 the card grammar projects through CARD_TO_SPINE', src.includes('CARD_TO_SPINE'))
t('§1 …reading the spine table, never a rival', src.includes('STATE_STYLE'))
t("§1 no rival check-mark glyphs in the file", !src.includes("'✓'") && !src.includes("'×'"))

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
  const { cardToneOf } = await import('../../src/components/mercury-ui/toolCardGrammar.ts')
  const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
  const { TERRA } = await import('../../src/components/mercuryPalette.ts')
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
  const { readdirSync, readFileSync: readFs, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const toolsDir = join(import.meta.dir, '..', '..', 'src', 'tools')
  const offenders: string[] = []
  for (const dir of readdirSync(toolsDir)) {
    const ui = join(toolsDir, dir, 'UI.tsx')
    if (!existsSync(ui)) continue
    const body = readFs(ui, 'utf8')
    if (/\bcardTone\(/.test(body) || /= cardTone\b/.test(body)) offenders.push(dir)
  }
  t('§5 no tool card reads the fixed one-argument door any more', offenders.length === 0, offenders.join(','))
  const grammar = readFs(join(import.meta.dir, '..', '..', 'src', 'components', 'mercury-ui', 'toolCardGrammar.ts'), 'utf8')
  t('§5 the door projects through stateStyleOf (the adaptive spine)', grammar.includes('stateStyleOf(t, spine)'))
  t('§5 WithCardTone owns the hook for non-component render functions', grammar.includes('export function WithCardTone'))
}

console.log(failures === 0 ? 'STATUS SPINE UNITY: ALL PASS' : 'STATUS SPINE UNITY: RED')
process.exit(failures)
