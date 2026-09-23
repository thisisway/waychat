#!/usr/bin/env bash
# dep-check.sh — Inspeção rápida de dependências do projeto
# Uso: dep-check.sh [diretório] [--outdated] [--audit]
#
# Detecta automaticamente o gerenciador (npm/pnpm/yarn/bun/pip/cargo)

set -euo pipefail

DIR="${1:-.}"
OUTDATED=0
AUDIT=0

shift 1 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --outdated) OUTDATED=1; shift ;;
    --audit)    AUDIT=1; shift ;;
    *) shift ;;
  esac
done

cd "$DIR"

detect_manager() {
  if [[ -f "bun.lockb" || -f "bun.lock" ]]; then echo "bun"
  elif [[ -f "pnpm-lock.yaml" ]]; then echo "pnpm"
  elif [[ -f "yarn.lock" ]]; then echo "yarn"
  elif [[ -f "package-lock.json" || -f "package.json" ]]; then echo "npm"
  elif [[ -f "requirements.txt" || -f "pyproject.toml" ]]; then echo "pip"
  elif [[ -f "Cargo.toml" ]]; then echo "cargo"
  else echo "unknown"
  fi
}

MGR=$(detect_manager)
echo "=== Gerenciador detectado: $MGR ==="
echo ""

case "$MGR" in
  npm|pnpm|yarn|bun)
    if [[ -f "package.json" ]]; then
      echo "=== Resumo package.json ==="
      python3 -c "
import json
p = json.load(open('package.json'))
print(f\"Nome:    {p.get('name','?')}\")
print(f\"Versão:  {p.get('version','?')}\")
print(f\"Deps:    {len(p.get('dependencies',{}))} produção, {len(p.get('devDependencies',{}))} dev\")
print()
print('Scripts disponíveis:')
for k,v in (p.get('scripts') or {}).items():
    print(f'  {k}: {v[:80]}')
"
    fi
    [[ "$OUTDATED" -eq 1 ]] && { echo ""; echo "=== Outdated ==="; "$MGR" outdated 2>/dev/null || true; }
    [[ "$AUDIT"    -eq 1 ]] && { echo ""; echo "=== Audit ===";    "$MGR" audit 2>/dev/null || true; }
    ;;
  pip)
    if [[ -f "pyproject.toml" ]]; then
      echo "=== pyproject.toml ==="
      grep -E "^(name|version|dependencies)" pyproject.toml | head -20
    elif [[ -f "requirements.txt" ]]; then
      echo "=== requirements.txt (top 30) ==="
      head -30 requirements.txt
      echo ""
      echo "Total: $(wc -l < requirements.txt) deps"
    fi
    [[ "$OUTDATED" -eq 1 ]] && { echo ""; pip list --outdated 2>/dev/null || true; }
    ;;
  cargo)
    echo "=== Cargo.toml ==="
    grep -E "^(name|version|\[dependencies\])" Cargo.toml | head -20
    [[ "$OUTDATED" -eq 1 ]] && { echo ""; cargo outdated 2>/dev/null || true; }
    ;;
  *)
    echo "Gerenciador não identificado em $DIR"
    exit 1 ;;
esac
