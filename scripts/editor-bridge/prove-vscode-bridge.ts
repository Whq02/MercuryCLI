#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-vscode-bridge.ts — PROOF: the VS Code
//  bridge:
//
//    (1) manifest truth — package.json declares the three views + the full
//        command set with a conservative engines floor and ZERO runtime
//        dependencies (a thin bridge carries no second runtime).
//    (2) activation truth — extension.js activates under a stubbed
//        `vscode` module and registers EXACTLY the commands the manifest
//        contributes (no phantom contributions, no dead commands).
//    (3) the .vsix builds deterministically (hand-built stable-OPC zip, no
//        downloads) with every required member; two builds are
//        byte-identical.
//    (4) `mercury editor status` runs E2E from the dist bundle and answers
//        honestly on a machine without the `code` CLI (the manual path).
//    (5) the packager's TOP_ALLOWLIST admits mercury-vscode.vsix on both
//        platforms (the distribution contract).
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-vscode-bridge.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const NODE = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
const scratch = mkdtempSync(join(tmpdir(), 'mosaic-vsix-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const manifest = JSON.parse(readFileSync('integrations/vscode/package.json', 'utf8')) as {
  engines: { vscode: string }
  main: string
  dependencies?: Record<string, string>
  contributes: {
    views: Record<string, Array<{ id: string }>>
    commands: Array<{ command: string }>
  }
}

section('(1) manifest truth')
{
  check('engines floor declared', /^\^1\.\d+\.\d+$/.test(manifest.engines.vscode), manifest.engines.vscode)
  check('zero runtime dependencies', manifest.dependencies === undefined)
  const views = manifest.contributes.views.mercury.map(v => v.id)
  check(
    'four views (attention first — rendezvous C2)',
    JSON.stringify(views) ===
      JSON.stringify(['mercuryAttention', 'mercurySessions', 'mercuryWorkbench', 'mercuryArtifacts']),
    JSON.stringify(views),
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
  ]) {
    check(`command contributed: ${required}`, commands.includes(required))
  }
  check('main points at extension.js', manifest.main === './extension.js' && existsSync('integrations/vscode/extension.js'))
}

section('(2) activation truth under a stubbed vscode module')
{
  const harness = join(scratch, 'harness.cjs')
  writeFileSync(
    harness,
    `
'use strict'
const Module = require('node:module')
const registered = []
const stub = {
  window: {
    createWebviewPanel: () => ({ webview: { onDidReceiveMessage() {}, html: '' }, onDidDispose() {}, reveal() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createTerminal: () => ({ sendText() {}, show() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    setStatusBarMessage: () => {},
    visibleTextEditors: [],
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => 'mercury' }),
    asRelativePath: p => String(p),
    openTextDocument: async () => ({}),
  },
  commands: {
    registerCommand: (name, fn) => { registered.push(name); return { dispose() {} } },
    executeCommand: async () => undefined,
  },
  Uri: { file: p => ({ fsPath: p, toString: () => 'file://' + p, with: () => ({}) }) },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }) } fire() {} },
  TreeItem: class { constructor(label) { this.label = label } },
  ThemeColor: class { constructor(id) { this.id = id } },
  ViewColumn: { Beside: 2 },
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vscode') return stub
  return originalLoad.call(this, request, ...rest)
}
const ext = require(process.argv[2])
if (typeof ext.activate !== 'function' || typeof ext.deactivate !== 'function') {
  console.error('MISSING activate/deactivate')
  process.exit(1)
}
const subscriptions = []
ext.activate({ subscriptions })
console.log(JSON.stringify({ registered, subscriptions: subscriptions.length }))
`,
  )
  const result = execFileSync(NODE, [harness, join(process.cwd(), 'integrations/vscode/extension.js')], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const parsed = JSON.parse(result.trim().split('\n').pop()!) as { registered: string[]; subscriptions: number }
  check('activate ran + pushed disposables', parsed.subscriptions > 0)
  const contributed = new Set(manifest.contributes.commands.map(c => c.command))
  const registered = new Set(parsed.registered)
  const phantom = [...contributed].filter(c => !registered.has(c))
  const dead = [...registered].filter(c => !contributed.has(c))
  check('every contributed command registers', phantom.length === 0, phantom.join(','))
  check('no unregistered phantom commands', dead.length === 0, dead.join(','))
}

section('(2b) verify-wave regressions — client robustness (structural)')
{
  const ext = readFileSync('integrations/vscode/extension.js', 'utf8')
  check("spawn failures are handled (child.on('error'))", ext.includes("this.child.on('error'"))
  check('stdin writes are guarded (safeWrite)', ext.includes('safeWrite(payload)'))
  check('inbound requests ALWAYS settle (responded-once + catch)', ext.includes('let responded = false') && ext.includes(".catch(() => respond({ outcome: { outcome: 'cancelled' } }))"))
  check('only MUTATING tools count as changed files', ext.includes("['Write', 'Edit', 'MultiEdit', 'NotebookEdit']"))
  const child = readFileSync('src/services/acp/childSession.ts', 'utf8')
  check('the ACP child pipe is crash-isolated', child.includes("this.child.on('error'") && child.includes('private writeFrame'))
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
  ]) {
    check(`vsix member: ${member}`, listing.includes(member))
  }
}

section('(4) mercury editor status — honest E2E from the dist bundle')
{
  if (!existsSync('dist/mercury.mjs')) {
    check('dist present for the editor E2E', false, 'run bun run build.ts')
  } else {
    const out = execFileSync(NODE, ['dist/mercury.mjs', 'editor', 'status'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: '/usr/bin:/bin' }, // hide any code CLI — the manual path is the covered one
    })
    check('status exits 0 without the code CLI', true)
    check('vsix located or honestly named missing', out.includes('vsix:'))
    check('manual instructions offered without code', out.includes('manual install') || out.includes('code CLI:'))
    let badExit = 0
    try {
      execFileSync(NODE, ['dist/mercury.mjs', 'editor', 'bogus'], {
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
  const packager = readFileSync('scripts/release/package.mjs', 'utf8')
  // The allowlist moved to the ONE member-role authority (payloadContract.mjs,
  // UPDATE-RELIABILITY U2) — assert the derived lists, not packager source text.
  const { topAllowlist, readCompatFloor } = await import('../release/payloadContract.mjs')
  const floor = readCompatFloor()
  check(
    'the member-role authority admits the vsix on BOTH platforms',
    topAllowlist('windows-x64', floor).includes('mercury-vscode.vsix') && topAllowlist('linux-x64', floor).includes('mercury-vscode.vsix'),
  )
  check('the packager builds + stages the vsix', packager.includes('build-vsix.sh') && packager.includes("join(pkgDir, 'mercury-vscode.vsix')"))
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ VS Code bridge proofs green')
