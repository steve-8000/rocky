if [[ -n "${_ROCKY_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _ROCKY_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _ROCKY_ZSH_COMMAND_ACTIVE=0

function _rocky_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _rocky_precmd() {
  local command_status=$?
  if [[ "$_ROCKY_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _rocky_osc633 "D;${command_status}"
    _ROCKY_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _rocky_osc633 "A"
}

function _rocky_preexec() {
  _ROCKY_ZSH_COMMAND_ACTIVE=1
  _rocky_osc633 "B"
  _rocky_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _rocky_precmd
add-zsh-hook preexec _rocky_preexec
