
export const MAX_PAUSE_DIRECTIVE_CHARS = 160

const PAUSE_VERBS = new Set(['pause', 'stop', 'hold'])

const PRE_VERB_BLOCKERS = new Set([
  "don't", 'dont', 'not', 'never', 'no', "won't", 'wont', "shouldn't",
  'shouldnt', "can't", 'cant', 'cannot', 'without', 'the', 'a', 'an', 'my',
  'our', 'this', 'that', 'implement', 'add', 'build', 'support', 'make',
  'fix', 'test', 'handle',
])

const OBJECT_ARTICLES = new Set(['the', 'this', 'that', 'all'])

const WORK_OBJECTS = new Set([
  'workflow', 'workflows', 'run', 'runs', 'work', 'working', 'agent',
  'agents', 'fanout', 'fan-out', 'task', 'tasks', 'everything', 'it', 'this',
  'that', 'here', 'now', 'there', 'on', 'off', 'up', 'rq', 'please', 'for',
  'sec', 'second', 'bit', 'moment', 'minute', 'min', 'real', 'quick', 'a',
])

export type OperatorPauseVerdict =
  | { kind: 'pause'; directive: string }
  | { kind: 'none' }

export function parseOperatorPauseDirective(text: string): OperatorPauseVerdict {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw || raw.length > MAX_PAUSE_DIRECTIVE_CHARS) return { kind: 'none' }
  const tokens = raw
    .toLowerCase()
    .replace(/[.,!?…;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!PAUSE_VERBS.has(tok)) continue
    const prev = tokens[i - 1]
    if (prev !== undefined && PRE_VERB_BLOCKERS.has(prev)) continue
    let j = i + 1
    while (j < tokens.length && OBJECT_ARTICLES.has(tokens[j]!)) j++
    const object = tokens[j]
    if (object === undefined || WORK_OBJECTS.has(object)) {
      return { kind: 'pause', directive: raw.slice(0, 120) }
    }
  }
  return { kind: 'none' }
}
