#!/usr/bin/env bun
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EMBED_ADDON_FILE, embedPackDirFor } from '../../src/mneme/embedPack.js'
import { EMBED_MODELS, EMBED_MODELS_VENDOR_PATH } from '../../src/mneme/embedModels.js'
import { voicePackPlatform } from '../../src/services/voice/voicePack.js'
import { STUDY_FIXTURE_PATH, loadStudyCorpus, type StudyCorpus, type StudySimEntry } from './bench-semantic-recall.js'

const ROOT = resolve(import.meta.dir, '..', '..')

export interface SimilarityRecorder {
  loadModel(path: string): number
  modelInfo(handle: number): { name: string; architecture: string; dimension: number; layers: number; pooling: string }
  embed(handle: number, text: string, isQuery?: boolean): number[]
  unloadModel(handle: number): void
}

export function openRecorder(root = ROOT): SimilarityRecorder | null {
  const addonPath = join(embedPackDirFor(root, voicePackPlatform()), EMBED_ADDON_FILE)
  if (!existsSync(addonPath)) return null
  return createRequire(import.meta.url)(addonPath) as SimilarityRecorder
}

export function recordSimilarities(corpus: StudyCorpus, recorder: SimilarityRecorder, modelFile: string, decimals = 6): Record<string, StudySimEntry[]> {
  const handle = recorder.loadModel(modelFile)
  try {
    const docs = new Map(corpus.candidates.map(c => [c.id, recorder.embed(handle, c.text ?? c.id, false)]))
    const out: Record<string, StudySimEntry[]> = {}
    const f = 10 ** decimals
    for (const q of corpus.questions) {
      const qv = recorder.embed(handle, q.query, true)
      out[q.id] = corpus.candidates
        .map(c => {
          const dv = docs.get(c.id)!
          let s = 0
          for (let i = 0; i < qv.length; i++) s += qv[i]! * dv[i]!
          return { id: c.id, sim: Math.round(s * f) / f }
        })
        .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id))
    }
    return out
  } finally {
    recorder.unloadModel(handle)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--corpus')
  const path = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : STUDY_FIXTURE_PATH)
  const write = args.includes('--write')
  const recorder = openRecorder()
  if (recorder === null) {
    console.error('record-semantic-similarities: no embed pack on this host — bun run scripts/vendor/build-embed.ts builds it')
    process.exit(2)
  }
  const corpus = loadStudyCorpus(path)
  const rowsByName = new Map(EMBED_MODELS.map(r => [r.name, r]))
  let recorded = 0
  for (const m of corpus.models) {
    const row = rowsByName.get(m.name)
    const file = row ? join(ROOT, EMBED_MODELS_VENDOR_PATH, row.file) : ''
    if (!row || !existsSync(file)) {
      console.log(`record-semantic-similarities: ${m.name} — weights absent in ${EMBED_MODELS_VENDOR_PATH} (bun run scripts/vendor/fetch-embed-models.ts --model ${m.name}); left as recorded`)
      continue
    }
    const t0 = performance.now()
    corpus.similaritiesByModel[m.name] = recordSimilarities(corpus, recorder, file)
    recorded++
    console.log(`record-semantic-similarities: ${m.name} — ${corpus.questions.length} questions × ${corpus.candidates.length} candidates in ${(performance.now() - t0).toFixed(0)} ms`)
  }
  if (write) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    raw.similaritiesByModel = corpus.similaritiesByModel
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n')
    console.log(`record-semantic-similarities: wrote ${recorded} model(s) of similarities into ${path}`)
  } else {
    console.log(`record-semantic-similarities: ${recorded} model(s) recorded in memory — pass --write to store them in ${path}`)
  }
}
