#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-editor-package.ts — PROOF: the ONE owner of
//  Mercury's editor-extension identity and package, and its two consumers:
//
//    §1 installedEditorExtensions — a live read of the VS Code-family
//       extension directories: the newest installed version per editor,
//       decoys ignored, an empty home is an empty list.
//    §2 locateBridgeVsix — beside the bundle, else dist/; nothing invented
//       when neither holds the package.
//    §3 the /ide install arm installs the package this build ships
//       (structural): no "not published" refusal survives, the arm asks the
//       one package owner, and a missing package is a named failure that
//       says where one comes from.
//    §4 `mercury editor` shares that owner and probes every VS Code-family
//       CLI (code · code-insiders · cursor · codium · windsurf), naming the
//       one it used.
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-editor-package.ts
// ============================================================================
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
    /* best-effort */
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
    // The prover's own argv[1] directory (scripts/editor-bridge) holds no
    // package, and this cwd has no dist/: nothing is invented.
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

t.section('§3 the /ide install arm installs the shipped package')
{
  const ide = readFileSync('src/utils/ide.ts', 'utf8')
  t.check('no "not published" refusal survives', !ide.includes('No published Mercury extension artifact') && !ide.includes('MERCURY_EXTENSION_ARTIFACT_PUBLISHED'))
  t.check('the arm asks the one package owner', ide.includes("from './editorExtensionPackage.js'") && ide.includes('locateBridgeVsix()'))
  t.check('the CLI installs the located package file, not a catalogue id', ide.includes("['--force', '--install-extension', vsix]"))
  t.check('a missing package is a named failure that says where one comes from', ide.includes('mercury-vscode.vsix) beside this build') && ide.includes('scripts/vscode/build-vsix.sh'))
  t.check('the identity is re-exported from the owner (importers survive)', ide.includes("export { MERCURY_IDE_EXTENSION_ID } from './editorExtensionPackage.js'"))
}

t.section('§4 `mercury editor` — same owner, every VS Code-family CLI')
{
  const cli = readFileSync('src/cli/editorBridge.ts', 'utf8')
  t.check('the verb imports the one package owner', cli.includes("from '../utils/editorExtensionPackage.js'") && cli.includes('locateBridgeVsix()'))
  for (const name of ['code', 'code-insiders', 'cursor', 'codium', 'windsurf']) {
    t.check(`probes the ${name} CLI`, new RegExp(`'${name}'`).test(cli))
  }
  t.check('names the CLI it used in the output', cli.includes('editor CLI: ${cli}') && cli.includes('via ${cli}'))
  t.check('a missing CLI names the roster in the manual steps', cli.includes('${CLI_ROSTER}'))
}

t.finish('prove-editor-package')
