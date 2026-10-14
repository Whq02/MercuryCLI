#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface LinkCandidate {
  id: string
  seq?: number
  slug: string
  pending: boolean
  pinned?: boolean
  kind?: 'fact' | 'ruling' | 'pending' | 'handoff' | 'session'
  time?: string
  directUseCount: number
  flowedUseCount: number
  footnotes: { session?: number; ruling?: string; supersedes?: string }
  text: string
}

export interface LinkQuestion {
  id: string
  target: string
  session?: number
  ruling?: string
  query: string
}

export interface LinkCorpus {
  recordedAt: string
  candidates: LinkCandidate[]
  questions: LinkQuestion[]
}

export interface Score {
  at1: number
  at5: number
  sameSession: number
  ranks: string
}

const ROOT = resolve(import.meta.dir, '..', '..')

export function loadLinkCorpus(path: string): LinkCorpus {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LinkCorpus>
  if (typeof raw.recordedAt !== 'string' || !Array.isArray(raw.candidates) || !Array.isArray(raw.questions)) throw new Error(`${path}: not a study corpus (recordedAt, candidates, questions)`)
  for (const c of raw.candidates) {
    if (typeof c.id !== 'string' || typeof c.text !== 'string' || typeof c.slug !== 'string') throw new Error(`${path}: a candidate lacks id, slug or text`)
    c.footnotes = c.footnotes ?? {}
    c.directUseCount = Number.isFinite(c.directUseCount) ? c.directUseCount : 0
    c.flowedUseCount = Number.isFinite(c.flowedUseCount) ? c.flowedUseCount : c.directUseCount
  }
  return raw as LinkCorpus
}

export function scoreOrders(corpus: LinkCorpus, orderOf: (q: LinkQuestion) => readonly string[]): Score {
  const byId = new Map(corpus.candidates.map(c => [c.id, c]))
  let at1 = 0
  let at5 = 0
  let same = 0
  let seen = 0
  const ranks: string[] = []
  for (const q of corpus.questions) {
    const order = orderOf(q)
    if (order[0] === q.target) at1++
    const top = order.slice(0, 5)
    if (top.includes(q.target)) at5++
    const at = order.indexOf(q.target)
    ranks.push(`${q.id}:${at < 0 ? '-' : at + 1}`)
    if (q.session !== undefined) {
      seen += top.length
      for (const id of top) if (byId.get(id)?.footnotes.session === q.session) same++
    }
  }
  return { at1, at5, sameSession: seen > 0 ? same / seen : 0, ranks: ranks.join(' ') }
}

