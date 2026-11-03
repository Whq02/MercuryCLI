export interface GoldenTask {
  id: string
  name: string
  prompt: string
  sentenceUnderTest: string
  completion: string
}

export const GOLDEN_TASKS: readonly GoldenTask[] = [
  {
    id: 'T1',
    name: 'hang',
    prompt: 'run ./slow.sh and then report the line count of src/a.ts',
    sentenceUnderTest: 'So to bound a command that may hang, pass a short `timeout`, then TaskStop it; no watchdog script is needed.',
    completion: 'The src/a.ts line count is reported, the outcome completes within 150 seconds, and no watchdog file or loop is used.',
  },
  {
    id: 'T2',
    name: 'unread edit',
    prompt: "change the greeting string in src/b.ts to 'hello there'",
    sentenceUnderTest: "Read coverage follows current content: stale or unread edits refuse without writing and name the recovery.",
    completion: "src/b.ts contains greeting 'hello there' and every other fixture file is byte-identical.",
  },
  {
    id: 'T3',
    name: 'two-file change',
    prompt: 'rename the constant LIMIT to MAX_ITEMS everywhere',
    sentenceUnderTest: 'Use this over Edit when the same change spans several files.',
    completion: 'src/a.ts and src/c.ts use MAX_ITEMS, bun test.ts passes, and no other fixture content changes.',
  },
  {
    id: 'T4',
    name: 'call sites',
    prompt: 'how many places call parseRow()? list the files',
    sentenceUnderTest: 'For code by its shape, AstSearch (load it with ToolSearch) matches the parse tree rather than the text.',
    completion: 'The answer says two calls and names src/b.ts and src/c.ts.',
  },
  {
    id: 'T5',
    name: 'PDF page',
    prompt: 'what is the heading on page 2 of docs/spec.pdf?',
    sentenceUnderTest: 'PDFs return numbered text; pages selects pictures on image-capable models, text otherwise, with OCR for scans.',
    completion: 'The answer contains the exact heading Parser Contract.',
  },
  {
    id: 'T6',
    name: 'public page',
    prompt: 'what is the title of https://example.com?',
    sentenceUnderTest: 'For public web requests, use WebFetch first.',
    completion: 'The answer contains Example Domain; curl or wget through Bash is a wrong-tool call.',
  },
  {
    id: 'T7',
    name: 'deferred tool',
    prompt: 'how many tokens of context are left?',
    sentenceUnderTest: 'Load the full schemas of deferred tools so they become callable.',
    completion: 'ToolSearch loads ContextLeft before ContextLeft is called, and the answer reports a token count.',
  },
  {
    id: 'T8',
    name: 'README control',
    prompt: 'fix the typo in src/util.ts',
    sentenceUnderTest: 'Documentation files (*.md, READMEs) appear only on an explicit request — never proactively.',
    completion: 'retreiveFirstCell becomes retrieveFirstCell in src/util.ts, no Markdown file is added, and README.md is unchanged.',
  },
  {
    id: 'T9',
    name: 'large output',
    prompt: 'run ./noisy.sh and tell me the last line it printed',
    sentenceUnderTest: 'A longer output is saved to a file, and you get its size, its path and about 2000 characters from its start and end.',
    completion: 'The answer contains the exact final line noise line 60000.',
  },
  {
    id: 'T10',
    name: 'no-match grep',
    prompt: 'count the FIXME comments under src/',
    sentenceUnderTest: 'Except exit 1 when the last command is grep, rg, find, diff, cmp, pgrep, test, `[`, which or `command -v`: that is a result with a label such as `no matches found (exit code 1)`.',
    completion: 'The answer is zero and does not report the no-match exit as an error.',
  },
] as const
