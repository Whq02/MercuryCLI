// prove-thinking-disclosure — finalized thinking rows are visible + honestly
// expandable in place, and every thinking surface speaks ONE grammar.
//
// The bug class (three defects stacked):
//   a. Message.tsx nulled finalized thinking rows whenever !isTranscriptMode &&
//      !verbose — the reasoning was silently unreachable in the default view
//      (no cue, no row), and AssistantThinkingMessage's collapsed branch was
//      DEAD CODE.
//   b. Even if it had rendered, Messages.tsx never classified thinking rows
//      clickable, so the ⌄ disclosure cue would have lied (the dead-toggle
//      class from the click-expand pass).
//   c. The settled block painted the SESSION ACCENT (italic, identity-tinted)
//      while the live quiet-stream line of a hidden-reasoning model painted a
//      plain grey word with no glyph, and the redacted stub carried a third
//      glyph — three spellings of one fact, keyed to the model family.
//
// Contract proven here:
//   1. Message.tsx's thinking case no longer returns null pre-dispatch (the
//      collapsed row renders); redacted_thinking keeps its null (nothing to
//      reveal — a cue there would be a dead toggle).
//   2. Messages.tsx classifies first-block thinking rows clickable, gated on
//      !verbose (global verbose already reveals all — no dead toggle) and on
//      non-empty thinking text (empty renders null).
//   3. The per-row expand path is the existing expandedKeys verbose merge.
//   4. The settled row paints the thinking grammar's colour and never the
//      session accent: no accent subscription, no accent read (a subscription
//      nothing reads is dead code).
//   5. ONE thinking grammar: one owner exports glyph / word / label / colour;
//      the settled block, the redacted stub, the live tail line and the
//      spinner segment import it and none spells its own glyph, word or
//      colour; the live line and the settled header are the same element;
//      the rendered row carries the one-cell glyph, the lowercase word and
//      the theme's subtle colour, with the accent absent from its bytes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The colour pin reads the row's escape bytes: force the truecolor level
// BEFORE the renderer's colouriser loads (it reads the env at import).
process.env.FORCE_COLOR = '3';
// chdir to the repo root BEFORE any src import — the renderer's owners resolve
// their homes from the cwd.
const ROOT = join(import.meta.dir, '..', '..');
process.chdir(ROOT);

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};
// Source pins read CODE lines only: a comment may name the accent to say the row
// never paints it.
const code = (src: string): string => src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const message = readFileSync('src/components/Message.tsx', 'utf8');
const messages = readFileSync('src/components/Messages.tsx', 'utf8');
const thinkingCmp = readFileSync('src/components/messages/AssistantThinkingMessage.tsx', 'utf8');

// ── 1. dispatch renders the row (no silent drop) ────────────────────────────
const thinkingCase = message.slice(
  message.indexOf('case "thinking":'),
  message.indexOf('case "server_tool_use":'),
);
check(
  'Message.tsx thinking case exists',
  thinkingCase.length > 0 && thinkingCase.includes('<AssistantThinkingMessage'),
);
// The ONE null-return in the case is the provider-uniform ruling: a GPT
// turn's reasoning summaries never paint the in-chat expander outside the
// reveal modes (LiveStreamingTail owns the quiet-stream line). A Claude
// thinking row is never nulled out of the default view.
const thinkingNulls = thinkingCase.match(/return null/g) ?? [];
check(
  'thinking rows are never nulled out of the default view (the only null-return is the OpenAI-route ruling)',
  thinkingNulls.length === 1 &&
    /declaredRouteOf\(servedModel\) === 'openai' &&\s*!isTranscriptMode &&\s*!verbose\s*\) \{[\s\S]{0,400}return null/.test(thinkingCase),
  `null-returns=${thinkingNulls.length} — a bare !isTranscriptMode && !verbose null-return makes Claude reasoning unreachable`,
);
const redactedCase = message.slice(
  message.indexOf('case "redacted_thinking":'),
  message.indexOf('case "thinking":'),
);
check(
  'redacted_thinking keeps its null (no dead disclosure cue)',
  redactedCase.includes('return null'),
);

