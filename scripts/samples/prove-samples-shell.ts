#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-samples-shell-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_SAMPLES
delete process.env.MERCURY_BROWSER_MAX_SESSIONS

const ROOT = join(import.meta.dirname, '..', '..')

const { renderSampleShell } = await import('../../src/services/samples/shell.ts')
const { formatMarksMessage, parseMarksBody } = await import('../../src/services/samples/marks.ts')
const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
const { ensureBrowserSession, disposeBrowserOwner } = await import('../../src/services/browser/browserSession.ts')
const { makeOwnerKey, MAIN_LANE } = await import('../../src/services/run/ownerKey.ts')
type SampleRecord = import('../../src/services/samples/contracts.ts').SampleRecordV1

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
async function until(cond: () => Promise<boolean> | boolean, ms = 6000): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise(r => setTimeout(r, 50))
  }
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — samples shell proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const TOKEN = 'f'.repeat(32)
const ID = 'k7f2q1abcd'
const STAMP = '2026-01-01T00:00:00.000Z'
const pageOf = (word: string, tall: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${word}</title></head>` +
  `<body style="margin:0;padding:24px;font-family:sans-serif;background:#f6f5f1;color:#1c1b19">` +
  `<h1 id="price" class="head main">Pricing — ${word}</h1><p id="blurb">Three plans, billed monthly.</p>` +
  `${tall ? '<div style="height:3000px"></div><p id="bottom">the foot</p>' : ''}</body></html>`
const HTML: Record<number, string> = { 1: pageOf('one', false), 2: pageOf('two', true), 3: pageOf('three', false) }
const record = (latest: number, state: SampleRecord['state'] = 'open'): SampleRecord => ({
  id: ID,
  slug: 'pricing-table',
  title: 'Pricing table',
  sessionId: 'shell-session',
  createdAt: STAMP,
  updatedAt: STAMP,
  latestVersion: latest,
  state,
  glyph: '⧉',
  versions: Array.from({ length: latest }, (_, i) => ({ n: i + 1, createdAt: STAMP })),
})

section('H the document, statically')
const served = renderSampleShell({ record: record(2), versions: record(2).versions, token: TOKEN })
const inlineDoc = renderSampleShell({ record: record(2), versions: record(2).versions, token: null, inline: true, versionHtml: HTML })
check('H1 the served page stays under 40 KB', Buffer.byteLength(served, 'utf8') < 40 * 1024, `${Buffer.byteLength(served, 'utf8')} bytes`)
check('H2 nothing is fetched from the network: no http(s) address in either form', !/https?:\/\//.test(served) && !/https?:\/\//.test(inlineDoc))
check(
  'H3 the words on the page are Mercury\'s',
  ['Edit with Mercury', 'Send marks to Mercury', 'Approve', 'Changes needed', 'Code', 'Copy', 'Download', 'Sample'].every(w => served.includes(w)) && inlineDoc.includes('Copy for Mercury') && !inlineDoc.includes('Send marks to Mercury'),
)
const borrowed = new RegExp(['cl', 'aude', '|anth', 'ropic'].join(''), 'i')
check('H4 no borrowed product name', !borrowed.test(served) && !borrowed.test(inlineDoc))
check('H5 the newest version is the one selected and framed', served.includes('aria-pressed="true">v2<') && served.includes('aria-pressed="false">v1<') && served.includes(`src="/s/${ID}/v/2.html?t=${TOKEN}"`))
check('H6 the frame is sandboxed with scripts and its own origin, nothing more', (served.match(/sandbox="allow-scripts allow-same-origin"/g) ?? []).length === 2)
check('H7 the ground is painted before anything else and the page declares itself dark', served.startsWith('<!doctype html>\n<html lang="en" style="background:#050f12">') && served.includes('<meta name="color-scheme" content="dark">'))
check('H8 the inline form carries no token and every version escaped in a template', !inlineDoc.includes(TOKEN) && inlineDoc.includes('"token":null') && inlineDoc.includes('<template data-version="1">&lt;!doctype html&gt;') && !inlineDoc.includes('<h1 id="price"'))
check('H9 every version names itself for the switcher', served.includes('aria-label="version 1"') && served.includes('aria-label="version 2"'))
check('H10 the record\'s state is on the chip', renderSampleShell({ record: record(2, 'changes-needed'), versions: record(2).versions, token: TOKEN }).includes('class="chip warn" id="state">changes needed<'))

section('R the browser road')
const resolution = resolveBrowser()
if (resolution.state !== 'ok') {
  const { resolveExecutionProfile } = await import('../lib/executionProfile.ts')
  if (resolveExecutionProfile(ROOT).kind === 'hosted-gate') {
    console.log(`  [FAIL] the hosted gate has no drivable browser — ${resolution.note}`)
    process.exit(1)
  }
  if (failures > 0) {
    console.log(`\n❌ samples shell: ${failures} failure(s) before the browser road`)
    process.exit(1)
  }
  console.log(`__SUITE_SKIPPED samples-shell: ${resolution.note}`)
  console.log('  – no drivable browser on this machine — the document checks above passed; the driven checks are skipped by name')
  process.exit(0)
}
console.log(`  driving: ${resolution.source} — ${resolution.executablePath}`)

interface Fixture {
  latest: number
  failNext: number
  posts: string[]
  tokenless: string[]
  paths: string[]
}
const fixture: Fixture = { latest: 2, failNext: 0, posts: [], tokenless: [], paths: [] }
const listener = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  fixture.paths.push(url.pathname)
  const deny = (): void => {
    res.writeHead(404)
    res.end()
  }
  if (url.searchParams.get('t') !== TOKEN) {
    fixture.tokenless.push(url.pathname)
    return deny()
  }
  const version = /^\/s\/([a-z0-9]+)\/v\/(\d+)\.html$/.exec(url.pathname)
  if (req.method === 'GET' && url.pathname === `/s/${ID}`) {
    const rec = record(fixture.latest)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(renderSampleShell({ record: rec, versions: rec.versions, token: TOKEN }))
  }
  if (req.method === 'GET' && version !== null && HTML[Number(version[2])] !== undefined && Number(version[2]) <= fixture.latest) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(HTML[Number(version[2])])
  }
  if (req.method === 'GET' && url.pathname === `/s/${ID}/versions`) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ latestVersion: fixture.latest, versions: record(fixture.latest).versions }))
  }
  if (req.method === 'POST' && url.pathname === `/s/${ID}/marks`) {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (fixture.failNext > 0) {
        res.writeHead(fixture.failNext)
        fixture.failNext = 0
        return res.end()
      }
      fixture.posts.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, delivered: true, state: 'changes-needed', count: fixture.posts.length }))
    })
    return
  }
  deny()
})
const port = await new Promise<number>(resolve => {
  listener.listen(0, '127.0.0.1', () => resolve((listener.address() as { port: number }).port))
})
const shellUrl = `http://127.0.0.1:${port}/s/${ID}?t=${TOKEN}`

const workDir = mkdtempSync(join(tmpdir(), 'mercury-samples-shell-work-'))
const owner = makeOwnerKey({ workspace: workDir, sessionId: 'shell-session', lane: MAIN_LANE })
const session = await ensureBrowserSession(owner)
if (!('page' in session)) {
  console.log(`  [FAIL] no browser session: ${session.note}`)
  process.exit(1)
}
const page = session.page
await page.evaluateOnNewDocument(() => {
  const copied: string[] = []
  ;(window as unknown as { __copied: string[] }).__copied = copied
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { copied.push(text); return Promise.resolve() } },
    })
  } catch {
  }
})

