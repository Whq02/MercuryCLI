import { stringWidth } from '../../ink/stringWidth.js'
import type { SampleRowV1 } from '../../services/engine-connector/types.js'
import { sampleStateWord } from '../../services/samples/contracts.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'

export const SAMPLES_TITLE_WIDTH = 22
export const SAMPLES_LIST_WINDOW = 10
export const SAMPLES_EMPTY_LINE = 'no samples in this session — ask the model to show you something'
export const SAMPLES_LIST_HINT = '↵ open · esc back'

export function samplesListTitle(count: number): string {
  return `SAMPLES · this session · ${count}`
}

export function sampleListRow(sample: SampleRowV1, now: number): string {
  const title = truncateToWidth(sample.title, SAMPLES_TITLE_WIDTH)
  const pad = ' '.repeat(Math.max(0, SAMPLES_TITLE_WIDTH - stringWidth(title)))
  const at = Date.parse(sample.updatedAt)
  const age = formatRelativeTimeAgo(new Date(at), { now: new Date(Math.max(now, at)) })
  return `${title}${pad} v${sample.version} · ${sampleStateWord(sample.state)} · ${age}`
}
