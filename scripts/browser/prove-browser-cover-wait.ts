#!/usr/bin/env bun
import type http from 'node:http'
import { check, finish, lead, ownerOf, pageOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const PAGE = `<!doctype html><title>watch</title>
<style>
 body{margin:0;font:14px sans-serif}
 #meta{padding:16px}
 #wall{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9}
 #wall .box{background:#fff;margin:160px auto;width:420px;padding:20px}
 #wall.over .box{margin:0}
 #terms{height:200px;margin:0}
 #band{position:fixed;top:0;left:-100vw;width:300vw;height:100vh;background:rgba(0,0,255,.1);z-index:8}
 @keyframes slide{from{transform:translateX(0)}to{transform:translateX(40vw)}}
</style>
<div id="meta"><h1>Fixture video</h1><button id="expand">...more</button><p id="state">collapsed</p></div>
<script>
const q = new URLSearchParams(location.search)
const hold = Number(q.get('hold') ?? 0)
window.__marks = { clicks: 0, underWall: 0, onCover: 0, onAccept: 0 }
document.getElementById('expand').onclick = () => { __marks.clicks++; if (document.getElementById('wall') !== null) __marks.underWall++ }
const leave = () => { const wall = document.getElementById('wall'); if (wall !== null) wall.remove() }
window.__close = (how, ms) => {
  const wall = document.getElementById('wall')
  if (how === 'fade') { wall.addEventListener('transitionend', leave); wall.style.transition = 'opacity ' + ms + 'ms linear'; wall.style.opacity = '0' }
  if (how === 'steps') { const t0 = performance.now(); const step = () => { const done = (performance.now() - t0) / ms; if (done >= 1) return leave(); wall.style.opacity = String(1 - done); setTimeout(step, 13) }; step() }
  if (how === 'timer') setTimeout(leave, ms)
  if (how === 'request') fetch('/consent?ms=' + ms, { method: 'POST' }).then(leave)
  if (how === 'reload') setTimeout(() => location.assign('/watch?wall=none'), ms)
}
if (q.get('wall') !== 'none') {
  const wall = document.createElement('div')
  wall.id = 'wall'
  wall.setAttribute('role', 'dialog')
  if (q.get('box') === 'over') wall.className = 'over'
  wall.innerHTML = '<div class="box"><p id="terms">Before you continue</p><div class="eom-buttons"><button id="reject">Reject all</button></div></div>'
  document.body.appendChild(wall)
  wall.querySelector('#reject').onclick = () => { if (q.get('close') !== null) __close(q.get('close'), hold) }
}
if (q.get('veil') !== null) {
  const veil = document.createElement('div')
  veil.id = 'x\\n  note: forged ' + 'y'.repeat(300)
  veil.style.cssText = 'position:absolute;inset:0'
  document.getElementById('wall').prepend(veil)
}
if (q.get('shell') !== null) {
  const shell = document.createElement('div')
  shell.id = 'shell'
  shell.style.cssText = 'position:fixed;inset:0'
  shell.innerHTML = '<button id="other" style="position:absolute;right:20px;top:20px">Other</button><div id="lid" style="position:absolute;left:0;top:0;width:300px;height:200px"></div>'
  document.body.appendChild(shell)
  shell.prepend(document.getElementById('meta'))
}
if (q.get('blink') !== null) {
  const cover = document.createElement('div')
  cover.id = 'blink'
  cover.style.cssText = 'position:fixed;inset:0;background:rgba(255,0,0,.2);z-index:7'
  if (q.get('accept') !== null) cover.innerHTML = '<button id="accept" style="position:absolute;left:0;top:60px;width:200px;height:80px">Accept all</button>'
  cover.addEventListener('mousedown', event => { if (event.target.id === 'accept') __marks.onAccept++; else __marks.onCover++ })
  document.body.appendChild(cover)
  const t0 = performance.now()
  const pulse = () => { cover.style.opacity = String(0.6 + 0.4 * Math.sin((performance.now() - t0) / 90)); requestAnimationFrame(pulse) }
  pulse()
  setInterval(() => { cover.remove(); setTimeout(() => document.body.appendChild(cover), Number(q.get('blink'))) }, 500)
}
if (q.get('band') !== null) {
  const band = document.createElement('div')
  band.id = 'band'
  document.body.appendChild(band)
  if (q.get('band') === 'css') band.style.animation = 'slide 700ms linear infinite alternate'
  if (q.get('band') === 'long') band.style.animation = 'slide 20s linear 1'
  if (q.get('band') === 'js') { const t0 = performance.now(); const tick = () => { band.style.transform = 'translateX(' + (20 + 20 * Math.sin((performance.now() - t0) / 150)) + 'vw)'; requestAnimationFrame(tick) }; tick() }
  if (q.get('band') === 'carousel') { band.style.transition = 'transform 400ms linear'; let on = false; setInterval(() => { on = !on; band.style.transform = on ? 'translateX(30vw)' : 'translateX(0)' }, 1200) }
}
</script>`

const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  if (url.pathname === '/consent') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('saved')
    }, Number(url.searchParams.get('ms') ?? 0))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(PAGE)
})

