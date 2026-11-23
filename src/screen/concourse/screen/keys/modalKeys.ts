import { boardModalOwner } from '../../boardModalOwner.js'
import type { InputEvent, Key } from '../../../themedRenderer.js'
import type { KeysArgs } from '../state.js'

export function modalKeys(input: string, key: Key, event: InputEvent, { callbacks, answerCapacityAsk, answerTrustAsk, capacityAskRef, clearDoorNote, doorNoteRef, gitOfferRef, groundPickerOpenRef, helpOpenRef, modelDefaultOpenRef, rowPickRef, setHelpOpen, trustAskRef }: KeysArgs): boolean {
  if (doorNoteRef.current) clearDoorNote()
  const modalOwner = boardModalOwner({
    capacityAsk: capacityAskRef.current,
    trustAsk: trustAskRef.current !== null,
    groundPickerOpen: groundPickerOpenRef.current,
    rowPick: rowPickRef.current !== null,
    modelDefault: modelDefaultOpenRef.current,
    gitOffer: gitOfferRef.current !== undefined,
    helpOpen: helpOpenRef.current,
  })
  const plainConsent = !key.ctrl && !key.meta && !key.super
  if (modalOwner === null && callbacks.daemonOfferArmed?.() === true && callbacks.answerDaemonOffer !== undefined) {
    if (plainConsent && (input === 'y' || input === 'Y')) {
      event.stopImmediatePropagation()
      callbacks.answerDaemonOffer(true)
      return true
    }
    if (key.escape || (plainConsent && (input === 'n' || input === 'N'))) {
      event.stopImmediatePropagation()
      callbacks.answerDaemonOffer(false)
      return true
    }
  }
  if (modalOwner === 'help') {
    event.stopImmediatePropagation()
    if (key.escape || input === '?' || key.return) {
      helpOpenRef.current = false
      setHelpOpen(false)
    }
    return true
  }
  if (modalOwner === 'capacity-ask') {
    event.stopImmediatePropagation()
    if (plainConsent && (input === 'y' || input === 'Y')) answerCapacityAsk(true)
    else if (key.escape || (plainConsent && (input === 'n' || input === 'N'))) answerCapacityAsk(false)
    return true
  }
  if (modalOwner === 'trust-ask') {
    event.stopImmediatePropagation()
    if (plainConsent && (input === 'y' || input === 'Y')) answerTrustAsk(true)
    else if (key.escape || (plainConsent && (input === 'n' || input === 'N'))) answerTrustAsk(false)
    return true
  }
  if (modalOwner !== null) return true
  return false
}
