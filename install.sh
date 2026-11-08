#!/usr/bin/env bash
# branch-tree 安裝（純 cc plugin）：從 custom-tools 市場安裝 branch-tree@custom-tools
# 可重跑：已安裝就更新。安裝後的程式碼在 cc 的 plugin 快取裡，不依賴本專案目錄。
set -e
PLUGIN="branch-tree"
MARKET="custom-tools"
ID="${PLUGIN}@${MARKET}"

command -v claude >/dev/null 2>&1 || { echo "✗ 需要 claude CLI，請先安裝。" >&2; exit 1; }

if claude plugin marketplace list 2>/dev/null | grep -qE "❯ ${MARKET}\$"; then
  claude plugin marketplace update "$MARKET" >/dev/null
else
  claude plugin marketplace add "ayii0111/$MARKET" >/dev/null
  echo "· 已註冊 marketplace：$MARKET"
fi

if claude plugin list 2>/dev/null | grep -qF "$ID"; then
  claude plugin update "$ID" >/dev/null
  echo "· 已更新 plugin：$ID"
else
  claude plugin install "$ID" --scope user >/dev/null
  echo "· 已安裝 plugin：$ID"
fi
echo "✓ 安裝完成。在 CC 執行 /reload-plugins 或重啟 CC 套用。使用說明見 docs/使用者手冊.md"
