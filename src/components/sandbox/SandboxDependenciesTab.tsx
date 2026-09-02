// Per-dependency presence report: found/missing lines with install
// hints, driven entirely by the caller-supplied dependency-check result.
// Which dependency an error refers to is decided by substring matching on
// the error text — the tool names `ripgrep`, `bwrap` and `socat` appear
// inside those strings (contract data with the sandbox runtime).

import React from 'react'
import { Box, Text } from '../../ink.js'
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js'
import { getPlatform } from '../../utils/platform.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { GLYPH } from '../mercury-ui/glyphs.js'

function installHintForRipgrep(): string {
  switch (getPlatform()) {
    case 'macos':
      return 'brew install ripgrep'
    case 'linux':
    case 'wsl':
      return 'apt install ripgrep (or your distribution equivalent)'
    default:
      return 'install ripgrep from your package manager'
  }
}

function DependencyLine({
  name,
  found,
  hint,
}: {
  name: string
  found: boolean
  hint?: string
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={found ? tokens.success : tokens.failure}>
          {found ? GLYPH.ok : GLYPH.fail}
        </Text>{' '}
        {name} <Text dimColor>{found ? 'found' : 'missing'}</Text>
      </Text>
      {!found && hint !== undefined ? (
        <Text dimColor>{'  '}{hint}</Text>
      ) : null}
    </Box>
  )
}

export function SandboxDependenciesTab({
  depCheck,
}: {
  depCheck: SandboxDependencyCheck
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const platform = getPlatform()
  const all = [...depCheck.errors, ...depCheck.warnings]
  const missingRipgrep = all.some(text => text.includes('ripgrep'))
  const missingBwrap = all.some(text => text.includes('bwrap'))
  const missingSocat = all.some(text => text.includes('socat'))
  // The seccomp filter's absence is signalled by the presence of ANY warning.
  const seccompMissing = depCheck.warnings.length > 0
  // Errors matching none of the known tool names render verbatim.
  const unmatched = depCheck.errors.filter(
    text =>
      !text.includes('ripgrep') &&
      !text.includes('bwrap') &&
      !text.includes('socat'),
  )

  return (
    <Box flexDirection="column">
      <DependencyLine
        name="ripgrep (search tool)"
        found={!missingRipgrep}
        hint={installHintForRipgrep()}
      />
      {platform === 'macos' ? (
        <Text>
          <Text color={tokens.success}>{GLYPH.ok}</Text> platform sandbox{' '}
          <Text dimColor>built in</Text>
        </Text>
      ) : (
        <>
          <DependencyLine
            name="bwrap (sandbox launcher)"
            found={!missingBwrap}
            hint="apt install bubblewrap (or your distribution equivalent)"
          />
          <DependencyLine
            name="socat (socket relay)"
            found={!missingSocat}
            hint="apt install socat (or your distribution equivalent)"
          />
          <Box flexDirection="column">
            <DependencyLine name="seccomp filter" found={!seccompMissing} />
            {seccompMissing ? (
              <Box flexDirection="column" paddingLeft={2}>
                <Text dimColor>
                  Without it, unix domain sockets cannot be blocked.
                </Text>
                <Text dimColor>
                  Either install a libseccomp-enabled build, or set
                  sandbox.network.allowUnixSockets /
                  sandbox.network.allowAllUnixSockets in your settings file to
                  acknowledge the gap.
                </Text>
              </Box>
            ) : null}
          </Box>
        </>
      )}
      {unmatched.map((text, index) => (
        <Text key={index} color={tokens.failure}>
          {text}
        </Text>
      ))}
    </Box>
  )
}
