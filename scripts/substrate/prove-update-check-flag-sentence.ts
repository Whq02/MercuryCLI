#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const VERSION = '9.9.9'
const FLAG = 'MERCURY_UPDATE_NOTICE'
const NAMED = ['accept', 'user-agent', 'x-github-api-version']
const TRANSPORT = /^(host|connection|accept-encoding|accept-language|sec-fetch-.*)$/

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'update-check-sentence-')))
;(globalThis as Record<string, unknown>).MACRO = { VERSION }
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_UPDATE_CHANNEL_REPO
process.env.MERCURY_GH_CMD = JSON.stringify([join(scratch, 'absent', 'gh')])

const asks: Array<{ url: string; headers: Record<string, string> }> = []
const github = createServer((req, res) => {
  asks.push({ url: req.url ?? '', headers: Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, String(value)])) })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('[]')
})
await new Promise<void>(done => github.listen(0, '127.0.0.1', done))
process.env.MERCURY_UPDATE_API_BASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`

try {
  const { channelRepoSlug, listChannelReleases } = await import('../../src/platform/update-channel/channelTransport.ts')
  const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
  const listed = await listChannelReleases(channelRepoSlug())
  const ask = asks[0]
  const own = Object.keys(ask?.headers ?? {}).filter(name => !TRANSPORT.test(name)).sort()
  const summary = getFlagSpec(FLAG)?.summary ?? ''
  const where = `the summary in the ${FLAG} row of the flag registry names what anonymousHeaders in src/platform/update-channel/channelTransport.ts sends`

  console.log('the update check: what the request carries, and what its flag says it carries')
  check('the release list is read once, anonymously', listed.state === 'ok' && asks.length === 1 && ask?.url === `/repos/${channelRepoSlug()}/releases?per_page=50`, JSON.stringify({ listed: listed.state, asks: asks.map(one => one.url) }))
  check('the request names Mercury and its version', ask?.headers['user-agent'] === `mercury/${VERSION}`, JSON.stringify(ask?.headers))
  check('the request carries no sign-in and nothing else of its own making', JSON.stringify(own) === JSON.stringify(NAMED) && ask?.headers.authorization === undefined && ask?.headers.cookie === undefined, JSON.stringify(own))
  check('the flag says the request carries user-agent: mercury/<version>', summary.includes('user-agent: mercury/<version>'), where)
} finally {
  github.close()
  removeScratch(scratch)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} the update check and its flag's sentence: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
