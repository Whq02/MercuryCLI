#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { keywordGlowHex, keywordGlowPositions, keywordGlowSpans } from '../../src/utils/keywordGlow.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ACCENT = '#DD4444'
const SOFT = '#E58484'
const ON = { deepthink: true, supercode: true }

console.log('\n— G1 the builder —')
{
  const text = 'please deepthink about this, supercode on'
  const spans = keywordGlowSpans(text, { accent: ACCENT, accentSoft: SOFT }, ON)
  check('one span per word, both kinds, in text order', spans.length === 2 && spans[0]!.start < spans[1]!.start, JSON.stringify(spans))
  check('the spans cover the words exactly', text.slice(spans[0]!.start, spans[0]!.end).toLowerCase() === 'deepthink' && text.slice(spans[1]!.start, spans[1]!.end).toLowerCase() === 'supercode', JSON.stringify(spans))
  check("every span's colour is the accent and its sweep colour the soft companion", spans.every(s => s.color === ACCENT && s.shimmerColor === SOFT), JSON.stringify(spans))
  check('a static paint carries no sweep colour', keywordGlowSpans(text, { accent: ACCENT, accentSoft: SOFT }, ON, { shimmer: false }).every(s => s.shimmerColor === undefined))
  check('the priority rides through', keywordGlowSpans(text, { accent: ACCENT, accentSoft: SOFT }, ON, { priority: 7 }).every(s => s.priority === 7))
  check('deepthink off ⇒ only the supercode word glows', keywordGlowPositions(text, { deepthink: false, supercode: true }).map(p => p.kind).join(',') === 'supercode')
  check('supercode off ⇒ only the deepthink word glows', keywordGlowPositions(text, { deepthink: true, supercode: false }).map(p => p.kind).join(',') === 'deepthink')
  check('no word ⇒ no span', keywordGlowSpans('a plain sentence', { accent: ACCENT, accentSoft: SOFT }, ON).length === 0)
  check('a paint that is not a hex hue yields no span (the base ink stands, never a guess)', keywordGlowSpans(text, { accent: 'ansi:red', accentSoft: SOFT }, ON).length === 0 && keywordGlowHex('rgb(1, 2, 3)') === undefined && keywordGlowHex('#AbCdEf') === '#AbCdEf')
  check('a soft companion that is not a hue falls to the accent', keywordGlowSpans(text, { accent: ACCENT, accentSoft: 'default' }, ON).every(s => s.shimmerColor === ACCENT))
  const octopus = keywordGlowSpans(text, { accent: '#B07BE0', accentSoft: '#C9A6EA' }, ON)
  check("another critter's accent paints the same words in ITS hue", octopus.every(s => s.color === '#B07BE0'))
}

console.log('\n— G2 the surfaces read the owner —')
{
  const composer = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
  check('the composer builds its keyword spans through keywordGlowSpans, in the session tokens\' accent and soft companion, with the sweep', composer.includes('keywordGlowSpans(') && composer.includes('{ accent: tokens.accent, accentSoft: tokens.accentSoft }') && composer.includes('{ deepthink: isDeepthinkEnabled(), supercode: true }') && composer.includes('shimmer: true'))
  check('the composer keeps no palette of its own for the word', !composer.includes("['suggestion', 'permission', 'success']"))
  const row = readFileSync('src/components/messages/HighlightedThinkingText.tsx', 'utf8')
  check('the transcript row takes its positions from keywordGlowPositions and paints the accent, static', row.includes('keywordGlowPositions(text, { deepthink: isDeepthinkEnabled(), supercode: true })') && row.includes('color={accent}') && !row.includes('getRainbowColor'))
  const shimmer = readFileSync('src/components/PromptInput/ShimmeredInput.tsx', 'utf8')
  check('the shimmered input still runs the sweep road the spans ride (shimmerColor)', shimmer.includes('shimmerColor') && shimmer.includes('ShimmerChar'))
}

console.log('\n— G3 the rainbow is gone —')
{
  const thinking = readFileSync('src/utils/thinking.ts', 'utf8')
  const theme = readFileSync('src/utils/theme.ts', 'utf8')
  check('no rainbow painter remains', !thinking.includes('getRainbowColor') && !thinking.includes('RAINBOW_'))
  check('no rainbow token remains in the theme', !theme.includes('rainbow_'))
}

console.log(failures === 0 ? '\nprove-keyword-glow: ALL LAWS HOLD' : `\nprove-keyword-glow: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
