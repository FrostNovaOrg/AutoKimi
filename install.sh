#!/bin/sh
set -eu
umask 077

case "${1:-}" in
  --help|-h)
    echo 'Usage: sh install.sh [--source | --package archive.tar.gz] [--version v0.2.2] [--home directory] [--timeout-ms 90000]'
    echo 'Downloads a verified runtime release, or builds pinned sources. Installs Node privately if needed.'
    exit 0 ;;
esac
case "$(uname -s)" in
  Darwin) node_os=darwin ;;
  Linux) node_os=linux ;;
  *) echo 'AutoKimi supports macOS and Linux.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) node_arch=arm64 ;;
  x86_64|amd64) node_arch=x64 ;;
  *) echo 'AutoKimi supports ARM64 and x64.' >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo 'Install curl before running this installer.' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'Install tar before running this installer.' >&2; exit 1; }

install_home=${AUTOKIMI_HOME:-${KIMI_CODE_HOME:-"$HOME/.kimi-code"}}
expect_home=no
for install_arg in "$@"; do
  if [ "$expect_home" = yes ]; then install_home=$install_arg; expect_home=no; fi
  case "$install_arg" in --home) expect_home=yes ;; --home=*) install_home=${install_arg#--home=} ;; esac
done
case "$install_home" in /*) ;; *) install_home=$PWD/$install_home ;; esac
[ "$expect_home" = no ] || { echo '--home needs a directory.' >&2; exit 1; }
install_tmp=$(mktemp -d "${TMPDIR:-/tmp}/autokimi-bootstrap.XXXXXX")
trap 'rm -rf "$install_tmp"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=15)?0:1)' 2>/dev/null; then
  node_command=$(node -p 'process.execPath')
else
  node_version=24.15.0
  node_name=node-v$node_version-$node_os-$node_arch
  node_root=$install_home/autokimi/tools/$node_name
  if [ ! -x "$node_root/bin/node" ]; then
    echo "Installing Node $node_version in the AutoKimi tools directory."
    curl -fSL --retry 3 "https://nodejs.org/dist/v$node_version/$node_name.tar.gz" -o "$install_tmp/node.tar.gz"
    curl -fsSL --retry 3 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$install_tmp/SHASUMS256.txt"
    node_expected=$(awk -v name="$node_name.tar.gz" '$2 == name {print $1}' "$install_tmp/SHASUMS256.txt")
    if command -v sha256sum >/dev/null 2>&1; then node_actual=$(sha256sum "$install_tmp/node.tar.gz" | awk '{print $1}');
    elif command -v shasum >/dev/null 2>&1; then node_actual=$(shasum -a 256 "$install_tmp/node.tar.gz" | awk '{print $1}');
    else echo 'A SHA-256 tool (sha256sum or shasum) is required.' >&2; exit 1; fi
    [ -n "$node_expected" ] && [ "$node_expected" = "$node_actual" ] || { echo 'Node archive checksum mismatch.' >&2; exit 1; }
    tar -xzpf "$install_tmp/node.tar.gz" -C "$install_tmp"
    mkdir -p "$install_home/autokimi/tools"
    if [ ! -d "$node_root" ]; then mv "$install_tmp/$node_name" "$node_root"; fi
  fi
  node_command=$node_root/bin/node
fi
PATH=$(dirname "$node_command"):$PATH
export PATH

install_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || install_dir=''
if [ -n "$install_dir" ] && [ -f "$install_dir/tools/bootstrap.mjs" ] && [ "${0##*/}" = install.sh ]; then
  "$node_command" "$install_dir/tools/bootstrap.mjs" "$@"
else
  bootstrap_url=https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/main/tools/bootstrap.mjs
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    curl -fsSL --retry 3 -H "Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}" "$bootstrap_url" -o "$install_tmp/bootstrap.mjs"
  else curl -fsSL --retry 3 "$bootstrap_url" -o "$install_tmp/bootstrap.mjs"; fi
  "$node_command" "$install_tmp/bootstrap.mjs" "$@"
fi
