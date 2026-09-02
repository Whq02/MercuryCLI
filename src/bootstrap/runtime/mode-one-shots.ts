
export class ModeOneShotOwner {
  hasExitedPlanMode = false
  needsPlanModeExitAttachment = false
  needsAutoModeExitAttachment = false
  hasEnteredPlanModeThisSession = false
  hasEnteredAutoModeThisSession = false

  handlePlanModeTransition(fromMode: string, toMode: string): void {
    if (toMode === 'strategy' && fromMode !== 'strategy') {
      this.hasEnteredPlanModeThisSession = true
      this.needsPlanModeExitAttachment = false
    }

    if (fromMode === 'strategy' && toMode !== 'strategy') {
      this.needsPlanModeExitAttachment = true
    }
  }

  handleAutoModeTransition(fromMode: string, toMode: string): void {
    if (
      (fromMode === 'flow' && toMode === 'strategy') ||
      (fromMode === 'strategy' && toMode === 'flow')
    ) {
      return
    }
    const fromIsAuto = fromMode === 'flow'
    const toIsAuto = toMode === 'flow'

    if (toIsAuto && !fromIsAuto) {
      this.hasEnteredAutoModeThisSession = true
      this.needsAutoModeExitAttachment = false
    }

    if (fromIsAuto && !toIsAuto && this.hasEnteredAutoModeThisSession) {
      this.needsAutoModeExitAttachment = true
    }
  }
}
