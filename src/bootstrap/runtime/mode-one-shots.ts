
export class ModeOneShotOwner {
  needsAutoModeExitAttachment = false
  hasEnteredAutoModeThisSession = false

  handleAutoModeTransition(fromMode: string, toMode: string): void {
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
