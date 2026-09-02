// ============================================================================
//  scripts/field-tasks/inspect-waypost.ts — the §5.7 browser-visual EVIDENCE
//  inspector for the WAYPOST family (WP1).
//
//  The WP1 grader froze before qualification (node --test over the pinned
//  suites); this inspector supplies the family's browser-side lane evidence
//  AFTER a run, driving the ACTUAL working tree a subject produced (a kept
//  workdir) in a real headless Chromium: mechanics, state, input journeys
//  and presentation probed against the fixture's deterministic seed —
//  never screenshot similarity alone. The close wave
//  adjudicates sufficiency; this tool never grades or regrades rows.
//
//  Determinism: the fixture's own static server (tools/serve.mjs, fixed
//  port), a fresh browser profile (clean localStorage), pinned viewport
//  1280×800@1, reduced-motion emulated, day clock TODAY=118 seeded in the
//  fixture. Browser resolution prefers the version-pinned managed
//  Chrome-for-Testing build; the resolved identity is recorded in the
//  receipt. On any failed check the page HTML + a screenshot are retained
//  beside the receipt (§5.7 trace retention).
//
//  Usage:
//    bun scripts/field-tasks/inspect-waypost.ts --workdir <kept WP1 work tree>
//      [--receipt <out.txt>] [--port 8613] [--screenshot <out.png>]
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { listManagedBrowsers, resolveBrowser, browserVersionOf } from '../../src/services/browser/browserResolver.js'

