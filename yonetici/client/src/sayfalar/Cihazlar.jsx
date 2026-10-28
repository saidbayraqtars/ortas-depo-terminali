import React, { useEffect, useState } from 'react';
import { Alan, api, Btn, Durum, Icon, kilitDestegiYok, Modal, once, Rozet, SayfaBaslik, useApp, useOnay, useVeri } from '../lib.jsx';

function QrPenceresi({ cihaz, kapat }) {
  const { durum, toast } = useApp();
  const ipler = durum?.adresler || [];
  // Bağlantı adresi: bu bilgisayar (Merkez) ya da Toybelen gibi uzak şubedeki köprü bilgisayarı (terminaller ona bağlanır).
  const kopruler = (durum?.kopruler || []).filter((k) => k.adresler.length);
  const secenekler = [
    ...ipler.map((a) => ({ kod: `ip:${a.ip}`, ad: `Merkez · ${a.ip} (${a.ad})` })),
    ...kopruler.flatMap((k) => k.adresler.map((u) => ({ kod: `url:${u}`, ad: `${k.ad} · ${u.replace(/^https?:\/\//, '')}${k.bagli ? '' : ' (bağlı değil)'}` }))),
  ];
  const [secim, setSecim] = useState(secenekler[0]?.kod || '');
  const [qr, setQr] = useState(null);
  useEffect(() => {
    const [tur, ...kalan] = secim.split(':');
    const q = secim ? `?${tur === 'url' ? 'url' : 'ip'}=${encodeURIComponent(kalan.join(':'))}` : '';
    api(`/cihaz/${cihaz.id}/qr${q}`).then(setQr).catch((e) => toast(e.message, true));
  }, [cihaz.id, secim, toast]);
  return (
    <Modal genis baslik={`${cihaz.name} kurulumu`} kapat={kapat} alt={<Btn kind="primary" onClick={kapat}>Tamam</Btn>}>
      {secenekler.length > 1 && (
        <Alan etiket="Terminallerin bağlanacağı adres" ipucu={kopruler.length ? 'Merkezdeki terminaller için Merkez adresini, Toybelen terminalleri için köprü adresini seçin' : 'Terminaller hangi ağdaysa o ağdaki adresi seçin'}>
          <select className="inp" value={secim} onChange={(e) => setSecim(e.target.value)}>
            {secenekler.map((o) => <option key={o.kod} value={o.kod}>{o.ad}</option>)}
          </select>
        </Alan>
      )}
      {ipler.length === 0 && <div className="notice warn"><Icon name="wifiOff" /><p>Bu bilgisayar bir ağa bağlı görünmüyor. Terminaller sunucuya ulaşamaz.</p></div>}
      <div className="grid g2">
        <div className="qr-box">
          <b>1. Uygulamayı kur</b>
          {qr ? <img src={qr.apkQr} alt="APK indirme QR" /> : <div style={{ height: 220 }} />}
          <span className="small muted" style={{ textAlign: 'center' }}>Terminalin kamerası ya da tarayıcısıyla okutun:<br /><span className="mono">{qr?.url}/kur</span></span>
        </div>
        <div className="qr-box">
          <b>2. Sunucuya bağla</b>
          {qr ? <img src={qr.qr} alt="Cihaz ayar QR" /> : <div style={{ height: 220 }} />}
          <span className="small muted" style={{ textAlign: 'center' }}>Uygulamada Ayarlar › <b>QR ile kur</b> ve bunu okutun.</span>
        </div>
      </div>
      <div className="card card-pad">
        <div className="small muted" style={{ marginBottom: 6 }}>Elle girmek için (Ayarlar › Demo modu kapalı)</div>
        <dl className="kv">
          <dt>Sunucu adresi</dt><dd className="mono">{qr?.url}</dd>
          <dt>Cihaz anahtarı</dt><dd className="key">{cihaz.key}</dd>
          <dt>Cihaz adı</dt><dd className="mono">{cihaz.name}</dd>
        </dl>
      </div>
      <div className="notice info"><Icon name="info" /><p>Bu bilgisayarın güvenlik duvarında {durum?.port} numaralı TCP portu açık olmalı (kurulum programı açar). Sunucu bilgisayarının IP adresi değişmesin diye modemde sabit IP verilmesi önerilir.</p></div>
    </Modal>
  );
}

