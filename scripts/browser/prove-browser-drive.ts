#!/usr/bin/env bun
// ============================================================================
//  scripts/browser/prove-browser-drive.ts — the Browser tool's DRIVING
//  surface proved against the REAL resolved headless engine over LOCAL
//  fixture pages (in-process http servers on 127.0.0.1 — three ports =
//  three real origins; no external network):
//
//    permission grammar   first visit asks by URL; approved origins ride;
//                         a crossing (link click, redirect) re-asks; reads
//                         never ask; close wipes the grants
//    click                changes page state (selector AND point forms)
//    type                 lands in inputs/textarea/contenteditable; refuses
//                         non-editable and credential-shaped targets by name
//    waitFor              resolves on the EVENT (well under the deadline),
//                         and a miss fails naming the bounded deadline
//    scroll               moves the viewport / brings a target into view
//    extract              text + accessibility-tree truth, honest truncation
//    console              the bounded ring captures logs and page errors
//    owner keying         sessions AND grants are per OwnerKey: two live
//                         owners stay isolated (grants never cross, pages
//                         never trample), an owner's teardown reaps ITS
//                         child, the children cap refuses honestly
//    reap                 close kills the child; a normal process exit
//                         WITHOUT close reaps it too (subprocess drill)
//
//  No browser on the box → named SKIP (the resolution law itself is pinned
//  hermetically by scripts/language-sidecars/prove-browser-resolution.ts).
// ============================================================================

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_BROWSER ??= '1'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { activeSession } = await import('../../src/services/browser/browserSession.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
// The single-owner road rides the SAME key the tool derives from a bare
// context (no agentId ⇒ the main lane) — behavior identical to the
// pre-rekey singleton; the two-owner sections mint agent-lane owners.
const OWNER = processOwnerForLane(null)
type ToolInput = Parameters<typeof BrowserTool.call>[0]

// ── §0 resolve, SKIP locally, RED under the hosted gate ─────────────────────
// A hosted shard with no browser is a BROKEN LANE, not an honoured gate: the
// pooled verdict cannot distinguish "all checks green" from "zero checks
// ran", so the skip that is honest on a developer box is a silent lie in CI.
// Locally the skip prints a machine-readable marker (the gate's skip-column
// road, mirroring __SUITE_TIMEOUT) so a future verdict layer can carry it.
{
  const r = resolveBrowser()
  if (r.state !== 'ok') {
    const { resolveExecutionProfile } = await import('../lib/executionProfile.ts')
    if (resolveExecutionProfile(ROOT).kind === 'hosted-gate') {
      console.error(`  [FAIL] hosted gate has no drivable browser — ${r.note}; provision the shard (op:"provision" / a cached managed build) rather than skipping the suite`)
      process.exit(1)
    }
    console.log(`__SUITE_SKIPPED browser: ${r.note}`)
    console.log(`  – no drivable browser on this machine — SKIP; the resolution law is pinned by scripts/language-sidecars/prove-browser-resolution.ts`)
    process.exit(0)
  }
  console.log(`  driving: ${r.source} — ${r.executablePath}`)
}

const ctx = {} as Parameters<typeof BrowserTool.call>[1]
async function run(input: ToolInput): Promise<{ result: string; outcome: string }> {
  const { data } = await BrowserTool.call(input, ctx)
  return { result: data.result, outcome: data.outcome }
}
async function perm(input: Partial<ToolInput>): Promise<{ behavior: string; message?: string }> {
  return (await BrowserTool.checkPermissions(input, ctx)) as { behavior: string; message?: string }
}
function page() {
  const s = activeSession(OWNER)
  if (!s) throw new Error('no live session where one was expected')
  return s.page
}
async function until(label: string, cond: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise(r => setTimeout(r, 50))
  }
}

// ── the fixture estate: three local origins ─────────────────────────────────
function fixtureA(portB: number): string {
  return `<!doctype html><title>drive-fixture-a</title><body>
<h1>Fixture Alpha</h1>
<p id="intro">The alpha fixture page for the drive proofs.</p>
<ul id="list"></ul>
<button id="grow" onclick="document.getElementById('list').appendChild(document.createElement('li'))">grow</button>
<input id="field" type="text">
<textarea id="area"></textarea>
<div id="note" contenteditable="true"></div>
<input id="pw" type="password">
<input id="mail" type="text" autocomplete="current-password">
<div id="plain" tabindex="0">not editable</div>
<button id="late-btn" onclick="setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'the late panel arrived'; document.body.appendChild(d) }, 150)">late</button>
<button id="nav-btn" onclick="setTimeout(() => { location.href = '/two' }, 150)">nav</button>
<button id="log-btn" onclick="console.log('log-btn clicked')">log</button>
<img src="/no-such-asset.png" alt="">
<button id="fetch-boom" onclick="fetch('/api/boom?token=SECRETVALUE')">boom fetch</button>
<button id="obj-btn" onclick="console.log('state', { user: 'ada', id: 7 })">obj</button>
<button id="boom-btn" onclick="(function(){ throw new Error('fixture boom') })()">boom</button>
<a id="cross" href="http://127.0.0.1:${portB}/">cross to beta</a>
<a id="sync-link" href="/two">two, synchronously</a>
<button id="pop-btn" onclick="window.open('http://127.0.0.1:${portB}/', '_blank')">pop</button>
<iframe id="frame" src="/framed" title="framed"></iframe>
<button id="spawn-btn" onclick="setTimeout(() => { const b = document.createElement('button'); b.id = 'spawned'; b.textContent = 'spawned'; b.onclick = () => document.getElementById('list').appendChild(document.createElement('li')); document.body.appendChild(b) }, 200)">spawn</button>
<button id="spawn-input-btn" onclick="setTimeout(() => { const i = document.createElement('input'); i.id = 'late-field'; document.body.appendChild(i) }, 200)">spawn input</button>
<button id="dead-btn" disabled>dead</button>
<div id="modal" style="display:none">modal body</div>
<button id="reveal-btn" onclick="setTimeout(() => { document.getElementById('modal').style.display = 'block' }, 150)">reveal</button>
<div id="spinner">spinning</div>
<button id="finish-btn" onclick="setTimeout(() => document.getElementById('spinner').remove(), 150)">finish</button>
<div id="status-line">status: pending</div>
<button id="flip-btn" onclick="setTimeout(() => { document.getElementById('status-line').firstChild.nodeValue = 'status: Ready' }, 150)">flip</button>
<button id="alert-btn" onclick="setTimeout(() => alert('fixture alert'), 50)">alert</button>
<button id="confirm-btn" onclick="setTimeout(() => { document.getElementById('confirm-result').textContent = confirm('Delete this record?') ? 'confirmed' : 'dismissed' }, 50)">confirm</button>
<div id="confirm-result"></div>
<button id="ghost-btn" style="display:none">ghost</button>
<div style="position:relative;width:120px"><button id="covered-btn">covered</button><div id="blanket" style="position:absolute;inset:0"></div></div>
<div id="wrap"><input id="wrapped"></div>
<select id="sel"><option value="a">Alpha</option><option value="b">Beta</option><option value="g">Gamma</option></select>
<div id="menu-wrap"><button id="menu-btn">menu</button><div id="menu" style="display:none">menu body</div></div>
<input id="esc-field" onkeydown="if (event.key === 'Escape') document.getElementById('esc-mark').textContent = 'escaped'">
<div id="esc-mark"></div>
<input id="ro" readonly value="frozen">
<input id="cb" type="checkbox">
<input id="fi" type="file">
<input id="otp" autocomplete="one-time-code">
<input id="cc" autocomplete="cc-number">
<input id="apikey" name="api_key">
<input id="trap" oninput="document.getElementById('pw').focus()">
<script>document.getElementById('menu-wrap').addEventListener('mouseenter', () => { document.getElementById('menu').style.display = 'block' })</script>
<div id="host"></div>
<div style="height: 3000px"></div>
<div id="bottom">the bottom marker</div>
<script>console.log('alpha loaded')</script>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input id="deep-input">'</script>
</body>`
}

function serve(routes: (url: string, res: http.ServerResponse) => void): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => routes(req.url ?? '/', res))
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server }))
  })
}

const html = (res: http.ServerResponse, body: string): void => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

