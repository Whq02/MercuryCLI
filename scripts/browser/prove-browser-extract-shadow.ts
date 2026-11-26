#!/usr/bin/env bun
import type http from 'node:http'
import { check, finish, lead, requireBrowser, run, section, serve } from './harness.ts'

await requireBrowser()

const countOccurrences = (haystack: string, needle: string): number =>
  needle === '' ? 0 : haystack.split(needle).length - 1

const padBlock = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')} alpha beta gamma delta epsilon zeta eta theta iota kappa.`).join('\n')

const SHARED_PHRASE = 'INDEPENDENT-SHARED-PHRASE-42'
const synthBody = padBlock('SYNTH-LINE', 45)
const longBody = padBlock('LONG-DISTINCT-ROW', 260)

const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/long') {
    res.end(`<!doctype html><title>Long</title><body><pre>${longBody}</pre><div id="tail-host"></div><script>
const sr = document.getElementById('tail-host').attachShadow({ mode: 'open' });
sr.innerHTML = '<p>TAIL-SHADOW-MARKER-99</p>';
</script></body>`)
    return
  }
  res.end(`<!doctype html><title>Shadow Extract</title><body>
<main>
  <h1>VISIBLE-LIGHT-HEADING</h1>
  <p>${SHARED_PHRASE}</p>
  <div id="native-outer">
    <p>SLOTTED-OUTER-FRAGMENT</p>
    <div id="native-mid">
      <p>SLOTTED-MID-FRAGMENT</p>
      <div id="native-inner">
        <p>SLOTTED-INNER-FRAGMENT</p>
      </div>
    </div>
  </div>
  <div id="shadow-only-host"></div>
  <div style="display:none"><div id="hidden-host"></div></div>
  <div id="synth-l1">
    <div id="synth-l2">
      <div id="synth-l3">
        <article>${synthBody}</article>
      </div>
    </div>
  </div>
</main>
<script>
const o = document.getElementById('native-outer').attachShadow({ mode: 'open' });
o.innerHTML = '<style>.css-leak-token{color:red}</style><script>const scriptLeakToken = 1;</' + 'script><div style="display:none">HIDDEN-DIRECT-SHADOW</div><section><p>SHADOW-OUTER-FRAGMENT</p><slot></slot></section>';

const m = document.getElementById('native-mid').attachShadow({ mode: 'open' });
m.innerHTML = '<div style="display:contents"><p>SHADOW-MID-FRAGMENT</p><p style="display:none">HIDDEN-IN-DC</p><slot></slot></div>';

const i = document.getElementById('native-inner').attachShadow({ mode: 'open' });
i.innerHTML = '<p>SHADOW-INNER-FRAGMENT</p><p>${SHARED_PHRASE}</p><p style="visibility:hidden">VIS-HIDDEN-ONLY</p><slot></slot>';

const so = document.getElementById('shadow-only-host').attachShadow({ mode: 'open' });
so.innerHTML = '<style>.host-only-css{margin:0}</style><p hidden>HOST-ONLY-HIDDEN</p><p>HOST-ONLY-VISIBLE-88</p>';

const hh = document.getElementById('hidden-host').attachShadow({ mode: 'open' });
hh.innerHTML = '<p>HIDDEN-HOST-SHADOW-LEAK</p>';

for (const id of ['synth-l1', 'synth-l2', 'synth-l3']) {
  const el = document.getElementById(id);
  const polyfill = Object.create(ShadowRoot.prototype, {
    host: { get: () => el },
    mode: { get: () => 'open' },
    children: { get: () => el.children },
    childNodes: { get: () => el.childNodes },
    querySelectorAll: { value: selector => el.querySelectorAll(selector) },
  });
  Object.defineProperty(el, 'shadowRoot', { get: () => polyfill });
}
</script></body>`)
}

const site = await serve(0, handler)
const opened = await run({ op: 'open', url: `${site.origin}/` })
check('fixture page opens', opened.outcome === 'succeeded', opened.result)

