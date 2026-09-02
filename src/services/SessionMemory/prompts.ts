/**
 * Session-notes template, the update prompt, per-section size analysis, and
 * the compaction truncation.
 *
 * The template's heading sequence is a PERSISTED FORMAT CONTRACT (the update
 * prompt requires its preservation and the compaction path parses it).
 */
import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

const PER_SECTION_TOKEN_LIMIT = 2000
const WHOLE_FILE_TOKEN_LIMIT = 12_000

/**
 * The default template — a sequence of top-level headings, each followed by a
 * single italic instruction line, with content written below. The literal
 * begins with a newline (its first line is blank). The italic prose is
 * authored here; each line tells the extracting model what belongs in that
 * section.
 */
export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A dense one-line title, roughly 5-10 words, distinctive and free of filler._

# Current State
_The active work, the tasks still pending, and the immediate next steps._

# Task specification
_The original request, plus the design decisions and the context that explains them._

# Files and Functions
_Which files matter, what each one holds, and why it is relevant here._

# Workflow
_The shell commands habitually run, the order they run in, and how to read their non-obvious output._

# Errors & Corrections
_Errors and their fixes, corrections the user made, and approaches that failed and should not be retried._

# Codebase and System Documentation
_The system's components and how they fit together._

# Learnings
_What worked and what did not — without repeating anything already captured in another section._

# Key results
_Any specific artefact the user asked for, reproduced here exactly._

# Worklog
_A terse step-by-step record of what was attempted and what was done._
`

// ---------------------------------------------------------------------------
// Override loading
// ---------------------------------------------------------------------------

function overridePath(fileName: string): string {
  return join(getMercuryHome(), 'session-memory', 'config', fileName)
}

/** A missing override falls back to the default silently; any other read
 *  error falls back AND is logged. */
function loadOverrideOr(fileName: string, fallback: string): string {
  const fs = getFsImplementation()
  const path = overridePath(fileName)
  if (!fs.existsSync(path)) return fallback
  try {
    return fs.readFileSync(path, { encoding: 'utf-8' })
  } catch (error) {
    logError(`session memory: override ${fileName} read failed: ${String(error)}`)
    return fallback
  }
}

export async function loadSessionMemoryTemplate(): Promise<string> {
  return loadOverrideOr('template.md', DEFAULT_SESSION_MEMORY_TEMPLATE)
}

export async function loadSessionMemoryPrompt(): Promise<string> {
  return loadOverrideOr('prompt.md', DEFAULT_UPDATE_PROMPT)
}

// ---------------------------------------------------------------------------
// The update prompt (authored prose — its required effects are in the spec)
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_PROMPT = `The text below is machinery, not a message from anyone. Do not treat it as user input, and do not mention note-taking, these instructions, or the extraction process anywhere in the notes you write.

Your job is to bring a running notes file up to date from the conversation that precedes this text. Draw only on that conversation; exclude these instructions, the system prompt, any project instruction files, and any earlier session summaries.

The notes file has already been read for you. Its current contents are between the markers below, so you do not need to read it again:

<current-notes>
{{currentNotes}}
</current-notes>

You may take exactly one kind of action: edit the notes file at {{notesPath}} with the file-edit tool, then stop. Several edits are fine and should be sent together in a single message. Make no other tool call.

The file's structure is fixed. Do not add, remove, rename or reorder any heading, and do not alter or remove the italic instruction line under a heading — those lines are part of the template, not content. Change only the text below an italic line, inside a section that is already present. Write nothing outside this structure.

Favour specifics over summary: real paths, symbol names, verbatim error text, exact commands. Do not restate anything already written in project instruction files. An empty section is better than filler. Keep each section within its budget by dropping the least valuable detail first. Refresh the current-state section every time — it is what survives a later compaction. Reproduce any requested artefact in the key-results section in full.