const b = await serve((url, res) => {
  if (url === '/land') return html(res, '<title>beta-landing</title><body><p>redirect landed here</p></body>')
  return html(res, '<title>drive-fixture-b</title><body><p>the beta fixture page</p><input id="bfield"></body>')
})
const c = await serve((_url, res) => html(res, '<title>gamma-landing</title><body><p>the gamma page</p></body>'))
const a = await serve((url, res) => {
  if (url === '/two') return html(res, '<title>fixture-a-two</title><body><p>the second alpha page</p></body>')
  if (url === '/redir') {
    res.writeHead(302, { location: `http://127.0.0.1:${c.port}/land` })
    return res.end()
  }
  if (url === '/big') return html(res, `<title>fixture-a-big</title><body><p>${'lorem-volume '.repeat(3200)}</p></body>`)
  if (url === '/missing') {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    return res.end('<title>lost</title><body><p>no such page here</p></body>')
  }
  if (url === '/framed') return html(res, '<title>framed</title><body><button id="inner-btn">inner button</button></body>')
  if (url === '/download') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="payload.bin"' })
    return res.end('payload-bytes')
  }
  if (url.startsWith('/no-such')) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('gone')
  }
  if (url.startsWith('/api/boom')) {
    res.writeHead(500, { 'content-type': 'application/json' })
    return res.end('{"error":"fixture boom"}')
  }
  return html(res, fixtureA(b.port))
})
const A = `http://127.0.0.1:${a.port}`
const B = `http://127.0.0.1:${b.port}`
const C = `http://127.0.0.1:${c.port}`

// ── §1 permission grammar, cold ─────────────────────────────────────────────
console.log('§1 permission grammar (cold)')
{
  const ask = await perm({ op: 'open', url: `${A}/` })
  check('first visit to an origin ASKS', ask.behavior === 'ask', JSON.stringify(ask))
  check('the ask names the URL and the origin', (ask.message ?? '').includes(`${A}/`) && (ask.message ?? '').includes(A), ask.message ?? '')
  check('status never asks', (await perm({ op: 'status' })).behavior === 'allow')
  check('reads never ask (extract, no session)', (await perm({ op: 'extract' })).behavior === 'allow')
}

// ── §2 open rides the approved origin ───────────────────────────────────────
console.log('§2 open + the origin ride')
{
  const opened = await run({ op: 'open', url: `${A}/` })
  check('open succeeds with title + provenance', opened.outcome === 'succeeded' && opened.result.includes('drive-fixture-a'), opened.result)
  check('same-origin open now rides (allow)', (await perm({ op: 'open', url: `${A}/two` })).behavior === 'allow')
  check('acts on the approved origin ride (click allow)', (await perm({ op: 'click', selector: '#grow' })).behavior === 'allow')
}

// ── §3 click changes state ──────────────────────────────────────────────────
console.log('§3 click')
{
  const one = await run({ op: 'click', selector: '#grow' })
  const n1 = await page().$$eval('#list li', els => els.length)
  check('selector click changes page state', one.outcome === 'succeeded' && n1 === 1, `${one.result} · li=${n1}`)
  await run({ op: 'click', selector: '#grow' })
  const n2 = await page().$$eval('#list li', els => els.length)
  check('a second click lands too', n2 === 2, `li=${n2}`)
  const box = await (await page().$('#grow'))!.boundingBox()
  const point = await run({ op: 'click', x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })
  const n3 = await page().$$eval('#list li', els => els.length)
  check('point click (x,y) lands on the same button', point.outcome === 'succeeded' && n3 === 3, `${point.result} · li=${n3}`)
  const missing = await run({ op: 'click', selector: '#nope-no-such', timeoutMs: 600 })
  check('a missing selector fails naming it', missing.outcome === 'failed' && missing.result.includes('#nope-no-such'), missing.result)
}

// ── §3b acts auto-wait (the locator road: present AND visible, bounded) ─────
console.log('§3b act auto-wait + actionability')
{
  const before = await page().$$eval('#list li', els => els.length)
  await run({ op: 'click', selector: '#spawn-btn' })
  const late = await run({ op: 'click', selector: '#spawned' }) // injected ~200ms later — no waitFor between
  const n = await page().$$eval('#list li', els => els.length)
  check('a click on a late-injected target WAITS and lands', late.outcome === 'succeeded' && n === before + 1, `${late.result} · li=${n}`)
  await run({ op: 'click', selector: '#spawn-input-btn' })
  const typed = await run({ op: 'type', selector: '#late-field', text: 'late land' })
  const v = await page().$eval('#late-field', el => (el as HTMLInputElement).value)
  check('type auto-waits for a late-injected field', typed.outcome === 'succeeded' && v === 'late land', typed.result)
  const ghost = await run({ op: 'click', selector: '#ghost-btn', timeoutMs: 600 })
  check('a present-but-hidden target refuses naming deadline + visibility', ghost.outcome === 'failed' && ghost.result.includes('600ms') && ghost.result.includes('visible'), ghost.result)
  const missing = await run({ op: 'click', selector: '#never-here', timeoutMs: 600 })
  check('an absent target refuses naming the deadline', missing.outcome === 'failed' && missing.result.includes('600ms'), missing.result)
  const dead = await run({ op: 'click', selector: '#dead-btn' })
  check('a disabled target refuses by name (no silent success)', dead.outcome === 'failed' && dead.result.includes('disabled'), dead.result)
  const covered = await run({ op: 'click', selector: '#covered-btn' })
  check('a covered target names its occluder', covered.outcome === 'failed' && covered.result.includes('#blanket'), covered.result)
  const shadow = await run({ op: 'type', selector: '#host >>> input', text: 'deep' })
  const dv = await page().evaluate(() => (document.getElementById('host')!.shadowRoot!.getElementById('deep-input') as HTMLInputElement).value)
  check('type lands inside a shadow root (deep active-element resolve)', shadow.outcome === 'succeeded' && dv === 'deep', `${shadow.result} · value=${dv}`)
  await run({ op: 'type', selector: '#field', text: 'seed' }) // park focus on a real field
  const wrong = await run({ op: 'type', selector: '#wrap', text: 'x' })
  check('a wrapper that cannot take focus refuses naming the holder', wrong.outcome === 'failed' && wrong.result.includes('focus did not land'), wrong.result)
  await run({ op: 'type', selector: '#area', text: 'line one\nline two' })
  await run({ op: 'type', selector: '#area', text: 'fresh', clear: true })
  const area = await page().$eval('#area', el => (el as HTMLTextAreaElement).value)
  check('clear empties a MULTI-LINE textarea whole (select-all, not a line)', area === 'fresh', `value=${JSON.stringify(area)}`)
  await run({ op: 'reload' }) // reset fixture state for §4
}

// ── §4 type lands where it should ───────────────────────────────────────────
console.log('§4 type')
{
  const typed = await run({ op: 'type', selector: '#field', text: 'hermes drive' })
  const value = await page().$eval('#field', el => (el as HTMLInputElement).value)
  check('type lands in the input', typed.outcome === 'succeeded' && value === 'hermes drive', `${typed.result} · value=${value}`)
  check('the result carries honest provenance (chars + target + url)', typed.result.includes('12 chars') && typed.result.includes('input#field') && typed.result.includes(A), typed.result)
  await run({ op: 'type', selector: '#field', text: 'fresh', clear: true })
  const cleared = await page().$eval('#field', el => (el as HTMLInputElement).value)
  check('clear replaces instead of appending', cleared === 'fresh', `value=${cleared}`)
  const focused = await run({ op: 'type', text: '-tail' })
  const tail = await page().$eval('#field', el => (el as HTMLInputElement).value)
  check('selector-less type hits the FOCUSED element', focused.outcome === 'succeeded' && tail === 'fresh-tail', `value=${tail}`)
  await run({ op: 'type', selector: '#area', text: 'textarea line' })
  check('textarea accepts text', (await page().$eval('#area', el => (el as HTMLTextAreaElement).value)) === 'textarea line')
  await run({ op: 'type', selector: '#note', text: 'note text' })
  check('contenteditable accepts text', (await page().$eval('#note', el => (el as HTMLElement).innerText)).includes('note text'))
  const refuse = await run({ op: 'type', selector: '#plain', text: 'x' })
  check('a non-editable target refuses by name', refuse.outcome === 'failed' && refuse.result.includes('not an editable field'), refuse.result)
  const enter = await run({ op: 'type', selector: '#field', text: 'z', enter: true })
  check('enter is named in the provenance', enter.outcome === 'succeeded' && enter.result.includes('+ Enter'), enter.result)
}

// ── §5 credential-shaped targets refuse ─────────────────────────────────────
console.log('§5 credential refusal')
{
  const pw = await run({ op: 'type', selector: '#pw', text: 'secret!' })
  const pwValue = await page().$eval('#pw', el => (el as HTMLInputElement).value)
  check('input[type=password] refuses by name, nothing typed', pw.outcome === 'failed' && pw.result.includes('credential field') && pwValue === '', `${pw.result} · value="${pwValue}"`)
  const mail = await run({ op: 'type', selector: '#mail', text: 'secret!' })
  const mailValue = await page().$eval('#mail', el => (el as HTMLInputElement).value)
  check('autocomplete=current-password refuses too', mail.outcome === 'failed' && mail.result.includes('credential field') && mailValue === '', mail.result)
}

