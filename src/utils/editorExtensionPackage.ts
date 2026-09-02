// ============================================================================
//  editorExtensionPackage — the ONE owner of Mercury's own editor-extension
//  identity and package: the marketplace-style id, where the built .vsix
//  lives (beside the running bundle in a release layout, dist/ in a source
//  checkout), and which editors have it installed — read live from their
//  extension directories, never from a cache or a spawned CLI.
// ============================================================================

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Mercury's OWN marketplace-style extension identifier — the
 *  publisher.name of integrations/vscode/package.json. */
export const MERCURY_IDE_EXTENSION_ID = 'mercury.mercury-vscode'

/** The package file name the build writes and the release layout carries. */
export const BRIDGE_VSIX_NAME = 'mercury-vscode.vsix'

/** The built extension package: beside the running bundle (the release
 *  layout), then the source checkout's dist/. Null when neither holds one. */
export function locateBridgeVsix(): string | null {
  const bundleDir = process.argv[1] ? dirname(process.argv[1]) : null
  const candidates = [
    ...(bundleDir ? [join(bundleDir, BRIDGE_VSIX_NAME)] : []),
    join(process.cwd(), 'dist', BRIDGE_VSIX_NAME),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** VS Code-family editors and the user directory each keeps its
 *  extensions under (`<home>/<dir>/extensions/<publisher>.<name>-<version>`). */
const EDITOR_EXTENSION_HOMES: ReadonlyArray<{ editor: string; dir: string }> = [
  { editor: 'VS Code', dir: '.vscode' },
  { editor: 'VS Code Insiders', dir: '.vscode-insiders' },
  { editor: 'Cursor', dir: '.cursor' },
  { editor: 'VSCodium', dir: '.vscode-oss' },
  { editor: 'Windsurf', dir: '.windsurf' },
]

export interface InstalledEditorExtension {
  editor: string
  version: string
  dir: string
}

/** Every VS Code-family editor with the Mercury extension installed, with
 *  the newest installed version — a live directory read. */
export function installedEditorExtensions(home: string = homedir()): InstalledEditorExtension[] {
  const prefix = `${MERCURY_IDE_EXTENSION_ID}-`
  const out: InstalledEditorExtension[] = []
  for (const { editor, dir } of EDITOR_EXTENSION_HOMES) {
    const extensionsDir = join(home, dir, 'extensions')
    let names: string[]
    try {
      names = readdirSync(extensionsDir)
    } catch {
      continue
    }
    const matches = names.filter(n => n.toLowerCase().startsWith(prefix)).sort()
    const newest = matches[matches.length - 1]
    if (newest !== undefined) {
      out.push({ editor, version: newest.slice(prefix.length), dir: join(extensionsDir, newest) })
    }
  }
  return out
}
