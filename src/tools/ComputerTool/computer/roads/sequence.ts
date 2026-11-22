import { isTerminalApplication, readTerminalText } from '../../terminalText.js'
import { WEB_CONTENT_NOTICE } from '../../../BashTool/webContent.js'
import type { PermissionDecision } from '../../../../types/permissions.js'
import { appApproved, peekCheckedActApp } from '../../../../services/desktop/desktopSession.js'
import { type DesktopObservation, STATE_LINE, observationChanged, readObservation, stateWord, treeObservation } from '../../fastRoad.js'
import { ACT_ACTIONS, type Input, SCREENSHOT_SUPERSEDED, SCREENSHOT_UNSEEN, permissionAction } from '../schema.js'
import { frontAfterCard } from '../plan.js'
import { interruptedAfterActText, interruptedText } from '../words.js'
import { takeScreenshot } from '../shot.js'
import type { ComputerAnswer, RoadNeeds } from './needs.js'
import { notBuilt } from '../../../../pi/holes.js'

export async function sequenceRoad(arg0: RoadNeeds, steps: Input[]): Promise<ComputerAnswer> {
  return notBuilt('src/tools/ComputerTool/computer/roads/sequence.ts:12')
}
