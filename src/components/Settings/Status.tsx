import figures from 'figures';
import * as React from 'react';
import { Suspense, use } from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { Box, Text, useTheme } from '../../ink.js';
import { type AppState, useAppState } from '../../state/AppState.js';
import { useCwdState } from '../../hooks/useCwdState.js';
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js';
import { buildAPIProviderProperties, buildIDEProperties, buildInstallationDiagnostics, buildInstallationHealthDiagnostics, buildMcpProperties, buildMemoryDiagnostics, buildProviderAccountBlocks, buildSettingSourcesProperties, type Diagnostic, getModelDisplayLabel, type Property } from '../../utils/status.js';
import type { ThemeName } from '../../utils/theme.js';
import { displayWidth } from '../mercury-ui/glyphs.js';
import { useSessionAccent } from '../mercury-ui/sessionAccent.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';

// ============================================================================
//  Settings → Status — the Mercury session instrument card.
//  One glance answers: who am I running as, on what engine. The a bare stamp shape
//  (flat bold `Label:` rows) is replaced by the cockpit grammar: an identity
//  header (session-accent ✶ + name + a FAINT version chip) over eyebrow-labeled
//  sections (session · account · engine) with an aligned label column. DATA is
//  unchanged — the same utils/status.ts property builders feed the grid; values
//  stay ReactNodes (MCP/IDE rows carry their own tones). Diagnostics keep their
//  Suspense seam, restyled to the warn tone. SINGLE-BRAND: no wordmark here —
//  the ✶ + accent carry identity.
// ============================================================================

type Props = {
  context: LocalJSXCommandContext;
  diagnosticsPromise: Promise<Diagnostic[]>;
};

export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [...(await buildInstallationDiagnostics()), ...(await buildInstallationHealthDiagnostics()), ...(await buildMemoryDiagnostics())];
}

function PropertyValue({ value }: { value: Property['value'] }) {
  if (Array.isArray(value)) {
    return (
      <Box flexWrap="wrap" columnGap={1} flexShrink={99}>
        {value.map((item: React.ReactNode, i: number) => (
          <Text key={i}>
            {item}
            {i < value.length - 1 ? ',' : ''}
          </Text>
        ))}
      </Box>
    );
  }
  if (typeof value === 'string') return <Text>{value}</Text>;
  return value;
}

/** One eyebrow-labeled section: FAINT lowercase title + an aligned grid. */
function Section({
  title,
  properties,
  labelWidth,
}: {
  title: string;
  properties: Property[];
  labelWidth: number;
}) {
  const tokens = useMercuryTokens();
  if (properties.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color={tokens.textMuted}>{title}</Text>
      {properties.map(({ label, value }, j) => (
        <Box key={j} flexDirection="row" flexShrink={0} paddingLeft={1}>
          {label !== undefined && (
            <Box width={labelWidth} flexShrink={0}>
              <Text color={tokens.textSecondary}>{label}</Text>
            </Box>
          )}
          <PropertyValue value={value} />
        </Box>
      ))}
    </Box>
  );
}

export function Status({ context, diagnosticsPromise }: Props) {
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel);
  const mcp = useAppState((s: AppState) => s.mcp);
  const [theme] = useTheme();
  const tokens = useMercuryTokens();
  const accent = useSessionAccent().accent;

  const sessionId = getSessionId();
  const customTitle = getCurrentSessionTitle(sessionId);
  // The screen's ground on the ground beat (Law 9, census A12): a repo pick
  // repaints this row while the panel is open instead of on the next
  // unrelated re-render.
  const cwd = useCwdState();

  const sessionProps: Property[] = [
    { label: 'session id', value: sessionId },
    { label: 'cwd', value: cwd },
  ];
  // Provider-NEUTRAL accounts: one uniform
  // block per registry family — no brand owns the section's shape; API
  // transport facts (base URL/proxy/mTLS) ride after the provider blocks.
  const accountProps: Property[] = [
    ...buildProviderAccountBlocks(),
    ...buildAPIProviderProperties(),
  ];
  const engineProps: Property[] = [
    { label: 'model', value: getModelDisplayLabel(mainLoopModel) },
    ...buildIDEProperties(mcp.clients, context.options.ideInstallationStatus, theme as ThemeName),
    ...buildMcpProperties(mcp.clients, theme as ThemeName),
    ...buildSettingSourcesProperties(),
  ];
  // base labels arrive Title-cased ('Login method') — fold to the cockpit's
  // lowercase grid voice without touching the shared builders.
  const fold = (props: Property[]): Property[] =>
    props.map(p => (typeof p.label === 'string' ? { ...p, label: p.label.toLowerCase() } : p));
  const sections: Array<[string, Property[]]> = [
    ['session', sessionProps],
    ['accounts', fold(accountProps)],
    ['engine', fold(engineProps)],
  ];
  const labelWidth =
    Math.max(
      8,
      ...sections.flatMap(([, props]) =>
        props.map(p => (typeof p.label === 'string' ? displayWidth(p.label) : 0)),
      ),
    ) + 2;

  const grow = useIsInsideModal() ? 1 : undefined;
  return (
    <Box flexDirection="column" flexGrow={grow}>
      <Box flexDirection="column" gap={1} flexGrow={grow}>
        {/* Identity header: accent marker + name, the version as a quiet chip. */}
        <Box flexDirection="row">
          <Text color={accent}>{'✶ '}</Text>
          {customTitle ? (
            <Text bold color={tokens.textPrimary}>{customTitle}</Text>
          ) : (
            <Text color={tokens.textMuted}>unnamed session — /rename to add a name</Text>
          )}
          <Text color={tokens.textMuted}>{'  ·  v'}{MACRO.VERSION}</Text>
        </Box>
        {sections.map(([title, props]) => (
          <Section key={title} title={title} properties={props} labelWidth={labelWidth} />
        ))}
        <Suspense fallback={null}>
          <Diagnostics promise={diagnosticsPromise} />
        </Suspense>
      </Box>
      <Text dimColor>
        <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
      </Text>
    </Box>
  );
}

function Diagnostics({ promise }: { promise: Promise<Diagnostic[]> }) {
  const tokens = useMercuryTokens();
  const diagnostics = use(promise);
  if (diagnostics.length === 0) return null;
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Text color={tokens.textMuted}>diagnostics</Text>
      {diagnostics.map((diagnostic, i) => (
        <Box key={i} flexDirection="row" gap={1} paddingLeft={1}>
          <Text color={tokens.warning}>{figures.warning}</Text>
          {typeof diagnostic === 'string' ? <Text wrap="wrap">{diagnostic}</Text> : diagnostic}
        </Box>
      ))}
    </Box>
  );
}
