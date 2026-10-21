import { sanitizeSvg, normalizeSampleDoc, renderSampleDoc } from '../../src/services/samples/renderDoc.js'

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok ? ` — ${detail}` : ''}`)
}

const handlers = [
  '<svg><svg/onload="document.title=\'SVG SCRIPT EXECUTED\'"></svg></svg>',
  '<svg><g/onpointerover=alert(1)><rect width="10" height="10"/></g></svg>',
  '<svg><g data-label="a > b"/onclick=alert(1)><text>safe</text></g></svg>',
  '<svg><g data-label="a < b" onload=alert(1)><text>safe</text></g></svg>',
  '<svg><g\u0000onload=alert(1)><text>safe</text></g></svg>',
  '<svg><script/x>document.title="SCRIPT"</script><text>safe</text></svg>',
  '<svg><foreignObject/x><img/src=x/onerror=alert(1)></foreignObject><text>safe</text></svg>',
  '<svg><title><img/src=x/onerror=alert(1)></title><text>safe</text></svg>',
]
handlers.forEach((input, i) => {
  const out = sanitizeSvg(input)
  check(`H${i + 1} markup cannot carry an event or executable element`, !/\bon(?:load|click|pointerover|error)\s*=|<script\b|<foreignobject\b|<img\b/i.test(out), out)
})

const references = [
  '<svg><a href="#safe"><animate attributeName="href" values="#safe;javascript:alert(1)"/></a></svg>',
  '<svg><a href="#safe"><set attributeName="href" to="jav&#x61;script:alert(1)"/></a></svg>',
  '<svg><a href="#safe"><animate attributeName="href" values="#safe;https://example.invalid/a"/></a></svg>',
  '<svg><image href="https&colon;//example.invalid/a"/></svg>',
  '<svg><image href="image.png"/></svg>',
  '<svg><a href="data:text/html;base64,PHNjcmlwdD4="/></svg>',
  '<svg><rect style="fill:u\\72l(\\68 ttps://example.invalid/a)"/></svg>',
  '<svg><rect fill="url(//example.invalid/a)"/></svg>',
  '<svg><set attributeName="onload" to="alert(1)"/></svg>',
]
references.forEach((input, i) => {
  const out = sanitizeSvg(input)
  check(`U${i + 1} dynamic, encoded and relative active references are stripped`, !/javascript|jav&#|example\.invalid|image\.png|data:text|attributeName="onload"/i.test(out), out)
})

const safe = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#clip)"><rect id="box" class="fx-box" fill="url(#paint)" width="4" height="4"><animate attributeName="x" values="0;5;0" dur="2s" repeatCount="indefinite"/></rect><use xlink:href="#box"/><image href="data:image/png;base64,AAAA"/><text x="1" y="2">A &amp; B &lt; C</text></g></svg>'
const out = sanitizeSvg(safe)
check('S1 namespaces, gradients, clipping, local references and data images remain', ['xmlns="http://www.w3.org/2000/svg"', 'xmlns:xlink="http://www.w3.org/1999/xlink"', '<linearGradient', '<clipPath', 'clip-path="url(#clip)"', 'fill="url(#paint)"', 'xlink:href="#box"', 'href="data:image/png;base64,AAAA"'].every(x => out.includes(x)), out)
check('S2 safe animation, classes, geometry and escaped text remain', ['class="fx-box"', 'width="4"', 'attributeName="x"', 'values="0;5;0"', 'dur="2s"', 'repeatCount="indefinite"', 'A &amp; B &lt; C'].every(x => out.includes(x)), out)
check('S3 sanitization is idempotent', sanitizeSvg(out) === out)
const deep = `<svg>${'<g>'.repeat(12_000)}<text>deep</text>${'</g>'.repeat(12_000)}</svg>`
check('S4 deep SVG nesting is processed without recursive stack growth', sanitizeSvg(deep) === deep)
const html = renderSampleDoc(normalizeSampleDoc({ parts: [{ kind: 'figure', svg: handlers[0], alt: 'safe figure' }] }))
check('S5 the actual rendered document contains only the product script, no hostile handler', (html.match(/<script>/g) ?? []).length === 1 && !html.includes('SVG SCRIPT EXECUTED') && html.includes('aria-label="safe figure"'))
check('P1 the handler comparator detects the original malformed SVG', /\bonload\s*=/.test(handlers[0]!))
console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
