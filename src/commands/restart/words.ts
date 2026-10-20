export const RESTART_DURING_TURN = 'This chat is still working. Press esc to interrupt it, then run /restart.'

export function restartAlreadyCurrentWords(build: string): string {
  return `This chat already uses the installed Mercury build (${build.slice(0, 12)}). Nothing needs restarting.`
}
