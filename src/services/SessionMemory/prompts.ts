import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logError } from '../../utils/log.js'

const PER_SECTION_TOKEN_LIMIT = 2000

const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_Distinctive 5-10 word one-line title, no filler._

# Current State
_Active work, pending tasks, immediate next steps._

# Task specification
_Original request, design decisions and rationale._

# Files and Functions
_Relevant files, what each holds and why it matters._

# Workflow
_Habitual shell commands, order, and non-obvious output notes._

# Errors & Corrections
_Errors, fixes, user corrections, and failed approaches not to retry._

# Codebase and System Documentation
_Components and how they fit together._

# Learnings
_What worked and failed, without repeating other sections._

# Key results
_Exact user-requested artefacts._

# Worklog
_Terse step-by-step record of attempts and results._
`


function overridePath(fileName: string): string {
  return join(getMercuryHome(), 'session-memory', 'config', fileName)
}

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

async function loadSessionMemoryTemplate(): Promise<string> {
  return loadOverrideOr('template.md', DEFAULT_SESSION_MEMORY_TEMPLATE)
}


export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = await loadSessionMemoryTemplate()
  return content.trim() === template.trim()
}

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
