# Hata toplayıcı (nevaqr VPS)

Sahadaki Ortaş Depo Terminali ve Ortaş Depo Yönetici çökme, donma (ANR) ve hata raporlarını buraya gönderir.
Said uzaktan `ssh nevaqr` ile okur.

- Adres: `https://lisans.neva.technology/hata/v1/rapor` (Cloudflare dışı yol; eski Android'lerde CF üzerinden TLS kopabiliyor).
- Servis: `/opt/hata-toplayici/sunucu.js`, systemd `hata-toplayici.service`, `127.0.0.1:8796`, `DynamicUser`.
- Raporlar: `/var/lib/hata-toplayici/<app>/<YYYY-MM-DD>/<HHMMSS>-<tür>-<id>.json`, 120 gün, toplam 500 MB kota.
- Anahtar: VPS'te `/etc/hata-toplayici.env` (`RAPOR_ANAHTARI=...`, root 600). Derlemede:
  - Android: `android/keystore.properties` içinde `raporAnahtari=...` → `BuildConfig.REPORT_KEY`
  - Yönetici: `yonetici/server/rapor.json` → `{ "anahtar": "..." }`
  İkisi de depoya girmez. Anahtar yoksa uygulama VPS'e göndermez (yönetici günlüğüne yazmaya devam eder).

## Okuma

```bash
ssh nevaqr 'node /opt/hata-toplayici/liste.js 30'
ssh nevaqr 'cat /var/lib/hata-toplayici/ortas-terminal/2026-10-26/<dosya>.json'
ssh nevaqr 'journalctl -u hata-toplayici -n 50'
```

## Kurulum

```bash
scp sunucu.js liste.js nevaqr:/tmp/
ssh nevaqr 'install -d /opt/hata-toplayici && install -m 644 /tmp/sunucu.js /tmp/liste.js /opt/hata-toplayici/'
```

`/etc/systemd/system/hata-toplayici.service`:

```ini
[Unit]
Description=Hata toplayici (saha uygulamalari cokme raporlari)
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/hata-toplayici/sunucu.js
EnvironmentFile=/etc/hata-toplayici.env
DynamicUser=yes
StateDirectory=hata-toplayici
StateDirectoryMode=0750
Restart=always
RestartSec=3
MemoryMax=128M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

nginx: `/etc/nginx/conf.d/hata-toplayici-limit.conf` içinde
`limit_req_zone $binary_remote_addr zone=hata_rapor:10m rate=30r/m;` ve lisans vhost'una:

```nginx
location /hata/ {
    limit_req zone=hata_rapor burst=30 nodelay;
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:8796;
    include /etc/nginx/snippets/neva-lisans-proxy.conf;
}
```
