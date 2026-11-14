#!/usr/bin/env bun
import { check, finish, pageOf, requireBrowser, run, serve } from './harness.ts'

await requireBrowser()
const fixture = await serve(27286, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(`<title>locale</title><script>window.received=${JSON.stringify(req.headers['accept-language'] ?? '')}</script>`)
})
await run({ op: 'open', url: fixture.origin })
const baseline = await pageOf().evaluate(() => [...navigator.languages])
await pageOf().evaluate(() => {
  const proto = Object.getPrototypeOf(navigator)
  ;(window as unknown as { held: unknown }).held = {
    toString: Function.prototype.toString,
    query: Permissions.prototype.query,
    webgl: WebGLRenderingContext.prototype.getParameter,
    language: Object.getOwnPropertyDescriptor(proto, 'language')!.get!,
    languages: Object.getOwnPropertyDescriptor(proto, 'languages')!.get!,
  }
})
for (const locale of ['fr-FR', 'de-DE', null]) {
  const applied = await run({ op: 'viewport', emulation: { locale } })
  const read = await pageOf().evaluate(() => {
    const held = (window as unknown as { held: Record<string, Function> }).held
    const proto = Object.getPrototypeOf(navigator)
    const getter = Object.getOwnPropertyDescriptor(proto, 'languages')!.get!
    return {
      stable: held.toString === Function.prototype.toString && held.query === Permissions.prototype.query && held.webgl === WebGLRenderingContext.prototype.getParameter && held.languages === getter,
      presented: held.toString!.call(getter),
      languages: [...navigator.languages],
      retained: [...held.languages!.call(navigator)],
      language: held.language!.call(navigator),
      frozen: Object.isFrozen(navigator.languages),
      vectorStable: navigator.languages === navigator.languages,
      locale: Intl.NumberFormat().resolvedOptions().locale,
    }
  })
  const expected = locale === null ? baseline : [locale, locale.split('-')[0]!]
  check(`locale ${locale}: the browser applied the requested value`, applied.outcome === 'succeeded' && JSON.stringify(read.languages) === JSON.stringify(expected), applied.result)
  check(`locale ${locale}: no unrelated patch or language getter was replaced`, read.stable, JSON.stringify(read))
  check(`locale ${locale}: a retained presenter still sees a native getter`, read.presented === 'function get languages() { [native code] }', read.presented)
  check(`locale ${locale}: retained getters read the current frozen stable vector`, JSON.stringify(read.retained) === JSON.stringify(expected) && read.language === expected[0] && read.frozen && read.vectorStable, JSON.stringify(read))
}
await run({ op: 'viewport', emulation: { locale: 'fr-FR' } })
await run({ op: 'reload' })
const later = await pageOf().evaluate(() => ({ languages: [...navigator.languages], received: (window as unknown as { received: string }).received }))
check('a new document agrees with the navigation header', JSON.stringify(later.languages) === '["fr-FR","fr"]' && later.received.startsWith('fr-FR,fr'), JSON.stringify(later))
await finish('prove-browser-locale-identity')
