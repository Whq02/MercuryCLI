import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('memory-stale-centre')
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const React = await import('react')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { MemoryCentreView } = await import('../../src/components/memory/MemoryCentreView.tsx')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { emptyDoc, docFileName } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { writeDoc } = await import('../../src/mneme/mnemeLibrary.ts')
const { readUsage, pinFact } = await import('../../src/mneme/mnemeUsage.ts')
const dir = mnemeLibraryDir()
const date = new Date(Date.now() - 120 * 86400000).toISOString()
const doc = emptyDoc('checksums', 'backup checksums', date)
doc.sections = [{ heading: 'notes', entries: [
  { seq: 1, text: 'The backup uses the checksum catalog.', source: 'proof', time: date },
  { seq: 2, text: 'Always keep the checksum rule verbatim.', source: 'proof', time: date },
] }]
writeDoc(doc, dir)
pinFact(2, dir, new Date(), { asked: true })
const bytes = readFileSync(join(dir, docFileName(doc.slug)), 'utf8')
const h = React.createElement
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt >= 0 ? process.argv[framesAt + 1] : undefined
if (frames) mkdirSync(frames, { recursive: true })
const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(MemoryCentreView, { onClose: () => {}, width: 88, rowBudget: 30 }))), 100, 38)
try {
  assert(await waitFor(() => m.screen().includes('facts and decisions'), 6000))
  m.push(KEY.enter)
  assert(await waitFor(() => m.screen().includes('memory › facts'), 6000))
  assert(m.lines().some(line => line.includes('stale') && line.includes('The backup uses')), m.screen())
  assert(m.lines().some(line => line.includes('pinned') && line.includes('Always keep') && !line.includes('stale')), m.screen())
  assert.deepEqual(readUsage(dir), {})
  if (frames) writeFileSync(join(frames, 'stale-list.txt'), m.screen())
  m.push(KEY.down)
  m.push(KEY.enter)
  assert(await waitFor(() => readUsage(dir)['1']?.count === 1 && m.screen().includes('seq 1'), 6000), m.screen())
  assert(!m.screen().includes('not confirmed since'), m.screen())
  if (frames) writeFileSync(join(frames, 'opened-current.txt'), m.screen())
  m.push(KEY.esc)
  assert(await waitFor(() => m.screen().includes('memory › facts') && !m.lines().some(line => line.includes('stale') && line.includes('The backup uses')), 6000), m.screen())
  assert.equal(readUsage(dir)['1']?.count, 1)
  assert.equal(readFileSync(join(dir, docFileName(doc.slug)), 'utf8'), bytes)
  console.log('PASS memory lists stale facts, exempts pinned rules, confirms on open once and preserves the page')
} finally {
  m.unmount()
  await releaseScratchHome(home)
}
process.exit(0)