const text = (selector: string): Promise<string> => page.$eval(selector, el => (el.textContent ?? '').trim()).catch(() => '')
const count = (selector: string): Promise<number> => page.$$eval(selector, els => els.length)
const attr = (selector: string, name: string): Promise<string | null> => page.$eval(selector, (el, n) => el.getAttribute(n as string), name).catch(() => null)
const visibleFrameSrc = (): Promise<string> =>
  page.evaluate(() => {
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('.frame')).filter(f => !f.hidden && f.classList.contains('ready') && getComputedStyle(f).opacity === '1')
    frames.sort((a, b) => Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0))
    return frames[0]?.getAttribute('src') ?? frames[0]?.getAttribute('srcdoc')?.slice(0, 80) ?? ''
  })
async function frameShowing(word: string) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue
    const heading = await frame.$eval('#price', el => el.textContent ?? '').catch(() => '')
    if (heading.endsWith(word)) return frame
  }
  return null
}
async function boxOf(frame: NonNullable<Awaited<ReturnType<typeof frameShowing>>>, selector: string): Promise<{ x: number; y: number }> {
  const handle = await frame.$(selector)
  const box = await handle!.boundingBox()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}
const layerRect = (): Promise<{ left: number; top: number; width: number; height: number }> =>
  page.$eval('#layer', el => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
const pinPositions = (): Promise<Array<{ left: number; top: number; label: string }>> =>
  page.$$eval('.pin', els => els.map(el => ({ left: parseFloat((el as HTMLElement).style.left), top: parseFloat((el as HTMLElement).style.top), label: el.getAttribute('aria-label') ?? '' })))

section('V1 the page opens on the newest version')
await page.goto(shellUrl, { waitUntil: 'load' })
check('V1a the title bar names the sample and the state', (await text('.title')) === 'Pricing table' && (await text('#state')) === 'open' && (await text('.eyebrow')) === '⧉ Sample')
check('V1b v2 is the selected pill', (await text('.pill.on')) === 'v2' && (await attr('.pill.on', 'aria-pressed')) === 'true')
check('V1c the frame shows version 2', await until(async () => (await visibleFrameSrc()).endsWith(`/v/2.html?t=${TOKEN}`)) && (await frameShowing('two')) !== null, await visibleFrameSrc())
check('V1d the send button reads "Send marks to Mercury" and marks are off', (await text('#send')) === 'Send marks to Mercury' && (await attr('#marks', 'aria-pressed')) === 'false')

section('V2 the switcher moves: keys and pills')
await page.keyboard.press('ArrowLeft')
check('V2a ← selects v1 and the frame follows, quietly', (await text('.pill.on')) === 'v1' && (await until(async () => (await visibleFrameSrc()).endsWith(`/v/1.html?t=${TOKEN}`))), await visibleFrameSrc())
check('V2b the old frame is put away once the new one is up', await until(() => page.$$eval('.frame', els => els.filter(f => !(f as HTMLElement).hidden).length === 1)))
await page.keyboard.press('ArrowLeft')
check('V2c ← at the first version stays', (await text('.pill.on')) === 'v1')
await page.click('.pill[data-version="2"]')
check('V2d a click on v2 brings it back', (await text('.pill.on')) === 'v2' && (await until(async () => (await visibleFrameSrc()).endsWith(`/v/2.html?t=${TOKEN}`))))

section('V3 marks: a click drops a pin that names the element under it')
await page.keyboard.press('m')
check('V3a m turns marks on: the button says so and the layer takes the pointer', (await text('#marks')) === 'Edit with Mercury · on' && (await attr('#marks', 'aria-pressed')) === 'true' && (await page.$eval('#layer', el => getComputedStyle(el).pointerEvents)) === 'auto')
const frame2 = (await frameShowing('two'))!
const heading = await boxOf(frame2, '#price')
await page.mouse.click(heading.x, heading.y)
check('V3b one pin lands and the comment box opens on it', (await count('.pin')) === 1 && (await count('.comment')) === 1)
check('V3c the box names the element under the click: tag, id, classes, its first words', (await text('.comment .who')) === 'pin 1 · h1#price.head.main "Pricing — two"', await text('.comment .who'))
const rect = await layerRect()
const pinsAfterClick = await pinPositions()
check('V3d the pin sits where the click landed', Math.abs(pinsAfterClick[0]!.left - (heading.x - rect.left)) < 2 && Math.abs(pinsAfterClick[0]!.top - (heading.y - rect.top)) < 2, JSON.stringify({ pinsAfterClick, heading, rect }))
await page.keyboard.type('make it larger')
await page.keyboard.press('Enter')
check('V3e Enter keeps the comment and closes the box', (await count('.comment')) === 0 && (await attr('.pin', 'aria-label')) === 'pin 1: make it larger')
const blurb = await boxOf(frame2, '#blurb')
await page.mouse.click(blurb.x, blurb.y)
check('V3f a second pin is numbered 2 and names the paragraph', (await count('.pin')) === 2 && (await text('.comment .who')) === 'pin 2 · p#blurb "Three plans, billed monthly."', await text('.comment .who'))
await page.keyboard.press('Escape')
check('V3g Esc on a fresh pin removes it', (await count('.pin')) === 1 && (await count('.comment')) === 0)
await page.mouse.click(blurb.x, blurb.y)
await page.keyboard.type('say it plainly')
await page.keyboard.press('Enter')
const before = await pinPositions()
await page.mouse.move(rect.left + before[1]!.left, rect.top + before[1]!.top)
await page.mouse.down()
await page.mouse.move(rect.left + before[1]!.left + 20, rect.top + before[1]!.top, { steps: 4 })
await page.mouse.move(rect.left + before[1]!.left + 40, rect.top + before[1]!.top, { steps: 4 })
await page.mouse.up()
const after = await pinPositions()
check('V3h a pin can be dragged: it moves with the pointer and stays numbered', after.length === 2 && Math.abs(after[1]!.left - (before[1]!.left + 40)) < 2 && Math.abs(after[1]!.top - before[1]!.top) < 2 && after[1]!.label === 'pin 2: say it plainly', JSON.stringify({ before, after }))
await page.mouse.click(rect.left + after[1]!.left, rect.top + after[1]!.top)
check('V3i a click on a kept pin reopens its comment with the text', (await count('.comment')) === 1 && (await page.$eval('.comment textarea', el => (el as HTMLTextAreaElement).value)) === 'say it plainly')
await page.keyboard.press('Escape')
check('V3j Esc on a kept pin closes the box and keeps the pin', (await count('.comment')) === 0 && (await count('.pin')) === 2)

section('V4 the page under the pins can still scroll, and the pins stay on their spots')
await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2)
await page.mouse.wheel({ deltaY: 300 })
const scrolled = await until(async () => (await frame2.evaluate(() => window.scrollY)) === 300)
const pinsScrolled = await pinPositions()
check('V4a the wheel over the marks layer scrolls the page inside the frame', scrolled, String(await frame2.evaluate(() => window.scrollY)))
check('V4b the pins move with the page', Math.abs(pinsScrolled[0]!.top - (after[0]!.top - 300)) < 2 && Math.abs(pinsScrolled[1]!.top - (after[1]!.top - 300)) < 2, JSON.stringify({ after, pinsScrolled }))
await page.mouse.wheel({ deltaY: -300 })
await until(async () => (await frame2.evaluate(() => window.scrollY)) === 0)

