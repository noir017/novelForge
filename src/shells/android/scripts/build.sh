#!/usr/bin/env bash
# 打 Android 包：独立版打成 node 单文件 → assets/server.cjs，Termux node → jniLibs（没有才取），再 gradle assemble。
# 用法（任意目录）：src/shells/android/scripts/build.sh [debug|release]，产物在 src/shells/android/app/build/outputs/apk/
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
variant="${1:-debug}"
main="$here/app/src/main"

rm -rf "$main/assets"
mkdir -p "$main/assets"
(cd "$repo" && node scripts/build-android-server.js "$main/assets/server.cjs")

[[ -f "$main/jniLibs/arm64-v8a/libnode.so" ]] || "$here/scripts/fetch-node.sh"

cd "$here"
./gradlew --no-daemon -q --stacktrace "assemble${variant^}"
ls -l app/build/outputs/apk/"$variant"/*.apk
