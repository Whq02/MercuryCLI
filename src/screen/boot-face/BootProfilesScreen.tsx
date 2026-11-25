import React, { useMemo, useState } from 'react';
import { Box, useInput } from '../themedRenderer.js';
import { createSplashCore, WORD_W } from '../../../assets/splash/splash-core.mjs';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { createProfile, listProfiles, removeProfile, renameProfile, type ProfileRow } from '../../platform/profiles/profiles.js';
import { errorMessage } from '../../platform/errors/errors.js';
import { bootEnvironment } from './bootEnvironment.js';
import { useGreetingShimmer } from '../widgets/useGreetingShimmer.js';
import { useInteractiveList } from '../widgets/useInteractiveList.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useSplashCoreAccent } from '../widgets/useSplashCoreAccent.js';
import { useBootComposition } from './useBootComposition.js';
import { settingsRowLine } from './settings/rows.js';

const PROFILE_NAME_MAX = 24;

type ProfileFaceRow = ProfileRow & { label: string };

type ProfilesFace =
  | { kind: 'list' }
  | { kind: 'rename'; profile: ProfileRow; name: string }
  | { kind: 'remove'; profile: ProfileRow; busy: boolean };

const removable = (profile: ProfileRow): boolean => profile.id !== 1 && !profile.current;

function startWords(profile: ProfileRow): string {
  if (profile.current) return 'this session runs in it';
  return profile.command === null ? 'its command is missing' : `${profile.command} starts it`;
}

function detailLinesOf(face: ProfilesFace, selected: ProfileRow | null): string[] {
  if (face.kind === 'rename') return [`name: ${face.name}▌`, '', 'an empty name puts the default back'];
  if (face.kind === 'remove') {
    return face.busy
      ? [`removing ${face.profile.name} — signing its logins out…`]
      : [`remove ${face.profile.name}?`, '', 'its logins are signed out and its command is deleted —', `its folder stays at ${face.profile.home}`];
  }
  return selected === null ? [] : [selected.home, '', startWords(selected)];
}

export function BootProfilesScreen({ onClose, fullScene }: { onClose: () => void; fullScene: { columns: number; rows: number } }): React.ReactNode {
  const t = useMercuryTokens();
  const { columns, rows } = fullScene;
  const [tick, setTick] = useState(0);
  const profiles = useMemo<ProfileFaceRow[]>(() => listProfiles().map(profile => ({ ...profile, label: `${profile.id} · ${profile.name}` })), [tick]);
  const [face, setFace] = useState<ProfilesFace>({ kind: 'list' });
  const [note, setNote] = useState<string | null>(null);
  const settle = (line: string | null): void => {
    setFace({ kind: 'list' });
    setNote(line);
    setTick(n => n + 1);
  };

  const list = useInteractiveList<ProfileFaceRow>({
    rows: profiles,
    rowId: profile => String(profile.id),
    idNamespace: 'boot-profiles',
    active: face.kind === 'list',
    onClose,
    actions: [
      {
        key: 'n',
        hint: 'new',
        run: () => {
          const made = createProfile();
          settle(made.ok ? `${made.profile.name} created — ${startWords(made.profile)}` : made.reason);
          return null;
        },
      },
      {
        key: 'r',
        hint: 'rename',
        run: profile => {
          if (profile !== null) setFace({ kind: 'rename', profile, name: '' });
          return null;
        },
      },
      {
        key: 'backspace',
        hint: 'remove',
        when: removable,
        run: profile => {
          if (profile !== null) setFace({ kind: 'remove', profile, busy: false });
          return null;
        },
      },
    ],
  });

  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      if (face.kind !== 'rename') return;
      if (key.escape) {
        setFace({ kind: 'list' });
        return;
      }
      if (key.return) {
        const renamed = renameProfile(face.profile.id, face.name);
        settle(renamed.ok ? null : renamed.reason);
        return;
      }
      if (key.backspace || key.delete) {
        setFace(f => (f.kind === 'rename' ? { ...f, name: f.name.slice(0, -1) } : f));
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
        setFace(f => (f.kind === 'rename' ? { ...f, name: (f.name + input).slice(0, PROFILE_NAME_MAX) } : f));
      }
    },
    { isActive: face.kind === 'rename' },
  );

  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      if (face.kind !== 'remove' || face.busy) return;
      if (input === 'y' || key.return) {
        const { profile } = face;
        setFace({ kind: 'remove', profile, busy: true });
        void removeProfile(profile.id)
          .then(removed => (removed.ok ? `${profile.name} removed — its folder stays at ${removed.keptHome}` : removed.reason), errorMessage)
          .then(settle);
      } else if (input === 'n' || key.escape) setFace({ kind: 'list' });
    },
    { isActive: face.kind === 'remove' },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useEngineModel();

  const selected = list.selectedRow;
  const menuM = useMemo(() => {
    return {
      entries: profiles.map(profile => ({
        label: profile.label,
        group: 'profiles',
        summary: startWords(profile),
        valueLabel: [profile.command ?? '—', ...(profile.current ? ['this one'] : [])].join(' · '),
        valueIsDefault: !profile.current,
        pinnedVal: null,
        detail: null,
      })),
      selIdx: list.selectedIndex,
      title: 'profiles (beta)',
      summaryTitle: 'PROFILES',
      summaryRows: [
        { key: 'Profiles', value: String(profiles.length) },
        ...profiles.filter(profile => profile.current).map(profile => ({ key: 'This one', value: profile.name })),
      ],
      environment: bootEnvironment(mainModel, process.cwd()),
      statusRight: note ?? `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`,
      noticeLine: note,
      glowWord: wordGlow,
      legend:
        face.kind === 'rename'
          ? 'type a name · ↵ save · esc cancel'
          : face.kind === 'remove'
            ? 'y / ↵ remove · n / esc cancel'
            : `↑↓ move · n new · r rename${selected !== null && removable(selected) ? ' · ⌫ remove' : ''} · esc back`,
      detailOverride: detailLinesOf(face, selected),
      detailOverrideConfirms: face.kind !== 'list',
    };
  }, [profiles, face, note, selected, list.selectedIndex, mainModel, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useBootComposition(core, columns, rows, menuM);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => settingsRowLine({ composition, list, menuRows: profiles, t }, i))}
    </Box>
  );
}
