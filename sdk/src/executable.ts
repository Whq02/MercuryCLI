import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MercuryError } from './errors.js'

export const MANAGED_SHIM_FAMILY = 'mercury-managed-shim'
export const HOMEBREW_COMMANDS = ['/opt/homebrew/bin/mercury', '/usr/local/bin/mercury', '/home/linuxbrew/.linuxbrew/bin/mercury'] as const

export function executableOf(executable: string | readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform: string = process.platform): string[] {
  const win = platform === 'win32'
  const keys = Object.keys(env)
  const variable = (name: string): string | undefined => env[name] ?? (win ? env[keys.find(key => key.toUpperCase() === name) ?? name] : undefined)
  const parts = executable === undefined ? [variable('MERCURY_BIN') || 'mercury'] : typeof executable === 'string' ? [executable] : [...executable]
  const command = parts.shift()
  if (!command) throw new MercuryError('the mercury executable is empty', null)
  const runnable = (path: string): boolean => { try { accessSync(path, win ? constants.F_OK : constants.X_OK); return true } catch { return false } }
  const extensions = win ? (variable('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== '') : ['']
  const spellings = (name: string): string[] => win ? [...(/\.[^\\/.]+$/.test(name) ? [name] : []), ...extensions.map(ext => name + ext.toLowerCase())] : [name]
  const onPath = (name: string): string | undefined => (variable('PATH') ?? '').split(win ? ';' : ':').filter(dir => dir !== '').flatMap(dir => spellings(name).map(spelling => resolve(cwd, dir, spelling))).find(runnable)
  const isShim = (path: string): boolean => /\.(cmd|bat|ps1)$/i.test(path)
  const isScript = (path: string): boolean => /\.(mjs|cjs|js)$/i.test(path)
  const head = (path: string): string => { try { const fd = openSync(path, 'r'); try { const buffer = Buffer.alloc(8192); return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)) } finally { closeSync(fd) } } catch { return '' } }
  const vendoredRuntime = (dir: string): string => join(dir, 'vendor', 'node', ...(win ? ['node.exe'] : ['bin', 'node']))
  const runtimeFor = (script: string): string => {
    const pinned = variable('MERCURY_NODE')
    if (pinned) {
      if (runnable(pinned)) return pinned
      throw new MercuryError(`MERCURY_NODE names no executable file: ${pinned}; point it at a Node binary, or unset it so ${script} runs on the runtime vendored beside it or node from PATH`, null)
    }
    const vendored = vendoredRuntime(dirname(script))
    return runnable(vendored) ? vendored : onPath('node') ?? 'node'
  }
  const home = (win ? variable('USERPROFILE') ?? variable('HOME') : variable('HOME')) ?? homedir()
  const versionsDir = variable('MERCURY_VERSIONS_DIR') || join(variable('MERCURY_CONFIG_DIR') || variable('MERCURY_HOME') || join(home, '.mercury'), 'versions')
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
  const wrapped = (source: string): string[] | undefined => {
    const match = /^exec "([^"\r\n]+)" "\$@"\s*$/m.exec(source)
    if (!match || !isAbsolute(match[1]!)) return undefined
    const bundle = join(dirname(match[1]!), 'mercury.mjs')
    return existsSync(bundle) && runnable(vendoredRuntime(dirname(match[1]!))) ? [runtimeFor(bundle), bundle] : undefined
  }
  const file = (path: string): string[] => {
    const placed = resolve(cwd, path)
    if (isShim(path)) return shim(placed)
    if (isScript(path)) {
      if (!existsSync(placed)) throw new MercuryError(`the executable is a JavaScript entry point that does not exist: ${placed}`, null)
      return [runtimeFor(placed), placed]
    }
    const source = head(placed)
    if (source.includes(MANAGED_SHIM_FAMILY)) return shim(placed)
    return wrapped(source) ?? [/[\\/]/.test(path) ? placed : path]
  }
  if (command === 'mercury') {
    const bundle = managed()
    if (bundle) return [...bundle, ...parts]
    const stable = win ? join(variable('LOCALAPPDATA') || join(home, 'AppData', 'Local'), 'Mercury', 'bin', 'mercury.cmd') : join(home, '.local', 'bin', 'mercury')
    const prefix = variable('HOMEBREW_PREFIX')
    const brew = win ? [] : [...(prefix ? [join(prefix, 'bin', 'mercury')] : []), ...HOMEBREW_COMMANDS]
    const found = onPath(command) ?? [stable, join(home, '.mercury', 'bin', 'mercury'), ...brew].find(runnable)
    return found ? [...file(found), ...parts] : [command, ...parts]
  }
  const named = isShim(command) && !isAbsolute(command) && !command.includes('/') && !command.includes('\\') ? onPath(command) ?? command : command
  return [...file(named), ...parts]
}
