#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type http from 'node:http'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { ROOT, check, finish, ownerOf, requireBrowser, section, serve, sessions } from './harness.ts'

await requireBrowser()

const DIST = process.env.PROVE_DIST ?? join(ROOT, 'dist')
const BUNDLE = join(DIST, 'mercury.mjs')
const RELEASE_NODE = join(DIST, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
let nodeMissing = ''
const NODE = existsSync(RELEASE_NODE)
  ? RELEASE_NODE
  : (() => {
      try {
        return nodeBinPath()
      } catch (error) {
        nodeMissing = (error as Error).message
        return ''
      }
    })()

const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>marks</title><p>marks</p>')
})

const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
const send = Connection.prototype._rawSend
let sourceText = ''
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
  const source = (params as { source?: unknown } | undefined)?.source
  if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof source === 'string' && source.includes('[native code]') && sourceText === '') sourceText = source
  return send.call(this, callbacks, method, params, session, ...rest)
}
const reference = { agentId: 'marked-names-reference' }
const bare = (await sessions.ensureBrowserSession(ownerOf(reference), { origin: A.origin, headless: true })) as { browser: { newPage(): Promise<Page> } }
Connection.prototype._rawSend = send

const FIND = `
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const text = readFileSync(process.env.MARKED_NAMES_BUNDLE, 'utf8')
const mark = text.indexOf('get webdriver')
let found = null
if (mark !== -1 && text.indexOf('get webdriver', mark + 1) === -1) {
  for (let from = text.lastIndexOf('function', mark); from !== -1 && mark - from < 20000 && found === null; from = from === 0 ? -1 : text.lastIndexOf('function', from - 1)) {
    for (let end = text.indexOf('}', mark); end !== -1 && end - mark < 40000; end = text.indexOf('}', end + 1)) {
      try {
        const made = vm.runInNewContext('(' + text.slice(from, end + 1) + ')')
        if (typeof made === 'function' && made.length === 1 && String(made).includes('[native code]')) found = String(made)
        break
      } catch {}
    }
  }
}
console.log(JSON.stringify({ text: found, node: process.version }))
`
const shipped = ((): { text: string; node: string } | { why: string } | { lost: string } => {
  if (!existsSync(BUNDLE)) return { why: `no built bundle at ${BUNDLE}` }
  if (NODE === '') return { why: `no Node to read the bundle with (${nodeMissing})` }
  const ran = spawnSync(NODE, ['--input-type=module', '-'], { input: FIND, env: { ...process.env, MARKED_NAMES_BUNDLE: BUNDLE }, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  try {
    const out = JSON.parse(ran.stdout) as { text: string | null; node: string }
    return out.text === null ? { lost: 'no function of the bundle stands around the one place it names the webdriver getter' } : { text: out.text, node: out.node }
  } catch {
    return { lost: `the read of the bundle ended ${ran.status ?? ran.signal}: ${(ran.stderr ?? '').slice(0, 300)}` }
  }
})()

const MARKS = `(() => {
  const d = (o, k) => { try { return Object.getOwnPropertyDescriptor(o, k) } catch (e) { return undefined } }
  const g = (o, k) => { const x = d(o, k); return x ? x.get : undefined }
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
  const runtime = window.chrome && window.chrome.runtime
  const port = (() => { try { return runtime && runtime.connect ? runtime.connect('abcdefghijklmnopabcdefghijklmnop') : undefined } catch (e) { return undefined } })()
  const first = (() => { try { return navigator.plugins[0] } catch (e) { return undefined } })()
  const list = {
    'Function.prototype.toString': Function.prototype.toString,
    'the getter of navigator.webdriver': g(Navigator.prototype, 'webdriver'),
    'the getter of navigator.language': g(Navigator.prototype, 'language'),
    'the getter of navigator.languages': g(Navigator.prototype, 'languages'),
    'chrome.app.getDetails': window.chrome && window.chrome.app && window.chrome.app.getDetails,
    'chrome.app.getIsInstalled': window.chrome && window.chrome.app && window.chrome.app.getIsInstalled,
    'chrome.app.runningState': window.chrome && window.chrome.app && window.chrome.app.runningState,
    'chrome.csi': window.chrome && window.chrome.csi,
    'chrome.loadTimes': window.chrome && window.chrome.loadTimes,
    'chrome.runtime.sendMessage': runtime && runtime.sendMessage,
    'chrome.runtime.connect': runtime && runtime.connect,
    'a port’s onMessage.addListener': port && port.onMessage && port.onMessage.addListener,
    'a port’s onMessage.dispatch': port && port.onMessage && port.onMessage.dispatch,
    'a port’s onMessage.hasListener': port && port.onMessage && port.onMessage.hasListener,
    'a port’s onMessage.hasListeners': port && port.onMessage && port.onMessage.hasListeners,
    'a port’s onMessage.removeListener': port && port.onMessage && port.onMessage.removeListener,
    'a port’s disconnect': port && port.disconnect,
    'a port’s postMessage': port && port.postMessage,
    'the getter of Notification.permission': typeof Notification === 'undefined' ? undefined : g(Notification, 'permission'),
    'Permissions.prototype.query': typeof Permissions === 'undefined' ? undefined : Permissions.prototype.query,
    'WebGLRenderingContext.prototype.getParameter': typeof WebGLRenderingContext === 'undefined' ? undefined : WebGLRenderingContext.prototype.getParameter,
    'WebGL2RenderingContext.prototype.getParameter': typeof WebGL2RenderingContext === 'undefined' ? undefined : WebGL2RenderingContext.prototype.getParameter,
    'item of an entry of navigator.plugins': first && (own(first, 'item') || Plugin.prototype.item),
    'namedItem of an entry of navigator.plugins': first && (own(first, 'namedItem') || Plugin.prototype.namedItem),
    'navigator.plugins.item': own(navigator.plugins, 'item') || PluginArray.prototype.item,
    'navigator.plugins.namedItem': own(navigator.plugins, 'namedItem') || PluginArray.prototype.namedItem,
    'navigator.plugins.refresh': own(navigator.plugins, 'refresh') || PluginArray.prototype.refresh,
    'navigator.mimeTypes.item': own(navigator.mimeTypes, 'item') || MimeTypeArray.prototype.item,
    'navigator.mimeTypes.namedItem': own(navigator.mimeTypes, 'namedItem') || MimeTypeArray.prototype.namedItem,
    'the getter of navigator.plugins': g(Navigator.prototype, 'plugins'),
    'the getter of navigator.mimeTypes': g(Navigator.prototype, 'mimeTypes'),
    'the getter of window.outerWidth': g(window, 'outerWidth'),
    'the getter of window.outerHeight': g(window, 'outerHeight'),
  }
  const out = {}
  for (const key of Object.keys(list)) {
    const fn = list[key]
    if (typeof fn !== 'function') { out[key] = null; continue }
    const name = d(fn, 'name')
    out[key] = { name: fn.name, length: fn.length, text: Function.prototype.toString.call(fn), shape: name ? [name.writable ? 'writable' : '', name.enumerable ? 'enumerable' : '', name.configurable ? 'configurable' : ''].filter(Boolean).join(' ') : 'none' }
  }
  return JSON.stringify(out)
})()`
const EVERY_BRANCH = `(() => {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get() { return true }, enumerable: true, configurable: true })
  Object.defineProperty(window, 'chrome', { value: {}, writable: true, enumerable: true, configurable: true })
  if (Notification.permission !== 'denied') Object.defineProperty(Notification, 'permission', { get() { return 'denied' }, enumerable: true, configurable: true })
  const none = Object.create(PluginArray.prototype)
  Object.defineProperty(none, 'length', { value: 0 })
  Object.defineProperty(Navigator.prototype, 'plugins', { get() { return none }, enumerable: true, configurable: true })
  return [navigator.webdriver, Object.keys(window.chrome).length, Notification.permission, navigator.plugins.length].join(' ')
})()`
interface Mark {
  name: string
  length: number
  text: string
  shape: string
}
type Marks = Record<string, Mark | null>
const RUNTIME: Record<string, string> = {
  'chrome.runtime.sendMessage': 'sendMessage',
  'chrome.runtime.connect': 'connect',
  'a port’s onMessage.addListener': 'addListener',
  'a port’s onMessage.dispatch': 'dispatch',
  'a port’s onMessage.hasListener': 'hasListener',
  'a port’s onMessage.hasListeners': 'hasListeners',
  'a port’s onMessage.removeListener': 'removeListener',
  'a port’s disconnect': 'disconnect',
  'a port’s postMessage': 'postMessage',
}
const fresh = async (): Promise<Page> => {
  const page = await bare.browser.newPage()
  await sessions.firstNavigation(bare, `${A.origin}/`, () => page.goto(`${A.origin}/`, { waitUntil: 'load' }))
  return page
}
const marksAfter = async (registered: string): Promise<{ staged: string; marks: Marks }> => {
  const page = await fresh()
  const staged = (await page.evaluate(EVERY_BRANCH)) as string
  await page.evaluate(registered)
  const marks = JSON.parse((await page.evaluate(MARKS)) as string) as Marks
  await page.close()
  return { staged, marks }
}

section('S0 Chrome’s own: a page of this browser that nothing prepared')
const plain = await fresh()
const natives = JSON.parse((await plain.evaluate(MARKS)) as string) as Marks
await plain.close()
const keys = Object.keys(natives)
const withNative = keys.filter(key => natives[key] !== null)
const without = keys.filter(key => natives[key] === null)
check(
  'this Chrome has a function of its own for every marked function but chrome.runtime’s nine, each with a name that is not writable, not enumerable and configurable',
  keys.length === 33 && without.join('|') === Object.keys(RUNTIME).join('|') && withNative.every(key => natives[key]!.shape === 'configurable'),
  `${keys.length} read; without one of Chrome’s own: ${without.join(', ')}; shapes: ${[...new Set(withNative.map(key => natives[key]!.shape))].join(' | ')}`,
)
console.log(`    33 marked functions (32 marks, getParameter on both WebGL contexts): ${withNative.length} stand beside Chrome’s own here, ${without.length} of chrome.runtime beside the key each is reached by`)

const read = async (what: string, registered: string): Promise<void> => {
  const { staged, marks } = await marksAfter(registered)
  const missing = keys.filter(key => marks[key] === null || marks[key] === undefined)
  check(`${what}: with every branch of the script made to run, all 33 marked functions are in the page`, staged === 'true 0 denied 0' && missing.length === 0, `staged ${staged}; missing: ${missing.join(', ')}`)
  const named = (key: string): string => (natives[key] === null ? RUNTIME[key]! : natives[key]!.name)
  const texted = (key: string): string => (natives[key] === null ? `function ${RUNTIME[key]}() { [native code] }` : natives[key]!.text)
  const present = keys.filter(key => !missing.includes(key))
  const misnamed = present.filter(key => marks[key]!.name !== named(key))
  check(`${what}: each reads the name Chrome’s own function reads, and where Chrome has none the key it is reached by`, missing.length === 0 && misnamed.length === 0, `${misnamed.length} of ${present.length}: ${misnamed.map(key => `${key} reads ${JSON.stringify(marks[key]!.name)} where ${JSON.stringify(named(key))} is read`).join(' ; ')}`)
  const mistexted = present.filter(key => marks[key]!.text !== texted(key))
  check(`${what}: each answers toString with the text Chrome’s own answers`, missing.length === 0 && mistexted.length === 0, mistexted.map(key => `${key} answers ${JSON.stringify(marks[key]!.text)} where ${JSON.stringify(texted(key))} is answered`).join(' ; '))
  const misshaped = present.filter(key => marks[key]!.shape !== 'configurable')
  check(`${what}: each name is not writable, not enumerable and configurable, as Chrome’s own`, missing.length === 0 && misshaped.length === 0, misshaped.map(key => `${key}: ${marks[key]!.shape}`).join(' ; '))
  const lengths = present.filter(key => natives[key] !== null && marks[key]!.length !== natives[key]!.length)
  check(`${what}: each declares as many parameters as Chrome’s own (holds on the parent too)`, missing.length === 0 && lengths.length === 0, lengths.map(key => `${key}: ${marks[key]!.length} where Chrome’s own declares ${natives[key]!.length}`).join(' ; '))
  console.log(`    ${what}: chrome.runtime’s nine declare ${Object.keys(RUNTIME).map(key => `${RUNTIME[key]} ${marks[key]?.length ?? '?'}`).join(', ')}`)
}

section('S1 the text the source registers')
check('a launch registers the script preparation, and its text is read from the wire', sourceText.includes('[native code]') && sourceText.endsWith(')'), `${sourceText.length} characters`)
await read('the source’s text', sourceText)

section('S2 the text the shipped bundle registers')
if ('why' in shipped) {
  console.log(`  [SKIP] the shipped bundle’s text reads the names the source’s reads (six checks) — ${shipped.why}`)
} else {
  check('the built bundle carries the script preparation, and Node gives the text it would register', 'text' in shipped, 'lost' in shipped ? shipped.lost : '')
  if ('text' in shipped) {
    const languages = sourceText.slice(sourceText.lastIndexOf(')(') + 1)
    console.log(`    the bundle’s function is ${shipped.text.length} characters under Node ${shipped.node} (${NODE === RELEASE_NODE ? 'the vendored one' : 'not the vendored one: this checkout has no release Node'}); the source’s text is ${sourceText.length} under this runtime`)
    await read('the shipped bundle’s text', `(${shipped.text})${languages}`)
  }
}

await finish('prove-browser-marked-names', [reference])
