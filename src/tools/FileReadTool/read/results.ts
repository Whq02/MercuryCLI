import { notBuilt, unbuilt, type Unbuilt } from '../../../pi/holes.js'

export const resultLineAnchors: WeakSet<object> = unbuilt('src/tools/FileReadTool/read/results.ts:3')

export const resultOutlineBodies: WeakMap<object, string> = unbuilt('src/tools/FileReadTool/read/results.ts:5')

export const resultResolvedNames: WeakMap<object, string> = unbuilt('src/tools/FileReadTool/read/results.ts:7')
export const resultPreRenderedBody: WeakMap<object, string> = unbuilt('src/tools/FileReadTool/read/results.ts:8')
export const resultWithoutProfileHint: WeakSet<object> = unbuilt('src/tools/FileReadTool/read/results.ts:9')

type FileReadListener = (...args: Unbuilt[]) => Unbuilt

export function registerFileReadListener(listener: FileReadListener): () => void {
  return notBuilt('src/tools/FileReadTool/read/results.ts:15')
}

export function notifyFileReadListeners(filePath: string, content: string): void {
  return notBuilt('src/tools/FileReadTool/read/results.ts:22')
}
