#!/bin/sh
set -eu
umask 077

case "${1:-}" in
  --help|-h)
    echo 'Usage: sh install.sh [--source | --package archive.tar.gz] [--revision full-commit --version v0.3.1] [--home directory] [--timeout-ms 90000]'
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
expect_revision=no
install_revision=''
install_package=no
expect_home=no
for install_arg in "$@"; do
  if [ "$expect_revision" = yes ]; then install_revision=$install_arg; expect_revision=no; fi
  case "$install_arg" in --package|--package=*) install_package=yes ;; esac
  case "$install_arg" in --revision) expect_revision=yes ;; --revision=*) install_revision=${install_arg#--revision=} ;; esac
  if [ "$expect_home" = yes ]; then install_home=$install_arg; expect_home=no; fi
  case "$install_arg" in --home) expect_home=yes ;; --home=*) install_home=${install_arg#--home=} ;; esac
done
case "$install_home" in /*) ;; *) install_home=$PWD/$install_home ;; esac
[ "$expect_home" = no ] || { echo '--home needs a directory.' >&2; exit 1; }
[ "$expect_revision" = no ] || { echo '--revision needs a full commit.' >&2; exit 1; }
install_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || install_dir=''
install_local=no
if [ -n "$install_dir" ] && [ -f "$install_dir/tools/bootstrap.mjs" ] && [ "${0##*/}" = install.sh ]; then install_local=yes; fi
if [ -n "$install_revision" ] || [ "$install_local" = no ]; then
  case "$install_revision" in ''|*[!a-f0-9]*) echo 'Use --revision with a trusted 40-character commit.' >&2; exit 1 ;; esac
  [ "${#install_revision}" = 40 ] || { echo 'Use a full source revision.' >&2; exit 1; }
fi

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
    case "$node_os-$node_arch" in
      darwin-arm64) node_expected=372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4 ;;
      darwin-x64) node_expected=ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b ;;
      linux-arm64) node_expected=73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed ;;
      linux-x64) node_expected=44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89 ;;
    esac
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

if [ "$install_local" = yes ]; then
  if [ -z "$install_revision" ] && [ "$install_package" = no ]; then
    [ -e "$install_dir/.git" ] || { echo 'A source archive needs --revision with a trusted full commit.' >&2; exit 1; }
    install_revision=$(git -C "$install_dir" rev-parse HEAD 2>/dev/null) || { echo 'Use --revision with a trusted full commit.' >&2; exit 1; }
  fi
  if [ -n "$install_revision" ]; then AUTOKIMI_SOURCE_REVISION=$install_revision; export AUTOKIMI_SOURCE_REVISION; fi
  "$node_command" "$install_dir/tools/bootstrap.mjs" "$@"
else
  case "$install_revision" in ''|*[!a-f0-9]*) echo 'Use --revision with a trusted 40-character commit.' >&2; exit 1 ;; esac
  [ "${#install_revision}" = 40 ] || { echo 'Use a full source revision.' >&2; exit 1; }
  AUTOKIMI_SOURCE_REVISION=$install_revision; export AUTOKIMI_SOURCE_REVISION
  bootstrap_url=https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/$install_revision/tools/bootstrap.mjs
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    curl -fsSL --retry 3 -H "Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}" "$bootstrap_url" -o "$install_tmp/bootstrap.mjs"
  else curl -fsSL --retry 3 "$bootstrap_url" -o "$install_tmp/bootstrap.mjs"; fi
  bootstrap_expected=6c5af653d29f8a56774e4fb33c3581ed8184962df411830e3b50131f053bcfd0
  if command -v sha256sum >/dev/null 2>&1; then bootstrap_actual=$(sha256sum "$install_tmp/bootstrap.mjs" | awk '{print $1}');
  elif command -v shasum >/dev/null 2>&1; then bootstrap_actual=$(shasum -a 256 "$install_tmp/bootstrap.mjs" | awk '{print $1}');
  else echo 'A SHA-256 tool is required.' >&2; exit 1; fi
  [ "$bootstrap_expected" = "$bootstrap_actual" ] || { echo 'Bootstrap checksum mismatch.' >&2; exit 1; }
  "$node_command" "$install_tmp/bootstrap.mjs" "$@"
fi
