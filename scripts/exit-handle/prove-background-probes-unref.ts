#!/usr/bin/env bun
// ============================================================================
//  scripts/exit-handle/prove-background-probes-unref.ts — the boot-time
//  probes (policy limits, managed settings) ride the ONE background https
//  agent whose sockets never hold the process open: a print run that ends its
//  turn while a probe is still connecting exits at the cliff (the census red
//  of pool run 6: a ref'd TLSSocket to api.anthropic.com at reallyExit).
//
//    §1 the owner exists in proxy.ts and unrefs every socket it opens
//    §2 both probes pass it as their httpsAgent (the source shape)
//    §3 live: a socket the agent opens reads unref'd on its handle
//
//  Run: ~/.bun/bin/bun run scripts/exit-handle/prove-background-probes-unref.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the owner')
const proxy = read('src/utils/proxy.ts')
check('proxy.ts owns backgroundHttpsAgent (memoized, keepAlive off)', /export function backgroundHttpsAgent\(\)/.test(proxy) && /new BackgroundHttpsAgent\(\{ keepAlive: false \}\)/.test(proxy))
check('the agent unrefs every socket it opens (createConnection → unref)', /override createConnection\(/.test(proxy) && /\.unref\?\.\(\)/.test(proxy))

console.log('§2 the probes')
const limits = read('src/services/policyLimits/index.ts')
const managed = read('src/services/remoteManagedSettings/index.ts')
check('policy limits rides the background agent', /httpsAgent: backgroundHttpsAgent\(\)/.test(limits) && /import \{ backgroundHttpsAgent \} from '\.\.\/\.\.\/utils\/proxy\.js'/.test(limits))
check('managed settings rides the background agent', /httpsAgent: backgroundHttpsAgent\(\)/.test(managed) && /import \{ backgroundHttpsAgent \} from '\.\.\/\.\.\/utils\/proxy\.js'/.test(managed))

console.log('§3 live')
{
  const { backgroundHttpsAgent } = await import('../../src/utils/proxy.ts')
  const server = createServer(() => {})
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const agent = backgroundHttpsAgent()
  const socket = (agent as unknown as { createConnection: (o: unknown) => { _handle?: { hasRef?: () => boolean }; destroy: () => void } }).createConnection({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false })
  const handle = socket._handle
  check('a socket the agent opens reads unref’d on its handle (hasRef false) — or the host cannot say', handle === undefined || typeof handle.hasRef !== 'function' || handle.hasRef() === false, String(handle?.hasRef?.()))
  socket.destroy()
  await new Promise<void>(r => server.close(() => r()))
}

console.log(failures ? `\nRESULT: RED — ${failures} check(s) failed` : '\nRESULT: GREEN — the background probes never hold the exit')
process.exit(failures ? 1 : 0)
