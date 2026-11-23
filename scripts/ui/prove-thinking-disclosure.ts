import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FORCE_COLOR = '3';
const HOME = mkdtempSync(join(tmpdir(), 'thinking-grammar-home-'));
process.env.MERCURY_CONFIG_DIR = HOME;
process.env.MERCURY_CREDENTIAL_STORE = 'file';
const ROOT = join(import.meta.dir, '..', '..');
process.chdir(ROOT);
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts');
enableConfigs();

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};


const grammar = await import('../../src/screen/messages/thinkingGrammar.tsx');
const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts');
const { getTheme, THEME_NAMES } = await import('../../src/screen/theme/theme.ts');
const { getSessionAccent } = await import('../../src/screen/widgets/sessionAccent.ts');

const GLYPH = '\u273B';
check('owner: the glyph is U+273B (no Emoji property — never a pictograph)', grammar.THINKING_GLYPH === GLYPH, 'set THINKING_GLYPH to U+273B in src/screen/messages/thinkingGrammar.tsx');
check('owner: the glyph measures one cell', stringWidth(grammar.THINKING_GLYPH) === 1, `width=${stringWidth(grammar.THINKING_GLYPH)}; THINKING_GLYPH in src/screen/messages/thinkingGrammar.tsx must be one cell wide`);
check('owner: the word is lowercase', grammar.THINKING_WORD === 'thinking', 'set THINKING_WORD to thinking in src/screen/messages/thinkingGrammar.tsx');
check('owner: the label is glyph + space + word + ellipsis', grammar.THINKING_LABEL === `${GLYPH} thinking…`, 'THINKING_LABEL in src/screen/messages/thinkingGrammar.tsx must be glyph, space, word, ellipsis');
check('owner: the colour is the theme role `subtle`', grammar.THINKING_COLOR === 'subtle', 'set THINKING_COLOR to subtle in src/screen/messages/thinkingGrammar.tsx');
check(
  'owner: every theme family resolves the role (a grey of its own, never the accent)',
  THEME_NAMES.every(name => {
    const theme = getTheme(name);
    return typeof theme.subtle === 'string' && theme.subtle !== '' && theme.subtle !== getSessionAccent().accent;
  }),
  'every family in src/screen/theme/theme.ts needs a subtle role of its own that differs from the session accent',
);
check('owner: exports the row element', typeof grammar.ThinkingLabel === 'function', 'src/screen/messages/thinkingGrammar.tsx must export the ThinkingLabel component');

const React = (await import('react')).default;
const { renderToAnsiString } = await import('../../src/screen/renderer/staticRender.tsx');
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx');
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts');
const mounted = (node: unknown): ReturnType<typeof React.createElement> =>
  React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() } as never, node as never);
const { AssistantThinkingMessage } = await import('../../src/screen/messages/AssistantThinkingMessage.tsx');
const { AssistantRedactedThinkingMessage } = await import('../../src/screen/messages/AssistantRedactedThinkingMessage.tsx');
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const rgbOf = (value: string): string | null => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16)).join(';');
  const rgb = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  return rgb ? `${rgb[1]};${rgb[2]};${rgb[3]}` : null;
};
const subtle = rgbOf(getTheme('dark').subtle);
const accent = rgbOf(getSessionAccent().accent);
check('fixture: the dark family\'s subtle and the accent are truecolor values', subtle !== null && accent !== null, `${subtle} / ${accent}; the subtle role of the dark family in src/screen/theme/theme.ts or the accent from src/screen/widgets/sessionAccent.ts is not a hex or rgb() value`);

const collapsedAnsi = await renderToAnsiString(
  mounted(React.createElement(AssistantThinkingMessage, { param: { type: 'thinking', thinking: 'the reasoning body' } })),
  60,
);
const collapsed = stripAnsi(collapsedAnsi);
check('rendered collapsed row: the label paints', collapsed.includes(grammar.THINKING_LABEL), `${JSON.stringify(collapsed.trim())}; AssistantThinkingMessage in src/screen/messages/AssistantThinkingMessage.tsx must render ThinkingLabel`);
check('rendered collapsed row: the fold cue rides the same row', /thinking…\s+\(.*to expand\)|thinking…\s+⌄/.test(collapsed), `${JSON.stringify(collapsed.trim())}; AssistantThinkingMessage in src/screen/messages/AssistantThinkingMessage.tsx must put the expand cue on the label row`);
check('rendered collapsed row: the body stays folded', !collapsed.includes('the reasoning body'), 'AssistantThinkingMessage in src/screen/messages/AssistantThinkingMessage.tsx must not print the body unless verbose');
check('rendered collapsed row: painted in the subtle colour', collapsedAnsi.includes(`38;2;${subtle}`), `${JSON.stringify(collapsedAnsi.slice(0, 120))}; paint the row with THINKING_COLOR (subtle) in src/screen/messages/AssistantThinkingMessage.tsx`);
check('rendered collapsed row: the accent is absent from its bytes', !collapsedAnsi.includes(`38;2;${accent}`), 'the row in src/screen/messages/AssistantThinkingMessage.tsx must not use the session accent');
check('rendered collapsed row: italic', collapsedAnsi.includes('\x1b[3m'), 'the row in src/screen/messages/AssistantThinkingMessage.tsx must be italic');

