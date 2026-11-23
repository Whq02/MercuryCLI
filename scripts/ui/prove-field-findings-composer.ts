#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 CI-01 — the composer reads the field the editor returns')
{
}

console.log('§2 CI-02 — the masked branch paints renderedValue (the owner already masked it)')
{
  const { Cursor } = await import('../../src/screen/composer/vim/textCursor.ts')
  const INV = (s: string): string => `\x1b[7m${s}\x1b[27m`
  const secret = 'sk-ant-0123456789abcdef'
  const rendered = Cursor.fromText(secret, 80, secret.length).render('', '•', INV)
  const dots = (rendered.match(/•/g) ?? []).length
  check('the masked render masks every grapheme but the six-tail', dots === [...secret].length - 6, `dots=${dots} — change Cursor.render in src/screen/composer/vim/textCursor.ts so the mask character covers every grapheme except the last six`)
  check('the six-grapheme tail stays readable (the reveal law)', rendered.includes('abcdef'), 'change Cursor.render in src/screen/composer/vim/textCursor.ts so the last six graphemes of a masked value are printed')
  check('the head never leaks', !rendered.includes('sk-ant'), 'change Cursor.render in src/screen/composer/vim/textCursor.ts so the head of a masked value is replaced by the mask character')
}

process.exit(failures === 0 ? 0 : 1)
