# Quick Draw — 手機當體感控制器的派對遊戲

PC 開一個大螢幕頁面，手機掃 QR code 進來當控制器，不用裝 App。
目前有兩個部分：

- **大廳遊樂場**：2D 平台跳躍風。左右傾斜手機讓角色在大螢幕上跑、搖一搖或按「跳」跳上平台、按 emoji 冒泡泡。物理在伺服器算（重力、單向平台、土狼時間、跳躍緩衝），顯示頁只做插值與擠壓拉伸動畫。關卡平台在 `server.js` 的 `WORLD.PLATFORMS`。
- **快槍手對決**（1-2-Switch 式）：兩人把手機垂在身側，聽到槍聲最快舉起並點螢幕的人贏；提早動就是搶跑直接輸。贏家留下，輸家排到隊伍最後。

## 啟動

```bash
npm install
npm start
```

- PC 顯示頁：<http://localhost:8080/>（純 HTTP，不會有憑證警告）。按 **Enter** 開始對決、**Esc** 結束、**D** 開啟輸入檢視。
- 手機控制器：終端機與顯示頁會印出 `https://<PC 的區網 IP>:8443/c` 和 QR code。手機第一次開會看到憑證警告，選「進階 → 繼續前往」。
- 沒手機時可在 PC 開 <http://localhost:8080/c?sim> 用鍵盤模擬：H 垂下、R 舉起、Space 開槍、方向鍵傾斜、S 搖晃、1-8 emoji。

手機與 PC 要在同一個 Wi-Fi。

## 測試

```bash
npm test                      # 對決狀態機測試，會自己起一個 GAME_FAST 的伺服器在 18080
npm run bot -- 小明 400 wander  # 假手機：名字、反應時間 ms、行為
```

機器人行為：`normal`、`wander`（大廳亂走、發 emoji）、`falsestart`、`sleepy`（不就位）、`nofire`、`misfire`（沒舉起就按）。

## 為什麼手機那邊要 HTTPS

iOS 與 Android 的瀏覽器都只在 secure context 才給 `DeviceMotion` / `DeviceOrientation`。
第一次啟動會自動產生一張自簽憑證存在 `certs/`。想拿掉警告，用 [mkcert](https://github.com/FiloSottile/mkcert) 簽一張，手機裝一次 root CA：

```bash
mkcert -install
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 <PC 的區網 IP>
```

伺服器看到 `certs/cert.pem` + `certs/key.pem` 就會優先用它。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `HTTPS_PORT` | 8443 | HTTPS 埠（手機） |
| `PORT` | 8080 | HTTP 埠（PC 顯示頁） |
| `HOST` | 第一張非 loopback 的 IPv4 | 多張網卡（VPN 等）時指定 QR code 要用哪個 IP |
| `GAME_FAST` | 無 | 設了就把對決各階段的時間縮短，給測試用 |

## 對決流程

```
lobby ──Enter──▶ intro (3.5s) ──▶ holster ──兩人都垂下 0.6s──▶ wait (隨機 2–6s) ──▶ fire ──▶ result (5s) ──▶ 下一場
                                   │ 30s 沒就位                │ 舉起或按 = 搶跑          │ 3s 沒人開槍 = 平手重打
```

- **就位**：手機 pitch（`beta`）低於 -55°，持續 0.6 秒。
- **搶跑**：等待期間 `beta` 高過 -30°，或點了螢幕。
- **開槍**：舉起（`beta` ≥ -30°）後點螢幕。沒舉起就點算走火，不計分也不算輸。
- **公平性**：每支手機加入時做 NTP 式時鐘同步（取 RTT 最小的樣本），開槍時間用手機端時間戳換算成伺服器時間，所以 Wi-Fi 延遲不同的兩支手機比的是真正的反應時間。第一槍到達後再等 150 ms，看對方有沒有時間戳更早的那槍。
- 對決中途斷線，對手直接獲勝。

門檻都在 `server.js` 頂部的 `QD` 常數。

## 協定（JSON over WebSocket）

手機 → 伺服器

| 訊息 | 內容 |
|---|---|
| `hello` | `{role:'controller', pid, name}`，`pid` 存在手機 localStorage，重連保留同一個玩家槽 |
| `motion` | `{ts, alpha, beta, gamma, ax, ay, az}`，約 30 Hz |
| `pong` | 回應伺服器的 `ping`，帶 `{s, c}`（伺服器送出時間、手機當下時間） |
| `shot` | `{ts, beta}` 點螢幕開槍 |
| `emoji` | `{e}` |
| `calib` | 以目前姿勢重設傾斜中心 |

伺服器 → 手機

| 訊息 | 內容 |
|---|---|
| `welcome` | `{pid, num, name, color}` |
| `ping` | `{s}` |
| `game` | `{screen: 'lobby'|'spectate'|'intro'|'holster'|'wait'|'fire'|'result', ...}` 手機該顯示的畫面 |
| `holster` | `{ok}` 就位狀態變化 |
| `misfire` | 沒舉起就按了 |
| `haptic` | `{ms}` 震動 |

伺服器 → 顯示頁（30 Hz）

`{t:'state', players:[...], game:{mode, round, champion, queue, duel:{phase, a, b, result, ...}}}`，另有 `event` 與 `fire` 即時訊息。
顯示頁 → 伺服器：`{t:'cmd', cmd:'start'|'stop'|'skip'|'reset'}`。

## 檔案

- `server.js` 伺服器：靜態頁、WebSocket、輸入判讀、大廳移動、對決狀態機、時鐘同步
- `public/display.html` PC 大螢幕：大廳遊樂場、對決畫面、合成音效、輸入檢視（按 D）
- `public/controller.html` 手機頁：加入、大廳 emoji、對決各畫面、鍵盤模擬
- `test/duel.test.js` 狀態機測試、`test/bot.js` 假手機
