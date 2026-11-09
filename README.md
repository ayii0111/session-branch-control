# session-branch-control

Claude Code 的對話分枝管理：主線之外，用 `/q`（概念追問）、`/wi`（假設推演）開**輕支線**，答案只顯示在全寬的閱讀區、不污染主線（側欄只看樹狀架構）；
支線可**併回主線**，或**升級成重支線**（真正的子 session，原地或開在新的 Orca 分頁）；
每個 session 都看得到同一張 **Session 地圖**，可以一鍵原地切換或用分頁開啟任一分枝。

👉 使用方式見 **[使用者手冊](docs/使用者手冊.md)**。

## 安裝／移除

純 cc plugin，收錄於 [custom-tools](https://github.com/ayii0111/custom-tools) 市場。私人 repo：以下方式都需本機已登入有權限的 GitHub 帳號（`gh auth status` 確認）。

### 方式一：cc plugin 指令

```bash
claude plugin marketplace add ayii0111/custom-tools
claude plugin install session-branch-control@custom-tools
# 移除
claude plugin uninstall session-branch-control@custom-tools
```

### 方式二：curl 一鍵

```bash
curl -fsSL -H "Authorization: token $(gh auth token)" https://raw.githubusercontent.com/ayii0111/session-branch-control/main/install.sh | bash
# 移除（加 `-s -- --purge` 連同 session 地圖資料一起刪除）
curl -fsSL -H "Authorization: token $(gh auth token)" https://raw.githubusercontent.com/ayii0111/session-branch-control/main/uninstall.sh | bash
```

### 方式三：clone 後執行 install.sh

```bash
git clone https://github.com/ayii0111/session-branch-control.git && cd session-branch-control && ./install.sh
# 移除（加 --purge 連同 session 地圖資料一起刪除）
./uninstall.sh
```

安裝後在 CC 執行 `/reload-plugins` 或重啟 CC 套用。install.sh 可重跑（已安裝即更新）。
安裝後的程式碼放在 cc 的 plugin 快取裡，執行時不依賴本專案目錄。

## 運作方式（給維護者）

| 功能 | 用到的 cc mod API |
|---|---|
| 輕支線問答 | `$.model.fork`：帶著主線完整脈絡、不用工具、答案不寫回主線，並沿用主線的 prompt cache |
| 支線閱讀區 | `$.ui.place` 在對話尾端放一列全寬區塊；`UserMessage`／`AssistantMessage` 的 render hook 記下畫面上緣是哪則訊息，`$.ui.scroll({ to: { requestId } })` 跳去／捲回 |
| 併回主線、升級時寫入紀錄 | `$.session.append`：在歷史最後面加一筆隱藏的 user 訊息，不觸發新的一輪 |
| 原地切換、原地分出 | `$.command.run` 觸發內建 `/resume`、`/branch`（要從按鈕或計時器呼叫，不能在指令 hook 裡直接呼叫） |
| 新分頁 | `orca terminal create` 執行 `claude --resume <id> [--fork-session --session-id <uuid>]` |
| 地圖 | 每個專案一個 JSON：`~/.claude/session-branch-control/<專案路徑>.json`，所有分頁共用；每 8 秒同步一次 |

- `hooks/register.tsx`：指令、面板、輕支線、升級／分出流程
- `hooks/graph.ts`：地圖檔讀寫、Orca 分頁操作（跨檔案傳 `$` 的 helper 必須寫成 function 宣告）
- 新分頁裡的子 session 啟動時，會從地圖檔的 `pending` 取出屬於自己的支線紀錄寫進歷史

## 開發

```bash
claude --plugin-dir .            # 載入本 mod 啟動（測試前先 uninstall 已安裝版，避免重複載入）
claude plugin validate .         # 驗證
claude plugin test .             # 測試
npx -p typescript tsc -p .       # 型別檢查（型別由引擎寫入 .claude-plugin/types/）
```

依 `cc-tools` 規範：修改後要先移除再重新安裝，讓修改立即生效。
