import React, { useMemo, useState } from 'react';
import { Alan, api, Ara, Btn, Durum, HAREKET, Icon, indir, miktar, Modal, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';
import EtiketPenceresi from './Etiket.jsx';

function aralik(metin) {
  // "A-C" → A,B,C · "A,B,D" → A,B,D · "1-12" → 1..12
  const out = [];
  for (const parca of String(metin).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\w+)\s*-\s*(\w+)$/.exec(parca);
    if (m && /^\d+$/.test(m[1]) && /^\d+$/.test(m[2])) {
      for (let i = Number(m[1]); i <= Number(m[2]) && out.length < 500; i++) out.push(i);
    } else if (m && /^[A-Za-z]$/.test(m[1]) && /^[A-Za-z]$/.test(m[2])) {
      for (let c = m[1].toUpperCase().charCodeAt(0); c <= m[2].toUpperCase().charCodeAt(0); c++) out.push(String.fromCharCode(c));
    } else out.push(/^\d+$/.test(parca) ? Number(parca) : parca.toUpperCase());
  }
  return out;
}

function TopluOlustur({ kapat, tamam }) {
  const { toast } = useApp();
  const [bolge, setBolge] = useState('A-C');
  const [koridor, setKoridor] = useState('1-10');
  const [kat, setKat] = useState('1-4');
  const [goz, setGoz] = useState('');
  const [ayrac, setAyrac] = useState('-');
  const [hane, setHane] = useState(2);
  const [mesgul, setMesgul] = useState(false);
  const kodlar = useMemo(() => {
    const p = (x) => (typeof x === 'number' ? String(x).padStart(hane, '0') : x);
    const out = [];
    const gozler = goz.trim() ? aralik(goz) : [null];
    for (const b of aralik(bolge)) for (const k of aralik(koridor)) for (const t of aralik(kat)) for (const g of gozler) {
      out.push([b, p(k), p(t), ...(g === null ? [] : [p(g)])].join(ayrac));
      if (out.length > 5000) return out;
    }
    return out;
  }, [bolge, koridor, kat, goz, ayrac, hane]);
  const olustur = async () => {
    setMesgul(true);
    try {
      const r = await api('/raflar', { method: 'POST', body: { kodlar } });
      toast(`${r.eklenen} yeni raf eklendi${r.toplam > r.eklenen ? ` (${r.toplam - r.eklenen} zaten vardı)` : ''}`);
      tamam(kodlar);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal genis baslik="Toplu raf oluştur" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" busy={mesgul} disabled={!kodlar.length || kodlar.length > 5000} onClick={olustur}>{kodlar.length} raf oluştur</Btn></>}>
      <p className="muted" style={{ margin: 0 }}>Raf kodu bölge, koridor ve kattan oluşur: <span className="mono">A-03-02</span> = A bölgesi, 3. koridor/dolap, 2. kat. Aralık için tire, liste için virgül.</p>
      <div className="grid g3">
        <Alan etiket="Bölge" ipucu="A-C ya da A,B,E"><input className="inp mono" value={bolge} onChange={(e) => setBolge(e.target.value)} /></Alan>
        <Alan etiket="Koridor / dolap" ipucu="1-10"><input className="inp mono" value={koridor} onChange={(e) => setKoridor(e.target.value)} /></Alan>
        <Alan etiket="Kat" ipucu="1-4"><input className="inp mono" value={kat} onChange={(e) => setKat(e.target.value)} /></Alan>
        <Alan etiket="Göz (isteğe bağlı)" ipucu="Boş bırakılabilir"><input className="inp mono" value={goz} onChange={(e) => setGoz(e.target.value)} /></Alan>
        <Alan etiket="Ayraç"><select className="inp" value={ayrac} onChange={(e) => setAyrac(e.target.value)}><option value="-">Tire (A-01-02)</option><option value=".">Nokta (A.01.02)</option><option value="">Yok (A0102)</option></select></Alan>
        <Alan etiket="Sayı hanesi"><select className="inp" value={hane} onChange={(e) => setHane(Number(e.target.value))}><option value={1}>1 (A-1-2)</option><option value={2}>2 (A-01-02)</option><option value={3}>3 (A-001-002)</option></select></Alan>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>Önizleme · {kodlar.length > 5000 ? 'en çok 5000 raf' : `${kodlar.length} raf`}</div>
        <div className="chip-list" style={{ maxHeight: 130, overflow: 'auto' }}>
          {kodlar.slice(0, 60).map((k) => <span className="chip" key={k}>{k}</span>)}
          {kodlar.length > 60 && <span className="chip">… {kodlar.at(-1)}</span>}
        </div>
      </div>
    </Modal>
  );
}

function TekEkle({ kapat, tamam }) {
  const { toast } = useApp();
  const [kod, setKod] = useState('');
  const [not, setNot] = useState('');
  const ekle = async (e) => {
    e?.preventDefault();
    try {
      await api('/raflar', { method: 'POST', body: { kodlar: kod.split(/[\s,;]+/).filter(Boolean), note: not } });
      toast('Raf eklendi');
      tamam();
    } catch (er) {
      toast(er.message, true);
    }
  };
  return (
    <Modal baslik="Raf ekle" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" onClick={ekle}>Ekle</Btn></>}>
      <form onSubmit={ekle} className="stack">
        <Alan etiket="Raf kodu" ipucu="Birden çok için boşluk ya da virgülle ayırın"><input className="inp mono" value={kod} onChange={(e) => setKod(e.target.value.toUpperCase())} autoFocus /></Alan>
        <Alan etiket="Not"><input className="inp" value={not} onChange={(e) => setNot(e.target.value)} placeholder="Örnek: soğuk oda, ağır parça" /></Alan>
      </form>
    </Modal>
  );
}

export default function Raflar() {
  const { toast } = useApp();
  const { veri, hata, yukleniyor, yukle } = useVeri('/raflar');
  const [q, setQ] = useState('');
  const [bolge, setBolge] = useState('');
  const [dolu, setDolu] = useState('hepsi');
  const [secili, setSecili] = useState(new Set());
  const [pencere, setPencere] = useState(null);
  const bolgeler = useMemo(() => [...new Set((veri || []).map((r) => r.zone))].sort(), [veri]);
  const liste = useMemo(() => {
    const a = q.trim().toUpperCase();
    return (veri || []).filter((r) => (!a || r.code.includes(a) || r.note.toUpperCase().includes(a)) && (!bolge || r.zone === bolge) && (dolu === 'hepsi' || (dolu === 'dolu' ? r.cesit > 0 : r.cesit === 0)));
  }, [veri, q, bolge, dolu]);
  const hepsiSecili = liste.length > 0 && liste.every((r) => secili.has(r.code));
  const tumunuSec = () => setSecili(hepsiSecili ? new Set() : new Set(liste.map((r) => r.code)));
  const sec = (c) => setSecili((s) => {
    const n = new Set(s);
    if (n.has(c)) n.delete(c);
    else n.add(c);
    return n;
  });
  const etiketRaflari = (veri || []).filter((r) => secili.has(r.code));
  return (
    <>
      <SayfaBaslik baslik="Raflar" alt={veri ? `${veri.length} raf · ${veri.filter((r) => r.cesit).length} dolu` : ''}>
        <Btn icon="export" onClick={() => indir('/raflar.csv', 'raflar.csv').catch((e) => toast(e.message, true))}>CSV</Btn>
        <Btn icon="plus" onClick={() => setPencere('tek')}>Raf ekle</Btn>
        <Btn kind="primary" icon="layers" onClick={() => setPencere('toplu')}>Toplu raf oluştur</Btn>
      </SayfaBaslik>
      <div className="card">
        <div className="toolbar">
          <Ara deger={q} degis={setQ} yer="Raf kodu ya da not" />
          <select className="inp" style={{ width: 150 }} value={bolge} onChange={(e) => setBolge(e.target.value)}>
            <option value="">Tüm bölgeler</option>
            {bolgeler.map((b) => <option key={b} value={b}>{b} bölgesi</option>)}
          </select>
          <Secim deger={dolu} degis={setDolu} secenekler={[['hepsi', 'Hepsi'], ['dolu', 'Dolu'], ['bos', 'Boş']]} />
          <div className="grow" />
          <Btn icon="printer" disabled={!secili.size} onClick={() => setPencere('etiket')}>Etiket yazdır{secili.size ? ` (${secili.size})` : ''}</Btn>
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={liste.length === 0 && (veri?.length ? 'Eşleşen raf yok.' : 'Henüz raf yok. "Toplu raf oluştur" ile başlayın.')}>
          <div className="tbl-wrap tbl-scroll" style={{ maxHeight: 'calc(100vh - 240px)' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={hepsiSecili} onChange={tumunuSec} aria-label="Hepsini seç" /></th>
                  <th>Raf</th><th>Bölge</th><th className="num">Ürün çeşidi</th><th className="num">Toplam miktar</th><th>Son hareket</th><th>Not</th>
                </tr>
              </thead>
              <tbody>
                {liste.map((r) => (
                  <tr key={r.code} className="click" onClick={() => (window.location.hash = `/raf/${encodeURIComponent(r.code)}`)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={secili.has(r.code)} onChange={() => sec(r.code)} /></td>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.code}</td>
                    <td className="muted">{r.zone}</td>
                    <td className="num">{r.cesit || ''}</td>
                    <td className="num">{r.miktar ? miktar(r.miktar) : ''}</td>
                    <td className="muted">{r.sonHareket ? tarihSaat(r.sonHareket) : ''}</td>
                    <td className="muted">{r.note}{r.source === 'TERMINAL' && <Rozet tur="b-info">terminalde açıldı</Rozet>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Durum>
      </div>
      {pencere === 'toplu' && <TopluOlustur kapat={() => setPencere(null)} tamam={(k) => { setPencere(null); setSecili(new Set(k)); yukle(); }} />}
      {pencere === 'tek' && <TekEkle kapat={() => setPencere(null)} tamam={() => { setPencere(null); yukle(); }} />}
      {pencere === 'etiket' && <EtiketPenceresi tur="raf" kodlar={etiketRaflari.map((r) => r.code)} kapat={() => setPencere(null)} />}
    </>
  );
}

export function RafDetay({ kod }) {
  const { toast } = useApp();
  const { veri: d, hata, yukleniyor } = useVeri(`/raf/${encodeURIComponent(kod)}`);
  const [sor, onay] = useOnay();
  const [etiket, setEtiket] = useState(false);
  const [not, setNot] = useState(null);
  const sil = async () => {
    if (!(await sor('Raf silinsin mi?', `${kod} rafı tanımlardan kalkar. Terminaller bir sonraki eşitlemede bu rafı tanımaz.`, { tamam: 'Sil', tehlike: true }))) return;
    try {
      await api(`/raf/${encodeURIComponent(kod)}`, { method: 'DELETE' });
      toast('Raf silindi');
      window.location.hash = '/raflar';
    } catch (e) {
      toast(e.message, true);
    }
  };
  const notKaydet = async () => {
    try {
      await api(`/raf/${encodeURIComponent(kod)}`, { method: 'PUT', body: { note: not } });
      setNot(null);
      toast('Kaydedildi');
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <Durum yukleniyor={yukleniyor && !d} hata={hata}>
      {d && (
        <>
          <SayfaBaslik baslik={<span className="mono">{kod}</span>} alt={d.raf ? `${d.raf.zone} bölgesi${d.raf.note ? ' · ' + d.raf.note : ''}` : 'Tanımlı değil'} geri={['/raflar', 'Raflar']}>
            {d.raf && <Btn icon="edit" onClick={() => setNot(d.raf.note || '')}>Not</Btn>}
            {d.raf && <Btn icon="printer" onClick={() => setEtiket(true)}>Etiket</Btn>}
            {d.raf && <Btn kind="danger" icon="trash" onClick={sil}>Sil</Btn>}
          </SayfaBaslik>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><Icon name="box" /><h2>Raftaki ürünler</h2><div className="grow" /><span className="muted">{d.icerik.length} çeşit</span></div>
            {d.icerik.length === 0 ? (
              <div className="empty">Raf boş.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Ürün</th><th className="num">Miktar</th><th>Son değişiklik</th></tr></thead>
                <tbody>
                  {d.icerik.map((u) => (
                    <tr key={u.productId} className="click" onClick={() => (window.location.hash = `/urun/${u.productId}`)}>
                      <td><div className="name">{u.name}</div><div className="code">{u.code}</div></td>
                      <td className="num">{miktar(u.qty)} <span className="muted small">{u.unit}</span></td>
                      <td className="muted">{tarihSaat(u.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <div className="card-head"><Icon name="history" /><h2>Son hareketler</h2></div>
            {d.hareketler.length === 0 ? (
              <div className="empty">Hareket yok.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Zaman</th><th>Tür</th><th>Ürün</th><th className="num">Miktar</th><th>Kim</th></tr></thead>
                <tbody>
                  {d.hareketler.map((h) => (
                    <tr key={h.id}>
                      <td className="muted">{tarihSaat(h.ts)}</td>
                      <td><Rozet tur={(HAREKET[h.kind] || [])[1]}>{(HAREKET[h.kind] || [h.kind])[0]}</Rozet></td>
                      <td><div className="name">{h.urunAd}</div><div className="code">{h.urunKod}</div></td>
                      <td className={`num ${h.delta > 0 ? 'pos' : h.delta < 0 ? 'neg' : ''}`}>{miktar(h.delta, true)}</td>
                      <td className="muted">{h.user || '—'}{h.device ? ` · ${h.device}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {etiket && <EtiketPenceresi tur="raf" kodlar={[d.raf.code]} kapat={() => setEtiket(false)} />}
          {not !== null && (
            <Modal baslik="Raf notu" kapat={() => setNot(null)} alt={<><Btn onClick={() => setNot(null)}>Vazgeç</Btn><Btn kind="primary" onClick={notKaydet}>Kaydet</Btn></>}>
              <input className="inp" value={not} onChange={(e) => setNot(e.target.value)} autoFocus />
            </Modal>
          )}
          {onay}
        </>
      )}
    </Durum>
  );
}
