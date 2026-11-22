import { notBuilt } from '../pi/holes.js'

export function needsPowerShellBom(filePath: string, platform?: NodeJS.Platform): boolean {
  return notBuilt('src/utils/fileEncoding.ts:7')
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  return notBuilt('src/utils/fileEncoding.ts:12')
}
