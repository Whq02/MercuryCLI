import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
const root = join(import.meta.dir, '../..')
const forbidden = [
  'The socket address has no target.',
  'a completed, stopped or failed one is resumed from its transcript with your message as its next turn',
  'message and you will be notified when it completes',
  'a SendMessage revives it',
  'or by SendMessage to its id',
  'To continue this agent, use ${SEND_MESSAGE_TOOL_NAME}',
  'back up, address ${SEND_MESSAGE_TOOL_NAME}',
  'a message to that id (SendMessage) resumes it',
  'one-line outcome through ${SEND_MESSAGE_TOOL_NAME}',
]
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(tsx?|txt)$/.test(entry.name) ? [join(dir, entry.name)] : [])
const sources = walk(join(root, 'src')).filter(path => relative(root, path) !== 'src/constants/changelog.ts').map(path => [relative(root, path), readFileSync(path, 'utf8')] as const)
let failures = 0
for (const words of forbidden) {
  const hits = sources.filter(([, text]) => text.includes(words)).map(([path]) => path)
  if (hits.length > 0) failures++
  console.log(`[${hits.length === 0 ? 'PASS' : 'FAIL'}] retired resume-road words absent: ${JSON.stringify(words)}${hits.length ? ` — ${hits.join(', ')}` : ''}`)
}
console.log(`sendmessage-resume-words-gone: ${forbidden.length} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
