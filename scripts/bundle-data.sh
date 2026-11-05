#!/usr/bin/env bash
# Packs the generated project data (seed SQL, drone tiles, demo accounts) into the encrypted
# bundle that the deployment workflow decrypts. Run after pipeline/build_seed.py or drone.py.
#   DATA_KEY=... scripts/bundle-data.sh            (or put the key in data/secrets/data_key)
# Decrypt:  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:DATA_KEY -in data/bundle.tar.gz.enc | tar xz
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${DATA_KEY:-}" ]; then DATA_KEY="$(cat data/secrets/data_key)"; fi
export DATA_KEY
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' -czf - \
  data/build/seed data/build/tiles data/secrets/demo_users.json \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 -pass env:DATA_KEY -out data/bundle.tar.gz.enc
ls -lh data/bundle.tar.gz.enc
