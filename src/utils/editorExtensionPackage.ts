
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MERCURY_IDE_EXTENSION_ID = 'mercury.mercury-vscode'

export const BRIDGE_VSIX_NAME = 'mercury-vscode.vsix'

export function locateBridgeVsix(): string | null {
  const bundleDir = process.argv[1] ? dirname(process.argv[1]) : null
  const candidates = [
    ...(bundleDir ? [join(bundleDir, BRIDGE_VSIX_NAME)] : []),
    join(process.cwd(), 'dist', BRIDGE_VSIX_NAME),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

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
