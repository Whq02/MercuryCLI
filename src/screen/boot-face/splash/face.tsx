import type { Dispatch, SetStateAction } from 'react';
import figures from 'figures';
import { Box } from '../../themedRenderer.js';
import type { createSplashCore, SplashComposeOpts, SplashStripChips } from '../../../../assets/splash/splash-core.mjs';
import { truncateToWidth } from '../../theme/glyphs.js';
import type { scanBootCardFacts, BootProjectFact } from '../bootCardFacts.js';
import type { PlainWorldWhy } from '../../routes/surfaceRoute.js';
import { BootAgentsScreen } from '../BootAgentsScreen.js';
import { BootHealthScreen } from '../BootHealthScreen.js';
import { BootLoginsScreen } from '../BootLoginsScreen.js';
import { BootProfilesScreen } from '../BootProfilesScreen.js';
import { BootResumeScreen } from '../BootResumeScreen.js';
import { BootSaturnScreen } from '../BootSaturnScreen.js';
import { BootSettingsScreen } from '../BootSettingsScreen.js';
import { KitMenuScreen } from '../KitMenuScreen.js';
import { MercuryModelDefaultPicker } from '../../../commands/model/mercuryModel.js';
import { ModalContext } from '../../overlays/modalContext.js';
import { PopupGutter } from '../../overlays/PopupGutter.js';
import { modelPickerPopupGeometry } from '../../overlays/ModelPickerPopupSlot.js';
import { InteractiveRow } from '../../widgets/InteractiveRow.js';
import { renderSceneLine } from '../../widgets/SceneCanvas.js';
import type { useGreetingShimmer } from '../../widgets/useGreetingShimmer.js';
import type { useInteractiveList, AsyncListNote } from '../../widgets/useInteractiveList.js';
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js';
import type { BootRow } from './rowActions.js';

export function bootSplashCompositionOf({ isCompact, composedRows, selectedIndex, core, columns, rows, modelDefaultDoor, stripHint, wordGlow, rowGlow, bottomRowWithNotice, updateLine, chips, plainWhy, keyMapHint }: { isCompact: boolean; composedRows: BootRow[]; selectedIndex: number; core: ReturnType<typeof createSplashCore>; columns: number; rows: number; modelDefaultDoor: boolean; stripHint: string; wordGlow: ReturnType<typeof useGreetingShimmer>; rowGlow: ReturnType<typeof useGreetingShimmer>; bottomRowWithNotice: (core: ReturnType<typeof createSplashCore>, columns: number, keyMapHint: string, notice: string | null, compact: boolean) => string | null; updateLine: string | null; chips: SplashStripChips; plainWhy: PlainWorldWhy | null; keyMapHint: string }) {
  if (isCompact) {
    const compact = core.composeCompactFace(columns, rows, {
      cardRows: composedRows.map(r => ({ label: r.label, ctx: r.key === 'continue' && r.ctx.startsWith('in ') ? r.ctx : '', ...(r.dim ? { dim: true } : {}) })),
      cardSel: selectedIndex,
      hintSegments: [
        { key: '>_', label: '', tone: 'faint' as const },
        { key: '↵', label: '', tone: 'ivory' as const },
        { key: '↑↓', label: '', tone: 'faint' as const },
        ...(modelDefaultDoor ? [] : [{ key: 'm', label: ' menu', tone: 'faint' as const }]),
      ],
      keyMap: stripHint,
      stripLines: w => core.composeStrip(chips, w),
      pointer: figures.pointer,
      glowWord: wordGlow,
      glowRow: rowGlow,
    });
    const placed = [...compact.lines];
    const corner = bottomRowWithNotice(core, columns, stripHint, updateLine, true);
    if (corner !== null && ((stripHint !== '' && rows > 2) || placed[rows - 1] === '')) placed[rows - 1] = corner;
    return {
      placed,
      actionAt: new Map<number, number>(compact.actions.map(a => [a.line, a.index])),
      lastRowFree: false,
      boxed: compact.framed,
    };
  }
  const lockupOptions: SplashComposeOpts = {
    cardRows: composedRows.map(r => ({
      label: r.label,
      ctx: r.key === 'continue' && r.ctx.startsWith('in ') ? r.ctx : '',
      ...(r.dim ? { dim: true } : {}),
    })),
    cardSel: selectedIndex,
    hintSegments: [
      { key: '↵', label: '', tone: 'ivory' as const },
      ...(modelDefaultDoor ? [] : [{ key: 'm', label: ' menu', tone: 'faint' as const }]),
    ],
    tinyHint: '↵',
    stripLines: (w: number) => core.composeStrip(chips, w) as string[],
    glowWord: wordGlow,
    glowRow: rowGlow,
  };
  const composeOver = (faceRows: number) => {
    const composed = core.composeLockup(columns, faceRows, lockupOptions);
    return { faceRows, composed, ...core.placeBlock(composed.lines, faceRows) };
  };
  let fit = composeOver(plainWhy !== null && keyMapHint !== '' ? Math.max(1, rows - 1) : rows);
  if (keyMapHint !== '' && fit.faceRows === rows && fit.top + fit.composed.lines.length > rows - 1) {
    fit = composeOver(Math.max(1, rows - 1));
  }
  return {
    placed: fit.placed,
    actionAt: new Map<number, number>(fit.composed.actionLines.map((line, i) => [line + fit.top, i])),
    lastRowFree: fit.faceRows !== rows || fit.top + fit.composed.lines.length <= rows - 1,
    boxed: fit.composed.cardShown,
  };
}

