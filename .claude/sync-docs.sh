#!/usr/bin/env bash
# Syncs AGENTS.md and Qwen.md whenever CLAUDE.md is written.
# Called as a PostToolUse hook; receives tool input JSON via CLAUDE_TOOL_INPUT.

file=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)

[[ "$file" == *"/CLAUDE.md" ]] || exit 0

dir=$(dirname "$file")
cp "$file" "$dir/AGENTS.md"
cp "$file" "$dir/Qwen.md"
cp "$file" "$dir/Gemini.md"
