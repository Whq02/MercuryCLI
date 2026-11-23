#!/usr/bin/env bun
// gate-watch: src/integrations/mcp/serverConfigs.ts src/integrations/mcp/utils.ts src/screen/mcp/MCPServerApprovalDialog.tsx src/screen/mcp/MCPServerMultiselectDialog.tsx src/commands/verbs/mcp.tsx src/screen/mcp/mcpServerApproval.tsx src/platform/settings/projectConfig.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-config-')))
process.env.MERCURY_CONFIG_DIR = CONFIG_DIR
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-proj-')))

const { enableConfigs, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setOriginalCwd(PROJ)
bootstrap.setProjectRoot(PROJ)
bootstrap.setIsInteractive(false)
const { setCwd } = await import('../../src/platform/shell/shellExec.ts')
await setCwd(PROJ)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${cond ? '' : ' | change the project scope in src/integrations/mcp/serverConfigs.ts (getMercuryMcpConfigs, addMcpConfig, removeMcpConfig, projectMcpFilePath) or its labels in src/integrations/mcp/utils.ts; the dist legs also need dist rebuilt with bun run build.ts'}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const stdio = (cmd: string): Record<string, unknown> => ({ type: 'stdio', command: cmd, args: [], env: {} })

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — project mcp file proof exceeded 60s; look for a hang in addMcpConfig or removeMcpConfig in src/integrations/mcp/serverConfigs.ts')
  process.exit(1)
}, 60_000)
guard.unref?.()

const otherName = ['.mcp', 'json'].join('.')
const projectFile = join(PROJ, '.mercury', 'mcp.json')
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(projectFile, JSON.stringify({ mcpServers: { 'in-home': stdio('in-home-cmd') } }))
writeFileSync(join(PROJ, otherName), JSON.stringify({ mcpServers: { 'other-file': stdio('other-file-cmd') } }))
writeFileSync(join(PROJ, '.mercury', 'settings.local.json'), JSON.stringify({ kit: { trustProjectServers: true } }))
saveCurrentProjectConfig(current => ({ ...current, hasTrustDialogAccepted: true }))

const config = await import('../../src/integrations/mcp/serverConfigs.ts')
const utils = await import('../../src/integrations/mcp/utils.ts')

console.log('============================================================')
console.log(' the project MCP file is .mercury/mcp.json')
console.log('============================================================')

console.log('\n§1 the project scope reads .mercury/mcp.json and nothing else at the root')
{
  const { servers } = await config.getMercuryMcpConfigs({})
  const names = Object.keys(servers).sort()
  check('the server in the project-home file is in the walk, scoped project', (servers['in-home'] as { scope?: string } | undefined)?.scope === 'project', j(names))
  check('a server file under another name at the project root is not read', !('other-file' in servers), j(names))
  check('the cwd read sees the same one server', Object.keys(config.getProjectMcpConfigsFromCwd().servers).join(',') === 'in-home', j(Object.keys(config.getProjectMcpConfigsFromCwd().servers)))
}

console.log('\n§2 the scope describes itself by that file')
{
  check('projectMcpFilePath rides the project-config seam', config.projectMcpFilePath(PROJ) === projectFile, config.projectMcpFilePath(PROJ))
  check("describeMcpConfigFilePath('project') names the file", utils.describeMcpConfigFilePath('project') === projectFile, utils.describeMcpConfigFilePath('project'))
  check("getScopeLabel('project') names the file", utils.getScopeLabel('project').includes('.mercury/mcp.json'), utils.getScopeLabel('project'))
}

