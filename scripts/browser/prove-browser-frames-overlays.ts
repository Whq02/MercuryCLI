import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_BROWSER ??= '1'
const { resolveBrowser } = await import('../../src/integrations/browser/browserResolver.ts')
{
  const resolved = await (async () => {
    const first = resolveBrowser()
    if (first.state === 'ok') return first
    const { resolveExecutionProfile } = await import('../lib/executionProfile.ts')
    if (resolveExecutionProfile(join(import.meta.dir, '..', '..')).kind === 'hosted-gate') {
      const { provisionManagedBrowserForTheGate } = await import('../lib/provisionManagedBrowser.ts')
      const provisioned = await provisionManagedBrowserForTheGate(line => console.log(line))
      const again = provisioned.ok ? resolveBrowser() : first
      if (again.state === 'ok') return again
      console.error(`FAIL hosted gate has no drivable browser — ${again.note}${provisioned.ok ? '' : `; provisioning failed: ${provisioned.note}`}`)
      process.exit(1)
    }
    console.log(`__SUITE_SKIPPED browser: ${first.note}`)
    console.log('  – no drivable browser on this machine — SKIP; the resolution law is pinned by scripts/language-sidecars/prove-browser-resolution.ts')
    process.exit(0)
  })()
  console.log(`  driving: ${resolved.source} — ${resolved.executablePath}`)
}
const { BrowserTool } = await import('../../src/tools/browser/BrowserTool.ts')
const { activeSession, disposeBrowserOwner } = await import('../../src/integrations/browser/browserSession.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
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
  const laidOut = await run({ op: 'waitFor', frame: 1, selector: 'button', state: 'visible', timeoutMs: 5000 })
  check('the child frame has laid out its button before the timed acts (a fresh bundle\'s first launch paints late)', laidOut.outcome === 'succeeded', `${laidOut.result} | to fix: waitFor with frame:1 must resolve the child frame; see targetSurface in src/tools/browser/ops/page.ts and waitForOp in src/tools/browser/ops/navigateOps.ts`)
  const s = activeSession(owner)!
  const framed = { op: 'click', frame: 1, selector: 'aria/Save[role="button"]', timeoutMs: 500 }
  const permission = await BrowserTool.checkPermissions(framed as never, context)
  check('cross-origin frame asks for its own origin', permission.behavior === 'ask' && permission.message.includes('http://localhost:'), `${JSON.stringify(permission)} | to fix: checkBrowserPermissions in src/tools/browser/ops/permissions.ts must ask for the frame's own origin (targetOrigin in src/tools/browser/ops/page.ts) when an act targets a cross-origin frame`)
  const clicked = await run(framed)
  check('frame button is clicked by index', clicked.outcome === 'succeeded', `${clicked.result} | to fix: the click op (case 'click' in src/tools/browser/ops/ops.ts) must act in the frame that targetSurface in src/tools/browser/ops/page.ts picks for frame:1`)
  const typed = await run({ op: 'type', frame: '/child', selector: 'aria/Name[role="textbox"]', text: 'Ada', clear: true, timeoutMs: 500 })
  check('frame input is typed by URL substring', typed.outcome === 'succeeded', `${typed.result} | to fix: targetSurface in src/tools/browser/ops/page.ts must match a string frame by URL substring, and the type op in src/tools/browser/ops/typeOp.ts must type inside it`)
  const text = await run({ op: 'extract', frame: 1 })
  check('frame text is extracted', text.result.includes('Clicked'), `${text.result} | to fix: the extract op (case 'extract' in src/tools/browser/ops/ops.ts) must read the frame chosen by frame:1 (targetSurface in src/tools/browser/ops/page.ts)`)
  const tree = await run({ op: 'extract', frame: 1, mode: 'tree' })
  check('frame tree exposes typed value', tree.result.includes('Ada'), `${tree.result} | to fix: extract mode:'tree' (case 'extract' in src/tools/browser/ops/ops.ts) must read the frame's tree including the typed value`)
  const deep = await run({ op: 'click', frame: 1, selector: '#shadow >>> button', timeoutMs: 500 })
  check('shadow selectors work inside a frame', deep.outcome === 'succeeded', `${deep.result} | to fix: resolveActTarget in src/tools/browser/ops/targets.ts must resolve the '>>>' shadow selector inside the chosen frame`)
  const credential = await run({ op: 'type', frame: 1, selector: 'input[type=password]', text: 'not-a-secret', timeoutMs: 500 })
  check('frame plaintext credential gate remains closed', credential.outcome === 'failed' && credential.result.includes('credential field'), `${credential.result} | to fix: the type op in src/tools/browser/ops/typeOp.ts must refuse plain text into a password field inside a frame and say it is a credential field`)
  const wait = await run({ op: 'waitFor', frame: 1, selector: '#shadow', state: 'attached', timeoutMs: 500 })
  check('frame selector waits use the chosen frame', wait.outcome === 'succeeded', `${wait.result} | to fix: waitForOp in src/tools/browser/ops/navigateOps.ts must wait on the frame given by frame:1 (targetSurface in src/tools/browser/ops/page.ts)`)
  const scoped = await run({ op: 'extract', frame: 1, selector: 'button' })
  check('scoped frame reads resolve inside the frame', scoped.result.includes('Clicked'), `${scoped.result} | to fix: the extract op with a selector (case 'extract' in src/tools/browser/ops/ops.ts) must resolve the selector inside the chosen frame`)
  await s.page.evaluate(() => {
    const frame = document.querySelector('iframe')!
    const box = frame.getBoundingClientRect()
    const cover = document.createElement('div')
    cover.id = 'frame-cover'
    Object.assign(cover.style, { position: 'fixed', left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: '999' })
    document.body.append(cover)
  })
  const parentCover = await run({ op: 'click', frame: 1, selector: 'button' })
  check('an embedding-page overlay is detected too', parentCover.outcome === 'failed' && parentCover.result.includes('frame-cover'), `${parentCover.result} | to fix: the covered-click check in src/tools/browser/ops/targets.ts must also test the embedding page's elements over the frame element and name the covering element`)
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
  check('sandboxed frames cannot borrow their URL origin for secrets', opaque.behavior === 'deny' && opaque.message.includes('opaque:'), `${JSON.stringify(opaque)} | to fix: targetOrigin in src/tools/browser/ops/page.ts must answer 'opaque:' for a sandboxed frame, and checkBrowserPermissions in src/tools/browser/ops/permissions.ts must deny a secretRef on it`)
  await s.page.frames().filter(frame => frame.parentFrame() !== null)[1]!.evaluate(origin => { Object.defineProperty(window, 'origin', { value: origin }) }, new URL(url).origin)
  const spoofed = await BrowserTool.checkPermissions({ op: 'type', frame: 2, selector: 'input[type=password]', secretRef: 'FIXTURE' }, context)
  check('page scripts cannot forge the frame origin', spoofed.behavior === 'deny' && spoofed.message.includes('opaque:'), `${JSON.stringify(spoofed)} | to fix: targetOrigin in src/tools/browser/ops/page.ts must not trust a window.origin the page script set; the frame stays 'opaque:'`)
  await BrowserTool.checkPermissions({ op: 'click', frame: 1, selector: 'button' }, context)
  await s.page.evaluate(async target => {
    const frame = document.querySelector('iframe')!
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve() })
    frame.src = target
    await loaded
  }, `${url}child`)
  const drift = await run({ op: 'click', frame: 1, selector: 'button' })
  check('frame origin drift between permission and act refuses', drift.outcome === 'failed' && drift.result.includes('between the permission check'), `${drift.result} | to fix: the origin recheck in src/tools/browser/ops/targets.ts must refuse an act whose frame origin changed since checkBrowserPermissions judged it`)
  const missing = await run({ op: 'extract', frame: 12 })
  check('missing frame is named, not silently the main page', missing.outcome === 'failed' && /frame.*12/.test(missing.result), `${missing.result} | to fix: targetSurface in src/tools/browser/ops/page.ts must throw naming the requested frame when no child frame matches`)
  const covered = await run({ op: 'click', selector: '#covered' })
  check('covered click refuses with a usable remedy', covered.outcome === 'failed' && covered.result.includes('click the covering element to dismiss it, or scroll the target into view'), `${covered.result} | to fix: the occluder message in src/tools/browser/ops/targets.ts must keep the remedy 'click the covering element to dismiss it, or scroll the target into view'`)
  const forced = await run({ op: 'click', selector: '#covered', force: true })
  check('explicit force dispatches the target click', forced.outcome === 'succeeded' && await s.page.$eval('#covered', el => el.textContent) === 'Forced', `${forced.result} | to fix: the click op in src/tools/browser/ops/ops.ts must dispatch the DOM click to the target when force:true on a covered element`)
  const disabled = await run({ op: 'click', selector: '#disabled', force: true })
  check('force never enables a disabled control', disabled.outcome === 'failed' && disabled.result.includes('disabled'), `${disabled.result} | to fix: the click op in src/tools/browser/ops/ops.ts must still refuse a disabled control with force:true and say it is disabled`)
  const prompt = await BrowserTool.prompt()
  const fields = BrowserTool.inputSchema.shape
  check('frame/force meanings live in fields and frame-coordinate depth stays in the manual', fields.frame.description?.includes('Acts use that frame origin') === true && fields.force.description?.includes('DOM click to a covered selector target') === true && prompt.includes('coordinate clicks stay in the main viewport'), 'to fix: the frame and force field descriptions in src/tools/browser/ops/schema.ts must keep the phrases "Acts use that frame origin" and "DOM click to a covered selector target", and the prompt in src/tools/browser/BrowserTool.ts must keep "coordinate clicks stay in the main viewport"')
} finally {
  await disposeBrowserOwner(owner)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
process.exitCode = failures ? 1 : 0
