#!/usr/bin/env bash
# session-branch-control 移除：解除 session-branch-control@custom-tools（custom-tools 市場保留，其他 plugin 不受影響）
# 加 --purge 連同 session 地圖資料（~/.claude/session-branch-control/）一起刪除。
set -e
ID="session-branch-control@custom-tools"

command -v claude >/dev/null 2>&1 || { echo "✗ 需要 claude CLI，請先安裝。" >&2; exit 1; }

if claude plugin uninstall "$ID" >/dev/null 2>&1; then
  echo "· 已解除安裝 plugin：$ID"
else
  echo "· 未安裝，略過：$ID"
fi

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.claude/session-branch-control"
  echo "· 已刪除 session 地圖資料：~/.claude/session-branch-control/"
else
  echo "· 保留 session 地圖資料（~/.claude/session-branch-control/）；要一起刪除請加 --purge"
fi
echo "✓ 已移除。在 CC 執行 /reload-plugins 或重啟 CC 套用。"
