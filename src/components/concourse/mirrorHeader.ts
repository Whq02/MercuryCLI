import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'

const NOW_WORDS_FLOOR = 8
const NOW_GLYPH_CELLS = 2
const NOW_WORDS_LEAD = 1

export function mirrorHeaderFit(args: {
  titleShown: string
  facts: readonly string[]
  paneWidth: number
  hintWidth: number
  noteReserve: number | null
  nowWords: string | null
  nowText: string | null
}): { factsShown: string; nowText: string | null; cluster: number } {
  const { titleShown, facts, paneWidth, hintWidth, noteReserve, nowWords } = args
  const factsWidth = facts.length > 0 ? stringWidth(` · ${facts.join(' · ')}`) : 0
  let nowText = args.nowText
  let cluster = noteReserve ?? hintWidth
  if (noteReserve === null && hintWidth > 0 && nowWords !== null) {
    const spare = paneWidth - 2 - stringWidth(titleShown) - factsWidth - hintWidth - NOW_GLYPH_CELLS - NOW_WORDS_LEAD
    if (nowText === null || spare < stringWidth(nowText)) nowText = spare >= NOW_WORDS_FLOOR ? truncateToWidth(nowWords, spare) : null
    cluster = hintWidth + NOW_GLYPH_CELLS + (nowText === null ? 0 : stringWidth(nowText) + NOW_WORDS_LEAD)
  }
  const room = Math.max(0, Math.max(8, paneWidth - cluster - 2) - stringWidth(titleShown))
  let factsShown = ''
  for (const fact of facts) {
    const next = `${factsShown} · ${fact}`
    if (stringWidth(next) > room) break
    factsShown = next
  }
  return { factsShown, nowText, cluster }
}
