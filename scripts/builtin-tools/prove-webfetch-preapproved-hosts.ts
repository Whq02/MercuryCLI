#!/usr/bin/env bun
// gate-watch: src/tools/WebFetchTool/preapproved.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'webfetch-preapproved-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('WebFetch reaches no model vendor\'s site without the user\'s word')

const { PREAPPROVED_HOSTS, isPreapprovedHost } = await import('../../src/tools/WebFetchTool/preapproved.ts')

const VENDOR_HOSTS = ['platform.claude.com', 'docs.claude.com', 'api.anthropic.com', 'platform.openai.com', 'docs.x.ai', 'ai.google.dev', 'api-docs.deepseek.com', 'platform.moonshot.ai', 'openrouter.ai']
const VENDOR_ORGS = ['github.com/anthropics', 'github.com/openai', 'github.com/xai-org', 'github.com/google-gemini']

for (const host of VENDOR_HOSTS) {
  check(`${host} is not pre-approved (a docs page there asks like any other site)`, !PREAPPROVED_HOSTS.has(host) && !isPreapprovedHost(host, '/docs/en/api') && !isPreapprovedHost(host, '/'))
}
for (const org of VENDOR_ORGS) {
  const [host, ...rest] = org.split('/')
  check(`${org} is not pre-approved (a vendor's repository asks like any other)`, !PREAPPROVED_HOSTS.has(org) && !isPreapprovedHost(host!, `/${rest.join('/')}/sdk`))
}
check('the open protocol estates stay pre-approved', isPreapprovedHost('modelcontextprotocol.io', '/specification') && isPreapprovedHost('agentskills.io', '/'))
check('a language reference stays pre-approved', isPreapprovedHost('docs.python.org', '/3/library/json.html'))
check('a path-scoped entry still matches at its segment boundary only', isPreapprovedHost('vercel.com', '/docs/functions') && !isPreapprovedHost('vercel.com', '/docsx'))
check('an unknown host is not pre-approved', !isPreapprovedHost('example.com', '/'))
check('no entry names a model vendor', [...PREAPPROVED_HOSTS].every(entry => !VENDOR_HOSTS.includes(entry) && !VENDOR_ORGS.includes(entry)))

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ WEBFETCH PREAPPROVED HOSTS GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ WEBFETCH PREAPPROVED HOSTS RED (${failures} of ${checks} checks failed)`)
process.exit(1)
