import type { PinIntent } from './memoryPinIntent.js'

export interface MemoryApplicability {
  scope: 'global' | 'project'
  purpose?: 'safety' | 'honesty'
  role?: 'main' | 'child'
  directive: PinIntent
}

export function applicabilityOf(directive: PinIntent | undefined): MemoryApplicability | undefined {
  if (!directive?.messageId || !directive.text) return undefined
  const text = directive.text
  const purpose = /\bglobal safety rule\b/i.test(text) ? 'safety' : /\bglobal honesty rule\b/i.test(text) ? 'honesty' : undefined
  if (purpose) return { scope: 'global', purpose, directive }
  if (/\bonly (?:for )?the (?:main|lead) (?:thread|session|agent)\b/i.test(text)) return { scope: 'project', role: 'main', directive }
  if (/\bonly (?:for )?(?:the )?(?:child|crewmate) (?:threads?|sessions?|agents?)\b/i.test(text)) return { scope: 'project', role: 'child', directive }
  return undefined
}

export function validatedApplicability(value: unknown): MemoryApplicability | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as MemoryApplicability
  if (!row.directive || typeof row.directive.messageId !== 'string' || typeof row.directive.text !== 'string') return undefined
  const derived = applicabilityOf(row.directive)
  return derived?.scope === row.scope && derived?.purpose === row.purpose && derived?.role === row.role ? derived : undefined
}
