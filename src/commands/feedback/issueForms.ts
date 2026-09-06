
export type IssueKind = 'bug' | 'provider' | 'feature'

export type IssueFieldSource =
  | 'auto'
  | 'words'
  | 'ask'
  | 'doctor'

export interface IssueField {
  id: string
  label: string
  source: IssueFieldSource
  prompt?: string
}

export interface IssueForm {
  kind: IssueKind
  template: string
  name: string
  description: string
  titlePrefix: string
  fields: readonly IssueField[]
}

export const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'provider', 'feature']

export const NOT_STATED = '(not stated)'

const VERSION_FIELD: IssueField = { id: 'version', label: 'Version', source: 'auto' }
const PLATFORM_FIELD: IssueField = { id: 'platform', label: 'OS and terminal', source: 'auto' }
const DOCTOR_FIELD: IssueField = { id: 'doctor', label: 'doctor --json', source: 'doctor' }

export const ISSUE_FORMS: Readonly<Record<IssueKind, IssueForm>> = {
  bug: {
    kind: 'bug',
    template: 'bug_report.yml',
    name: 'Bug report',
    description: 'Something behaves wrongly.',
    titlePrefix: '[bug] ',
    fields: [
      VERSION_FIELD,
      PLATFORM_FIELD,
      { id: 'install', label: 'How Mercury was installed', source: 'auto' },
      {
        id: 'steps',
        label: 'Steps to reproduce',
        source: 'words',
        prompt: 'Exactly what you did, from boot to the failure, one step per line.',
      },
      { id: 'expected', label: 'What you expected', source: 'ask' },
      {
        id: 'actual',
        label: 'What happened instead',
        source: 'ask',
        prompt: 'A pasted transcript of the failing screen helps; paste text rather than an image where you can.',
      },
      DOCTOR_FIELD,
    ],
  },
  provider: {
    kind: 'provider',
    template: 'provider_or_model_report.yml',
    name: 'Provider or model report',
    description: 'A sign-in door, a model row, a refusal or a warning that reads wrong.',
    titlePrefix: '[provider] ',
    fields: [
      { id: 'family', label: 'Provider family', source: 'auto' },
      { id: 'model', label: 'The model row', source: 'auto' },
      {
        id: 'where',
        label: 'Where it happened',
        source: 'ask',
        prompt: 'The first-run walk, /logins or /accounts, /model, a chat turn, a headless -p run, /health or doctor, or somewhere else.',
      },
      {
        id: 'text',
        label: 'The exact refusal or warning text',
        source: 'ask',
        prompt: 'Paste it verbatim; the wording names the door and the cause.',
      },
      VERSION_FIELD,
      PLATFORM_FIELD,
      {
        id: 'steps',
        label: 'Steps to reproduce',
        source: 'words',
        prompt: 'From boot to the refusal or warning, one step per line.',
      },
      DOCTOR_FIELD,
    ],
  },
  feature: {
    kind: 'feature',
    template: 'feature_request.yml',
    name: 'Feature request',
    description: 'Something Mercury should do and does not.',
    titlePrefix: '[feature] ',
    fields: [
      {
        id: 'task',
        label: 'What you are trying to do',
        source: 'words',
        prompt: 'The task in your own words, not the feature; the task is what a design answers.',
      },
      {
        id: 'today',
        label: 'What happens today',
        source: 'ask',
        prompt: 'What Mercury does now when you try, and any workaround you use.',
      },
      {
        id: 'proposal',
        label: 'What you would like',
        source: 'ask',
        prompt: 'The behaviour you want, and where in the product it belongs (a screen, a command, a flag).',
      },
      VERSION_FIELD,
      PLATFORM_FIELD,
      {
        id: 'steps',
        label: 'Steps to reach the gap',
        source: 'ask',
        prompt: 'How you get to the place where the feature is missing, one step per line.',
      },
    ],
  },
}

export function promptedFields(form: IssueForm): IssueField[] {
  const words = form.fields.filter(f => f.source === 'words')
  const asks = form.fields.filter(f => f.source === 'ask')
  return [...words, ...asks]
}


const TITLE_CAP = 200

export function fullIssueTitle(form: IssueForm, drafted: string): string {
  let text = drafted.replace(/\s+/g, ' ').trim()
  while (/^\[[^\]]*\]\s*/.test(text)) text = text.replace(/^\[[^\]]*\]\s*/, '')
  if (text === '') text = `${form.name} from Mercury`
  if (text.length > TITLE_CAP) text = `${text.slice(0, TITLE_CAP - 1).trimEnd()}…`
  return `${form.titlePrefix}${text}`
}


export const SECTION_HEADING = '### '

export const RECENT_ERRORS_MAX = 20
export const RECENT_ERROR_CHARS = 500

