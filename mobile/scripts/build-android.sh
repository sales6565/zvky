#!/usr/bin/env bash
# One signed release APK, from a clean checkout.
#
# WHAT THIS NEEDS THAT IS NOT IN THE REPOSITORY, and must not be:
#   - The Android SDK (Android Studio installs it).
#   - A release keystore, and its two passwords.
#
# THE KEYSTORE IS THE ONE IRREPLACEABLE THING HERE. Android identifies an app by
# the key it was signed with, so an upgrade must be signed with the SAME key as
# the install it replaces. Lose it and the only way back is for all sixty people
# to uninstall and reinstall, losing their session. Back it up somewhere that
# is not this repository and not the build machine.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ZVKY_KEYSTORE:?Set ZVKY_KEYSTORE to the path of the release keystore}"
: "${ZVKY_KEYSTORE_PASS:?Set ZVKY_KEYSTORE_PASS}"
: "${ZVKY_KEY_ALIAS:=zvky}"
: "${ZVKY_KEY_PASS:=$ZVKY_KEYSTORE_PASS}"
OUT="${ZVKY_OUT:-../dist-mobile}"

if [ ! -f "$ZVKY_KEYSTORE" ]; then
  echo "No keystore at $ZVKY_KEYSTORE." >&2
  echo "Create one ONCE with:" >&2
  echo "  keytool -genkeypair -v -keystore zvky-release.jks -alias zvky \\" >&2
  echo "    -keyalg RSA -keysize 4096 -validity 10000" >&2
  echo "Then back it up off this machine — see the note at the top of this file." >&2
  exit 1
fi

echo "==> Syncing the shell into the Android project"
npx cap sync android

echo "==> Assembling the release APK"
pushd android >/dev/null
./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file="$(readlink -f "$ZVKY_KEYSTORE")" \
  -Pandroid.injected.signing.store.password="$ZVKY_KEYSTORE_PASS" \
  -Pandroid.injected.signing.key.alias="$ZVKY_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$ZVKY_KEY_PASS"
popd >/dev/null

mkdir -p "$OUT"
APK="android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "Gradle did not produce $APK" >&2; exit 1; }
cp "$APK" "$OUT/zvky.apk"

echo
echo "==> $OUT/zvky.apk"
echo "    size:   $(du -h "$OUT/zvky.apk" | cut -f1)"
echo "    sha256: $(sha256sum "$OUT/zvky.apk" | cut -d' ' -f1)"
echo
echo "Copy it to the server's dist-mobile/ directory and it is live on the"
echo "install page. Nothing else needs restarting."
