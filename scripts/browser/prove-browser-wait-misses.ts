#!/usr/bin/env bun
import type http from 'node:http'
import { check, finish, pageOf, requireBrowser, run, section, serve } from './harness.ts'

await requireBrowser()

const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if ((req.url ?? '').startsWith('/framed')) {
    res.end('<!doctype html><title>framed</title><button id="inner">Frame button</button><p>frame words</p>')
    return
  }
  res.end(`<!doctype html><title>watch</title>
<style>#desc{display:none}</style>
<h1>Fixture video</h1>
<button id="expand" aria-expanded="false" aria-controls="desc">...more</button>
<div id="desc"><p>description words</p><section id="transcript"><button>Show transcript</button></section></div>
<iframe src="/framed" title="inner frame"></iframe>`)
})
const HERE = `${A.origin}/watch`
const WAIT = 'waitForOp in src/tools/browser/ops/navigateOps.ts must answer a wait that ran out with what was watched, where, and what stood instead'
const ONE = 'the sentence comes from selectorMissWords in src/tools/browser/ops/targets.ts, the one diagnosis the acts use'

section('S1 a selector that never satisfies the wait: the state watched, the page, and which of the three it was')
{
  const opened = await run({ op: 'open', url: HERE })
  check('the fixture opens', opened.outcome === 'succeeded', opened.result)
  const absent = await run({ op: 'waitFor', selector: '#nowhere', timeoutMs: 600 })
  check('absent: the answer names the state watched and the page', absent.outcome === 'failed' && absent.result.startsWith(`waitFor selector #nowhere (visible) failed at ${HERE}: `), `${absent.result} — change: ${WAIT}`)
  check('absent: it says no element came within the deadline, in the acts’ own sentence', absent.result.includes('no element for selector #nowhere within the 600ms deadline'), `${absent.result} — change: ${ONE}`)
  check('absent: it carries the frames diagnosis', absent.result.includes(`1 child frame(s) present (${A.origin}/framed); set frame to an index from extract or a unique URL substring`), `${absent.result} — change: ${ONE}`)
  check('absent: the wait ran its deadline and no longer than one bounded look at the frames', absent.ms >= 500 && absent.ms < 3000, `${absent.ms}ms — change: ${WAIT}`)
  const hidden = await run({ op: 'waitFor', selector: '#transcript button', timeoutMs: 600 })
  check('present but hidden: it says the element is there and never became visible', hidden.outcome === 'failed' && hidden.result.startsWith(`waitFor selector #transcript button (visible) failed at ${HERE}: #transcript button is present but never became visible within the 600ms deadline`), `${hidden.result} — change: ${ONE}`)
  const framed = await run({ op: 'waitFor', selector: '#inner', timeoutMs: 600 })
  check('inside a child frame: it names the frame and the frame road', framed.outcome === 'failed' && framed.result.startsWith(`waitFor selector #inner (visible) failed at ${HERE}: #inner lives inside a child frame (${A.origin}/framed); set frame to its index from extract or a unique URL substring`), `${framed.result} — change: ${ONE}`)
  const attached = await run({ op: 'waitFor', selector: '#nowhere', state: 'attached', timeoutMs: 600 })
  check('state attached: the answer names that state and the absent element', attached.outcome === 'failed' && attached.result.startsWith(`waitFor selector #nowhere (attached) failed at ${HERE}: no element for selector #nowhere within the 600ms deadline`), `${attached.result} — change: ${WAIT}`)
  const stays = await run({ op: 'waitFor', selector: '#expand', state: 'hidden', timeoutMs: 600 })
  check('state hidden on an element that stays: it says the element is still there', stays.outcome === 'failed' && stays.result === `waitFor selector #expand (hidden) failed at ${HERE}: #expand is still present and visible after the 600ms deadline`, `${stays.result} — change: ${WAIT}`)
  const inFrame = await run({ op: 'waitFor', selector: '#nowhere', frame: 1, timeoutMs: 600 })
  check('a wait inside a named frame is diagnosed in that frame', inFrame.outcome === 'failed' && inFrame.result.includes('no element for selector #nowhere within the 600ms deadline') && !inFrame.result.includes('lives inside a child frame'), `${inFrame.result} — change: ${ONE}`)
  const raw = [absent, hidden, framed, attached, stays, inFrame].filter(miss => /Waiting for selector|the event never arrived/.test(miss.result))
  check('no miss carries the driver’s sentence or the old catch-all', raw.length === 0, `${raw.map(miss => miss.result).join(' | ')} — change: ${WAIT}`)
  const there = await run({ op: 'waitFor', selector: '#expand', timeoutMs: 2000 })
  check('control: a wait that is satisfied answers as before', there.outcome === 'succeeded' && there.result.startsWith('waitFor selector #expand: present and visible after '), there.result)
  const click = await run({ op: 'click', selector: '#nowhere', timeoutMs: 600 })
  check('control: an act’s miss keeps its sentence', click.outcome === 'failed' && click.result === `click failed: no element for selector #nowhere within the 600ms deadline (the act auto-waits; the element never appeared); 1 child frame(s) present (${A.origin}/framed); set frame to an index from extract or a unique URL substring`, `${click.result} — change: ${ONE}`)
  const covert = await run({ op: 'click', selector: '#transcript button', timeoutMs: 600 })
  check('control: an act on a hidden target keeps its sentence', covert.outcome === 'failed' && covert.result.startsWith('click failed: #transcript button is present but never became visible within the 600ms deadline (hidden or zero-sized — acts need a visible target; waitFor state:"attached" can read its arrival)'), `${covert.result} — change: ${ONE}`)
}

