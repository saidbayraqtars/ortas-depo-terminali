import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, belirtecYaz, Btn, Ctx, Icon, oturumDinle, useHash } from './lib.jsx';
import Ozet from './sayfalar/Ozet.jsx';
import Kabul, { KabulDetay } from './sayfalar/Kabul.jsx';
import Urunler, { UrunDetay } from './sayfalar/Urunler.jsx';
import Raflar, { RafDetay } from './sayfalar/Raflar.jsx';
import Sayimlar, { SayimDetay } from './sayfalar/Sayimlar.jsx';
import Bekleme from './sayfalar/Bekleme.jsx';
import Transferler from './sayfalar/Transferler.jsx';
import VegaYazimlari from './sayfalar/VegaYazimlari.jsx';
import Hareketler from './sayfalar/Hareketler.jsx';
import Kullanicilar from './sayfalar/Kullanicilar.jsx';
import Cihazlar from './sayfalar/Cihazlar.jsx';
import Ayarlar from './sayfalar/Ayarlar.jsx';

const MENU = [
  ['/ozet', 'home', 'Özet'],
  ['/kabul', 'package', 'Mal kabul', (d) => d?.sayilar.acikBelge],
  ['/bekleme', 'calendar', 'Bekleme depoları'],
  ['/urunler', 'box', 'Ürün ve stok'],
  ['/raflar', 'layers', 'Raflar'],
  ['/sayimlar', 'count', 'Sayımlar', (d) => d?.sayilar.onayBekleyen],
  ['/transfer', 'truck', 'Depo transferi', (d) => d?.sayilar.transferDikkat],
  ['/hareketler', 'history', 'Hareketler'],
  ['/vega-yazimlari', 'undo', "Vega'ya yazılanlar"],
  ['/kullanicilar', 'users', 'Kullanıcılar'],
  ['/cihazlar', 'mobile', 'Cihazlar'],
  ['/ayarlar', 'settings', 'Ayarlar'],
];

function Sayfa({ yol }) {
  const [kok, a, b] = yol.split('/').filter(Boolean).concat(['', '']);
  const p = decodeURIComponent(a || '');
  switch (kok) {
    case 'kabul':
      return p ? <KabulDetay id={p} /> : <Kabul />;
    case 'urunler':
      return <Urunler />;
    case 'urun':
      return <UrunDetay id={p} />;
    case 'raflar':
      return <Raflar />;
    case 'raf':
      return <RafDetay depo={Number(p)} kod={decodeURIComponent(b || '')} />;
    case 'sayimlar':
      return <Sayimlar />;
    case 'sayim':
      return <SayimDetay id={p} />;
    case 'bekleme':
      return <Bekleme />;
    case 'transfer':
      return <Transferler />;
    case 'hareketler':
      return <Hareketler />;
    case 'vega-yazimlari':
      return <VegaYazimlari />;
    case 'kullanicilar':
      return <Kullanicilar />;
    case 'cihazlar':
      return <Cihazlar />;
    case 'ayarlar':
      return <Ayarlar />;
    default:
      return <Ozet />;
  }
}

function Giris({ tamam }) {
  const [parola, setParola] = useState('');
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState(null);
  useEffect(() => {
    api('/oturum').then(setBilgi).catch(() => {});
  }, []);
  const gir = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/oturum', { method: 'POST', body: { parola } });
      belirtecYaz(r.belirtec);
      tamam();
    } catch (er) {
      setHata(er.message);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={gir}>
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark"><Icon name="layers" /></div>
          <div><b>Ortaş Depo</b><span className="muted">Yönetici</span></div>
        </div>
        {bilgi && !bilgi.parolaVar ? (
          <div className="notice warn"><Icon name="lock" /><p>Ağdan yönetim için önce sunucu bilgisayarında Ayarlar › Güvenlik'ten yönetici parolası belirleyin.</p></div>
        ) : (
          <>
            <label className="field">
              <span>Yönetici parolası</span>
              <input className="inp" type="password" value={parola} onChange={(e) => setParola(e.target.value)} autoFocus />
            </label>
            {hata && <div className="notice err"><p>{hata}</p></div>}
            <button className="btn primary" type="submit">Giriş</button>
          </>
        )}
      </form>
    </div>
  );
}

