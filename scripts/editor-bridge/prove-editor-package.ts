#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { installedEditorExtensions, locateBridgeVsix, MERCURY_IDE_EXTENSION_ID, BRIDGE_VSIX_NAME } = await import(
  '../../src/utils/editorExtensionPackage.ts'
)

const scratch = mkdtempSync(join(tmpdir(), 'mercury-editor-package-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
  }
})

t.section('§1 installedEditorExtensions — the editors\' own directories')
{
  const home = join(scratch, 'home')
  mkdirSync(join(home, '.vscode', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-1.0.0`), { recursive: true })
  mkdirSync(join(home, '.vscode', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-1.0.1`), { recursive: true })
  mkdirSync(join(home, '.vscode', 'extensions', 'other.extension-9.9.9'), { recursive: true })
  mkdirSync(join(home, '.cursor', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-0.9.0`), { recursive: true })
  mkdirSync(join(home, '.windsurf', 'extensions'), { recursive: true })
  const found = installedEditorExtensions(home)
  t.check('two editors report the extension', found.length === 2, JSON.stringify(found))
  const vscode = found.find(f => f.editor === 'VS Code')
  t.check('VS Code reports its NEWEST installed version', vscode?.version === '1.0.1', JSON.stringify(vscode))
  t.check('the reported dir is the real extension directory', vscode?.dir === join(home, '.vscode', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-1.0.1`))
  t.check('Cursor reports its version', found.find(f => f.editor === 'Cursor')?.version === '0.9.0')
  t.check('a decoy extension is not Mercury', !JSON.stringify(found).includes('other.extension'))
  t.check('an editor with an empty extensions dir reports nothing', !found.some(f => f.editor === 'Windsurf'))
  t.check('an absent home is an empty list, never a throw', installedEditorExtensions(join(scratch, 'nowhere')).length === 0)
}

t.section('§2 locateBridgeVsix — beside the bundle, else dist/, else null')
{
  const here = process.cwd()
  const empty = join(scratch, 'empty-cwd')
  mkdirSync(empty, { recursive: true })
  process.chdir(empty)
  try {
    t.check('no package anywhere ⇒ null', locateBridgeVsix() === null, String(locateBridgeVsix()))
  } finally {
    process.chdir(here)
  }
  const located = locateBridgeVsix()
  t.check(
    'from the repo root: null, or an existing dist/ package (a built checkout)',
    located === null || located.endsWith(join('dist', BRIDGE_VSIX_NAME)),
    String(located),
  )
}

t.section('§3 `mercury bridge` — the one installer, every VS Code-family CLI')
{
  const cli = readFileSync('src/cli/editorBridge.ts', 'utf8')
  t.check('the verb imports the one package owner', cli.includes("from '../utils/editorExtensionPackage.js'") && cli.includes('locateBridgeVsix()'))
  t.check('the verb installs the located package file, not a catalogue id', cli.includes("['--install-extension', vsix, '--force']"))
  t.check('a missing package is a named failure that says where one comes from', cli.includes('mercury-vscode.vsix not found') && cli.includes('scripts/vscode/build-vsix.sh'))
  for (const name of ['code', 'code-insiders', 'cursor', 'codium', 'windsurf']) {
    t.check(`probes the ${name} CLI`, new RegExp(`'${name}'`).test(cli))
  }
  t.check('names the CLI it used in the output', cli.includes('editor CLI: ${cli}') && cli.includes('via ${cli}'))
  t.check('a missing CLI names the roster in the manual steps', cli.includes('${CLI_ROSTER}'))
}

t.finish('prove-editor-package')