export default function Cihazlar() {
  const { toast, durum } = useApp();
  const { veri, hata, yukleniyor, yukle } = useVeri('/cihazlar');
  const [yeniAd, setYeniAd] = useState(null);
  const [qr, setQr] = useState(null);
  const [sor, onay] = useOnay();
  const ekle = async () => {
    try {
      const r = await api('/cihazlar', { method: 'POST', body: { name: yeniAd } });
      setYeniAd(null);
      await yukle();
      setQr({ id: r.id, key: r.key, name: yeniAd });
    } catch (e) {
      toast(e.message, true);
    }
  };
  const aktiflik = async (c) => {
    try {
      await api(`/cihaz/${c.id}`, { method: 'PUT', body: { active: !c.active } });
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const sil = async (c) => {
    if (!(await sor('Cihaz silinsin mi?', `${c.name} sunucuya bağlanamaz. Cihazda gönderilmemiş işlem varsa önce gönderilmesini bekleyin.`, { tamam: 'Sil', tehlike: true }))) return;
    try {
      await api(`/cihaz/${c.id}`, { method: 'DELETE' });
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const sonraki = `TRM-${String((veri?.length || 0) + 1).padStart(2, '0')}`;
  return (
    <>
      <SayfaBaslik baslik="Cihazlar" alt="Sunucuya bağlanmasına izin verilen el terminalleri ve telefonlar">
        <Btn kind="primary" icon="plus" onClick={() => setYeniAd(sonraki)}>Yeni cihaz</Btn>
      </SayfaBaslik>
      {durum?.apk ? (
        <div className="notice info" style={{ marginBottom: 14 }}>
          <Icon name="download" />
          <p>Terminal uygulaması sürüm <b>{durum.apk.versionName}</b> bu programla birlikte geliyor. Terminaller <span className="mono">http://{durum.adresler[0]?.ip}:{durum.port}/kur</span> adresinden indirir; yeni sürüm çıkınca uygulama kendisi haber verir.</p>
        </div>
      ) : (
        <div className="notice warn" style={{ marginBottom: 14 }}><Icon name="warning" /><p>Bu kurulumda terminal APK'sı yok.</p></div>
      )}
      <div className="card">
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && veri.length === 0 && 'Henüz cihaz yok. "Yeni cihaz" ile ekleyip QR kodu terminale okutun.'}>
          <table className="tbl">
            <thead><tr><th>Cihaz</th><th>Anahtar</th><th>Son bağlantı</th><th>Son kullanıcı</th><th>Uygulama</th><th /></tr></thead>
            <tbody>
              {veri?.map((c) => {
                const canli = c.last_seen && Date.now() - c.last_seen < 3 * 60 * 1000;
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <span className={`pill ${canli ? 'on' : 'off'}`} style={{ padding: '0 6px' }}>{canli ? '●' : '○'}</span>
                        <b>{c.name}</b>
                        {!c.active && <Rozet tur="b-err">engelli</Rozet>}
                      </div>
                      {c.last_name && c.last_name !== c.name && <div className="muted small">terminalde: {c.last_name}</div>}
                    </td>
                    <td className="mono">{c.key}</td>
                    <td className="muted">{once(c.last_seen)}{c.last_ip ? ` · ${c.last_ip}` : ''}</td>
                    <td>{c.last_user || '—'}</td>
                    <td className="mono small">{c.app_version || '—'}{kilitDestegiYok(c.app_version) && <div><Rozet tur="b-warn">kilit desteği yok</Rozet></div>}</td>
                    <td>
                      <div className="btns" style={{ justifyContent: 'flex-end' }}>
                        <Btn size="sm" icon="qr" onClick={() => setQr(c)}>Kurulum QR</Btn>
                        <Btn size="sm" onClick={() => aktiflik(c)}>{c.active ? 'Engelle' : 'İzin ver'}</Btn>
                        <Btn size="sm" kind="danger ghost" icon="trash" onClick={() => sil(c)} title="Sil" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Durum>
      </div>
      {yeniAd !== null && (
        <Modal baslik="Yeni cihaz" kapat={() => setYeniAd(null)} alt={<><Btn onClick={() => setYeniAd(null)}>Vazgeç</Btn><Btn kind="primary" onClick={ekle}>Ekle</Btn></>}>
          <Alan etiket="Cihaz adı" ipucu="Terminalin üstüne yazılan ad; hareketlerde görünür"><input className="inp mono" value={yeniAd} onChange={(e) => setYeniAd(e.target.value.toUpperCase())} autoFocus onKeyDown={(e) => e.key === 'Enter' && ekle()} /></Alan>
        </Modal>
      )}
      {qr && <QrPenceresi cihaz={qr} kapat={() => setQr(null)} />}
      {onay}
    </>
  );
}
