#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'memory-mesh-page-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.NODE_ENV = 'test'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_SAMPLES = '1'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
  if (!cond) failures++
}

const mesh = await import('../../src/mneme/mnemeMeshPage.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')
const usage = await import('../../src/mneme/mnemeUsage.js')
const ledger = await import('../../src/mneme/ledger.js')
const signal = await import('../../src/mneme/mnemeSignal.js')
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.js')
const { getSessionId } = await import('../../src/bootstrap/state.js')
const page = await import('../../src/commands/memory/memoryPage.js')
const store = await import('../../src/services/samples/store.js')
const { closeSampleListener } = await import('../../src/services/samples/listener.js')

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const key = mnemeProjectKey()
const ONE = 'mesh-session-one-0000-4000-8000-000000000001'
const current = String(getSessionId())
const at = (minute: number): string => `2026-10-13T09:${String(minute).padStart(2, '0')}:00.000Z`
const ops = docs.emptyDoc('ops', 'operating facts', at(0))
ops.sections.push({ heading: 'rules', entries: [
  { text: 'Every rollout names its owner before it starts.', seq: 1, time: at(1), source: `tool:Retain s:${ONE.slice(0, 8)}` },
  { text: 'The rollout window opens at nine once the smoke suite is green and the owner has said so in the channel.', seq: 2, time: at(2), source: `tool:Retain s:${ONE.slice(0, 8)}` },
  { text: 'The rollout notes live in the release folder.', seq: 4, time: at(5), source: 'tool:Retain s:elsewhere', supersedes: '3' },
  { text: 'An old note about <script>alert("x")</script> & the "quoted" gate.', seq: 6, time: at(6), source: 'tool:Retain s:elsewhere' },
] })
ops.history.push({ text: 'The rollout notes live in the wiki.', seq: 3, time: at(3), source: 'tool:Retain s:elsewhere', supersededBy: 4 })
const old = docs.emptyDoc('archive-like', 'old facts', '2024-01-01T00:00:00.000Z')
old.sections.push({ heading: 'old', entries: [{ text: 'The build server used to be the tower under the desk.', seq: 5, time: '2024-01-01T00:00:00.000Z', source: 'tool:Retain s:elsewhere' }] })
writeFileSync(join(dir, docs.docFileName('ops')), docs.serializeTopicDoc(ops))
writeFileSync(join(dir, docs.docFileName('archive-like')), docs.serializeTopicDoc(old))
usage.writePins([{ seq: 1, at: at(1) }], dir)
ledger.openEntry(key, { sessionId: ONE, model: 'engine-one' })
ledger.recordRuling(key, ONE, 'seq:1')
ledger.recordHandoff(key, ONE, 'The rollout owner rule is set; the window note follows it.')
ledger.closeEntry(key, ONE, { outcome: 'completed' })
ledger.openEntry(key, { sessionId: current, model: 'engine-two' })
appendObservation({ text: 'The freeze calendar lives beside the release notes.', source: `tool:Retain s:${current.slice(0, 8)}`, topicHint: 'ops' }, dir)
async function turn(body: () => Promise<void>): Promise<void> {
  for await (const _ of signal.memorySignalScope((async function* () { await body() })())) {}
}
for (let i = 0; i < 3; i++) {
  await turn(async () => {
    signal.noteMemoryOffered('rollout window', [{ id: 'seq:2' }, { id: 'seq:4' }], dir)
    if (i < 2) signal.noteMemoryOpened(['seq:2'], dir)
    await signal.finishMemorySignal(i === 0 ? 'The window opens at nine [seq:2].' : 'Nothing cited.')
  })
}

const sessions = ledger.readLedger(key)
const now = new Date('2026-10-14T08:00:00.000Z')
const digestTree = (root: string): string => {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else h.update(`${p}\n`).update(readFileSync(p))
    }
  }
  walk(root)
  return h.digest('hex')
}
const libraryBefore = digestTree(dir)

