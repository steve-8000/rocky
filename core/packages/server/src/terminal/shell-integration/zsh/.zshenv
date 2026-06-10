typeset -g ROCKY_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${ROCKY_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${ROCKY_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${ROCKY_SHELL_INTEGRATION_DIR}/rocky-integration.zsh"
