#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const NODE = nodeBinPath()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-vsix-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
  }
})

const EXTENSION = join(process.cwd(), 'integrations/vscode/extension.js')

const manifest = JSON.parse(readFileSync('integrations/vscode/package.json', 'utf8')) as {
  engines: { vscode: string }
  main: string
  dependencies?: Record<string, string>
  contributes: {
    views: Record<string, Array<{ id: string }>>
    commands: Array<{ command: string }>
    keybindings?: Array<{ command: string; key: string }>
    menus?: Record<string, Array<{ command: string }>>
    configuration?: { properties: Record<string, { description?: string }> }
  }
}

section('(1) manifest truth')
{
  check('engines floor declared', /^\^1\.\d+\.\d+$/.test(manifest.engines.vscode), manifest.engines.vscode)
  check('zero runtime dependencies', manifest.dependencies === undefined)
  const viewIds = Object.values(manifest.contributes.views).flat().map(v => v.id)
  check(
    'the four views are contributed',
    ['mercurySessions', 'mercuryWorkbench', 'mercuryArtifacts', 'mercuryAttention'].every(id => viewIds.includes(id)),
    viewIds.join(','),
  )
  const commands = manifest.contributes.commands.map(c => c.command)
  for (const required of [
    'mercury.openChat',
    'mercury.newSession',
    'mercury.resumeSession',
    'mercury.cancelTurn',
    'mercury.askSelection',
    'mercury.editSelection',
    'mercury.reviewLastTurn',
    'mercury.openArtifact',
    'mercury.showReviewComments',
    'mercury.openTerminal',
    'mercury.setMode',
    'mercury.showLog',
    'mercury.refreshViews',
  ]) {
    check(`command contributed: ${required}`, commands.includes(required))
  }
  check('main points at extension.js', manifest.main === './extension.js' && existsSync('integrations/vscode/extension.js'))
  const keyCommands = (manifest.contributes.keybindings ?? []).map(k => k.command)
  check('keybindings exist and name contributed commands', keyCommands.length >= 4 && keyCommands.every(c => commands.includes(c)), keyCommands.join(','))
  const menuCommands = Object.values(manifest.contributes.menus ?? {}).flat().map(m => m.command)
  check('menus name contributed commands', menuCommands.length >= 2 && menuCommands.every(c => commands.includes(c)), menuCommands.join(','))
  const settings = manifest.contributes.configuration?.properties ?? {}
  check(
    'every setting carries a description (path · liveContext)',
    ['mercury.path', 'mercury.liveContext'].every(k => typeof settings[k]?.description === 'string' && settings[k]!.description!.length > 20),
    Object.keys(settings).join(','),
  )
  check('the settings are exactly path and liveContext', Object.keys(settings).sort().join(',') === 'mercury.liveContext,mercury.path', Object.keys(settings).join(','))
}

let activation: { registered: string[]; subscriptions: number; env: unknown[] } | null = null
const activationHome = join(scratch, 'activation-home')
section('(2) activation truth under the stubbed vscode module')
{
  const result = execFileSync(NODE, [join(process.cwd(), 'scripts/editor-bridge/fixtures/vscode-activation-probe.cjs'), EXTENSION], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: activationHome, MERCURY_STUB_WORKSPACE: scratch },
  })
  activation = JSON.parse(result.trim().split('\n').pop()!) as { registered: string[]; subscriptions: number; env: unknown[] }
  check('activate ran + pushed disposables', activation.subscriptions > 0)
  const contributed = new Set(manifest.contributes.commands.map(c => c.command))
  const registered = new Set(activation.registered)
  const phantom = [...contributed].filter(c => !registered.has(c))
  const dead = [...registered].filter(c => !contributed.has(c))
  check('every contributed command registers', phantom.length === 0, phantom.join(','))
  check('no unregistered phantom commands', dead.length === 0, dead.join(','))
}