console.log('\n[N] the facts are nodes with their first words, their marks and their counts')
const model = mesh.memoryMesh(dir, { sessions, now })
const node = (id: string) => model.nodes.find(n => n.id === id)
{
  check('every live fact, the history row, the pending row and both sessions are nodes', ['seq:1', 'seq:2', 'seq:3', 'seq:4', 'seq:5', 'seq:6', 'ledger:1', 'ledger:2'].every(id => node(id) !== undefined) && model.nodes.some(n => n.kind === 'pending'), JSON.stringify(model.nodes.map(n => n.id)))
  check('a node carries the first eight words of its fact', node('seq:2')?.firstWords === 'The rollout window opens at nine once the …', node('seq:2')?.firstWords)
  check('a node carries the fact verbatim for its record', node('seq:6')?.text === 'An old note about <script>alert("x")</script> & the "quoted" gate.')
  check('the pinned rule is marked pinned (a ruling node)', node('seq:1')?.pinned === true && node('seq:1')?.kind === 'ruling')
  check('the superseded original is a history node', node('seq:3')?.kind === 'history')
  check('the long-unused fact is marked stale, a fresh one is not', node('seq:5')?.stale === true && node('seq:2')?.stale === false, JSON.stringify([node('seq:5')?.stale, node('seq:2')?.stale]))
  check('the offered · opened · cited counts come from the signal log', JSON.stringify(node('seq:2')?.counts) === JSON.stringify({ offered: 3, opened: 2, cited: 1 }), JSON.stringify(node('seq:2')?.counts))
  check('a fact offered and never opened says so', JSON.stringify(node('seq:4')?.counts) === JSON.stringify({ offered: 3, opened: 0, cited: 0 }), JSON.stringify(node('seq:4')?.counts))
}

console.log('\n[E] the links are edges: supersedes, ruling, session')
{
  const has = (from: string, to: string, kind: string): boolean => model.edges.some(e => e.from === from && e.to === to && e.kind === kind)
  const pendingId = model.nodes.find(n => n.kind === 'pending')!.id
  check('the replacement supersedes its original', has('seq:4', 'seq:3', 'supersedes'))
  check('the fact made after the pin in its session is made under that ruling', has('seq:2', 'seq:1', 'ruling'))
  check('a fact is linked to the session that made it', has('seq:2', 'ledger:1', 'session') && has('seq:1', 'ledger:1', 'session'))
  check('the pending row is linked to the current session', has(pendingId, 'ledger:2', 'session'))
  check('a fact from outside the ledger carries no session edge', !model.edges.some(e => e.from === 'seq:6' && e.kind === 'session'))
  check('every edge ends on a node of the page', model.edges.every(e => node(e.from) !== undefined && node(e.to) !== undefined))
}