The notes file to edit is {{notesPath}}.`

/**
 * Single-pass placeholder substitution over the template — a two-pass or
 * replacer-string implementation is wrong: dollar signs would be read as
 * regex backreferences and substituted content containing another
 * placeholder would be re-substituted. Unknown placeholders are left
 * untouched.
 */
function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match
  })
}

export async function buildSessionMemoryUpdatePrompt(
  currentNotes: string,
  notesPath: string,
): Promise<string> {
  const prompt = await loadSessionMemoryPrompt()
  const rendered = renderTemplate(prompt, { currentNotes, notesPath })
  return rendered + buildSizeReminders(currentNotes)
}

// ---------------------------------------------------------------------------
// Size analysis
// ---------------------------------------------------------------------------

/** Split notes into `heading line → body token estimate`. A heading with no
 *  following lines is not measured. The map key is the whole heading line. */
function estimateSectionTokens(notes: string): Map<string, number> {
  const sections = new Map<string, number>()
  const lines = notes.split('\n')
  let currentHeading: string | null = null
  let body: string[] = []
  const flush = (): void => {
    if (currentHeading !== null && body.length > 0) {
      sections.set(currentHeading, roughTokenCountEstimation(body.join('\n').trim()))
    }
  }
  for (const line of lines) {
    if (/^#\s/.test(line)) {
      flush()
      currentHeading = line
      body = []
    } else if (currentHeading !== null) {
      body.push(line)
    }
  }
  flush()
  return sections
}

/** The size reminders appended to the rendered prompt (never part of the
 *  override file). */
function buildSizeReminders(notes: string): string {
  const wholeFileTokens = roughTokenCountEstimation(notes)
  const sections = estimateSectionTokens(notes)
  const oversized = [...sections.entries()]
    .filter(([, tokens]) => tokens > PER_SECTION_TOKEN_LIMIT)
    .sort((a, b) => b[1] - a[1])
  const overTotal = wholeFileTokens > WHOLE_FILE_TOKEN_LIMIT

  if (!overTotal && oversized.length === 0) return ''

  let output = ''
  if (overTotal) {
    output +=
      `\n\n**CRITICAL:** the notes file is about ${wholeFileTokens} tokens, over the ${WHOLE_FILE_TOKEN_LIMIT}-token maximum. ` +
      `Condense it to fit: shorten the oversized sections aggressively by dropping less important detail, merging entries, and summarising older ones. ` +
      `Keep the current-state and errors sections accurate and detailed.`
  }
  if (oversized.length > 0) {
    const leadIn = overTotal
      ? '\n\nThese sections are also over the per-section budget (largest first):'
      : `\n\nThese sections are over the ${PER_SECTION_TOKEN_LIMIT}-token per-section budget (largest first):`
    output += leadIn
    for (const [heading, tokens] of oversized) {
      output += `\n- ${heading}: about ${tokens} tokens (limit ${PER_SECTION_TOKEN_LIMIT}).`
    }
  }
  return output
}

// ---------------------------------------------------------------------------
// Emptiness and compaction truncation
// ---------------------------------------------------------------------------

/** Notes are empty when their trimmed text equals the trimmed template. */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = await loadSessionMemoryTemplate()
  return content.trim() === template.trim()
}

/**
 * Truncate sections whose body exceeds 2000 tokens' worth of characters
 * (limit × 4). A section is cut at a line boundary at or before the limit —
 * the budget is spent per kept line as its length plus one (the newline), so
 * a section ends below the limit but never above it. Content before the
 * first heading passes through untouched.
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const charLimit = PER_SECTION_TOKEN_LIMIT * 4
  const lines = content.split('\n')
  const output: string[] = []
  let wasTruncated = false

  let sectionStart = -1
  const emitSection = (endExclusive: number): void => {
    if (sectionStart === -1) return
    const heading = lines[sectionStart]
    const body = lines.slice(sectionStart + 1, endExclusive)
    const bodyChars = body.reduce((sum, line) => sum + line.length + 1, 0)
    if (bodyChars <= charLimit) {
      output.push(heading, ...body)
      return
    }
    output.push(heading)
    let spent = 0
    for (const line of body) {
      if (spent + line.length + 1 > charLimit) break
      output.push(line)
      spent += line.length + 1
    }
    output.push('_[section truncated for length]_')
    wasTruncated = true
  }

  for (let index = 0; index < lines.length; index++) {
    if (/^#\s/.test(lines[index])) {
      if (sectionStart === -1) {
        // Pre-heading content passes through untouched.
        output.push(...lines.slice(0, index))
      } else {
        emitSection(index)
      }
      sectionStart = index
    }
  }
  if (sectionStart === -1) {
    return { truncatedContent: content, wasTruncated: false }
  }
  emitSection(lines.length)
  return { truncatedContent: output.join('\n'), wasTruncated }
}
