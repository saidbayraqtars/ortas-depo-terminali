# Ortaş Depo Yönetici

Windows programı: el terminallerinin bağlandığı sunucu (port 5480, yerel ağ) ve yönetim ekranı. Electron 44 +
Express 5 + React 19 (Vite), kendi verisi `node:sqlite`, Vega'ya `mssql`. Kullanım: [`../docs/KURULUM.md`](../docs/KURULUM.md).

| Yer | İçerik |
|---|---|
| `server/vega.js` | Vega okuma (kart, barkod, depo stoku, mal kabul = `TBLSTOKHAREKETLERI` IZAHAT 20/26/32) ve sayım fişi yazma (93/94) |
| `server/depo.js` | Raf stoku, terminal işlemleri, sayım özeti, terminale giden ana veri (ETag) |
| `server/etiket.js` | Raf / ürün etiketi HTML + barkod (bwip-js; geçerli EAN-13, yoksa Code 128) |
| `server/fuzzy.js` | İsimle yakın eşleşmeli arama (terminaldeki `Fuzzy.kt` ile aynı kurallar) |
| `server/index.js` | Uçlar: `/api/*` terminal, `/yonetim/api/*` yönetim, `/apk`, `/kur` |
| `electron/main.js` | Pencere, tepsi, Windows açılışında başlatma, PDF ve sessiz etiket yazdırma, GitHub'dan güncelleme |
| `client/` | Yönetim ekranı |

```bash
npm install
npm test              # sunucu testleri
npm run dev           # sunucu (veri ./veri) + arayüz http://localhost:5173
npm run desktop       # Electron ile aç
npm run dist          # APK'yı ekler (../cikti/OrtasDepo-<sürüm>.apk) ve kurulum exe'si üretir → release/
npm run release       # aynısı + GitHub Releases'e yükler (GH_TOKEN gerekir)
```

İkonlar Reicon'dan: `node scripts/ikonlar.js <icon-data.json>` (elle ikon çizilmez). Program simgesi:
`node scripts/electron-calistir.js scripts/ikon-uret.js`.

Vega'ya yazma deseni gerçek Vega kaydından alındı (Galya F0102D0002 Z0000048/Z0000022) ve `VEGADB_KAYITSINAMA` test
kopyasında yazılıp geri alınarak denendi. Kurulumdan kuruluma sütun farkı için yalnız tabloda olan sütunlara yazılır.