// ── §4b the grown act surface + the input zoo ───────────────────────────────
console.log('§4b select / press / hover + the input zoo')
{
  await run({ op: 'open', url: `${A}/` })
  const chosen = await run({ op: 'select', selector: '#sel', values: ['b'] })
  const selVal = await page().$eval('#sel', el => (el as HTMLSelectElement).value)
  check('select picks by value and reports the choice', chosen.outcome === 'succeeded' && selVal === 'b' && chosen.result.includes('Beta'), `${chosen.result} · value=${selVal}`)
  const byLabel = await run({ op: 'select', selector: '#sel', values: ['Gamma'] })
  const selVal2 = await page().$eval('#sel', el => (el as HTMLSelectElement).value)
  check('select falls back to the visible label and says so', byLabel.outcome === 'succeeded' && selVal2 === 'g' && byLabel.result.includes('visible label'), `${byLabel.result} · value=${selVal2}`)
  const noSel = await run({ op: 'select', selector: '#field', values: ['x'] })
  check('select on a non-select refuses by name', noSel.outcome === 'failed' && noSel.result.includes('<select>'), noSel.result)
  const hov = await run({ op: 'hover', selector: '#menu-btn' })
  const menuShown = await until('menu opens on hover', () => page().$eval('#menu', el => getComputedStyle(el).display !== 'none'))
  check('hover opens a hover-only menu', hov.outcome === 'succeeded' && menuShown, hov.result)
  await run({ op: 'type', selector: '#esc-field', text: 'x' })
  const esc = await run({ op: 'press', key: 'Escape' })
  const escMark = await page().$eval('#esc-mark', el => el.textContent)
  check('press Escape reaches the page', esc.outcome === 'succeeded' && escMark === 'escaped', `${esc.result} · mark=${escMark}`)
  const badKey = await run({ op: 'press', key: 'a' })
  check('press refuses printable keys by allowlist (never a typing side door)', badKey.outcome === 'failed' && badKey.result.includes('allowlist'), badKey.result)
  const ro = await run({ op: 'type', selector: '#ro', text: 'thaw' })
  const roVal = await page().$eval('#ro', el => (el as HTMLInputElement).value)
  check('a readOnly input refuses by name, value untouched', ro.outcome === 'failed' && ro.result.includes('readOnly') && roVal === 'frozen', ro.result)
  const cb = await run({ op: 'type', selector: '#cb', text: 'yes' })
  check('a checkbox refuses type and names op:click', cb.outcome === 'failed' && cb.result.includes('op:"click"'), cb.result)
  const fi = await run({ op: 'type', selector: '#fi', text: '/tmp/x' })
  check('a file input refuses naming the uploads deferral', fi.outcome === 'failed' && fi.result.includes('deferral'), fi.result)
}

// ── §5b the credential zoo (widened detector + the mid-act trap) ────────────
console.log('§5b credential zoo')
{
  const otp = await run({ op: 'type', selector: '#otp', text: '123456' })
  check('autocomplete=one-time-code refuses (2FA codes are credentials)', otp.outcome === 'failed' && otp.result.includes('credential field') && otp.result.includes('one-time-code'), otp.result)
  const cc = await run({ op: 'type', selector: '#cc', text: '4111' })
  check('cc-number refuses by name', cc.outcome === 'failed' && cc.result.includes('credential field'), cc.result)
  const api = await run({ op: 'type', selector: '#apikey', text: 'sk-live' })
  check('a name/label credential shape refuses naming the matched token', api.outcome === 'failed' && api.result.includes('api_key'), api.result)
  await page().$eval('#trap', el => { (el as HTMLInputElement).value = 'x' })
  const trap = await run({ op: 'type', selector: '#trap', text: 'abc', clear: true })
  const pwVal = await page().$eval('#pw', el => (el as HTMLInputElement).value)
  check('a focus trap firing on clear is caught by the pre-keystroke re-probe (nothing typed into the credential field)', trap.outcome === 'failed' && trap.result.includes('credential') && pwVal === '', `${trap.result} · pw="${pwVal}"`)
}

// ── §6 waitFor is event-driven, deadline-honest ─────────────────────────────
console.log('§6 waitFor')
{
  await run({ op: 'click', selector: '#late-btn' })
  let t0 = Date.now()
  const late = await run({ op: 'waitFor', selector: '#late', timeoutMs: 6000 })
  let dt = Date.now() - t0
  check('selector wait resolves on the EVENT, well under the deadline', late.outcome === 'succeeded' && dt < 3000, `${late.result} · ${dt}ms`)
  await run({ op: 'reload' })
  await run({ op: 'click', selector: '#late-btn' })
  t0 = Date.now()
  const text = await run({ op: 'waitFor', text: 'the late panel arrived', timeoutMs: 6000 })
  dt = Date.now() - t0
  check('text wait resolves on the mutation, not the clock', text.outcome === 'succeeded' && dt < 3000, `${text.result} · ${dt}ms`)
  await run({ op: 'click', selector: '#nav-btn' })
  const nav = await run({ op: 'waitFor', timeoutMs: 8000 })
  check('navigation wait lands the scheduled navigation', nav.outcome === 'succeeded' && nav.result.includes('/two'), nav.result)
  const backed = await run({ op: 'back' })
  check('back returns to the alpha page (bfcache restore counts)', backed.outcome === 'succeeded' && (await page().title()) === 'drive-fixture-a', backed.result)
  const toBlank = await run({ op: 'back' }) // entry 0 is the launch about:blank
  const atStart = await run({ op: 'back' })
  check('back at the history start says so honestly', atStart.outcome === 'no-change' && atStart.result.includes('no earlier history entry'), `${toBlank.result} · ${atStart.result}`)
  await run({ op: 'open', url: `${A}/` })
  t0 = Date.now()
  const miss = await run({ op: 'waitFor', selector: '#never-appears', timeoutMs: 600 })
  dt = Date.now() - t0
  check('a miss fails naming the bounded deadline', miss.outcome === 'failed' && miss.result.includes('deadline 600ms exceeded') && dt >= 500 && dt < 3000, `${miss.result} · ${dt}ms`)
}

// ── §6b waitFor visibility states ───────────────────────────────────────────
console.log('§6b waitFor visibility states')
{
  const present = await run({ op: 'waitFor', selector: '#modal', timeoutMs: 600 })
  check('a pre-rendered HIDDEN modal no longer reads as present (visible default)', present.outcome === 'failed' && present.result.includes('deadline 600ms exceeded'), present.result)
  const attached = await run({ op: 'waitFor', selector: '#modal', state: 'attached', timeoutMs: 4000 })
  check('state:"attached" is the explicit presence-only escape', attached.outcome === 'succeeded', attached.result)
  await run({ op: 'click', selector: '#reveal-btn' })
  const revealed = await run({ op: 'waitFor', selector: '#modal', timeoutMs: 6000 })
  check('the reveal resolves the visible wait on the event', revealed.outcome === 'succeeded' && revealed.result.includes('visible'), revealed.result)
  await run({ op: 'click', selector: '#finish-btn' })
  const gone = await run({ op: 'waitFor', selector: '#spinner', state: 'hidden', timeoutMs: 6000 })
  check('state:"hidden" expresses the spinner-gone wait', gone.outcome === 'succeeded', gone.result)
  await run({ op: 'click', selector: '#flip-btn' })
  const flipped = await run({ op: 'waitFor', text: 'status: ready', timeoutMs: 6000 })
  check('a characterData-only text flip wakes the wait (RAF polling), case-insensitive', flipped.outcome === 'succeeded', flipped.result)
}

// ── §6c navigation truth: the sync-nav race is dead; HTTP status is named ───
console.log('§6c navigation truth')
{
  await run({ op: 'open', url: `${A}/` })
  await run({ op: 'click', selector: '#sync-link' }) // navigates INSIDE the click
  const t0 = Date.now()
  const nav = await run({ op: 'waitFor', timeoutMs: 8000 })
  const dt = Date.now() - t0
  check(
    'waitFor(navigation) after a SYNCHRONOUS link click observes the landed truth fast (no burned deadline)',
    nav.outcome === 'succeeded' && nav.result.includes('/two') && dt < 2000,
    `${nav.result} · ${dt}ms`,
  )
  const nf = await run({ op: 'open', url: `${A}/missing` })
  check('a 404 open NAMES the status in its FIRST line', (nf.result.split('\n')[0] ?? '').includes('HTTP 404'), nf.result)
  const ok = await run({ op: 'open', url: `${A}/` })
  check('a healthy open carries the status and the page census', ok.result.includes('[200]') && ok.result.includes('chars of body text'), ok.result.split('\n').slice(0, 2).join(' | '))
  const interrupter = new AbortController()
  setTimeout(() => interrupter.abort(), 150)
  const t1 = Date.now()
  const cut = await BrowserTool.call(
    { op: 'waitFor', selector: '#never-appears', timeoutMs: 20_000 } as ToolInput,
    { abortController: interrupter } as Parameters<typeof BrowserTool.call>[1],
  )
  const cutDt = Date.now() - t1
  check(
    'an operator interrupt releases a long wait by name (cancellation is real, not declared)',
    cut.data.outcome === 'failed' && cut.data.result.includes('interrupted') && cutDt < 5000,
    `${cut.data.result} · ${cutDt}ms`,
  )
}

