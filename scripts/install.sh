#!/bin/sh

set -eu

# This bootstrap script intentionally requires a POSIX shell. Windows users
# should use scripts/install.ps1 for the native Studio package.
repository="${UIT_INSTALL_REPOSITORY:-RyanNg1403/uit-cli}"
release="${UIT_INSTALL_VERSION:-latest}"
mode="cli"

usage() {
  cat <<'EOF'
Install UIT CLI, UIT Studio, or both from release assets.

This curl installer is POSIX-only. Windows users should use the PowerShell
installer at scripts/install.ps1 on Windows.

Usage:
  install.sh                 Install UIT CLI (default)
  install.sh --cli           Install UIT CLI
  install.sh --studio        Install the native web Studio for macOS or Linux
  install.sh --all           Install UIT CLI and UIT Studio
  install.sh --help          Show this help

Environment:
  UIT_INSTALL_VERSION        Release tag to install, for example v1.2.0
  UIT_INSTALL_REPOSITORY     GitHub repository, default RyanNg1403/uit-cli
  UIT_INSTALL_BASE_URL       Override the release asset base URL (useful for mirrors/tests)
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

host_system="$(uname -s 2>/dev/null || printf 'unknown')"
case "$host_system" in
  MINGW*|MSYS*|CYGWIN*) fail "the curl installer requires a POSIX macOS/Linux shell; use npm on Windows." ;;
esac

release_base_url() {
  if [ -n "${UIT_INSTALL_BASE_URL:-}" ]; then
    printf '%s\n' "${UIT_INSTALL_BASE_URL%/}"
  elif [ "$release" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download\n' "$repository"
  else
    case "$release" in
      v[0-9]*) ;;
      *) fail "UIT_INSTALL_VERSION must be a release tag such as v1.2.0." ;;
    esac
    printf 'https://github.com/%s/releases/download/%s\n' "$repository" "$release"
  fi
}

install_standalone_cli() (
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v tar >/dev/null 2>&1 || fail "tar is required."

  system="$(uname -s)"
  machine="$(uname -m)"
  case "$system" in
    Darwin)
      platform="macos"
      platform_label="macOS"
      case "$machine" in
        arm64) architecture="arm64" ;;
        *) fail "unsupported Mac architecture: $machine" ;;
      esac
      ;;
    Linux)
      platform="linux"
      platform_label="Linux"
      case "$machine" in
        x86_64|amd64) architecture="x64" ;;
        arm64|aarch64) architecture="arm64" ;;
        *) fail "unsupported Linux architecture: $machine" ;;
      esac
      ;;
    *) fail "unsupported operating system: $system" ;;
  esac

  if command -v sha256sum >/dev/null 2>&1; then
    verify_checksum() { sha256sum --check "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    verify_checksum() { shasum --algorithm 256 --check "$1"; }
  else
    fail "sha256sum or shasum is required."
  fi

  asset="UIT-CLI-${platform}-${architecture}.tar.gz"
  base_url="$(release_base_url)"
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/uit-cli.XXXXXX")"
  replacement_directory=""
  target_directory="${UIT_INSTALL_CLI_DIR:-$HOME/.uit/cli}"
  backup_directory=""
  replacement_started=0
  cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$replacement_started" -eq 1 ]; then
      rm -rf "$target_directory"
      if [ -n "$backup_directory" ] && [ -e "$backup_directory" ]; then
        mv "$backup_directory" "$target_directory" || :
      fi
    fi
    [ -z "$replacement_directory" ] || rm -rf "$replacement_directory"
    rm -rf "$temporary_directory"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf 'Downloading standalone UIT CLI for %s (%s)...\n' "$platform_label" "$architecture"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$asset" "$base_url/$asset"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$asset.sha256" "$base_url/$asset.sha256"
  (
    cd "$temporary_directory"
    verify_checksum "$asset.sha256"
  ) || fail "the downloaded UIT CLI archive failed checksum verification."

  tar -xzf "$temporary_directory/$asset" -C "$temporary_directory"
  source_directory="$temporary_directory/uit-cli"
  [ -x "$source_directory/bin/uit" ] || fail "the release archive does not contain UIT CLI."
  [ -x "$source_directory/bin/node" ] || fail "the release archive does not contain the UIT CLI runtime."

  binary_directory="${UIT_INSTALL_BIN_DIR:-$HOME/.local/bin}"
  launcher="$binary_directory/uit"
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if [ ! -L "$launcher" ] || [ "$(readlink "$launcher")" != "$target_directory/bin/uit" ]; then
      fail "$launcher already exists and is not managed by the UIT installer."
    fi
  fi

  target_parent="$(dirname "$target_directory")"
  mkdir -p "$target_parent" "$binary_directory"
  replacement_directory="$(mktemp -d "$target_parent/.uit-cli-install.XXXXXX")"
  staged_directory="$replacement_directory/current"
  backup_directory="$replacement_directory/previous"
  mv "$source_directory" "$staged_directory"

  if [ -e "$target_directory" ]; then
    replacement_started=1
    mv "$target_directory" "$backup_directory"
  fi
  if ! mv "$staged_directory" "$target_directory"; then
    fail "UIT CLI could not be installed. The previous installation was restored."
  fi
  replacement_started=1

  temporary_launcher="$binary_directory/.uit-launcher.$$"
  rm -f "$temporary_launcher"
  ln -s "$target_directory/bin/uit" "$temporary_launcher"
  if ! mv -f "$temporary_launcher" "$launcher"; then
    rm -f "$temporary_launcher"
    fail "UIT CLI launcher could not be installed. The previous installation was restored."
  fi

  replacement_started=0
  rm -rf "$replacement_directory"
  replacement_directory=""
  trap - EXIT HUP INT TERM
  rm -rf "$temporary_directory"

  printf '\nUIT CLI was installed at %s\n' "$launcher"
  case ":$PATH:" in
    *":$binary_directory:"*) ;;
    *) printf 'Add %s to your PATH to run uit from any terminal.\n' "$binary_directory" ;;
  esac
)

