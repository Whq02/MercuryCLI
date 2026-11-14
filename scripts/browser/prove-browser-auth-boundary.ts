#!/usr/bin/env bun
import { check, finish, lead, ownerOf, pageOf, requireBrowser, run, serve, sessions } from './harness.ts'

await requireBrowser()
const password = 'boundary-fixture-value'
const basic = `Basic ${Buffer.from(`reader:${password}`).toString('base64')}`
const a = 'http://127.0.0.1:27287'
const b = 'http://127.0.0.1:27288'
const handler = (other: string) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
  const path = req.url?.split('?')[0] ?? '/'
  if (path === '/redirect') { res.writeHead(302, { location: `${other}/private` }); res.end(); return }
  if (path === '/private' && req.headers.authorization !== basic) { res.writeHead(401, { 'www-authenticate': 'Basic realm="boundary"' }); res.end('locked'); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(`<meta name="viewport" content="width=device-width, initial-scale=1"><title>loaded</title>${path === '/embedded' ? `<img src="${other}/private"><iframe src="${other}/private"></iframe>` : '<p>loaded</p>'}`)
}
const A = await serve(27287, handler(b))
const B = await serve(27288, handler(a))
await run({ op: 'open', url: `${a}/private` })
const combined = await run({ op: 'viewport', emulation: { device: 'Pixel 5', credentials: { username: 'reader', password } } })
check('credentials are live before the same call reloads for its device', combined.outcome === 'succeeded' && pageOf().url() === `${a}/private` && !combined.result.includes('site did not load'), combined.result)
if (pageOf().url().startsWith('chrome-error:')) await run({ op: 'reload' })
check('the bound origin receives its credentials', A.hits.some(hit => hit.headers.authorization === basic))
for (const path of ['/embedded', '/redirect']) {
  const answer = await run({ op: 'open', url: `${a}${path}` })
  check(`${path} is bounded while another origin challenges`, answer.ms < 10_000, answer.result)
}
await pageOf().goto(`${b}/private`).catch(() => undefined)
check('navigation, redirect, sub-resource and frame never sent the bound credentials to B', B.hits.filter(hit => hit.url === '/private').length >= 4 && B.hits.every(hit => hit.headers.authorization !== basic), String(B.hits.length))
await run({ op: 'open', url: `${a}/public` })
const kit = sessions.pageKitOf(pageOf())!
const paused: number[] = []
const waits: number[] = []
const pending = new Map<string, number>()
kit.cdp!.on('Fetch.requestPaused', (event: { requestId: string }) => { paused.push(performance.now()); pending.set(event.requestId, performance.now()) })
const send = kit.cdp!.send.bind(kit.cdp)
kit.cdp!.send = (async (method: string, params: { requestId?: string }) => {
  const result = await send(method as never, params as never)
  if (method === 'Fetch.continueRequest' && params?.requestId && pending.has(params.requestId)) waits.push(performance.now() - pending.get(params.requestId)!)
  return result
}) as typeof kit.cdp.send
const fetches = async (): Promise<void> => { await pageOf().evaluate(async () => { for (let i = 0; i < 12; i++) await (await fetch(`/probe?n=${i}`, { cache: 'no-store' })).text() }) }
await fetches()
check('credentials pause each request for the authentication road', paused.length >= 12 && waits.length >= 12, `${paused.length} pauses, ${waits.length} completed continues`)
console.log(`authentication interception: ${waits.length} continues, median ${[...waits].sort((x, y) => x - y)[Math.floor(waits.length / 2)]?.toFixed(3)} ms, max ${Math.max(...waits).toFixed(3)} ms`)
const reset = await run({ op: 'viewport', emulation: { reset: true } })
check('reset names the cached-credential exception and its origin', reset.result.includes(`what the browser already answered for ${a} stays answered until this browser closes`), reset.result)
const mark = paused.length
await fetches()
check('without credentials no request pauses on this road', paused.length === mark, String(paused.length - mark))
const headerSet = await run({ op: 'viewport', emulation: { headers: { Authorization: 'fixture-header', Cookie: 'fixture=value' } } })
await pageOf().goto(`${b}/public`)
const received = B.hits.findLast(hit => hit.url === '/public')?.headers
check('credential-named extra headers ride other origins, as ordinary extra headers', headerSet.outcome === 'succeeded' && received?.authorization === 'fixture-header' && received.cookie === 'fixture=value')
await run({ op: 'viewport', emulation: { headers: { 'Proxy-Authorization': 'fixture-proxy' } } })
const proxy = await pageOf().goto(`${b}/proxy`).then(() => 'loaded', (error: Error) => error.message)
console.log(`Proxy-Authorization extra header: ${proxy}; requests reaching the server: ${B.hits.filter(hit => hit.url === '/proxy').length}`)
await run({ op: 'viewport', emulation: { reset: true } })
await pageOf().goto(`${b}/public`)
const cleared = B.hits.findLast(hit => hit.url === '/public')?.headers
check('reset clears all extra headers', cleared !== undefined && cleared.authorization === undefined && cleared.cookie === undefined && cleared['proxy-authorization'] === undefined)
await finish('prove-browser-auth-boundary')
