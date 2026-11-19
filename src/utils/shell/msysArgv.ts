const MSYS_ARGV_HALVED_BACKSLASH_RUN_RE = /\\{2,}(?=[^\\"])/g

const MSYS_ARGUMENT_KEEPS = 8186

const MSYS_NAMES_GLOB = /glob/i

export function protectBackslashRunsFromMsysArgv(script: string): string {
  return script.replace(MSYS_ARGV_HALVED_BACKSLASH_RUN_RE, run => run + run)
}

export function msysArgvCarries(script: string, env: NodeJS.ProcessEnv): boolean {
  const options = Object.entries(env).find(([name]) => name.toUpperCase() === 'MSYS')?.[1] ?? ''
  return !MSYS_NAMES_GLOB.test(options) && Buffer.byteLength(protectBackslashRunsFromMsysArgv(script)) <= MSYS_ARGUMENT_KEEPS
}

const singleQuoted = (text: string): string => `'${text.split("'").join("'\\''")}'`

export function msysSourceLine(fileInShell: string, gone?: { words: string; exit: number }): string {
  const file = singleQuoted(fileInShell)
  return gone === undefined ? `source ${file}` : `[ -r ${file} ] || { echo ${singleQuoted(gone.words)} >&2; exit ${gone.exit}; }; source ${file}`
}