console.log('\n[P] the page draws every node and edge, opens each record, and fetches nothing')
const html = mesh.renderMemoryMeshPage(model)
{
  check('every node is drawn as a link to its record', model.nodes.every(n => html.includes(`data-node="${n.id}"`) && html.includes(`href="#${mesh.meshAnchor(n.id)}"`) && html.includes(`id="${mesh.meshAnchor(n.id)}"`)))
  check('every edge is drawn with its kind', model.edges.every(e => html.includes(`data-edge="${e.from}|${e.to}|${e.kind}"`)))
  check('pins and stale marks are drawn', html.includes('data-node="seq:1" data-kind="ruling" data-pinned="true"') && html.includes('data-node="seq:5" data-kind="fact" data-pinned="false" data-stale="true"'))
  check('the counts are drawn on the node', html.includes('offered 3 · opened 2 · cited 1'))
  check('a record carries the fact word for word, escaped', html.includes('An old note about &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; the &quot;quoted&quot; gate.') && !html.includes('<script>alert'))
  check('a record names its links both ways', html.includes('supersedes <a href="#rec-seq-3">seq:3</a>') && html.includes('superseded by <a href="#rec-seq-4">seq:4</a>') && html.includes('governs <a href="#rec-seq-2">seq:2</a>'))
  check('no script, no remote address: the page fetches nothing', !/<script/i.test(html) && !/(src|href)="https?:/i.test(html) && !/@import|url\(http/i.test(html))
}

console.log('\n[S] /memory page keeps it through the Samples road, versioned, served on this machine')
{
  const opened: string[] = []
  const first = await page.openMemoryPage({ dir, sessionId: current, sessions, now, open: async url => { opened.push(url); return true } })
  const kept = first.kept
  check('the page is kept as a sample and opened', kept !== undefined && kept.version === 1 && opened.length === 1 && first.line.startsWith('Opened the memory page v1'), first.line)
  const record = kept ? store.getSample(current, kept.id) : null
  check('the sample lives under the session in the config home, never in the library', record !== null && existsSync(join(store.sampleDir(current, kept!.id), 'v1.html')) && !store.sampleDir(current, kept!.id).startsWith(dir), kept ? store.sampleDir(current, kept.id) : '')
  check('the kept version is the page as drawn', kept !== undefined && store.readVersion(current, kept.id, 1) === html)
  check('the address is the loopback listener with its token', kept !== undefined && /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]+\?t=[0-9a-f]+$/.test(kept.url), kept?.url)
  if (kept !== undefined && kept.url.startsWith('http://127.0.0.1:')) {
    const u = new URL(kept.url)
    const shell = await fetch(kept.url)
    const body = await fetch(`${u.origin}/s/${kept.id}/v/1.html?t=${u.searchParams.get('t')}`)
    check('the listener serves the sample shell', shell.status === 200 && (await shell.text()).includes(mesh.MESH_PAGE_TITLE))
    check('…and the version itself', body.status === 200 && (await body.text()) === html)
    const refused = await fetch(`${u.origin}/s/${kept.id}`)
    check('…and nothing without the token', refused.status === 404, String(refused.status))
  }
  const second = await page.openMemoryPage({ dir, sessionId: current, sessions, now, open: async () => true })
  check('opening it again keeps the next version of the same sample', second.kept?.id === kept?.id && second.kept?.version === 2, JSON.stringify(second.kept))
  check('the line names what the page holds', first.line.includes('4 facts') && first.line.includes('1 pinned rule') && first.line.includes('1 pending') && first.line.includes('1 in history') && first.line.includes('2 sessions'), first.line)
  process.env.MERCURY_SAMPLES = '0'
  const off = await page.openMemoryPage({ dir, sessionId: current, sessions, now, open: async () => true })
  check('with Samples off it says so in one line and keeps nothing', off.line === page.MEMORY_PAGE_OFF_SENTENCE && off.kept === undefined && store.getSample(current, kept!.id)?.latestVersion === 2, off.line)
  process.env.MERCURY_SAMPLES = '1'
  await closeSampleListener()
}

console.log('\n[W] nothing is written to the library by the page')
{
  check('the library folder is byte for byte what it was', digestTree(dir) === libraryBefore)
  check('the pinned rule is word for word in its page', readFileSync(join(dir, docs.docFileName('ops')), 'utf8').includes('Every rollout names its owner before it starts.'))
}

console.log('\n[R] /memory page is the road, and the docs say what it does')
{
  const command = readFileSync(join(ROOT, 'src/commands/memory/memory.tsx'), 'utf8')
  check('/memory page calls the page road', command.includes("trimmed === 'page'") && command.includes('openMemoryPage()'))
  const mneme = readFileSync(join(ROOT, 'docs/MNEME.md'), 'utf8')
  const samples = readFileSync(join(ROOT, 'docs/SAMPLES.md'), 'utf8')
  check('docs/MNEME.md names /memory page', mneme.includes('`/memory page`'))
  check('docs/SAMPLES.md names the memory page as a sample', samples.includes('`/memory page`'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures > 0 ? `\nprove-memory-mesh-page: RED (${failures})` : '\nprove-memory-mesh-page: green')
process.exit(failures > 0 ? 1 : 0)
