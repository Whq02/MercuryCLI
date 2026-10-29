#!/usr/bin/env bun
// gate-watch: src/utils/healthReport.ts src/mneme/embedModels.ts src/mneme/embedPack.ts
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'embedder-row-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const report = await import('../../src/utils/healthReport.js')
const { seedEmbedPackDirForTest, embedPackDirFor, EMBED_PACK_MANIFEST_FILE } = await import('../../src/mneme/embedPack.js')
const { seedEmbedModelForTest, memoryRecallModeWords, WORD_MATCH_ONLY_WORDS, embedDefaultModel } = await import('../../src/mneme/embedModels.js')
type Row = { id: string; label: string; status: string; evidence: string; link?: string }
const row = async (): Promise<{ section: string; row: Row } | null> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  for (const section of cert.sections) {
    const found = section.checks.find(c => c.id === 'memory-embedder')
    if (found) return { section: section.title, row: { id: found.id, label: found.label, status: String(found.status), evidence: String(found.evidence), ...(found.link ? { link: String(found.link) } : {}) } }
  }
  return null
}

console.log('§1 the row exists in MEMORY & CONTEXT and says what Recall will use (RED on the base: no row names the embedder)')
{
  const found = await row()
  check('the certificate carries a memory-embedder row', found !== null, 'absent')
  check('it sits in MEMORY & CONTEXT and is labelled Semantic embedder', found?.section === 'MEMORY & CONTEXT' && found.row.label === 'Semantic embedder', `${found?.section}: ${found?.row.label}`)
  const mode = memoryRecallModeWords()
  check(`the row agrees with the ranking Recall reports (${mode})`, found !== null && found.row.evidence.includes(`Recall ranks by ${mode}`), found?.row.evidence)
  check('present reads ok and names the model; degraded reads info and says word match only', found !== null && (found.row.status === 'ok' ? /^present: \S+ \(\d+ dimensions\)/.test(found.row.evidence) : found.row.status === 'info' && found.row.evidence.startsWith(`degraded: ${WORD_MATCH_ONLY_WORDS} (`)), `${found?.row.status}: ${found?.row.evidence}`)
}

console.log('\n§2 with no pack on the box the row is degraded: word match only, and says why')
{
  seedEmbedPackDirForTest(join(HOME, 'no-such-pack'))
  const found = await row()
  check('status info, never a fault: memory still answers by word match', found?.row.status === 'info', `${found?.row.status}`)
  check('the evidence leads with the degradation and ends with the ranking', found !== null && found.row.evidence.startsWith(`degraded: ${WORD_MATCH_ONLY_WORDS} (`) && found.row.evidence.endsWith(`Recall ranks by ${WORD_MATCH_ONLY_WORDS}`), found?.row.evidence)
  check('the reason is the pack resolver\'s own note', found !== null && found.row.evidence.includes('no-such-pack'), found?.row.evidence)
  check('the row links to /memory', found?.row.link === '/memory', found?.row.link)
  seedEmbedPackDirForTest(null)
}

const packDir = embedPackDirFor(ROOT, `${process.platform}-${process.arch}`)
const model = embedDefaultModel()
const missing = [join(packDir, EMBED_PACK_MANIFEST_FILE), join(ROOT, 'vendor', 'embed-models', model.file)].filter(path => !existsSync(path))
if (missing.length === 0) {
  console.log('\n§3 with the pack and the default model on the box the row is present and names the model')
  seedEmbedPackDirForTest(packDir)
  seedEmbedModelForTest(null, join(ROOT, 'vendor', 'embed-models'))
  const found = await row()
  check('status ok', found?.row.status === 'ok', `${found?.row.status}: ${found?.row.evidence}`)
  check(`the evidence names the model (${model.name}) and its dimensions`, found !== null && found.row.evidence.startsWith(`present: ${model.name} (${model.dimension} dimensions)`), found?.row.evidence)
  check('…and the semantic + word ranking Recall will use, in Recall\'s own words', found !== null && found.row.evidence.endsWith(`Recall ranks by semantic + word match (${model.name})`), found?.row.evidence)
  seedEmbedPackDirForTest(null)
  seedEmbedModelForTest(null)
} else {
  console.log(`\n§3 [SKIP] present embedder row: missing ${missing.join(', ')}`)
}

console.log('\n§4 with memory off the row is off and still states the pack fact')
{
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { enabled: false } }))
  resetSettingsCache()
  const found = await row()
  check('status off, naming the setting', found?.row.status === 'off' && found.row.evidence.includes('memory.enabled is false'), `${found?.row.status}: ${found?.row.evidence}`)
  check('the pack fact rides along (present: or degraded:)', found !== null && /the embedder pack is (present|degraded): /.test(found.row.evidence), found?.row.evidence)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? missing.length > 0 ? '\nprove-embedder-row: [SKIP] present-model checks; other checks passed' : '\nprove-embedder-row: green' : `\nprove-embedder-row: RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
