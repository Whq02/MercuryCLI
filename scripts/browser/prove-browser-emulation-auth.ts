#!/usr/bin/env bun
import type http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserTool, ROOT, check, decide, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions, validate } from './harness.ts'

await requireBrowser()

const PASSWORD = 'opensesame-27283'
const WRONG = 'wrongpass-27283'
const SECOND = 'second-27283'
const basic = (password: string): string => `Basic ${Buffer.from(`ada:${password}`).toString('base64')}`
const BASIC = basic(PASSWORD)
const handler =
  (other: string) =>
  (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    if (url.pathname === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' })
      res.end(JSON.stringify(req.headers))
      return
    }
    if (url.pathname === '/second' || url.pathname === '/third') {
      const ok = req.headers.authorization === basic(SECOND)
      res.writeHead(ok ? 200 : 401, { ...(ok ? {} : { 'www-authenticate': `Basic realm="${url.pathname.slice(1)}"` }), 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(`<title>${ok ? 'vault' : 'locked'}</title><p id="who">${ok ? 'welcome to the second realm' : 'locked'}</p>`)
      return
    }
    if (url.pathname === '/private' || url.pathname === '/pixel') {
      if (req.headers.authorization !== BASIC) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/html', 'cache-control': 'no-store' })
        res.end('<title>locked</title><p id="who">locked</p>')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(`<title>vault</title><p id="who">welcome ada</p><img src="${other}/pixel">`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(url.pathname === '/framed' ? '<title>framed</title><button id="inner">inner</button>' : `<title>open</title><p>public</p><iframe src="${other}/framed"></iframe>`)
  }
const A = await serve(27283, handler('http://127.0.0.1:27284'))
const B = await serve(27284, handler('http://127.0.0.1:27283'))

const said: string[] = []
const tell = async (input: Record<string, unknown> & { op: string }) => {
  const answer = await run(input)
  said.push(answer.result)
  return answer
}
const ask = async (input: Record<string, unknown> & { op: string }) => {
  const verdict = await permission(input)
  said.push(`${verdict.message ?? ''} ${JSON.stringify((verdict as { decisionReason?: unknown }).decisionReason ?? null)}`)
  return verdict
}
const tried = (fixture: typeof A, path: string, password: string): number =>
  fixture.hits.filter(hit => (hit.url ?? '').startsWith(path) && hit.headers.authorization === basic(password)).length
const sent = (fixture: typeof A, path: string): string[] =>
  fixture.hits.filter(hit => (hit.url ?? '').startsWith(path)).map(hit => (hit.headers.authorization === undefined ? 'none' : hit.headers.authorization === BASIC ? 'right' : 'wrong'))
const who = async (): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pageOf().$eval('#who', el => el.textContent ?? '')
    } catch (err) {
      if (attempt >= 20 || !/context was destroyed|Cannot find context|detached/i.test((err as Error).message)) return `unreadable: ${(err as Error).message}`
      await new Promise(done => setTimeout(done, 100))
    }
  }
}
const echo = (names: string[]): Promise<Array<string | null>> =>
  pageOf()
    .evaluate(async (wanted: string[]) => {
      try {
        const headers = (await (await fetch('/headers')).json()) as Record<string, string>
        return wanted.map(name => headers[name] ?? null)
      } catch (err) {
        return wanted.map(() => `unreadable: ${(err as Error).message}`)
      }
    }, names)
    .catch((err: Error) => names.map(() => `unreadable: ${err.message}`))
const visit = async (url: string): Promise<string> => {
  const outcome = await pageOf().goto(url).then(() => 'loaded', (err: Error) => err.message)
  for (let waited = 0; outcome !== 'loaded' && waited < 20 && !pageOf().url().startsWith('chrome-error://'); waited++) await new Promise(done => setTimeout(done, 50))
  return outcome
}
const credentials = (password: string) => ({ op: 'viewport', emulation: { credentials: { username: 'ada', password } } })
const ruleOf = (verdict: { suggestions?: unknown }): string | undefined =>
  (verdict.suggestions as Array<{ rules?: Array<{ ruleContent?: string }> }> | undefined)?.[0]?.rules?.[0]?.ruleContent

section('S1 a site behind basic authentication')
{
  const refused = await tell({ op: 'open', url: `${A.origin}/private` })
  check('the open that meets the challenge fails with the way forward', refused.outcome === 'failed' && refused.result === `open failed: net::ERR_INVALID_AUTH_CREDENTIALS at ${A.origin}/private — the site asks for basic credentials: op:"viewport" with emulation.credentials sets them, then op:"reload"`, refused.result)
  check('[E4] setting credentials or headers is not a read; a zone or a plain resize still is', BrowserTool.isReadOnly(credentials(PASSWORD) as never) === false && BrowserTool.isReadOnly({ op: 'viewport', emulation: { headers: { a: 'b' } } } as never) === false && BrowserTool.isReadOnly({ op: 'viewport', emulation: { timezone: 'Asia/Tokyo' } } as never) === true && BrowserTool.isReadOnly({ op: 'viewport', width: 900, height: 600 } as never) === true)
  const asked = await ask(credentials(PASSWORD))
  check('[E4] credentials meet the act approval of the origin whose address did not load: it is not approved yet, so they ask, as an act there asks', asked.behavior === 'ask' && asked.message === `Browser viewport with basic credentials for ada on ${A.origin} — its address did not load, not yet approved this session` && ruleOf(asked) === `origin:${A.origin}`, JSON.stringify(asked))
  const set = await tell(credentials(PASSWORD))
  check('[M10] the answer names the user and the one origin that is answered, never the password', set.outcome === 'succeeded' && set.result.includes(`  credentials: ada answers ${A.origin} only (password withheld)`), set.result)
  check('[E4] the approval the call met is the origin’s, held as an act’s is', sessions.originApproved(ownerOf(lead), A.origin) && (await ask(credentials(PASSWORD))).behavior === 'allow')
  const reloaded = await tell({ op: 'reload' })
  check('[M10] the reload is answered and the page loads', reloaded.outcome === 'succeeded' && reloaded.result.startsWith(`reload: ${A.origin}/private [200] — vault`) && (await who()) === 'welcome ada' && reloaded.ms < 10_000, `${reloaded.result} ${reloaded.ms}ms`)
  check('[M10] the server received the credentials once the challenge came', sent(A, '/private').slice(-1)[0] === 'right', sent(A, '/private').join(','))
  check('[E4] another origin’s challenge inside the page is not answered: it never receives the password', sent(B, '/pixel').length > 0 && sent(B, '/pixel').every(kind => kind === 'none'), sent(B, '/pixel').join(','))
  const info = await tell({ op: 'info' })
  check('[M12] info lists the credentials line', info.result.includes(`  credentials: ada answers ${A.origin} only (password withheld)`), info.result)
}

section('S2 another origin, a wrong password, and clearing')
{
  const elsewhere = await visit(`${B.origin}/private`)
  check('[E4] a page of another origin that challenges stays unanswered, and its server never sees the password', elsewhere.startsWith('net::ERR_INVALID_AUTH_CREDENTIALS') && sent(B, '/private').length > 0 && sent(B, '/private').every(kind => kind === 'none'), `${elsewhere} ${sent(B, '/private').join(',')}`)
  await visit(`${A.origin}/private`)
  check('[M11] back on the bound origin the credentials still answer', (await who()) === 'welcome ada')
  const wrong = await tell(credentials(WRONG))
  check('[M10] replacing credentials that were used says what the browser keeps', wrong.outcome === 'succeeded' && wrong.result.includes(`  note: this tab answers new challenges with the new credentials; what the browser already answered for ${A.origin} stays answered in every tab until it closes`), wrong.result)
  const locked = await visit(`${A.origin}/second`)
  check('[M10] a wrong password is tried once on a new challenge and the failure is the browser’s, with no loop', locked.startsWith('net::ERR_INVALID_AUTH_CREDENTIALS') && tried(A, '/second', WRONG) === 1, `${locked} tried=${tried(A, '/second', WRONG)}`)
  const again = await tell(credentials(SECOND))
  check('[E4] on the browser’s error page the credentials bind to the origin of the address that did not load', again.outcome === 'succeeded' && again.result.includes(`  credentials: ada answers ${A.origin} only (password withheld)`), again.result)
  const recovered = await tell({ op: 'reload' })
  check('[B02] the next call recovers: the reload is answered', recovered.outcome === 'succeeded' && (await who()) === 'welcome to the second realm', recovered.result)
  const cleared = await tell({ op: 'viewport', emulation: { credentials: null } })
  check('[M10] null clears them, and the answer says what the browser keeps', cleared.outcome === 'succeeded' && !cleared.result.includes('  credentials:') && cleared.result.includes(`  note: this tab no longer answers new challenges; what the browser already answered for ${A.origin} stays answered in every tab until it closes`), cleared.result)
  const unanswered = await visit(`${A.origin}/third`)
  check('[M10] a challenge that comes after the clearing is unanswered', unanswered.startsWith('net::ERR_INVALID_AUTH_CREDENTIALS') && tried(A, '/third', SECOND) + tried(A, '/third', WRONG) + tried(A, '/third', PASSWORD) <= 1 && A.hits.filter(hit => (hit.url ?? '').startsWith('/third')).length <= 2, `${unanswered}`)
  await visit(`${A.origin}/private`)
  check('[M10] and what the browser had answered stays answered, as the answer said', (await who()) === 'welcome ada')
}

section('S3 the password as a registered secret')
{
  process.env.MERCURY_BROWSER_SECRET_FIXTURE_AUTH = PASSWORD
  const input = { op: 'viewport', emulation: { credentials: { username: 'ada', secret: 'FIXTURE_AUTH' } } }
  const asked = await ask(input)
  check('[E4] a secret asks for its secret-and-origin pairing, the existing kind of ask', asked.behavior === 'ask' && asked.message === `Browser answer basic authentication on ${A.origin} with secret FIXTURE_AUTH as ada — the value never enters the conversation; approve exactly this secret-origin pairing` && ruleOf(asked) === `secret:FIXTURE_AUTH@${A.origin}`, JSON.stringify(asked))
  const denied = await decide(input, { mode: 'sovereign', deny: [`Browser(secret:FIXTURE_AUTH@${A.origin})`] })
  check('[E4] a deny rule on the pairing refuses in the mode that asks nothing', denied.behavior === 'deny' && (denied.message ?? '').startsWith(`Answering ${A.origin} with the secret FIXTURE_AUTH is denied by the rule`), JSON.stringify(denied))
  const sovereign = await decide(input, { mode: 'sovereign' })
  check('[E4] the mode that asks nothing asks nothing here either', sovereign.behavior === 'allow', JSON.stringify(sovereign))
  const set = await tell(input)
  check('[M10] the answer names the secret, never its value', set.outcome === 'succeeded' && set.result.includes(`  credentials: ada answers ${A.origin} only (secret FIXTURE_AUTH)`), set.result)
  await tell({ op: 'reload' })
  check('[M10] the secret answers the challenge', (await who()) === 'welcome ada' && sent(A, '/private').slice(-1)[0] === 'right')
  check('[E4] the pairing is approved for the session after its first use, as a fill’s is', (await ask(input)).behavior === 'allow' && sessions.secretPairingApproved(ownerOf(lead), 'FIXTURE_AUTH', A.origin))
  const missing = await tell({ op: 'viewport', emulation: { credentials: { username: 'ada', secret: 'NO_SUCH_SECRET' } } })
  check('[M10] an unregistered secret is refused in the existing words and changes nothing', missing.outcome === 'failed' && missing.result.startsWith('viewport refused: secret NO_SUCH_SECRET is not registered') && (await tell({ op: 'info' })).result.includes('(secret FIXTURE_AUTH)'), missing.result)
  const grammar = await validate({ op: 'viewport', emulation: { credentials: { username: 'ada', secret: 'lower-case' } } })
  check('a secret name outside the grammar is refused at validation in the existing sentence', !grammar.ok && grammar.message === 'emulation.credentials.secret "lower-case" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)', grammar.message)
  delete process.env.MERCURY_BROWSER_SECRET_FIXTURE_AUTH
  await tell({ op: 'viewport', emulation: { credentials: null } })
}

section('S4 extra headers')
{
  const allowed = await ask({ op: 'viewport', emulation: { headers: { 'X-Proof': 'one' } } })
  const set = await tell({ op: 'viewport', emulation: { headers: { 'X-Proof': 'one', 'x-flag': 'on' } } })
  const echoed = await echo(['x-proof', 'x-flag'])
  check('[M10][E4] on an approved origin headers need no further approval, and every request of the page carries them', allowed.behavior === 'allow' && set.outcome === 'succeeded' && set.result.includes('  headers: x-proof, x-flag') && JSON.stringify(echoed) === '["one","on"]', `${set.result} ${JSON.stringify(echoed)}`)
  const cleared = await tell({ op: 'viewport', emulation: { headers: null } })
  const gone = (await echo(['x-proof']))[0]
  check('[M10] null clears them', cleared.outcome === 'succeeded' && !cleared.result.includes('headers') && gone === null, `${cleared.result} ${gone}`)
  const invalid = await tell({ op: 'viewport', emulation: { headers: { 'bad name': 'x' }, timezone: 'Asia/Tokyo' } })
  check('[B02] a header the browser refuses is named, and the zone in the same call applies', invalid.outcome === 'failed' && invalid.result.includes('headers NOT applied (headers bad name)') && invalid.result.includes('  timezone: Asia/Tokyo') && !invalid.result.includes('  headers:'), invalid.result)
  await tell({ op: 'viewport', emulation: { reset: true } })
}

section('S5 the approval is the origin’s existing one')
{
  await visit(`${B.origin}/open`)
  const headers = { op: 'viewport', emulation: { headers: { 'x-two': '2' } } }
  const asked = await ask(headers)
  check('[E4] on an origin reached by navigation, headers ask exactly as a first act there asks', asked.behavior === 'ask' && asked.message === `Browser viewport on ${B.origin} with extra headers sent on every request, including other origins — reached by navigation, not yet approved this session` && ruleOf(asked) === `origin:${B.origin}`, JSON.stringify(asked))
  check('[E1] a zone, a device or a plain resize there asks nothing, as viewport never did', (await ask({ op: 'viewport', emulation: { timezone: 'Asia/Tokyo', device: 'Pixel 5' } })).behavior === 'allow' && (await ask({ op: 'viewport', width: 900, height: 600 })).behavior === 'allow')
  const sovereign = await decide(headers, { mode: 'sovereign' })
  const denied = await decide(headers, { mode: 'sovereign', deny: [`Browser(origin:${B.origin})`] })
  check('[E4] the mode that asks nothing lets it through, and an origin deny rule refuses it in that mode too', sovereign.behavior === 'allow' && denied.behavior === 'deny' && (denied.message ?? '').startsWith(`Browsing ${B.origin} is denied by the rule`), JSON.stringify([sovereign, denied]))
  await ask(headers)
  await visit(`${A.origin}/open`)
  const moved = await tell(headers)
  check('[T7] a check made for one origin does not land on the page that replaced it', moved.outcome === 'failed' && moved.result === `viewport refused: the page moved from ${B.origin} to ${A.origin} between the permission check and the act — nothing done; re-issue to ask for the new origin` && !(await tell({ op: 'info' })).result.includes('headers'), moved.result)
  await visit('about:blank')
  const blank = await tell(credentials(PASSWORD))
  check('[E4] with no web origin to answer, credentials are refused with the order of steps', blank.outcome === 'failed' && blank.result === 'viewport refused: credentials answer a web origin, and this page is about: content — op:"open" the site first (it fails while the site asks for credentials), set them, then op:"reload"', blank.result)
  check('headers on a blank page ask nothing, as an act on a blank page asks nothing', (await ask(headers)).behavior === 'allow')
}

section('S6 the card remembers the subject that was checked')
{
  const words = await import(join(ROOT, 'src/services/browser/browserWords.ts'))
  const remembered = (words as { checkedRuleContent?: (verdict: unknown, input: unknown) => string | null }).checkedRuleContent
  const cardSource = readFileSync(join(ROOT, 'src/components/permissions/BrowserPermissionRequest/BrowserPermissionRequest.tsx'), 'utf8')
  check('[T7] the card takes its remembered rule from the decision, and no longer reads the page that happens to be live', cardSource.includes('checkedRuleContent(toolUseConfirm.permissionResult, toolUseConfirm.input)') && !cardSource.includes('activeSession'))
  await visit(`${A.origin}/open`)
  await pageOf().waitForSelector('iframe')
  const frameAct = { op: 'click', frame: 1, selector: '#inner' }
  const frameAsk = await ask(frameAct)
  check('[T7] an act in a frame of another origin is checked against the frame’s origin', frameAsk.behavior === 'ask' && ruleOf(frameAsk) === `origin:${B.origin}`, JSON.stringify(frameAsk))
  check('[T7] the card’s remembered rule is that frame’s origin, not the page around it', remembered?.(frameAsk, frameAct) === `origin:${B.origin}`, String(remembered?.(frameAsk, frameAct)))
  process.env.MERCURY_BROWSER_SECRET_CARD_AUTH = PASSWORD
  await visit(`${B.origin}/open`)
  const pairing = { op: 'viewport', emulation: { credentials: { username: 'ada', secret: 'CARD_AUTH' } } }
  const pairingAsk = await ask(pairing)
  check('[T7] for credentials by secret the remembered rule is the pairing, never a whole-origin rule', remembered?.(pairingAsk, pairing) === `secret:CARD_AUTH@${B.origin}`, String(remembered?.(pairingAsk, pairing)))
  delete process.env.MERCURY_BROWSER_SECRET_CARD_AUTH
  const opening = { op: 'open', url: 'http://127.0.0.1:27299/never' }
  const openAsk = await ask(opening)
  check('an open keeps its origin rule, a page the browser conjured keeps none, a provision keeps none', remembered?.(openAsk, opening) === 'origin:http://127.0.0.1:27299' && remembered?.({ suggestions: [{ type: 'addRules', rules: [{ ruleContent: 'origin:data:' }] }] }, frameAct) === null && remembered?.({ suggestions: [{ type: 'addRules', rules: [{ ruleContent: 'origin:http://127.0.0.1:27299' }] }] }, { op: 'provision' }) === null, String(remembered?.(openAsk, opening)))
}

section('S7 the tab keeps them in another browser')
{
  await sessions.closeBrowserSession(ownerOf(lead))
  await tell({ op: 'open', url: `${A.origin}/open` })
  await tell({ op: 'viewport', emulation: { headers: { 'x-kept': 'yes' }, credentials: { username: 'ada', password: PASSWORD } } })
  const before = B.hits.length
  const moved = await tell({ op: 'open', url: `${B.origin}/open` })
  check('[M11] headers and credentials come with the tab, the credentials still bound to their origin', moved.outcome === 'succeeded' && moved.result.includes(`the emulation came with it before it loaded (headers, credentials for ${A.origin})`) && B.hits[before]?.headers['x-kept'] === 'yes', moved.result)
  await visit(`${A.origin}/private`)
  check('[M11] and they still answer that origin from the new browser', (await who()) === 'welcome ada')
  check('[E4] while the other origin was never sent the password', [...sent(B, '/pixel'), ...sent(B, '/private')].every(kind => kind === 'none'))
}

section('S8 the names, the wire and the silence')
{
  const shape = await validate({ op: 'viewport', emulation: { credentials: { username: 'ada' } } })
  check('[G2] a wrong shape of credentials is answered with the shape', !shape.ok && shape.message === 'emulation.credentials takes {username, password} or {username, secret} with a registered secret\'s name, or null to clear it', shape.message)
  const manual = await BrowserTool.prompt({} as never)
  check('[G2] the manual names the two fields', manual.includes('reducedMotion, headers (every request, including other origins), credentials {username, password or secret (a registered name)}, reset; devices lists the names.'), manual)
  const schema = (await import('zod/v4')).z.toJSONSchema(BrowserTool.inputSchema as never, { io: 'input' }) as { properties: Record<string, unknown> }
  check('[G2] and the wire did not grow for them', JSON.stringify(schema.properties.emulation) === '{"description":"viewport: overrides; omitted stays, null clears, reset restores launch defaults","type":"object","properties":{},"additionalProperties":{}}', JSON.stringify(schema.properties.emulation))
  said.push((await tell({ op: 'info' })).result, (await tell({ op: 'console' })).result, (await tell({ op: 'status' })).result)
  check('[E4] no answer, ask, info, console line or status of this whole run carries a password', said.length > 30 && said.every(text => ![PASSWORD, WRONG, SECOND, BASIC.slice(6), basic(SECOND).slice(6)].some(secret => text.includes(secret))), said.find(text => [PASSWORD, WRONG, SECOND].some(secret => text.includes(secret))) ?? '')
}

await finish('prove-browser-emulation-auth')