section('S1 body extract keeps every visible fragment once, preserves legitimate repeats, blocks leaks and avoids false truncation')
{
  const ex = await run({ op: 'extract', mode: 'text' })
  const header = ex.result.split('\n')[0] ?? ''
  const charMatch = /(\d+) chars|of (\d+)/.exec(header)
  const totalChars = Number(charMatch?.[1] ?? charMatch?.[2] ?? '0')
  console.log(`  observed body extract: header="${header}" totalChars=${totalChars} synthLine1Count=${countOccurrences(ex.result, 'SYNTH-LINE-01')} sharedCount=${countOccurrences(ex.result, SHARED_PHRASE)}`)

  check('body extract is not falsely truncated under 15000 chars', !ex.result.includes('TRUNCATED') && totalChars > 3000 && totalChars < 8000, header)
  for (const fragment of [
    'VISIBLE-LIGHT-HEADING',
    'SLOTTED-OUTER-FRAGMENT',
    'SLOTTED-MID-FRAGMENT',
    'SLOTTED-INNER-FRAGMENT',
    'SHADOW-OUTER-FRAGMENT',
    'SHADOW-MID-FRAGMENT',
    'SHADOW-INNER-FRAGMENT',
    'HOST-ONLY-VISIBLE-88',
    'SYNTH-LINE-01',
    'SYNTH-LINE-45',
  ]) {
    const n = countOccurrences(ex.result, fragment)
    check(`fragment ${fragment} appears exactly once`, n === 1, `count=${n}`)
  }
  const sharedCount = countOccurrences(ex.result, SHARED_PHRASE)
  check('both independent equal phrases are preserved', sharedCount === 2, `count=${sharedCount}`)

  for (const leaked of [
    'css-leak-token',
    'scriptLeakToken',
    'HIDDEN-DIRECT-SHADOW',
    'HIDDEN-IN-DC',
    'VIS-HIDDEN-ONLY',
    'host-only-css',
    'HOST-ONLY-HIDDEN',
    'HIDDEN-HOST-SHADOW-LEAK',
  ]) {
    check(`hidden/style fragment ${leaked} does not leak`, !ex.result.includes(leaked), `leaked ${leaked}`)
  }
}

section('S2 selector rooted at a shadow host reads its own shadow root and descendants cleanly')
{
  const hostOnly = await run({ op: 'extract', mode: 'text', selector: '#shadow-only-host' })
  check('selector on shadow-only host returns its visible shadow text', hostOnly.result.includes('HOST-ONLY-VISIBLE-88') && hostOnly.result.includes('[shadow root of div#shadow-only-host]'), hostOnly.result)
  check('selector on shadow-only host does not leak style or hidden children', !hostOnly.result.includes('host-only-css') && !hostOnly.result.includes('HOST-ONLY-HIDDEN'), hostOnly.result)

  const outer = await run({ op: 'extract', mode: 'text', selector: '#native-outer' })
  for (const fragment of ['SLOTTED-OUTER-FRAGMENT', 'SHADOW-OUTER-FRAGMENT', 'SHADOW-MID-FRAGMENT', 'SHADOW-INNER-FRAGMENT']) {
    const n = countOccurrences(outer.result, fragment)
    check(`#native-outer extract includes ${fragment} once`, n === 1, `count=${n} result=${outer.result.slice(0, 400)}`)
  }
  check('#native-outer extract does not leak style or hidden shadow text', !outer.result.includes('css-leak-token') && !outer.result.includes('HIDDEN-DIRECT-SHADOW'), outer.result.slice(0, 400))
}

section('S3 truly long content still truncates at 15000 and continues cleanly by offset')
{
  const openedLong = await run({ op: 'open', url: `${site.origin}/long` })
  check('long page opens', openedLong.outcome === 'succeeded', openedLong.result)
  const first = await run({ op: 'extract', mode: 'text' })
  check('long page reports TRUNCATED to 15000', first.result.includes('TRUNCATED to 15000') && first.result.includes('continue with offset: 15000'), first.result.split('\n')[0] ?? '')
  check('first page starts with first row and omits tail marker', first.result.includes('LONG-DISTINCT-ROW-01') && !first.result.includes('TAIL-SHADOW-MARKER-99'), first.result.split('\n')[0] ?? '')
  const next = await run({ op: 'extract', mode: 'text', offset: 15000 })
  check('offset 15000 reaches the tail and shadow marker without truncation', !next.result.includes('TRUNCATED') && next.result.includes('LONG-DISTINCT-ROW-260') && next.result.includes('TAIL-SHADOW-MARKER-99'), next.result.split('\n')[0] ?? '')
}

await finish('prove-browser-extract-shadow', [lead])
