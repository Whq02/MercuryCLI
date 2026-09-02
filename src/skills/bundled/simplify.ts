// ============================================================================
//  src/skills/bundled/simplify.ts — /simplify: three concurrent reviewers
//  over the working diff, then fix what they found.
// ============================================================================
import { registerBundledSkill } from '../bundledSkills.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'

const PROMPT = `This is a quality pass, not a bug hunt: make the changed code earn its size. Find what it could reuse, shed, or do cheaper — then apply those fixes.

Step 1 — collect the subject. The working diff is the material: unstaged plus staged changes together. When version control shows no changes, the subject is the files the user named, or failing that whatever this conversation has already changed.

Step 2 — dispatch three reviewers at once: one ${AGENT_TOOL_NAME} tool-use block each, all three in a single message — separate messages would run them one after another. Every reviewer receives the full diff and owns one question.

1. The REUSE question: what here already exists? Sweep the repository — utility and helper directories, modules neighbouring the changed files, the platform's own standard library — for prior art the diff re-invents. A finding names the existing symbol and the new code that should call it. Watch for the classics: string and path work done by hand, environment probing rebuilt inline, ad-hoc type guards beside an established one.

2. The SHAPE question: what would a maintainer resent? State that is stored but derivable; values that travel in herds through every signature; near-duplicate blocks written by copy-and-vary; an abstraction whose callers reach around it; strings doing an enum's job; nesting that flattens once inverted; comments that restate the code beneath them.

3. The COST question: what does this spend that it does not need? Work redone per call, per render, or per poll that one pass could establish; awaits in sequence with no data dependency between them; existence checks before operations that already report their own failure cleanly; structures that grow without a bound — caches, listeners, accumulating arrays; reads that fetch far more than the code consumes.

Step 3 — merge the three reports. Apply every real finding directly; let the false positives die in silence rather than in argument. Close with a short account of what changed, or the honest sentence that the diff was already clean.`

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description:
      'Use when the user asks to clean up, simplify, or tighten changed code: a quality-only pass over the working diff for reuse, shape, and cost improvements, applied directly. It does not hunt for bugs — adversarial checking is /verify.',
    getPromptForCommand: async args => {
      const text = args.trim() ? `${PROMPT}\n\nAdditional focus:\n${args.trim()}` : PROMPT
      return [{ type: 'text', text }]
    },
  })
}
