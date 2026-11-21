import { FIXTURE_MODEL, withFixtureRunner } from '../lib/builtProduct.ts'
import { answerOf, isCompleted, isOutcome } from '../lib/rows.ts'

type RequestBody = { messages?: Array<{ content?: unknown }> }

function requestTexts(body: RequestBody): string[] {
  const texts: string[] = []
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
  }
  return texts
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

await withFixtureRunner(
  [{ kind: 'text', text: 'PR 12 review complete.' }],
  async (runner, api) => {
    await runner.prompt('/review 12')
    const outcome = await runner.waitFor('review 12 outcome', isOutcome, 30_000)
    const texts = api.messageRequests().flatMap(request => requestTexts(request.body as RequestBody))
    const expanded = texts.find(text => text.includes('Act as an expert code reviewer.')) ?? ''
    check('/review 12 expands into the code reviewer prompt', expanded.includes('Act as an expert code reviewer.'), expanded.slice(0, 120))
    check('/review 12 hands PR number 12 to the model', expanded.includes('Fetch pull request 12 — its details and its diff — and review it.'), expanded.slice(0, 200))
    check('/review 12 omits the bare no-PR fallback', !expanded.includes('No PR number was given'))
    check(
      '/review 12 carries the review rubric',
      expanded.includes('an overview of what the change does') &&
        expanded.includes('code quality and style') &&
        expanded.includes('specific suggestions for improvement') &&
        expanded.includes('potential issues or risks'),
    )
    check('/review 12 completes with the model answer', isCompleted(outcome) && answerOf(outcome).includes('PR 12 review complete.'), JSON.stringify(outcome).slice(0, 200))
  },
  { model: FIXTURE_MODEL },
)

await withFixtureRunner(
  [{ kind: 'text', text: 'Open pull requests listed.' }],
  async (runner, api) => {
    await runner.prompt('/review')
    const outcome = await runner.waitFor('bare review outcome', isOutcome, 30_000)
    const texts = api.messageRequests().flatMap(request => requestTexts(request.body as RequestBody))
    const expanded = texts.find(text => text.includes('Act as an expert code reviewer.')) ?? ''
    check('bare /review expands into the code reviewer prompt', expanded.includes('Act as an expert code reviewer.'), expanded.slice(0, 120))
    check('bare /review asks to list open pull requests', expanded.includes('No PR number was given: list the open pull requests so one can be picked.'), expanded.slice(0, 200))
    check('bare /review omits the specific-PR fetch line', !expanded.includes('Fetch pull request '))
    check('bare /review completes with the model answer', isCompleted(outcome) && answerOf(outcome).includes('Open pull requests listed.'), JSON.stringify(outcome).slice(0, 200))
  },
  { model: FIXTURE_MODEL },
)

console.log(failures === 0 ? 'REVIEW COMMAND GREEN' : `REVIEW COMMAND RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
