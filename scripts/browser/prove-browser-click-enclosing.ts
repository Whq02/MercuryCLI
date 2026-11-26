#!/usr/bin/env bun
import type http from 'node:http'
import { check, finish, lead, pageOf, requireBrowser, run, section, serve } from './harness.ts'

await requireBrowser()

const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/child') {
    res.end(`<!doctype html><title>Child</title><style>body{margin:0}</style>
<button id="framed-btn" style="width:200px;height:48px" onclick="window.__hits=(window.__hits||0)+1;window.__trusted=event.isTrusted"><span style="pointer-events:none">Framed action</span></button>`)
    return
  }
  res.end(`<!doctype html><title>Enclosing Click</title><style>
body{margin:16px;font-family:sans-serif}
button,[role="button"]{display:inline-flex;align-items:center;justify-content:center;min-width:160px;height:44px;margin:8px 0}
.wrap{position:relative;display:inline-block}
</style>
<script>
window.__counts = Object.create(null);
window.__trusted = Object.create(null);
function bump(name, ev) {
  window.__counts[name] = (window.__counts[name] || 0) + 1;
  window.__trusted[name] = Boolean(ev && ev.isTrusted);
}
</script>
<div><button id="faq-btn" onclick="bump('faq', event)"><span style="pointer-events:none">Expand question</span></button></div>
<div id="shadow-host"></div>
<script>
const host = document.getElementById('shadow-host');
const sr = host.attachShadow({ mode: 'open' });
sr.innerHTML = '<button id="sbtn" style="min-width:160px;height:44px"><span style="pointer-events:none">Shadow label</span></button>';
sr.getElementById('sbtn').addEventListener('click', ev => bump('shadow', ev));
</script>
<div id="slot-host" style="display:inline-block"><span id="slotted-span" style="pointer-events:none">Slotted label</span></div>
<script>
const slotHost = document.getElementById('slot-host');
const slotRoot = slotHost.attachShadow({ mode: 'open' });
slotRoot.innerHTML = '<button id="slot-btn" style="min-width:160px;height:44px"><slot></slot></button>';
slotRoot.getElementById('slot-btn').addEventListener('click', ev => bump('slotted', ev));
</script>
<div><span id="bare-pe" style="display:inline-block;padding:10px 20px;pointer-events:none" onclick="bump('bare', event)">Bare passive text</span></div>
<div id="outer-role" role="button" onclick="bump('outer', event)" style="padding:12px">
  <a id="inner-link" href="#inner" onclick="event.preventDefault();bump('inner', event)" style="display:inline-block;padding:8px 16px;pointer-events:none"><span style="pointer-events:none">Nested control text</span></a>
</div>
<div class="wrap">
  <button id="covered-btn" onclick="bump('covered', event)"><span style="pointer-events:none">Under overlay</span></button>
  <div id="real-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,0.2)">Cover</div>
</div>
<div><button id="dis-btn" disabled onclick="bump('dis', event)"><span style="pointer-events:none">Disabled native</span></button></div>
<div><div id="aria-dis-btn" role="button" aria-disabled="true" onclick="bump('ariaDis', event)"><span style="pointer-events:none">Disabled aria</span></div></div>
<fieldset disabled><button id="fs-dis-btn" onclick="bump('fsDis', event)"><span style="pointer-events:none">Disabled fieldset</span></button></fieldset>
<div class="wrap" id="frame-wrap">
  <iframe id="child-frame" src="/child" width="220" height="60" style="border:0"></iframe>
  <div id="frame-cover" style="position:absolute;inset:0;background:rgba(0,0,0,0.2)">Frame cover</div>
</div>`)
}

const site = await serve(0, handler)
const opened = await run({ op: 'open', url: `${site.origin}/` })
check('fixture page opens', opened.outcome === 'succeeded', opened.result)

const countOf = (name: string) => pageOf(lead).evaluate(k => (window as unknown as { __counts: Record<string, number> }).__counts[k] ?? 0, name)
const trustedOf = (name: string) => pageOf(lead).evaluate(k => (window as unknown as { __trusted: Record<string, boolean> }).__trusted[k] ?? false, name)

section('S1 text/ click on pointer-events:none child inside an enabled button')
{
  const clicked = await run({ op: 'click', selector: 'text/Expand question', timeoutMs: 2000 })
  check('ordinary click by text lands without force', clicked.outcome === 'succeeded', clicked.result)
  check('enclosing button receives exactly one trusted click', (await countOf('faq')) === 1 && (await trustedOf('faq')) === true, `count=${await countOf('faq')} trusted=${await trustedOf('faq')}`)
}