console.log('\n§3 mcp add/remove --scope project write that file')
{
  await config.addMcpConfig('added', stdio('added-cmd'), 'project')
  const doc = JSON.parse(readFileSync(projectFile, 'utf8')) as { mcpServers: Record<string, unknown> }
  check('add lands in .mercury/mcp.json beside the existing server', 'added' in doc.mcpServers && 'in-home' in doc.mcpServers, j(Object.keys(doc.mcpServers)))
  const other = JSON.parse(readFileSync(join(PROJ, otherName), 'utf8')) as { mcpServers: Record<string, unknown> }
  check('the other file at the root is untouched', Object.keys(other.mcpServers).join(',') === 'other-file')
  let duplicate = ''
  try {
    await config.addMcpConfig('added', stdio('added-cmd'), 'project')
  } catch (error) {
    duplicate = String(error)
  }
  check('a second add of the same name refuses and names the project file', duplicate.includes(projectFile), duplicate)
  await config.removeMcpConfig('added', 'project')
  const after = JSON.parse(readFileSync(projectFile, 'utf8')) as { mcpServers: Record<string, unknown> }
  check('remove takes it out again', !('added' in after.mcpServers) && 'in-home' in after.mcpServers, j(Object.keys(after.mcpServers)))
  const handWritten = { $schema: 'https://example.invalid/mcp.json', mcpServers: { 'in-home': { ...stdio('in-home-cmd'), note: 'kept as written' }, 'odd-shape': { type: 'carrier-pigeon', coop: 'north' } } }
  writeFileSync(projectFile, JSON.stringify(handWritten, null, 2) + '\n')
  await config.addMcpConfig('beside', stdio('beside-cmd'), 'project')
  const kept = JSON.parse(readFileSync(projectFile, 'utf8')) as { $schema?: string; mcpServers: Record<string, Record<string, unknown>> }
  check('a project add changes only the named key: unknown top-level keys, unknown fields and an entry of another shape stay as the operator wrote them (F43A-C7-21)', kept.$schema === handWritten.$schema && kept.mcpServers['in-home']?.note === 'kept as written' && j(kept.mcpServers['odd-shape']) === j(handWritten.mcpServers['odd-shape']) && 'beside' in kept.mcpServers, j(kept))
  await config.removeMcpConfig('beside', 'project')
  check('…and a project remove takes out only the named key', j(JSON.parse(readFileSync(projectFile, 'utf8'))) === j(handWritten), readFileSync(projectFile, 'utf8'))
  writeFileSync(projectFile, '{ "mcpServers": { "in-home": ')
  let broken = ''
  try {
    await config.addMcpConfig('onto-broken', stdio('x'), 'project')
  } catch (error) {
    broken = String(error)
  }
  check('an add onto a file that is not valid JSON refuses with the scope reader\'s own words and rewrites nothing', broken.includes('MCP configuration file is not valid JSON') && readFileSync(projectFile, 'utf8') === '{ "mcpServers": { "in-home": ', broken)
  writeFileSync(projectFile, JSON.stringify({ mcpServers: { 'in-home': stdio('in-home-cmd') } }))
  const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-fresh-')))
  await setCwd(fresh)
  await config.addMcpConfig('first', stdio('first-cmd'), 'project')
  check('an add in a project with no config home creates .mercury/mcp.json', existsSync(join(fresh, '.mercury', 'mcp.json')) && !existsSync(join(fresh, otherName)))
  rmSync(fresh, { recursive: true, force: true })
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-empty-')))
  await setCwd(empty)
  let missing = ''
  try {
    await config.removeMcpConfig('nothing', 'project')
  } catch (error) {
    missing = String(error)
  }
  check('a remove in a project with no config home refuses and names the project file', missing.includes(join(empty, '.mercury', 'mcp.json')), missing)
  check('the refused remove leaves no config home behind', !existsSync(join(empty, '.mercury')))
  rmSync(empty, { recursive: true, force: true })
  await setCwd(PROJ)
}


console.log('\n§5 eight racing adds into a project with no config home yet all land (the lock waits for the home)')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-race-home-')))
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-race-proj-')))
    const { spawn } = await import('node:child_process')
    const add = (name: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('node', [DIST, 'mcp', 'add', '--scope', 'project', name, '--', 'echo', name], {
          cwd: fresh,
          env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
          stdio: ['ignore', 'ignore', 'ignore'],
        })
        child.on('close', rc => resolve(rc ?? -1))
      })
    const names = Array.from({ length: 8 }, (_, i) => `race-${i}`)
    const codes = await Promise.all(names.map(add))
    let written: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
    try {
      written = JSON.parse(readFileSync(join(fresh, '.mercury', 'mcp.json'), 'utf8')) as typeof written
    } catch {
      written = { mcpServers: {} }
    }
    const survivors = names.filter(n => n in written.mcpServers)
    check('every add exited 0', codes.every(c => c === 0), j(codes))
    check('all eight servers are in .mercury/mcp.json', survivors.length === 8, `${survivors.length}/8 ${j(Object.keys(written.mcpServers).sort())}`)
    rmSync(home, { recursive: true, force: true })
    rmSync(fresh, { recursive: true, force: true })
  }
}

