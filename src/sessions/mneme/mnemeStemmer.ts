export function stemLookupToken(token: string): string {
  if (token.length < 4 || /[^a-z]/.test(token)) return token
  let stem = token
  if (stem.endsWith('sses')) stem = stem.slice(0, -2)
  else if (/(ies|ied)$/.test(stem)) stem = stem.slice(0, -3) + (stem.length > 4 ? 'y' : 'ie')
  else if (stem.endsWith('s') && !/(ss|us|is)$/.test(stem)) stem = stem.slice(0, -1)
  if (stem.endsWith('eed')) {
    if (stem.length > 4) stem = stem.slice(0, -1)
  } else {
    const ending = /(ing|ed)$/.exec(stem)
    if (ending) {
      const root = stem.slice(0, -ending[0].length)
      if (/[aeiouy]/.test(root)) {
        stem = root
        if (/(at|bl|iz)$/.test(stem)) stem += 'e'
        else if (/([^aeioulsz])\1$/.test(stem)) stem = stem.slice(0, -1)
        else if (/^[^aeiou][aeiou][^aeiouwxy]$/.test(stem)) stem += 'e'
      }
    }
  }
  for (const suffix of ['ment', 'ness', 'ful', 'ly']) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= 3) {
      stem = stem.slice(0, -suffix.length)
      if (stem.endsWith('i')) stem = stem.slice(0, -1) + 'y'
      break
    }
  }
  return stem
}