// ── §7 scroll ───────────────────────────────────────────────────────────────
console.log('§7 scroll')
{
  const by = await run({ op: 'scroll', dy: 600 })
  const y1 = await page().evaluate(() => window.scrollY)
  check('scroll by dy moves the viewport', by.outcome === 'succeeded' && y1 >= 400, `${by.result} · scrollY=${y1}`)
  const into = await run({ op: 'scroll', selector: '#bottom' })
  const y2 = await page().evaluate(() => window.scrollY)
  check('scroll to selector brings the target into view', into.outcome === 'succeeded' && y2 > y1, `${into.result} · scrollY=${y2}`)
}

// ── §7b viewport + screenshot budget + the extract pager ────────────────────
console.log('§7b viewport / screenshot / extract pager')
{
  await run({ op: 'open', url: `${A}/` })
  const vp = page().viewport()
  const iw = await page().evaluate(() => window.innerWidth)
  check('the session launches at the NAMED desktop viewport, not the driver default', vp?.width === 1280 && vp?.height === 800 && iw === 1280, `viewport=${vp?.width}x${vp?.height} innerWidth=${iw}`)
  const resized = await run({ op: 'viewport', width: 900, height: 600 })
  check('the viewport op resizes and reports', resized.outcome === 'succeeded' && resized.result.includes('900x600'), resized.result)
  const shot = await run({ op: 'screenshot', label: 'vp' })
  const pngPath = /screenshot: (\S+\.png)/.exec(shot.result)?.[1]
  const buf = readFileSync(pngPath!)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  check('a screenshot reflects the resized viewport in its pixels', w === 900 && h === 600, `${w}x${h}`)
  const elShot = await run({ op: 'screenshot', selector: '#grow', label: 'el' })
  const elPath = /screenshot: (\S+\.png)/.exec(elShot.result)?.[1]
  const ebuf = readFileSync(elPath!)
  const ew = ebuf.readUInt32BE(16)
  const eh = ebuf.readUInt32BE(20)
  check('an element screenshot clips to the element', elShot.outcome === 'succeeded' && elShot.result.includes('#grow') && ew < 300 && eh < 100, `${ew}x${eh}`)
  await run({ op: 'viewport', width: 1280, height: 800 })
  await run({ op: 'open', url: `${A}/big` })
  const tail = await run({ op: 'extract', offset: 15000 })
  check('extract offset pages BEYOND the cap (the tail is reachable)', tail.result.includes('chars 15000-') && tail.result.includes('lorem-volume'), tail.result.slice(0, 140))
  await run({ op: 'open', url: `${A}/` })
}

// ── §8 extract truth + honest truncation ────────────────────────────────────
console.log('§8 extract')
{
  const text = await run({ op: 'extract' })
  check('text extract returns the page truth', text.result.includes('The alpha fixture page') && text.result.includes('chars'), text.result.slice(0, 200))
  const scoped = await run({ op: 'extract', selector: '#intro' })
  check('selector scopes the extract', scoped.result.includes('The alpha fixture page') && !scoped.result.includes('Fixture Alpha'), scoped.result.slice(0, 200))
  const tree = await run({ op: 'extract', mode: 'tree' })
  check('tree extract projects roles and names', tree.result.includes('button') && tree.result.includes('"grow"'), tree.result.slice(0, 300))
  await run({ op: 'open', url: `${A}/big` })
  const big = await run({ op: 'extract' })
  check('oversize truncates HONESTLY naming the window and full length', big.result.includes('TRUNCATED to 15000') && /chars 0-15000 of \d{5,}/.test(big.result), big.result.slice(0, 160))
  await run({ op: 'open', url: `${A}/` })
}

// ── §9 console ring ─────────────────────────────────────────────────────────
console.log('§9 console')
{
  const ok = await until('alpha loaded captured', async () => (await run({ op: 'console' })).result.includes('alpha loaded'))
  check('page console.log lands in the ring', ok)
  await run({ op: 'click', selector: '#log-btn' })
  const clicked = await until('click log captured', async () => (await run({ op: 'console' })).result.includes('log-btn clicked'))
  check('a click-driven log is captured', clicked)
  await run({ op: 'click', selector: '#boom-btn' })
  const boomed = await until('pageerror captured', async () => {
    const r = (await run({ op: 'console' })).result
    return r.includes('pageerror') && r.includes('fixture boom')
  })
  check('page errors join the ring as pageerror', boomed)
  const two = await run({ op: 'console', limit: 2 })
  const lines = two.result.split('\n')
  check('limit bounds the slice and the header says so', /console: last 2 of \d+/.test(lines[0] ?? '') && lines.length === 3, two.result)
}

// ── §9b the selector grammar round-trip (aria / text / xpath / >>> pierce) ──
console.log('§9b selector grammar')
{
  await run({ op: 'open', url: `${A}/` })
  const before = await page().$$eval('#list li', els => els.length)
  const tree = await run({ op: 'extract', mode: 'tree' })
  const row = tree.result.split('\n').find(l => l.includes('button "grow"'))
  check('the tree row carries the ready aria token', !!row && row.includes('→ aria/grow[role="button"]'), row ?? '(row missing)')
  const token = /→ (aria\/grow\[role="button"\])/.exec(row ?? '')?.[1]
  const viaAria = await run({ op: 'click', selector: token ?? 'aria/grow[role="button"]' })
  const n1 = await page().$$eval('#list li', els => els.length)
  check('clicking the tree-derived aria selector LANDS', viaAria.outcome === 'succeeded' && n1 === before + 1, `${viaAria.result} · li=${n1}`)
  const viaText = await run({ op: 'click', selector: 'text/grow' })
  const n2 = await page().$$eval('#list li', els => els.length)
  check('text/<substring> resolves and clicks', viaText.outcome === 'succeeded' && n2 === before + 2, viaText.result)
  const viaXpath = await run({ op: 'click', selector: "xpath///button[@id='grow']" })
  const n3 = await page().$$eval('#list li', els => els.length)
  check('xpath/<expr> resolves and clicks', viaXpath.outcome === 'succeeded' && n3 === before + 3, viaXpath.result)
  const pierce = await run({ op: 'waitFor', selector: '#host >>> input', timeoutMs: 4000 })
  check('the >>> deep combinator pierces the shadow root', pierce.outcome === 'succeeded', pierce.result)
}

// ── §9d the network ring + console fidelity ─────────────────────────────────
console.log('§9d network ring + console fidelity')
{
  await run({ op: 'open', url: `${A}/` })
  const missingAsset = await until('404 asset in ring', async () => (await run({ op: 'console' })).result.includes('/no-such-asset.png 404'))
  check('a 404 subresource lands in the ring as kind net', missingAsset)
  await run({ op: 'click', selector: '#fetch-boom' })
  const boom = await until('500 fetch in ring', async () => {
    const r = (await run({ op: 'console' })).result
    return r.includes('/api/boom') && r.includes('500')
  })
  check('a 500 API response is visible (method + path + status)', boom)
  const ringNow = (await run({ op: 'console' })).result
  check('query strings never enter the ring (token redacted)', !ringNow.includes('SECRETVALUE'), ringNow.split('\n').filter(l => l.includes('boom')).join(' | '))
  await run({ op: 'click', selector: '#obj-btn' })
  const obj = await until('object log resolves', async () => (await run({ op: 'console' })).result.includes('"user":"ada"'))
  check('object console args resolve to JSON, not an opaque handle', obj)
  await run({ op: 'click', selector: '#boom-btn' })
  const stack = await until('pageerror stack head', async () => {
    const r = (await run({ op: 'console' })).result
    return r.includes('fixture boom') && r.includes('at ')
  })
  check('a pageerror carries its stack head (the line that names the broken file)', stack)
}

// ── §9e popups are NAMED and frames are visible ─────────────────────────────
console.log('§9e popups + frames')
{
  await run({ op: 'open', url: `${A}/` })
  await run({ op: 'click', selector: '#pop-btn' })
  const ringPop = await until('popup named in ring', async () => (await run({ op: 'console' })).result.includes('new tab'))
  check('a window.open click lands a NAMED ring entry (the black hole dies)', ringPop)
  const orphanGone = await until('orphan tab closed', async () => (await activeSession(OWNER)!.browser.pages()).length === 1)
  check('the orphan tab was closed (census: one owned page)', orphanGone)
  const tree = await run({ op: 'extract', mode: 'tree' })
  check('the tree projects FRAMED content (includeIframes)', tree.result.includes('inner button'), tree.result.slice(0, 200))
  const miss = await run({ op: 'click', selector: '#inner-btn', timeoutMs: 600 })
  check('a selector living in a frame diagnoses the frames, not a bare not-found', miss.outcome === 'failed' && miss.result.includes('child frame'), miss.result)
  const dl = await run({ op: 'open', url: `${A}/download` })
  check('a download-serving URL cannot land bytes (protocol-level deny)', dl.outcome === 'failed' && /ERR_ABORTED|abort/i.test(dl.result), dl.result)
  await run({ op: 'open', url: `${A}/` })
}

