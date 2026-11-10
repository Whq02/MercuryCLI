export const BOOT_FACE_READY = '↵\\s*(start|open)(\\s*·\\s*m\\s*menu)?\\s*·\\s*↑↓\\s*choose'

const BOOT_FACE_PASS_DELAY_MS = 900

export function paintsBootFaceReady(text: string): boolean {
  return new RegExp(BOOT_FACE_READY).test(text)
}

export function afterBootFace(delayMs: number, text: string): string {
  return `after:~${BOOT_FACE_READY}:${delayMs}:${text}`
}

export function arenaBootFacePass(): string[] {
  return ['--arena-send', afterBootFace(BOOT_FACE_PASS_DELAY_MS, '\\r')]
}

export type SendAuthor = 'arena' | 'drive'

export function sendsByAuthor<Row extends { sent: number; by?: string }>(rows: readonly Row[]): { sends: Array<Row & { by: SendAuthor }>; sendLog: Array<Row & { by: SendAuthor }>; sent: { drive: number; arena: number } } {
  const sends = rows.map(row => ({ ...row, by: row.by === 'arena' ? ('arena' as const) : ('drive' as const) }))
  const sendLog = sends.filter(row => row.by === 'drive')
  return { sends, sendLog, sent: { drive: sendLog.length, arena: sends.length - sendLog.length } }
}
