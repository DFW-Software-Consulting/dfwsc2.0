#!/usr/bin/env bash
# Syncs root mirror docs whenever CLAUDE.md is written.
# Supports both root and .claude/CLAUDE.md.

file=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)

[[ "$file" == *"CLAUDE.md" ]] || exit 0

# Determine the source file (prefers root CLAUDE.md if available)
if [[ -f "CLAUDE.md" ]]; then
    src="CLAUDE.md"
else
    src="$file"
fi

# Determine the root directory
if [[ "$file" == *"/.claude/CLAUDE.md" ]]; then
    repo_root=$(dirname "$(dirname "$file")")
else
    repo_root="."
fi

# Sync the mirrors
cp "$src" "$repo_root/AGENTS.md"
cp "$src" "$repo_root/Qwen.md"
cp "$src" "$repo_root/Gemini.md"
