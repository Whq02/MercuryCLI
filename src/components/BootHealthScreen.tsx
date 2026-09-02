import React, { useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  HEALTH_STATUS_META,
  countByStatus,
  nextActions,
  runAndRecordHealthReport,
  type HealthCertificate as Cert,
  type HealthCheck,
  type HealthSection,
} from '../utils/healthReport.js';
import { formatAge, isFixable, sha7 } from '../utils/healthCertCore.js';
import { applyRemedy, healthFixEnabled, type AppliedFix } from '../utils/healthFix.js';
import { renderModelChip } from '../utils/model/model.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';


interface BootHealthScreenProps {
  onClose?: () => void;
  fullScene?: { columns: number; rows: number };
  certificate?: Cert;
}

export function healthLegendOf(state: { fixable: boolean; trailOpen: boolean; fixPhase: 'confirm' | 'running' | 'done' | null }): string {
  if (state.fixPhase === 'confirm') return '↵ apply · esc cancel';
  if (state.fixPhase === 'running') return 'applying… (the screen stays read-only until it settles)';
  if (state.fixPhase === 'done') return '↵ / esc dismiss';
  if (state.trailOpen) return '↑↓ move · ↵ back · esc back';
  return `↑↓ move · ↵ evidence${state.fixable ? ' · f fix' : ''} · d deep · r re-run · esc back`;
}

export function healthStatusLine(state:
  | { kind: 'running'; depth: 'fast' | 'deep'; done: number; total: number; current: string }
  | { kind: 'settled'; verdict: Cert['verdict']; checks: number; issuedAgo: string; durationMs: number }
  | { kind: 'failed' }): string {
  if (state.kind === 'running') {
    const progress = state.total > 0 ? ` · ${state.done}/${state.total} · ${state.current}` : '…';
    return `examining the harness (${state.depth})${progress}`;
  }
  if (state.kind === 'failed') return 'the certificate could not be produced — r re-runs';
  return `verdict ${state.verdict} · ${state.checks} checks · issued ${state.issuedAgo} · ${state.durationMs}ms · read-only`;
}

export type HealthEntry = {
  label: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: null;
  detail: null;
  detailExtra?: string[];
  inert?: boolean;
};

export function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

const NEXT_LABEL_MAX = 44;

export function healthNextEntries(cert: Cert): HealthEntry[] {
  if (cert.verdict === 'certified') return [];
  return nextActions(cert.sections.flatMap(s => s.checks), 3).map(a => ({
    label: (a.fix ?? '').length > NEXT_LABEL_MAX ? (a.fix ?? '').slice(0, NEXT_LABEL_MAX - 1) + '…' : (a.fix ?? ''),
    group: 'next',
    groupTitle: 'NEXT',
    summary: '',
    valueLabel: `${HEALTH_STATUS_META[a.status].glyph} ${a.status}`,
    valueIsDefault: false,
    pinnedVal: null,
    detail: null,
    inert: true,
  }));
}

export function healthEntryOf(check: HealthCheck, sectionTitle: string): HealthEntry {
  const meta = HEALTH_STATUS_META[check.status];
  return {
    label: check.label,
    group: sectionTitle,
    groupTitle: sectionTitle,
    summary: check.evidence,
    valueLabel: `${meta.glyph} ${check.status}`,
    valueIsDefault: !(check.status === 'fail' || check.status === 'warn' || check.status === 'stale' || check.status === 'unknown'),
    pinnedVal: null,
    detail: null,
  };
}

const DETAIL_W = 38;

export function healthDetailLines(check: HealthCheck): string[] {
  const meta = HEALTH_STATUS_META[check.status];
  const lines: string[] = [`${meta.glyph} ${check.status}`, ''];
  lines.push('evidence:');
  lines.push(...wrapPlain(check.evidence, DETAIL_W));
  if (check.detail) {
    lines.push('');
    lines.push(...wrapPlain(check.detail, DETAIL_W));
  }
  if (check.fix) {
    lines.push('');
    lines.push(...wrapPlain(`→ ${check.fix}`, DETAIL_W));
  }
  if (check.link) {
    lines.push('');
    lines.push(`related surface: ${check.link}`);
  }
  if (isFixable(check) && check.remedy) {
    lines.push('');
    lines.push(`f — apply the ${check.remedy.class} remedy`);
  }
  return lines;
}