section('V5 Send posts the contract\'s marks and clears the page')
await page.click('#note')
await page.keyboard.type('keep the table, lose the gradient header')
await page.click('#changes')
check('V5a the verdict pill takes', (await attr('#changes', 'aria-pressed')) === 'true' && (await attr('#approve', 'aria-pressed')) === 'false')
await page.keyboard.press('s')
check('V5b one post reaches the listener', await until(() => fixture.posts.length === 1), String(fixture.posts.length))
const posted = JSON.parse(fixture.posts[0] ?? '{}') as { version: number; pins: Array<{ x: number; y: number; target: string; text: string }>; note: string; verdict: string | null }
const parsed = parseMarksBody(posted, 2)
check('V5c the body is SampleMarksV1 as the listener reads it', parsed !== null && parsed.version === 2 && parsed.pins.length === 2 && parsed.note === 'keep the table, lose the gradient header' && parsed.verdict === 'changes-needed', fixture.posts[0])
check(
  'V5d each pin carries its element and its words, with x and y as fractions of the page',
  posted.pins[0]!.target === 'h1#price.head.main "Pricing — two"' && posted.pins[0]!.text === 'make it larger' && posted.pins[1]!.target === 'p#blurb "Three plans, billed monthly."' && posted.pins[1]!.text === 'say it plainly' && posted.pins.every(p => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1),
  JSON.stringify(posted.pins),
)
const expectedMessage = [
  'Marks on Pricing table v2: 2 pins · 1 note · changes needed',
  '- at h1#price.head.main "Pricing — two": make it larger',
  '- at p#blurb "Three plans, billed monthly.": say it plainly',
  '',
  'keep the table, lose the gradient header',
].join('\n')
check('V5e the listener would speak this post as the contract\'s message', parsed !== null && formatMarksMessage({ title: 'Pricing table' }, parsed) === expectedMessage)
check('V5f the page says "sent" and clears the pins, the note and the verdict', (await until(async () => (await text('#status')) === 'sent')) && (await count('.pin')) === 0 && (await page.$eval('#note', el => (el as HTMLInputElement).value)) === '' && (await attr('#changes', 'aria-pressed')) === 'false')
check('V5g the state chip follows the verdict', (await text('#state')) === 'changes needed' && (await attr('#state', 'class')) === 'chip warn')
await page.keyboard.press('s')
check('V5h an empty send goes nowhere and says so', (await until(async () => (await text('#status')).startsWith('nothing to send yet'))) && fixture.posts.length === 1)

