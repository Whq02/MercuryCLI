_mercury_completions() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[1]}"
  local subcommands="acp agents auth daemon doctor editor extensions health install mcp show themis update upgrade"
  local root_opts="--add-dir --agent --agents --allow-dangerously-bypass-permissions --allowed-tools --append-system-prompt --bare --betas --chat --concourse-off --concourse-on --continue --dangerously-bypass-permissions --debug --debug-file --disable-slash-commands --disallowed-tools --effort --extension --fallback-model --fork-session --from-pr --help --ide --include-partial-messages --input-format --json-schema --max-budget-usd --mcp-config --model --name --no-session-persistence --output-format --permission-mode --print --project-root --replay-user-messages --resume --session-id --setting-sources --settings --strict-mcp-config --system-prompt --tmux --tools --version --worktree"
  case "$prev" in
    acp)
      COMPREPLY=( $(compgen -W "" -- "$cur") )
      return 0
      ;;
    agents)
      COMPREPLY=( $(compgen -W "--help --setting-sources" -- "$cur") )
      return 0
      ;;
    auth)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    daemon)
      COMPREPLY=( $(compgen -W "" -- "$cur") )
      return 0
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--deep --fix --help --json --only --yes" -- "$cur") )
      return 0
      ;;
    editor)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    extensions)
      COMPREPLY=( $(compgen -W "--help --previous --source --yes" -- "$cur") )
      return 0
      ;;
    health)
      COMPREPLY=( $(compgen -W "--deep --fix --help --json --only --yes" -- "$cur") )
      return 0
      ;;
    install)
      COMPREPLY=( $(compgen -W "--dry-run --force --help --json --uninstall" -- "$cur") )
      return 0
      ;;
    mcp)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    show)
      COMPREPLY=( $(compgen -W "--cols --help --protocol" -- "$cur") )
      return 0
      ;;
    themis)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return 0
      ;;
    update)
      COMPREPLY=( $(compgen -W "--check --help --json --rollback --status" -- "$cur") )
      return 0
      ;;
    upgrade)
      COMPREPLY=( $(compgen -W "--check --help --json --rollback --status" -- "$cur") )
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
