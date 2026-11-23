import { join } from 'node:path'

import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { logError } from '../../platform/logs/errorLog.js'


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

const MAX_SECTION_CHARS = 8000
const TRUNCATION_MARKER = '_[section truncated for length]_'

export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = loadOverrideOr('template.md', DEFAULT_SESSION_MEMORY_TEMPLATE)
  return content.trim() === template.trim()
}

export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const lines = content.split('\n')
  const firstHeadingIndex = lines.findIndex(line => /^#\s/.test(line))
  if (firstHeadingIndex === -1) {
    return { truncatedContent: content, wasTruncated: false }
  }

  const out: string[] = lines.slice(0, firstHeadingIndex)
  let wasTruncated = false
  let sectionChars = 0
  let sectionTruncated = false

  for (let i = firstHeadingIndex; i < lines.length; i++) {
    const line = lines[i]!
    if (/^#\s/.test(line)) {
      out.push(line)
      sectionChars = 0
      sectionTruncated = false
      continue
    }
    if (sectionTruncated) continue
    const cost = line.length + 1
    if (sectionChars + cost > MAX_SECTION_CHARS) {
      out.push(TRUNCATION_MARKER)
      sectionTruncated = true
      wasTruncated = true
      continue
    }
    out.push(line)
    sectionChars += cost
  }

  return {
    truncatedContent: out.join('\n'),
    wasTruncated,
  }
}