// ── §9c dialogs never wedge the session ─────────────────────────────────────
// Truth drill: with no dialog listener, an open alert BLOCKED the
// page realm (waitForFunction TimeoutError while the text sat in the DOM).
console.log('§9c dialogs')
{
  await run({ op: 'open', url: `${A}/` })
  await run({ op: 'click', selector: '#alert-btn' })
  const alive = await run({ op: 'waitFor', text: 'Fixture Alpha', timeoutMs: 4000 })
  check('an alert cannot wedge the session (auto-dismissed, the page answers)', alive.outcome === 'succeeded', alive.result)
  const ringA = await until('alert in ring', async () => (await run({ op: 'console' })).result.includes('fixture alert'))
  check('the dismissed alert is NAMED in the ring (honest provenance)', ringA)
  await run({ op: 'click', selector: '#confirm-btn' })
  const dismissed = await run({ op: 'waitFor', text: 'dismissed', timeoutMs: 4000 })
  check('a confirm auto-dismisses (the no-consequence answer) and the page sees it', dismissed.outcome === 'succeeded', dismissed.result)
}

// ── §10a the judged origin travels with the act (check→act TOCTOU) ──────────
console.log('§10a judged-origin carry')
{
  await run({ op: 'open', url: `${A}/` })
  const allowed = await perm({ op: 'click', selector: '#grow' })
  check('the check allows on the approved origin (and judges it)', allowed.behavior === 'allow')
  await page().goto(`${B}/`) // the page moves UNDER the open consent (driver-level, no tool op)
  const raced = await run({ op: 'click', selector: '#bfield' })
  check('an act whose page moved after the check refuses by name, nothing done', raced.outcome === 'failed' && raced.result.includes('moved'), raced.result)
  check('the moved-to origin was NOT granted by the race', (await perm({ op: 'click', selector: '#bfield' })).behavior === 'ask')
  await run({ op: 'open', url: `${A}/` })
}

// ── §10b non-web schemes are a CLOSED default ───────────────────────────────
console.log('§10b non-web schemes')
{
  await page().goto('about:blank')
  check('about:blank stays ask-free (a contentless start page)', (await perm({ op: 'click', x: 5, y: 5 })).behavior === 'allow')
  await page().goto('data:text/html,<button id="d">d</button>')
  const ask = await perm({ op: 'click', selector: '#d' })
  check('a page-conjured scheme (data:) ASKS naming the scheme', ask.behavior === 'ask' && (ask.message ?? '').includes('data:'), JSON.stringify(ask))
  const { originOf } = await import('../../src/services/browser/browserSession.ts')
  check('a malformed URL gets its OWN marker (never about:blank\'s standing)', originOf('::::not a url') === 'unparseable:')
  await run({ op: 'open', url: `${A}/` })
}

// ── §16 the engine chain honors the grammar (rules, bypass, safetyCheck) ────
console.log('§16 engine-chain truth')
{
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const engineCtx = (opts: { mode?: string; allow?: string[]; deny?: string[] }) => {
    const toolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      mode: (opts.mode ?? 'default') as never,
      alwaysAllowRules: opts.allow ? { localSettings: opts.allow } : {},
      alwaysDenyRules: opts.deny ? { localSettings: opts.deny } : {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }
    const appState = { toolPermissionContext, denialTracking: undefined }
    return {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      options: {},
      localDenialTracking: { consecutiveDenials: 0, totalDenials: 0 },
    } as unknown as Parameters<typeof BrowserTool.call>[1]
  }
  await page().goto(`${B}/`) // an UNAPPROVED origin under the session grammar
  const clickB = { op: 'click', selector: '#bfield' } as ToolInput
  const underToolAllow = await decideToolPermission(BrowserTool as never, clickB, engineCtx({ allow: ['Browser'] }) as never)
  check('a WHOLE-TOOL allow rule cannot cover the crossing act (safetyCheck floor)', underToolAllow.decision.behavior === 'ask', JSON.stringify(underToolAllow.decision.behavior))
  const underSovereign = await decideToolPermission(BrowserTool as never, clickB, engineCtx({ mode: 'sovereign' }) as never)
  check('a bypass mode cannot cover the crossing act', underSovereign.decision.behavior === 'ask', JSON.stringify(underSovereign.decision.behavior))
  const originRule = `Browser(origin:${B})`
  const underOriginAllow = await decideToolPermission(BrowserTool as never, clickB, engineCtx({ allow: [originRule] }) as never)
  check('an origin-scoped allow rule covers acts on THAT origin', underOriginAllow.decision.behavior === 'allow', JSON.stringify(underOriginAllow.decision.behavior))
  const underOriginDeny = await decideToolPermission(BrowserTool as never, clickB, engineCtx({ deny: [originRule] }) as never)
  check('an origin-scoped deny rule refuses', underOriginDeny.decision.behavior === 'deny', JSON.stringify(underOriginDeny.decision.behavior))
  const openNew = { op: 'open', url: `${C}/land` } as ToolInput
  const openUnderToolAllow = await decideToolPermission(BrowserTool as never, openNew, engineCtx({ allow: ['Browser'] }) as never)
  check('the FIRST-VISIT open ask stays rule-reachable (intent-confirming, no safetyCheck)', openUnderToolAllow.decision.behavior === 'allow', JSON.stringify(openUnderToolAllow.decision.behavior))
  await run({ op: 'open', url: `${A}/` })
}

// ── §10 origin crossing by link click ───────────────────────────────────────
console.log('§10 the crossing re-asks')
{
  check('an unapproved origin still ASKS for open', (await perm({ op: 'open', url: `${B}/` })).behavior === 'ask')
  await run({ op: 'scroll', selector: '#cross' })
  const crossed = await run({ op: 'click', selector: '#cross' })
  const landed = await until('link navigation lands on beta', () => page().url().startsWith(B))
  check('the link click crosses to the beta origin', crossed.outcome === 'succeeded' && landed, `${crossed.result} · url=${page().url()}`)
  const ask = await perm({ op: 'click', selector: '#bfield' })
  check('an act on the crossed-to origin ASKS', ask.behavior === 'ask' && (ask.message ?? '').includes(B), JSON.stringify(ask))
  check('the ask names the act', (ask.message ?? '').includes('click #bfield'), ask.message ?? '')
  check('reads on the crossed-to origin stay free', (await perm({ op: 'extract' })).behavior === 'allow')
  const info = await run({ op: 'info' })
  check('info says the origin is NOT approved', info.result.includes('NOT approved'), info.result)
  const typed = await run({ op: 'type', selector: '#bfield', text: 'ride' })
  check('an approved act marks the origin (the operator said yes)', typed.outcome === 'succeeded' && (await perm({ op: 'click', selector: '#bfield' })).behavior === 'allow', typed.result)
}

// ── §11 origin crossing by redirect ─────────────────────────────────────────
console.log('§11 the redirect crossing')
{
  check('the redirect URL itself rides its approved origin', (await perm({ op: 'open', url: `${A}/redir` })).behavior === 'allow')
  const opened = await run({ op: 'open', url: `${A}/redir` })
  check('open follows the redirect and NAMES the crossing', opened.outcome === 'succeeded' && page().url().startsWith(C) && opened.result.includes('landed on'), opened.result)
  const ask = await perm({ op: 'reload' })
  check('an act on the redirect-landed origin ASKS', ask.behavior === 'ask' && (ask.message ?? '').includes(C), JSON.stringify(ask))
}

// ── §12 status carries the grant ledger ─────────────────────────────────────
console.log('§12 status provenance')
{
  const status = await run({ op: 'status' })
  check('status lists the session and its approved origins', status.result.includes('session: OPEN') && status.result.includes('approved origins') && status.result.includes(A) && status.result.includes(B), status.result.split('\n').slice(-2).join(' | '))
}

