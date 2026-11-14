#!/usr/bin/env bun
import { check, finish, requireBrowser, run, serve } from './harness.ts'

await requireBrowser()
const accepted = `Basic ${Buffer.from('reader:fixture-pass').toString('base64')}`
const A = await serve(0, (req, res) => {
  if (req.url?.startsWith('/auth') && req.headers.authorization !== accepted) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="tab-memory"' })
    res.end('authentication required')
    return
  }
  if (req.url === '/auth/redirect') { res.writeHead(302, { location: '/' }); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end('<title>accepted</title><p>ready</p>')
})
await run({ op: 'open', url: `${A.origin}/` })
await run({ op: 'open', tab: 'credentials', url: `${A.origin}/` })
const set = await run({ op: 'viewport', tab: 'credentials', emulation: { credentials: { username: 'reader', password: 'fixture-pass' } } })
check('setting credentials says the browser keeps its answer across every tab', set.result.includes(`; once answered, the browser answers ${A.origin} in every tab until it closes`), set.result)
const blank = await run({ op: 'info' })
check('a sibling with no answered challenge does not claim browser memory', !blank.result.includes("answered by the browser's memory"), blank.result)
await run({ op: 'open', tab: 'credentials', url: `${A.origin}/auth/first` })
const sibling = await run({ op: 'open', url: `${A.origin}/auth/sibling` })
const siblingInfo = await run({ op: 'info' })
const memory = `credentials: ${A.origin} — answered by the browser's memory until it closes`
check('a sibling actually sends the cached authorization', sibling.outcome === 'succeeded' && A.hits.find(req => req.url === '/auth/sibling')?.headers.authorization === accepted, sibling.result)
check('its empty emulation still discloses the browser memory', siblingInfo.result.includes(memory), siblingInfo.result)
const replaced = await run({ op: 'viewport', tab: 'credentials', emulation: { credentials: { username: 'other', password: 'unused-pass' } } })
check('replacement names new challenges separately from the earlier browser answer', replaced.result.includes(`this tab answers new challenges with the new credentials; what the browser already answered for ${A.origin} stays answered in every tab until it closes`), replaced.result)
const cleared = await run({ op: 'viewport', tab: 'credentials', emulation: { credentials: null } })
check('clear says only this tab stops answering new challenges', cleared.result.includes(`this tab no longer answers new challenges; what the browser already answered for ${A.origin} stays answered in every tab until it closes`), cleared.result)
await run({ op: 'viewport', tab: 'credentials', emulation: { credentials: { username: 'reader', password: 'fixture-pass' } } })
const reset = await run({ op: 'viewport', tab: 'credentials', emulation: { reset: true } })
check('reset keeps the same true scope', reset.result.includes(`this tab no longer answers new challenges; what the browser already answered for ${A.origin} stays answered in every tab until it closes`), reset.result)
await run({ op: 'close', tab: 'credentials' })
await run({ op: 'open', tab: 'credentials', url: `${A.origin}/auth/recreated` })
const recreated = await run({ op: 'info', tab: 'credentials' })
check('closing and recreating the tab drops its overrides but not the browser answer', recreated.result.includes(memory) && !recreated.result.includes('reader answers') && A.hits.find(req => req.url === '/auth/recreated')?.headers.authorization === accepted, recreated.result)
await run({ op: 'close' })
await run({ op: 'open', url: `${A.origin}/` })
check('closing the browser drops the remembered-origin receipt', !(await run({ op: 'info' })).result.includes("answered by the browser's memory"))
await run({ op: 'viewport', emulation: { credentials: { username: 'wrong', password: 'wrong' } } })
await run({ op: 'open', url: `${A.origin}/auth/rejected` })
await run({ op: 'open', tab: 'unanswered', url: `${A.origin}/` })
check('a rejected challenge never claims cached authentication on its sibling', !(await run({ op: 'info', tab: 'unanswered' })).result.includes("answered by the browser's memory"))
await run({ op: 'viewport', emulation: { credentials: { username: 'reader', password: 'fixture-pass' } } })
await run({ op: 'open', url: `${A.origin}/auth/redirect` })
check('a successful authenticated redirect records the same browser memory', (await run({ op: 'info', tab: 'unanswered' })).result.includes(memory))
check('all receipts withhold credential values', [set, siblingInfo, replaced, cleared, reset, recreated].every(answer => !answer.result.includes('fixture-pass') && !answer.result.includes('unused-pass')))
await finish('prove-browser-tab-auth-memory')