section('V6 a refused post shows the exact error and keeps the marks')
fixture.failNext = 500
await page.mouse.click(heading.x, heading.y)
await page.keyboard.type('try again')
await page.keyboard.press('Enter')
await page.keyboard.press('s')
check('V6a the status names the error', await until(async () => (await text('#status')) === 'not sent: HTTP 500'), await text('#status'))
check('V6b the pin stays for another try', (await count('.pin')) === 1 && fixture.posts.length === 1)

section('V7 a new version arrives while the tab is open')
fixture.latest = 3
check('V7a within the poll the switcher gains v3 and, the newest being selected, the frame moves to it', await until(async () => (await count('.pill')) === 3 && (await text('.pill.on')) === 'v3' && (await visibleFrameSrc()).endsWith(`/v/3.html?t=${TOKEN}`), 8000), `${await count('.pill')} pills · on=${await text('.pill.on')} · ${await visibleFrameSrc()}`)
check('V7b a new version opens the sample again', (await text('#state')) === 'open')
check('V7c the pins belong to their version: none on v3, the one on v2 still there', (await count('.pin')) === 0 && (await (async () => { await page.keyboard.press('ArrowLeft'); return until(async () => (await text('.pill.on')) === 'v2' && (await count('.pin')) === 1) })()))
await page.keyboard.press('ArrowRight')
await until(async () => (await text('.pill.on')) === 'v3')