export interface IssueBodyInput {
  values: Readonly<Partial<Record<string, string>>>
  recentErrors: readonly { error: string; timestamp: string }[]
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '````' : '```'
  return `${ticks}text\n${text}\n${ticks}`
}

function sectionText(field: IssueField, values: IssueBodyInput['values']): string {
  const raw = (values[field.id] ?? '').replace(/\r\n/g, '\n').trim()
  if (raw === '') return NOT_STATED
  return field.source === 'doctor' ? fence(raw) : raw
}

function recentErrorsBlock(errors: IssueBodyInput['recentErrors']): string {
  if (errors.length === 0) return '(none in this session)'
  const kept = errors.slice(-RECENT_ERRORS_MAX)
  const rows = kept.map(e => {
    const one = e.error.replace(/\s+/g, ' ').trim()
    const cut = one.length > RECENT_ERROR_CHARS ? `${one.slice(0, RECENT_ERROR_CHARS)}…` : one
    return `${e.timestamp}  ${cut}`
  })
  const omitted = errors.length - kept.length
  return fence(rows.join('\n') + (omitted > 0 ? `\n(${omitted} earlier error${omitted === 1 ? '' : 's'} omitted)` : ''))
}

export function composeIssueBody(form: IssueForm, input: IssueBodyInput): string {
  const parts: string[] = []
  for (const field of form.fields) {
    parts.push(`${SECTION_HEADING}${field.label}\n${sectionText(field, input.values)}`)
  }
  parts.push(
    `<details>\n<summary>Recent errors (redacted)</summary>\n\n${recentErrorsBlock(input.recentErrors)}\n\n</details>`,
  )
  parts.push(
    `_Filed from inside Mercury (\`/${form.kind === 'bug' ? 'bug' : 'feedback'}\`). The session transcript stays in the reporter's local draft and was not sent._`,
  )
  return `${parts.join('\n\n')}\n`
}

export function issueSectionLabels(body: string): string[] {
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (line.startsWith(SECTION_HEADING)) out.push(line.slice(SECTION_HEADING.length).trim())
  }
  return out
}


export interface NoGhParagraphInput {
  note: string
  remedy: string
  slug: string
  draftPath: string | null
  bodyPath: string | null
}

export function noGhParagraph(i: NoGhParagraphInput): string {
  const where =
    i.bodyPath !== null && i.draftPath !== null
      ? `The body to paste is at ${i.bodyPath} and the local draft (with the transcript) at ${i.draftPath}.`
      : 'The draft file could not be written (see the error log).'
  return `The issue was not filed: ${i.note} — ${i.remedy}. ${where} File it by hand at https://github.com/${i.slug}/issues.`
}


export const ISSUE_FORM_URL_CAP = 7250

export const URL_CUT_NOTE = ' … (cut to fit the link; the local draft has the rest)'

export function percentSafeCut(encoded: string, budget: number): string {
  if (encoded.length <= budget) return encoded
  let cut = encoded.slice(0, Math.max(0, budget))
  const lastPercent = cut.lastIndexOf('%')
  if (lastPercent > cut.length - 3) cut = cut.slice(0, lastPercent)
  return cut
}

export function doctorPointer(bodyPath: string | null): string {
  return bodyPath !== null
    ? `paste the doctor --json block here from the local draft: ${bodyPath}`
    : 'paste the output of `mercury doctor --json` here'
}

export interface IssueFormUrlInput {
  slug: string
  title: string
  values: Readonly<Partial<Record<string, string>>>
}

export function issueFormUrl(form: IssueForm, input: IssueFormUrlInput): string {
  const base = `https://github.com/${input.slug}/issues/new?template=${encodeURIComponent(form.template)}&title=${encodeURIComponent(input.title)}`
  const entries = form.fields.map(field => ({
    id: field.id,
    words: field.source === 'words',
    encoded: encodeURIComponent((input.values[field.id] ?? '').replace(/\r\n/g, '\n').trim()),
  }))
  const length = (): number => base.length + entries.reduce((n, e) => n + 1 + e.id.length + 1 + e.encoded.length, 0)
  if (length() > ISSUE_FORM_URL_CAP) {
    const note = encodeURIComponent(URL_CUT_NOTE)
    const order = [...entries.filter(e => !e.words).reverse(), ...entries.filter(e => e.words)]
    for (const entry of order) {
      if (length() <= ISSUE_FORM_URL_CAP) break
      const over = length() - ISSUE_FORM_URL_CAP
      const keep = entry.encoded.length - over - note.length
      if (keep > 0) entry.encoded = percentSafeCut(entry.encoded, keep) + note
      else if (entry.encoded !== '') entry.encoded = entry.encoded.length > note.length ? note : ''
    }
  }
  return `${base}${entries.map(e => `&${e.id}=${e.encoded}`).join('')}`
}
