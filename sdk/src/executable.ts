import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MercuryError } from './errors.js'

export function executableOf(executable: string | readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const parts = executable === undefined ? [env.MERCURY_BIN || 'mercury'] : typeof executable === 'string' ? [executable] : [...executable]
  let command = parts.shift()
  if (!command) throw new MercuryError('the mercury executable is empty', null)
  const runnable = (path: string): boolean => { try { accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true } catch { return false } }
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  const onPath = (name: string): string | undefined => (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').flatMap(dir => extensions.map(ext => resolve(cwd, dir, name + ext))).find(runnable)
  if (command === 'mercury') {
    const home = env.HOME ?? env.USERPROFILE ?? homedir()
    const installed = onPath(command)
    if (installed) { if (/\.(cmd|bat)$/i.test(installed)) command = installed }
    else command = [join(home, '.mercury', 'bin', 'mercury'), join(home, '.local', 'bin', 'mercury')].find(runnable) ?? command
  } else if (/\.(cmd|bat)$/i.test(command) && !isAbsolute(command) && !command.includes('/') && !command.includes('\\')) command = onPath(command) ?? command
  if (/\.(cmd|bat)$/i.test(command)) {
    const path = resolve(cwd, command)
    const source = readFileSync(path, 'utf8')
    const match = /"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"/i.exec(source)
    const script = match ? resolve(dirname(path), match[1]!.replaceAll('\\', '/')) : undefined
    if (!script || !existsSync(script)) throw new MercuryError('the executable is a command shim without a readable Node entry point; pass [node, script]', null)
    const localNode = join(dirname(path), 'node.exe')
    return [existsSync(localNode) ? localNode : onPath('node') ?? 'node', script, ...parts]
  }
  return [command, ...parts]
}
