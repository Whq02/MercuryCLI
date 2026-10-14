#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'embed-index-thread-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures++
}
const finish = (): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-embed-index-off-thread: RED (${failures})` : '\nprove-embed-index-off-thread: green')
  process.exit(failures > 0 ? 1 : 0)
}

const pack = await import('../../src/mneme/embedPack.js')
const models = await import('../../src/mneme/embedModels.js')
const idx = await import('../../src/mneme/mnemeIndex.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')

const PACK_DIR = pack.embedPackDirFor(ROOT, voicePackPlatform())
const cached = join(ROOT, models.EMBED_MODELS_VENDOR_PATH, models.embedDefaultModel().file)
if (!existsSync(join(PACK_DIR, pack.EMBED_PACK_MANIFEST_FILE)) || !existsSync(cached)) {
  console.log('prove-embed-index-off-thread: SKIP (the embed pack or the default model is absent on this host — bun run scripts/vendor/build-embed.ts and scripts/vendor/fetch-embed-models.ts)')
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(0)
}
pack.seedEmbedPackDirForTest(PACK_DIR)
models.seedEmbedModelForTest(null)

const FACTS = 12
const sentence = (i: number): string => {
  const parts = [
    `Fact ${i}: before any release step that runs a repository command, read the branch tip once and compare it with the recorded fold tip, because a stale tip silently rebuilds the wrong tree.`,
    'Keep the proof commands prefixed with the checkout path, never the shell working directory, and verify the runtime symlink after a deploy by reading it back and printing the version.',
    'When a suite reads red under load, rerun the single failing proof alone once for the diagnosis; a green rerun names a clock defect in the proof, and the loaded failure stays on record as evidence.',
    'Never write settings in the home directory from a proof; a scratch configuration directory serves every run, and a daemon of the run never attaches to the installed one.',
  ]
  return parts.join(' ')
}
const writeLibrary = (dir: string, count: number): void => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const doc = docs.emptyDoc('ops', 'operating facts', '2026-10-13T09:00:00.000Z')
  doc.sections.push({ heading: 'notes', entries: Array.from({ length: count }, (_, i) => ({ text: sentence(i + 1), seq: i + 1, time: `2026-10-13T1${i % 10}:00:00.000Z`, source: 's:a' })) })
  writeFileSync(join(dir, 'topic-ops.md'), docs.serializeTopicDoc(doc))
}

console.log(`\n[U] the cost of one fact on this machine`)
const one = join(SCRATCH, 'one')
writeLibrary(one, 1)
const t0 = performance.now()
const first = await idx.ensureEmbedIndex(one)
const unitMs = performance.now() - t0
check('one owner-length fact embeds and the index is written', first.built && first.rows === 1, JSON.stringify(first))
console.log(`  one fact (model load included): ${unitMs.toFixed(0)} ms`)

console.log(`\n[T] a whole-library build does not hold the thread (${FACTS} facts)`)
{
  const dir = join(SCRATCH, 'many')
  writeLibrary(dir, FACTS)
  const ticks: number[] = []
  const timer = setInterval(() => ticks.push(performance.now()), 20)
  await new Promise(r => setTimeout(r, 60))
  const started = performance.now()
  const out = await idx.ensureEmbedIndex(dir)
  const took = performance.now() - started
  await new Promise(r => setTimeout(r, 60))
  clearInterval(timer)
  let maxGap = 0
  for (let i = 1; i < ticks.length; i++) maxGap = Math.max(maxGap, ticks[i]! - ticks[i - 1]!)
  check(`the ${FACTS}-fact build completes`, out.built && out.rows === FACTS, JSON.stringify(out))
  const bound = 3 * Math.max(unitMs, 50)
  check(`the longest pause of the event loop during the build stays under three facts' worth (${bound.toFixed(0)} ms)`, maxGap < bound, `longest pause ${maxGap.toFixed(0)} ms over a ${took.toFixed(0)} ms build — the build runs synchronously on the calling thread`)
}

pack.resetEmbedAddonForTest()
idx.resetEmbedIndexForTest()
finish()
