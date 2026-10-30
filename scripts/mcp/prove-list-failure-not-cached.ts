#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-list-failure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.MERCURY_MCP_TIMEOUT_MS = '1500'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { connectToServer, fetchResourcesForClient, fetchCommandsForClient, clearServerCache } = await import('../../src/services/mcp/client.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — list-failure prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

console.log('a resources/list or prompts/list that fails once is asked again, never remembered as empty')
const config: import('../../src/services/mcp/types.ts').ScopedMcpServerConfig = {
  type: 'stdio',
  scope: 'dynamic',
  command: process.execPath,
  args: [join(import.meta.dir, '_fixture-stdio-server.mjs')],
  env: { MCP_FIXTURE_FIRST_LIST_SILENT: '1' },
}
const connection = await connectToServer('first-list-silent', config)
try {
  check('the fixture connects and advertises resources and prompts', connection.type === 'connected' && Boolean(connection.type === 'connected' && connection.capabilities.resources && connection.capabilities.prompts))
  if (connection.type === 'connected') {
    const started = Date.now()
    const first = await fetchResourcesForClient(connection)
    check('the first resources/list, left unanswered, comes back empty after the request budget', first.length === 0 && Date.now() - started >= 1000, `${first.length} resources after ${Date.now() - started}ms`)
    const second = await fetchResourcesForClient(connection)
    check('the second call asks the server again and gets its one resource', second.length === 1 && second[0]?.uri === 'fixture://a.txt', JSON.stringify(second))
    const third = await fetchResourcesForClient(connection)
    check('a good answer is then remembered for the connection', third === second)
    const firstPrompts = await fetchCommandsForClient(connection)
    check('the first prompts/list, left unanswered, comes back empty', firstPrompts.length === 0, String(firstPrompts.length))
    const secondPrompts = await fetchCommandsForClient(connection)
    check('the second prompts/list asks again and gets the one prompt', secondPrompts.length === 1 && secondPrompts[0]?.name === 'mcp__first-list-silent__greet', JSON.stringify(secondPrompts.map(p => p.name)))
  }
} finally {
  await clearServerCache('first-list-silent', config)
}

clearTimeout(watchdog)
console.log(failures === 0 ? '\nPASS prove-list-failure-not-cached' : `\nFAIL prove-list-failure-not-cached (${failures})`)
process.exit(failures === 0 ? 0 : 1)
