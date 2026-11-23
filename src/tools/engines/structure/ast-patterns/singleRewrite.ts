import { type parsePolyglot, type PolyglotLanguage, type TSNode } from '../../../../platform/grammars/grammarFacility.js'
import type { encodePattern } from '../pattern.js'
import { compileFor } from '../polyglotQuery.js'
import type { CompileCache } from './search.js'
import { sameShape } from './rewriteParts.js'

export async function spansTerminator(engine: Parameters<typeof parsePolyglot>[0], terminatorByLang: Map<string, boolean>, encodedPattern: ReturnType<typeof encodePattern>, patternCache: CompileCache, lang: PolyglotLanguage): Promise<boolean> {
  const cached = terminatorByLang.get(lang.name)
  if (cached !== undefined) return cached
  const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedPattern, patternCache)
  const spans = !('state' in pat) && pat.pattern.spansTerminator === true
  terminatorByLang.set(lang.name, spans)
  return spans
}

export async function shapeFor(engine: Parameters<typeof parsePolyglot>[0], shapeByLang: Map<string, { pat: TSNode; rw: TSNode; standIn?: RegExp } | null>, singleRewrite: string, encodedPattern: ReturnType<typeof encodePattern>, encodedRewrite: ReturnType<typeof encodePattern>, patternCache: CompileCache, rewriteCache: CompileCache, lang: PolyglotLanguage): Promise<{ pat: TSNode; rw: TSNode; standIn?: RegExp } | null> {
  const cached = shapeByLang.get(lang.name)
  if (cached !== undefined) return cached
  let shape: { pat: TSNode; rw: TSNode; standIn?: RegExp } | null = null
  if (singleRewrite.trim() !== '') {
    const pat = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedPattern, patternCache)
    const rw = await compileFor(engine as Parameters<typeof compileFor>[0], lang, encodedRewrite, rewriteCache)
    if (!('state' in pat) && !('state' in rw) && !pat.pattern.tagMetavars && !rw.pattern.tagMetavars && sameShape(pat.pattern.root, rw.pattern.root, pat.pattern.standIn, rw.pattern.standIn)) {
      shape = { pat: pat.pattern.root, rw: rw.pattern.root, ...(pat.pattern.standIn && { standIn: pat.pattern.standIn }) }
    }
  }
  shapeByLang.set(lang.name, shape)
  return shape
}

export function releaseCompiled(patternCache: CompileCache, rewriteCache: CompileCache): void {
  for (const cache of [patternCache, rewriteCache]) {
    for (const entry of cache.values()) {
      if (!('state' in entry)) entry.hold.delete()
    }
  }
}
