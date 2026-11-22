#!/bin/zsh
# Packages GlassNotch for sharing: a universal (Apple silicon + Intel) app in a drag-to-install DMG.
#
#   Scripts/package.sh
#       Ad-hoc signed DMG. Recipients open it once via System Settings > Privacy & Security >
#       Open Anyway (a "How to open" note is included in the DMG).
#
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" NOTARY_PROFILE=glassnotch Scripts/package.sh
#       Signed and notarized DMG that opens without warnings. Needs an Apple Developer account;
#       create the profile once with:
#         xcrun notarytool store-credentials glassnotch --apple-id you@example.com --team-id TEAMID
#
# Output: dist/GlassNotch-<version>.dmg
set -euo pipefail
cd "${0:A:h}/.."

APP_NAME=GlassNotch
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" Resources/Info.plist)
DMG="dist/$APP_NAME-$VERSION.dmg"

UNIVERSAL=1 ./build.sh

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
ditto "build.noindex/$APP_NAME.app" "$STAGING/$APP_NAME.app"
ln -s /Applications "$STAGING/Applications"
cp Vendor/mediaremote-adapter/LICENSE "$STAGING/Third-party licenses.txt"

if [[ -z "${SIGN_IDENTITY:-}" ]]; then
  cat > "$STAGING/How to open GlassNotch.txt" <<'EOF'
How to open GlassNotch

1. Drag GlassNotch into the Applications folder.
2. Open it. macOS says it can't verify the developer, because this copy isn't notarized by Apple.
   Click Done.
3. Open System Settings > Privacy & Security, scroll down, and click "Open Anyway" next to
   GlassNotch. Confirm with your password.

You only need to do this once. GlassNotch then opens normally, shows a welcome screen that explains
each permission it may ask for, and lives in your notch and menu bar.

Requires macOS 14 Sonoma or later. On macOS 26 Tahoe and later the notch is Liquid Glass;
on Sonoma and Sequoia it uses the classic frosted blur.
EOF
fi

mkdir -p dist
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
fi

echo "Created $DMG ($(du -h "$DMG" | cut -f1))"