export function healthTrailEntries(check: HealthCheck): HealthEntry[] {
  return healthDetailLines(check).map(line => ({
    label: line,
    group: 'evidence',
    groupTitle: check.label,
    summary: check.evidence,
    valueLabel: '',
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
    inert: true,
  }));
}

export type HealthFixFlow =
  | { phase: 'confirm'; check: HealthCheck }
  | { phase: 'running'; check: HealthCheck }
  | { phase: 'done'; check: HealthCheck; outcome: AppliedFix };

export function healthFixCardLines(flow: HealthFixFlow): string[] {
  const lines: string[] = [`fix · ${flow.check.remedy?.class ?? 'safe'} remedy`, ''];
  lines.push(...wrapPlain(flow.check.remedy?.plan ?? '', DETAIL_W));
  lines.push('');
  lines.push(...wrapPlain(`evidence: ${flow.check.evidence}`, DETAIL_W));
  lines.push('');
  if (flow.phase === 'confirm') {
    if (flow.check.remedy?.class === 'destructive') {
      lines.push(...wrapPlain('DESTRUCTIVE — this discards state that cannot be mechanically recovered.', DETAIL_W));
    }
    lines.push('↵ apply · esc cancel');
  } else if (flow.phase === 'running') {
    lines.push('applying…');
  } else {
    lines.push(`apply: ${flow.outcome.applied.ok ? 'ok' : 'FAILED'} — ${flow.outcome.applied.note}`.slice(0, DETAIL_W + 20));
    lines.push(
      flow.outcome.verified === null
        ? 'verify: skipped (apply failed)'
        : `verify: ${flow.outcome.verified.ok ? 'ok' : 'STILL FAILING'} — ${flow.outcome.verified.note}`.slice(0, DETAIL_W + 20),
    );
    lines.push('');
    lines.push(flow.outcome.verified?.ok ? '↵ dismiss + re-issue the certificate' : '↵ dismiss');
  }
  return lines;
}

export function healthSummaryRows(cert: Cert | null, nowMs: number = Date.now()): Array<{ key: string; value: string; tone?: 'teal' | 'amber' | 'crimson' | 'faint' }> {
  if (cert === null) {
    return [
      { key: 'Verdict', value: '… examining', tone: 'faint' },
      { key: 'Checks', value: 'streaming in as they settle', tone: 'faint' },
    ];
  }
  const checks = cert.sections.flatMap(s => s.checks);
  const counts = countByStatus(checks);
  const countBits = [
    counts.fail > 0 ? `${counts.fail} fail` : null,
    counts.stale > 0 ? `${counts.stale} stale` : null,
    counts.warn > 0 ? `${counts.warn} warn` : null,
    counts.unknown > 0 ? `${counts.unknown} unknown` : null,
    `${counts.ok} ok`,
  ].filter((b): b is string => b !== null);
  const meta =
    cert.verdict === 'certified'
      ? { glyph: '✓', tone: 'teal' as const }
      : cert.verdict === 'caution'
        ? { glyph: '▲', tone: 'amber' as const }
        : { glyph: '✕', tone: 'crimson' as const };
  return [
    { key: 'Verdict', value: `${meta.glyph} ${cert.verdict}`, tone: meta.tone },
    { key: 'Checks', value: `${checks.length} · ${countBits.join(' · ')}` },
    { key: 'Issued', value: `${formatAge(nowMs - Date.parse(cert.ranAt))} · ${cert.durationMs}ms` },
    {
      key: 'Build',
      value: cert.head.branch ? `${cert.version} · ${cert.head.branch} @ ${sha7(cert.head.sha)}${cert.head.dirty ? ' (dirty)' : ''}` : cert.version,
      tone: 'faint',
    },
  ];
}

export function healthVerdictLine(verdict: Cert['verdict']): string {
  return verdict === 'certified'
    ? 'every check is backed by fresh evidence — safe to trust'
    : verdict === 'caution'
      ? 'trust with care — stale, unknown, or warning rows below'
      : 'do not trust until the failing checks are fixed';
}