// ── §17 owner isolation: sessions AND grants are keyed per owner ────────────
// The rekey's core law: every in-process agent drives its OWN child with its
// OWN grants. Owner B here is an agent-lane fixture — the exact context
// shape runAgent stamps on a subagent's tool calls (agentId ⇒ the lane key).
console.log('§17 owner isolation (two live owners)')
const ctxB = { agentId: 'fixture-owner-b' } as Parameters<typeof BrowserTool.call>[1]
const OWNER_B = processOwnerForLane('fixture-owner-b')
async function runB(input: ToolInput): Promise<{ result: string; outcome: string }> {
  const { data } = await BrowserTool.call(input, ctxB)
  return { result: data.result, outcome: data.outcome }
}
async function permB(input: Partial<ToolInput>): Promise<{ behavior: string; message?: string }> {
  return (await BrowserTool.checkPermissions(input, ctxB)) as { behavior: string; message?: string }
}
{
  const { approvedOriginList, noteCheckedActOrigin, consumeCheckedActOrigin } = await import(
    '../../src/services/browser/browserSession.ts'
  )
  // GRANT ISOLATION at the permission layer: the main owner approved origin A
  // long ago — owner B's first visit to it must ASK, never ride.
  const askB = await permB({ op: 'open', url: `${A}/` })
  check('owner B asks for an origin owner A already approved (grants never cross owners)', askB.behavior === 'ask', JSON.stringify(askB))
  // TWO LIVE CHILDREN, no trampling: B opens its own session; A's page never moves.
  const mainUrlBefore = page().url()
  const openedB = await runB({ op: 'open', url: `${B}/` })
  check('owner B opens its OWN session', openedB.outcome === 'succeeded' && openedB.result.includes('drive-fixture-b'), openedB.result)
  check("opening B's session never moved A's page", page().url() === mainUrlBefore, `${mainUrlBefore} → ${page().url()}`)
  const pidA = activeSession(OWNER)!.browser.process()?.pid
  const pidB = activeSession(OWNER_B)!.browser.process()?.pid
  check('two owners = two real browser children (distinct pids)', typeof pidA === 'number' && typeof pidB === 'number' && pidA !== pidB, `A=${pidA} B=${pidB}`)
  // Interleaved acts land on each owner's own page.
  const typedB = await runB({ op: 'type', selector: '#bfield', text: 'beta-owner' })
  const clickedA = await run({ op: 'click', x: 5, y: 5 })
  check("interleaved acts: B types into B's page, A clicks A's page, both land", typedB.outcome === 'succeeded' && clickedA.outcome === 'succeeded', `${typedB.result} | ${clickedA.result}`)
  const grantsB = approvedOriginList(OWNER_B)
  check("B's grant ledger is its own: exactly the origin B visited", grantsB.length === 1 && grantsB[0] === B, grantsB.join(' · '))
  // B's fresh child never visited A — its ring must not carry A's load line.
  const ringB = await runB({ op: 'console' })
  check("B's console ring is B's own (no alpha-page entries)", !ringB.result.includes('alpha loaded'), ringB.result.split('\n').slice(0, 3).join(' | '))
  // The judged-origin carry is per owner: A's noted origin cannot answer B's act.
  noteCheckedActOrigin(OWNER, 'click', 'http://one-shot-fixture.test')
  check("A's judged origin is NOT consumable by owner B", consumeCheckedActOrigin(OWNER_B, 'click') === null)
  check("…and stays consumable by owner A (one-shot, own lane)", consumeCheckedActOrigin(OWNER, 'click') === 'http://one-shot-fixture.test')
  // The status surface names the multi-owner truth on both sides.
  const statusA = await run({ op: 'status' })
  const statusB = await runB({ op: 'status' })
  check('status (A) names the other live session', statusA.result.includes('other live sessions: 1'), statusA.result.split('\n').slice(-1).join(''))
  check("status (B) names ITS session and the other", statusB.result.includes(`session: OPEN at ${B}/`) && statusB.result.includes('other live sessions: 1'), statusB.result.split('\n').slice(-2).join(' | '))
}

// ── §18 per-owner reap: an owner's teardown kills ITS child, no other ───────
// disposeBrowserOwner is the exact call runAgent's teardown seam makes when
// an agent completes or aborts — this drill IS the agent-exit semantics.
console.log('§18 per-owner reap')
{
  const { disposeBrowserOwner, approvedOriginList } = await import('../../src/services/browser/browserSession.ts')
  const pidA = activeSession(OWNER)!.browser.process()?.pid
  const pidB = activeSession(OWNER_B)!.browser.process()?.pid
  await disposeBrowserOwner(OWNER_B)
  const bGone = await until('owner-B child gone after dispose', () => {
    try {
      process.kill(pidB!, 0)
      return false
    } catch {
      return true
    }
  })
  check("disposing owner B reaps B's child (kill-0 census)", bGone, `pidB=${pidB}`)
  let aAlive = false
  try {
    process.kill(pidA!, 0)
    aAlive = true
  } catch {
    aAlive = false
  }
  check("owner A's child survives B's teardown", aAlive && activeSession(OWNER) !== null, `pidA=${pidA}`)
  check("B's grants died with its child", approvedOriginList(OWNER_B).length === 0 && (await permB({ op: 'open', url: `${B}/` })).behavior === 'ask')
  check("A's grants survive B's teardown (open A still rides)", (await perm({ op: 'open', url: `${A}/` })).behavior === 'allow')
}

// ── §19 the concurrent-children cap: bounded, honest, race-proof ────────────
console.log('§19 the children cap')
{
  const { browserSessionCap, BROWSER_SESSION_CAP_DEFAULT, ensureBrowserSession, disposeBrowserOwner } = await import(
    '../../src/services/browser/browserSession.ts'
  )
  check(`the default cap is small (${BROWSER_SESSION_CAP_DEFAULT})`, browserSessionCap() === BROWSER_SESSION_CAP_DEFAULT)
  process.env.MERCURY_BROWSER_MAX_SESSIONS = '0'
  check('a nonsense cap value falls back to the default (floor 1)', browserSessionCap() === BROWSER_SESSION_CAP_DEFAULT)
  process.env.MERCURY_BROWSER_MAX_SESSIONS = '1'
  const ctxC = { agentId: 'fixture-owner-c' } as Parameters<typeof BrowserTool.call>[1]
  const refused = await BrowserTool.call({ op: 'open', url: `${B}/` } as ToolInput, ctxC)
  check(
    'a launch past the cap refuses naming live count, lane and the knob',
    refused.data.outcome === 'failed' &&
      refused.data.result.includes('1 of 1') &&
      refused.data.result.includes('main') &&
      refused.data.result.includes('MERCURY_BROWSER_MAX_SESSIONS'),
    refused.data.result,
  )
  const mainStill = await run({ op: 'open', url: `${A}/two` })
  check("the cap gates NEW children, never a live owner's navigation", mainStill.outcome === 'succeeded', mainStill.result)
  // The race: two owners ensure() into ONE free slot — the synchronous slot
  // reservation admits exactly one; the loser is refused, never a third child.
  process.env.MERCURY_BROWSER_MAX_SESSIONS = '2'
  const OWNER_R1 = processOwnerForLane('fixture-racer-1')
  const OWNER_R2 = processOwnerForLane('fixture-racer-2')
  const [r1, r2] = await Promise.all([ensureBrowserSession(OWNER_R1), ensureBrowserSession(OWNER_R2)])
  const wins = [r1, r2].filter(r => !('state' in r)).length
  const capped = [r1, r2].filter(r => 'state' in r && r.state === 'at-capacity').length
  check('two owners racing ONE free slot: exactly one child, one at-capacity refusal', wins === 1 && capped === 1, `wins=${wins} capped=${capped}`)
  await disposeBrowserOwner(OWNER_R1)
  await disposeBrowserOwner(OWNER_R2)
  delete process.env.MERCURY_BROWSER_MAX_SESSIONS
}

// ── §19b one owner never races itself: parallel ensures share ONE launch ────
// The cap census excludes the caller's own rows (so a relaunch is never
// self-blocked), which means the slot reservation cannot police a SAME-owner
// race — the single-flight does: a second ensure() while this owner's launch
// is in flight joins it. Without it, the loser's child was overwritten OUT
// of the store: unkillable by the exit sweep, a leaked Chrome.
console.log('§19b same-owner launch single-flight')
{
  const { ensureBrowserSession, disposeBrowserOwner, liveBrowserSessionCensus } = await import(
    '../../src/services/browser/browserSession.ts'
  )
  const OWNER_S = processOwnerForLane('fixture-single-flight')
  const [s1, s2] = await Promise.all([ensureBrowserSession(OWNER_S), ensureBrowserSession(OWNER_S)])
  const okBoth = !('state' in s1) && !('state' in s2)
  const pidOf = (s: unknown): number | undefined =>
    (s as { browser?: { process(): { pid?: number } | null } }).browser?.process()?.pid
  const pid1 = pidOf(s1)
  const pid2 = pidOf(s2)
  check('two parallel ensures from ONE owner land the SAME session (object identity)', okBoth && s1 === s2, `pids ${pid1}/${pid2}`)
  check('the owner holds exactly one live child (census)', liveBrowserSessionCensus().filter(r => r.owner === OWNER_S).length === 1)
  await disposeBrowserOwner(OWNER_S)
  // A red run must never strand a child: in the defect world the loser lives
  // outside the store, so the sweep below reaps by pid, both worlds.
  for (const pid of [pid1, pid2]) {
    if (pid === undefined) continue
    try {
      process.kill(pid)
    } catch {
      /* already reaped */
    }
  }
}

