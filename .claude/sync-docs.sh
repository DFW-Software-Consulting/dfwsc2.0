#!/usr/bin/env bash
# Syncs mirror docs whenever CLAUDE.md is written.
# The file that was edited (root CLAUDE.md or .claude/CLAUDE.md) is the source.

file=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)

[[ "$file" == *"CLAUDE.md" ]] || exit 0

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
root_doc="$repo_root/CLAUDE.md"
claude_doc="$repo_root/.claude/CLAUDE.md"

# Resolve the edited path (absolute or relative to cwd) and pick the source.
abs=$(realpath -m -- "$file")
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
