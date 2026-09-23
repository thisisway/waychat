#!/usr/bin/env bash
# grep-code.sh — Busca conteúdo em código (preferindo ripgrep)
# Uso: grep-code.sh <padrão> [diretório] [--ext extensão] [--type tipo] [--count]
#
# Exemplos:
#   grep-code.sh "useState" ./src --ext tsx
#   grep-code.sh "TODO" . --count
#   grep-code.sh "fetch\(" . --type js

set -euo pipefail

PATTERN="${1:?Uso: grep-code.sh <padrão> [dir] [--ext ext] [--type tipo] [--count]}"
DIR="${2:-.}"
EXT=""
TYPE=""
COUNT=0

shift 2 2>/dev/null || shift 1 2>/dev/null || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ext)   EXT="$2"; shift 2 ;;
    --type)  TYPE="$2"; shift 2 ;;
    --count) COUNT=1; shift ;;
    *) shift ;;
  esac
done

if command -v rg >/dev/null 2>&1; then
  CMD=(rg --hidden --glob '!node_modules' --glob '!.git' --glob '!dist' --glob '!build' --line-number --color never)
  [[ -n "$EXT"  ]] && CMD+=(--glob "*.$EXT")
  [[ -n "$TYPE" ]] && CMD+=(--type "$TYPE")
  [[ "$COUNT" -eq 1 ]] && CMD+=(--count)
  CMD+=("$PATTERN" "$DIR")
  "${CMD[@]}" || true
else
  GREP_ARGS=(-rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build)
  [[ -n "$EXT" ]] && GREP_ARGS+=(--include="*.$EXT")
  [[ "$COUNT" -eq 1 ]] && GREP_ARGS+=(-c)
  grep "${GREP_ARGS[@]}" "$PATTERN" "$DIR" 2>/dev/null || true
fi
