#!/usr/bin/env bash
# analyze-logs.sh — Análise rápida de arquivos de log
# Uso: analyze-logs.sh <arquivo|diretório> [--errors] [--top N] [--since "1 hour ago"]
#
# Exemplos:
#   analyze-logs.sh ./logs/app.log --errors
#   analyze-logs.sh ./logs --top 20
#   analyze-logs.sh app.log --since "30 minutes ago"

set -euo pipefail

TARGET="${1:?Uso: analyze-logs.sh <arquivo|dir> [--errors] [--top N]}"
ERRORS_ONLY=0
TOP=10
SINCE=""

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --errors) ERRORS_ONLY=1; shift ;;
    --top)    TOP="$2"; shift 2 ;;
    --since)  SINCE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

collect_lines() {
  if [[ -d "$TARGET" ]]; then
    find "$TARGET" -type f \( -name "*.log" -o -name "*.txt" \) -exec cat {} +
  elif [[ -f "$TARGET" ]]; then
    cat "$TARGET"
  else
    echo "ERRO: '$TARGET' não encontrado" >&2
    exit 1
  fi
}

LINES=$(collect_lines)

if [[ "$ERRORS_ONLY" -eq 1 ]]; then
  echo "=== Erros/Warnings ==="
  echo "$LINES" | grep -iE "error|exception|fail|fatal|warn" | head -100
  echo ""
  echo "=== Top $TOP padrões de erro ==="
  echo "$LINES" | grep -iE "error|exception|fail" | \
    sed -E 's/[0-9]+/N/g; s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/UUID/g' | \
    sort | uniq -c | sort -rn | head -"$TOP"
else
  TOTAL=$(echo "$LINES" | wc -l | tr -d ' ')
  ERR=$(echo "$LINES" | grep -ciE "error|exception|fail|fatal" || true)
  WARN=$(echo "$LINES" | grep -ci "warn" || true)
  INFO=$(echo "$LINES" | grep -ci "info" || true)

  echo "=== Resumo ==="
  echo "Total de linhas: $TOTAL"
  echo "Errors:   $ERR"
  echo "Warnings: $WARN"
  echo "Info:     $INFO"
  echo ""
  echo "=== Top $TOP linhas mais frequentes ==="
  echo "$LINES" | \
    sed -E 's/[0-9]+/N/g; s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/UUID/g' | \
    sort | uniq -c | sort -rn | head -"$TOP"
fi
