
let cachedRecordFilePath: string | null = null

export function getRecordFilePath(): string | null {
  if (cachedRecordFilePath !== null) return cachedRecordFilePath
  return null
}

export async function renameRecordingForSession(): Promise<void> {
  if (getRecordFilePath() === null) return
}
