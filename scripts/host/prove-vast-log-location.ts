import assert from 'node:assert/strict'
import { vastFixture } from './vastFixture.mjs'
import { VastClient } from '../../src/models/hosting/vendors/vast.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const fixture = await vastFixture()
const client = new VastClient(fixture.key, fixture.baseUrl)
const nativeFetch = globalThis.fetch
const remote: string[] = []
const canonical = 'https://s3.amazonaws.com/vast.ai/instance_logs/fixture.log'
const observed = 'https://s3.amazonaws.com/public.vast.ai/instance_logs/' + 'a'.repeat(64) + '.log'
const followed: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (request.url.startsWith(fixture.baseUrl + '/')) return nativeFetch(request)
  remote.push(request.url)
  if (request.url !== canonical && request.url !== observed) throw new Error('Unexpected external request')
  followed.push(request.redirect)
  assert.equal(request.headers.get('authorization'), null)
  return new Response('engine log\n' + fixture.key + '\nready\n')
}, nativeFetch)
let checks = 0
let failures = 0
const check = (name: string, truth: unknown, detail?: string): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' · ' + detail : '')) }
try {
  const refusal = async (url: string): Promise<string> => {
    fixture.state.logUrl = url
    try { await client.logs('7001', AbortSignal.timeout(3000)); return 'accepted' }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  const moved = await refusal('https://moved-logs.example/vast.ai/instance_logs/private-name.log?signature=never-print-this#private-fragment')
  check('a refused location names its origin and public path shape, not the signed URL', moved === 'unexpected log URL · https://moved-logs.example/vast.ai/instance_logs/:file.log', 'got ' + moved + '; fix the refusal message built in VastClient.logs in src/models/hosting/vendors/vast.ts so it carries only the origin and the :file shaped path')
  check('the diagnostic carries no query, filename or fragment secret', !/never-print-this|private-name|private-fragment|signature=/.test(moved), 'got ' + moved + '; VastClient.logs in src/models/hosting/vendors/vast.ts must drop the query, filename and fragment from the refusal')
  const userinfo = await refusal('https://private-user:private-password@moved-logs.example/private-directory/private-token.txt?key=private-key')
  check('userinfo and arbitrary path segments are not logged', userinfo === 'unexpected log URL · https://moved-logs.example/:segment/:file.txt' && !userinfo.includes('private-'), 'got ' + userinfo + '; VastClient.logs in src/models/hosting/vendors/vast.ts must use only url.origin and mask path segments as :segment or :file.ext')
  const invalid = await refusal('not a URL?signature=private-invalid')
  check('an invalid location never quotes the unparseable signed value', invalid === 'unexpected log URL · invalid URL', 'got ' + invalid + '; the new URL parse in VastClient.logs in src/models/hosting/vendors/vast.ts must throw the fixed text without the value')
  const movedBucket = await refusal('https://moved-logs.example/public.vast.ai/instance_logs/private-name.log?signature=never-print-this')
  check("a refused location under the vendor's public bucket name keeps that name in its shape and nothing private", movedBucket === 'unexpected log URL · https://moved-logs.example/public.vast.ai/instance_logs/:file.log', 'got ' + movedBucket + '; the path masking in VastClient.logs in src/models/hosting/vendors/vast.ts must keep the public.vast.ai part')
  const neighbours = ['https://s3.amazonaws.com/public.vast.ai.example/instance_logs/n.log', 'https://s3.amazonaws.com/private.vast.ai/instance_logs/n.log', 'https://s3.amazonaws.com/public.vast.ai/other_logs/n.log', 'https://public.vast.ai/instance_logs/n.log', 'http://s3.amazonaws.com/public.vast.ai/instance_logs/n.log', 'https://private-user@s3.amazonaws.com/public.vast.ai/instance_logs/n.log', 'https://s3.amazonaws.com/public.vast.ai/instance_logs/n.log#private-fragment']
  const answers: string[] = []
  for (const neighbour of neighbours) answers.push(await refusal(neighbour))
  check('another bucket, another folder, another host, plain http, userinfo and a fragment beside the public bucket are each refused', answers.every(answer => answer.startsWith('unexpected log URL · ')) && !answers.join(' ').includes('private-'), 'answers ' + JSON.stringify(answers) + '; tighten the allowed test in VastClient.logs in src/models/hosting/vendors/vast.ts (host, protocol, userinfo, hash, path prefix)')
  check('no refused URL was fetched', remote.length === 0, 'fetched ' + JSON.stringify(remote) + '; VastClient.logs in src/models/hosting/vendors/vast.ts must throw before its fetch when the location is not allowed')
  fixture.state.logUrl = canonical
  const log = await client.logs('7001', AbortSignal.timeout(3000))
  check('the existing allowed origin and path still return a redacted log without a bearer header', log.includes('ready') && !log.includes(fixture.key) && remote.length === 1 && remote[0] === canonical, 'log ' + JSON.stringify(log) + ', fetched ' + JSON.stringify(remote) + '; the allowed list and the redaction in VastClient.logs in src/models/hosting/vendors/vast.ts')
  fixture.state.logUrl = observed
  let today = ''
  try { today = await client.logs('7001', AbortSignal.timeout(3000)) } catch (error) { today = 'refused: ' + (error instanceof Error ? error.message : String(error)) }
  check("the location the vendor answers today, its public bucket, returns a redacted log without a bearer header", today.includes('ready') && !today.includes(fixture.key) && remote.length === 2 && remote[1] === observed, 'got ' + JSON.stringify(today) + ', fetched ' + JSON.stringify(remote) + '; the /public.vast.ai/instance_logs/ prefix must be allowed in VastClient.logs in src/models/hosting/vendors/vast.ts')
  check('a log location is read as given and a redirect from it is an error, at either bucket', followed.length === remote.length && followed.every(mode => mode === 'error'), 'redirect modes ' + JSON.stringify(followed) + ', fetched ' + remote.length + '; the fetch in VastClient.logs in src/models/hosting/vendors/vast.ts must pass redirect: error')
  console.log(`VAST LOG LOCATION ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failed; fixture responses only`)
} finally { globalThis.fetch = nativeFetch; await fixture.close() }
process.exitCode = failures ? 1 : 0
