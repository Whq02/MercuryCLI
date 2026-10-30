export const MISSING_CWD_LINE =
  'the folder you started in no longer exists; start Mercury from another folder'

export function isMissingCwd(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false
  const e = reason as NodeJS.ErrnoException
  return e.code === 'ENOENT' && (e.syscall === 'uv_cwd' || /uv_cwd/.test(reason.message))
}

export function cwdIsMissing(): boolean {
  try {
    process.cwd()
    return false
  } catch (error) {
    return isMissingCwd(error)
  }
}
