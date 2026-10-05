import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

const PER_SECTION_TOKEN_LIMIT = 2000

const DEFAULT_SESSION_MEMORY_TEMPLATE = `
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
