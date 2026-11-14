import type { ReadQueryRequest, ReadQueryResult } from './readQuery.js'

export async function readJson({ target }: ReadQueryRequest): Promise<ReadQueryResult> {
  const content = [
    `(target: JSON query · source: ${target.source} · state: unavailable)`,
    "A query's result, not the file's bytes: it gives no edit anchor and does not count as reading the file.",
    'The JSON query engine is unavailable.',
  ].join('\n')
  return { content, numLines: 3 }
}
