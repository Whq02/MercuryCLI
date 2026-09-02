#!/usr/bin/env bun
// ============================================================================
//  scripts/search/prove-search-parsers.ts — the search backends' PARSERS
//  over the captured fixtures, with their shape poisons.
//
//    §1 DuckDuckGo html: the captured results page parses to its ten hits
//       (first hit exact: title, url, tag-stripped snippet); the captured
//       202 challenge page reads CHALLENGE; the POISON (a changed page
//       shape) reads UNRECOGNISED — never a guessed hit; a framed page with
//       zero result blocks is an honest EMPTY; the /l/?uddg redirect form
//       decodes; ad blocks and y.js redirects drop.
//    §2 DuckDuckGo lite: the captured page parses (positional snippet
//       pairing); challenge and poison as §1.
//    §3 Brave decode: the documented body to hits, <strong> stripped and
//       entities decoded; no-web empty; poison unrecognised.
//    §4 Tavily decode: the documented body to hits; poison unrecognised.
//    §5 the domain law: allow/block matching (subdomains, www, unparseable
//       urls), normaliseHits (dedupe · snippet bound · cap).
//    §6 the honest lines: every failure kind's one line; via lines; the
//       query builders' site:/-site: operators and Tavily's native lists.
//
//  Pure and hermetic — no network, no config home.
//  Run:  ~/.bun/bin/bun run scripts/search/prove-search-parsers.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

// Portable under node AND bun (the node bundle-and-run verdict law:
// import.meta.dir is Bun-only).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const page = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const { parseDuckDuckGoHtml, parseDuckDuckGoLite, resolveDuckDuckGoHref, keylessQueryFor } = await import('../../src/services/search/duckduckgo.js')
const { decodeBraveWebSearch, braveQueryFor } = await import('../../src/services/search/brave.js')
const { decodeTavilySearch, tavilyRequestBodyFor } = await import('../../src/services/search/tavily.js')
const { decodeHtmlEntities, htmlToText, readAttribute } = await import('../../src/services/search/htmlText.js')
const contract = await import('../../src/services/search/searchContract.js')

