# Security

## Reporting a vulnerability

Report vulnerabilities privately through the repository's **Security** tab on
GitHub (Security → Report a vulnerability). Do not open a public issue for a
security problem, and do not send it by any other channel: the private report
is the one door.

Include:

- the `--version` line (`node dist/mercury.mjs --version`, or
  `mercury --version` for a release install);
- the output of `health --json` (`node dist/mercury.mjs health --json`, or
  `mercury health --json`);
- the OS and terminal;
- the exact steps, what you expected, and what happened instead;
- for a provider problem, the provider family and the model row.

The report thread is where the conversation continues.

## Supported versions

The latest release is supported. Older releases receive no fixes: update with
`mercury update`, or rebuild from the current source.
