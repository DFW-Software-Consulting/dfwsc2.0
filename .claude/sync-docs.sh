#!/usr/bin/env bash
# Syncs mirror docs whenever CLAUDE.md is written.
# The file that was edited (root CLAUDE.md or .claude/CLAUDE.md) is the source.
# The repo root is derived from the edited file, so edits made inside a git
# worktree sync within that worktree even though the hook is invoked by the
# primary checkout's path.

file=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)

[[ "$file" == *"CLAUDE.md" ]] || exit 0

# Portable realpath (no GNU-only flags); relative paths resolve against cwd.
abs=$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$file" 2>/dev/null)
[[ -n "$abs" ]] || exit 0

repo_root=$(git -C "$(dirname "$abs")" rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$repo_root" ]]; then
    repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
fi
repo_root=$(cd "$repo_root" 2>/dev/null && pwd -P) || exit 0

root_doc="$repo_root/CLAUDE.md"
claude_doc="$repo_root/.claude/CLAUDE.md"

if [[ "$abs" == "$claude_doc" ]]; then
    src="$claude_doc"
    targets=("$root_doc")
elif [[ "$abs" == "$root_doc" ]]; then
    src="$root_doc"
    targets=("$claude_doc")
else
    exit 0
fi
targets+=("$repo_root/AGENTS.md" "$repo_root/Gemini.md" "$repo_root/Qwen.md")

for t in "${targets[@]}"; do
    [[ "$t" == "$src" ]] || cp "$src" "$t"
done