// ── §20 the secretRef credential road (operator-ruled stage 1) ──────────────
// The complement pair of laws: plain text NEVER lands in a credential-shaped
// field; a registered secret lands ONLY in one — and the value never touches
// a model-visible surface (results, provenance, the ring, error text).
console.log('§20 the secretRef credential road')
{
  const { resolveBrowserSecret, scrubSecretFromText } = await import('../../src/services/browser/browserSecrets.ts')
  const { secretPairingApproved } = await import('../../src/services/browser/browserSession.ts')
  const SECRET_VALUE = 'fixture-hunter2-9QzX'
  process.env.MERCURY_BROWSER_SECRET_TEST_LOGIN = SECRET_VALUE
  await run({ op: 'open', url: `${A}/` })
  // a. the pairing ask: an APPROVED origin still asks, naming secret+origin,
  //    never the value; human-only by reason.
  const ask = (await BrowserTool.checkPermissions({ op: 'type', selector: '#pw', secretRef: 'TEST_LOGIN' }, ctx)) as {
    behavior: string
    message?: string
    decisionReason?: { type?: string; classifierApprovable?: boolean }
  }
  check(
    'a secret fill ASKS on an already-approved origin (the pairing is its own consent)',
    ask.behavior === 'ask' && (ask.message ?? '').includes('TEST_LOGIN') && (ask.message ?? '').includes(A),
    JSON.stringify(ask.message),
  )
  check('the pairing ask never carries the value', !(ask.message ?? '').includes(SECRET_VALUE))
  check(
    'the pairing ask is human-only (safetyCheck, classifier-unanswerable)',
    ask.decisionReason?.type === 'safetyCheck' && ask.decisionReason?.classifierApprovable === false,
    JSON.stringify(ask.decisionReason),
  )
  // b. the engine chain: whole-tool allow and a WRONG-origin pairing rule
  //    cannot cover the fill; the exact pairing rule can.
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const engineCtx = (opts: { allow?: string[] }) => {
    const toolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      mode: 'default' as never,
      alwaysAllowRules: opts.allow ? { localSettings: opts.allow } : {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }
    const appState = { toolPermissionContext, denialTracking: undefined }
    return {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      options: {},
      localDenialTracking: { consecutiveDenials: 0, totalDenials: 0 },
    } as unknown as Parameters<typeof BrowserTool.call>[1]
  }
  const fillInput = { op: 'type', selector: '#pw', secretRef: 'TEST_LOGIN' } as ToolInput
  const underToolAllow = await decideToolPermission(BrowserTool as never, fillInput, engineCtx({ allow: ['Browser'] }) as never)
  check('a WHOLE-TOOL allow rule cannot cover a secret fill', underToolAllow.decision.behavior === 'ask', String(underToolAllow.decision.behavior))
  const wrongPairing = await decideToolPermission(
    BrowserTool as never,
    fillInput,
    engineCtx({ allow: [`Browser(secret:TEST_LOGIN@${C})`] }) as never,
  )
  check('a pairing rule for ANOTHER origin does not cover this one (hostile-origin refusal)', wrongPairing.decision.behavior === 'ask', String(wrongPairing.decision.behavior))
  const rightPairing = await decideToolPermission(
    BrowserTool as never,
    fillInput,
    engineCtx({ allow: [`Browser(secret:TEST_LOGIN@${A})`] }) as never,
  )
  check('the EXACT pairing rule covers the fill', rightPairing.decision.behavior === 'allow', String(rightPairing.decision.behavior))
  // c. the fill lands, and the value is ABSENT from the result.
  const filled = await run({ op: 'type', selector: '#pw', secretRef: 'TEST_LOGIN' })
  const landed = await page().evaluate(() => (document.getElementById('pw') as HTMLInputElement).value)
  check('the secret fill LANDS in the password field (page-side census)', filled.outcome === 'succeeded' && landed === SECRET_VALUE, filled.result)
  check('the result names the REF, never the value and never a length readback', filled.result.includes('TEST_LOGIN') && !filled.result.includes(SECRET_VALUE) && !filled.result.includes('value now'), filled.result)
  // d. the ring is value-free too.
  const ring = await run({ op: 'console' })
  check('the console ring never carries the value', !ring.result.includes(SECRET_VALUE))
  // e. the pairing rides for the session; it is OWNER-scoped.
  check('the approved pairing rides (no re-ask this session)', (await perm({ op: 'type', selector: '#pw', secretRef: 'TEST_LOGIN' })).behavior === 'allow')
  check("the pairing is the MAIN owner's own, not owner B's", secretPairingApproved(OWNER, 'TEST_LOGIN', A) && !secretPairingApproved(OWNER_B, 'TEST_LOGIN', A))
  // f. the complement law, both directions.
  const wrongShape = await run({ op: 'type', selector: '#field', secretRef: 'TEST_LOGIN' })
  check('secretRef refuses a NON-credential target by name', wrongShape.outcome === 'failed' && wrongShape.result.includes('credential-shaped'), wrongShape.result)
  const fieldUntouched = await page().evaluate(() => (document.getElementById('field') as HTMLInputElement).value)
  check('…and nothing was filled', fieldUntouched === '')
  const plainIntoPw = await run({ op: 'type', selector: '#pw', text: 'not-a-secret', clear: true })
  check('plain text STILL refuses the credential field (the standing law kept)', plainIntoPw.outcome === 'failed' && plainIntoPw.result.includes('credential field'), plainIntoPw.result)
  // g. origin drift refuses the fill and grants NOTHING.
  await perm({ op: 'type', selector: '#pw', secretRef: 'TEST_LOGIN' }) // judges origin A
  await page().goto(`${B}/`) // the page moves under the consent (driver-level)
  const drifted = await run({ op: 'type', selector: '#bfield', secretRef: 'TEST_LOGIN' })
  check('a page that moved after the pairing check refuses by name, nothing filled', drifted.outcome === 'failed' && drifted.result.includes('moved'), drifted.result)
  check('the drifted-to origin gained NO pairing', (await perm({ op: 'type', selector: '#bfield', secretRef: 'TEST_LOGIN' })).behavior === 'ask')
  await run({ op: 'open', url: `${A}/` })
  // h. resolution honesty: value-free refusals; the input grammar. The
  // drift drill above left a stale one-shot judgment (its ask was never
  // followed by an act) — re-judge on the live page first, as production
  // always does.
  await perm({ op: 'type', selector: '#pw', secretRef: 'NO_SUCH_SECRET' })
  const missing = await run({ op: 'type', selector: '#pw', secretRef: 'NO_SUCH_SECRET' })
  check(
    'a missing secret refuses naming BOTH registration roads',
    missing.outcome === 'failed' && missing.result.includes('MERCURY_BROWSER_SECRET_NO_SUCH_SECRET') && missing.result.includes('browser-secrets.json'),
    missing.result,
  )
  const badGrammar = await BrowserTool.validateInput!({ op: 'type', selector: '#pw', secretRef: 'bad-lower' } as ToolInput, ctx)
  check('a ref outside the name grammar refuses at validation', badGrammar.result === false && (badGrammar as { message?: string }).message?.includes('grammar') === true)
  const bothForms = await BrowserTool.validateInput!({ op: 'type', selector: '#pw', secretRef: 'TEST_LOGIN', text: 'x' } as ToolInput, ctx)
  check('text and secretRef together refuse', bothForms.result === false)
  const noSelector = await BrowserTool.validateInput!({ op: 'type', secretRef: 'TEST_LOGIN' } as ToolInput, ctx)
  check('secretRef without a selector refuses (never aimed at "whatever is focused")', noSelector.result === false)
  // i. the scrub rail (the function the catch installs).
  check(
    'the error-text scrub replaces every value occurrence with a named marker',
    scrubSecretFromText(`boom ${SECRET_VALUE} and ${SECRET_VALUE}`, SECRET_VALUE, 'TEST_LOGIN') === 'boom [redacted:TEST_LOGIN] and [redacted:TEST_LOGIN]',
  )
  // j. the file road: owner-only mode enforced; env outranks file.
  const secretsDir = mkdtempSync(join(tmpdir(), 'mercury-browser-secrets-'))
  const secretsFile = join(secretsDir, 'browser-secrets.json')
  writeFileSync(secretsFile, JSON.stringify({ FILE_SECRET: 'file-road-value-77' }), { mode: 0o600 })
  const fromFile = resolveBrowserSecret('FILE_SECRET', { fileDir: secretsDir })
  check('the 0600 file road resolves', fromFile.state === 'ok' && fromFile.value === 'file-road-value-77' && fromFile.source === 'file', JSON.stringify(fromFile))
  chmodSync(secretsFile, 0o644)
  const tooWide = resolveBrowserSecret('FILE_SECRET', { fileDir: secretsDir })
  check('a group/other-readable secrets file REFUSES naming the fix', tooWide.state === 'refused' && tooWide.note.includes('chmod 600'), JSON.stringify(tooWide))
  process.env.MERCURY_BROWSER_SECRET_FILE_SECRET = 'env-wins-value'
  const envWins = resolveBrowserSecret('FILE_SECRET', { fileDir: secretsDir })
  check('the env road outranks the file road', envWins.state === 'ok' && envWins.source === 'env' && envWins.value === 'env-wins-value')
  delete process.env.MERCURY_BROWSER_SECRET_FILE_SECRET
  delete process.env.MERCURY_BROWSER_SECRET_TEST_LOGIN
  rmSync(secretsDir, { recursive: true, force: true })
}

