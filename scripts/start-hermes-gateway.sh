#!/usr/bin/env bash
set -euo pipefail

if ! command -v hermes >/dev/null 2>&1; then
  echo "hermes command not found. Install Hermes first."
  exit 1
fi

hermes gateway
