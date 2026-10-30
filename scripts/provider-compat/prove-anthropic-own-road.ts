import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const goldenPath = join(import.meta.dir, 'fixtures/anthropic-sdk-road.json')
type Request = { path: string; method: string; headers: Record<string, string>; raw: string; body: unknown }
type Capture = { arm: string; requests: Request[]; outputs: unknown[]; errors: Record<string, unknown> }
const runtimeNeutral = (errors: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(errors).replaceAll('ECONNRESET: The socket connection was closed unexpectedly', 'The socket connection was closed unexpectedly')) as Record<string, unknown>
const HEADER_ALLOW_LIST = {
  host: 'The loopback fixture binds a new ephemeral port on each run.',
  'x-stainless-arch': 'Removed vendor SDK telemetry; not a protocol or identity header.',
  'x-stainless-lang': 'Removed vendor SDK telemetry; not a protocol or identity header.',
  'x-stainless-os': 'Removed vendor SDK telemetry; not a protocol or identity header.',
  'x-stainless-package-version': 'Removed vendor SDK telemetry; Mercury does not run that package.',
  'x-stainless-runtime': 'Removed vendor SDK telemetry; not a protocol or identity header.',
  'x-stainless-runtime-version': 'Removed vendor SDK telemetry; not a protocol or identity header.',
  'x-stainless-retry-count': 'Transport retries remain bounded; the SDK diagnostic header is not authentication.',
  'x-stainless-timeout': 'The same request deadline is enforced locally, not by this SDK diagnostic header.',
} as const

function sdkImports(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sdkImports(path)
    return /\.[cm]?[jt]sx?$/.test(entry.name) && /(?:from\s*|import\s*\(|require\s*\()['"]@anthropic-ai\/sdk/.test(readFileSync(path, 'utf8')) ? [path.slice(root.length + 1)] : []
  })
}
function capture(arm: string): Capture {
  const child = spawnSync(process.execPath, [join(import.meta.dir, 'anthropicRoadCapture.ts'), arm], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(child.status, 0, `${arm}: ${child.stderr}\n${child.stdout}`)
  const line = child.stdout.split('\n').find(row => row.startsWith('CAPTURE '))
  assert.ok(line, `${arm}: no capture`)
  return JSON.parse(line.slice(8)) as Capture
}
const withoutClientVersion = (text: string): string => text.replace(/cc_version=\d+\.\d+\.\d+\./g, 'cc_version=<release>.')
function comparable(request: Request): Request {
  assert.match(request.headers.host!, /^127\.0\.0\.1:\d+$/)
  return {
    ...request,
    raw: withoutClientVersion(request.raw),
    body: JSON.parse(withoutClientVersion(JSON.stringify(request.body))) as unknown,
    headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !(name in HEADER_ALLOW_LIST))),
  }
}
const actual = ['key', 'subscriber', 'bearer'].map(capture)
const imports = sdkImports(join(root, 'src'))
if (process.argv.includes('--record')) {
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), '5107b4f082287dfc6cb0ca7614f3caa7319d18c0')
  assert.equal(execFileSync('git', ['-C', root, 'diff', '--', 'src'], { encoding: 'utf8' }), '')
  assert.equal(imports.length, 11)
  mkdirSync(join(import.meta.dir, 'fixtures'), { recursive: true })
  writeFileSync(goldenPath, JSON.stringify({ base: '5107b4f082287dfc6cb0ca7614f3caa7319d18c0', captures: actual }, null, 2) + '\n')
  console.log('PASS recorded untouched SDK requests and error table on 5107b4f082')
} else {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { captures: Capture[] }
  for (const [index, current] of actual.entries()) {
    const before = golden.captures[index]!
    assert.equal(current.arm, before.arm)
    assert.deepEqual(current.requests.map(comparable), before.requests.map(comparable), `${current.arm}: request bytes changed`)
    assert.deepEqual(current.outputs, before.outputs, `${current.arm}: transcript or usage changed`)
    assert.deepEqual(runtimeNeutral(current.errors), runtimeNeutral(before.errors), `${current.arm}: error contract changed`)
    const source = readFileSync(join(root, 'src/constants/oauth.ts'), 'utf8')
    const version = /ANTHROPIC_CLIENT_CONTRACT_VERSION = '([^']+)'/.exec(source)?.[1]
    assert.ok(version)
    for (const request of current.requests) {
      assert.ok(request.raw.includes(`cc_version=${version}.`))
      assert.equal(request.headers['x-app'], 'cli')
      assert.equal(request.headers['x-claude-code-session-id'], '11111111-1111-4111-8111-111111111111')
      if (current.arm === 'subscriber') {
        assert.equal(request.headers.authorization, 'Bearer fixture-subscriber')
        assert.equal(request.headers['x-api-key'], undefined)
        assert.ok(request.headers['anthropic-beta']?.includes('oauth-2025-04-20'))
      }
    }
    console.log(`PASS ${current.arm}: ordered requests, transcript, usage, client identity and errors equal`)
  }
  assert.deepEqual(imports, [], 'product still imports the vendor SDK')
  for (const capture of actual) for (const request of capture.requests) {
    for (const header of Object.keys(HEADER_ALLOW_LIST).filter(name => name !== 'host')) assert.equal(request.headers[header], undefined, `${header}: vendor telemetry survived`)
  }
  console.log('PASS no vendor SDK import remains under src/')
  await import('./anthropicTransportChecks.ts')
}