section('S2 a text that never comes: how long, and where the text is when it is somewhere')
{
  const absent = await run({ op: 'waitFor', text: 'never here', timeoutMs: 600 })
  check('absent: the text, the page and the deadline', absent.outcome === 'failed' && absent.result === `waitFor text "never here" failed at ${HERE}: not in the page's rendered text within the 600ms deadline`, `${absent.result} — change: ${WAIT}`)
  const hidden = await run({ op: 'waitFor', text: 'Description  WORDS', timeoutMs: 600 })
  check('in hidden content: it says the page holds it unrendered', hidden.outcome === 'failed' && hidden.result === `waitFor text "Description  WORDS" failed at ${HERE}: not in the page's rendered text within the 600ms deadline; the page holds it in content that is not rendered (extract with a selector reads hidden content)`, `${hidden.result} — change: ${WAIT}`)
  const framed = await run({ op: 'waitFor', text: 'frame words', timeoutMs: 600 })
  check('in a child frame: it names the frame by index and address', framed.outcome === 'failed' && framed.result === `waitFor text "frame words" failed at ${HERE}: not in the page's rendered text within the 600ms deadline; child frame 1 (${A.origin}/framed) holds it (set frame to wait there)`, `${framed.result} — change: ${WAIT}`)
  const inFrame = await run({ op: 'waitFor', text: 'frame words', frame: 1, timeoutMs: 2000 })
  check('control: the same text is found with the frame set', inFrame.outcome === 'succeeded' && inFrame.result.startsWith('waitFor text "frame words": present after '), inFrame.result)
}

section('S3 a navigation that never comes: how long, and where the tab stayed')
{
  const stayed = await run({ op: 'waitFor', timeoutMs: 600 })
  check('the answer says no navigation came and names the page that stayed', stayed.outcome === 'failed' && stayed.result === `waitFor navigation failed: no navigation within the 600ms deadline; the tab stayed at ${HERE}`, `${stayed.result} — change: ${WAIT}`)
}

section('S4 a page whose script is held when the wait runs out: the answer comes within the deadline and one bounded look, not when the page lets go')
{
  const HELD_MS = 4000
  const BOUND = 'selectorMissWords and framedOnly in src/tools/browser/ops/targets.ts and textElsewhere in src/tools/browser/ops/navigateOps.ts must put each look after the deadline under MISS_LOOK_MS; a look that does not come back is no hint, never a longer wait'
  const answers = (): Promise<number> => pageOf().evaluate(() => 1)
  const hold = (): Promise<void> =>
    pageOf().evaluate((ms: number) => {
      setTimeout(() => {
        const until = performance.now() + ms
        while (performance.now() < until) continue
      }, 250)
    }, HELD_MS)
  for (const [label, input] of [
    ['a text', { op: 'waitFor', text: 'never here', timeoutMs: 600 }],
    ['a selector, visible', { op: 'waitFor', selector: '#nowhere', timeoutMs: 600 }],
    ['a selector, hidden', { op: 'waitFor', selector: '#expand', state: 'hidden', timeoutMs: 600 }],
  ] as Array<[string, { op: string } & Record<string, unknown>]>) {
    await answers()
    await hold()
    const miss = await run(input)
    console.log(`    ${label}: answered after ${miss.ms}ms — ${miss.result}`)
    check(`${label}: the wait answers within its 600 ms and one 1,000 ms look, the page held for ${HELD_MS} ms`, miss.outcome === 'failed' && miss.ms < 2600 && !/Waiting for selector|the event never arrived/.test(miss.result), `${miss.ms}ms ${miss.result} — change: ${BOUND}`)
  }
  await answers()
  const after = await run({ op: 'waitFor', selector: '#expand', timeoutMs: 2000 })
  check('control: the page answers again once its script lets go', after.outcome === 'succeeded', after.result)
}

await finish('prove-browser-wait-misses')