const args = process.argv.slice(2)
const get = (flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const workdir = get('--workdir')
if (!workdir || !existsSync(join(workdir, 'index.html'))) {
  console.error('usage: inspect-waypost.ts --workdir <waypost tree with index.html> [--receipt out.txt] [--port N]')
  process.exit(2)
}
const port = Number(get('--port') ?? 8613)
const receiptPath = resolve(get('--receipt') ?? join(import.meta.dirname, 'receipts', 'cr2-browser-inspection-wp1-2026-08-05.txt'))
const screenshotPath = resolve(get('--screenshot') ?? receiptPath.replace(/\.txt$/, '.png'))
mkdirSync(dirname(receiptPath), { recursive: true })

// ── browser resolution: managed pin first (deterministic build), law second ─
const managed = listManagedBrowsers()
const resolution = managed.length > 0
  ? { source: 'managed-cache', label: `Chrome for Testing ${managed[0]!.buildId}`, executablePath: managed[0]!.executablePath }
  : (() => {
      const law = resolveBrowser()
      if (law.state === 'unavailable') {
        console.error('no browser available: ' + law.note)
        process.exit(2)
      }
      return { source: law.source, label: law.label, executablePath: law.executablePath }
    })()

// ── the fixture's deterministic expectations (src/data.js, TODAY=118) ───────
const EXPECT_BASE: Record<string, string[]> = {
  waiting: ['w-1002', 'w-1007', 'w-1001'], // overdue w-1002 pinned; rest due-day→id
  moving: ['w-1004', 'w-1003', 'w-1008'],
  delivered: ['w-1005'],
  flagged: ['w-1006'],
}
const EXPECT_VISIBLE = Object.values(EXPECT_BASE).flat()
const EXPECT_OVERDUE = ['w-1002', 'w-1004', 'w-1006']

interface Check {
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'ok ' : 'FAIL'} ${name} — ${detail}`)
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── serve the fixture with its own tool; observed-ready, never a timer ──────
const server = spawn('node', [join(workdir, 'tools/serve.mjs')], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise<void>((resolveReady, reject) => {
  const bail = setTimeout(() => reject(new Error('serve.mjs never announced readiness')), 10_000)
  server.stdout.on('data', (chunk: Buffer) => {
    if (String(chunk).includes('http://localhost:')) {
      clearTimeout(bail)
      resolveReady()
    }
  })
  server.on('exit', code => reject(new Error('serve.mjs exited early: ' + code)))
})

const puppeteer = (await import('puppeteer-core')).default
const browser = await puppeteer.launch({
  executablePath: resolution.executablePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
})

let dialogMessages: string[] = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  page.on('dialog', dialog => {
    dialogMessages.push(dialog.message())
    void dialog.dismiss()
  })
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' })
  // Settled phase: the shell paints 'loading' then re-paints ready ~30ms in;
  // wait for CONTENT (cards present), never a fixed instant (§4.14).
  await page.waitForFunction(() => document.querySelectorAll('#board-root [data-cid]').length > 0, { timeout: 10_000 })

  const domState = async (): Promise<{ columns: Record<string, string[]>; counts: string[]; overdue: string[]; empties: number }> =>
    page.evaluate(() => {
      const sections = [...document.querySelectorAll('#board-root section')]
      const columns: Record<string, string[]> = {}
      const counts: string[] = []
      for (const section of sections) {
        // The subject names columns accessibly: aria-label="Waiting (3)".
        const label = (section.getAttribute('aria-label') ?? section.textContent ?? '').trim().toLowerCase()
        const status = ['waiting', 'moving', 'delivered', 'flagged'].find(s => label.includes(s)) ?? 'unknown'
        columns[status] = [...section.querySelectorAll('[data-cid]')].map(el => (el as HTMLElement).dataset.cid ?? '')
        const match = label.match(/\((\d+)\)/)
        counts.push(match ? match[1]! : '')
      }
      const overdue = [...document.querySelectorAll('[data-cid]')]
        .filter(el => el.querySelector('.chip-overdue'))
        .map(el => (el as HTMLElement).dataset.cid ?? '')
      const empties = document.querySelectorAll('#board-root .empty').length
      return { columns, counts, overdue, empties }
    })

  // 1 · shell + column structure + counts
  const shell = await page.evaluate(() => ({
    controls: ['search', 'status-pick', 'station-pick'].every(id => document.getElementById(id) !== null),
    lists: document.querySelectorAll('#board-root [role="list"]').length,
    cards: document.querySelectorAll('#board-root [data-cid]').length,
    listitems: document.querySelectorAll('#board-root [role="listitem"]').length,
  }))
  check('shell', shell.controls && shell.lists === 4 && shell.cards === 8 && shell.listitems === 8,
    `controls=${shell.controls} role=list×${shell.lists} cards=${shell.cards} listitems=${shell.listitems}`)

  // 2 · baseline order: the overdue-pinning law per column + the probe hook
  const base = await domState()
  check('baseline-order', eq(base.columns, EXPECT_BASE), JSON.stringify(base.columns))
  check('column-counts', eq(base.counts, ['3', '3', '1', '1']), `headers carry counts ${JSON.stringify(base.counts)}`)
  const visible = await page.evaluate(() => (window as unknown as { __waypost: { visible(): string[] } }).__waypost.visible())
  check('probe-visible', eq(visible, EXPECT_VISIBLE), `__waypost.visible → ${JSON.stringify(visible)}`)

  // 3 · escaping honesty: the seeded `<batch 4>` label renders as TEXT
  const escaping = await page.evaluate(() => {
    const card = document.querySelector('[data-cid="w-1002"]')
    if (!card) return { ok: false, why: 'w-1002 card missing' }
    const text = card.textContent ?? ''
    const html = card.innerHTML
    return {
      ok: text.includes('Peat samples <batch 4>') && html.includes('&lt;batch 4&gt;') && card.querySelector('batch') === null,
      why: 'text/html/element probes',
    }
  })
  check('escape-honesty', escaping.ok, `w-1002 "<batch 4>" stays text (${escaping.why})`)

  // 4 · overdue chips exactly on the past-due undelivered set
  check('overdue-chips', eq([...base.overdue].sort(), [...EXPECT_OVERDUE].sort()), JSON.stringify(base.overdue))

  // 5 · search journey (courier display name, case-insensitive)
  await page.type('#search', 'UNA')
  const searched = await domState()
  check('search-una', eq(Object.values(searched.columns).flat(), ['w-1007', 'w-1003', 'w-1008']),
    `visible after search "UNA" → ${JSON.stringify(Object.values(searched.columns).flat())}`)

  // 6 · Escape INSIDE the search box clears filters (the shell's one pass-through key)
  await page.keyboard.press('Escape')
  const cleared = await domState()
  check('escape-clears', Object.values(cleared.columns).flat().length === 8 &&
    (await page.$eval('#search', el => (el as HTMLInputElement).value)) === '',
    'filters reset, 8 cards back')

  // 7 · exact status filter + honest empty states elsewhere
  await page.select('#status-pick', 'waiting')
  const waiting = await domState()
  check('status-waiting', eq(waiting.columns['waiting'], EXPECT_BASE['waiting']) &&
    (waiting.columns['moving'] ?? []).length === 0 && waiting.empties >= 3,
    `waiting ${JSON.stringify(waiting.columns['waiting'])}, empty-state notes ${waiting.empties}`)
  await page.select('#status-pick', 'all')

  // 8 · exact station filter
  await page.select('#station-pick', 'st-fenn')
  const fenn = await domState()
  check('station-fenn', eq(Object.values(fenn.columns).flat(), ['w-1002', 'w-1008', 'w-1005']),
    `visible for st-fenn → ${JSON.stringify(Object.values(fenn.columns).flat())}`)
  await page.select('#station-pick', 'all')

  // 9 · keyboard journey: Home/arrows/End clamped, Enter opens, focus ring
  await page.click('h1') // keydown listens on window; leave the search box
  const focusedId = async (): Promise<string> =>
    page.evaluate(() => (document.querySelector('article.focused') as HTMLElement | null)?.dataset.cid ?? '')
  await page.keyboard.press('Home')
  check('key-home', (await focusedId()) === 'w-1002', `Home → ${await focusedId()}`)
  await page.keyboard.press('ArrowDown')
  check('key-arrow-down', (await focusedId()) === 'w-1007', `ArrowDown → ${await focusedId()}`)
  await page.keyboard.press('End')
  check('key-end', (await focusedId()) === 'w-1006', `End → ${await focusedId()}`)
  await page.keyboard.press('ArrowDown')
  check('key-clamp', (await focusedId()) === 'w-1006', `ArrowDown at End stays → ${await focusedId()}`)
  await page.keyboard.press('ArrowUp')
  check('key-arrow-up', (await focusedId()) === 'w-1005', `ArrowUp → ${await focusedId()}`)
  await page.keyboard.press('Enter')
  check('key-enter-opens', dialogMessages.length === 1 && dialogMessages[0] === 'w-1005 — Medical resupply · Ash Trelawny',
    `alert: ${JSON.stringify(dialogMessages)}`)

  // 10 · persistence: the filter survives a reload (store.js round-trip)
  await page.type('#search', 'flags')
  await page.waitForFunction(() => document.querySelectorAll('#board-root [data-cid]').length === 1, { timeout: 5_000 })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.querySelectorAll('#board-root [data-cid]').length > 0, { timeout: 10_000 })
  const persisted = await page.evaluate(() => ({
    search: (document.getElementById('search') as HTMLInputElement).value,
    cards: [...document.querySelectorAll('[data-cid]')].map(el => (el as HTMLElement).dataset.cid),
  }))
  // The store round-trip is the graded contract: the reloaded board applies
  // the persisted filter. (The GIVEN shell never rehydrates control VALUES —
  // the empty input box is a fixture-shell observation, recorded, not a
  // subject defect.)
  check('filter-persists', eq(persisted.cards, ['w-1004']),
    `after reload the board stays filtered to ${JSON.stringify(persisted.cards)}; input box shows ${JSON.stringify(persisted.search)} (given-shell rehydration gap, noted)`)

  // 11 · no-mutation law: the seed survives every journey untouched
  const seedOk = await page.evaluate(() => {
    const state = (window as unknown as { __waypost: { state(): { consignments: { id: string; status: string; dueDay: number }[] } } }).__waypost.state()
    const ids = state.consignments.map(c => `${c.id}:${c.status}:${c.dueDay}`).join(',')
    return {
      ids,
      ok: state.consignments.length === 8 &&
        ids === 'w-1001:waiting:121,w-1002:waiting:115,w-1003:moving:119,w-1004:moving:112,w-1005:delivered:110,w-1006:flagged:116,w-1007:waiting:118,w-1008:moving:125',
    }
  })
  check('no-mutation', seedOk.ok, 'consignment seed unchanged after all journeys')

  // Reset to the clean state for the settled screenshot, then capture.
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('#board-root [data-cid]').length === 8, { timeout: 5_000 })
  await page.screenshot({ path: screenshotPath as `${string}.png` })

  const failed = checks.filter(c => !c.pass)
  if (failed.length > 0) {
    // §5.7 trace retention: keep the DOM beside the receipt on failure.
    writeFileSync(receiptPath.replace(/\.txt$/, '.failure.html'), await page.content(), 'utf8')
  }
} finally {
  await browser.close().catch(() => {})
  server.kill()
}

const failed = checks.filter(c => !c.pass)
const receipt = [
  `=== crucible §5.7 browser-visual inspection — WAYPOST WP1, ${new Date().toISOString()} ===`,
  `workdir: ${resolve(workdir)}`,
  `browser: ${resolution.label} (${resolution.source}) — ${browserVersionOf(resolution.executablePath) ?? 'version probe unavailable'}`,
  `driver: puppeteer-core (bundled) · viewport 1280×800@1 · prefers-reduced-motion: reduce · fresh profile`,
  `server: the fixture's own tools/serve.mjs on :${port}`,
  ...checks.map(c => `${c.pass ? 'ok ' : 'FAIL'} ${c.name} — ${c.detail}`),
  `verdict: ${failed.length === 0 ? `ALL ${checks.length} CHECKS PASS` : `${failed.length}/${checks.length} FAILED`}`,
  `screenshot: ${screenshotPath}`,
  '',
].join('\n')
writeFileSync(receiptPath, receipt, 'utf8')
console.log(`receipt → ${receiptPath}`)
process.exit(failed.length === 0 ? 0 : 1)
