import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const fence = resolve(import.meta.dir, 'loopbackOnly.ts')
const scratch = mkdtempSync(join(tmpdir(), 'loopback-only-'))
let checks = 0
const failureHint = ' · fix the fetch fence in scripts/host/loopbackOnly.ts (its fetch wrapper refuses a non-loopback host and endsRed makes the member exit 1; its exit handler prints the FAIL line)'
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? ': ' + detail : '') + failureHint); checks++; console.log('PASS ' + name) }

type Ask = { url: string; method?: string }
type Seen = { status: number | null; sent: string[]; answers: string[]; lines: string[]; all: string }
function run(name: string, asks: Ask[], ending = ''): Seen {
  const path = join(scratch, 'scripts', 'host', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, [
    'const sent: string[] = []',
    'globalThis.fetch = (async (input: string | URL | Request) => { sent.push(input instanceof Request ? input.url : String(input)); return new Response("{}") }) as typeof fetch',
    'await import(' + JSON.stringify(fence) + ')',
    'const answers: string[] = []',
    'for (const ask of ' + JSON.stringify(asks) + ' as { url: string; method?: string }[]) answers.push(await fetch(ask.url, { method: ask.method, headers: { Authorization: "Bearer fixture-key" } }).then(() => "answered", (error: Error) => "refused · " + error.message))',
    'console.log("SEEN " + JSON.stringify({ sent, answers }))',
    ending,
    '',
  ].join('\n'))
  const child = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 60_000 })
  const seen = /^SEEN (.+)$/m.exec(child.stdout)
  const parsed = seen ? JSON.parse(seen[1]!) as { sent: string[]; answers: string[] } : { sent: [], answers: [] }
  return { status: child.status, sent: parsed.sent, answers: parsed.answers, lines: child.stderr.split('\n').filter(line => line.startsWith('FAIL ')), all: child.stdout + child.stderr }
}

try {
  const asked = run('prove-asks-a-vendor.ts', [{ url: 'http://127.0.0.1:9/first' }, { url: 'https://api.runpod.io/v2/pods' }, { url: 'https://api.runpod.io/v2/pods' }, { url: 'https://console.vast.ai/api/v0/asks/', method: 'post' }, { url: 'http://localhost:9/last' }])
  check('a member that asks a vendor ends red', asked.status === 1, 'exit ' + asked.status + '\n' + asked.all)
  check('its one line names the member and each host it asked, once, with the method and the path', asked.lines.length === 1 && asked.lines[0] === 'FAIL scripts/host/prove-asks-a-vendor.ts asked a host that is not loopback: GET https://api.runpod.io/v2/pods, POST https://console.vast.ai/api/v0/asks/', asked.lines.join('\n') || asked.all)
  check('nothing was sent to the vendor, and the loopback requests before and after it were', asked.sent.join(' ') === 'http://127.0.0.1:9/first http://localhost:9/last', JSON.stringify(asked.sent))
  check('the request fails where it was made, with the member and the request in its words', asked.answers.length === 5 && asked.answers[0] === 'answered' && asked.answers[4] === 'answered' && asked.answers[1] === 'refused · scripts/host/prove-asks-a-vendor.ts asked a host that is not loopback; not sent: GET https://api.runpod.io/v2/pods' && asked.answers[3] === 'refused · scripts/host/prove-asks-a-vendor.ts asked a host that is not loopback; not sent: POST https://console.vast.ai/api/v0/asks/', JSON.stringify(asked.answers))
  const exits = run('prove-asks-then-exits-green.ts', [{ url: 'https://cloud.lambda.ai/api/v1/instance-types' }], 'process.exit(0)')
  check('a member that asks a vendor and then exits with code 0 by its own call still ends red, with its line', exits.status === 1 && exits.lines.length === 1 && exits.lines[0] === 'FAIL scripts/host/prove-asks-then-exits-green.ts asked a host that is not loopback: GET https://cloud.lambda.ai/api/v1/instance-types' && exits.sent.length === 0, 'exit ' + exits.status + '\n' + exits.all)
  const home = run('prove-stays-on-loopback.ts', [{ url: 'http://127.0.0.1:9/a' }, { url: 'http://[::1]:9/b' }, { url: 'http://localhost:9/c' }, { url: 'http://127.0.0.2:9/d' }])
  check('a member that stays on loopback ends green with no line, every request sent', home.status === 0 && home.lines.length === 0 && home.sent.length === 4 && home.answers.every(answer => answer === 'answered'), 'exit ' + home.status + '\n' + home.all)
  console.log('LOOPBACK ONLY GREEN — ' + checks + ' checks; three scratch members over a stand-in fetch, nothing sent off the box')
} finally { removeScratch(scratch) }