export default function App() {
  const yol = useHash();
  const [durum, setDurum] = useState(null);
  const [surum, setSurum] = useState(0);
  // Yönetim ekranının depo süzgeci: '' = bütün depolar. Bu bilgisayarda hatırlanır.
  const [depo, setDepoState] = useState(() => {
    try {
      return localStorage.getItem('ortas-depo') || '';
    } catch {
      return '';
    }
  });
  const setDepo = (d) => {
    setDepoState(d);
    try {
      localStorage.setItem('ortas-depo', d);
    } catch {}
  };
  const [oturum, setOturum] = useState(null); // null: bilinmiyor
  const [toasts, setToasts] = useState([]);
  const tid = useRef(0);

  const toast = useCallback((metin, hata = false) => {
    const id = ++tid.current;
    setToasts((t) => [...t, { id, metin, hata }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), hata ? 7000 : 3500);
  }, []);

  const durumAl = useCallback(async () => {
    try {
      const d = await api('/durum');
      setDurum(d);
      setSurum((s) => (s !== d.degisiklik ? d.degisiklik : s));
    } catch {}
  }, []);

  useEffect(() => {
    oturumDinle(() => setOturum(false));
    api('/oturum')
      .then((o) => setOturum(o.girildi))
      .catch(() => setOturum(false));
  }, []);

  useEffect(() => {
    if (!oturum) return;
    durumAl();
    const t = setInterval(durumAl, 5000);
    return () => clearInterval(t);
  }, [oturum, durumAl]);

  if (oturum === null) return null;
  if (!oturum) return <Giris tamam={() => setOturum(true)} />;

  const aktif = '/' + (yol.split('/')[1] || 'ozet');
  const esle = { '/kabul': '/kabul', '/urun': '/urunler', '/raf': '/raflar', '/sayim': '/sayimlar' };
  const secili = esle[aktif] || aktif;
  const v = durum?.vega;

  return (
    <Ctx.Provider value={{ surum, toast, durum, yenile: durumAl, depo, setDepo }}>
      <div className="shell">
        <nav className="side">
          <div className="brand">
            <div className="brand-mark"><Icon name="layers" /></div>
            <div><b>Ortaş Depo</b><span>Yönetici</span></div>
          </div>
          {(durum?.depolar?.length || 0) > 1 && (
            <select className="inp depo-sec" value={depo} onChange={(e) => setDepo(e.target.value)} title="Ekranlarda gösterilecek depo">
              <option value="">Bütün depolar</option>
              {durum.depolar.map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
            </select>
          )}
          {MENU.map(([h, ic, ad, say]) => {
            const n = say ? say(durum) : 0;
            return (
              <a key={h} href={'#' + h} className={`nav-item ${secili === h ? 'on' : ''}`} title={ad}>
                <Icon name={ic} size={19} />
                <span className="lbl">{ad}</span>
                {n > 0 && <span className="badge-n">{n}</span>}
              </a>
            );
          })}
          <div className="side-foot">
            <div className="row">
              {v?.ok ? (
                <span className="pill on"><Icon name="database" size={13} /> Vega bağlı</span>
              ) : v?.calisiyor || (v?.hazir && !v?.hata) ? (
                <span className="pill on"><Icon name="refresh" size={13} className="spin" /> Vega okunuyor</span>
              ) : (
                <span className="pill off" title={v?.hata || ''}><Icon name="wifiOff" size={13} /> Vega yok</span>
              )}
            </div>
            <div>Terminal adresi</div>
            {(durum?.adresler || []).slice(0, 2).map((a) => (
              <div key={a.ip} className="addr">http://{a.ip}:{durum.port}</div>
            ))}
            <div>Sürüm {durum?.surum}</div>
          </div>
        </nav>
        <main className="main">
          <div className="page">
            <Sayfa yol={yol} />
          </div>
        </main>
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.hata ? 'err' : ''}`}>
            <Icon name={t.hata ? 'alert' : 'check'} size={16} /> {t.metin}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export { Btn };