section('V8 Code, the help strip and a narrow window')
await page.keyboard.press('c')
check('V8a c opens the code panel with the version\'s HTML, read-only', (await page.$eval('#codepanel', el => !(el as HTMLElement).hidden)) && (await until(async () => (await text('#codetext')) === HTML[3])) && (await text('#codename')).startsWith('pricing-table-v3.html'))
await page.keyboard.press('Escape')
check('V8b Esc closes it', await page.$eval('#codepanel', el => !!(el as HTMLElement).hidden))
await page.keyboard.press('?')
check('V8c ? hides the help strip and ? brings it back', (await page.$eval('#hint', el => (el as HTMLElement).hidden)) && (await (async () => { await page.keyboard.press('?'); return page.$eval('#hint', el => !(el as HTMLElement).hidden) })()))
check('V8d every control is a real button with a name', await page.$$eval('button', els => els.every(b => (b.textContent ?? '').trim() !== '' || (b.getAttribute('aria-label') ?? '') !== '')))
await page.setViewport({ width: 400, height: 700 })
const narrow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, stage: document.getElementById('stage')!.getBoundingClientRect().height }))
check('V8e at 400 px nothing overflows sideways and the frame keeps its space', narrow.scrollWidth <= 400 && narrow.stage > 150, JSON.stringify(narrow))
await page.setViewport({ width: 1280, height: 800 })
check('V8f every request the page made to the listener carried the token', fixture.paths.length > 0 && fixture.tokenless.every(p => !p.startsWith('/s/')), fixture.tokenless.join(','))

