#!/bin/zsh
# Builds GlassNotch.app with SwiftPM. Uses Xcode's toolchain when Xcode is installed, otherwise the
# Command Line Tools.
#   ./build.sh            build into ./build.noindex/GlassNotch.app (this Mac's architecture;
#                         ".noindex" keeps Spotlight from listing a second GlassNotch)
#   ./build.sh install    build, copy to /Applications (or ~/Applications) and relaunch
#
# Environment:
#   UNIVERSAL=1           build for Apple silicon and Intel
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"
#                         sign for distribution (hardened runtime, timestamp); default is ad-hoc
set -euo pipefail
cd "${0:A:h}"

if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

APP_NAME=GlassNotch
APP="build.noindex/$APP_NAME.app"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" Resources/Info.plist)

if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  ARCH_FLAGS=(--arch arm64 --arch x86_64)
else
  ARCH_FLAGS=(--arch "$(uname -m)")
fi

swift build -c release "${ARCH_FLAGS[@]}"
BIN_DIR="$(swift build -c release "${ARCH_FLAGS[@]}" --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN_DIR/$APP_NAME" "$APP/Contents/MacOS/$APP_NAME"
cp Resources/Info.plist "$APP/Contents/Info.plist"
if [[ -f Resources/AppIcon.icns ]]; then
  cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
fi
cp Vendor/mediaremote-adapter/mediaremote-adapter.pl "$APP/Contents/Resources/"
cp Vendor/mediaremote-adapter/LICENSE "$APP/Contents/Resources/MediaRemoteAdapter-LICENSE.txt"
ditto Vendor/mediaremote-adapter/MediaRemoteAdapter.framework "$APP/Contents/Frameworks/MediaRemoteAdapter.framework"

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  # Distribution signature: nested code first, hardened runtime, secure timestamp.
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
    "$APP/Contents/Frameworks/MediaRemoteAdapter.framework"
  codesign --force --options runtime --timestamp --entitlements Resources/GlassNotch.entitlements \
    --sign "$SIGN_IDENTITY" "$APP"
else
  # Ad-hoc signature (runs locally; other Macs need "Open Anyway" once). The designated
  # requirement names the bundle ID instead of the binary's hash, so privacy permissions
  # (Screen Recording, Desktop folder) survive rebuilds and updates.
  codesign --force --sign - "$APP/Contents/Frameworks/MediaRemoteAdapter.framework"
  codesign --force --sign - --requirements "=designated => identifier \"$BUNDLE_ID\"" "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "Built $APP ($(lipo -archs "$APP/Contents/MacOS/$APP_NAME"))"

if [[ "${1:-}" == "install" ]]; then
  DEST=/Applications
  [[ -w "$DEST" ]] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 0.5
  rm -rf "$DEST/$APP_NAME.app"
  ditto "$APP" "$DEST/$APP_NAME.app"
  open "$DEST/$APP_NAME.app"
  echo "Installed to $DEST/$APP_NAME.app"
fi
