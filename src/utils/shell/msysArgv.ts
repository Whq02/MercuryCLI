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

const CARRIED = '__mercury_carried'

export function carriedByFile(text: string, mark: string): string {
  return `${CARRIED}=${mark}\n${text}`
}

export function msysSourceLine(fileInShell: string, gone?: { words: string; exit: number; mark: string }): string {
  const file = singleQuoted(fileInShell)
  if (gone === undefined) return `source ${file}`
  return `__mercury_left=${gone.exit}; [ -r ${file} ] && { source ${file}; __mercury_left=$?; }; [[ \${${CARRIED}-} == ${gone.mark} ]] || { echo ${singleQuoted(gone.words)} >&2; __mercury_left=${gone.exit}; }; __mercury_leave() { return $1; }; __mercury_leave $__mercury_left`
}