// ── 2. clickable classification ─────────────────────────────────────────────
const clickableStart = messages.indexOf('const isItemClickable = useCallback');
const clickableBody = messages.slice(clickableStart, messages.indexOf('const canAnimate', clickableStart));
check('isItemClickable found', clickableStart >= 0);
check(
  'first-block thinking rows classified clickable',
  clickableBody.includes("first?.type === 'thinking'"),
);
check(
  'gated on !verbose (no dead toggle under global verbose)',
  /!verbose && typeof first\.thinking === 'string'/.test(clickableBody),
);
check(
  'gated on non-empty thinking text',
  clickableBody.includes('first.thinking.trim().length > 0'),
);
check(
  'isItemClickable deps include verbose (classification tracks the live flag)',
  // The law is VERBOSE-IN-THE-DEPS, not a frozen array literal — the agent
  // fold legitimately added agentFoldHidden alongside it.
  /\}, \[tools, verbose(, [A-Za-z]+)*\]\);/.test(messages.slice(messages.indexOf('const isItemClickable'))),
);

// ── 3. per-row expand path unchanged ────────────────────────────────────────
check(
  'row verbose merges the per-message expandedKeys toggle',
  messages.includes('verbose={verbose || isItemExpanded(msg_8)'),
);
check(
  'expandKey falls back to uuid (per-row identity for thinking)',
  messages.includes('?? msg.uuid'),
);

// ── 4. collapsed cue + the grammar's colour, never the accent ───────────────
check(
  'collapsed branch renders the disclosure cue',
  thinkingCmp.includes('<CtrlOToExpand />'),
);
check(
  'AssistantThinkingMessage holds no accent subscription and no accent read (nothing paints it)',
  !/useSessionAccent|getSessionAccent|useMercuryTokens|\baccent\b/.test(code(thinkingCmp)),
);
check(
  'the expanded body paints the grammar colour (header and body share one role)',
  thinkingCmp.includes('<Markdown color={THINKING_COLOR}>'),
);

// ── 5. ONE thinking grammar ─────────────────────────────────────────────────
const OWNER = 'src/components/messages/thinkingGrammar.tsx';
const grammar = await import('../../src/components/messages/thinkingGrammar.tsx');
const { stringWidth } = await import('../../src/ink/stringWidth.ts');
const { getTheme, THEME_NAMES } = await import('../../src/utils/theme.ts');
const { getSessionAccent } = await import('../../src/components/mercury-ui/sessionAccent.ts');

const GLYPH = '\u2733\uFE0E';
check('owner: the glyph is U+2733 with VS15 (text presentation)', grammar.THINKING_GLYPH === GLYPH);
check('owner: the glyph measures one cell (the selector is zero-width)', stringWidth(grammar.THINKING_GLYPH) === 1, `width=${stringWidth(grammar.THINKING_GLYPH)}`);
check('owner: the word is lowercase', grammar.THINKING_WORD === 'thinking');
check('owner: the label is glyph + space + word + ellipsis', grammar.THINKING_LABEL === `${GLYPH} thinking…`);
check('owner: the colour is the theme role `subtle`', grammar.THINKING_COLOR === 'subtle');
check(
  'owner: every theme family resolves the role (a grey of its own, never the accent)',
  THEME_NAMES.every(name => {
    const theme = getTheme(name);
    return typeof theme.subtle === 'string' && theme.subtle !== '' && theme.subtle !== getSessionAccent().accent;
  }),
);
check('owner: exports the row element', typeof grammar.ThinkingLabel === 'function');
const ownerSrc = readFileSync(OWNER, 'utf8');
check(
  'owner: the selector is spelled as an escape (never a droppable invisible literal)',
  ownerSrc.includes("'\u2733\\uFE0E'") && !ownerSrc.includes('\uFE0E'),
);

