import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { activeSession, disposeBrowserOwner } = await import('../../src/services/browser/browserSession.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'frames', lane: 'main' })
const context = { owner, abortController: new AbortController() } as never
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(req.url === '/child' ? `<!doctype html><title>Child</title><button onclick="this.textContent='Clicked'">Save</button><input aria-label="Name"><input type="password" aria-label="Password"><div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Deep</button>'</script>` : `<!doctype html><title>Frames</title><div style="position:relative;width:200px;height:50px"><button id="covered" onclick="this.textContent='Forced'" style="width:200px;height:50px">Covered</button><div id="overlay" style="position:absolute;inset:0">Overlay</div></div><button disabled id="disabled">Disabled</button><iframe title="Child" src="http://localhost:${(server.address() as AddressInfo).port}/child"></iframe>`)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
const run = async (input: Record<string, unknown>) => (await BrowserTool.call(input as never, context)).data
try {
  const opened = await run({ op: 'open', url })
  assert.equal(opened.outcome, 'succeeded', opened.result)
  const s = activeSession(owner)!
  const framed = { op: 'click', frame: 1, selector: 'aria/Save[role="button"]', timeoutMs: 500 }
  const permission = await BrowserTool.checkPermissions(framed as never, context)
  check('cross-origin frame asks for its own origin', permission.behavior === 'ask' && permission.message.includes('http://localhost:'), JSON.stringify(permission))
  const clicked = await run(framed)
  check('frame button is clicked by index', clicked.outcome === 'succeeded', clicked.result)
  const typed = await run({ op: 'type', frame: '/child', selector: 'aria/Name[role="textbox"]', text: 'Ada', clear: true, timeoutMs: 500 })
  check('frame input is typed by URL substring', typed.outcome === 'succeeded', typed.result)
  const text = await run({ op: 'extract', frame: 1 })
  check('frame text is extracted', text.result.includes('Clicked'), text.result)
  const tree = await run({ op: 'extract', frame: 1, mode: 'tree' })
  check('frame tree exposes typed value', tree.result.includes('Ada'), tree.result)
  const deep = await run({ op: 'click', frame: 1, selector: '#shadow >>> button', timeoutMs: 500 })
  check('shadow selectors work inside a frame', deep.outcome === 'succeeded', deep.result)
  const credential = await run({ op: 'type', frame: 1, selector: 'input[type=password]', text: 'not-a-secret', timeoutMs: 500 })
  check('frame plaintext credential gate remains closed', credential.outcome === 'failed' && credential.result.includes('credential field'), credential.result)
  const wait = await run({ op: 'waitFor', frame: 1, selector: '#shadow', state: 'attached', timeoutMs: 500 })
  check('frame selector waits use the chosen frame', wait.outcome === 'succeeded', wait.result)
  const scoped = await run({ op: 'extract', frame: 1, selector: 'button' })
  check('scoped frame reads resolve inside the frame', scoped.result.includes('Clicked'), scoped.result)
  await s.page.evaluate(() => {
    const frame = document.querySelector('iframe')!
    const box = frame.getBoundingClientRect()
    const cover = document.createElement('div')
    cover.id = 'frame-cover'
    Object.assign(cover.style, { position: 'fixed', left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: '999' })
    document.body.append(cover)
  })
  const parentCover = await run({ op: 'click', frame: 1, selector: 'button' })
  check('an embedding-page overlay is detected too', parentCover.outcome === 'failed' && parentCover.result.includes('frame-cover'), parentCover.result)
  await s.page.evaluate(() => document.querySelector('#frame-cover')!.remove())
  await s.page.evaluate(async () => {
    const frame = document.createElement('iframe')
    frame.sandbox.add('allow-scripts')
    frame.src = '/child'
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve() })
    document.body.append(frame)
    await loaded
  })
  const opaque = await BrowserTool.checkPermissions({ op: 'type', frame: 2, selector: 'input[type=password]', secretRef: 'FIXTURE' }, context)
  check('sandboxed frames cannot borrow their URL origin for secrets', opaque.behavior === 'deny' && opaque.message.includes('opaque:'), JSON.stringify(opaque))
  await s.page.frames().filter(frame => frame.parentFrame() !== null)[1]!.evaluate(origin => { Object.defineProperty(window, 'origin', { value: origin }) }, new URL(url).origin)
  const spoofed = await BrowserTool.checkPermissions({ op: 'type', frame: 2, selector: 'input[type=password]', secretRef: 'FIXTURE' }, context)
  check('page scripts cannot forge the frame origin', spoofed.behavior === 'deny' && spoofed.message.includes('opaque:'), JSON.stringify(spoofed))
  await BrowserTool.checkPermissions({ op: 'click', frame: 1, selector: 'button' }, context)
  await s.page.evaluate(async target => {
    const frame = document.querySelector('iframe')!
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve() })
    frame.src = target
    await loaded
  }, `${url}child`)
  const drift = await run({ op: 'click', frame: 1, selector: 'button' })
  check('frame origin drift between permission and act refuses', drift.outcome === 'failed' && drift.result.includes('between the permission check'), drift.result)
  const missing = await run({ op: 'extract', frame: 12 })
  check('missing frame is named, not silently the main page', missing.outcome === 'failed' && /frame.*12/.test(missing.result), missing.result)
  const covered = await run({ op: 'click', selector: '#covered' })
  check('covered click refuses with a usable remedy', covered.outcome === 'failed' && covered.result.includes('click the covering element to dismiss it, or scroll the target into view'), covered.result)
  const forced = await run({ op: 'click', selector: '#covered', force: true })
  check('explicit force dispatches the target click', forced.outcome === 'succeeded' && await s.page.$eval('#covered', el => el.textContent) === 'Forced', forced.result)
  const disabled = await run({ op: 'click', selector: '#disabled', force: true })
  check('force never enables a disabled control', disabled.outcome === 'failed' && disabled.result.includes('disabled'), disabled.result)
  const prompt = await BrowserTool.prompt()
  check('frame and force contracts are in the model prompt', prompt.includes('frame:') && prompt.includes('force: true') && !prompt.includes('selectors do not reach into frames'))
} finally {
  await disposeBrowserOwner(owner)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
process.exitCode = failures ? 1 : 0