const n = (k: number, of: number): string => `${k}/${of} (${((100 * k) / of).toFixed(1)}%)`

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const corpusAt = argv.indexOf('--corpus')
  const corpusPath = resolve(corpusAt >= 0 && argv[corpusAt + 1] ? argv[corpusAt + 1]! : join(import.meta.dir, 'fixtures', 'study-corpus.json'))
  const modelsAt = argv.indexOf('--models-dir')
  const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bench-links-')))
  process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.chdir(ROOT)
  const pack = await import('../../src/mneme/embedPack.js')
  const models = await import('../../src/mneme/embedModels.js')
  const idx = await import('../../src/mneme/mnemeIndex.js')
  const lookup = await import('../../src/mneme/mnemeLookup.js')
  const links = await import('../../src/mneme/mnemeLinks.js')
  const docs = await import('../../src/mneme/mnemeTopicDocs.js')
  const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')
  const modelsDir = resolve(modelsAt >= 0 && argv[modelsAt + 1] ? argv[modelsAt + 1]! : join(ROOT, models.EMBED_MODELS_VENDOR_PATH))
  const packDir = pack.embedPackDirFor(ROOT, voicePackPlatform())
  const finish = (code: number): never => {
    rmSync(SCRATCH, { recursive: true, force: true })
    process.exit(code)
  }
  if (!existsSync(join(packDir, pack.EMBED_PACK_MANIFEST_FILE))) {
    console.error(`bench-links: no embed pack at ${packDir} — bun run scripts/vendor/build-embed.ts`)
    finish(2)
  }
  const corpus = loadLinkCorpus(corpusPath)
  const N = corpus.questions.length
  const now = Date.parse(corpus.recordedAt)
  const dir = join(SCRATCH, 'library')
  mkdirSync(dir, { recursive: true })
  const bySlug = new Map<string, LinkCandidate[]>()
  for (const c of corpus.candidates) {
    if (c.pending || c.seq === undefined) continue
    bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c])
  }
  for (const [slug, list] of bySlug) {
    const doc = docs.emptyDoc(slug, `${slug} facts`, corpus.recordedAt)
    doc.sections.push({ heading: 'facts', entries: list.map(c => ({ text: c.text, seq: c.seq!, time: c.time ?? corpus.recordedAt, source: 'study' })) })
    writeFileSync(join(dir, docs.docFileName(slug)), docs.serializeTopicDoc(doc))
  }
  const staged = corpus.candidates.filter(c => c.pending && c.id.startsWith('pending:'))
  if (staged.length > 0) writeFileSync(join(dir, 'current.jsonl'), staged.map(c => JSON.stringify({ ts: c.id.slice('pending:'.length), source: 'study', text: c.text, topicHint: c.slug })).join('\n') + '\n')
  const pool = (flowed: boolean) => corpus.candidates.map(c => ({ id: c.id, seq: c.seq, slug: c.slug, pagePath: c.slug, pending: c.pending, pinned: c.pinned, kind: c.kind, time: c.time, useCount: flowed ? c.flowedUseCount : c.directUseCount, signature: '', text: c.text }))
  const usageOf = (flowed: boolean) => Object.fromEntries(corpus.candidates.filter(c => c.seq !== undefined).map(c => [String(c.seq), { last: '', count: flowed ? c.flowedUseCount : c.directUseCount }]))
  const byId = new Map(corpus.candidates.map(c => [c.id, c]))
  const indexFile = idx.indexPath(dir)
  const recall = (q: LinkQuestion, flowed: boolean): string[] => lookup.fuseRecallRankings(q.query, pool(flowed), [], { dir, usage: usageOf(flowed), now })
  pack.seedEmbedPackDirForTest(packDir)
  models.seedEmbedModelForTest(null, modelsDir)
  rmSync(indexFile, { force: true })
  const wordOnly = new Map(corpus.questions.map(q => [q.id, recall(q, false)]))
  const word = scoreOrders(corpus, q => wordOnly.get(q.id)!)
  const loadAddon = createRequire(import.meta.url)(join(packDir, pack.EMBED_ADDON_FILE)) as { loadModel(p: string): number; embed(h: number, t: string, q?: boolean): number[]; unloadModel(h: number): void }

  interface ModelRun { name: string; bytes: number; license: string; dimension: number; sem: Score; tree: Score; rrf: Score; buildMs: number; orders: { tree: Map<string, string[]>; rrf: Map<string, string[]> } }
  const runs: ModelRun[] = []
  for (const row of models.EMBED_MODELS) {
    const file = join(modelsDir, row.file)
    if (!existsSync(file)) {
      console.log(`(skipped ${row.name}: ${file} is absent — bun run scripts/vendor/fetch-embed-models.ts --model ${row.name})`)
      continue
    }
    models.seedEmbedModelForTest(row.name, modelsDir)
    idx.resetEmbedIndexForTest()
    rmSync(indexFile, { force: true })
    const t0 = performance.now()
    const built = await idx.rebuildEmbedIndex(dir)
    const buildMs = performance.now() - t0
    if (!built.built) throw new Error(`${row.name}: the product's index build refused: ${built.reason}`)
    const handle = loadAddon.loadModel(file)
    const vectors = new Map(corpus.candidates.map(c => [c.id, loadAddon.embed(handle, c.text, false)]))
    const semOrder = new Map(corpus.questions.map(q => {
      const qv = loadAddon.embed(handle, q.query, true)
      const sims = corpus.candidates.map(c => { const v = vectors.get(c.id)!; let s = 0; for (let i = 0; i < qv.length; i++) s += qv[i]! * v[i]!; return [c.id, s] as const })
      return [q.id, sims.sort((a, b) => b[1] - a[1]).map(([id]) => id)]
    }))
    loadAddon.unloadModel(handle)
    const tree = new Map(corpus.questions.map(q => [q.id, recall(q, false)]))
    const rrf = new Map(corpus.questions.map(q => [q.id, lookup.fuseRankings([[], wordOnly.get(q.id)!, lookup.semanticRanking(q.query, pool(false), dir)])]))
    runs.push({ name: row.name, bytes: row.bytes, license: row.license, dimension: row.dimension, buildMs, sem: scoreOrders(corpus, q => semOrder.get(q.id)!), tree: scoreOrders(corpus, q => tree.get(q.id)!), rrf: scoreOrders(corpus, q => rrf.get(q.id)!), orders: { tree, rrf } })
  }

  const lines: string[] = []
  lines.push(`corpus ${corpusPath} · ${N} questions · ${corpus.candidates.length} candidates · recorded ${corpus.recordedAt}`)
  lines.push('')
  lines.push('| model | size | licence | dim | meaning alone @1 | meaning alone @5 | this tree\'s Recall @1 | this tree\'s Recall @5 | reciprocal-rank @1 | reciprocal-rank @5 | index build |')
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  lines.push(`| word match only (this tree's Recall, no index) | — | — | — | — | — | ${n(word.at1, N)} | ${n(word.at5, N)} | ${n(word.at1, N)} | ${n(word.at5, N)} | — |`)
  for (const r of runs) lines.push(`| ${r.name} | ${(r.bytes / 1_000_000).toFixed(1)} MB | ${r.license} | ${r.dimension} | ${n(r.sem.at1, N)} | ${n(r.sem.at5, N)} | ${n(r.tree.at1, N)} | ${n(r.tree.at5, N)} | ${n(r.rrf.at1, N)} | ${n(r.rrf.at5, N)} | ${Math.round(r.buildMs)} ms |`)
  const eligible = runs.filter(r => (r.license === 'MIT' || r.license === 'Apache-2.0') && Math.max(r.sem.at5, r.tree.at5) > word.at5)
  const chosen = [...eligible].sort((a, b) => b.sem.at5 - a.sem.at5 || b.sem.at1 - a.sem.at1 || b.tree.at1 - a.tree.at1 || b.bytes - a.bytes)[0]
  lines.push('')
  lines.push(`chosen by the rule (permissive licence; best meaning-alone recall@5, then @1, then this tree's Recall @1, then the bigger model): ${chosen?.name ?? 'none'} · the lock's default: ${models.EMBED_DEFAULT_MODEL}`)

  const arms = models.EMBED_MODELS.some(r => r.name === models.EMBED_DEFAULT_MODEL) ? runs.find(r => r.name === models.EMBED_DEFAULT_MODEL) : undefined
  if (arms !== undefined) {
    models.seedEmbedModelForTest(arms.name, modelsDir)
    idx.resetEmbedIndexForTest()
    rmSync(indexFile, { force: true })
    await idx.rebuildEmbedIndex(dir)
    const newest = [...corpus.candidates].filter(c => c.footnotes.ruling).sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))[0]?.footnotes.ruling
    const newestSession = Math.max(0, ...corpus.candidates.map(c => c.footnotes.session ?? 0))
    const linkedBy = (q: LinkQuestion, kind: 'ruling' | 'unrelated' | 'session' | 'newest-session' | 'supersedes', order: readonly string[]): Set<string> => {
      const ids = new Set<string>()
      for (const id of order) {
        const c = byId.get(id)
        if (c === undefined) continue
        if (kind === 'ruling' && q.ruling !== undefined && c.footnotes.ruling === q.ruling) ids.add(id)
        if (kind === 'unrelated' && newest !== undefined && c.footnotes.ruling === newest) ids.add(id)
        if (kind === 'session' && q.session !== undefined && c.footnotes.session === q.session) ids.add(id)
        if (kind === 'newest-session' && newestSession > 0 && c.footnotes.session === newestSession) ids.add(id)
        if (kind === 'supersedes' && c.flowedUseCount > c.directUseCount) ids.add(id)
      }
      return ids
    }
    const fusions: Array<[string, (q: LinkQuestion, flowed: boolean) => string[]]> = [
      ["this tree's Recall fusion", (q, flowed) => recall(q, flowed)],
      ['reciprocal-rank preview', (q, flowed) => lookup.fuseRankings([[], flowed ? recallWord(q, true) : wordOnly.get(q.id)!, lookup.semanticRanking(q.query, pool(flowed), dir)])],
    ]
    function recallWord(q: LinkQuestion, flowed: boolean): string[] {
      const saved = readFileSync(indexFile, 'utf8')
      rmSync(indexFile, { force: true })
      try {
        return recall(q, flowed)
      } finally {
        writeFileSync(indexFile, saved)
      }
    }
    lines.push('')
    lines.push(`signals on ${arms.name} (the lift is the product's liftLinked, ${links.RULING_LIFT_PLACES} places at most, never past another linked fact; the links are the record's footnotes)`)
    lines.push('')
    lines.push('| fusion | arm | recall@1 | recall@5 | same-session share of the top five | ships |')
    lines.push('| --- | --- | ---: | ---: | ---: | --- |')
    for (const [fname, fuse] of fusions) {
      const base = new Map(corpus.questions.map(q => [q.id, fuse(q, false)]))
      const flowed = new Map(corpus.questions.map(q => [q.id, fuse(q, true)]))
      const rows: Array<[string, (q: LinkQuestion) => string[], string]> = [
        ['no links', q => base.get(q.id)!, '—'],
        ['+ supersedes: usage weight flows to the replacement', q => flowed.get(q.id)!, 'yes if neutral or better'],
        ['+ ruling: facts made under the question\'s ruling lifted', q => links.liftLinked(base.get(q.id)!, linkedBy(q, 'ruling', base.get(q.id)!)), 'yes if it moves the number'],
        ['+ both shipped links (usage flow and ruling lift)', q => links.liftLinked(flowed.get(q.id)!, linkedBy(q, 'ruling', flowed.get(q.id)!)), '—'],
        [`harm check: every question asked under the newest recorded ruling (${newest ?? 'none'})`, q => links.liftLinked(flowed.get(q.id)!, linkedBy(q, 'unrelated', flowed.get(q.id)!)), '—'],
        ['+ session: facts of the question\'s session lifted', q => links.liftLinked(base.get(q.id)!, linkedBy(q, 'session', base.get(q.id)!)), 'no unless it moves recall'],
        [`session harm check: every question asked in the newest recorded session (${newestSession})`, q => links.liftLinked(base.get(q.id)!, linkedBy(q, 'newest-session', base.get(q.id)!)), '—'],
        ['+ supersedes as a lift (facts that inherited usage lifted)', q => links.liftLinked(base.get(q.id)!, linkedBy(q, 'supersedes', base.get(q.id)!)), 'no unless it moves recall'],
      ]
      for (const [arm, orderOf, ships] of rows) {
        const s = scoreOrders(corpus, orderOf)
        lines.push(`| ${fname} | ${arm} | ${n(s.at1, N)} | ${n(s.at5, N)} | ${(100 * s.sameSession).toFixed(1)}% | ${ships} |`)
      }
    }
    const withRuling = corpus.questions.filter(q => q.ruling !== undefined)
    const own = withRuling.filter(q => byId.get(q.target)?.footnotes.ruling === q.ruling).length
    const shared = new Map<string, number>()
    for (const c of corpus.candidates) if (c.footnotes.ruling) shared.set(c.footnotes.ruling, (shared.get(c.footnotes.ruling) ?? 0) + 1)
    lines.push('')
    lines.push(`${withRuling.length} of ${N} questions carry a ruling; ${own} of them carry the target's own ruling footnote; a ruling footnote is shared by ${Math.max(0, ...shared.values())} facts at most`)
  }
  console.log(lines.join('\n'))
  finish(0)
}