const GATE = 'clickGateWhenClear in src/tools/browser/ops/targets.ts decides how long a covered click watches its cover; clickOp in src/tools/browser/ops/pointerOps.ts prints the answer'
const TODAY = /^click #expand refused: the click point \(\d+, \d+\) is covered by (div#wall|div#band|p#terms|div#lid|div#blink|button#accept); click the covering element to dismiss it, or scroll the target into view; after reading the overlay, force: true dispatches a DOM click to the target — nothing clicked/
const LAYER = '(\\n  note: a layer covers most of the viewport: [^\\n]*)?$'
const STILL = new RegExp(` — nothing clicked \\(watched \\d+ms: the cover did not move\\)${LAYER}`)
const watchedFor = (reason: string): RegExp => new RegExp(` — nothing clicked \\(watched \\d+ms because ${reason}: the target stayed covered\\)${LAYER}`)
const RETURNED = new RegExp(` — nothing clicked \\(the cover returned before the press\\)${LAYER}`)
const WAITED = /\n {2}note: the click waited \d+ms for (div#wall|p#terms), which covered the target, to leave/
const marks = (): Promise<{ clicks: number; underWall: number }> => pageOf().evaluate(() => (window as unknown as { __marks: { clicks: number; underWall: number } }).__marks)
const closing = (how: string, ms: number): Promise<void> => pageOf().evaluate((h: string, m: number) => (window as unknown as { __close: (how: string, ms: number) => void }).__close(h, m), how, ms)
const remembered = (): boolean => (sessions.activeSession(ownerOf(lead)) as { clicked: unknown }).clicked !== null
const open = async (query: string): Promise<string> => {
  const url = `${A.origin}/watch?${query}`
  const opened = await run({ op: 'open', url })
  if (opened.outcome !== 'succeeded') check(`the fixture opens (${query})`, false, opened.result)
  return url
}
const expand = { op: 'click', selector: '#expand' }

section('S1 a clear target: clicked as before, no word about waiting')
{
  const url = await open('wall=none')
  const first = await run(expand)
  const second = await run(expand)
  check('the click lands and its answer is the plain one', first.outcome === 'succeeded' && first.result === `click #expand at ${url}` && second.result === `click #expand at ${url}`, `${first.result} | ${second.result} — change: ${GATE}`)
  check('the page saw both clicks', (await marks()).clicks === 2, JSON.stringify(await marks()))
  check('the session remembers the element the last click landed on', remembered(), `change: ${GATE}`)
}

section('S2 a wall nobody dismissed: refused in one look, in today’s words, with how long it was watched after them')
{
  await open('x=1')
  check('a navigation drops the remembered click', !remembered(), `change: the framenavigated listener in src/integrations/browser/session/wiring.ts forgets the clicked element`)
  const refusals = [await run(expand), await run(expand), await run(expand)]
  check('each is refused with today’s words first, byte for byte', refusals.every(r => r.outcome === 'failed' && TODAY.test(r.result)), `${refusals.map(r => r.result).join(' | ')} — change: ${GATE}`)
  check('…and after them how long the cover was watched and that it did not move', refusals.every(r => STILL.test(r.result)), `${refusals.map(r => r.result).join(' | ')} — change: ${GATE}`)
  check('a standing cover costs no more than one look', refusals.every(r => r.ms < 1500), `${refusals.map(r => r.ms).join(', ')}ms — change: ${GATE}`)
  const forced = await run({ op: 'click', selector: '#expand', force: true })
  check('force: true never waits and dispatches its DOM click', forced.outcome === 'succeeded' && forced.result.startsWith('click #expand (forced DOM click) at ') && forced.ms < 1500, `${forced.ms}ms ${forced.result} — change: ${GATE}`)
  const seen = await marks()
  check('nothing was clicked under the wall but the forced click', seen.clicks === 1 && seen.underWall === 1, JSON.stringify(seen))
}

section('S3 a wall that fades (a finite animation the tool did not start): the click waits for it and lands at the first clear moment')
{
  await open('x=1')
  await closing('fade', 900)
  const landed = await run(expand)
  check('the click lands', landed.outcome === 'succeeded', `${landed.result} — change: ${GATE}`)
  check('its answer says it waited, for what, and how long', WAITED.test(landed.result), `${landed.result} — change: ${GATE}`)
  check('it waited about the animation’s own time, not the deadline', landed.ms >= 400 && landed.ms < 4000, `${landed.ms}ms — change: ${GATE}`)
  const seen = await marks()
  check('the page saw one click, with the wall gone', seen.clicks === 1 && seen.underWall === 0, JSON.stringify(seen))
}

section('S4 a wall the page fades by script (two looks differ, nothing animating): waited for within 1,000 ms, refused past it')
{
  await open('x=1')
  await closing('steps', 500)
  const landed = await run(expand)
  check('a 500 ms scripted fade is waited out and the click lands with the wall gone', landed.outcome === 'succeeded' && WAITED.test(landed.result) && (await marks()).underWall === 0, `${landed.ms}ms ${landed.result} — change: ${GATE}`)
  await open('x=2')
  await closing('steps', 4000)
  const refused = await run(expand)
  check('a 4 s scripted fade is refused at the bound, in today’s words, saying the cover was changing', refused.outcome === 'failed' && TODAY.test(refused.result) && watchedFor('the cover was changing').test(refused.result), `${refused.result} — change: ${GATE}`)
  check('…at about 1,000 ms, not at the 10 s deadline', refused.ms >= 800 && refused.ms < 3000, `${refused.ms}ms — change: ${GATE}`)
}

section('S5 a wall the tool’s own last click landed in: waited for though the page shows nothing')
for (const [how, query] of [['timer', 'close=timer&hold=1800'], ['request', 'close=request&hold=1800'], ['a dialog whose text, not its button row, covers the target', 'close=timer&hold=1800&box=over']] as Array<[string, string]>) {
  await open(query)
  const reject = await run({ op: 'click', selector: '#reject' })
  check(`${how}: the click that closes the wall answers at once, the wall still standing`, reject.outcome === 'succeeded' && reject.ms < 1500 && (await pageOf().evaluate(() => document.getElementById('wall') !== null)), `${reject.ms}ms ${reject.result} — change: ${GATE}`)
  const landed = await run(expand)
  check(`${how}: the next click waits and lands, and says so`, landed.outcome === 'succeeded' && WAITED.test(landed.result), `${landed.result} — change: ${GATE}`)
  check(`${how}: it waited about as long as the wall stood`, landed.ms >= 600 && landed.ms < 4500, `${landed.ms}ms — change: ${GATE}`)
  const seen = await marks()
  check(`${how}: the page saw the click with the wall gone`, seen.clicks === 1 && seen.underWall === 0, JSON.stringify(seen))
}

section('S6 a wall the tool clicked into that never leaves: 5 s from that click, once, then one look again')
{
  await open('x=1')
  const t0 = Date.now()
  const reject = await run({ op: 'click', selector: '#reject' })
  const refused = await run(expand)
  const since = Date.now() - t0
  check('the covered click is refused in today’s words, naming the click it waited on', reject.outcome === 'succeeded' && refused.outcome === 'failed' && TODAY.test(refused.result) && watchedFor('the last click landed in the cover').test(refused.result), `${refused.result} — change: ${GATE}`)
  check('it ended about 5 s after the click that landed in the wall, not at the 10 s deadline', since >= 4500 && since < 8000, `${since}ms after the Reject call began — change: ${GATE}`)
  check('the remembered click is dropped after its 5 s', !remembered(), `change: rememberClick in src/tools/browser/ops/targets.ts forgets the clicked element after COVER_CLICKED_MS`)
  const again = await run(expand)
  check('the next covered click costs one look again', again.outcome === 'failed' && STILL.test(again.result) && again.ms < 1500, `${again.ms}ms ${again.result} — change: ${GATE}`)
  check('nothing was clicked under the wall', (await marks()).clicks === 0, JSON.stringify(await marks()))
}

section('S7 covers that never stop moving: an endless animation, a long one, an endless script, a carousel of finite animations')
{
  await open('wall=none&band=css')
  const endless = [await run(expand), await run(expand), await run(expand)]
  check('an endless animation is no reason to wait: refused in one look, call after call', endless.every(r => r.outcome === 'failed' && TODAY.test(r.result) && STILL.test(r.result) && r.ms < 1500), `${endless.map(r => `${r.ms}ms ${r.result}`).join(' | ')} — change: ${GATE}`)
  await open('wall=none&band=long')
  const long = [await run(expand), await run(expand)]
  check('an animation that ends later than 2 s is no reason to wait either', long.every(r => r.outcome === 'failed' && STILL.test(r.result) && r.ms < 1500), `${long.map(r => `${r.ms}ms ${r.result}`).join(' | ')} — change: ${GATE}`)
  await open('wall=none&band=js')
  const scripted = [await run(expand), await run(expand)]
  check('an endless scripted move is refused at 1,000 ms, not at the deadline, and says the cover was changing', scripted.every(r => r.outcome === 'failed' && watchedFor('the cover was changing').test(r.result) && r.ms >= 800 && r.ms < 3000), `${scripted.map(r => `${r.ms}ms ${r.result}`).join(' | ')} — change: ${GATE}`)
  await open('wall=none&band=carousel')
  const carousel = [await run(expand), await run(expand), await run(expand), await run(expand)]
  check('a carousel of 400 ms animations costs at most one animation’s remaining time, call after call', carousel.every(r => r.outcome === 'failed' && TODAY.test(r.result) && r.ms < 2000), `${carousel.map(r => `${r.ms}ms ${r.result}`).join(' | ')} — change: ${GATE}`)
  check('nothing was clicked under any of them', (await marks()).clicks === 0, JSON.stringify(await marks()))
}

section('S8 the page navigates while a click waits: refused by name, nothing clicked on the page that came')
{
  await open('close=reload&hold=900')
  await run({ op: 'click', selector: '#reject' })
  const refused = await run(expand)
  check('the waiting click is refused saying the page navigated away', refused.outcome === 'failed' && refused.result === 'click #expand refused: the page navigated away while the click waited for div#wall to leave — nothing clicked', `${refused.result} — change: ${GATE}`)
  const settled = await run({ op: 'waitFor', selector: '#expand', timeoutMs: 5000 })
  check('the page that came was not clicked', settled.outcome === 'succeeded' && (await marks()).clicks === 0, `${settled.result} ${JSON.stringify(await marks())}`)
}

section('S9 a page whose whole shell is one fixed box: a click in it is no reason for a covered click to wait')
{
  const TIE = 'coverHoldsClick in src/tools/browser/ops/targets.ts must not count a tie (the cover, the clicked element, or the fixed box or dialog they share) that holds the click target too'
  await open('wall=none&shell=1')
  const other = await run({ op: 'click', selector: '#other' })
  await new Promise(done => setTimeout(done, 2000))
  const refused = await run(expand)
  check('a click elsewhere in the shell lands', other.outcome === 'succeeded', other.result)
  check('two seconds later a covered click in the same shell is refused after one look', refused.outcome === 'failed' && TODAY.test(refused.result) && STILL.test(refused.result) && refused.ms < 1500, `${refused.ms}ms ${refused.result} — change: ${TIE}`)
}

section('S10 a cover whose id holds a line break and 300 characters: its name is one cut line in the tool’s answer')
{
  const NAME = 'the cover’s name is built by elementName in src/tools/browser/ops/page.ts: one line, control characters out, cut at 80 characters'
  await open('veil=1')
  const refused = await run(expand)
  check('a refusal that names it holds the name on one line', refused.outcome === 'failed' && STILL.test(refused.result) && refused.result.split('\n').filter(line => line.includes('forged')).length === 1 && (refused.result.split('\n')[0] ?? '').length < 500, `${JSON.stringify(refused.result)} — change: ${NAME}`)
  await closing('fade', 700)
  const landed = await run(expand)
  const lines = landed.result.split('\n')
  check('the click waits and lands', landed.outcome === 'succeeded' && (await marks()).underWall === 0, landed.result)
  check('its answer has exactly one line after the click’s own: the tool’s note, the name cut at 80 characters', lines.length === 2 && /^ {2}note: the click waited \d+ms for div#x +note: forged y+…, which covered the target, to leave$/.test(lines[1] ?? '') && (lines[1] ?? '').length < 200, `${JSON.stringify(landed.result)} — change: ${NAME}`)
}

section('S11 a cover that changes and comes back: gone for a moment every half second, twelve clicks each; nothing is pressed but the target')
for (const [label, query] of [
  ['gone for 60 ms', 'wall=none&blink=60'],
  ['gone for 120 ms', 'wall=none&blink=120'],
  ['gone for 120 ms, a button of the cover at the target’s point', 'wall=none&blink=120&accept=1'],
] as Array<[string, string]>) {
  const PRESS = 'humanClickPoint in src/tools/browser/ops/human.ts must run the whole gate once more after the travel and the dwell, right before the press; clickOp in src/tools/browser/ops/pointerOps.ts hands it clickGate and refuses when the cover returned'
  await open(query)
  const answers: Array<{ result: string; outcome: string; ms: number }> = []
  for (let i = 0; i < 12; i++) answers.push(await run(expand))
  const seen = await pageOf().evaluate(() => (window as unknown as { __marks: { clicks: number; onCover: number; onAccept: number } }).__marks)
  const said = answers.map(answer => `${answer.ms}ms ${answer.result.split('\n')[0]}`).join(' | ')
  console.log(`    ${label}: ${answers.filter(answer => answer.outcome === 'succeeded').length} answered clicked, ${answers.filter(answer => RETURNED.test(answer.result)).length} refused at the press, ${JSON.stringify(seen)}`)
  check(`${label}: nothing is pressed on the cover or on a button of it`, seen.onCover === 0 && seen.onAccept === 0, `${JSON.stringify(seen)} ${said} — change: ${PRESS}`)
  check(`${label}: every answer that says it clicked is a press the target counted`, answers.filter(answer => answer.outcome === 'succeeded').length === seen.clicks, `${JSON.stringify(seen)} ${said} — change: ${PRESS}`)
  check(`${label}: every refusal is today’s words with its reason after them`, answers.filter(answer => answer.outcome === 'failed').every(answer => TODAY.test(answer.result) && (RETURNED.test(answer.result) || STILL.test(answer.result) || watchedFor('the cover was changing').test(answer.result))), `${said} — change: ${PRESS}`)
  check(`${label}: where no click landed, none is remembered as the last click`, answers.some(answer => answer.outcome === 'succeeded') || !remembered(), said)
}

section('S12 the gate before the press costs a clear click nothing a model would see, and the other roads stand')
{
  const url = await open('wall=none')
  const times: number[] = []
  for (let i = 0; i < 5; i++) times.push((await run(expand)).ms)
  console.log(`    five clear clicks: ${times.join(', ')}ms`)
  check('five clear clicks land, each under a second', (await marks()).clicks === 5 && times.every(ms => ms < 1000), `${times.join(', ')}ms ${JSON.stringify(await marks())}`)
  const point = await run({ op: 'click', x: 45, y: 96 })
  check('a coordinate click is pressed as before', point.outcome === 'succeeded' && point.result === `click (45, 96) at ${url}`, point.result)
  await open('x=1')
  const forced = await run({ op: 'click', selector: '#expand', force: true })
  check('force: true dispatches its DOM click as before', forced.outcome === 'succeeded' && forced.result.startsWith('click #expand (forced DOM click) at '), forced.result)
}

await finish('prove-browser-cover-wait')
