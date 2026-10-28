import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ICONS } from './iconData.js';

// ---- API ---------------------------------------------------------------------------------------

const TOKEN = 'ortas-yonetici-belirtec';

export function belirtec() {
  try {
    return localStorage.getItem(TOKEN) || '';
  } catch {
    return '';
  }
}

export function belirtecYaz(t) {
  try {
    if (t) localStorage.setItem(TOKEN, t);
    else localStorage.removeItem(TOKEN);
  } catch {}
}

let oturumDustu = () => {};
export function oturumDinle(f) {
  oturumDustu = f;
}

export async function api(yol, { method = 'GET', body } = {}) {
  const r = await fetch('/yonetim/api' + yol, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Yonetici': belirtec() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d = null;
  try {
    d = t ? JSON.parse(t) : null;
  } catch {
    d = t;
  }
  if (r.status === 401 && yol !== '/oturum') oturumDustu();
  if (!r.ok) throw new Error((d && d.error) || `Hata ${r.status}`);
  return d;
}

/** CSV vb. indirme: oturum başlığı gerektiği için fetch ile alınıp kaydedilir. */
export async function indir(yol, ad) {
  const r = await fetch('/yonetim/api' + yol, { headers: { 'X-Yonetici': belirtec() } });
  if (!r.ok) throw new Error(`İndirilemedi (${r.status})`);
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ad;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Biçim -------------------------------------------------------------------------------------

export function miktar(x, imza = false) {
  const n = Number(x) || 0;
  const s = Math.abs(n) % 1 === 0 ? Math.abs(n).toLocaleString('tr-TR') : Math.abs(n).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
  if (n < 0) return '−' + s;
  return (imza && n > 0 ? '+' : '') + s;
}

export function tarihSaat(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

export function once(ts) {
  if (!ts) return 'hiç';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return tarihSaat(ts);
}

export const HAREKET = {
  PUTAWAY: ['Rafa kaldırma', 'b-ok'],
  TRANSFER_IN: ['Transfer giriş', 'b-info'],
  TRANSFER_OUT: ['Transfer çıkış', 'b-info'],
  PICK: ['Raftan alma', 'b-warn'],
  TRANSFER_OUT_DEPO: ['Depoya gönderim', 'b-info'],
  TRANSFER_IN_DEPO: ['Depodan kabul', 'b-ok'],
  COUNT: ['Sayım', 'b-acc'],
  IMPORT: ['Excel', 'b-mute'],
  ADJUST: ['Düzeltme', 'b-warn'],
};

export const SAYIM_DURUM = {
  OPEN: ['Sayılıyor', 'b-info'],
  CLOSED: ['Onay bekliyor', 'b-warn'],
  APPROVED: ['Onaylandı', 'b-ok'],
  CANCELLED: ['İptal', 'b-mute'],
};

// ---- Yönlendirme (hash) ------------------------------------------------------------------------

export function useHash() {
  const [h, setH] = useState(() => window.location.hash.slice(1) || '/ozet');
  useEffect(() => {
    const f = () => setH(window.location.hash.slice(1) || '/ozet');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

export function git(yol) {
  window.location.hash = yol;
}

// ---- Bağlam: değişiklik sayacı ve bildirimler ------------------------------------------------

export const Ctx = createContext({ surum: 0, toast: () => {}, durum: null, yenile: () => {} });
export const useApp = () => useContext(Ctx);

/** Depo süzgeci ve depo listesi. `qs`: istek sonuna eklenecek "&depo=.." (bütün depolarda boş). */
export function useDepo() {
  const { depo, setDepo, durum } = useApp();
  const depolar = durum?.depolar || [];
  const ad = (ind) => depolar.find((d) => d.ind === Number(ind))?.ad || String(ind ?? '');
  return { depo, setDepo, depolar, ad, cok: depolar.length > 1, varsayilan: durum?.varsayilanDepo, qs: depo ? `&depo=${depo}` : '' };
}

/** Sunucu verisi; sunucuda değişiklik olunca (surum) kendiliğinden yeniden yüklenir. */
export function useVeri(yol, bag = []) {
  const { surum } = useApp();
  const [veri, setVeri] = useState(null);
  const [hata, setHata] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const son = useRef(0);
  const yukle = useCallback(async () => {
    if (!yol) return;
    const no = ++son.current;
    setYukleniyor(true);
    try {
      const d = await api(yol);
      if (no === son.current) {
        setVeri(d);
        setHata(null);
      }
    } catch (e) {
      if (no === son.current) setHata(e.message);
    } finally {
      if (no === son.current) setYukleniyor(false);
    }
  }, [yol]);
  useEffect(() => {
    yukle();
  }, [yukle, surum, ...bag]);
  return { veri, hata, yukleniyor, yukle, setVeri };
}

// ---- Bileşenler --------------------------------------------------------------------------------

export function Icon({ name, size = 18, className = '' }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} />;
}

export function Btn({ icon, children, kind = '', size = '', busy = false, ...rest }) {
  return (
    <button type="button" className={`btn ${kind} ${size}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Icon name="refresh" size={16} className="spin" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function Modal({ baslik, kapat, children, alt, genis = false }) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && kapat();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [kapat]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && kapat()}>
      <div className={`modal ${genis ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{baslik}</h2>
          <Btn kind="ghost" size="sm" icon="x" onClick={kapat} aria-label="Kapat" />
        </div>
        <div className="modal-body">{children}</div>
        {alt && <div className="modal-foot">{alt}</div>}
      </div>
    </div>
  );
}

export function Alan({ etiket, ipucu, children }) {
  return (
    <label className="field">
      <span>{etiket}</span>
      {children}
      {ipucu && <small className="hint">{ipucu}</small>}
    </label>
  );
}

export function Durum({ yukleniyor, hata, bos, children }) {
  if (hata) return <div className="notice err" style={{ margin: 16 }}><Icon name="alert" /><p>{hata}</p></div>;
  if (yukleniyor) return <div className="empty"><Icon name="refresh" className="spin" /></div>;
  if (bos) return <div className="empty">{bos}</div>;
  return children;
}

export function Rozet({ tur, children }) {
  return <span className={`badge ${tur}`}>{children}</span>;
}

export function Ara({ deger, degis, yer = 'Ara…', otomatik = false }) {
  return (
    <div className="search" style={{ minWidth: 240, flex: '0 1 340px' }}>
      <Icon name="search" size={16} />
      <input className="inp" value={deger} onChange={(e) => degis(e.target.value)} placeholder={yer} autoFocus={otomatik} />
    </div>
  );
}

export function Secim({ secenekler, deger, degis }) {
  return (
    <div className="seg">
      {secenekler.map(([k, ad]) => (
        <button key={k} className={deger === k ? 'on' : ''} onClick={() => degis(k)} type="button">
          {ad}
        </button>
      ))}
    </div>
  );
}

export function Ilerleme({ oran }) {
  return (
    <div className="progress" title={`%${Math.round(oran * 100)}`}>
      <i style={{ width: `${Math.max(0, Math.min(1, oran)) * 100}%` }} />
    </div>
  );
}

export function SayfaBaslik({ baslik, alt, geri, children }) {
  return (
    <>
      {geri && (
        <a className="back" href={'#' + geri[0]}>
          <Icon name="chevronLeft" size={16} /> {geri[1]}
        </a>
      )}
      <div className="page-head">
        <div>
          <h1>{baslik}</h1>
          {alt && <div className="sub">{alt}</div>}
        </div>
        <div className="grow" />
        {children}
      </div>
    </>
  );
}

/** Onay soran düğme: tıklanınca pencere açar. */
export function useOnay() {
  const [s, setS] = useState(null);
  const sor = (baslik, metin, { tamam = 'Evet', tehlike = false } = {}) =>
    new Promise((res) => setS({ baslik, metin, tamam, tehlike, res }));
  const pencere = s && (
    <Modal
      baslik={s.baslik}
      kapat={() => { s.res(false); setS(null); }}
      alt={
        <>
          <Btn onClick={() => { s.res(false); setS(null); }}>Vazgeç</Btn>
          <Btn kind={s.tehlike ? 'danger solid' : 'primary'} onClick={() => { s.res(true); setS(null); }}>{s.tamam}</Btn>
        </>
      }
    >
      <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{s.metin}</p>
    </Modal>
  );
  return [sor, pencere];
}