section('I the inline form: no listener, "Copy for Mercury" puts the contract\'s message on the clipboard')
const inlinePath = join(workDir, 'v2.page.html')
writeFileSync(inlinePath, inlineDoc, 'utf8')
const pathsBefore = fixture.paths.length
await page.goto(pathToFileURL(inlinePath).href, { waitUntil: 'load' })
check('I1 the page opens from a file on the newest version', (await text('.pill.on')) === 'v2' && (await until(async () => (await frameShowing('two')) !== null)) && (await text('#send')) === 'Copy for Mercury')
await page.keyboard.press('ArrowLeft')
check('I2 the switcher moves between the inlined versions', await until(async () => (await text('.pill.on')) === 'v1' && (await frameShowing('one')) !== null && (await visibleFrameSrc()).startsWith('<!doctype html>')))
await page.keyboard.press('ArrowRight')
await until(async () => (await text('.pill.on')) === 'v2' && (await visibleFrameSrc()).includes('two'))
await page.keyboard.press('m')
const inlineFrame = (await frameShowing('two'))!
const inlineHeading = await boxOf(inlineFrame, '#price')
await page.mouse.click(inlineHeading.x, inlineHeading.y)
const inlineWho = await text('.comment .who')
check('I3 a pin on the inlined page names its element through the frame', inlineWho === 'pin 1 · h1#price.head.main "Pricing — two"', inlineWho)
await page.keyboard.type('make it the highlighted plan')
await page.keyboard.press('Enter')
await page.click('#note')
await page.keyboard.type('looks right otherwise')
await page.click('#approve')
await page.keyboard.press('s')
const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
const inlineExpected = formatMarksMessage(
  { title: 'Pricing table' },
  parseMarksBody({ version: 2, pins: [{ x: 0.5, y: 0.5, target: 'h1#price.head.main "Pricing — two"', text: 'make it the highlighted plan' }], note: 'looks right otherwise', verdict: 'approve' }, 2)!,
)
check('I4 the clipboard holds the contract\'s message, byte for byte', copied.length === 1 && copied[0] === inlineExpected, JSON.stringify({ copied, inlineExpected }))
check('I5 the page says so, clears the marks and moves the chip', (await until(async () => (await text('#status')).startsWith('copied for Mercury'))) && (await count('.pin')) === 0 && (await text('#state')) === 'approved')
await new Promise(r => setTimeout(r, 2500))
check('I6 the inline page never polls', fixture.paths.length === pathsBefore)

section('P the poison — the predicates bite')
const olderSelected = renderSampleShell({ record: record(1), versions: record(2).versions, token: TOKEN })
check('P1 a shell whose latest is v1 does not pass the newest-selected pin', olderSelected.includes('aria-pressed="true">v1<') && !olderSelected.includes('aria-pressed="true">v2<'))
check('P2 the message comparator bites on one changed word', expectedMessage !== expectedMessage.replace('larger', 'smaller') && formatMarksMessage({ title: 'Pricing table' }, { ...parsed!, verdict: 'approve' }) !== expectedMessage)
check('P3 the target comparator bites on a pin that only says "the page"', formatMarksMessage({ title: 'Pricing table' }, { ...parsed!, pins: [{ ...parsed!.pins[0]!, target: 'the page' }, parsed!.pins[1]!] }) !== expectedMessage)
check('P4 the size pin bites on a page over the cap', !(Buffer.byteLength(served + 'x'.repeat(40 * 1024), 'utf8') < 40 * 1024))
check('P5 the token law of the fixture bites', await (async () => { const r = await fetch(`http://127.0.0.1:${port}/s/${ID}?t=${'0'.repeat(32)}`); return r.status === 404 })())

await disposeBrowserOwner(owner)
await new Promise<void>(resolve => listener.close(() => resolve()))

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ samples shell: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ samples shell: every law holds')
process.exit(0)
