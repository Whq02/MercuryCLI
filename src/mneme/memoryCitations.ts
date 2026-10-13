export function synthesisCitations(answer: string): string[] {
  return [...new Set([...answer.matchAll(/\[(seq \d+|pending \d+)\]/g)].map(match => match[1]!))]
}

export function pointerCitations(answer: string): Set<string> {
  const ids = new Set(synthesisCitations(answer).filter(id => id.startsWith('seq ')).map(id => id.replace(' ', ':')))
  for (const match of answer.matchAll(/\b(?:seq:\d+|ledger:\d+|doc:(?:archive\/)?[a-z0-9-]+|pending:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)(?![\w:/-])/g)) ids.add(match[0])
  return ids
}
