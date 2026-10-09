import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { SHELL_TYPES } from '../utils/shell/shellProvider.js'
import {
  HOOK_EVENTS,
  HOOK_TIMEOUT_MAX_S,
  hookEventTable,
  hookKindsOf,
  type HookEvent,
  type HookKind,
} from '../utils/hooks/contract.js'
import { matcherCompiles } from '../utils/hooks/matcherGrammar.js'

const entryShape = {
  run: z.string().min(1).optional().describe('A shell command; the payload arrives on stdin'),
  question: z.string().min(1).optional().describe('A question a model answers; $EVENT is replaced by the payload JSON'),
  crewmate: z.string().min(1).optional().describe('A brief a crewmate with tools checks; $EVENT as above'),
  name: z.string().optional().describe('The words every line about the hook uses, and the status row while it runs'),
  match: z.string().optional().describe("Names (Bash, Read|Edit) or a regular expression, matched against the event's match field"),
  shell: z.enum(SHELL_TYPES).optional().describe('The shell a command runs in; bash unless set'),
  model: z.string().optional().describe('The model a question or crewmate hook runs on'),
  timeout: z.number().positive().max(HOOK_TIMEOUT_MAX_S).optional().describe('Seconds before the hook is ended: 600 for a run, 30 for a question, 60 for a crewmate'),
  background: z.boolean().optional().describe('A run hook that does not hold the moment; its answer arrives at the next turn'),
  wake: z.boolean().optional().describe('A background run hook whose block wakes the model'),
  once: z.boolean().optional().describe('Runs once in a session, then stands down'),
  watch: z.array(z.string().min(1)).optional().describe('file.changed only: the files to watch, relative to the project'),
}

const entryObjectSchema = lazySchema(() => z.strictObject(entryShape))

export type HookEntry = z.infer<ReturnType<typeof entryObjectSchema>>

export function hookKindOf(entry: Pick<HookEntry, 'run' | 'question' | 'crewmate'>): HookKind {
  if (entry.run !== undefined) return 'run'
  if (entry.question !== undefined) return 'question'
  return 'crewmate'
}

export function hookEntryText(entry: HookEntry): string {
  return entry.run ?? entry.question ?? entry.crewmate ?? ''
}

export function hookEntryName(entry: HookEntry): string {
  if (entry.name !== undefined && entry.name !== '') return entry.name
  return hookEntryText(entry).split('\n')[0] ?? ''
}

export function hookEntryFaults(entry: HookEntry): string[] {
  const faults: string[] = []
  const kinds = [entry.run, entry.question, entry.crewmate].filter(field => field !== undefined).length
  if (kinds !== 1) faults.push('a hook names exactly one of run, question or crewmate')
  const command = entry.run !== undefined
  if (!command) {
    if (entry.shell !== undefined) faults.push('shell belongs to a run hook')
    if (entry.background !== undefined) faults.push('background belongs to a run hook')
    if (entry.wake !== undefined) faults.push('wake belongs to a run hook')
  } else if (entry.model !== undefined) {
    faults.push('model belongs to a question or crewmate hook')
  }
  if (!matcherCompiles(entry.match)) faults.push(`match is not a valid regular expression: ${JSON.stringify(entry.match)}`)
  return faults
}

export function hookEntryEventFaults(event: HookEvent, entry: HookEntry): string[] {
  const faults: string[] = []
  const row = hookEventTable[event]
  if (entry.match !== undefined && row.match === undefined) faults.push(`${event} has no match field; remove match`)
  if (entry.watch !== undefined && row.watchable !== true) faults.push(`watch belongs to file.changed, not ${event}`)
  const kind = hookKindOf(entry)
  if (!hookKindsOf(event).includes(kind)) faults.push(`${event} runs ${hookKindsOf(event).join(' and ')} hooks only`)
  if (row.foregroundOnly === true && (entry.background === true || entry.wake === true)) {
    faults.push(`${event} runs in the foreground; remove background and wake`)
  }
  return faults
}

export const HookEntrySchema = lazySchema(() =>
  z.preprocess((value, ctx) => {
    const parsed = entryObjectSchema().safeParse(value)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', message: `${issue.path.join('.') || 'entry'}: ${issue.message}` })
      }
      return value
    }
    for (const fault of hookEntryFaults(parsed.data)) ctx.addIssue({ code: 'custom', message: fault })
    return value
  }, entryObjectSchema()),
)

export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS as [HookEvent, ...HookEvent[]]), z.array(HookEntrySchema())).superRefine((map, ctx) => {
    for (const event of Object.keys(map) as HookEvent[]) {
      const entries = map[event] ?? []
      entries.forEach((entry, index) => {
        for (const fault of hookEntryEventFaults(event, entry)) {
          ctx.addIssue({ code: 'custom', message: fault, path: [event, index] })
        }
      })
    }
  }),
)

export type HooksSettings = Partial<Record<HookEvent, HookEntry[]>>

export type HooksMapReading = { hooks: HooksSettings; faults: string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHooksMap(raw: unknown): HooksMapReading {
  if (raw === undefined || raw === null) return { hooks: {}, faults: [] }
  if (!isPlainObject(raw)) return { hooks: {}, faults: ['hooks must be a map of event name to a list of entries'] }
  const working: Record<string, unknown> = { ...raw }
  const faults: string[] = []
  for (let round = 0; round < 3; round++) {
    const parsed = HooksSchema().safeParse(working)
    if (parsed.success) return { hooks: parsed.data as HooksSettings, faults }
    const dropEntries = new Map<string, Set<number>>()
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
        for (const key of issue.keys) {
          faults.push(`${key}: not a hook event Mercury fires — skipped`)
          delete working[key]
        }
        continue
      }
      const [event, index] = issue.path as [string | undefined, number | undefined]
      if (event === undefined) {
        return { hooks: {}, faults: [...faults, issue.message] }
      }
      if (typeof index === 'number') {
        faults.push(`${event}[${index}]: ${issue.message} — skipped`)
        let set = dropEntries.get(event)
        if (set === undefined) {
          set = new Set()
          dropEntries.set(event, set)
        }
        set.add(index)
        continue
      }
      faults.push(`${event}: ${issue.message} — skipped`)
      delete working[event]
    }
    for (const [event, indexes] of dropEntries) {
      const list = working[event]
      if (Array.isArray(list)) working[event] = list.filter((_, i) => !indexes.has(i))
    }
  }
  return { hooks: {}, faults }
}
