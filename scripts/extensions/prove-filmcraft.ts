import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'craft-proof' }
const root = resolve(import.meta.dir, '../..')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { computeActiveSet, publishActiveSet } = await import('../../src/extensions/active.ts')
const active = computeActiveSet({ cwd: root })
publishActiveSet(active)
const ext = active.active.find(e => e.entry.id === 'filmcraft@mercury')
assert(ext, 'FilmCraft must be bundled and active without an application install')
assert.equal(ext.health.outcome, 'loads')
assert.equal(ext.resolution.servers.length, 1)
assert.equal(ext.resolution.skills.length, 1)
const { getExtensionSkills } = await import('../../src/extensions/load/commands.ts')
const skill: any = getExtensionSkills().find(s => s.name === 'filmcraft:filmcraft')
assert(skill)
assert.match(skill.description, /Use when editing, cutting, grading or exporting a FilmCraft project/)
assert.match(skill.description, /Not for PhotoCraft.*LightCraft/)
const prompt = (await skill.getPromptForCommand('Cut the open FilmCraft sequence at one second')).map((p: any) => p.text).join('\n')
assert(prompt.includes('Cut the open FilmCraft sequence at one second'))
assert(prompt.includes('sequence.addEdit') && prompt.includes('ui_screenshot') && prompt.includes('file.exportMedia'))
assert(prompt.includes('FilmCraft 0.20.0') && prompt.includes('FILMCRAFT_CONTROL_TOKEN') && prompt.includes('tokenFile') && prompt.includes('254016000000'))
assert(prompt.includes('timeline.move') && prompt.includes('lastPath'), 'The skill carries the 0.17.1 words: a move takes time objects, an image sequence names its first and last stills')
assert(!prompt.includes('craft_status') && !prompt.includes('craft_install'), 'Onboarding belongs to the server instructions, not the skill')
assert(readFileSync(join(ext.root, 'skills/filmcraft/SKILL.md')).byteLength <= 1700)
assert(!prompt.includes('${MERCURY_EXTENSION_ROOT}'))
console.log('PASS: real skill discovery, argument expansion, FilmCraft editing trigger and PhotoCraft/LightCraft exclusion')
const { getExtensionMcpServers } = await import('../../src/extensions/load/servers.ts')
const config: any = getExtensionMcpServers()['ext:filmcraft:app']
assert(config && config.command === process.execPath)
assert(config.env.MERCURY_CRAFT_INSTALL_KEY)
assert(config.args[0].startsWith(ext.root))
const client = new Client({ name: 'filmcraft-bundled-proof', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env } as Record<string, string>, stderr: 'pipe' }))
try {
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(t => t.name), ['craft_status', 'craft_install', 'craft_connect'])
  const status = await client.callTool({ name: 'craft_status', arguments: {} })
  assert(!status.isError)
  assert.match(JSON.stringify(status), /absent/)
  const attach = await client.callTool({ name: 'craft_connect', arguments: { mode: 'attach' } })
  assert(attach.isError)
  const install = await client.callTool({ name: 'craft_install', arguments: {} })
  assert(install.isError, 'Raw MCP call without the permission handoff must not install')
  console.log('PASS: delivered bundled bootstrap initializes, lists tools and remains absent on unapproved calls')
} finally { await client.close() }
const { connectToServer, fetchToolsForClient } = await import('../../src/services/mcp/client.ts')
const connection = await connectToServer('ext:filmcraft:app', config)
assert.equal(connection.type, 'connected')
if (connection.type === 'connected') {
  try {
    const tools = await fetchToolsForClient(connection)
    const { assembleToolPool } = await import('../../src/tools.ts')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
    const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
    const permission = getEmptyToolPermissionContext()
    const pool = assembleToolPool(permission, tools)
    const install = pool.find(t => t.mcpInfo?.toolName === 'craft_install')!
    assert(install)
    const context: any = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission }), options: {} }
    const { decision } = await decideToolPermission(install, {}, context)
    assert.equal(decision.behavior, 'ask')
    assert.match((decision as any).message, /Install FilmCraft 0\.20\.0 \([\d,]+ bytes\)/)
    assert(!JSON.stringify(decision).includes('_mercuryInstallGrant'))
    console.log('PASS: real Mercury MCP client and tool pool ask once with a private install handoff')
  } finally { await connection.client.close() }
}
const pins = ['filmcraft.lock.json', 'filmcraft-cli.lock.json'].map(name => JSON.parse(readFileSync(join(ext.root, 'server', name), 'utf8')))
assert.equal(pins[0].version, pins[1].version)
assert.equal(pins[0].platforms['darwin-arm64'].bytes + pins[1].platforms['darwin-arm64'].bytes, 218611874)
assert.equal(pins[0].platforms['win-x64'].bytes, 113362703)
console.log('PASS: delivered Mac/Windows release pins and matching versions')
const { adapter } = await import(pathToFileURL(join(ext.root, 'server/install.mjs')).href)
const { planInstall } = await import(pathToFileURL(join(ext.root, 'shared/install.mjs')).href)
const dataDir = join(tmpdir(), 'filmcraft-plan')
assert.equal(planInstall(adapter, { dataDir, platform: 'darwin-arm64' }).payloads.length, 2, 'macOS installs the DMG and the separately pinned filmcraft-cli zip')
for (const platform of ['win-x64', 'linux-x64']) assert.deepEqual(planInstall(adapter, { dataDir, platform }).payloads.map((p: { archive: string }) => p.archive), [pins[0].platforms[platform].archive], `${platform}: the one app archive carries filmcraft-cli; upstream ships no separate CLI archive there`)
const doubled = { ...adapter, pins: [pins[0], { ...pins[1], platforms: { ...pins[1].platforms, 'win-x64': pins[0].platforms['win-x64'] } }] }
assert.equal(planInstall(doubled, { dataDir, platform: 'win-x64' }).payloads.length, 2, 'a Windows row on the CLI lock would fetch the portable zip twice and leave resolveBinaries two filmcraft-cli.exe')
console.log('PASS: one pinned archive per platform on Windows and Linux, two on macOS')