// ── §13 close reaps the child and wipes the grants ──────────────────────────
console.log('§13 close')
{
  const pid = activeSession(OWNER)!.browser.process()?.pid
  check('the session names its child pid', typeof pid === 'number')
  const closed = await run({ op: 'close' })
  const gone = await until('child gone after close', () => {
    try {
      process.kill(pid!, 0)
      return false
    } catch {
      return true
    }
  })
  check('close reaps the browser child (kill 0 census)', closed.outcome === 'succeeded' && gone, closed.result)
  check('the grants died with the session (open asks again)', (await perm({ op: 'open', url: `${A}/` })).behavior === 'ask')
  const dead = await run({ op: 'info' })
  check('acts after close refuse honestly', dead.outcome === 'failed' && dead.result.includes('no open session'), dead.result)
}

// ── §13b a crashed child cannot lend its grants ─────────────────────────────
console.log('§13b crash-path grant death')
{
  await run({ op: 'open', url: `${A}/` })
  const pid = activeSession(OWNER)!.browser.process()?.pid
  process.kill(pid!, 'SIGKILL')
  const gone = await until('dead child reaped on next read', async () => (await run({ op: 'status' })).result.includes('session: none'))
  check('status reports the crashed child as NONE (no stale OPEN)', gone)
  check('the crash wiped the grants (open asks again)', (await perm({ op: 'open', url: `${A}/` })).behavior === 'ask')
}

// ── §14 a NORMAL process exit without close reaps too (the cliff class) ─────
console.log('§14 exit reap drill')
{
  const dir = mkdtempSync(join(tmpdir(), 'mercury-drive-exit-'))
  const child = join(dir, 'exit-drill.ts')
  writeFileSync(
    child,
    `const { ensureBrowserSession } = await import(${JSON.stringify(join(ROOT, 'src', 'services', 'browser', 'browserSession.ts'))})
const { processOwnerForLane } = await import(${JSON.stringify(join(ROOT, 'src', 'services', 'run', 'resolveOwner.ts'))})
const s = await ensureBrowserSession(processOwnerForLane(null))
if ('state' in s) { console.log('DRILL-UNAVAILABLE: ' + s.note); process.exit(3) }
console.log('DRILL-PID ' + s.browser.process()?.pid)
`,
  )
  let out = ''
  let rc = 0
  try {
    out = execFileSync(process.execPath, [child], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, MERCURY_BROWSER: '1' },
    })
  } catch (err) {
    rc = (err as { status?: number }).status ?? 1
    out = String((err as { stdout?: string }).stdout ?? '')
  }
  const pid = Number(/DRILL-PID (\d+)/.exec(out)?.[1])
  check('the drill child opened a real session and exited normally', rc === 0 && Number.isFinite(pid), `rc=${rc} out=${out.trim()}`)
  const gone = await until('child gone after normal exit', () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
  check('a normal exit WITHOUT close reaps the browser child', gone, `pid=${pid}`)
}

// ── §15 structural teeth (law spellings a refactor must keep) ───────────────
console.log('§15 structural teeth')
{
  const toolSrc = await Bun.file(join(ROOT, 'src', 'tools', 'BrowserTool', 'BrowserTool.ts')).text()
  // Re-trued with the grown act surface (select/press/hover ride the same
  // origin grammar): the exact spelling, whitespace-normalized.
  check(
    'the act-op set is spelled exactly',
    toolSrc
      .replace(/\s+/g, ' ')
      .includes("new Set([ 'open', 'click', 'type', 'scroll', 'back', 'reload', 'select', 'press', 'hover', ])"),
  )
  check('press has NO printable keys (never a typing side door)', toolSrc.includes('PRESS_KEYS') && !/PRESS_KEYS[^]]*'a'/.test(toolSrc))
  check('the first-visit ask names itself', toolSrc.includes('first visit to'))
  check('the crossing ask names itself', toolSrc.includes('reached by navigation'))
  check('the credential refusal is a named law', toolSrc.includes('credential field'))
  // Re-trued (frontier-over-fossil): the law's reason is "never a
  // clock spin". RAF is the browser's own frame signal — still event-driven —
  // and unlike the mutation poller it wakes on characterData-only rewrites
  // (React's text-commit path), which the retired 'mutation' spelling missed.
  check('text waits poll the frame signal, never clock spins', toolSrc.includes("polling: 'raf'") && !toolSrc.includes('waitForTimeout'))
  check('the tool names its own deadline on a miss', toolSrc.includes('deadline ${deadline}ms exceeded'))
  check('the crossing ask is bypass-immune by reason (safetyCheck, never classifier-answered)', toolSrc.includes('classifierApprovable: false'))
  const cardSrc = await Bun.file(join(ROOT, 'src', 'components', 'permissions', 'BrowserPermissionRequest', 'BrowserPermissionRequest.tsx')).text()
  check('the consent card persists ORIGIN rules only (the whole-tool allow option does not exist)', cardSrc.includes('ruleContent: ruleContent') && !cardSrc.includes('rules: [{ toolName: toolUseConfirm.tool.name }]'))
  const routerSrc = await Bun.file(join(ROOT, 'src', 'components', 'permissions', 'PermissionRequest.tsx')).text()
  check('the Browser card is ROUTED (the fallback whole-tool card no longer answers)', routerSrc.includes('BrowserPermissionRequest'))
  check('extract truncation names its cap', toolSrc.includes('TRUNCATED to ${EXTRACT_CAP}'))
  const sessionSrc = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserSession.ts')).text()
  // Re-trued with the owner rekey: the wipe now guards FOUR dead-child roads
  // (the owner disposer, ensure's relaunch, the crash reap, close) — every
  // road through "no live child" clears exactly THAT owner's grants, and the
  // owner-scoped spelling is the pinned shape.
  check('grants wipe on EVERY dead-session road (owner-scoped)', sessionSrc.split('.approvedOrigins.clear()').length === 5)
  check('the per-owner store joins the owner-disposal registry', sessionSrc.includes('registerOwnerScopedStore(ownerStates)'))
  check(
    'a live or launching child is retained (LRU eviction can never kill a browser mid-act)',
    sessionSrc.includes('retain: state => state.session !== null || state.launching'),
  )
  check('the at-capacity refusal names the knob', sessionSrc.includes('raise MERCURY_BROWSER_MAX_SESSIONS'))
  const runAgentSrc = await Bun.file(join(ROOT, 'src', 'tools', 'AgentTool', 'runAgent.ts')).text()
  check(
    "agent teardown reaps the agent's own browser child (the leak-repair seam)",
    runAgentSrc.includes('disposeBrowserOwner(processOwnerForLane(agentId))'),
  )
  // The secretRef road's structural rails (the ruled stage-1 build).
  check('secret pairings wipe on EVERY dead-session road', sessionSrc.split('.approvedSecretPairings.clear()').length === 5)
  check('the error-text scrub is INSTALLED on the result rail', toolSrc.includes('scrubSecretFromText(result'))
  check('the fill-only-credential complement is a named law', toolSrc.includes('secretRef fills only credential-shaped targets'))
  check('the pairing ask names itself', toolSrc.includes('fill secret'))
  check('the Chrome child inherits the SCRUBBED env, never the raw one', sessionSrc.includes('env: subprocessEnv()'))
  const scrubSrc = await Bun.file(join(ROOT, 'src', 'utils', 'subprocessEnv.ts')).text()
  check('the secret family is stripped from every spawned child env', scrubSrc.includes("'MERCURY_BROWSER_SECRET_'"))
  check('the popup owner is armed (a new tab is named, never a black hole)', sessionSrc.includes("page.on('popup'"))
  check('the console ring is armed at launch and bounded', sessionSrc.includes("page.on('console'") && sessionSrc.includes('consoleRing.length > CONSOLE_RING_CAP'))
  check('the dialog owner is armed at launch (a dialog can never wedge the session)', sessionSrc.includes("page.on('dialog'"))
  check('the network planes are armed at launch (requestfailed + error responses)', sessionSrc.includes("page.on('requestfailed'") && sessionSrc.includes("page.on('response'"))
  check('ring URLs are query-redacted (tokens never enter the ring)', sessionSrc.includes('redactUrl'))
  const uiSrc = await Bun.file(join(ROOT, 'src', 'tools', 'BrowserTool', 'UI.tsx')).text()
  check(
    'the UI rows speak the new verbs',
    uiSrc.includes("'waitFor'") &&
      uiSrc.includes("'extract'") &&
      uiSrc.includes("'type'") &&
      uiSrc.includes("'select'") &&
      uiSrc.includes("'press'") &&
      uiSrc.includes("'hover'"),
  )
}

a.server.close()
b.server.close()
c.server.close()

if (failures > 0) {
  console.error(`\nbrowser drive: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nbrowser drive: green')
