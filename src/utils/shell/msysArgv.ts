const MSYS_ARGV_HALVED_BACKSLASH_RUN_RE = /\\{2,}(?=[^\\"])/g

export function protectBackslashRunsFromMsysArgv(script: string): string {
  return script.replace(MSYS_ARGV_HALVED_BACKSLASH_RUN_RE, run => run + run)
}
