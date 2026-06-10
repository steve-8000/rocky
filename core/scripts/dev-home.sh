#!/bin/bash

copy_json_tree() {
  local source_dir="$1"
  local target_dir="$2"

  if [ ! -d "$source_dir" ]; then
    return
  fi

  mkdir -p "$target_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --include='*/' --include='*.json' --exclude='*' "$source_dir/" "$target_dir/"
    return
  fi

  while IFS= read -r -d '' source_file; do
    local relative_path="${source_file#"$source_dir"/}"
    local target_file="$target_dir/$relative_path"
    mkdir -p "$(dirname "$target_file")"
    cp "$source_file" "$target_file"
  done < <(find "$source_dir" -type f -name '*.json' -print0)
}

has_files() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

seed_worktree_rocky_home() {
  local source_home="${ROCKY_DEV_SEED_HOME:-$HOME/.rocky}"
  local target_home="$1"

  if [ ! -d "$source_home" ]; then
    echo "  Seed:    skipped (${source_home} missing)"
    return
  fi

  if [ "$source_home" = "$target_home" ]; then
    echo "  Seed:    skipped (source is target)"
    return
  fi

  if [ "${ROCKY_DEV_RESET_HOME:-0}" = "1" ]; then
    rm -rf "$target_home"
  elif has_files "$target_home"; then
    echo "  Seed:    skipped (${target_home} already has data)"
    return
  fi

  mkdir -p "$target_home"
  echo "  Seed:    copying metadata from ${source_home}"
  copy_json_tree "$source_home/agents" "$target_home/agents"
  copy_json_tree "$source_home/projects" "$target_home/projects"
  if [ -f "$source_home/config.json" ]; then
    cp "$source_home/config.json" "$target_home/config.json"
  fi

  echo "  Seed:    copied metadata from ${source_home}"
}

configure_dev_rocky_home() {
  if [ -n "${ROCKY_HOME:-}" ]; then
    export ROCKY_HOME
    return
  fi

  export ROCKY_HOME
  local git_dir
  local git_common_dir
  git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
  git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$git_dir" ] && [ -n "$git_common_dir" ] && [ "$git_dir" != "$git_common_dir" ]; then
    local worktree_root
    local worktree_name
    worktree_root="$(git rev-parse --show-toplevel)"
    worktree_name="$(basename "$worktree_root" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//')"
    ROCKY_HOME="$HOME/.rocky-${worktree_name}"
    seed_worktree_rocky_home "$ROCKY_HOME"
    return
  fi

  ROCKY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/rocky-dev.XXXXXX")"
  trap "rm -rf '$ROCKY_HOME'" EXIT
}
