# chGPS — 地圖選點，USB 改 iPhone 定位

在網頁地圖上點一個位置，透過 USB 把該座標寫進 iPhone，讓系統與 App 認為裝置在該地點。
底層使用 [`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3)，走的是 Xcode「Simulate Location」同一個 Apple 官方開發者服務。

## 架構

```
React + Leaflet (:3000)
      │  POST /api/location {lat, lng}
      ▼
Node/Express bridge (:4000)
      │  spawn: python -m pymobiledevice3 developer dvt simulate-location set
      ▼
RemoteXPC tunnel (iOS 17+) ──USB──▶ iPhone
```

## 已驗證環境

| 項目 | 值 |
|---|---|
| 主機 | Windows 11 |
| 裝置 | iPhone 14 Plus (iPhone14,8) |
| 系統 | iOS 26.5.2 |
| pymobiledevice3 | 10.1.0 |
| Node | 24.x |

在 Windows 上**不需要安裝 iTunes**，內建的 Apple Mobile Device 驅動即可讓
`pymobiledevice3` 透過 usbmux 連上裝置。

iOS 17 以上（含 iOS 26）走 `developer dvt simulate-location`，**不是**頂層那個
`developer simulate-location`（那個只支援 iOS 16 以下），且必須有 RemoteXPC tunnel。
後端會依裝置回報的 iOS 版本自動選擇路徑，不需手動切換。

## 前置需求（僅需做一次）

### 1. 在 iPhone 上啟用開發者模式 ⚠️ 會重開機

```bash
python -m pymobiledevice3 amfi enable-developer-mode
```

執行後 iPhone 會**自動重新開機**。重開後：
設定 → 隱私權與安全性 → 開發者模式 → 開啟 → 輸入密碼確認。

> 這步無法完全自動化：Apple 強制要求實體解鎖與密碼確認。

### 2. 掛載 Developer Disk Image

開發者模式開啟後，在網頁的裝置面板點「立即掛載」，或：

```bash
python -m pymobiledevice3 mounter auto-mount
```

iOS 17+ 會從 Apple 下載 personalized DDI，需要連網，約數分鐘。

### 3. 啟動 RemoteXPC tunnel（iOS 17+ 必要）

需要**系統管理員權限**（要建立 TUN 介面）。開一個 Administrator PowerShell：

```bash
python -m pymobiledevice3 remote tunneld
```

保持這個視窗開著。tunneld 會在 `127.0.0.1:49151` 提供服務，bridge 會自動偵測。

**無管理員權限的替代方案** — 使用 userspace tunnel（速度較慢但免提權）：

```bash
python -m pymobiledevice3 remote tunneld --userspace
```

## 啟動

三個終端機：

```bash
npm run tunnel
```

```bash
npm run server
```

```bash
npm run dev
```

開啟 http://localhost:3000

## 使用

- **點擊地圖** → 新增座標點
- **📲** → 把該座標傳送到 iPhone
- **🎯** → 地圖移動到該點
- **✕** → 刪除
- 左側可手動微調經緯度到小數點後 6 位
- **還原真實 GPS** → 停止模擬，回到實際定位

裝置面板即時顯示連線狀態，未就緒時會列出具體缺什麼。

## API

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/api/status` | 裝置狀態與阻礙清單（`?fresh=1` 跳過快取） |
| `POST` | `/api/location` | `{lat, lng}` → 設定模擬定位 |
| `POST` | `/api/location/clear` | 還原真實 GPS |
| `POST` | `/api/ddi/mount` | 掛載 Developer Disk Image |

## 疑難排解

| 症狀 | 處理 |
|---|---|
| `未偵測到 iPhone` | 解鎖螢幕、確認已點「信任這台電腦」、換條支援資料傳輸的線 |
| `開發者模式未啟用` | 見前置需求 1 |
| `DDI 未掛載` | 見前置需求 2；需連網 |
| `tunneld 未回應` | 見前置需求 3；tunneld 需以管理員身分執行且保持運作 |
| 定位沒變 | 部分 App 會快取位置，重啟該 App；地圖類 App 通常即時反應 |

## 注意

- 模擬定位在 iPhone **重新開機後失效**，需重新設定。
- 這使用的是 Apple 官方開發者服務，**不需要越獄**，也不會修改系統檔案。
- 僅適用於自己擁有、且已配對信任的裝置。
