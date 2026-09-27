import { isLocalModelId, localWireId } from '../providers/local/localCatalogue.js'
import { gbWords, gibWords, tokensWords, type KvGeometry } from '../localServer/localServerMemory.js'
import { parseOllamaTags, type LocalServerTruth } from '../localServer/localServerTruth.js'
import { fitLocalWindowOn } from '../localServer/localWindowFit.js'
import { num, readJson, rec, resolveSetupIo, str } from './setupIo.js'
import { SETUP_CHOOSE_KEYS, SETUP_CURRENT_WORDS, SETUP_MODEL_LIBRARY, SETUP_MODEL_TAG, SETUP_SHOW_BOUND, SETUP_TESTED_WORDS, type SetupIo, type SetupModelChoice, type SetupModelRow, type SetupPullCandidate } from './setupTypes.js'

const QWEN35_TRAINED_MAX = 262_144

function qwen35(blockCount: number, attentionLayers: number, kvHeadsPerLayer: number): KvGeometry {
  return { kvHeads: attentionLayers * kvHeadsPerLayer, keyLength: 256, valueLength: 256, attentionLayers, blockCount }
}

export const SETUP_PULL_CANDIDATES: readonly SetupPullCandidate[] = [
  { tag: 'qwen3.5:0.8b', sizeWords: '1.0 GB', sizeBytes: 1.0e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(24, 6, 2) },
  { tag: 'qwen3.5:2b', sizeWords: '2.7 GB', sizeBytes: 2.7e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(24, 6, 2) },
  { tag: 'qwen3.5:4b', sizeWords: '3.4 GB', sizeBytes: 3.4e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(32, 8, 4) },
  { tag: SETUP_MODEL_TAG, sizeWords: '6.6 GB', sizeBytes: 6.6e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(32, 8, 4), tested: true },
  { tag: 'qwen3.5:27b', sizeWords: '17 GB', sizeBytes: 17e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(64, 16, 4) },
  { tag: 'qwen3.5:35b', sizeWords: '24 GB', sizeBytes: 24e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(40, 10, 2) },
  { tag: 'qwen3.5:122b', sizeWords: '81 GB', sizeBytes: 81e9, trainedMax: QWEN35_TRAINED_MAX, geometry: qwen35(48, 12, 2) },
]

export function pullCandidateOf(tag: string): SetupPullCandidate | undefined {
  return SETUP_PULL_CANDIDATES.find(c => c.tag === tag)
}

export function currentWireTag(model: string | null | undefined): string | undefined {
  if (model === null || model === undefined || !isLocalModelId(model)) return undefined
  return localWireId(model)
}

export function pullRowWords(candidate: SetupPullCandidate, fit: { window: number; fits: boolean }): string {
  return `pull ${candidate.sizeWords} · ${fit.fits ? `fits · ${tokensWords(fit.window)}` : 'does not fit'}`
}

export function serverRowWords(sizeBytes: number | undefined, trainedMax: number | undefined): string {
  const parts = ['on the server']
  if (sizeBytes !== undefined) parts.push(gbWords(sizeBytes))
  if (trainedMax !== undefined) parts.push(`trained ${tokensWords(trainedMax)}`)
  return parts.join(' · ')
}

export function pullCandidateRows(truth: LocalServerTruth, listed: ReadonlySet<string>, slots?: number, cacheType?: string, candidates: readonly SetupPullCandidate[] = SETUP_PULL_CANDIDATES): SetupModelRow[] {
  const rows: SetupModelRow[] = []
  for (const candidate of candidates) {
    if (listed.has(candidate.tag)) continue
    const fit = fitLocalWindowOn(truth, { name: candidate.tag, weightsBytes: candidate.sizeBytes, geometry: candidate.geometry, trainedMax: candidate.trainedMax }, slots, cacheType)
    const summary = { window: fit.window, fits: fit.fits }
    rows.push({ tag: candidate.tag, on: 'pull', words: pullRowWords(candidate, summary), sizeBytes: candidate.sizeBytes, trainedMax: candidate.trainedMax, fit: summary, ...(candidate.tested === true ? { tested: true } : {}) })
  }
  return rows
}

