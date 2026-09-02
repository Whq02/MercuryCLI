
export function getGlobPreambleCommand(shellPath: string): string | null {
  if (process.env.MERCURY_SHELL_PREFIX) {
    return '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_NOMATCH; } >/dev/null 2>&1 || true'
  }

  if (shellPath.includes('bash')) {
    return 'shopt -u extglob 2>/dev/null || true'
  } else if (shellPath.includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB NO_NOMATCH 2>/dev/null || true'
  }
  return null
}
