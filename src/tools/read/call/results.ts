import { logError } from '../../../platform/logs/errorLog.js'

export const resultLineAnchors = new WeakSet<object>()

export const resultOutlineBodies = new WeakMap<object, string>()

export const resultResolvedNames = new WeakMap<object, string>()
export const resultPreRenderedBody = new WeakMap<object, string>()
export const resultWithoutProfileHint = new WeakSet<object>()

type FileReadListener = (filePath: string, content: string) => void

const fileReadListeners = new Set<FileReadListener>()

export function registerFileReadListener(listener: FileReadListener): () => void {
  fileReadListeners.add(listener)
  return () => {
    fileReadListeners.delete(listener)
  }
}

export function notifyFileReadListeners(filePath: string, content: string): void {
  for (const listener of [...fileReadListeners]) {
    try {
      listener(filePath, content)
    } catch (error) {
      logError(error)
    }
  }
}
