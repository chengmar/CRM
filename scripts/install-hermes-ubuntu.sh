#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y git curl xz-utils ca-certificates build-essential unzip

curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/bin:$PATH"

hermes --version || true
echo "Next:"
echo "  1. run 'hermes setup'"
echo "  2. run 'hermes model' and verify a normal chat works"
echo "  3. run 'hermes gateway setup' and choose Feishu / Lark WebSocket"