export function bootSplashFaceView({ settingsOpen, columns, rows, setSettingsOpen, kitOpen, setKitOpen, profilesOpen, setProfilesOpen, healthOpen, setHealthOpen, saturnOpen, setSaturnOpen, agentsOpen, loginsOpen, setLoginsOpen, setAgentsOpen, closeLogins, loginsFamily, loginsBack, resumeOpen, setResumeOpen, facts, runningOf, openProject, composition, list, birthReceipt, core, isCompact, keyMapHint, updateLine, bottomRowWithNotice, KEY_MAP_ROW, composedRows, t, modelDefaultOpen, setModelDefaultOpen, setLoginsFamily, setLoginsBack }: { settingsOpen: boolean; columns: number; rows: number; setSettingsOpen: Dispatch<SetStateAction<boolean>>; kitOpen: boolean; setKitOpen: Dispatch<SetStateAction<boolean>>; profilesOpen: boolean; setProfilesOpen: Dispatch<SetStateAction<boolean>>; healthOpen: boolean; setHealthOpen: Dispatch<SetStateAction<boolean>>; saturnOpen: boolean; setSaturnOpen: Dispatch<SetStateAction<boolean>>; agentsOpen: boolean; loginsOpen: boolean; setLoginsOpen: Dispatch<SetStateAction<boolean>>; setAgentsOpen: Dispatch<SetStateAction<boolean>>; closeLogins: () => void; loginsFamily: string | undefined; loginsBack: 'route' | 'picker' | null; resumeOpen: boolean; setResumeOpen: Dispatch<SetStateAction<boolean>>; facts: ReturnType<typeof scanBootCardFacts>; runningOf: (dir: string) => number; openProject: (p: BootProjectFact) => AsyncListNote; composition: ReturnType<typeof bootSplashCompositionOf>; list: ReturnType<typeof useInteractiveList<BootRow>>; birthReceipt: string | null; core: ReturnType<typeof createSplashCore>; isCompact: boolean; keyMapHint: string; updateLine: string | null; bottomRowWithNotice: (core: ReturnType<typeof createSplashCore>, columns: number, keyMapHint: string, notice: string | null, compact: boolean) => string | null; KEY_MAP_ROW: (core: ReturnType<typeof createSplashCore>, hint: string) => string; composedRows: BootRow[]; t: ReturnType<typeof useMercuryTokens>; modelDefaultOpen: boolean; setModelDefaultOpen: Dispatch<SetStateAction<boolean>>; setLoginsFamily: Dispatch<SetStateAction<string | undefined>>; setLoginsBack: Dispatch<SetStateAction<'route' | 'picker' | null>> }) {
  if (profilesOpen) {
    return (
      <BootProfilesScreen
        fullScene={{ columns, rows }}
        onClose={() => setProfilesOpen(false)}
      />
    );
  }
  if (settingsOpen && !kitOpen && !agentsOpen) {
    return (
      <BootSettingsScreen
        fullScene={{ columns, rows }}
        onClose={() => setSettingsOpen(false)}
        onOpenEditor={editor => editor === 'kit' ? setKitOpen(true) : setAgentsOpen(true)}
      />
    );
  }
  if (kitOpen) {
    return (
      <KitMenuScreen
        fullScene={{ columns, rows }}
        onClose={() => setKitOpen(false)}
      />
    );
  }
  if (healthOpen) {
    return (
      <BootHealthScreen
        fullScene={{ columns, rows }}
        onClose={() => setHealthOpen(false)}
      />
    );
  }
  if (saturnOpen) {
    return (
      <BootSaturnScreen
        fullScene={{ columns, rows }}
        onClose={() => setSaturnOpen(false)}
      />
    );
  }
  if (agentsOpen) {
    return (
      <>
        <BootAgentsScreen
          suspended={loginsOpen}
          onOpenLogins={() => setLoginsOpen(true)}
          fullScene={{ columns, rows }}
          onClose={() => setAgentsOpen(false)}
        />
        {loginsOpen ? (
          <BootLoginsScreen
            fullScene={{ columns, rows }}
            onClose={closeLogins}
          />
        ) : null}
      </>
    );
  }
  if (loginsOpen) {
    return (
      <BootLoginsScreen
        fullScene={{ columns, rows }}
        family={loginsFamily}
        onClose={closeLogins}
        {...(loginsBack !== null ? { onSignedIn: closeLogins } : {})}
      />
    );
  }
  if (resumeOpen) {
    return (
      <BootResumeScreen
        fullScene={{ columns, rows }}
        onClose={() => setResumeOpen(false)}
        projects={facts.pickerProjects.map(p => {
          const running = runningOf(p.dir);
          return running > 0 ? { ...p, running } : p;
        })}
        openProject={openProject}
      />
    );
  }

  const pickerPopup = modelPickerPopupGeometry({ left: 0, top: 0, columns, rows }, rows);
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        if (i === rows - 1 && (list.note !== null || birthReceipt !== null)) {
          const noteLine = '  ' + core.hexFg(core.FAINT, core.T256.faint) + (list.note ?? birthReceipt ?? '') + core.R;
          return (
            <Box key="boot-note" height={1} flexShrink={0}>
              {renderSceneLine(isCompact ? truncateToWidth(noteLine, columns) : noteLine)}
            </Box>
          );
        }
        if (i === rows - 1 && composition.lastRowFree && (keyMapHint !== '' || updateLine !== null)) {
          const bottomLine =
            bottomRowWithNotice(core, columns, keyMapHint, updateLine, false) ?? (keyMapHint !== '' ? KEY_MAP_ROW(core, keyMapHint) : '');
          return (
            <Box key="boot-keymap" height={1} flexShrink={0}>
              {bottomLine === '' ? null : renderSceneLine(isCompact ? truncateToWidth(bottomLine, columns) : bottomLine)}
            </Box>
          );
        }
        const actionIdx = composition.actionAt.get(i);
        if (actionIdx !== undefined && composedRows[actionIdx] !== undefined) {
          const row = composedRows[actionIdx]!;
          const props = list.rowProps(row, actionIdx);
          const glowLabel = row.label;
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
              {hover =>
                renderSceneLine(line, hover && !props.selected ? { label: glowLabel, color: t.info } : undefined)
              }
            </InteractiveRow>
          );
        }
        return (
          <Box key={`bootline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
      {modelDefaultOpen ? (
        <PopupGutter {...pickerPopup}>
          <ModalContext.Provider value={{ rows: pickerPopup.rows, columns: pickerPopup.columns, scrollRef: null }}>
            <MercuryModelDefaultPicker
              onDone={() => setModelDefaultOpen(false)}
              onSignIn={family => {
                setModelDefaultOpen(false);
                setLoginsFamily(family);
                setLoginsBack('picker');
                setLoginsOpen(true);
              }}
            />
          </ModalContext.Provider>
        </PopupGutter>
      ) : null}
    </Box>
  );
}
