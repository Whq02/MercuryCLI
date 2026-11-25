import React, { useMemo, useState } from 'react';
import { Box, useInput } from '../themedRenderer.js';
import { createSplashCore, WORD_W } from '../../../assets/splash/splash-core.mjs';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { createProfile, listProfiles, removeProfile, renameProfile, type ProfileRow } from '../../platform/profiles/profiles.js';
import { inheritSkills } from '../../integrations/skills/inheritSkills.js';
import { errorMessage } from '../../platform/errors/errors.js';
import { bootEnvironment } from './bootEnvironment.js';
import { useGreetingShimmer } from '../widgets/useGreetingShimmer.js';
import { useInteractiveList } from '../widgets/useInteractiveList.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useSplashCoreAccent } from '../widgets/useSplashCoreAccent.js';
import { useBootComposition } from './useBootComposition.js';
import { settingsRowLine } from './settings/rows.js';
import { typedName } from './typedName.js';

const PROFILE_NAME_MAX = 24;

type ProfileFaceRow = ProfileRow & { label: string };

type ProfilesFace =
  | { kind: 'list' }
  | { kind: 'rename'; profile: ProfileRow; name: string }
  | { kind: 'remove'; profile: ProfileRow };

type Said = { where: 'status' | 'pane'; text: string };

const removable = (profile: ProfileRow): boolean => profile.id !== 1 && !profile.current;

function startWords(profile: ProfileRow): string {
  if (profile.current) return 'this session runs in it';
  return profile.command === null ? 'its command is missing' : `${profile.command} starts it`;
}

function skillsWords(answer: Awaited<ReturnType<typeof inheritSkills>>, from: string): string | null {
  if (!answer.ok) return answer.reason;
  return answer.skills.length === 0 ? null : `${answer.skills.length} skill${answer.skills.length === 1 ? '' : 's'} copied from ${from}, switched off`;
}

function detailLinesOf(face: ProfilesFace, selected: ProfileRow | null, said: Said | null): string[] {
  if (face.kind === 'rename') return [`name: ${face.name}▌`, '', 'an empty name puts the default back'];
  if (face.kind === 'remove') return [`remove ${face.profile.name}?`, '', 'its command is removed,', `its folder and logins stay at ${face.profile.home}`];
  if (said?.where === 'pane') return said.text.split('\n');
  return selected === null ? [] : [selected.home, '', startWords(selected)];
}

export function BootProfilesScreen({ onClose, fullScene }: { onClose: () => void; fullScene: { columns: number; rows: number } }): React.ReactNode {
  const t = useMercuryTokens();
  const { columns, rows } = fullScene;
  const [tick, setTick] = useState(0);
  const read = useMemo(() => listProfiles(), [tick]);
  const profiles = useMemo<ProfileFaceRow[]>(() => (read.ok ? read.profiles : []).map(profile => ({ ...profile, label: `${profile.id} · ${profile.name}` })), [read]);
  const [face, setFace] = useState<ProfilesFace>({ kind: 'list' });
  const [said, setSaid] = useState<Said | null>(null);
  const settle = (next: Said | null): void => {
    setFace({ kind: 'list' });
    setSaid(next);
    setTick(n => n + 1);
  };
  const open = (next: ProfilesFace): void => {
    setSaid(null);
    setFace(next);
  };

  const list = useInteractiveList<ProfileFaceRow>({
    rows: profiles,
    rowId: profile => String(profile.id),
    idNamespace: 'boot-profiles',
    active: face.kind === 'list',
    onClose,
    actions: read.ok
      ? [
          {
            key: 'n',
            hint: 'new',
            run: () => {
              const made = createProfile();
              if (!made.ok) {
                settle({ where: 'pane', text: made.reason });
                return null;
              }
              const created: Said = { where: 'status', text: `${made.profile.name} created — ${startWords(made.profile)}` };
              const from = profiles.find(profile => profile.current)?.name ?? 'this profile';
              settle(created);
              void inheritSkills(made.profile.home)
                .then(answer => skillsWords(answer, from), errorMessage)
                .then(line => {
                  if (line !== null) setSaid(now => (now === created ? { where: 'pane', text: `${created.text};\n${line}` } : now));
                });
              return null;
            },
          },
          {
            key: 'r',
            hint: 'rename',
            run: profile => {
              if (profile !== null) open({ kind: 'rename', profile, name: '' });
              return null;
            },
          },
          {
            key: 'backspace',
            hint: 'remove',
            when: removable,
            run: profile => {
              if (profile !== null) open({ kind: 'remove', profile });
              return null;
            },
          },
        ]
      : [],
  });
  const selected = list.selectedRow;
  const [saidBeside, setSaidBeside] = useState<{ said: Said | null; id: number | undefined }>({ said: null, id: undefined });
  if (saidBeside.said !== said) setSaidBeside({ said, id: selected?.id });
  else if (said !== null && saidBeside.id !== selected?.id) setSaid(null);

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
        settle(renamed.ok ? null : { where: 'pane', text: renamed.reason });
        return;
      }
      setFace(f => {
        if (f.kind !== 'rename') return f;
        const name = typedName(f.name, input, key, PROFILE_NAME_MAX);
        return name === null ? f : { ...f, name };
      });
    },
    { isActive: face.kind === 'rename' },
  );

  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      if (face.kind !== 'remove') return;
      if (input === 'y' || key.return) {
        const removed = removeProfile(face.profile.id);
        const left = removed.ok && removed.keptFiles !== undefined ? `;\nleft in place, not its command: ${removed.keptFiles.join(', ')}` : '';
        settle({ where: 'pane', text: removed.ok ? `${face.profile.name} removed: its folder stays at ${removed.keptHome}${left}` : removed.reason });
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
      title: 'profiles',
      summaryTitle: 'PROFILES',
      summaryRows: profiles.filter(profile => profile.current).map(profile => ({ key: 'This one', value: profile.name })),
      environment: bootEnvironment(mainModel, process.cwd()),
      statusRight: !read.ok ? 'the profile list could not be read' : said?.where === 'status' ? said.text : `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`,
      noticeLine: said?.where === 'status' ? said.text : null,
      glowWord: wordGlow,
      legend: !read.ok
        ? 'esc back'
        : face.kind === 'rename'
          ? 'type a name · ↵ save · esc cancel'
          : face.kind === 'remove'
            ? 'y / ↵ remove · n / esc cancel'
            : `↑↓ move · n new · r rename${selected !== null && removable(selected) ? ' · ⌫ remove' : ''} · esc back`,
      detailOverride: read.ok ? detailLinesOf(face, selected, said) : [read.reason],
      detailOverrideConfirms: !read.ok || face.kind !== 'list' || said?.where === 'pane',
    };
  }, [read, profiles, face, said, selected, list.selectedIndex, mainModel, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useBootComposition(core, columns, rows, menuM);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => settingsRowLine({ composition, list, menuRows: profiles, t }, i))}
    </Box>
  );
}
