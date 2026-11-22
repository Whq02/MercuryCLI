import { useRef } from 'react'
import { useClaim } from './effects.js'
import { watch, type FSWatcher } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveWatchRoot, watchDirectory } from '../utils/watchRoot.js'
import {
  clearCommandsCache,
  getCommands,
  type Command,
} from '../commands.js'
import { projectConfigCandidatePaths } from '../utils/projectConfig.js'
import { logForDebugging } from '../utils/debug.js'
import { useSetAppStateMaybe } from '../state/AppState.js'
import { getSessionId } from '../bootstrap/state.js'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../utils/hooks/sessionHooks.js'
import { notBuilt } from '../pi/holes.js'

export function useSkillsChange(
  cwd: string | undefined,
  onCommandsChange: (commands: Command[]) => void,
): void {
  return notBuilt('src/hooks/useSkillsChange.ts:19')
}
