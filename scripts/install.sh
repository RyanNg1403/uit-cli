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

install_cli_with_npm() {
  command -v node >/dev/null 2>&1 || fail "Node.js 20.19 or later is required to install UIT CLI."
  command -v npm >/dev/null 2>&1 || fail "npm is required to install UIT CLI."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)' \
    || fail "Node.js 20.19 or later is required to install UIT CLI."
  if [ "$release" = "latest" ]; then
    package="uit-cli"
  else
    case "$release" in
      v[0-9]*) package="uit-cli@${release#v}" ;;
      *) fail "UIT_INSTALL_VERSION must be a release tag such as v1.2.0." ;;
    esac
  fi
  printf 'Installing UIT CLI and its MCP server from npm...\n'
  npm install --global "$package"
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
  target_directory="${UIT_INSTALL_CLI_DIR:-$HOME/.local/share/uit-cli}"
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
    *) install_cli_with_npm ;;
  esac
}

install_studio() {
  [ "$(uname -s)" = "Darwin" ] || fail "UIT Studio currently supports macOS only."
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v shasum >/dev/null 2>&1 || fail "shasum is required."
  command -v ditto >/dev/null 2>&1 || fail "ditto is required."

  case "$(uname -m)" in
    arm64) architecture="arm64" ;;
    *) fail "unsupported Mac architecture: $(uname -m)" ;;
  esac

  asset="UIT-Studio-macos-${architecture}.zip"
  base_url="$(release_base_url)"

  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/uit-studio.XXXXXX")"
  replacement_directory=""
  target_application=""
  backup_application=""
  replacement_started=0
  cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$replacement_started" -eq 1 ] && [ -n "$backup_application" ] && [ -e "$backup_application" ]; then
      [ -z "$target_application" ] || rm -rf "$target_application"
      mv "$backup_application" "$target_application" || :
    fi
    [ -z "$replacement_directory" ] || rm -rf "$replacement_directory"
    rm -rf "$temporary_directory"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

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
  mkdir -p "$applications_directory"
  replacement_directory="$(mktemp -d "$applications_directory/.uit-studio-install.XXXXXX")"
  staged_application="$replacement_directory/UIT Studio.app"
  backup_application="$replacement_directory/UIT Studio.previous.app"

  # Complete the potentially slow copy before touching an existing install.
  ditto "$source_application" "$staged_application" \
    || fail "UIT Studio could not be staged. The previous installation was not changed."

  if [ -e "$target_application" ]; then
    replacement_started=1
    mv "$target_application" "$backup_application"
  fi
  if ! mv "$staged_application" "$target_application"; then
    fail "UIT Studio could not be installed. The previous installation was restored."
  fi
  replacement_started=0

  printf '\nUIT Studio was installed at %s\n' "$target_application"
  printf 'This free build is unsigned. If macOS blocks the first launch, use Open Anyway in System Settings > Privacy & Security.\n'
}

case "$mode" in
  cli) install_cli ;;
  studio) install_studio ;;
  all) install_cli; install_studio ;;
esac
