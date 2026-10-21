import { getSessionId } from '../../bootstrap/state.js'
import { mnemeEnabled, mnemeLibraryDir } from '../../mneme/mnemeGates.js'
import { MESH_PAGE_NAME, MESH_PAGE_TITLE, memoryMesh, meshSummary, renderMemoryMeshPage } from '../../mneme/mnemeMeshPage.js'
import type { LedgerEntry } from '../../mneme/types.js'
import { keepSample } from '../../services/samples/bridge.js'
import { SAMPLE_HTML_CAP_BYTES, samplesEnabled, type SampleItem } from '../../services/samples/contracts.js'
import { openSampleUrl } from '../../services/samples/open.js'

export const MEMORY_PAGE_OFF_SENTENCE =
  "/memory page draws the library through Samples, which are off — MERCURY_SAMPLES=1 turns them on (the Boot Menu's Samples row saves it for new sessions)"

const MEMORY_PAGE_MEMORY_OFF_SENTENCE = 'memory is off (memory.enabled is false in settings) — there is no library to draw.'

interface MemoryPageOutcome {
  line: string
  kept?: SampleItem
}

export async function openMemoryPage(
  opts: { dir?: string; sessionId?: string; sessions?: readonly LedgerEntry[]; now?: Date; open?: (url: string) => Promise<boolean> } = {},
): Promise<MemoryPageOutcome> {
  if (!mnemeEnabled()) return { line: MEMORY_PAGE_MEMORY_OFF_SENTENCE }
  if (!samplesEnabled()) return { line: MEMORY_PAGE_OFF_SENTENCE }
  const mesh = memoryMesh(opts.dir ?? mnemeLibraryDir(), { ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}), ...(opts.now !== undefined ? { now: opts.now } : {}) })
  const html = renderMemoryMeshPage(mesh)
  if (Buffer.byteLength(html, 'utf8') > SAMPLE_HTML_CAP_BYTES) {
    return { line: `the memory page would be larger than the ${SAMPLE_HTML_CAP_BYTES / (1024 * 1024)} MB a sample keeps — ${meshSummary(mesh)}; nothing was kept.` }
  }
  const kept = await keepSample(opts.sessionId ?? String(getSessionId()), { name: MESH_PAGE_NAME, title: MESH_PAGE_TITLE, html, source: 'product' })
  const opened = await (opts.open ?? openSampleUrl)(kept.url)
  const where = kept.url.startsWith('file:') ? ` (${kept.url})` : ''
  return {
    line: opened
      ? `Opened the memory page v${kept.version} in your browser — ${meshSummary(mesh)}. /samples lists it.`
      : `Kept the memory page v${kept.version} — ${meshSummary(mesh)}; the browser did not open it: /samples lists it${where}.`,
    kept,
  }
}