install_cli() {
  case "$(uname -s)" in
    Darwin|Linux)
    install_standalone_cli
    ;;
    *) fail "UIT CLI standalone releases are available for macOS and Linux; use npm on Windows." ;;
  esac
}

install_posix_studio() (
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v tar >/dev/null 2>&1 || fail "tar is required."
  case "$(uname -m)" in
    arm64)
      [ "$(uname -s)" = "Darwin" ] || fail "unsupported Linux architecture for UIT Studio: arm64"; platform="macos"; platform_label="macOS"; architecture="arm64" ;;
    x86_64|amd64)
      [ "$(uname -s)" = "Linux" ] || fail "unsupported Mac architecture for UIT Studio: $(uname -m)"; platform="linux"; platform_label="Linux"; architecture="x64" ;;
    aarch64)
      [ "$(uname -s)" = "Linux" ] || fail "unsupported architecture for UIT Studio: $(uname -m)"; platform="linux"; platform_label="Linux"; architecture="arm64" ;;
    *) fail "unsupported architecture for UIT Studio: $(uname -m)" ;;
  esac
  if command -v sha256sum >/dev/null 2>&1; then
    verify_checksum() { sha256sum --check "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    verify_checksum() { shasum --algorithm 256 --check "$1"; }
  else
    fail "sha256sum or shasum is required."
  fi

  asset="UIT-Studio-web-${platform}-${architecture}.tar.gz"
  base_url="$(release_base_url)"
  studio_directory="${UIT_INSTALL_STUDIO_DIR:-$HOME/.uit/studio/app}"
  binary_directory="${UIT_INSTALL_BIN_DIR:-$HOME/.local/bin}"
  launcher="$binary_directory/uit-studio"
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/uit-studio.XXXXXX")"
  replacement_directory=""
  target_directory="$studio_directory"
  backup_directory=""
  replacement_started=0
  temporary_launcher=""
  cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$replacement_started" -eq 1 ]; then
      rm -rf "$target_directory"
      if [ -n "$backup_directory" ] && [ -e "$backup_directory" ]; then
        mv "$backup_directory" "$target_directory" || :
      fi
    fi
    [ -z "$replacement_directory" ] || rm -rf "$replacement_directory"
    [ -z "$temporary_launcher" ] || rm -f "$temporary_launcher"
    rm -rf "$temporary_directory"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if [ ! -L "$launcher" ] || [ "$(readlink "$launcher")" != "$target_directory/bin/uit-studio" ]; then
      fail "$launcher already exists and is not managed by the UIT installer."
    fi
  fi

  target_parent="$(dirname "$target_directory")"
  mkdir -p "$target_parent" "$binary_directory"
  replacement_directory="$(mktemp -d "$target_parent/.uit-studio-install.XXXXXX")"

  printf 'Downloading UIT Studio for %s (%s)...\n' "$platform_label" "$architecture"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$asset" "$base_url/$asset"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$asset.sha256" "$base_url/$asset.sha256"
  (
    cd "$temporary_directory"
    verify_checksum "$asset.sha256"
  ) || fail "the downloaded UIT Studio archive failed checksum verification."

  while IFS= read -r archive_entry; do
    case "$archive_entry" in
      uit-studio|uit-studio/*) ;;
      *) fail "the downloaded UIT Studio archive contains an unsafe path." ;;
    esac
  done <<EOF
$(tar -tzf "$temporary_directory/$asset")
EOF
  tar -xzf "$temporary_directory/$asset" -C "$replacement_directory"
  source_directory="$replacement_directory/uit-studio"
  [ -x "$source_directory/bin/uit-studio" ] || fail "the release archive does not contain the native UIT Studio launcher."
  [ -x "$source_directory/bin/node" ] || fail "the release archive does not contain the bundled Node.js runtime."

  backup_directory="$replacement_directory/previous"
  if [ -e "$target_directory" ]; then
    replacement_started=1
    mv "$target_directory" "$backup_directory"
  fi
  if ! mv "$source_directory" "$target_directory"; then
    fail "UIT Studio could not be installed. The previous installation was restored."
  fi
  replacement_started=1

  temporary_launcher="$binary_directory/.uit-studio-launcher.$$"
  rm -f "$temporary_launcher"
  ln -s "$target_directory/bin/uit-studio" "$temporary_launcher"
  if ! mv -f "$temporary_launcher" "$launcher"; then
    temporary_launcher=""
    fail "UIT Studio launcher could not be installed. The previous installation was restored."
  fi
  temporary_launcher=""
  replacement_started=0
  rm -rf "$replacement_directory"
  replacement_directory=""

  printf '\nUIT Studio was installed at %s\n' "$launcher"
  printf 'This command starts the local web Studio in your default browser.\n'
  case ":$PATH:" in
    *":$binary_directory:"*) ;;
    *) printf 'Add %s to your PATH to run uit-studio from any terminal.\n' "$binary_directory" ;;
  esac
)

install_studio() {
  case "$(uname -s)" in
    Darwin|Linux) install_posix_studio ;;
    *) fail "Use scripts/install.ps1 -Studio for the native Windows Studio package." ;;
  esac
}

case "$mode" in
  cli) install_cli ;;
  studio) install_studio ;;
  all) install_cli; install_studio ;;
esac
