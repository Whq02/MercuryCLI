#!/usr/bin/env bun
// ============================================================================
//  prove-status-spine-unity — one scroll, one mark language.
//
//  The split: the transcript's row spine paints ● success / ✕ failed from
//  theme.ts (STATE_STYLE — "the authoritative honest-state mapping") while
//  the tool cards nested directly beneath those rows painted ✓ / × from a
//  rival table (toolCardGrammar) that ALSO mapped 'stopped' to the green
//  tick — a stopped run reading as a success, one line under a row that
//  said otherwise. Operator-ruled (R3): stopped NEVER paints a green tick —
//  the spine's neutral. The law: toolCardGrammar is a PROJECTION of
//  STATE_STYLE — every card word resolves through CARD_TO_SPINE onto the
//  spine's glyph and colour; the card file owns no rival glyph table.
//
//  §1 the projection is structural (the mapping exists; no rival glyphs)
//  §2 settled marks are the spine's (● and ✕ — never ✓, never ×)
//  §3 R3: stopped is the neutral ○, never success-toned
//  §4 the fallback stays honest ('·', muted)
// ============================================================================
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

// §1 structural
t('§1 the card grammar projects through CARD_TO_SPINE', src.includes('CARD_TO_SPINE'))
t('§1 …reading the spine table, never a rival', src.includes('STATE_STYLE'))
t("§1 no rival check-mark glyphs in the file", !src.includes("'✓'") && !src.includes("'×'"))

// §2 settled marks
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

// §3 R3
{
  const stopped = cardTone('stopped')
  t("§3 'stopped' is the spine's neutral ○", stopped.glyph === STATE_STYLE.off.glyph && stopped.tone === STATE_STYLE.off.color, `${stopped.glyph}`)
  t("§3 'stopped' is never success-toned", stopped.tone !== STATE_STYLE.ready.color)
  const expired = cardTone('expired')
  t("§3 'expired' reads as the spine's staleness", expired.glyph === STATE_STYLE.stale.glyph)
}

// §4 the fallback
{
  const fb = cardTone('__unknown__')
  t("§4 unknown states read neutral '·', never invented", fb.glyph === '·')
}

// §5 the adaptive door (B5's named follow-up, landed) — cardToneOf resolves
// the SAME projection through stateStyleOf; dark ≡ the fixed constants
// byte-identically, and the card consumers ride the door.
{
  const { cardToneOf } = await import('../../src/components/mercury-ui/toolCardGrammar.ts')
  const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
  const { TERRA } = await import('../../src/components/mercuryPalette.ts')
  // The identity accent; the state roles do not depend on it.
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
  // The consumers: every tool card rides the token door; the one-argument
  // fixed read survives ONLY on the named text surfaces (doctor).
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