// ---------------------------------------------------------------------------
section('§1 DuckDuckGo html — the captured page, the challenge, the poison')
{
  const parsed = parseDuckDuckGoHtml(page('ddg-html-results.html'))
  check('the captured results page parses as results', parsed.kind === 'results', parsed.kind)
  if (parsed.kind === 'results') {
    check('…ten hits', parsed.hits.length === 10, String(parsed.hits.length))
    const first = parsed.hits[0]
    check('…first hit title exact', first?.title === 'Harness: AI for DevOps, Testing, AppSec, and Cost Optimization', j(first))
    check('…first hit url exact', first?.url === 'https://www.harness.io/', j(first?.url))
    check('…first hit snippet tag-stripped ("<b>Harness</b>" reads as words)', (first?.snippet ?? '').startsWith('Harness is a unified, end-to-end AI software delivery platform'), j(first?.snippet))
    check('…no duckduckgo.com host among the hit urls', parsed.hits.every(h => !/duckduckgo\.com/.test(h.url)), j(parsed.hits.map(h => h.url)))
  }
  check('the captured 202 challenge page reads CHALLENGE', parseDuckDuckGoHtml(page('ddg-html-anomaly-202.html')).kind === 'challenge')
  const poison = parseDuckDuckGoHtml('<html><body><div class="totally-new-shape"><a href="https://example.com/x">A link</a></div></body></html>')
  check('POISON: a changed page shape reads UNRECOGNISED, never a hit', poison.kind === 'unrecognised', poison.kind)
  const framedEmpty = parseDuckDuckGoHtml('<html><body><form name="x" class="header__form" action="/html/" method="post"></form><div id="links" class="results"><div class="no-results">No results.</div></div></body></html>')
  check('a framed page with zero result blocks is an honest EMPTY', framedEmpty.kind === 'results' && framedEmpty.hits.length === 0, j(framedEmpty))
  check('the /l/?uddg redirect decodes to the target', resolveDuckDuckGoHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=abc') === 'https://example.com/page?a=1')
  check('a y.js ad redirect resolves to nothing', resolveDuckDuckGoHref('https://duckduckgo.com/y.js?ad_provider=x&u3=https%3A%2F%2Fad.example') === undefined)
  const withAd = page('ddg-html-results.html').replace('class="result results_links results_links_deep web-result "', 'class="result results_links results_links_deep result--ad web-result "')
  const adParsed = parseDuckDuckGoHtml(withAd)
  check('an advertisement block (result--ad) drops from the hits', adParsed.kind === 'results' && adParsed.hits.length === 9, adParsed.kind === 'results' ? String(adParsed.hits.length) : adParsed.kind)
  // A RECOGNISED page whose text carries a numeric entity above
  // the Unicode range must still PARSE — the literal kept, never an untyped
  // RangeError escaping the parser (String.fromCodePoint throws > 0x10FFFF).
  const entityPoison = parseDuckDuckGoHtml('<html><body><div id="links"><div class="result results_links"><a rel="nofollow" class="result__a" href="https://example.com/x">poison &#x110000; &#99999999999999999999; title</a></div></div></body></html>')
  check('POISON: over-range numeric entities PARSE (total — never a thrown RangeError), the literal kept',
    entityPoison.kind === 'results' && entityPoison.hits[0]?.title === 'poison &#x110000; &#99999999999999999999; title', j(entityPoison))
}

// ---------------------------------------------------------------------------
section('§2 DuckDuckGo lite — the captured page, the challenge, the poison')
{
  const parsed = parseDuckDuckGoLite(page('ddg-lite-results.html'))
  check('the captured lite page parses as results', parsed.kind === 'results', parsed.kind)
  if (parsed.kind === 'results') {
    check('…ten hits', parsed.hits.length === 10, String(parsed.hits.length))
    const first = parsed.hits[0]
    check('…first hit title exact', first?.title === 'Harness: AI for DevOps, Testing, AppSec, and Cost Optimization', j(first))
    check('…first hit url exact', first?.url === 'https://www.harness.io/', j(first?.url))
    check('…snippets paired positionally (first hit has one)', (first?.snippet ?? '').includes('unified, end-to-end AI software delivery platform'), j(first?.snippet))
  }
  check('the captured lite 202 challenge page reads CHALLENGE', parseDuckDuckGoLite(page('ddg-lite-anomaly-202.html')).kind === 'challenge')
  check('POISON: a changed lite shape reads UNRECOGNISED', parseDuckDuckGoLite('<html><body><table><tr><td>new shape</td></tr></table></body></html>').kind === 'unrecognised')
  const framedEmpty = parseDuckDuckGoLite("<html><body><form action=\"/lite/\" method=\"post\"></form>No more results.</body></html>")
  check('a framed lite page with zero rows is an honest EMPTY', framedEmpty.kind === 'results' && framedEmpty.hits.length === 0, j(framedEmpty))
  // The same over-range-entity totality on the lite shape —
  // title and snippet both keep the literal, nothing throws.
  const entityPoisonLite = parseDuckDuckGoLite("<html><body><table><tr><td><a rel=\"nofollow\" class='result-link' href=\"https://example.com/x\">poison &#x110000; title</a></td></tr><tr><td class='result-snippet'>snippet &#xFFFFFFFF; text</td></tr></table></body></html>")
  check('POISON: over-range entities on the lite page PARSE with the literal kept (title and snippet)',
    entityPoisonLite.kind === 'results' && entityPoisonLite.hits[0]?.title === 'poison &#x110000; title' && entityPoisonLite.hits[0]?.snippet === 'snippet &#xFFFFFFFF; text', j(entityPoisonLite))
}

// ---------------------------------------------------------------------------
section('§3 Brave — the documented decode and its poison')
{
  const decoded = decodeBraveWebSearch(JSON.parse(page('brave-web-search.json')))
  check('the fixture body decodes to its three hits', decoded.kind === 'results' && decoded.hits.length === 3, j(decoded))
  if (decoded.kind === 'results') {
    const first = decoded.hits[0]
    check('…title/url exact', first?.title === 'Harness: AI for DevOps, Testing, AppSec, and Cost Optimization' && first?.url === 'https://www.harness.io/', j(first))
    check('…description <strong> stripped into the snippet', first?.snippet === 'Harness is a unified, end-to-end AI software delivery platform to manage the SDLC using purpose-built AI agents.', j(first?.snippet))
    check('…entities decode (&amp; reads &)', decoded.hits[1]?.snippet?.includes('harnesses & the trade-offs') === true, j(decoded.hits[1]?.snippet))
  }
  check('a no-web search envelope is an honest EMPTY', (() => { const d = decodeBraveWebSearch({ type: 'search', query: { original: 'x' } }); return d.kind === 'results' && d.hits.length === 0 })())
  check('POISON: a body without web.results reads UNRECOGNISED', decodeBraveWebSearch({ shape: 'never-seen' }).kind === 'unrecognised')
  check('POISON: a non-object body reads UNRECOGNISED', decodeBraveWebSearch('nope').kind === 'unrecognised')
  // Brave titles/descriptions pass htmlToText — the same
  // over-range-entity totality holds on this door's decode.
  check('POISON: an over-range entity in a title/description decodes to the LITERAL, never a throw', (() => {
    const d = decodeBraveWebSearch({ web: { results: [{ title: 'T &#x110000;', url: 'https://x.org/', description: 'D &#78000000;' }] } })
    return d.kind === 'results' && d.hits[0]?.title === 'T &#x110000;' && d.hits[0]?.snippet === 'D &#78000000;'
  })())
}

// ---------------------------------------------------------------------------
section('§4 Tavily — the documented decode and its poison')
{
  const decoded = decodeTavilySearch(JSON.parse(page('tavily-search.json')))
  check('the fixture body decodes to its two hits', decoded.kind === 'results' && decoded.hits.length === 2, j(decoded))
  if (decoded.kind === 'results') {
    check('…title/url/content exact', decoded.hits[0]?.url === 'https://developer.harness.io/' && decoded.hits[0]?.snippet?.startsWith('Documentation, tutorials') === true, j(decoded.hits[0]))
  }
  check('POISON: a body without a results array reads UNRECOGNISED', decodeTavilySearch({ answer: 'x' }).kind === 'unrecognised')
}

// ---------------------------------------------------------------------------
section('§5 the domain law and hit normalisation')
{
  const hits = [
    { title: 'a', url: 'https://www.example.com/a' },
    { title: 'b', url: 'https://docs.example.com/b' },
    { title: 'c', url: 'https://other.net/c' },
    { title: 'd', url: 'not a url' },
  ]
  check('an allow list keeps the domain and its subdomains (www stripped)', j(contract.filterHitsByDomain(hits, ['example.com']).map(h => h.title)) === j(['a', 'b']))
  check('a block list drops the domain and its subdomains', j(contract.filterHitsByDomain(hits, undefined, ['example.com']).map(h => h.title)) === j(['c', 'd']))
  check('an unparseable url never passes an allow list but passes a block list', !contract.filterHitsByDomain(hits, ['example.com']).some(h => h.title === 'd') && contract.filterHitsByDomain(hits, undefined, ['other.net']).some(h => h.title === 'd'))
  check('an allow entry tolerates scheme/path dressing', contract.filterHitsByDomain(hits, ['https://example.com/blog']).length === 2)
  const normalised = contract.normaliseHits(
    [
      { title: 'dup', url: 'https://x.org/1' },
      { title: 'dup2', url: 'https://x.org/1' },
      { title: '', url: 'https://x.org/2', snippet: 'y'.repeat(1000) },
      { title: 'blank-url', url: '  ' },
    ],
    5,
  )
  check('normaliseHits dedupes by url, drops blank urls, titles a titleless hit with its url', normalised.length === 2 && normalised[1]?.title === 'https://x.org/2', j(normalised.map(h => [h.title, h.url])))
  check(`…and bounds the snippet at ${contract.MAX_SNIPPET_CHARS} chars with an ellipsis`, (normalised[1]?.snippet ?? '').length === contract.MAX_SNIPPET_CHARS && (normalised[1]?.snippet ?? '').endsWith('…'))
  check('…and caps the count', contract.normaliseHits(Array.from({ length: 30 }, (_, i) => ({ title: String(i), url: `https://x.org/${i}` })), 10).length === 10)
}

// ---------------------------------------------------------------------------
section('§6 the honest lines and the query builders')
{
  const kinds = ['no-backend', 'rate-limited', 'parse-failed', 'network', 'key-refused', 'provider-refused'] as const
  for (const kind of kinds) {
    const line = contract.failureLine(contract.searchFailure(kind, kind === 'no-backend' ? 'none' : 'duckduckgo', 'detail-words'))
    check(`failureLine(${kind}) is one sentence carrying the detail`, line.includes('detail-words') && !line.includes('\n'), line)
  }
  check('failureLine(parse-failed) says no result was guessed', contract.failureLine(contract.searchFailure('parse-failed', 'brave', 'x')).includes('no result was guessed'))
  check('viaLine(keyless) names the key door remedy', contract.viaLine('duckduckgo', 'keyless').includes('/router key brave'))
  check('viaChip(keyless) is the row spelling', contract.viaChip('duckduckgo', 'keyless') === 'via DuckDuckGo (keyless — add a Brave or Tavily key for richer results)')
  check('viaChip(keyed/native) name the tier', contract.viaChip('brave', 'keyed') === 'via Brave Search (keyed)' && contract.viaChip('openai-native', 'native') === 'via OpenAI web search (native)')
  check('one allowed domain rides as site: on the keyless query', keylessQueryFor({ query: 'q', allowedDomains: ['example.com'] }) === 'q site:example.com')
  check('several allowed domains do NOT ride the query (the post-filter is the law)', keylessQueryFor({ query: 'q', allowedDomains: ['a.com', 'b.com'] }) === 'q')
  check('blocked domains ride as -site:, bounded at five', keylessQueryFor({ query: 'q', blockedDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] }) === 'q -site:a.com -site:b.com -site:c.com -site:d.com -site:e.com')
  check('the Brave query builder speaks the same operators', braveQueryFor({ query: 'q', allowedDomains: ['example.com'], blockedDomains: ['x.net'] }) === 'q site:example.com -site:x.net')
  const body = tavilyRequestBodyFor({ query: 'q', allowedDomains: ['a.com'], blockedDomains: ['b.com'], maxResults: 7 })
  check('the Tavily body carries the documented fields and the native domain lists', j(body) === j({ query: 'q', max_results: 7, search_depth: 'basic', include_answer: false, include_raw_content: false, include_domains: ['a.com'], exclude_domains: ['b.com'] }))
  check('entity decoding handles named, decimal and hex forms', decodeHtmlEntities('&amp;&#65;&#x42;&nbsp;&unknown;') === '&AB &unknown;')
  check('entity decoding is TOTAL: above-Unicode numeric forms stay as written (String.fromCodePoint would throw), the last legal code point still decodes',
    decodeHtmlEntities('&#x110000;&#x10ffff;&#99999999999999999999;') === `&#x110000;${String.fromCodePoint(0x10ffff)}&#99999999999999999999;`)
  check('htmlToText strips tags and collapses whitespace', htmlToText('  <b>Bold</b>\n  and <i>italic</i>  ') === 'Bold and italic')
  check('readAttribute reads either quote style in any order', readAttribute('rel="nofollow" href=\'https://x.org/1\' class="a"', 'href') === 'https://x.org/1')
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ SEARCH PARSERS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SEARCH PARSER FAILURE(S)`)
process.exit(1)
