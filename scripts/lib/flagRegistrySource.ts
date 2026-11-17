import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const MODULE = 'src/substrate/flagRegistry.ts'
const ROWS = 'src/substrate/flags'

export function isFlagRegistryFile(rel: string): boolean {
  const path = rel.replaceAll('\\', '/')
  return path === MODULE || path.startsWith(`${ROWS}/`)
}

export function flagRegistryFiles(root: string = ROOT): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.isDirectory()) walk(`${rel}/${entry.name}`)
      else if (entry.name.endsWith('.ts')) out.push(`${rel}/${entry.name}`)
    }
  }
  if (existsSync(join(root, MODULE))) out.push(MODULE)
  if (existsSync(join(root, ROWS))) walk(ROWS)
  return out
}

export function flagRegistryText(root: string = ROOT): string {
  return flagRegistryFiles(root)
    .map(rel => readFileSync(join(root, rel), 'utf8'))
    .join('\n')
}
