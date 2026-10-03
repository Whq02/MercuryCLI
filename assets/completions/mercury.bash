_mercury_completions() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[1]}"
  local subcommands="acp auth bridge daemon extensions godot health image install mcp roster run runner update upgrade"
  local root_opts="--advise --agent --agent-defs --allow-sovereign --allowed-tools --backup-model --block-tools --brief --brief-add --budget --chat --concourse-off --concourse-on --config --config-layers --continue --debug --effort --ephemeral --extension --fork --format --help --input --lean --log-file --mcp --mode --model --multiplex --no-commands --only-mcp --partial --pr --project --provider-preview --resume --schema --session-id --sovereign --title --toolset --version --worktree"
  case "$prev" in
    acp)
      COMPREPLY=( $(compgen -W "" -- "$cur") )
      return 0
      ;;
    auth)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    bridge)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    daemon)
      COMPREPLY=( $(compgen -W "" -- "$cur") )
      return 0
      ;;
    extensions)
      COMPREPLY=( $(compgen -W "--help --previous --source --yes" -- "$cur") )
      return 0
      ;;
    godot)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    health)
      COMPREPLY=( $(compgen -W "--deep --end-stale --fix --help --json --only --yes" -- "$cur") )
      return 0
      ;;
    image)
      COMPREPLY=( $(compgen -W "--cols --help --protocol" -- "$cur") )
      return 0
      ;;
    install)
      COMPREPLY=( $(compgen -W "--allow-unsigned --dry-run --force --help --json --uninstall" -- "$cur") )
      return 0
      ;;
    mcp)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    roster)
      COMPREPLY=( $(compgen -W "--config-layers --help" -- "$cur") )
      return 0
      ;;
    run)
      COMPREPLY=( $(compgen -W "--advise --agent --agent-defs --allow-sovereign --allowed-tools --backup-model --block-tools --brief --brief-add --budget --chat --concourse-off --concourse-on --config --config-layers --continue --debug --effort --ephemeral --extension --fork --format --help --input --lean --log-file --mcp --mode --model --multiplex --no-commands --only-mcp --partial --pr --project --provider-preview --resume --schema --session-id --sovereign --title --toolset --version --worktree" -- "$cur") )
      return 0
      ;;
    runner)
      COMPREPLY=( $(compgen -W "--advise --agent --agent-defs --allow-sovereign --allowed-tools --backup-model --block-tools --brief --brief-add --budget --chat --concourse-off --concourse-on --config --config-layers --continue --debug --effort --ephemeral --extension --fork --help --lean --log-file --mcp --mode --model --multiplex --no-commands --only-mcp --pr --project --provider-preview --resume --schema --session-id --sovereign --title --toolset --version --worktree" -- "$cur") )
      return 0
      ;;
    update)
      COMPREPLY=( $(compgen -W "--allow-unsigned --check --help --json --rollback --status --yes" -- "$cur") )
      return 0
      ;;
    upgrade)
      COMPREPLY=( $(compgen -W "--allow-unsigned --check --help --json --rollback --status --yes" -- "$cur") )
      return 0
      ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$root_opts" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$subcommands" -- "$cur") )
  fi
  return 0
}
complete -F _mercury_completions mercury
