import { parseEmulation } from '../../../integrations/browser/browserEmulation.js'
import { parseAttachEndpoint } from '../../../integrations/browser/browserSession.js'
import { ATTACH_OP } from '../../../integrations/browser/browserWords.js'
import { BROWSER_SECRET_REF_GRAMMAR } from '../../../integrations/browser/browserSecrets.js'
import { type Input, PRESS_KEYS, browserToolEnabled } from './schema.js'
import { openSchemeRefusal } from './failures.js'
import { downloadAct } from './downloads.js'

export async function validateBrowserInput(asked: Input) {
  if (!browserToolEnabled()) {
    return { result: false as const, message: 'the Browser tool is disabled (MERCURY_BROWSER=0)', errorCode: 1 }
  }
  if (asked.op === 'download' && [asked.downloadId, asked.url, asked.selector].filter(given => given !== undefined && given !== '').length > 1) {
    return { result: false as const, message: 'download takes one of downloadId, url or selector', errorCode: 1 }
  }
  if (asked.op === ATTACH_OP) {
    const endpoint = parseAttachEndpoint(asked.endpoint)
    if ('refusal' in endpoint) return { result: false as const, message: endpoint.refusal, errorCode: 1 }
  }
  if (asked.endpoint !== undefined && asked.op !== ATTACH_OP) {
    return { result: false as const, message: 'endpoint requires op attach', errorCode: 1 }
  }
  const input = downloadAct(asked)
  if (input.tab !== undefined && (input.tab.trim() === '' || input.tab !== input.tab.trim() || /[\r\n]/.test(input.tab))) {
    return { result: false as const, message: 'tab takes a name on one line with no space around it', errorCode: 1 }
  }
  if (input.persist === true && input.op !== 'open') {
    return { result: false as const, message: 'persist requires op open', errorCode: 1 }
  }
  if (asked.downloadId !== undefined && asked.downloadId !== '' && asked.op !== 'download') {
    return { result: false as const, message: 'downloadId requires op download', errorCode: 1 }
  }
  if (asked.files !== undefined && asked.files.length > 0 && asked.op !== 'upload') {
    return { result: false as const, message: 'files requires op upload', errorCode: 1 }
  }
  if (asked.op === 'upload' && (!asked.selector || asked.files === undefined)) {
    return { result: false as const, message: 'upload requires selector and files (an empty list clears a file input)', errorCode: 1 }
  }
  if (input.op === 'open' && !(input.url === undefined && input.tab !== undefined) && (!input.url || !/^https?:\/\//.test(input.url))) {
    return { result: false as const, message: openSchemeRefusal(input.url), errorCode: 1 }
  }
  if (input.frame !== undefined && (!['click', 'type', 'scroll', 'waitFor', 'select', 'hover', 'extract', 'screenshot', 'upload'].includes(input.op) || (['click', 'scroll', 'screenshot'].includes(input.op) && !input.selector) || (input.op === 'waitFor' && !input.selector && input.text === undefined))) {
    return { result: false as const, message: 'frame requires a selector act/read, a type target, or a selector/text wait', errorCode: 1 }
  }
  if (input.force === true && (input.op !== 'click' || !input.selector)) {
    return { result: false as const, message: 'force requires click with a selector', errorCode: 1 }
  }
  if (input.op === 'click' && !input.selector && !(typeof input.x === 'number' && typeof input.y === 'number')) {
    return { result: false as const, message: 'click requires selector, or both x and y', errorCode: 1 }
  }
  if (input.op === 'type' && input.secretRef !== undefined) {
    if (typeof input.text === 'string') {
      return { result: false as const, message: 'type takes text OR secretRef, never both', errorCode: 1 }
    }
    if (!input.selector) {
      return {
        result: false as const,
        message: 'secretRef requires an explicit selector target (secrets are never aimed at "whatever is focused")',
        errorCode: 1,
      }
    }
    if (!BROWSER_SECRET_REF_GRAMMAR.test(input.secretRef)) {
      return {
        result: false as const,
        message: `secretRef "${input.secretRef}" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)`,
        errorCode: 1,
      }
    }
  }
  if (input.op === 'type' && input.secretRef === undefined && typeof input.text !== 'string') {
    return { result: false as const, message: 'type requires text (the characters to type) or secretRef', errorCode: 1 }
  }
  if (input.op === 'type' && input.clear === true && !input.selector) {
    return { result: false as const, message: 'clear requires a selector target', errorCode: 1 }
  }
  if (input.op === 'scroll' && !input.selector && typeof input.dy !== 'number') {
    return { result: false as const, message: 'scroll requires selector or dy', errorCode: 1 }
  }
  if (input.op === 'waitFor' && input.selector !== undefined && input.text !== undefined) {
    return {
      result: false as const,
      message: 'waitFor takes selector OR text (or neither, meaning navigation)',
      errorCode: 1,
    }
  }
  if (input.op === 'waitFor' && input.state !== undefined && input.selector === undefined) {
    return {
      result: false as const,
      message: 'waitFor state requires a selector (visibility states describe an element)',
      errorCode: 1,
    }
  }
  if (input.op === 'select' && (!input.selector || !input.values || input.values.length === 0)) {
    return {
      result: false as const,
      message: 'select requires selector and values (option values, or visible labels as the fallback)',
      errorCode: 1,
    }
  }
  if (input.op === 'press' && (!input.key || !PRESS_KEYS.has(input.key))) {
    return {
      result: false as const,
      message: `press takes a key from the allowlist [${[...PRESS_KEYS].join(', ')}] — printable characters go through op:"type" (where credential fields refuse)`,
      errorCode: 1,
    }
  }
  if (input.op === 'hover' && !input.selector) {
    return { result: false as const, message: 'hover requires selector', errorCode: 1 }
  }
  if (input.emulation !== undefined) {
    if (input.op !== 'viewport') return { result: false as const, message: 'emulation requires op viewport', errorCode: 1 }
    const parsed = parseEmulation(input.emulation)
    if ('refusal' in parsed) return { result: false as const, message: parsed.refusal, errorCode: 1 }
    const ref = parsed.request.credentials?.secret
    if (ref !== undefined && !BROWSER_SECRET_REF_GRAMMAR.test(ref)) {
      return {
        result: false as const,
        message: `emulation.credentials.secret "${ref}" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)`,
        errorCode: 1,
      }
    }
  }
  if (input.op === 'viewport' && input.emulation === undefined && (typeof input.width !== 'number' || typeof input.height !== 'number')) {
    return { result: false as const, message: 'viewport requires width and height (CSS px)', errorCode: 1 }
  }
  return { result: true as const }
}
