#!/usr/bin/env bash
# 取 Termux 的 nodejs-lts（arm64、bionic 编译）及其依赖库，放进 app/src/main/jniLibs/arm64-v8a，给内置服务端用。
# Android 10+ 只允许执行 nativeLibraryDir 里的文件，而安装时只解压名为 lib*.so 的文件，所以：
#   - node 本体改名 libnode.so
#   - libssl.so.3 这类带版本号的库改名 libssl_3.so：等长改名，直接在 .dynstr 里原地替换 soname 与 DT_NEEDED，不重写 ELF 结构
# 包的下载地址与 sha256 取自 Termux 仓库的 Packages 索引。
# 依赖：curl dpkg-deb readelf python3（GitHub 的 ubuntu runner 都有）
# 取自望舒（wangshu-reader）的同名脚本，多了一道检查：node 要的库既不在这几个包里、也不是 Android 系统库时直接失败。
set -euo pipefail
repo=https://packages.termux.dev/apt/termux-main
pkgs=(nodejs-lts libc++ openssl c-ares libicu libsqlite zlib)
dest="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/jniLibs/arm64-v8a"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "$repo/dists/stable/main/binary-aarch64/Packages" -o "$work/Packages"
for p in "${pkgs[@]}"; do
  read -r file sha < <(awk -v p="$p" 'BEGIN { RS = ""; FS = "\n" }
    { hit = 0; f = ""; s = ""
      for (i = 1; i <= NF; i++) {
        if ($i == "Package: " p) hit = 1
        if ($i ~ /^Filename: /) f = substr($i, 11)
        if ($i ~ /^SHA256: /) s = substr($i, 9)
      }
      if (hit) { print f, s; exit } }' "$work/Packages")
  [[ -n "${file:-}" ]] || { echo "Termux 仓库里找不到 $p" >&2; exit 1; }
  echo "· $file" >&2
  curl -fsSL "$repo/$file" -o "$work/pkg.deb"
  echo "$sha  $work/pkg.deb" | sha256sum -c --quiet
  dpkg-deb -x "$work/pkg.deb" "$work/root"
done

rm -rf "$dest"
mkdir -p "$dest"
python3 - "$work/root/data/data/com.termux/files/usr" "$dest" <<'EOF'
import re, shutil, subprocess, sys
from pathlib import Path

usr, dest = Path(sys.argv[1]), Path(sys.argv[2])

def needed(f):
    out = subprocess.run(['readelf', '-d', str(f)], capture_output=True, text=True, check=True).stdout
    return re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', out)

# Android 系统自带、app 进程里就能链接到的库（NDK 的稳定 API）。不在这里、也不在 Termux 包里的，装上手机必然起不来
SYSTEM = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so'}

def rename(n):
    # libssl.so.3 → libssl_3.so（与原名等长）；本来就是 lib*.so 的不动
    m = re.fullmatch(r'(lib.+)\.so\.(.+)', n)
    return f'{m.group(1)}_{m.group(2)}.so' if m else n

mapping, files = {}, {}
todo = [(usr / 'bin' / 'node', 'libnode.so')]
while todo:
    src, name = todo.pop()
    if name in files:
        continue
    files[name] = src
    for n in needed(src):
        if (usr / 'lib' / n).exists():
            mapping[n] = rename(n)
            todo.append((usr / 'lib' / n, mapping[n]))
        elif n not in SYSTEM:
            sys.exit(f'{src.name} 要 {n}：不在取下来的 Termux 包里，也不是系统库——在脚本开头的 pkgs 里补上它所在的包')

for name, src in files.items():
    data = bytearray(Path(src).resolve().read_bytes())
    for old, new in mapping.items():
        if old != new:
            assert len(old) == len(new)
            data = data.replace(b'\0' + old.encode() + b'\0', b'\0' + new.encode() + b'\0')
    (dest / name).write_bytes(data)
    print(f'  {name:28} {len(data) / 1e6:6.1f} MB', file=sys.stderr)
EOF
du -sh "$dest" >&2
