#!/usr/bin/env bash
set -euo pipefail

# Cloud images ship Node 22. Install the same LTS major used by CI.
case "$(uname -m)" in
  x86_64) architecture=x64 ;;
  aarch64) architecture=arm64 ;;
  *) echo 'Unsupported cloud architecture' >&2; exit 1 ;;
esac
node_archive="node-v24.22.0-linux-${architecture}.tar.xz"
download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
curl --fail --silent --show-error --location "https://nodejs.org/dist/v24.22.0/$node_archive" -o "$download_dir/$node_archive"
curl --fail --silent --show-error --location https://nodejs.org/dist/v24.22.0/SHASUMS256.txt -o "$download_dir/SHASUMS256.txt"
(
  cd "$download_dir"
  sha256sum --check --ignore-missing SHASUMS256.txt
)
mkdir -p /opt/spinetab-node
tar -xJf "$download_dir/$node_archive" --strip-components=1 -C /opt/spinetab-node
export PATH="/opt/spinetab-node/bin:$PATH"
npm install --global --allow-scripts=agent-browser pnpm@10.24.0 agent-browser@0.39.1
agent-browser --use-system-ca install --with-deps
node --version
pnpm --version
agent-browser --version
