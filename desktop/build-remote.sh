#!/usr/bin/env bash
# Builds the Windows .exe on GitHub Actions from a Mac, with the Supabase keys baked in, and
# leaves the decrypted result at desktop/dist/IMECO Price Tracker.exe.
#
#   ./desktop/build-remote.sh            build, download, decrypt
#   ./desktop/build-remote.sh --setup    first time only: copy keys from ../.env into repo secrets
#
# See .github/workflows/build-exe.yml for why the artifact is encrypted. Nothing secret is
# printed, committed or passed on a command line: values travel via stdin and env only.
set -euo pipefail
cd "$(dirname "$0")/.."

val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//"; }

if [[ "${1:-}" == "--setup" ]]; then
  if [[ -z "$(val EXE_ARCHIVE_PASSWORD)" ]]; then
    printf '\n# Decrypts the .exe from .github/workflows/build-exe.yml (also a repo secret). Never commit.\nEXE_ARCHIVE_PASSWORD=%s\n' \
      "$(openssl rand -base64 33 | tr -d '\n/+=')" >> .env
  fi
  for name in SUPABASE_URL SUPABASE_SERVICE_KEY EXE_ARCHIVE_PASSWORD; do
    [[ -n "$(val "$name")" ]] || { echo "$name missing from .env" >&2; exit 1; }
    val "$name" | gh secret set "$name"
  done
  gh secret list
  exit 0
fi

EXE_ARCHIVE_PASSWORD="$(val EXE_ARCHIVE_PASSWORD)"
export EXE_ARCHIVE_PASSWORD
[[ -n "$EXE_ARCHIVE_PASSWORD" ]] || { echo "run with --setup first" >&2; exit 1; }

gh workflow run build-exe.yml
sleep 5
run_id="$(gh run list --workflow build-exe.yml -L 1 --json databaseId -q '.[0].databaseId')"
echo "Building in run $run_id..."
gh run watch "$run_id" --exit-status

out="desktop/dist"
tmp="$(mktemp -d)"
gh run download "$run_id" -n IMECO-Price-Tracker-exe-encrypted -D "$tmp"
mkdir -p "$out"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:EXE_ARCHIVE_PASSWORD \
  -in "$tmp/IMECO Price Tracker.exe.enc" -out "$out/IMECO Price Tracker.exe"
rm -rf "$tmp"
ls -la "$out/IMECO Price Tracker.exe"