section('S2 shadow-root button and slotted text child inside a shadow button')
{
  const inShadow = await run({ op: 'click', selector: 'text/Shadow label', timeoutMs: 2000 })
  check('shadow button click by text lands without force', inShadow.outcome === 'succeeded', inShadow.result)
  check('shadow button receives one trusted click', (await countOf('shadow')) === 1 && (await trustedOf('shadow')) === true, `count=${await countOf('shadow')} trusted=${await trustedOf('shadow')}`)
  const slotted = await run({ op: 'click', selector: '#slotted-span', timeoutMs: 2000 })
  check('slotted text inside shadow button lands without force', slotted.outcome === 'succeeded', slotted.result)
  check('shadow host button receives one trusted click', (await countOf('slotted')) === 1 && (await trustedOf('slotted')) === true, `count=${await countOf('slotted')} trusted=${await trustedOf('slotted')}`)
}

section('S3 non-control ancestor, nested other control, real sibling overlay and frame cover still refuse without acting')
{
  const bare = await run({ op: 'click', selector: 'text/Bare passive text', timeoutMs: 2000 })
  check('pointer-events:none text directly under non-control container still refuses', bare.outcome === 'failed' && bare.result.includes('covered by'), bare.result)
  check('no click landed on bare text', (await countOf('bare')) === 0, `count=${await countOf('bare')}`)

  const nested = await run({ op: 'click', selector: 'text/Nested control text', timeoutMs: 2000 })
  check('text inside an inner control does not fall through to an outer control', nested.outcome === 'failed' && nested.result.includes('covered by div#outer-role'), nested.result)
  check('neither outer nor inner control received a click', (await countOf('outer')) === 0 && (await countOf('inner')) === 0, `outer=${await countOf('outer')} inner=${await countOf('inner')}`)

  const covered = await run({ op: 'click', selector: 'text/Under overlay', timeoutMs: 2000 })
  check('real sibling overlay still refuses', covered.outcome === 'failed' && covered.result.includes('covered by div#real-overlay'), covered.result)
  check('covered button received no click', (await countOf('covered')) === 0, `count=${await countOf('covered')}`)

  const frameCovered = await run({ op: 'click', frame: 1, selector: 'text/Framed action', timeoutMs: 2000 })
  check('embedding-page frame cover still refuses', frameCovered.outcome === 'failed' && frameCovered.result.includes('covered by div#frame-cover'), frameCovered.result)
  const frameHitsBefore = await pageOf(lead).frames().find(f => f.url().endsWith('/child'))!.evaluate(() => (window as unknown as { __hits?: number }).__hits ?? 0)
  check('framed button received no click while covered', frameHitsBefore === 0, `hits=${frameHitsBefore}`)

  await pageOf(lead).evaluate(() => document.getElementById('frame-cover')?.remove())
  const frameClear = await run({ op: 'click', frame: 1, selector: 'text/Framed action', timeoutMs: 2000 })
  const frameHitsAfter = await pageOf(lead).frames().find(f => f.url().endsWith('/child'))!.evaluate(() => (window as unknown as { __hits?: number }).__hits ?? 0)
  check('once frame cover is gone, framed button click by text lands once', frameClear.outcome === 'succeeded' && frameHitsAfter === 1, `${frameClear.result} hits=${frameHitsAfter}`)
}

section('S4 disabled controls stay disabled even via child text and force:true')
{
  for (const [label, text, key] of [
    ['native disabled button', 'Disabled native', 'dis'],
    ['aria-disabled control', 'Disabled aria', 'ariaDis'],
    ['fieldset-disabled button', 'Disabled fieldset', 'fsDis'],
  ] as const) {
    const plain = await run({ op: 'click', selector: `text/${text}`, timeoutMs: 2000 })
    check(`${label} refuses as disabled`, plain.outcome === 'failed' && plain.result.includes('the target is disabled'), plain.result)
    const forced = await run({ op: 'click', selector: `text/${text}`, force: true, timeoutMs: 2000 })
    check(`${label} refuses even with force:true`, forced.outcome === 'failed' && forced.result.includes('the target is disabled'), forced.result)
    check(`${label} received no click`, (await countOf(key)) === 0, `count=${await countOf(key)}`)
  }
}

await finish('prove-browser-click-enclosing', [lead])
