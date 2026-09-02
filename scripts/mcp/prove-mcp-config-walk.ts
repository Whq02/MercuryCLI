#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-walk-config-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_DIR
const PROJ = mkdtempSync(join(tmpdir(), 'mcp-walk-proj-'))

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } =
  await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(PROJ)
bootstrap.setProjectRoot(PROJ)
const { setCwd } = await import('../../src/utils/Shell.ts')
await setCwd(PROJ)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — mcp config walk exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const stdio = (cmd: string): Record<string, unknown> => ({ type: 'stdio', command: cmd, args: [], env: {} })

saveGlobalConfig(current => ({
  ...current,
  mcpServers: {
    'user-only': stdio('user-only-cmd'),
    dup: stdio('user-dup-cmd'),
  } as never,
}))

writeFileSync(
  join(PROJ, '.mcp.json'),
  JSON.stringify({
    mcpServers: {
      'proj-only': stdio('proj-only-cmd'),
      'proj-rejected': stdio('proj-rejected-cmd'),
      dup: stdio('proj-dup-cmd'),
    },
  }),
)

mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(
  join(PROJ, '.mercury', 'settings.json'),
  JSON.stringify({ disabledMcpjsonServers: ['proj-rejected'] }),
)

saveCurrentProjectConfig(current => ({
  ...current,
  mcpServers: { dup: stdio('local-dup-cmd') } as never,
}))

const { getMercuryMcpConfigs: walkUntrusted } = await import('../../src/services/mcp/config.ts')

console.log('============================================================')
console.log(' getMercuryMcpConfigs — the io precedence walk')
console.log('============================================================')

section('W2a — FC-144: no trust record, no headless auto-approval')
{
  const { servers } = await walkUntrusted({})
  check("an untrusted checkout's .mcp.json server is not in the walk (no auto-approval)", !('proj-only' in servers), j(Object.keys(servers).sort()))
}
saveCurrentProjectConfig(current => ({ ...current, hasTrustDialogAccepted: true }))

const { getMercuryMcpConfigs } = await import('../../src/services/mcp/config.ts')

section('W1–W5 — the hermetic walk (trusted workspace)')
{
  const { servers } = await getMercuryMcpConfigs({
    'dynamic-probe': stdio('dynamic-cmd') as never,
  })
  const names = Object.keys(servers).sort()
  console.log(`  [info] resolved servers: ${j(names)}`)

  const userOnly = servers['user-only'] as { scope?: string } | undefined
  check('W1 the user scope resolves from the global config (scope-tagged)', userOnly?.scope === 'user', j(userOnly))

  const projOnly = servers['proj-only'] as { scope?: string } | undefined
  check('W2 non-interactive + projectSettings enabled ⇒ the .mcp.json server auto-approves', projOnly?.scope === 'project', j(projOnly))

  check('W3 disabledMcpjsonServers REJECTS the named project server', !('proj-rejected' in servers))

  const dup = servers['dup'] as { scope?: string; command?: string } | undefined
  check('W4 precedence: user < project < LOCAL — the local entry wins', dup?.scope === 'local' && j(dup).includes('local-dup-cmd'), j(dup))

  check('W5 dynamicServers are dedup targets ONLY — never in the returned set', !('dynamic-probe' in servers))
}

section('W6 — the enterprise + extensions-lock branches (structural)')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'mcp', 'config.ts'), 'utf-8')
  check('the enterprise exclusive-control branch exists', src.includes('if (doesEnterpriseMcpConfigExist()) {') && src.includes('exclusive control over all MCP servers'))
  check('the extensions-lock branch drops user/project/local (keeps extensions)', src.includes("const mcpLocked = isRestrictedToExtensionsOnly('mcp')"))
  check('the merge order is extension < user < project < local (later spreads win)', /\{\s*\n\s*\.\.\.dedupedExtensions,\s*\n\s*\.\.\.user\.servers,\s*\n\s*\.\.\.approvedProject,\s*\n\s*\.\.\.local\.servers,\s*\n\s*\}/.test(src))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ MCP CONFIG WALK GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} MCP CONFIG WALK FAILURE(S)`)
process.exit(1)
