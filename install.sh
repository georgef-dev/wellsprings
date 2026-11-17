#!/usr/bin/env bash
# Wellsprings quick installer.
# Fetches the latest published release from GitHub and installs it locally:
#   Linux:   AppImage -> ~/.local/bin, plus a launcher entry and icon
#   macOS:   .app -> ~/Applications
# Usage:   curl -fsSL https://raw.githubusercontent.com/georgef-dev/wellsprings/main/install.sh | bash
set -euo pipefail

REPO="georgef-dev/wellsprings"

info() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v find >/dev/null 2>&1 || fail "find is required"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Draft releases are invisible to this endpoint, so a 404 usually means
# the latest build is still an unpublished draft.
info "Looking up the latest Wellsprings release..."
json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
if [ -z "$json" ]; then
  fail "Could not fetch release info from GitHub. Is there a published (not draft) release? See https://github.com/$REPO/releases"
fi

case "$(uname -s)" in
  Linux)
    case "$(uname -m)" in
      x86_64) arch="amd64" ;;
      *) fail "No Linux build for $(uname -m) yet. See https://github.com/$REPO/releases" ;;
    esac

    urls="$(printf '%s' "$json" | grep -oE 'https://[^"]+\.AppImage' | grep "_${arch}\.AppImage$" || true)"
    if [ -z "$urls" ]; then
      fail "No AppImage asset found for $arch. See https://github.com/$REPO/releases"
    fi
    url="${urls%%$'\n'*}"
    version="$(printf '%s' "$url" | sed -E 's|.*/wellsprings_([0-9.]+)_.*|\1|')"
    if [ "$version" = "$url" ]; then
      version=""
    fi

    bin_dir="$HOME/.local/bin"
    bin_path="$bin_dir/wellsprings.AppImage"
    mkdir -p "$bin_dir"
    info "Downloading Wellsprings${version:+ $version} for Linux ($arch)..."
    curl -fsSL -o "$tmpdir/wellsprings.AppImage" "$url"
    mv "$tmpdir/wellsprings.AppImage" "$bin_path"
    chmod +x "$bin_path"

    # Launcher entry and icon; both are nice-to-have, never fatal.
    icon_path="$HOME/.local/share/icons/hicolor/scalable/apps/wellsprings.svg"
    if [ -n "$version" ] && curl -fsSL -o "$tmpdir/icon.svg" \
        "https://raw.githubusercontent.com/$REPO/v$version/design/icon.svg" 2>/dev/null; then
      mkdir -p "$(dirname "$icon_path")" "$HOME/.local/share/applications"
      mv "$tmpdir/icon.svg" "$icon_path"
      cat > "$HOME/.local/share/applications/wellsprings.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Wellsprings
Comment=Keyboard-driven RSS reader
Exec=$bin_path
Icon=wellsprings
Terminal=false
Categories=Network;News;
EOF
      command -v update-desktop-database >/dev/null 2>&1 && \
        update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    fi

    if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
      info "AppImages need FUSE to run. Debian/Ubuntu: sudo apt install libfuse2. Arch: sudo pacman -S fuse2."
    fi

    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *) info "Note: $bin_dir is not in your PATH. Add it to your shell profile." ;;
    esac

    info "Installed. Launch Wellsprings from your app launcher, or run: $bin_path"
    ;;

  Darwin)
    case "$(uname -m)" in
      arm64) arch="aarch64" ;;
      x86_64) arch="x64" ;;
      *) fail "No macOS build for $(uname -m) yet. See https://github.com/$REPO/releases" ;;
    esac

    urls="$(printf '%s' "$json" | grep -oE 'https://[^"]+\.dmg' | grep "_${arch}\.dmg$" || true)"
    if [ -z "$urls" ]; then
      fail "No dmg asset found for $arch. See https://github.com/$REPO/releases"
    fi
    url="${urls%%$'\n'*}"

    info "Downloading Wellsprings for macOS ($arch)..."
    curl -fsSL -o "$tmpdir/wellsprings.dmg" "$url"
    mount="$(hdiutil attach -nobrowse "$tmpdir/wellsprings.dmg" | grep '/Volumes/' | tail -n1 | sed $'s/.*\t//' || true)"
    if [ -z "$mount" ]; then
      fail "Could not mount the disk image."
    fi

    apps="$(find "$mount" -maxdepth 1 -name '*.app')"
    if [ -z "$apps" ]; then
      hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
      fail "No .app found in the disk image."
    fi
    app_path="${apps%%$'\n'*}"

    mkdir -p "$HOME/Applications"
    info "Installing ${app_path##*/} to ~/Applications..."
    ditto "$app_path" "$HOME/Applications/${app_path##*/}"
    hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true

    info "Installed. If macOS blocks the first launch, approve it under System Settings > Privacy & Security > Open Anyway."
    ;;

  *)
    fail "Unsupported OS: $(uname -s). See https://github.com/$REPO/releases"
    ;;
esac
