#!/usr/bin/env bash
# git-summary.sh — Resumo enxuto do estado de um repo git
# Uso: git-summary.sh [diretório] [--full]
#
# Sem flags: status + branch + últimos 5 commits
# --full: inclui diff stat + arquivos modificados detalhados

set -euo pipefail

DIR="${1:-.}"
FULL=0
[[ "${2:-}" == "--full" ]] && FULL=1

cd "$DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERRO: '$DIR' não é um repositório git" >&2
  exit 1
fi

BRANCH=$(git branch --show-current 2>/dev/null || echo "(detached)")
REMOTE=$(git remote get-url origin 2>/dev/null || echo "(sem remote)")
AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo "?")
BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo "?")

echo "=== Repositório ==="
echo "Branch:   $BRANCH"
echo "Remote:   $REMOTE"
echo "Ahead:    $AHEAD"
echo "Behind:   $BEHIND"
echo ""

echo "=== Status ==="
STATUS=$(git status --short 2>/dev/null)
if [[ -z "$STATUS" ]]; then
  echo "(working tree limpo)"
else
  echo "$STATUS"
fi
echo ""

echo "=== Últimos 5 commits ==="
git log --oneline -5 --decorate 2>/dev/null || echo "(sem histórico)"

if [[ "$FULL" -eq 1 ]]; then
  echo ""
  echo "=== Diff stat (não-committed) ==="
  git diff --stat 2>/dev/null || true
  echo ""
  echo "=== Diff stat (staged) ==="
  git diff --cached --stat 2>/dev/null || true
fi
