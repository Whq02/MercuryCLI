import { notBuilt } from '../../pi/holes.js'

const SEGMENT_BOUNDARY = String.raw`(?:^|[;&|])\s*`

function firstFlagCluster(afterCommand: string): string | null {
  const match = afterCommand.match(/^\s+-([A-Za-z]+)(?:\s|$)/)
  return match ? (match[1] as string) : null
}

type Matcher = (command: string) => string | null

export function isDestructiveCommandVerb(command: string): boolean {
  return notBuilt('src/utils/shell/destructiveCommandWarning.ts:116')
}

export function getDestructiveCommandWarning(command: string): string | null {
  return notBuilt('src/utils/shell/destructiveCommandWarning.ts:121')
}

export function shellCommandSegments(command: string): { words: string[]; piped: boolean }[] {
  return notBuilt('src/utils/shell/destructiveCommandWarning.ts:131')
}
