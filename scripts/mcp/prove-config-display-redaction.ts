#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'mcp-config-display-'))
const previousCwd = process.cwd()
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.chdir(scratch)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const envValue = 'SECRET_VALUE_FIXTURE_7f3a'
const queryValue = 'KEYVALUE_FIXTURE_9c1d'
const username = 'USER_FIXTURE_48ce'
const password = 'PASS_FIXTURE_b7a2'
const url = `http://127.0.0.1:1/mcp?api_key=${queryValue}&region=eu&api_key=second#anchor`
const maskedUrl = 'http://127.0.0.1:1/mcp?api_key=[redacted]&region=[redacted]&api_key=[redacted]#anchor'
const credentialUrl = `http://${username}:${password}@127.0.0.1:1/mcp?token=${queryValue}`
const headers = { Authorization: 'Bearer HEADER_FIXTURE_22da', 'X-Trace': 'trace-visible' }
const args = ['-e', 'process.exit(0)', 'ARG_FIXTURE=visible-arg']
const framesIndex = process.argv.indexOf('--frames')
const frames = framesIndex < 0 ? undefined : process.argv[framesIndex + 1]
if (frames) mkdirSync(frames, { recursive: true })
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function unwrapped(frame: string): string {
  return frame.split('\n').map(line => line.replace(/^\s*│ ?| ?│\s*$/g, '').trim()).join('')
}
function safe(label: string, output: string): void {
  for (const [field, value] of [['env', envValue], ['query', queryValue], ['username', username], ['password', password], ['header', headers.Authorization]]) {
    check(`${label}: no ${field} fixture value`, !output.includes(value!) && !unwrapped(output).includes(value!), output)
  }
}
function cli(...argv: string[]): string {
  const result = spawnSync('node', [join(root, 'dist/mercury.mjs'), 'mcp', ...argv], {
    cwd: scratch,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = result.stdout + result.stderr
  if (result.status !== 0) throw new Error(`mcp ${argv[0]} exited ${result.status}: ${result.error ?? output}`)
  return output
}

try {
  const stdioAdd = cli('add', 'display-stdio', '--scope', 'user', '-e', `FIXTURE_ENV=${envValue}`, 'PLAIN=ordinary', 'EMPTY=', '--', 'node', ...args)
  safe('mcp add stdio', stdioAdd)
  check('mcp add keeps stdio args', stdioAdd.includes(args.join(' ')), stdioAdd)
  for (const transport of ['http', 'sse']) {
    const added = cli('add', `display-${transport}`, url, '--transport', transport, '--scope', 'user', '--header', `Authorization: ${headers.Authorization}`, 'X-Trace: trace-visible')
    safe(`mcp add ${transport}`, added)
    check(`mcp add ${transport} keeps address and all query names`, added.includes(maskedUrl), added)
    check(`mcp add ${transport} still masks headers`, added.includes('Authorization: [redacted]') && added.includes('X-Trace: trace-visible'), added)
  }
  safe('mcp add userinfo', cli('add', 'display-userinfo', credentialUrl, '--transport', 'http', '--scope', 'user'))
  for (const type of ['ws', 'claudeai-proxy']) {
    safe(`mcp import ${type}`, cli('import', `display-${type}`, JSON.stringify({ type, url, ...(type === 'claudeai-proxy' ? { id: 'display-proxy' } : {}) }), '--scope', 'user'))
  }
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getMcpConfigByName, setMcpServerEnabled } = await import('../../src/services/mcp/config.ts')
  const names = ['display-stdio', 'display-http', 'display-sse', 'display-userinfo', 'display-ws', 'display-claudeai-proxy']
  for (const name of names) setMcpServerEnabled(name, false)
  const { getGlobalMercuryFile } = await import('../../src/utils/env.ts')
  const before = readFileSync(getGlobalMercuryFile(), 'utf8')
  const stored = JSON.parse(before).mcpServers
  check('stored env keeps its original values', stored['display-stdio'].env.FIXTURE_ENV === envValue && stored['display-stdio'].env.PLAIN === 'ordinary' && stored['display-stdio'].env.EMPTY === '')
  check('stored args keep their original values', JSON.stringify(stored['display-stdio'].args) === JSON.stringify(args))
  check('stored query and userinfo keep their original values', stored['display-http'].url === url && stored['display-userinfo'].url === credentialUrl)
  check('stored headers keep their original values', stored['display-http'].headers.Authorization === headers.Authorization)

  for (const name of names) {
    const output = cli('get', name)
    safe(`mcp get ${name}`, output)
    check(`mcp get ${name} names the server`, output.includes(`${name}:`), output)
    if (name === 'display-stdio') {
      for (const key of ['FIXTURE_ENV', 'PLAIN', 'EMPTY']) check(`mcp get masks every env value: ${key}`, output.includes(`${key}=[redacted]`), output)
      check('mcp get leaves args unchanged', output.includes(`Args: ${args.join(' ')}`), output)
    } else if (name === 'display-userinfo') {
      check('mcp get masks userinfo and token but keeps host/path', output.includes('URL: http://[redacted]@127.0.0.1:1/mcp?token=[redacted]'), output)
    } else {
      check(`mcp get ${name} keeps address and duplicate query names`, output.includes(`URL: ${maskedUrl}`), output)
    }
  }
  const listed = cli('list')
  safe('mcp list', listed)
  for (const name of names) check(`mcp list keeps ${name}`, listed.includes(`${name}:`), listed)
  check('mcp list keeps address and query names', listed.includes(maskedUrl), listed)
  check('mcp list keeps stdio args', listed.includes(args.join(' ')), listed)

  const React = await import('react')
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { MCPConnectionManager } = await import('../../src/services/mcp/MCPConnectionManager.tsx')
  const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
  const { MCPRemoteServerMenu } = await import('../../src/components/mcp/MCPRemoteServerMenu.tsx')
  const { MCPStdioServerMenu } = await import('../../src/components/mcp/MCPStdioServerMenu.tsx')
  const { MCPAgentServerMenu } = await import('../../src/components/mcp/MCPAgentServerMenu.tsx')
  for (const [columns, rows] of [[178, 51], [80, 21]]) {
    for (const name of names.filter(name => name !== 'display-ws')) {
      const config = getMcpConfigByName(name)!
      const server = { name, config, scope: 'user', transport: config.type, isAuthenticated: false, client: { type: 'disabled', name, config } }
      const component = name === 'display-stdio' ? MCPStdioServerMenu : MCPRemoteServerMenu
      const frame = await renderToString(React.createElement(TerminalSizeContext.Provider, { value: { columns, rows } },
        React.createElement(AppStateProvider, { children: React.createElement(MCPConnectionManager, {
          dynamicMcpConfig: {}, isStrictMcpConfig: true,
          children: React.createElement(component, { server: server as never, serverToolsCount: 0, onViewTools() {}, onCancel() {}, onComplete() {} }),
        }) })), columns)
      if (frames) writeFileSync(join(frames, `${name}-${columns}x${rows}.txt`), frame + '\n')
      safe(`/mcp ${name} ${columns}x${rows}`, frame)
      check(`/mcp ${name} ${columns}x${rows} renders real menu rows`, frame.includes('Status: disabled') && frame.includes('Config:'), frame)
      const compact = unwrapped(frame)
      if (name === 'display-stdio') check(`/mcp stdio ${columns}x${rows} keeps args`, frame.includes(args.join(' ')), frame)
      else if (name === 'display-userinfo') check(`/mcp userinfo ${columns}x${rows} keeps redacted address`, compact.includes('http://[redacted]@127.0.0.1:1/mcp?token=[redacted]'), frame)
      else check(`/mcp ${name} ${columns}x${rows} keeps all address parts`, compact.includes(maskedUrl), frame)
    }
    const agentFrame = await renderToString(React.createElement(TerminalSizeContext.Provider, { value: { columns, rows } },
      React.createElement(AppStateProvider, { children: React.createElement(MCPAgentServerMenu, {
        agentServer: { name: 'agent-display', transport: 'http', url: stored['display-http'].url, needsAuth: true, isAuthenticated: false, sourceAgents: ['fixture-agent'] }, onBack() {},
      }) })), columns)
    if (frames) writeFileSync(join(frames, `agent-display-${columns}x${rows}.txt`), agentFrame + '\n')
    safe(`/mcp agent menu ${columns}x${rows}`, agentFrame)
    check(`/mcp agent menu ${columns}x${rows} keeps address and query names`, unwrapped(agentFrame).includes(maskedUrl), agentFrame)
  }
  check('get/list/render never rewrite the stored server configs', JSON.stringify(JSON.parse(readFileSync(getGlobalMercuryFile(), 'utf8')).mcpServers) === JSON.stringify(stored))
  const { describeUrlRedacted, describeEnvRedacted } = await import('../../src/utils/redactHeaders.ts')
  check('the shared redaction owner covers URLs and env', typeof describeUrlRedacted === 'function' && typeof describeEnvRedacted === 'function')
  if (typeof describeUrlRedacted === 'function' && typeof describeEnvRedacted === 'function') {
    const cases = [
      ['https://host/path', 'https://host/path'],
      ['https://host/path?', 'https://host/path?'],
      ['https://host/path#fragment?visible=value', 'https://host/path#fragment?visible=value'],
      ['https://host/path?empty=&flag&=value&encoded%20name=a%26b%3Dc&again=x=y&&#fragment', 'https://host/path?empty=[redacted]&flag&=[redacted]&encoded%20name=[redacted]&again=[redacted]&&#fragment'],
      ['not a valid address?any=value', 'not a valid address?any=[redacted]'],
      ['//user:password@host/path?any=value', '//[redacted]@host/path?any=[redacted]'],
      ['https://user%40domain:pass%3Fword@host:8443/path', 'https://[redacted]@host:8443/path'],
      ['https://user@host/path', 'https://[redacted]@host/path'],
      ['user:password@host/path?token=fixture', '[redacted]@host/path?token=[redacted]'],
      ['  https://user:password@host/path?token=fixture  ', '  https://[redacted]@host/path?token=[redacted]'],
    ]
    for (const [input, expected] of cases) check(`URL shape ${input}`, describeUrlRedacted(input!) === expected, describeUrlRedacted(input!))
    const env = { PLAIN: 'ordinary', EMPTY: '', MULTILINE: 'first\nsecond' }
    check('all env values mask without name or value heuristics', JSON.stringify(describeEnvRedacted(env)) === JSON.stringify(['PLAIN=[redacted]', 'EMPTY=[redacted]', 'MULTILINE=[redacted]']))
    check('env redaction never mutates its input', env.PLAIN === 'ordinary' && env.EMPTY === '' && env.MULTILINE === 'first\nsecond')
    check('absent env has no rows', describeEnvRedacted(undefined).length === 0)
  }
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `MCP CONFIG DISPLAY: ${failures} failure(s)` : 'MCP CONFIG DISPLAY: ALL PASS')
process.exit(failures ? 1 : 0)
