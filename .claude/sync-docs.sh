#!/usr/bin/env bash
# Syncs root mirror docs whenever .claude/CLAUDE.md is written.
# Called as a PostToolUse hook; receives tool input JSON via CLAUDE_TOOL_INPUT.

file=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)

[[ "$file" == *"/.claude/CLAUDE.md" ]] || exit 0

repo_root=$(dirname "$(dirname "$file")")
cp "$file" "$repo_root/AGENTS.md"
cp "$file" "$repo_root/Qwen.md"
cp "$file" "$repo_root/Gemini.md"
