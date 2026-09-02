

const NEXT_STEPS_RE = /\bnext steps?\b/i
const LET_ME_KNOW_RE = /\blet me know\b/i

const UNFINISHED_TAIL_PATTERNS: RegExp[] = [
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bi'?m going to\b/i,
  /\bi am going to\b/i,
  /\blet me\b/i,
  /\bnext,?\s+i\b/i,
  NEXT_STEPS_RE,
  /\bi plan to\b/i,
  /\bhere'?s (?:the|my) plan\b/i,
  /\bhere is (?:the|my) plan\b/i,
  /\bshould i\b/i,
  /\bwould you like\b/i,
  /\bwant me to\b/i,
  /\bdo you want (?:me )?to\b/i,
  /\bshall i\b/i,
  LET_ME_KNOW_RE,
]

const SOFT_PROMISE_PATTERNS: RegExp[] = [
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bi'?m going to\b/i,
  /\bi am going to\b/i,
  /\blet me\b/i,
]

const AWAITING_OPERATOR_MARKERS: RegExp[] = [
  /\bblocked (?:on|pending|by|until|awaiting)\b/i,
  /\bpermission (?:from|of) (?:you|the operator)\b/i,
  /\byour (?:decision|call|go-?ahead|approval|sign-?off)\b/i,
  /\b(?:needs?|need) (?:you|your)\b/i,
  /\bup to you\b/i,
  /\bwaiting (?:on|for) (?:you|your)\b.*\b(?:approval|decision|go-?ahead|sign-?off|call|review|input|response|reply|confirmation)\b/i,
  /\bawait(?:ing)? your (?:approval|decision|go-?ahead|sign-?off|call|review|input|response|reply|confirmation)\b/i,
  /\bpending your (?:approval|decision|go-?ahead|sign-?off|call|review|input|response|reply|confirmation)\b/i,
  /\byou (?:decide|approve|confirm|sign off)\b/i,
]

const CAPABILITY_REFUSAL_MARKERS: RegExp[] = [
  /\b(?:can'?t|cannot|can not|am unable to|won'?t be able to|not able to)\s+(?:do|make|generate|create|produce|render|access|run|execute|perform|provide|send|reach|open|complete|build)\b/i,
  /\b(?:impossible|not (?:possible|supported|available))\b/i,
  /\b(?:lack|don'?t have|do not have|missing)\s+(?:the\s+)?(?:capabilit(?:y|ies)|ability|tool(?:s|ing)?|access|permission|credential)/i,
  /\bno (?:tool|capability|way) (?:for|to)\b/i,
  /\bSTATUS:\s*impossible\b/i,
]

const PROMISE_DISARM_MARKERS: RegExp[] = [
  /\b(?:won'?t|will not|can'?t|cannot|can not|shan'?t)\b/i,
  /\bi'?m not going to\b/i,
  /\bi am not going to\b/i,
  /\bi will not\b/i,
  ...AWAITING_OPERATOR_MARKERS,
]

const SAFETY_PAUSE_MARKERS: RegExp[] = [
  /\b(?:delet\w*|drop(?:s|ping|ped)?|destroy\w*|wip(?:e|es|ing|ed)|truncat\w*|overwrit\w*|purg\w*|eras\w*|force[- ]?push\w*)\b/i,
  /\brm\s+-[rf]/i,
  /\breset --hard\b/i,
  /\b(?:irreversible|irreversibly|destructive|permanent(?:ly)?|unrecoverable)\b/i,
  /\bcan(?:no|')?t be undone\b/i,
  /\b(?:data[- ]?loss|los(?:e|ing) data)\b/i,
  /\b(?:production|prod)\b/i,
]

function splitClauses(text: string): string[] {
  return text
    .split(/[.;:\n]+/)
    .map(c => c.trim())
    .filter(Boolean)
}

function hasLiveSoftPromise(probe: string): boolean {
  for (const clause of splitClauses(probe)) {
    const probeClause = clause.replace(COURTESY_LET_ME_KNOW, '')
    if (!SOFT_PROMISE_PATTERNS.some(re => re.test(probeClause))) continue
    if (PROMISE_DISARM_MARKERS.some(re => re.test(probeClause))) continue
    return true
  }
  return false
}

const NON_PROMISE_PATTERNS: RegExp[] = UNFINISHED_TAIL_PATTERNS.filter(
  re => !SOFT_PROMISE_PATTERNS.some(p => p.source === re.source),
)

const COURTESY_LET_ME_KNOW = /\blet me know if\b/i
const NEXT_STEPS_COMPLETION_MARKERS =
  /\b(?:done|complete(?:d)?|finished|fixed|resolved|shipped|landed|verified|green|passing|no (?:further|more|remaining|other))\b/i

function hasNonPromiseStall(probe: string): boolean {
  for (const clause of splitClauses(probe)) {
    for (const re of NON_PROMISE_PATTERNS) {
      if (!re.test(clause)) continue
      if (re === LET_ME_KNOW_RE && COURTESY_LET_ME_KNOW.test(clause)) continue
      if (re === NEXT_STEPS_RE && NEXT_STEPS_COMPLETION_MARKERS.test(clause)) continue
      return true
    }
  }
  return false
}

function probeIsUnfinished(probe: string): boolean {
  return hasNonPromiseStall(probe) || hasLiveSoftPromise(probe)
}

function stripLineMarkers(line: string): string {
  return line.replace(/^[\s>#*\-\d.)+]+/, '').trim()
}

function lastParagraph(text: string): string {
  const paras = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  return paras.length > 0 ? paras[paras.length - 1]! : ''
}

export function isUnfinishedTail(text: string): boolean {
  const tail = lastParagraph(text)
  if (!tail) return false

  if (/\?\s*$/.test(tail)) {
    if (
      SAFETY_PAUSE_MARKERS.some(re => re.test(tail)) ||
      AWAITING_OPERATOR_MARKERS.some(re => re.test(tail)) ||
      CAPABILITY_REFUSAL_MARKERS.some(re => re.test(tail))
    ) {
      return false
    }
    const structuredOption = /—.*,/.test(tail) || /\bor\b.*\?\s*$/i.test(tail)
    if (!structuredOption) return true
  }

  const lines = tail.split('\n').map(stripLineMarkers).filter(Boolean)
  const lastLine = lines.length > 0 ? lines[lines.length - 1]! : tail
  const probe = `${tail}\n${lastLine}`
  return probeIsUnfinished(probe)
}
