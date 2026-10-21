import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MercuryError } from './errors.js'

export const MANAGED_SHIM_FAMILY = 'mercury-managed-shim'

export function executableOf(executable: string | readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform: string = process.platform): string[] {
  const win = platform === 'win32'
  const parts = executable === undefined ? [env.MERCURY_BIN || 'mercury'] : typeof executable === 'string' ? [executable] : [...executable]
  const command = parts.shift()
  if (!command) throw new MercuryError('the mercury executable is empty', null)
  const runnable = (path: string): boolean => { try { accessSync(path, win ? constants.F_OK : constants.X_OK); return true } catch { return false } }
  const extensions = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== '') : ['']
  const spellings = (name: string): string[] => win ? [...(/\.[^\\/.]+$/.test(name) ? [name] : []), ...extensions.map(ext => name + ext.toLowerCase())] : [name]
  const onPath = (name: string): string | undefined => (env.PATH ?? '').split(win ? ';' : ':').filter(dir => dir !== '').flatMap(dir => spellings(name).map(spelling => resolve(cwd, dir, spelling))).find(runnable)
  const isShim = (path: string): boolean => /\.(cmd|bat|ps1)$/i.test(path)
  const isScript = (path: string): boolean => /\.(mjs|cjs|js)$/i.test(path)
  const head = (path: string): string => { try { const fd = openSync(path, 'r'); try { const buffer = Buffer.alloc(8192); return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)) } finally { closeSync(fd) } } catch { return '' } }
  const runtimeFor = (script: string): string => {
    if (env.MERCURY_NODE && runnable(env.MERCURY_NODE)) return env.MERCURY_NODE
    const vendored = join(dirname(script), 'vendor', 'node', ...(win ? ['node.exe'] : ['bin', 'node']))
    return runnable(vendored) ? vendored : onPath('node') ?? 'node'
  }
  const home = (win ? env.USERPROFILE ?? env.HOME : env.HOME) ?? homedir()
  const versionsDir = env.MERCURY_VERSIONS_DIR || join(env.MERCURY_CONFIG_DIR || env.MERCURY_HOME || join(home, '.mercury'), 'versions')
  const managed = (): string[] | undefined => {
    let pointer: string
    try { pointer = readFileSync(join(versionsDir, 'current.txt'), 'utf8') } catch { return undefined }
    const version = pointer.split(/\r?\n/).map(line => line.replaceAll('"', '').trimEnd()).find(line => line.trim() !== '')
    if (!version || /[\\/]|\.\./.test(version)) return undefined
    const bundle = join(versionsDir, version, 'mercury.mjs')
    return existsSync(bundle) ? [runtimeFor(bundle), bundle] : undefined
  }
  const layout = `${join(versionsDir, 'current.txt')} must name a version directory under ${versionsDir} that holds mercury.mjs`
  const shim = (path: string): string[] => {
    const source = head(path)
    if (source.includes(MANAGED_SHIM_FAMILY)) {
      const bundle = managed()
      if (bundle) return bundle
      throw new MercuryError(`${path} is Mercury's managed command, but the install it points at was not found: ${layout}; run \`mercury install\` from an extracted release, or pass [node, script]`, null)
    }
    const match = /"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"/i.exec(source)
    const script = match ? resolve(dirname(path), match[1]!.replaceAll('\\', '/')) : join(dirname(path), 'mercury.mjs')
    if (!existsSync(script)) throw new MercuryError(`the executable is a command shim without a readable Node entry point: ${path} is neither Mercury's managed command (${layout}) nor an npm shim, and no mercury.mjs sits beside it; pass [node, script]`, null)
    const localNode = join(dirname(path), 'node.exe')
    return match ? [existsSync(localNode) ? localNode : onPath('node') ?? 'node', script] : [runtimeFor(script), script]
  }
  const file = (path: string): string[] => {
    if (isShim(path)) return shim(resolve(cwd, path))
    if (isScript(path)) {
      const script = resolve(cwd, path)
      if (!existsSync(script)) throw new MercuryError(`the executable is a JavaScript entry point that does not exist: ${script}`, null)
      return [runtimeFor(script), script]
    }
    if (head(resolve(cwd, path)).includes(MANAGED_SHIM_FAMILY)) return shim(resolve(cwd, path))
    return [path]
  }
  if (command === 'mercury') {
    const bundle = managed()
    if (bundle) return [...bundle, ...parts]
    const stable = win ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Mercury', 'bin', 'mercury.cmd') : join(home, '.local', 'bin', 'mercury')
    const found = onPath(command) ?? [stable, join(home, '.mercury', 'bin', 'mercury')].find(runnable)
    return found ? [...file(found), ...parts] : [command, ...parts]
  }
  const named = isShim(command) && !isAbsolute(command) && !command.includes('/') && !command.includes('\\') ? onPath(command) ?? command : command
  return [...file(named), ...parts]
}