export function BootHealthScreen({ onClose, fullScene, certificate: given }: BootHealthScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;

  const [cert, setCert] = useState<Cert | null>(() => given ?? null);
  const [liveSections, setLiveSections] = useState<HealthSection[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [runToken, setRunToken] = useState(0);
  const depthRef = useRef<'fast' | 'deep'>('fast');
  useEffect(() => {
    if (given !== undefined) return;
    let alive = true;
    const ac = new AbortController();
    const acc = new Map<string, HealthSection>();
    runAndRecordHealthReport({
      depth: depthRef.current,
      signal: ac.signal,
      onProgress: ev => {
        if (!alive) return;
        const section = acc.get(ev.sectionId) ?? { id: ev.sectionId, title: ev.sectionTitle, checks: [] };
        section.checks = [...section.checks, ev.check];
        acc.set(ev.sectionId, section);
        setLiveSections([...acc.values()]);
        setProgress({ done: ev.done, total: ev.total, current: ev.check.label });
      },
    })
      .then(c => {
        if (!alive) return;
        setCert(c);
        setLoadFailed(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadFailed(String(e));
      })
      .finally(() => {
        if (alive) setProgress(null);
      });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [runToken, given]);
  const rerun = (depth: 'fast' | 'deep'): void => {
    if (given !== undefined) return;
    depthRef.current = depth;
    setCert(null);
    setLiveSections([]);
    setLoadFailed(null);
    setRunToken(n => n + 1);
  };

  const sections = cert?.sections ?? liveSections;
  const checkRows = useMemo(
    () => sections.flatMap(s => s.checks.map(check => ({ check, sectionTitle: s.title }))),
    [sections],
  );

  const [trailOpen, setTrailOpen] = useState(false);
  const [fixFlow, setFixFlow] = useState<HealthFixFlow | null>(null);
  const fixFlowRef = useRef<HealthFixFlow | null>(null);
  fixFlowRef.current = fixFlow;

  const list = useInteractiveList<{ check: HealthCheck; sectionTitle: string }>({
    rows: checkRows,
    rowId: r => `health:${r.check.id}`,
    idNamespace: 'boot-health',
    active: !trailOpen && fixFlow === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'return',
        hint: 'evidence',
        run: r => {
          if (r !== null) setTrailOpen(true);
          return null;
        },
      },
      {
        key: 'd',
        hint: 'deep',
        run: () => {
          rerun('deep');
          return null;
        },
      },
      {
        key: 'r',
        hint: 're-run',
        run: () => {
          rerun(depthRef.current);
          return null;
        },
      },
      {
        key: 'f',
        hint: 'fix',
        run: r => {
          if (r !== null && healthFixEnabled() && isFixable(r.check)) setFixFlow({ phase: 'confirm', check: r.check });
          return null;
        },
      },
    ],
  });
  const selected = list.selectedRow;

  useInput(
    (_input, key, event) => {
      if (!key.return && !key.escape) return;
      event.stopImmediatePropagation();
      setTrailOpen(false);
    },
    { isActive: trailOpen && fixFlow === null },
  );

  useInput(
    (_input, key, event) => {
      event.stopImmediatePropagation();
      const flow = fixFlowRef.current;
      if (flow === null) return;
      if (flow.phase === 'confirm') {
        if (key.escape) setFixFlow(null);
        else if (key.return) {
          const check = flow.check;
          setFixFlow({ phase: 'running', check });
          void applyRemedy(check).then(outcome => {
            if (fixFlowRef.current?.phase === 'running' && fixFlowRef.current.check.id === check.id) {
              setFixFlow({ phase: 'done', check, outcome });
            }
          });
        }
        return;
      }
      if (flow.phase === 'running') return;
      if (key.return || key.escape) {
        const verified = flow.outcome.verified?.ok === true;
        setFixFlow(null);
        if (verified) rerun(depthRef.current);
      }
    },
    { isActive: fixFlow !== null },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useMainLoopModel();

  const menuM = useMemo(() => {
    const critterKey = getSessionCritterKey();
    const environment = {
      model: renderModelChip(mainModel),
      critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
      critterHue: getSessionAccent().accent,
      dirBase: basename(process.cwd()) || process.cwd(),
      dirTail: '',
    };
    const statusRight =
      list.note ??
      (loadFailed !== null
        ? healthStatusLine({ kind: 'failed' })
        : cert !== null
          ? healthStatusLine({
              kind: 'settled',
              verdict: cert.verdict,
              checks: checkRows.length,
              issuedAgo: formatAge(Date.now() - Date.parse(cert.ranAt)),
              durationMs: cert.durationMs,
            })
          : healthStatusLine({
              kind: 'running',
              depth: depthRef.current,
              done: progress?.done ?? 0,
              total: progress?.total ?? 0,
              current: progress?.current ?? '',
            }));
    if (trailOpen && selected !== null) {
      return {
        entries: healthTrailEntries(selected.check),
        selIdx: -1,
        title: 'health check',
        summaryTitle: 'CERTIFICATE',
        summaryRows: healthSummaryRows(cert),
        environment,
        statusRight,
        glowWord: wordGlow,
        legend: healthLegendOf({ fixable: false, trailOpen: true, fixPhase: null }),
        detailOverride: healthDetailLines(selected.check),
      };
    }
    const entries: HealthEntry[] = [
      ...(cert !== null ? healthNextEntries(cert) : []),
      ...checkRows.map(r => healthEntryOf(r.check, r.sectionTitle)),
    ];
    const nextCount = cert !== null ? healthNextEntries(cert).length : 0;
    const fixable = selected !== null && healthFixEnabled() && isFixable(selected.check);
    return {
      entries,
      selIdx: selected !== null ? nextCount + list.selectedIndex : -1,
      title: 'health check',
      summaryTitle: 'CERTIFICATE',
      summaryRows: healthSummaryRows(cert),
      moreHint: '… (↵ opens the full trail)',
      environment,
      statusRight,
      glowWord: wordGlow,
      legend: healthLegendOf({ fixable, trailOpen: false, fixPhase: fixFlow?.phase ?? null }),
      ...(fixFlow !== null
        ? { detailOverride: healthFixCardLines(fixFlow) }
        : selected !== null
          ? { detailOverride: healthDetailLines(selected.check) }
          : {
              detailOverride:
                loadFailed !== null
                  ? ['the certificate could not be produced', '', ...wrapPlain(loadFailed, DETAIL_W), '', 'r re-runs']
                  : cert !== null
                    ? [healthVerdictLine(cert.verdict)]
                    : ['the probes are running —', 'settled checks stream in below.'],
            }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkRows, cert, progress, loadFailed, trailOpen, fixFlow, selected, list.selectedIndex, list.note, mainModel, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useMemo(() => {
    const menu = core.composeBootMenu(columns, rows, menuM) as {
      lines: string[];
      entryLines: Array<{ entry: number; line: number }>;
    };
    const { placed, top } = core.placeBlock(menu.lines, rows) as { placed: string[]; top: number };
    return {
      placed,
      entryAt: new Map<number, number>(menu.entryLines.map(e => [e.line + top, e.entry])),
    };
  }, [core, columns, rows, menuM]);

  const nextCount = cert !== null && !trailOpen ? healthNextEntries(cert).length : 0;
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        const rowIdx = entryIdx !== undefined && !trailOpen ? entryIdx - nextCount : -1;
        const row = rowIdx >= 0 ? checkRows[rowIdx] : undefined;
        if (row !== undefined && fixFlow === null) {
          const props = list.rowProps(row, rowIdx);
          return (
            <InteractiveRow
              key={props.id}
              id={props.id}
              selected={props.selected}
              unavailable={props.unavailable}
              onSelect={props.onSelect}
              onActivate={props.onActivate}
              selectionBand={false}
              hoverStyle="chrome-ink"
              height={1}
            >
              {hover => renderSceneLine(line, hover && !props.selected ? { label: row.check.label, color: t.info } : undefined)}
            </InteractiveRow>
          );
        }
        return (
          <Box key={`healthline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
