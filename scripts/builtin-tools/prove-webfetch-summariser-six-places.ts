#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const createdHome = process.env.MERCURY_CONFIG_DIR ? null : realpathSync(mkdtempSync(join(tmpdir(), 'webfetch-summariser-six-')))
if (createdHome !== null) process.env.MERCURY_CONFIG_DIR = createdHome
process.env.NODE_ENV = 'test'

const HINT = 'check applyPromptToMarkdown in src/tools/web-fetch/fetchContent.ts'
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!ok) failures++
}

try {
  const { applyPromptToMarkdown } = await import('../../src/tools/web-fetch/fetchContent.ts')
  const { AbortError } = await import('../../src/platform/errors/errors.ts')
  const said = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
  const refused = (text: string) => ({ isApiErrorMessage: true, message: { content: text === '' ? [] : [{ type: 'text', text }] } })
  const thrower = (thrown: unknown) => async () => { throw thrown }
  const LABEL = '[Model reading of the extracted page, not the page’s own words.]\n\n'
  const sig = new AbortController().signal
  const ask = (reads: Record<string, unknown>, signal: AbortSignal = sig): Promise<string> => applyPromptToMarkdown('q', 'PAGE', signal, true, false, reads as never)
  const road = (answer: string): string => /Road: ([^\]]*)\.\]/.exec(answer)?.[1] ?? answer

  console.log('step 1: the text of a reply is used as it stands')
  {
    const r = await ask({ utility: async () => said('  SUMMARY with spaces \n'), withModel: thrower(new Error('must not run')), utilityModelId: () => 'u', mainModelId: () => 'm' })
    check('a reading is the label, an empty line and the text untrimmed', r === `${LABEL}  SUMMARY with spaces \n`, JSON.stringify(r))
    const blank = await ask({ utility: async () => said(' \n\t '), withModel: thrower(new Error('must not run')), utilityModelId: () => 'm', mainModelId: () => 'm' })
    check('a text of white space alone is no text', road(blank) === 'tried the utility model m (the reply carried no text); the session model is the same, so there was no second road', road(blank))
  }
  console.log('steps 2 and 3: the reason of a road, the four cases')
  {
    const withText = await ask({ utility: async () => refused('API Error: helper refused'), withModel: async () => refused('API Error: session refused'), utilityModelId: () => 'u', mainModelId: () => 'm' })
    check('an error reply with a text: that text, on each road', road(withText) === 'tried the utility model u (API Error: helper refused), then the session model m (API Error: session refused)', road(withText))
    const noText = await ask({ utility: async () => refused(''), withModel: async () => refused(''), utilityModelId: () => 'u', mainModelId: () => 'm' })
    check('an error reply with no text: the reply carried no text, and no other word', road(noText) === 'tried the utility model u (the reply carried no text), then the session model m (the reply carried no text)', road(noText))
    const empty = await ask({ utility: async () => said(''), withModel: async () => said(''), utilityModelId: () => 'u', mainModelId: () => 'm' })
    check('a reply that is no error and has no text: the same words', road(empty) === 'tried the utility model u (the reply carried no text), then the session model m (the reply carried no text)', road(empty))
    const thrown = await ask({ utility: thrower(new Error('helper threw')), withModel: thrower('a bare text'), utilityModelId: () => 'u', mainModelId: () => 'm' })
    check('a call that throws: the message of an Error, any other value made a text', road(thrown) === 'tried the utility model u (helper threw), then the session model m (a bare text)', road(thrown))
  }
  console.log('step 3: a cancellation is no reason, and no abort test stands before the first call')
  {
    const aborted = new AbortController()
    aborted.abort()
    let calls = 0
    const outcome = await ask({ utility: async () => { calls++; return said('x') }, withModel: thrower(new Error('y')), utilityModelId: () => 'u', mainModelId: () => 'm' }, aborted.signal).then(() => 'answered', (e: unknown) => (e instanceof AbortError ? 'AbortError' : String(e)))
    check('an aborted signal throws AbortError after the first call returns', outcome === 'AbortError' && calls === 1, `${outcome}, the first road called ${calls} time(s)`)
    const live = new AbortController()
    const mid = await ask({ utility: async () => { live.abort(); throw new Error('cut') }, withModel: async () => said('never'), utilityModelId: () => 'u', mainModelId: () => 'm' }, live.signal).then(() => 'answered', (e: unknown) => (e instanceof AbortError ? 'AbortError' : String(e)))
    check('a throw under an aborted signal is an AbortError, never a reason', mid === 'AbortError', mid)
  }
  console.log('step 4: the two ids are asked inside a pass-over, the session id only after the first road failed')
  {
    let mainAsked = 0
    const first = await ask({ utility: async () => said('SUMMARY'), withModel: thrower(new Error('must not run')), utilityModelId: () => 'u', mainModelId: () => { mainAsked++; return 'm' } })
    check('the first road answers: the session id is never asked', first === `${LABEL}SUMMARY` && mainAsked === 0, `asked ${mainAsked} time(s)`)
    const utilityThrows = await ask({ utility: thrower(new Error('helper refused')), withModel: async () => said('FALLBACK'), utilityModelId: () => { throw new Error('no utility id') }, mainModelId: () => 'm' }).then(v => v, (e: unknown) => `THREW ${String(e)}`)
    check('a throw while asking the utility id does not end the unit', utilityThrows === `${LABEL}FALLBACK`, JSON.stringify(utilityThrows))
    const mainThrows = await ask({ utility: thrower(new Error('helper refused')), withModel: thrower(new Error('must not run')), utilityModelId: () => 'u', mainModelId: () => { throw new Error('no session id') } }).then(v => v, (e: unknown) => `THREW ${String(e)}`)
    check('a throw while asking the session id does not end the unit, and no second road is tried', road(mainThrows) === 'tried the utility model u (helper refused); the session model is the same, so there was no second road', road(mainThrows))
  }
  console.log('steps 5 and 6: the second road and the road sentence')
  {
    let second = 0
    const emptyMain = await ask({ utility: thrower(new Error('helper refused')), withModel: async () => { second++; return said('FALLBACK') }, utilityModelId: () => 'u', mainModelId: () => '' })
    check('an empty session id tries no second road', second === 0 && road(emptyMain) === 'tried the utility model u (helper refused); the session model is the same, so there was no second road', `${second} call(s): ${road(emptyMain)}`)
    const unknownOne = await ask({ utility: thrower(new Error('helper refused')), withModel: thrower(new Error('must not run')), utilityModelId: () => '', mainModelId: () => '' })
    check('an empty utility id is written unknown', road(unknownOne) === 'tried the utility model unknown (helper refused); the session model is the same, so there was no second road', road(unknownOne))
    const unknownTwo = await ask({ utility: thrower(new Error('helper refused')), withModel: thrower(new Error('session refused')), utilityModelId: () => '', mainModelId: () => 'm' })
    check('…and in the sentence of two roads', road(unknownTwo) === 'tried the utility model unknown (helper refused), then the session model m (session refused)', road(unknownTwo))
    const handed: Record<string, unknown>[] = []
    await ask({ utility: thrower(new Error('helper refused')), withModel: async (question: Record<string, unknown>) => { handed.push(question); return said('FALLBACK') }, utilityModelId: () => 'u', mainModelId: () => 'claude-opus-5' })
    const options = (handed[0]?.options ?? {}) as Record<string, unknown>
    check('the second road is handed the named call: its thinking beside the options, its other members over the base options', handed.length === 1 && handed[0]?.thinkingConfig !== undefined && options.model === 'claude-opus-5' && options.effortPinned === true && options.querySource === 'web_fetch_apply' && options.isNonInteractiveSession === true && options.hasAppendSystemPrompt === false && !('thinkingConfig' in options), JSON.stringify(handed[0]))
  }
} finally {
  if (createdHome !== null) rmSync(createdHome, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nPASS prove-webfetch-summariser-six-places' : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
