import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ENGINE_LIBRARIES = new Set(['xul', 'xul.dll', 'libxul.so', 'webview2loader.dll', 'microsoft.web.webview2.core.dll'])
const VERSION_FOLDER = /^\d+(?:\.\d+)+$/

const read = new Map<string, boolean>()

function namesWithin(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

function holdsEngine(names: string[]): boolean {
  const lower = names.map(name => name.toLowerCase())
  return lower.some(name => ENGINE_LIBRARIES.has(name)) || (lower.includes('icudtl.dat') && lower.some(name => name.endsWith('.pak')))
}

function engineIn(bundlePath: string): boolean {
  const names = readdirSync(bundlePath)
  if (!names.includes('Contents')) return holdsEngine(names) || names.filter(name => VERSION_FOLDER.test(name)).some(name => holdsEngine(namesWithin(join(bundlePath, name))))
  const contents = join(bundlePath, 'Contents')
  if (holdsEngine(namesWithin(join(contents, 'MacOS')))) return true
  const frameworks = join(contents, 'Frameworks')
  return namesWithin(frameworks).some(name => name.endsWith('.framework') && holdsEngine(namesWithin(join(frameworks, name, 'Resources'))))
}

export function bundleWebEngine(bundlePath: string): boolean | undefined {
  const known = read.get(bundlePath)
  if (known !== undefined) return known
  try {
    const engine = engineIn(bundlePath)
    read.set(bundlePath, engine)
    return engine
  } catch {
    return undefined
  }
}