const expandedAnsi = await renderToAnsiString(
  mounted(React.createElement(AssistantThinkingMessage, { param: { type: 'thinking', thinking: 'the reasoning body' }, verbose: true })),
  60,
);
const expanded = stripAnsi(expandedAnsi);
check('rendered expanded block: the same header, then the body', expanded.includes(grammar.THINKING_LABEL) && expanded.includes('the reasoning body'), 'AssistantThinkingMessage in src/screen/messages/AssistantThinkingMessage.tsx must print the label then the body when verbose');
check('rendered expanded block: no fold cue when the body is open', !/to expand|⌄/.test(expanded), 'AssistantThinkingMessage in src/screen/messages/AssistantThinkingMessage.tsx must drop the expand cue when verbose');
check('rendered expanded block: the accent is absent from its bytes', !expandedAnsi.includes(`38;2;${accent}`), 'the expanded block in src/screen/messages/AssistantThinkingMessage.tsx must not use the session accent');

const redactedAnsi = await renderToAnsiString(mounted(React.createElement(AssistantRedactedThinkingMessage, { addMargin: false })), 60);
const redacted = stripAnsi(redactedAnsi);
check('rendered redacted stub: the same label, nothing to expand', redacted.trim() === grammar.THINKING_LABEL, `${JSON.stringify(redacted.trim())}; src/screen/messages/AssistantRedactedThinkingMessage.tsx must render only ThinkingLabel`);
check('rendered redacted stub: painted in the subtle colour, never the accent', redactedAnsi.includes(`38;2;${subtle}`) && !redactedAnsi.includes(`38;2;${accent}`), 'src/screen/messages/AssistantRedactedThinkingMessage.tsx must paint the stub in the subtle colour and not the accent');

const { Message } = await import('../../src/screen/messages/Message.tsx');
const { declaredRouteOf } = await import('../../src/models/roads/callModelRouter.ts');
const GPT_MODEL = 'gpt-5.6-sol';
const CLAUDE_MODEL = 'claude-opus-4-8';
const dispatched = async (model: string): Promise<string> =>
  renderToAnsiString(
    mounted(
      React.createElement(Message as never, {
        message: {
          type: 'assistant',
          uuid: 'row-under-proof',
          timestamp: '2026-06-19T12:00:02.000Z',
          message: {
            id: 'msg-under-proof',
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'thinking', thinking: 'the reasoning body', signature: '' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        messages: [],
        tools: [],
        commands: [],
        verbose: false,
        addMargin: false,
        shouldAnimate: false,
        shouldShowDot: false,
        isTranscriptMode: false,
        isStatic: false,
        inProgressToolUseIDs: new Set<string>(),
        streamingToolUseIDs: new Set<string>(),
        progressMessagesForMessage: [],
        lookups: { recoveredStreamFaultUuids: new Set<string>() },
        width: 60,
      } as never),
    ),
    60,
  );
check('fixture: the two ids route to openai and anthropic', declaredRouteOf(GPT_MODEL) === 'openai' && declaredRouteOf(CLAUDE_MODEL) === 'anthropic', `${declaredRouteOf(GPT_MODEL)} / ${declaredRouteOf(CLAUDE_MODEL)}; declaredRouteOf in src/models/roads/callModelRouter.ts must route these ids to openai and anthropic, or pick ids it does`);
const gptRowAnsi = await dispatched(GPT_MODEL);
const claudeRowAnsi = await dispatched(CLAUDE_MODEL);
const gptRow = stripAnsi(gptRowAnsi);
check('dispatched GPT-route row: the collapsed label paints in the default view', gptRow.includes(grammar.THINKING_LABEL), `${JSON.stringify(gptRow.trim())}; src/screen/messages/Message.tsx must send a thinking block of a GPT-route message to AssistantThinkingMessage`);
check('dispatched GPT-route row: the expand cue rides the same row', /thinking…\s+\(.*to expand\)|thinking…\s+⌄/.test(gptRow), `${JSON.stringify(gptRow.trim())}; src/screen/messages/Message.tsx must send a thinking block of a GPT-route message to AssistantThinkingMessage with the expand cue`);
check('dispatched GPT-route row: the body stays folded', !gptRow.includes('the reasoning body'), 'src/screen/messages/Message.tsx must keep the thinking body folded for a GPT-route message in the default view');
check('dispatched GPT-route row: painted in the subtle colour, never the accent', gptRowAnsi.includes(`38;2;${subtle}`) && !gptRowAnsi.includes(`38;2;${accent}`), 'src/screen/messages/Message.tsx must paint a GPT-route thinking row in the subtle colour and not the accent');
check('dispatched rows: the GPT-route row and the Claude row are the same bytes', gptRowAnsi === claudeRowAnsi, JSON.stringify({ gpt: gptRow.trim(), claude: stripAnsi(claudeRowAnsi).trim() }) + '; src/screen/messages/Message.tsx must render a thinking row the same for every model route');

rmSync(HOME, { recursive: true, force: true });
process.exit(fail);
