import type { ElementHandle } from 'puppeteer-core'
import type { ToolEffectOutcome } from '../../kit/tool.js'
import { approveSecretPairing } from '../../../integrations/browser/browserSession.js'
import { resolveBrowserSecret } from '../../../integrations/browser/browserSecrets.js'
import { TEXT_INPUT_TYPES } from './schema.js'
import { type LiveSession, pageWhere, targetOrigin, targetSurface } from './page.js'
import { actDeadline, actOriginGate, isDisabledTarget, probeEditableTarget, resolveActTarget } from './targets.js'
import { humanTypeText } from './human.js'
import type { OpDone, OpRun } from './ops.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export async function typeOp(s: LiveSession, { input, owner, signalFor, holdSecret }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  s.nav.seen = s.nav.seq
  if (typeof input.secretRef === 'string') {
    const secretOrigin = (await targetOrigin(s, input.frame))
    const requested = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s), input.frame)
    if (await isDisabledTarget(requested)) {
      result = `type refused: ${input.selector} is disabled — nothing filled`
      outcome = 'failed'
      return { result, outcome }
    }
    await requested.focus()
    const probe = await probeEditableTarget(s, requested, input.frame)
    if (!probe || !probe.held) {
      result = `type refused: focus did not land on ${input.selector}${
        probe ? ` — ${probe.desc} holds focus instead` : ''
      }; nothing filled`
      outcome = 'failed'
      return { result, outcome }
    }
    if (!probe.editable || probe.readOnly) {
      result = `type refused: ${probe.desc} is ${probe.readOnly ? 'readOnly' : 'not an editable field'} — nothing filled`
      outcome = 'failed'
      return { result, outcome }
    }
    if (!probe.credential) {
      result = `type refused: secretRef fills only credential-shaped targets, and ${probe.desc} is not one — pass text for an ordinary field`
      outcome = 'failed'
      return { result, outcome }
    }
    const resolved = resolveBrowserSecret(input.secretRef, { origin: secretOrigin })
    if (resolved.state !== 'ok') {
      result = `type refused: ${resolved.note}`
      outcome = 'failed'
      return { result, outcome }
    }
    holdSecret({ value: resolved.value, ref: input.secretRef })
    if (input.clear === true) {
      await targetSurface(s, input.frame).evaluate(() => {
        let active: Element | null = document.activeElement
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
        const el = active as HTMLInputElement | null
        if (!el) return
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select()
        else {
          const range = document.createRange()
          range.selectNodeContents(el)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      })
      await s.page.keyboard.press('Backspace')
    }
    const stillHeld = await probeEditableTarget(s, requested, input.frame)
    if (!stillHeld || !stillHeld.held) {
      result = `type refused mid-act: focus moved to ${stillHeld ? stillHeld.desc : '(nothing)'} before the fill — nothing filled`
      outcome = 'failed'
      return { result, outcome }
    }
    if (resolved.origin !== undefined) {
      const filled = await requested.evaluate((el, origin, value) => {
        let active: Element | null = document.activeElement
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
        if (location.origin !== origin || !el.isConnected || active !== el) return false
        const field = el as HTMLInputElement | HTMLTextAreaElement
        if (field.disabled || field.readOnly) return false
        const prototype = el.tagName === 'INPUT' ? HTMLInputElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : null
        if (prototype !== null) {
          const start = field.selectionStart ?? field.value.length
          const end = field.selectionEnd ?? start
          const next = field.value.slice(0, start) + value + field.value.slice(end)
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, next)
        } else if ((el as HTMLElement).isContentEditable) {
          el.textContent = (el.textContent ?? '') + value
        } else return false
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }))
        return true
      }, resolved.origin, resolved.value)
      if (!filled) {
        result = `type refused mid-act: focus moved to ${stillHeld.desc} before the fill — nothing filled`
        outcome = 'failed'
        return { result, outcome }
      }
    } else {
      await humanTypeText(s, resolved.value)
    }
    const entered = input.enter === true && (resolved.origin === undefined || (await targetOrigin(s, input.frame)) === resolved.origin)
    if (entered) await s.page.keyboard.press('Enter')
    approveSecretPairing(owner, input.secretRef, resolved.origin ?? (await targetOrigin(s, input.frame)))
    result = `type: filled secret ${input.secretRef} into ${probe.desc}${entered ? ' + Enter' : ''} at ${pageWhere(s)}`
    outcome = 'succeeded'
    return { result, outcome }
  }
  const targetName = input.selector ?? '(focused element)'
  let requested: ElementHandle<Element> | null = null
  if (input.selector) {
    requested = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame)
    if (await isDisabledTarget(requested)) {
      result = `type refused: ${input.selector} is disabled — nothing typed`
      outcome = 'failed'
      return { result, outcome }
    }
    await requested.focus()
  }
  const probe = await probeEditableTarget(s, requested, input.frame)
  if (input.selector && (!probe || !probe.held)) {
    result = `type refused: focus did not land on ${targetName}${
      probe ? ` — ${probe.desc} holds focus instead` : ''
    }; nothing typed`
    outcome = 'failed'
    return { result, outcome }
  }
  if (!probe || !probe.editable) {
    result = `type refused: ${targetName} is not an editable field (input/textarea/contenteditable) — nothing typed`
    outcome = 'failed'
    return { result, outcome }
  }
  if (probe.credential) {
    result = `type refused: ${probe.desc} is a credential field (${probe.credentialWhy}) — plain text never types into credential fields; pass secretRef instead (the operator registers the secret out-of-band and the value never enters the conversation)`
    outcome = 'failed'
    return { result, outcome }
  }
  if (probe.readOnly) {
    result = `type refused: ${probe.desc} is readOnly — nothing typed`
    outcome = 'failed'
    return { result, outcome }
  }
  if (probe.tag === 'input' && !TEXT_INPUT_TYPES.has(probe.type)) {
    result =
      probe.type === 'file'
        ? `type refused: ${probe.desc} is a file input — op:"upload" with files sets it`
        : ['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(probe.type)
          ? `type refused: ${probe.desc} is type=${probe.type} — use op:"click" to operate it`
          : `type refused: ${probe.desc} is type=${probe.type}, not a text-bearing input — nothing typed`
    outcome = 'failed'
    return { result, outcome }
  }
  if (input.clear === true) {
    await targetSurface(s, input.frame).evaluate(() => {
      let active: Element | null = document.activeElement
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      const el = active as HTMLInputElement | null
      if (!el) return
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select()
      else {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    })
    await s.page.keyboard.press('Backspace')
  }
  const credNow = await targetSurface(s, input.frame).evaluate(() => {
    let active: Element | null = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    if (!active || active === document.body) return null
    const a = active as HTMLInputElement
    const autocomplete = (a.getAttribute('autocomplete') ?? '').toLowerCase()
    const credAc = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'].some(
      t => autocomplete.includes(t),
    )
    const softText = `${a.name ?? ''} ${a.id ?? ''} ${a.getAttribute('aria-label') ?? ''}`
    const soft = /pass(word|wd)|otp|totp|2fa|one.?time|secret|api.?key|cvv|cvc|\bssn\b|\bpin\b/i.test(softText)
    return a.type === 'password' || credAc || soft
      ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}`
      : null
  })
  if (credNow !== null) {
    result = `type refused mid-act: focus moved to ${credNow} — a credential field; nothing typed`
    outcome = 'failed'
    return { result, outcome }
  }
  if (input.frame !== undefined && !(await probeEditableTarget(s, requested, input.frame))?.held) {
    result = 'type refused mid-act: focus left the target frame; nothing typed'
    outcome = 'failed'
    return { result, outcome }
  }
  await humanTypeText(s, input.text!)
  if (input.enter === true) await s.page.keyboard.press('Enter')
  let valueLen: number | null = null
  try {
    valueLen = await targetSurface(s, input.frame).evaluate(() => {
      let active: Element | null = document.activeElement
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      const el = active as HTMLInputElement | null
      return typeof el?.value === 'string' ? el.value.length : null
    })
  } catch (error) {
    passedOver(error)
  }
  result = `type: ${input.text!.length} chars into ${probe.desc}${input.enter === true ? ' + Enter' : ''}${
    valueLen !== null ? ` (value now ${valueLen} chars)` : ''
  } at ${pageWhere(s)}`
  outcome = 'succeeded'
  return { result, outcome }
}
