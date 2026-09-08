#!/bin/sh

set -eu

repository="${UIT_INSTALL_REPOSITORY:-RyanNg1403/uit-cli}"
release="${UIT_INSTALL_VERSION:-latest}"
mode="cli"

usage() {
  cat <<'EOF'
Install UIT CLI, UIT Studio for macOS, or both.

Usage:
  install.sh                 Install UIT CLI (default)
  install.sh --cli           Install UIT CLI
  install.sh --studio        Install UIT Studio for macOS
  install.sh --all           Install UIT CLI and UIT Studio
  install.sh --help          Show this help

Environment:
  UIT_INSTALL_VERSION        Release tag to install, for example v1.2.0
  UIT_INSTALL_REPOSITORY     GitHub repository, default RyanNg1403/uit-cli
EOF
}

fail() {
  printf 'UIT installer: %s\n' "$1" >&2
  exit 1
}

[ "$#" -le 1 ] || fail "expected exactly one of --cli, --studio, or --all."

case "${1:-}" in
  ""|--cli) mode="cli" ;;
  --studio) mode="studio" ;;
  --all) mode="all" ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; fail "unknown option: $1" ;;
esac

install_cli() {
  command -v node >/dev/null 2>&1 || fail "Node.js 20.19 or later is required to install UIT CLI."
  command -v npm >/dev/null 2>&1 || fail "npm is required to install UIT CLI."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)' \
    || fail "Node.js 20.19 or later is required to install UIT CLI."
  printf 'Installing UIT CLI and its MCP server from npm...\n'
  npm install --global uit-cli
}

install_studio() {
  [ "$(uname -s)" = "Darwin" ] || fail "UIT Studio currently supports macOS only."
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v shasum >/dev/null 2>&1 || fail "shasum is required."
  command -v ditto >/dev/null 2>&1 || fail "ditto is required."

  case "$(uname -m)" in
    arm64) architecture="arm64" ;;
    x86_64) architecture="x64" ;;
    *) fail "unsupported Mac architecture: $(uname -m)" ;;
  esac

  asset="UIT-Studio-macos-${architecture}.zip"
  if [ -n "${UIT_INSTALL_BASE_URL:-}" ]; then
    base_url="${UIT_INSTALL_BASE_URL%/}"
  elif [ "$release" = "latest" ]; then
    base_url="https://github.com/${repository}/releases/latest/download"
  else
    case "$release" in
      v[0-9]*) ;;
      *) fail "UIT_INSTALL_VERSION must be a release tag such as v1.2.0." ;;
    esac
    base_url="https://github.com/${repository}/releases/download/${release}"
  fi

  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/uit-studio.XXXXXX")"
  trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

  printf 'Downloading UIT Studio for macOS (%s)...\n' "$architecture"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$asset" "$base_url/$asset"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$asset.sha256" "$base_url/$asset.sha256"

  (
    cd "$temporary_directory"
    shasum --algorithm 256 --check "$asset.sha256"
  ) || fail "the downloaded UIT Studio archive failed checksum verification."

  ditto -x -k "$temporary_directory/$asset" "$temporary_directory/unpacked"
  source_application="$temporary_directory/unpacked/UIT Studio.app"
  [ -d "$source_application" ] || fail "the release archive does not contain UIT Studio.app."

  applications_directory="${UIT_INSTALL_APPLICATIONS_DIR:-$HOME/Applications}"
  target_application="$applications_directory/UIT Studio.app"
  backup_application="$temporary_directory/UIT Studio.previous.app"
  mkdir -p "$applications_directory"

  if [ -e "$target_application" ]; then
    mv "$target_application" "$backup_application"
  fi
  if ! ditto "$source_application" "$target_application"; then
    rm -rf "$target_application"
    if [ -e "$backup_application" ]; then
      mv "$backup_application" "$target_application"
    fi
    fail "UIT Studio could not be installed. The previous installation was restored."
  fi

  printf '\nUIT Studio was installed at %s\n' "$target_application"
  printf 'This free build is unsigned. If macOS blocks the first launch, use Open Anyway in System Settings > Privacy & Security.\n'
}

case "$mode" in
  cli) install_cli ;;
  studio) install_studio ;;
  all) install_cli; install_studio ;;
esac
