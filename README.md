# Quick Draw — 手機當控制器的派對遊戲

PC 開一個大螢幕頁面，手機掃 QR code 進來當控制器，不用裝 App。

- **大廳**：2D 平台跳躍的夜景地圖。手機橫拿，◀ ▶ 跑、「跳」跳、按 emoji 冒泡泡。地圖兩端是遊戲區，走進去站滿人數就自動開始。
- **快槍手**（1-2-Switch 式）：兩人把手機垂在身側，聽到槍聲最快舉起並點螢幕的人贏；提早動就是搶跑直接輸。贏家戴皇冠留在擂台，輸家被彈出去，下一個走進來的人接著挑戰。
- **碰碰車**（相撲圈）：2 到 8 人，地圖左端的入口站滿 2 人後開 5 秒加入窗口。手機上按住螢幕拖曳當搖桿、右下角「衝刺」。碰撞用等質量彈性碰撞，衝刺中撞到人會多推一把。15 秒後圈開始縮小，出圈淘汰，最後站著的贏；75 秒到時離圓心最近的贏。結束後所有人被彈出入口，重新聚集才會再開。參數在 `config.js` 的 `BUMPER`。

## 啟動

```bash
npm install
npm start
```

- PC 顯示頁：<http://localhost:8080/>（純 HTTP，不會有憑證警告）。按 **Enter** 可以直接開一場快槍手、**Esc** 結束、**D** 開啟輸入檢視。
- 手機控制器：終端機與顯示頁會印出 `https://<PC 的區網 IP>:8443/c` 和 QR code。手機第一次開會看到憑證警告，選「進階 → 繼續前往」。
- 沒手機時可在 PC 開 <http://localhost:8080/c?sim> 用鍵盤模擬：← → 跑、↑ 跳、1-8 emoji、H 垂下、R 舉起、Space 開槍、S 搖晃。

手機與 PC 要在同一個 Wi-Fi。

## 測試

```bash
npm test                         # 狀態機 + 擂台配對測試，會自己起一個 GAME_FAST 的伺服器在 18080
npm run bot -- 小明 400 wander   # 假手機：名字、反應時間 ms、行為
```

機器人行為：`normal`、`wander`（大廳亂走、發 emoji、會自己走進擂台打起來）、`falsestart`、`sleepy`（不就位）、`nofire`、`misfire`（沒舉起就按）。

## 專案結構

```
server/
  index.js          入口：HTTP/HTTPS 靜態頁、WebSocket 路由、30 Hz 狀態廣播
  config.js         所有可調參數：埠、顏色、物理、關卡平台、遊戲區、快槍手門檻
  state.js          共用狀態（players、displays、game）與事件匯流排
  net.js            send / broadcastDisplays / event / 區網 IP
  tls.js            自簽憑證或 certs/ 裡的 mkcert 憑證
  players.js        加入離開、感測器判讀（傾斜、搖晃）、手機時鐘同步
  lobby.js          平台物理（60 Hz）、遊戲區偵測、emoji、把輸家彈出去
  phones.js         決定每支手機該顯示哪個畫面，只在變化時推送
  games/
    index.js        遊戲註冊表：zone:ready 事件 → 啟動對應遊戲
    quickdraw.js    快槍手狀態機
    bumper.js       碰碰車：搖桿、碰撞、衝刺、縮圈、淘汰
public/
  display.html      PC 大螢幕：大廳地圖、對決畫面、合成音效、輸入檢視（按 D）
  controller.html   手機頁：加入、大廳控制、對決各畫面、鍵盤模擬
test/
  duel.test.js      整合測試（25 項）
  bot.js            假手機
```

**模組之間用 `state.bus` 溝通，避免互相 require**：`motion`、`shake`、`player:leave`、`player:kick`、`zone:ready`、`phones:push`。

### 新增一個遊戲

1. 在 `config.js` 的 `GAMES` 加一筆：id、名稱、人數、地圖上的區域、站多久開始、是否有加入倒數。
2. 寫 `server/games/<id>.js`，匯出 `id, start(pids), stop(), skip(), onShot?(…), phoneScreen(p) → 畫面或 null, publicState()`。進行中把 `state.game.mode` 設成自己的 id、`state.game.participants` 放進參賽者（大廳物理會把他們定住）；結束時設回 `lobby`，用 `bus.emit('player:kick', pid)` 把輸家彈出擂台、`bus.emit('phones:push')` 更新手機畫面。
3. 在 `games/index.js` 的 `list` 加進去。
4. `display.html` 加對應的場景、`controller.html` 加對應的 `screen`。

## 快槍手規則

```
lobby ──兩人站進擂台 1 秒──▶ intro (3.5s) ──▶ holster ──兩人都垂下 0.6s──▶ wait (隨機 2–6s) ──▶ fire ──▶ result (5s) ──▶ lobby
                                                 │ 30s 沒就位                │ 舉起或按 = 搶跑          │ 3s 沒人開槍 = 平手
```

- **就位**：手機 pitch（`beta`）低於 -55°，持續 0.6 秒。
- **搶跑**：等待期間 `beta` 高過 -30°，或點了螢幕。
- **開槍**：舉起（`beta` ≥ -30°）後點螢幕。沒舉起就點算走火，不計分也不算輸。
- **公平性**：每支手機加入時做 NTP 式時鐘同步（取 RTT 最小的樣本），開槍時間用手機端時間戳換算成伺服器時間，所以 Wi-Fi 延遲不同的兩支手機比的是真正的反應時間。第一槍到達後再等 150 ms，看對方有沒有時間戳更早的那槍。
- 對決中途斷線，對手直接獲勝。

## 協定（JSON over WebSocket）

手機 → 伺服器：`hello {role:'controller', pid, name}`、`motion {ts, alpha, beta, gamma, ax, ay, az}`（約 30 Hz）、`pong {s, c}`、`move {dir: -1|0|1}`、`jump`、`emoji {e}`、`shot {ts, beta}`、`stick {x, y}`（碰碰車搖桿，-1..1）、`dash`、`calib`。核心不認得的訊息會交給進行中的遊戲模組的 `onMessage`。

伺服器 → 手機：`welcome`、`ping {s}`、`game {screen, …}`（lobby / spectate / intro / holster / wait / fire / result / bumper / bumper-result）、`zone {game, name, comingSoon}`、`holster {ok}`、`misfire`、`haptic {ms}`。

伺服器 → 顯示頁（30 Hz）：`state {world, players[], game:{mode, champion, games[], duel}}`，另有 `event` 與 `fire`。顯示頁 → 伺服器：`cmd {cmd:'start'|'stop'|'skip'|'reset'}`。

## 為什麼手機那邊要 HTTPS

iOS 與 Android 的瀏覽器都只在 secure context 才給 `DeviceMotion` / `DeviceOrientation`。
第一次啟動會自動產生一張自簽憑證存在 `certs/`。想拿掉警告，用 [mkcert](https://github.com/FiloSottile/mkcert) 簽一張，手機裝一次 root CA：

```bash
mkcert -install
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 <PC 的區網 IP>
```

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `HTTPS_PORT` | 8443 | HTTPS 埠（手機） |
| `PORT` | 8080 | HTTP 埠（PC 顯示頁） |
| `HOST` | 第一張非 loopback 的 IPv4 | 多張網卡（VPN 等）時指定 QR code 要用哪個 IP |
| `GAME_FAST` | 無 | 設了就把對決各階段的時間縮短，給測試用 |