// Every renderer imports the owner and spells nothing of its own.
const RENDERERS: Record<string, string> = {
  settled: 'src/components/messages/AssistantThinkingMessage.tsx',
  redacted: 'src/components/messages/AssistantRedactedThinkingMessage.tsx',
  live: 'src/components/LiveStreamingTail.tsx',
  spinner: 'src/components/Spinner/SpinnerAnimationRow.tsx',
};
const sources = Object.fromEntries(Object.entries(RENDERERS).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
for (const [name, src] of Object.entries(sources)) {
  check(`${name}: imports the thinking grammar owner`, src.includes("/thinkingGrammar.js'"));
  check(`${name}: spells no glyph of its own`, !src.includes('\u2733') && !src.includes('TEARDROP_ASTERISK'));
  check(`${name}: spells no label of its own`, !/[Tt]hinking…/.test(src));
}
check('settled + redacted: no accent anywhere (the row is not identity)', !/accent/i.test(code(sources.settled!)) && !/accent/i.test(code(sources.redacted!)));
check('settled: the collapsed branch and the expanded header draw the one element', (sources.settled!.match(/<ThinkingLabel/g) ?? []).length === 2);
check('redacted: the stub draws the one element, with nothing to expand', sources.redacted!.includes('<ThinkingLabel />') && !sources.redacted!.includes('CtrlOToExpand'));
check('live: the quiet-stream line draws the one element (no bare word, no dim override)', sources.live!.includes('<ThinkingLabel />') && !/<Text[^>]*>\s*thinking\s*<\/Text>/.test(sources.live!));
check('spinner: the HUD word is the grammar word (full label and bare fallback)', sources.spinner!.includes('`${THINKING_WORD}${effortSuffix') && sources.spinner!.includes('text: THINKING_WORD') && !/text: 'thinking'/.test(sources.spinner!) && !/`thinking\$\{/.test(sources.spinner!));
check('spinner: the segment paints the grammar colour at rest (the dim override that beat it is gone)', sources.spinner!.includes('return THINKING_COLOR') && !sources.spinner!.includes('dimColor={!shimmerActive}'));

// The glyph literal lives in exactly one file under src (comments included).
const walk = (dir: string, out: string[]): void => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
};
const files: string[] = [];
walk('src', files);
const spellers = files.filter(f => readFileSync(f, 'utf8').includes('\u2733')).map(f => f.split('\\').join('/'));
check('the glyph literal is spelled in the owner and nowhere else under src', spellers.length === 1 && spellers[0] === OWNER, spellers.join(', ') || '(none)');

// The rendered row: real components through the static renderer.
const React = (await import('react')).default;
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx');
const { AssistantThinkingMessage } = await import('../../src/components/messages/AssistantThinkingMessage.tsx');
const { AssistantRedactedThinkingMessage } = await import('../../src/components/messages/AssistantRedactedThinkingMessage.tsx');
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const rgbOf = (value: string): string | null => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16)).join(';');
  const rgb = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  return rgb ? `${rgb[1]};${rgb[2]};${rgb[3]}` : null;
};
// The static render resolves the default (dark) family; its subtle is a
// truecolor value the forced level emits verbatim.
const subtle = rgbOf(getTheme('dark').subtle);
const accent = rgbOf(getSessionAccent().accent);
check('fixture: the dark family\'s subtle and the accent are truecolor values', subtle !== null && accent !== null, `${subtle} / ${accent}`);

const collapsedAnsi = await renderToAnsiString(
  React.createElement(AssistantThinkingMessage, { param: { type: 'thinking', thinking: 'the reasoning body' } }),
  60,
);
const collapsed = stripAnsi(collapsedAnsi);
check('rendered collapsed row: the label paints', collapsed.includes(grammar.THINKING_LABEL), JSON.stringify(collapsed.trim()));
check('rendered collapsed row: the fold cue rides the same row', /thinking…\s+\(.*to expand\)|thinking…\s+⌄/.test(collapsed), JSON.stringify(collapsed.trim()));
check('rendered collapsed row: the body stays folded', !collapsed.includes('the reasoning body'));
check('rendered collapsed row: painted in the subtle colour', collapsedAnsi.includes(`38;2;${subtle}`), JSON.stringify(collapsedAnsi.slice(0, 120)));
check('rendered collapsed row: the accent is absent from its bytes', !collapsedAnsi.includes(`38;2;${accent}`));
check('rendered collapsed row: italic', collapsedAnsi.includes('\x1b[3m'));

const expandedAnsi = await renderToAnsiString(
  React.createElement(AssistantThinkingMessage, { param: { type: 'thinking', thinking: 'the reasoning body' }, verbose: true }),
  60,
);
const expanded = stripAnsi(expandedAnsi);
check('rendered expanded block: the same header, then the body', expanded.includes(grammar.THINKING_LABEL) && expanded.includes('the reasoning body'));
check('rendered expanded block: no fold cue when the body is open', !/to expand|⌄/.test(expanded));
check('rendered expanded block: the accent is absent from its bytes', !expandedAnsi.includes(`38;2;${accent}`));

const redactedAnsi = await renderToAnsiString(React.createElement(AssistantRedactedThinkingMessage, { addMargin: false }), 60);
const redacted = stripAnsi(redactedAnsi);
check('rendered redacted stub: the same label, nothing to expand', redacted.trim() === grammar.THINKING_LABEL, JSON.stringify(redacted.trim()));
check('rendered redacted stub: painted in the subtle colour, never the accent', redactedAnsi.includes(`38;2;${subtle}`) && !redactedAnsi.includes(`38;2;${accent}`));

process.exit(fail);
