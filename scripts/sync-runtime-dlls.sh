#!/bin/sh
# 打包前把 exe 依赖的 OpenSSL 运行库同步到 src-tauri/，
# 它们由 tauri.conf.json 的 bundle.resources 一起打进安装包。
#
# 背景：exe 动态链接 libcrypto-3-x64.dll（openssl crate 默认），
# 早期安装包/便携包漏了它，换台电脑就报「找不到 libcrypto-3-x64.dll」。
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="${BUDDY_DLL_DIR:-F:/Soft/BuddySwitch}"
for f in libcrypto-3-x64.dll libssl-3-x64.dll; do
    if [ ! -f "$SRC/$f" ]; then
        echo "缺少 $SRC/$f（可用 BUDDY_DLL_DIR 指定所在目录）" >&2
        exit 1
    fi
    cp -f "$SRC/$f" "$HERE/src-tauri/$f"
    echo "synced $f"
done
