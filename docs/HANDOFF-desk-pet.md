# 交接：桌寵專案（desk-pet）

把這個檔案的內容貼給新的對話當第一則訊息，或直接請它讀這個檔案。

---

## 給新對話的提示

我要開一個新專案 `desk-pet`，放在 `D:\Claude project\desk-pet`，跟既有的派對遊戲專案 `D:\Claude project\motion-demo` 是**分開的 repo、分開的產品**，不要共用套件，需要的程式碼直接複製過來。

### 這個專案是什麼

一個 Windows 桌寵：幾個圓角方塊小角色在螢幕底部走來走去、跳上工作列、互相撞、偶爾冒 emoji 泡泡。靈感來自派對遊戲大廳裡的機器人：看它們跑來跑去很療癒。之後可能做美術、加內容、上 itch.io 或 Steam，但現在先做能掛在桌面上的版本。

### 技術決定

- Electron（不是 Tauri），因為要複製過來的物理和機器人程式都是 Node/JS。
- 一個透明、永遠置頂、滑鼠穿透的無邊框視窗貼在螢幕底部，`setIgnoreMouseEvents(true, { forward: true })`，角色所在區域再動態關閉穿透讓滑鼠可以互動。
- 系統匣圖示：暫停、角色數量、結束。
- 60 Hz 物理在主程序或渲染程序都可以，單機不用網路。先不做「抓其他視窗當平台」，那是進階功能。

### 從 motion-demo 複製這三段，其他都不要

1. `server/lobby.js` 的 `stepBody(body, input, level, dt, now)`：平台物理。重力 30、跳躍 13、加速 48、最高速 6.5、摩擦 14、空中摩擦 2、土狼時間 120 ms、跳躍緩衝 150 ms、單向平台。常數在 `server/config.js` 的 `WORLD`。
2. `public/display.html` 的 `renderLobby()` 裡畫角色的那段：圓角膠囊身體、兩顆眼睛看移動方向、落地擠壓與起跳拉伸、腳步動畫、名字、emoji 泡泡、冠軍皇冠。
3. `server/bots.js` 的 `thinkLobby()`：閒晃（隨機目標 x、閉迴路走路、用煞車距離 v²/(2×14) 判斷何時放開）、隨機跳、偶爾發 emoji。

桌寵專屬要新增的行為：被滑鼠碰到會跳開、可以用滑鼠拖起來丟（放開時給速度）、閒置久了坐下或睡覺、兩隻靠近時互撞一下。

### 原專案狀態（僅供參考，不要改它）

- 派對遊戲：手機掃 QR 當控制器，PC 大螢幕，有大廳、快槍手、碰碰車、跑酷，伺服器端機器人，四組整合測試。
- 使用者對手感的要求：跳躍要有土狼時間和跳躍緩衝、按住跳要連跳、角色動作要順，這些在桌寵也要保留。
- 環境：Windows 11，Node.js 24 在 `C:\Program Files\nodejs`，git 用 `user.name austinhuang`，commit 訊息結尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 使用者習慣：做完一個段落就 commit；他會用真機親自測，手感問題會直接回報；不要替他做產品方向的決定，先做最便宜能驗證的版本。

### 第一步

建立 `D:\Claude project\desk-pet`，`git init`，Electron 最小殼加透明置頂視窗，把三段程式碼搬過來讓三隻角色在螢幕底部走動和跳，加系統匣結束鈕。做到這裡先停下來讓我看。