section('(2c) activation is ACP-only — nothing stamped, written or served')
{
  check('activation touched the terminal environment of no terminal', activation !== null && activation.env.length === 0, JSON.stringify(activation?.env ?? null))
  const written = existsSync(activationHome) ? readdirSync(activationHome, { recursive: true }) : []
  check('activation wrote nothing under the config home', written.length === 0, written.join(','))
}

section('(3) deterministic .vsix build')
{
  execFileSync('bash', ['scripts/vscode/build-vsix.sh'], { stdio: 'pipe', timeout: 60_000 })
  const first = createHash('sha256').update(readFileSync('dist/mercury-vscode.vsix')).digest('hex')
  copyFileSync('dist/mercury-vscode.vsix', join(scratch, 'first.vsix'))
  execFileSync('bash', ['scripts/vscode/build-vsix.sh'], { stdio: 'pipe', timeout: 60_000 })
  const second = createHash('sha256').update(readFileSync('dist/mercury-vscode.vsix')).digest('hex')
  check('two builds byte-identical', first === second)
  const listing = execFileSync('unzip', ['-l', 'dist/mercury-vscode.vsix'], { encoding: 'utf8' })
  for (const member of [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/package.json',
    'extension/extension.js',
    'extension/LICENSE.txt',
    'extension/NOTICE',
  ]) {
    check(`vsix member: ${member}`, listing.includes(member))
  }
  const staged = execFileSync('unzip', ['-p', 'dist/mercury-vscode.vsix', 'extension/package.json'], { encoding: 'utf8' })
  const harnessVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  check('the staged manifest carries the harness version', (JSON.parse(staged) as { version: string }).version === harnessVersion, `${(JSON.parse(staged) as { version: string }).version} vs ${harnessVersion}`)
  check('the bridge manifest declares Apache-2.0', (JSON.parse(staged) as { license: string }).license === 'Apache-2.0')
  check('the bridge source licence matches LICENSE.md', readFileSync('integrations/vscode/LICENSE.txt').equals(readFileSync('LICENSE.md')))
  for (const [member, source] of [['extension/LICENSE.txt', 'LICENSE.md'], ['extension/NOTICE', 'NOTICE']]) {
    const shipped = execFileSync('unzip', ['-p', 'dist/mercury-vscode.vsix', member!])
    check(`vsix ships ${member} verbatim`, shipped.equals(readFileSync(source!)))
  }
  check('the extension NOTICE has a text content type', execFileSync('unzip', ['-p', 'dist/mercury-vscode.vsix', '\\[Content_Types\\].xml'], { encoding: 'utf8' }).includes('<Override PartName="/extension/NOTICE" ContentType="text/plain"/>'))
}

section('(4) mercury bridge status — honest E2E from the dist bundle')
{
  if (!existsSync('dist/mercury.mjs')) {
    check('dist present for the editor E2E', false, 'run bun run build.ts')
  } else {
    const out = execFileSync(NODE, ['dist/mercury.mjs', 'bridge', 'status'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    })
    check('status exits 0 without the code CLI', true)
    check('vsix located or honestly named missing', out.includes('vsix:'))
    check('manual instructions offered without code', out.includes('manual install') || out.includes('editor CLI:'))
    let badExit = 0
    try {
      execFileSync(NODE, ['dist/mercury.mjs', 'bridge', 'bogus'], {
        encoding: 'utf8',
        timeout: 60_000,
      })
    } catch (e) {
      badExit = (e as { status?: number }).status ?? 0
    }
    check('unknown action exits 2 with usage', badExit === 2)
  }
}

section('(5) the distribution contract')
{
  const { topAllowlist, readCompatFloor } = await import('../release/payloadContract.mjs')
  const floor = readCompatFloor()
  check(
    'the member-role authority admits the vsix on BOTH platforms',
    topAllowlist('windows-x64', floor).includes('mercury-vscode.vsix') && topAllowlist('linux-x64', floor).includes('mercury-vscode.vsix'),
  )
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ VS Code bridge proofs green')
