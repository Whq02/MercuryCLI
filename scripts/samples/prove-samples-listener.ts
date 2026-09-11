#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-samples-listener-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_SAMPLES
delete process.env.MERCURY_WORKSHOP

const { runWorkshopCell } = await import('../../src/services/workshop/runtime.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
const store = await import('../../src/services/samples/store.ts')
const listener = await import('../../src/services/samples/listener.ts')
const { getCommandQueue } = await import('../../src/utils/messageQueueManager.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — samples listener proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'mercury-samples-work-'))
const SESSION = 'samples-session'
const owner = makeOwnerKey({ workspace: workDir, sessionId: SESSION, lane: 'main' } as never)
const bridge = { inspect: async () => '', tool: async () => '', agent: async () => '' }
const run = (code: string) => runWorkshopCell({ owner, cwd: workDir, cell: { language: 'js', code }, bridge })

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}
function call(port: number, method: string, path: string, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
const firstLine = (cell: { outputTail: string[] }): string => cell.outputTail[0] ?? '{}'

section('B the bridge call keeps the page and answers its address')
const V1 = '<!doctype html><h1 id="price">Pricing — one</h1>'
const c1 = await run(`const kept = await mercury.sample({ name: 'Pricing table', html: ${JSON.stringify(V1)}, ask: 'show me the pricing table' })\nconsole.log(JSON.stringify(kept))`)
check('B1 the cell succeeds', c1.state === 'succeeded', JSON.stringify(c1).slice(0, 400))
const kept1 = JSON.parse(firstLine(c1)) as { id: string; version: number; url: string }
check(
  'B2 the call answers { id, version, url }: a short id, version 1, the loopback address with the token',
  /^[a-z0-9]{6,32}$/.test(kept1.id) && kept1.version === 1 && /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]+\?t=[0-9a-f]{32}$/.test(kept1.url),
  firstLine(c1),
)
check(
  'B3 the cell result lists the sample: title, version, address and the ask',
  c1.samples?.length === 1 &&
    c1.samples[0]!.id === kept1.id &&
    c1.samples[0]!.title === 'Pricing table' &&
    c1.samples[0]!.version === 1 &&
    c1.samples[0]!.url === kept1.url &&
    c1.samples[0]!.ask === 'show me the pricing table',
  JSON.stringify(c1.samples),
)
check('B4 the sample call counts as one bridge call', c1.nestedCalls === 1)
const record1 = store.getSample(SESSION, kept1.id)
check('B5 the record sits under the cell\'s session with the html as written', record1 !== null && record1.latestVersion === 1 && store.readVersion(SESSION, kept1.id, 1) === V1)
const V2 = '<!doctype html><h1 id="price">Pricing — two</h1>'
const c2 = await run(`const again = await mercury.sample({ name: 'pricing table', title: 'Pricing', html: ${JSON.stringify(V2)} })\nconsole.log(JSON.stringify(again))`)
const kept2 = JSON.parse(firstLine(c2)) as { id: string; version: number; url: string }
check(
  'B6 the same name from a later cell is version 2 of the same sample, at the same address',
  c2.state === 'succeeded' && kept2.id === kept1.id && kept2.version === 2 && kept2.url === kept1.url && c2.samples?.[0]?.title === 'Pricing' && c2.samples?.[0]?.ask === undefined,
  JSON.stringify(c2).slice(0, 400),
)
const c3 = await run("await mercury.sample({ name: 'no page' })")
check('B7 a call without html fails the cell with a plain reason and keeps nothing', c3.state === 'failed' && /needs the page as html/.test(c3.error ?? '') && store.listSamples(SESSION).length === 1, c3.error)
const c3b = await run("await mercury.sample('just a string')")
check('B7b a call without the object fails the same way', c3b.state === 'failed' && /takes one object/.test(c3b.error ?? ''), c3b.error)

section('L1 the listener')
const address = listener.sampleListenerAddress()
check('L1a the first sample bound the listener on a loopback port with a 32-hex token', address !== null && address.port > 0 && /^[0-9a-f]{32}$/.test(address.token))
const port = address!.port
const token = address!.token
const id = kept1.id
check('L1b sampleUrl is the listener\'s address for the sample, the one the cell got', store.sampleUrl(id) === `http://127.0.0.1:${port}/s/${id}?t=${token}` && kept1.url === store.sampleUrl(id))
check('L1c the token never lands beside the sample', !readFileSync(join(store.sampleDir(SESSION, id), 'sample.json'), 'utf8').includes(token))

section('L2 the token law: 404 and an empty body for everything without it')
const noToken = await call(port, 'GET', `/s/${id}`)
check('L2a no token → 404, empty', noToken.status === 404 && noToken.text === '')
const wrong = await call(port, 'GET', `/s/${id}?t=${'0'.repeat(32)}`)
check('L2b a wrong token → 404, empty', wrong.status === 404 && wrong.text === '')
const unknownPath = await call(port, 'GET', `/anything?t=${token}`)
check('L2c an unknown path with the token → 404, empty', unknownPath.status === 404 && unknownPath.text === '')
const unknownId = await call(port, 'GET', `/s/abcdef0123?t=${token}`)
check('L2d an unknown id with the token → 404, empty', unknownId.status === 404 && unknownId.text === '')
const root = await call(port, 'GET', '/')
check('L2e the root → 404, empty', root.status === 404 && root.text === '')
const traversal = await call(port, 'GET', `/s/..%2F..%2Fetc?t=${token}`)
check('L2f a path that is not an id → 404, empty', traversal.status === 404 && traversal.text === '')
check('L2g every refusal is no-store', [noToken, wrong, unknownPath, unknownId, root, traversal].every(r => r.headers['cache-control'] === 'no-store'))

section('L3 the right token answers the shell')
const shell = await call(port, 'GET', `/s/${id}?t=${token}`)
check('L3a the shell comes as html, no-store', shell.status === 200 && /^text\/html/.test(String(shell.headers['content-type'])) && shell.headers['cache-control'] === 'no-store', `${shell.status} ${String(shell.headers['content-type'])}`)
check('L3b the shell names the sample and its versions', shell.text.includes('Pricing') && shell.text.includes('v1') && shell.text.includes('v2') && shell.text.includes('version 2'))
check('L3c the shell fetches nothing from the network', !/https?:\/\//.test(shell.text))
check('L3d the shell\'s own addresses carry the token', shell.text.includes(`/s/${id}/v/2.html?t=${token}`))

section('L4 versions as written')
const v1 = await call(port, 'GET', `/s/${id}/v/1.html?t=${token}`)
const v2 = await call(port, 'GET', `/s/${id}/v/2.html?t=${token}`)
check('L4a v1 is served as written, as html', v1.status === 200 && v1.text === V1 && /^text\/html/.test(String(v1.headers['content-type'])))
check('L4b v2 is served as written', v2.status === 200 && v2.text === V2)
const v3 = await call(port, 'GET', `/s/${id}/v/3.html?t=${token}`)
check('L4c a missing version → 404, empty', v3.status === 404 && v3.text === '')
const v1NoToken = await call(port, 'GET', `/s/${id}/v/1.html`)
check('L4d a version without the token → 404, empty', v1NoToken.status === 404 && v1NoToken.text === '')

section('L5 the version list')
const versions = await call(port, 'GET', `/s/${id}/versions?t=${token}`)
const parsed = JSON.parse(versions.text) as { latestVersion: number; versions: Array<{ n: number; createdAt: unknown }> }
check(
  'L5a { latestVersion, versions: [{ n, createdAt }] }',
  versions.status === 200 && parsed.latestVersion === 2 && parsed.versions.map(v => v.n).join(',') === '1,2' && parsed.versions.every(v => typeof v.createdAt === 'string'),
  versions.text,
)
check('L5b as json, no-store', /^application\/json/.test(String(versions.headers['content-type'])) && versions.headers['cache-control'] === 'no-store')

section('L6 a marks post lands, moves the state, and queues ONE operator message')
const queuedBefore = getCommandQueue().length
const marksBody = JSON.stringify({
  version: 2,
  pins: [
    { x: 0.42, y: 0.1, target: 'h1#price "Pricing — two"', text: 'make it larger' },
    { x: 0.9, y: 0.5, target: 'td', text: 'align the numbers' },
  ],
  note: 'Tighten the whole table.',
  verdict: 'changes-needed',
})
const posted = await call(port, 'POST', `/s/${id}/marks?t=${token}`, marksBody)
const reply = JSON.parse(posted.text || '{}') as { ok?: boolean; delivered?: boolean; state?: string; count?: number }
check('L6a the post is taken: ok, delivered, the new state, the count', posted.status === 200 && reply.ok === true && reply.delivered === true && reply.state === 'changes-needed' && reply.count === 1, `${posted.status} ${posted.text}`)
const marksFile = join(store.sampleDir(SESSION, id), 'marks-v2.json')
const marksOnDisk = (): unknown[] => (existsSync(marksFile) ? (JSON.parse(readFileSync(marksFile, 'utf8')) as unknown[]) : [])
check('L6b the marks landed in marks-v2.json', marksOnDisk().length === 1)
check('L6c the record\'s state moved', store.getSample(SESSION, id)!.state === 'changes-needed')
const queued = getCommandQueue().slice(queuedBefore)
const expected = [
  'Marks on Pricing v2: 2 pins · 1 note · changes needed',
  '- at h1#price "Pricing — two": make it larger',
  '- at td: align the numbers',
  '',
  'Tighten the whole table.',
].join('\n')
check('L6d ONE operator message is queued, mode prompt, with the exact text', queued.length === 1 && queued[0]!.mode === 'prompt' && queued[0]!.value === expected, JSON.stringify(queued.map(q => q.value)))
check('L6e the queued message carries its own identity and reads as the operator\'s (no origin, no meta)', typeof queued[0]?.uuid === 'string' && queued[0]!.uuid.length > 0 && queued[0]!.origin === undefined && queued[0]!.isMeta !== true)
const approve = await call(port, 'POST', `/s/${id}/marks?t=${token}`, JSON.stringify({ version: 2, pins: [], note: '', verdict: 'approve' }))
check(
  'L6f an approve moves the state to approved and queues its own one-line message',
  approve.status === 200 && store.getSample(SESSION, id)!.state === 'approved' && getCommandQueue().length === queuedBefore + 2 && getCommandQueue()[queuedBefore + 1]!.value === 'Marks on Pricing v2: 0 pins · no note · approved',
  JSON.stringify(getCommandQueue().slice(queuedBefore).map(q => q.value)),
)

section('L7 refusals append nothing and queue nothing')
const notMarks = await call(port, 'POST', `/s/${id}/marks?t=${token}`, '{"version": 2, "pins": "none"}')
check('L7a a body that is not marks → 400, empty', notMarks.status === 400 && notMarks.text === '' && marksOnDisk().length === 2)
const badVersion = await call(port, 'POST', `/s/${id}/marks?t=${token}`, JSON.stringify({ version: 7, pins: [], note: '', verdict: null }))
check('L7b marks on a version that does not exist → 400', badVersion.status === 400 && marksOnDisk().length === 2)
const notJson = await call(port, 'POST', `/s/${id}/marks?t=${token}`, 'not json')
check('L7c a body that is not json → 400', notJson.status === 400)
const badVerdict = await call(port, 'POST', `/s/${id}/marks?t=${token}`, JSON.stringify({ version: 2, pins: [], note: '', verdict: 'maybe' }))
check('L7d a verdict outside the two words → 400', badVerdict.status === 400)
const huge = JSON.stringify({ version: 2, pins: [], note: 'x'.repeat(300 * 1024), verdict: null })
const over = await call(port, 'POST', `/s/${id}/marks?t=${token}`, huge)
check('L7e a body over 256 KB → 413, nothing appended', over.status === 413 && marksOnDisk().length === 2, String(over.status))
const postNoToken = await call(port, 'POST', `/s/${id}/marks`, marksBody)
check('L7f a marks post without the token → 404 and nothing appended', postNoToken.status === 404 && postNoToken.text === '' && marksOnDisk().length === 2)
const getMarks = await call(port, 'GET', `/s/${id}/marks?t=${token}`)
check('L7g the marks route answers GET with 404', getMarks.status === 404 && getMarks.text === '')
check('L7h the queue saw nothing from the refusals', getCommandQueue().length === queuedBefore + 2)
check('L7i the state stands', store.getSample(SESSION, id)!.state === 'approved')

section('L8 closing the listener')
await listener.closeSampleListener()
check('L8a the address is gone and sampleUrl has no listener to answer with', listener.sampleListenerAddress() === null && store.sampleUrl(id) === null)
let refused = false
try {
  await call(port, 'GET', `/s/${id}?t=${token}`)
} catch {
  refused = true
}
check('L8b the port no longer answers', refused)
const c4 = await run("const third = await mercury.sample({ name: 'pricing table', html: '<p>three</p>' })\nconsole.log(JSON.stringify(third))")
const kept3 = JSON.parse(firstLine(c4)) as { id: string; version: number; url: string }
const again = listener.sampleListenerAddress()
check(
  'L8c the next sample binds again with a NEW token, and the address follows',
  c4.state === 'succeeded' && again !== null && again.token !== token && kept3.version === 3 && kept3.url === `http://127.0.0.1:${again.port}/s/${id}?t=${again.token}`,
  `${JSON.stringify(kept3)} · ${JSON.stringify(again)}`,
)
const shellAgain = await call(again!.port, 'GET', `/s/${id}?t=${again!.token}`)
const oldTokenAgain = await call(again!.port, 'GET', `/s/${id}?t=${token}`)
check('L8d the new listener serves the shell and the old token is dead on it', shellAgain.status === 200 && shellAgain.text.includes('version 3') && oldTokenAgain.status === 404)
check('L8e a new version opened the sample again', store.getSample(SESSION, id)!.state === 'open')

section('P the poison — the token check bites')
const live = again!
const flipped = live.token.slice(0, 31) + (live.token.endsWith('0') ? '1' : '0')
check('P1 a token one character off → 404', (await call(live.port, 'GET', `/s/${id}?t=${flipped}`)).status === 404)
check('P2 a token one character short → 404', (await call(live.port, 'GET', `/s/${id}?t=${live.token.slice(0, 31)}`)).status === 404)
check('P3 a token one character long → 404', (await call(live.port, 'GET', `/s/${id}?t=${live.token}0`)).status === 404)
check('P4 the shell comparator bites: the shell is not the raw version', shell.text !== v1.text)
check('P5 the message comparator bites: a different verdict is a different message', expected !== expected.replace('changes needed', 'approved'))

await listener.closeSampleListener()
await disposeOwner(owner)

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ samples listener: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ samples listener: every law holds')
process.exit(0)
