#!/bin/sh

set -eu

platform="${1:-}"
architecture="${2:-}"
output_directory="${3:-release-assets}"

case "$platform" in
  macos)
    expected_system="Darwin"
    case "$architecture" in
      arm64) ;;
      *) printf 'Unsupported macOS architecture: %s\n' "$architecture" >&2; exit 1 ;;
    esac
    ;;
  linux)
    expected_system="Linux"
    case "$architecture" in
      arm64|x64) ;;
      *) printf 'Unsupported Linux architecture: %s\n' "$architecture" >&2; exit 1 ;;
    esac
    ;;
  *) printf 'Unsupported standalone platform: %s\n' "$platform" >&2; exit 1 ;;
esac

actual_system="$(uname -s)"
actual_architecture="$(node -p 'process.arch')"
[ "$actual_system" = "$expected_system" ] || {
  printf 'Expected %s, running on %s.\n' "$expected_system" "$actual_system" >&2
  exit 1
}
[ "$actual_architecture" = "$architecture" ] || {
  printf 'Expected %s, running on %s.\n' "$architecture" "$actual_architecture" >&2
  exit 1
}

repository_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
output_directory="$(mkdir -p "$output_directory" && CDPATH= cd -- "$output_directory" && pwd)"
version="$(node -p "require('$repository_root/package.json').version")"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/uit-cli-package.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

bundle="$temporary_directory/uit-cli"
mkdir -p "$bundle/app" "$bundle/bin"
cp "$repository_root/package.json" "$repository_root/package-lock.json" "$bundle/app/"

(
  cd "$bundle/app"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --omit=optional --ignore-scripts
)

cp -R "$repository_root/dist" "$bundle/app/dist"
cp "$(node -p 'process.execPath')" "$bundle/bin/node"
chmod 755 "$bundle/bin/node"
printf '%s\n' "$version" > "$bundle/VERSION"

cat > "$bundle/bin/uit" <<'EOF'
#!/bin/sh

set -eu

invoked_path="$0"
case "$invoked_path" in
  /*) ;;
  *) invoked_path="$(pwd)/$invoked_path" ;;
esac
export UIT_CLI_EXECUTABLE="$invoked_path"
script_path="$invoked_path"
while [ -L "$script_path" ]; do
  link_target="$(readlink "$script_path")"
  case "$link_target" in
    /*) script_path="$link_target" ;;
    *) script_path="$(dirname "$script_path")/$link_target" ;;
  esac
done

bundle_root="$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd)"
exec "$bundle_root/bin/node" "$bundle_root/app/dist/cli.js" "$@"
EOF
chmod 755 "$bundle/bin/uit"

"$bundle/bin/uit" --help >/dev/null
if find "$bundle/app/node_modules" -type d -name .local-browsers -print -quit | grep -q .; then
  printf 'The standalone bundle unexpectedly contains a Playwright browser.\n' >&2
  exit 1
fi

asset="UIT-CLI-${platform}-${architecture}.tar.gz"
tar -C "$temporary_directory" -czf "$output_directory/$asset" uit-cli
(
  cd "$output_directory"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$asset" > "$asset.sha256"
  else
    shasum -a 256 "$asset" > "$asset.sha256"
  fi
)

printf 'Created %s\n' "$output_directory/$asset"
