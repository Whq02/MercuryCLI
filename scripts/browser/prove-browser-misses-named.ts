#!/usr/bin/env bun
import http from 'node:http'
import { join } from 'node:path'

process.env.MERCURY_BROWSER ??= '1'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
const tool = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { BrowserTool } = tool
const { activeSession } = await import('../../src/services/browser/browserSession.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { call: browserCommand } = await import('../../src/commands/browser/browserCommand.ts')
const OWNER = processOwnerForLane(null)
type ToolInput = Parameters<typeof BrowserTool.call>[0]
const ctx = {} as Parameters<typeof BrowserTool.call>[1]
async function run(input: ToolInput): Promise<{ result: string; outcome: string; ms: number }> {
  const t0 = Date.now()
  const { data } = await BrowserTool.call(input, ctx)
  return { result: data.result, outcome: data.outcome, ms: Date.now() - t0 }
}

console.log('§1 the driver\'s timeout is recognised whatever the bundle calls its error class')
{
  const isDriverTimeout = (tool as { isDriverTimeout?: (err: unknown) => boolean }).isDriverTimeout
  check('the tool exports a timeout test that does not rely on the class name', typeof isDriverTimeout === 'function')
  if (isDriverTimeout) {
    const mangled = Object.assign(new Error('Timed out after waiting 10000ms'), { name: 'o' })
    check('a locator timeout with a mangled class name is a timeout', isDriverTimeout(mangled))
    const waited = Object.assign(new Error('Waiting failed: 2000ms exceeded'), { name: 'IQA' })
    check('a waitForFunction timeout with a mangled class name is a timeout', isDriverTimeout(waited))
    const named = Object.assign(new Error('anything'), { name: 'TimeoutError' })
    check('the named class still counts', isDriverTimeout(named))
    check('an ordinary error is not a timeout', !isDriverTimeout(new Error('Protocol error (Runtime.callFunctionOn): Target closed')))
  }
}

console.log('§2 the words that need no browser: the console clock, the scheme refusal, the /browser usage line')
{
  const localClock = (tool as { localClock?: (at: number) => string }).localClock
  check('the console ring prints the local clock, not UTC', typeof localClock === 'function', 'no localClock export')
  if (localClock) {
    const at = new Date(2026, 9, 12, 11, 21, 13, 604).getTime()
    check('…HH:MM:SS.mmm in the local zone', localClock(at) === '11:21:13.604', localClock(at))
  }
  const refusal = (tool as { openSchemeRefusal?: (url: string | undefined) => string }).openSchemeRefusal
  check('the open refusal names the scheme it was given', typeof refusal === 'function', 'no openSchemeRefusal export')
  if (refusal) {
    check('chrome://version is refused as chrome:, not as file://', /chrome: is not a web scheme/.test(refusal('chrome://version')) && !/file:\/\/ is not supported/.test(refusal('chrome://version')), refusal('chrome://version'))
    check('ftp:// names ftp:', /ftp: is not a web scheme/.test(refusal('ftp://127.0.0.1/')), refusal('ftp://127.0.0.1/'))
    check('javascript: names javascript:', /javascript: is not a web scheme/.test(refusal('javascript:alert(1)')), refusal('javascript:alert(1)'))
    check('about:blank names about:', /about: is not a web scheme/.test(refusal('about:blank')), refusal('about:blank'))
    check('file:// keeps its own words (serve the folder first)', /serve the folder first/.test(refusal('file:///tmp/x.html')) && /file:\/\/ is not supported/.test(refusal('file:///tmp/x.html')), refusal('file:///tmp/x.html'))
  }
  const direct = await BrowserTool.validateInput({ op: 'open', url: 'chrome://version' } as never, {} as never)
  check('validateInput carries the scheme words', direct.result === false && /chrome: is not a web scheme/.test(direct.message), JSON.stringify(direct))
  const help = await browserCommand('--help', {} as never)
  const helpText = help.type === 'text' ? help.value : ''
  check('/browser --help prints a usage line whose placeholders survive the renderer (no angle brackets)', helpText.includes('usage: /browser [status | install [build-id] [confirm] | remove build-id]') && !helpText.includes('<'), helpText)
  const bareRemove = await browserCommand('remove', {} as never)
  const bareRemoveText = bareRemove.type === 'text' ? bareRemove.value : ''
  check('/browser remove without an id names the placeholder without angle brackets', bareRemoveText.includes('usage: /browser remove build-id') && !bareRemoveText.includes('<'), bareRemoveText)
}

{
  const first = resolveBrowser()
  if (first.state !== 'ok') {
    const { resolveExecutionProfile } = await import('../lib/executionProfile.ts')
    if (resolveExecutionProfile(ROOT).kind === 'hosted-gate') {
      const { provisionManagedBrowserForTheGate } = await import('../lib/provisionManagedBrowser.ts')
      const provisioned = await provisionManagedBrowserForTheGate(line => console.log(line))
      const again = provisioned.ok ? resolveBrowser() : first
      if (again.state !== 'ok') {
        console.error(`  [FAIL] hosted gate has no drivable browser — ${again.note}`)
        process.exit(1)
      }
    } else {
      console.log(`__SUITE_SKIPPED browser: ${first.note}`)
      console.log(`  – no drivable browser on this machine — the real-engine legs SKIP; ${checks} hermetic checks ran, ${failures} failed`)
      process.exit(failures === 0 ? 0 : 1)
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/framed') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<title>framed</title><body><button id="inner-btn">Frame button</button></body>')
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<title>misses</title><body><h1>Misses</h1>
<input id="dis" disabled aria-label="Disabled field"><input id="ro" readonly value="frozen">
<select id="sel"><option value="a">Alpha</option></select>
<iframe id="frame" src="/framed" title="inner frame"></iframe>
<div id="host"></div>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<p>Inside shadow: MARKER-SHADOW-INNER-77</p><input id="deep" aria-label="Deep name"><button>Deep button</button><p>shadow idle</p>'</script>
</body>`)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const A = `http://127.0.0.1:${(server.address() as { port: number }).port}`

console.log('§3 a selector that matches nothing fails by name, at the deadline, on every act')
{
  const opened = await run({ op: 'open', url: `${A}/` })
  check('the fixture opens', opened.outcome === 'succeeded', opened.result)
  for (const [label, input] of [
    ['select', { op: 'select', selector: 'aria/Colour[role=combobox]', values: ['Purple'], timeoutMs: 600 }],
    ['type', { op: 'type', selector: 'aria/Name[role=textbox]', text: 'x', timeoutMs: 600 }],
    ['hover', { op: 'hover', selector: 'aria/Send[role=button]', timeoutMs: 600 }],
    ['click', { op: 'click', selector: 'text/Nowhere', timeoutMs: 600 }],
  ] as Array<[string, ToolInput]>) {
    const miss = await run(input)
    check(`${label}: the miss names the selector and the deadline`, miss.outcome === 'failed' && miss.result.includes(input.selector!) && miss.result.includes('600ms deadline') && !/Timed out after waiting/.test(miss.result), miss.result)
  }
  const textMiss = await run({ op: 'waitFor', text: 'NEVER APPEARS', timeoutMs: 500 })
  check('waitFor text: the miss names the text and the deadline', textMiss.outcome === 'failed' && textMiss.result.includes('NEVER APPEARS') && textMiss.result.includes('deadline 500ms exceeded'), textMiss.result)
}

console.log('§4 a selector the tree printed for framed content: no token offered, and the act fails at once naming the frame')
{
  const tree = await run({ op: 'extract', mode: 'tree' })
  const frameRow = tree.result.split('\n').find(l => l.includes('Iframe')) ?? ''
  const framedButton = tree.result.split('\n').find(l => l.includes('"Frame button"')) ?? ''
  check('the Iframe row names the frame parameter', /use frame with its index or URL substring/.test(frameRow), frameRow)
  check('the framed button carries no aria/ token', framedButton !== '' && !framedButton.includes('→ aria/'), framedButton)
  check('main-frame rows still carry their tokens', tree.result.includes('→ aria/Deep button[role="button"]'), tree.result)
  const click = await run({ op: 'click', selector: 'aria/Frame button[role="button"]', timeoutMs: 8000 })
  check('the click fails naming the child frame it lives in', click.outcome === 'failed' && /lives inside a child frame \(http:\/\/127\.0\.0\.1:\d+\/framed\)/.test(click.result), click.result)
  check('…and names the frame selector road', /set frame to its index from extract or a unique URL substring/.test(click.result), click.result)
  check('…at once, not after the deadline', click.ms < 3000, `${click.ms}ms`)
}

console.log('§5 shadow DOM text reaches extract and the page census')
{
  const text = await run({ op: 'extract', mode: 'text' })
  check('extract text crosses open shadow roots', text.result.includes('MARKER-SHADOW-INNER-77') && text.result.includes('shadow idle'), text.result)
  check('…and names the host it read', /\[shadow root of div#host\]/.test(text.result), text.result)
  const reopened = await run({ op: 'open', url: `${A}/` })
  const census = /page: (\d+) chars of body text/.exec(reopened.result)
  check('the census counts the shadow text (so a web-components page never reads as "still rendering")', census !== null && Number(census[1]) > 40, reopened.result)
}

console.log('§6 a point outside the viewport is refused by name; a disabled field refuses by its own name')
{
  const far = await run({ op: 'click', x: 5000, y: 5000 })
  check('a far point is refused naming the viewport', far.outcome === 'failed' && /outside the 1280x800 viewport/.test(far.result) && /nothing clicked/.test(far.result), far.result)
  const negative = await run({ op: 'click', x: -5, y: 10 })
  check('a negative point is refused', negative.outcome === 'failed' && /outside the 1280x800 viewport/.test(negative.result), negative.result)
  await run({ op: 'click', selector: '#ro' })
  const disabled = await run({ op: 'type', selector: '#dis', text: 'z', timeoutMs: 1500 })
  check('typing into a disabled input is refused as disabled, not as a focus miss', disabled.outcome === 'failed' && /#dis is disabled/.test(disabled.result) && !/holds focus instead/.test(disabled.result), disabled.result)
}

await run({ op: 'close' })
server.close()
console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.error(`browser misses named: ${failures} FAILURES`)
  process.exit(1)
}
console.log('prove-browser-misses-named: ALL LAWS HOLD')
