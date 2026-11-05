#!/usr/bin/env bash
# Decrypts data/bundle.tar.gz.enc with the DATA_KEY secret (used by the deploy workflow).
#   scripts/ci/decrypt-data.sh [paths inside the bundle…]   (default: everything)
# The key is checked against a fingerprint (a short SHA-256 prefix, which reveals nothing about it)
# so a wrong secret gives a clear message. Never prints the key.
set -euo pipefail
EXPECTED_FP=68c7e5c39ab34a41
raw="${DATA_KEY:-}"
if [ -z "$raw" ]; then echo "::error::DATA_KEY is empty."; exit 1; fi
# tolerate a pasted line break, spaces, quotes or backticks, or the key embedded in other text
key="$(printf '%s' "$raw" | tr -d '[:space:]"`'"'")"
fp() { printf '%s' "$1" | sha256sum | cut -c1-16; }
if [ "$(fp "$key")" != "$EXPECTED_FP" ]; then
  found="$(printf '%s' "$raw" | grep -oE '[A-Za-z0-9+/]{43}=' | sort -u || true)"
  if [ -n "$found" ] && [ "$(printf '%s\n' "$found" | wc -l)" -eq 1 ] && [ "$(fp "$found")" = "$EXPECTED_FP" ]; then
    echo "::warning::DATA_KEY holds other text besides the key; using the key found in it. Consider saving only the key."
    key="$found"
  else
    echo "::error::DATA_KEY does not match the key the project data was encrypted with (the secret has ${#raw} characters; the key has 44, ends with = and has no spaces). Set it to the DATA_KEY value from the setup steps."
    exit 1
  fi
fi
[ "$key" = "$raw" ] || echo "::warning::DATA_KEY had spaces, a line break or quotes around it; they were ignored."
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
DATA_KEY="$key" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:DATA_KEY -in data/bundle.tar.gz.enc -out "$tmp"
tar xzf "$tmp" "$@"
echo "project data decrypted"
