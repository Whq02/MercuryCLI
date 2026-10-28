import { randomUUID } from 'node:crypto'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { resolveBrowser } from '../../services/browser/browserResolver.js'
import { closeBrowserSession, ensureBrowserSession } from '../../services/browser/browserSession.js'
import { makeOwnerKey, parseOwnerKey, type OwnerKey } from '../../services/run/ownerKey.js'
import type { DocumentInput } from './schema.js'

export async function printDocument(html: string, input: DocumentInput, owner: OwnerKey | undefined, signal: AbortSignal): Promise<Uint8Array | null> {
  if (input.renderer === 'plain') return null
  if (!flagEnabled('MERCURY_BROWSER')) {
    if (input.renderer === 'browser') throw new Error('Browser rendering is disabled (MERCURY_BROWSER=0)')
    return null
  }
  const resolution = resolveBrowser()
  if (resolution.state !== 'ok') {
    if (input.renderer === 'browser') throw new Error(resolution.note)
    return null
  }
  if (!owner) throw new Error('PDF browser rendering requires a session owner')
  const identity = parseOwnerKey(owner)
  const printOwner = makeOwnerKey({ ...identity, lane: `${identity.lane}/document-${randomUUID()}` })
  const session = await ensureBrowserSession(printOwner, { headless: true, signal })
  if ('reason' in session) throw new Error(String(session.reason))
  if (!('page' in session)) throw new Error(JSON.stringify(session))
  const page = session.page
  const abort = (): void => { void closeBrowserSession(printOwner) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', request => {
      if (request.isInterceptResolutionHandled()) return
      void (/^data:image\/(png|jpeg);base64,/i.test(request.url()) ? request.continue() : request.abort())
    })
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
    const margin = `${input.margin ?? 54}pt`
    const bytes = await page.pdf({ format: input.paper ?? 'A4', printBackground: true, margin: { top: margin, bottom: margin, left: margin, right: margin }, displayHeaderFooter: Boolean(input.pageNumbers), headerTemplate: '<span></span>', footerTemplate: input.pageNumbers ? '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span></div>' : '<span></span>', timeout: 30_000 })
    signal.throwIfAborted()
    return bytes
  } finally {
    signal.removeEventListener('abort', abort)
    await closeBrowserSession(printOwner)
  }
}