export function markRows(rows: SetupModelRow[], currentTag: string | undefined, nothingLocal: boolean): SetupModelRow[] {
  return rows.map(row => {
    const current = currentTag !== undefined && row.tag === currentTag
    const tested = row.tested === true && nothingLocal
    const marks = [...(current ? [SETUP_CURRENT_WORDS] : []), ...(tested ? [SETUP_TESTED_WORDS] : [])]
    const words = marks.length > 0 ? `${row.words} · ${marks.join(' · ')}` : row.words
    const { tested: _tested, ...rest } = row
    return { ...rest, words, ...(current ? { current: true } : {}), ...(tested ? { tested: true } : {}) }
  })
}

export function chooseKeysLine(current: string | undefined): string {
  return current !== undefined ? `${SETUP_CHOOSE_KEYS} · esc keeps ${current}` : `${SETUP_CHOOSE_KEYS} · esc stop`
}

export function choiceWords(label: string, root: string, rows: SetupModelRow[], truth: LocalServerTruth, current: string | undefined, currentTag: string | undefined): string {
  const onServer = rows.filter(r => r.on === 'server').length
  const listedWords = onServer === 0 ? `${label} at ${root} lists no model` : `${label} at ${root} lists ${onServer} model${onServer === 1 ? '' : 's'}`
  const box = `pulls sized for this box: ${gibWords(truth.machine.usableMemoryBytes)} usable of ${gibWords(truth.machine.totalMemoryBytes)} (${SETUP_MODEL_LIBRARY})`
  const session =
    current === undefined
      ? `no local model is set up yet · ${SETUP_MODEL_TAG} is ${SETUP_TESTED_WORDS}`
      : currentTag === undefined
        ? `no local model is set up yet (the session is on ${current}) · ${SETUP_MODEL_TAG} is ${SETUP_TESTED_WORDS}`
        : rows.some(r => r.current === true && r.on === 'server')
          ? `the session is on ${current}`
          : `the session is on ${current}, not on this server`
  return `${listedWords} · ${session} · nothing is pre-chosen · ${box}`
}

export async function readModelChoice(root: string, label: string, seam: SetupIo = {}): Promise<SetupModelChoice> {
  const io = resolveSetupIo(seam)
  const tags = await readJson(io, `${root}/api/tags`)
  const listed = tags === undefined ? [] : parseOllamaTags(tags)
  const truth = await io.readTruth()
  const serverRows: SetupModelRow[] = []
  for (const model of listed.slice(0, SETUP_SHOW_BOUND)) {
    let trainedMax = model.trainedContext
    if (trainedMax === undefined) {
      const show = rec(await readJson(io, `${root}/api/show`, { model: model.name }))
      const info = rec(show?.model_info)
      const arch = info ? str(info['general.architecture']) : undefined
      trainedMax = info && arch ? num(info[`${arch}.context_length`]) : undefined
    }
    serverRows.push({ tag: model.name, on: 'server', words: serverRowWords(model.sizeBytes, trainedMax), ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}), ...(trainedMax !== undefined ? { trainedMax } : {}), ...(pullCandidateOf(model.name)?.tested === true ? { tested: true } : {}) })
  }
  const names = new Set(listed.map(m => m.name))
  const current = io.currentModel() ?? undefined
  const currentTag = currentWireTag(current)
  const nothingLocal = currentTag === undefined
  const rows = markRows([...serverRows, ...pullCandidateRows(truth, names, io.parallelSlots, io.cacheType)], currentTag, nothingLocal)
  return {
    rows,
    ...(current !== undefined ? { current } : {}),
    ...(currentTag !== undefined ? { currentTag } : {}),
    nothingLocal,
    words: choiceWords(label, root, rows, truth, current, currentTag),
  }
}
