import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'archive-search-page-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
  const { collectMemoryRefs } = await import('../../src/mneme/memoryRefs.ts')
  const { factPageLines, topicPage } = await import('../../src/components/memory/MemoryCentreView.tsx')
  const dir = mnemeLibraryDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'archive-work.md'), '---\nid: archive-work\nsummary: older work\n---\n## decisions\n- Archivefinder saved this decision <seq=81, time=2026-10-01T00:00:00.000Z, source=proof>\n')
  writeFileSync(join(dir, 'topic-work.md'), '---\nid: topic-work\nsummary: current work\n---\n## decisions\n- Different current fact <seq=82, time=2026-10-11T00:00:00.000Z, source=proof>\n')
  const ref = collectMemoryRefs('Archivefinder').find(ref => ref.refId === 'mneme:81')
  assert.ok(ref)
  assert.equal(ref.deref, 'Recall read:"doc:archive-work"')
  const lines = factPageLines(ref, 72)
  assert.ok(lines.some(line => line.seq === 81 && line.marked), 'the archived search result opens as a marked page')
  assert.ok(lines.some(line => line.text.includes('Archivefinder')))
  assert.ok(!lines.some(line => line.seq === 82), 'archive identity cannot resolve to the current topic of the same slug')
  assert.equal(topicPage('archive-work', 72).crumb, 'topics › archive-work')
  console.log('ARCHIVE SEARCH PAGE GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