console.log('\n§6 mcp remove --scope project in a project with no config home refuses and creates nothing')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-remove-home-')))
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-remove-proj-')))
    const { spawnSync } = await import('node:child_process')
    const run = spawnSync('node', [DIST, 'mcp', 'remove', '--scope', 'project', 'nothing'], {
      cwd: fresh,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    const said = `${run.stdout ?? ''}${run.stderr ?? ''}`
    check('the remove exits non-zero', run.status !== 0, String(run.status))
    check('the answer names the project file', said.includes(join(fresh, '.mercury', 'mcp.json')), said.trim().slice(0, 200))
    check('no config home was created by the refusal', !existsSync(join(fresh, '.mercury')), existsSync(join(fresh, '.mercury')) ? 'an empty .mercury/ was left behind' : '')
    rmSync(home, { recursive: true, force: true })
    rmSync(fresh, { recursive: true, force: true })
  }
}

console.log('\n§7 mcp list prints the settings fault sentence when .mercury/mcp.json cannot be read')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  const posixModes = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else if (posixModes) {
    const { chmodSync } = await import('node:fs')
    const { spawnSync } = await import('node:child_process')
    const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-list-home-')))
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-list-proj-')))
    const mcpDir = join(fresh, '.mercury')
    const mcpFile = join(mcpDir, 'mcp.json')
    mkdirSync(mcpDir, { recursive: true })
    seedFirstRun(home, [fresh])
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ kit: { trustProjectServers: true } }))
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { readable: stdio('/usr/bin/true') } }))
    chmodSync(mcpFile, 0o000)
    try {
      const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_MCP_TIMEOUT_MS: '1000' }
      delete env.MERCURY_HOME
      delete env.NODE_ENV
      const unread = spawnSync(process.env.MERCURY_NODE ?? 'node', [DIST, 'mcp', 'list'], { cwd: fresh, env, encoding: 'utf8', timeout: 30_000 })
      const errOut = unread.stderr ?? ''
      const allOut = `${unread.stdout ?? ''}\n${errOut}`
      check(
        'mcp list reports the unreadable project .mercury/mcp.json with the settings fault sentence',
        unread.status === 0 &&
          errOut.includes('settings: Failed to read MCP configuration file: ') &&
          errOut.includes(' — the file is skipped') &&
          errOut.includes('EACCES'),
        `rc=${unread.status} stdout=${JSON.stringify(unread.stdout)} stderr=${JSON.stringify(errOut)}`,
      )
      check(
        'mcp list does not print "No MCP servers configured" when reading the project file failed',
        !allOut.includes('No MCP servers configured'),
        allOut.slice(0, 300),
      )
      chmodSync(mcpFile, 0o644)
      const ok = spawnSync(process.env.MERCURY_NODE ?? 'node', [DIST, 'mcp', 'list'], { cwd: fresh, env, encoding: 'utf8', timeout: 30_000 })
      const okOut = `${ok.stdout ?? ''}\n${ok.stderr ?? ''}`
      check(
        'control: readable .mercury/mcp.json lists the server with no read-fault sentence',
        ok.status === 0 && okOut.includes('readable:') && !okOut.includes('Failed to read MCP configuration file'),
        `rc=${ok.status} out=${okOut.slice(0, 300)}`,
      )
    } finally {
      try { chmodSync(mcpFile, 0o644) } catch {}
      rmSync(home, { recursive: true, force: true })
      rmSync(fresh, { recursive: true, force: true })
    }
  }
}

rmSync(CONFIG_DIR, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ PROJECT MCP FILE — all checks pass' : `\n❌ PROJECT MCP FILE — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
