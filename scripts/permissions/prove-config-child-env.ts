import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'config-child-env-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION
delete process.env.MERCURY_BARE
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS: keys } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const key of keys) process.env[key] = `fixture-${key}`
const { startCommandHook } = await import('../../src/integrations/event-hooks/commandRunner.ts')
const { connectToServer, clearServerCache } = await import('../../src/integrations/mcp/client.ts')
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const script = join(home, 'child.mjs')
writeFileSync(script, `import { writeFileSync } from 'node:fs'; import { createInterface } from 'node:readline';
const env = Object.fromEntries(${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
if (process.argv[2] === 'hook') { console.log(JSON.stringify(env)); }
else if (process.argv[2] === 'bash') { writeFileSync(process.argv[3], JSON.stringify(env)); console.log('environment captured'); }
else { writeFileSync(process.argv[2], JSON.stringify(env)); const input = createInterface({ input: process.stdin }); input.on('line', line => { const message = JSON.parse(line); if (!('id' in message)) return; const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'env-fixture', version: '1' } } : {}; console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); }); }
`)
const config = { command: process.execPath, args: [script, join(home, 'mcp-env.json')], scope: 'project' as const }
mkdirSync(join(home, '.mercury'))
writeFileSync(join(home, '.mercury', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: config } }))
let failures = 0
const check = (name: string, passed: boolean, detail = '') => { console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${!passed && detail ? ` — ${detail}` : ''}`); if (!passed) failures++ }
try {
  const hook = await startCommandHook({ name: 'fixture', command: `"${process.execPath}" "${script}" hook`, shell: 'bash', event: 'tool.before', index: 0, payloadJson: '{}', timeoutMs: 10_000, source: { kind: 'settings' }, cwd: home })
  const ended = await hook.result
  check('headless hook runs without inherited provider credentials', ended.kind === 'exited' && ended.code === 0 && ended.stdout.trim() === '{}', 'the hook child env in startCommandHook (src/integrations/event-hooks/commandRunner.ts) must come from subprocessEnv({ stripProviderCredentials: true }), which deletes ALL_PROVIDER_CREDENTIAL_ENV_VARS (src/platform/processes/subprocessEnv.ts)')
  const server = await connectToServer('env-fixture', config)
  assert.equal(server.type, 'connected', JSON.stringify(server))
  check('MCP child receives no inherited provider credentials', readFileSync(join(home, 'mcp-env.json'), 'utf8') === '{}', 'the MCP stdio child env in src/integrations/mcp/client/transports.ts must come from subprocessEnv({ stripProviderCredentials: true }), which deletes ALL_PROVIDER_CREDENTIAL_ENV_VARS (src/platform/processes/subprocessEnv.ts)')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  const state = { tasks: {}, sessionHooks: new Map(), toolPermissionContext: getEmptyToolPermissionContext() }
  const context = { options: { isNonInteractiveSession: true }, abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, readFileState: new Map(), messages: [] } as never
  const bashPath = join(home, 'bash-env.json')
  const bash = await runWithCwdOverride(home, () => BashTool.call({ command: `"${process.execPath}" "${script}" bash "${bashPath}"` }, context))
  assert.equal(bash.data.code, 0, bash.data.stderr)
  const bashEnv = JSON.parse(readFileSync(bashPath, 'utf8'))
  check('Bash retains the exported provider keys', keys.every(key => bashEnv[key] === `fixture-${key}`), 'the Bash tool child must keep the exported provider keys; only hook and MCP children strip them, so remove the credential strip from the Bash tool env path')
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
  const { MCPServerApprovalDialog } = await import('../../src/screen/mcp/MCPServerApprovalDialog.tsx')
  const frame = await renderToString(React.createElement(MCPServerApprovalDialog, { serverName: 'fixture', config, onDone() {} }), 100)
  console.log(frame)
  check('single-server consent is highlighted, broad consent remains adjacent', /[❯›>]\s*.*Use this MCP server/.test(frame) && frame.includes('Use this and all future MCP servers in this project'), 'MCPServerApprovalDialog (src/screen/mcp/MCPServerApprovalDialog.tsx) must focus the single-server option first and list the all-servers option next to it')
} finally {
  await clearServerCache('env-fixture', config)
  rmSync(home, { recursive: true, force: true })
}
assert.equal(failures, 0)
