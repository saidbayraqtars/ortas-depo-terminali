import React, { useEffect, useMemo, useState } from 'react';
import { Alan, api, Ara, Btn, Durum, HAREKET, Icon, indir, miktar, Modal, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useDepo, useOnay, useVeri } from '../lib.jsx';
import EtiketPenceresi from './Etiket.jsx';
import { Tasi } from './Urunler.jsx';
import { kaliptan, RAF_DESEN } from '../kalip.mjs';

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

/** Yeni raflar hangi depoya: süzgeçteki depo, yoksa varsayılan; "hepsi" kullanılan bütün depolar. */
function DepoSec({ deger, degis }) {
  const { depolar, cok } = useDepo();
  if (!cok) return null;
  return (
    <Alan etiket="Depo" ipucu="Terminal rafı yalnız tanımlı olduğu depoda kabul eder">
      <select className="inp" value={deger} onChange={(e) => degis(e.target.value)}>
        <option value="hepsi">Bütün depolar</option>
        {depolar.map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
      </select>
    </Alan>
  );
}

function useYeniDepo() {
  const { depo, varsayilan, depolar } = useDepo();
  return useState(String(depo || varsayilan || depolar[0]?.ind || ''));
}

function TopluOlustur({ kapat, tamam }) {
  const { toast } = useApp();
  const [depo, setDepo] = useYeniDepo();
  const [bolge, setBolge] = useState('A-C');
  const [koridor, setKoridor] = useState('1-10');
  const [kat, setKat] = useState('1-4');
  const [goz, setGoz] = useState('');
  const [ayrac, setAyrac] = useState('-');
  const [hane, setHane] = useState(2);
  const [tur, setTur] = useState('kalip');
  const [kalip, setKalip] = useState('TK[1-10]-H[1-9]');
  const [mesgul, setMesgul] = useState(false);
  const { depolar } = useDepo();
  const kodlar = useMemo(() => {
    if (tur === 'kalip') return kaliptan(kalip);
    const p = (x) => (typeof x === 'number' ? String(x).padStart(hane, '0') : x);
    const out = [];
    const gozler = goz.trim() ? aralik(goz) : [null];
    for (const b of aralik(bolge)) for (const k of aralik(koridor)) for (const t of aralik(kat)) for (const g of gozler) {
      out.push([b, p(k), p(t), ...(g === null ? [] : [p(g)])].join(ayrac));
      if (out.length > 5000) return out;
    }
    return out;
  }, [tur, kalip, bolge, koridor, kat, goz, ayrac, hane]);
  const hatali = useMemo(() => kodlar.filter((k) => !RAF_DESEN.test(k)), [kodlar]);
  const olustur = async () => {
    setMesgul(true);
    try {
      const r = await api('/raflar', { method: 'POST', body: { kodlar, depo } });
      toast(`${r.eklenen} yeni raf eklendi${r.toplam > r.eklenen ? ` (${r.toplam - r.eklenen} zaten vardı)` : ''}`);
      // Etiket için seçili kalır; bütün depolarda açılınca aynı kod bir kez seçilir.
      tamam(kodlar.map((k) => `${depo === 'hepsi' ? depolar[0]?.ind : depo}|${k}`));
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal genis baslik="Toplu raf oluştur" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" busy={mesgul} disabled={!kodlar.length || kodlar.length > 5000 || hatali.length > 0} onClick={olustur}>{kodlar.length} raf oluştur</Btn></>}>
      <DepoSec deger={depo} degis={setDepo} />
      <Secim deger={tur} degis={setTur} secenekler={[['kalip', 'Kalıpla (TK2-H1)'], ['parca', 'Bölge / koridor / kat (A-01-02)']]} />
      {tur === 'kalip' ? (
        <Alan etiket="Kalıp" ipucu="Köşeli parantez içi aralık ya da liste: [1-20], [A-H], [01-12] (iki hane), [H,K,M]. Gerisi olduğu gibi yazılır.">
          <input className="inp mono" value={kalip} onChange={(e) => setKalip(e.target.value)} autoFocus />
        </Alan>
      ) : (
      <>
      <p className="muted" style={{ margin: 0 }}>Raf kodu bölge, koridor ve kattan oluşur: <span className="mono">A-03-02</span> = A bölgesi, 3. koridor/dolap, 2. kat. Aralık için tire, liste için virgül.</p>
      <div className="grid g3">
        <Alan etiket="Bölge" ipucu="A-C ya da A,B,E"><input className="inp mono" value={bolge} onChange={(e) => setBolge(e.target.value)} /></Alan>
        <Alan etiket="Koridor / dolap" ipucu="1-10"><input className="inp mono" value={koridor} onChange={(e) => setKoridor(e.target.value)} /></Alan>
        <Alan etiket="Kat" ipucu="1-4"><input className="inp mono" value={kat} onChange={(e) => setKat(e.target.value)} /></Alan>
        <Alan etiket="Göz (isteğe bağlı)" ipucu="Boş bırakılabilir"><input className="inp mono" value={goz} onChange={(e) => setGoz(e.target.value)} /></Alan>
        <Alan etiket="Ayraç"><select className="inp" value={ayrac} onChange={(e) => setAyrac(e.target.value)}><option value="-">Tire (A-01-02)</option><option value=".">Nokta (A.01.02)</option><option value="">Yok (A0102)</option></select></Alan>
        <Alan etiket="Sayı hanesi"><select className="inp" value={hane} onChange={(e) => setHane(Number(e.target.value))}><option value={1}>1 (A-1-2)</option><option value={2}>2 (A-01-02)</option><option value={3}>3 (A-001-002)</option></select></Alan>
      </div>
      </>
      )}
      {hatali.length > 0 && (
        <div className="notice err"><Icon name="warning" /><p>Uygun olmayan raf kodu: <span className="mono">{hatali.slice(0, 3).join(', ')}</span>{hatali.length > 3 ? ` ve ${hatali.length - 3} kod daha` : ''}. Raf kodu harf ya da rakamla başlar, en çok 24 karakterdir; harf, rakam, tire, nokta, eğik çizgi ve boşluk içerebilir.</p></div>
      )}
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
  const [depo, setDepo] = useYeniDepo();
  const [kod, setKod] = useState('');
  const [not, setNot] = useState('');
  const ekle = async (e) => {
    e?.preventDefault();
    try {
      await api('/raflar', { method: 'POST', body: { kodlar: kod.split(/[\s,;]+/).filter(Boolean), note: not, depo } });
      toast('Raf eklendi');
      tamam();
    } catch (er) {
      toast(er.message, true);
    }
  };
  return (
    <Modal baslik="Raf ekle" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" onClick={ekle}>Ekle</Btn></>}>
      <form onSubmit={ekle} className="stack">
        <DepoSec deger={depo} degis={setDepo} />
        <Alan etiket="Raf kodu" ipucu="Birden çok için boşluk ya da virgülle ayırın"><input className="inp mono" value={kod} onChange={(e) => setKod(e.target.value.toUpperCase())} autoFocus /></Alan>
        <Alan etiket="Not"><input className="inp" value={not} onChange={(e) => setNot(e.target.value)} placeholder="Örnek: soğuk oda, ağır parça" /></Alan>
      </form>
    </Modal>
  );
}

const ALAN_AD = { depo: 'Depo', raf: 'Raf', bolge: 'Bölge', not: 'Not', urun: 'Ürün kodu / barkod', miktar: 'Miktar' };

/** Excel / CSV'den raf: dosya → sütun eşleştirme → depo eşleştirme → önizleme → içe aktar. */
function IceAktar({ kapat, tamam }) {
  const { toast } = useApp();
  const { depolar, varsayilan, depo: secili } = useDepo();
  const [dosya, setDosya] = useState(null);
  const [eslesme, setEslesme] = useState({});
  const [sabitDepo, setSabitDepo] = useState(String(secili || varsayilan || depolar[0]?.ind || ''));
  const [depoEslesme, setDepoEslesme] = useState({});
  const [onizleme, setOnizleme] = useState(null);
  const [miktarModu, setMiktarModu] = useState('ayarla');
  const [mesgul, setMesgul] = useState('');

  const yukle = async (f) => {
    if (!f) return;
    setMesgul('oku');
    try {
      const icerik = await new Promise((ok, no) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] || '');
        r.onerror = () => no(new Error('Dosya okunamadı'));
        r.readAsDataURL(f);
      });
      const d = await api('/ice-aktar/oku', { method: 'POST', body: { ad: f.name, icerik } });
      setDosya({ ...d, ad: f.name });
      setEslesme(d.tahmin);
      setDepoEslesme({});
      onizle(d.anahtar, d.tahmin, {});
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };

  const onizle = async (anahtar, es, de, sd = sabitDepo) => {
    try {
      setOnizleme(await api('/ice-aktar/onizle', { method: 'POST', body: { anahtar, eslesme: es, depoEslesme: de, sabitDepo: es.depo === undefined ? sd : null } }));
    } catch (e) {
      toast(e.message, true);
    }
  };

  const esle = (alan, sutun) => {
    const yeni = { ...eslesme };
    if (sutun === '') delete yeni[alan];
    else yeni[alan] = Number(sutun);
    setEslesme(yeni);
    onizle(dosya.anahtar, yeni, depoEslesme);
  };

  const uygula = async () => {
    setMesgul('uygula');
    try {
      const r = await api('/ice-aktar/uygula', { method: 'POST', body: { anahtar: dosya.anahtar, eslesme, depoEslesme, sabitDepo: eslesme.depo === undefined ? sabitDepo : null, miktarModu } });
      toast(`${r.yeniRaf} yeni raf · ${r.miktar} raf miktarı · ${r.asilRaf} asıl raf${r.atlanan ? ` · ${r.atlanan} satır atlandı` : ''}`);
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };

  const o = onizleme?.ozet;
  return (
    <Modal
      genis
      baslik="Excel'den raf içe aktar"
      kapat={kapat}
      alt={
        <>
          <Btn icon="download" onClick={() => indir('/ice-aktar/sablon.xlsx', 'raf-sablonu.xlsx').catch((e) => toast(e.message, true))}>Şablon indir</Btn>
          <div style={{ flex: 1 }} />
          <Btn onClick={kapat}>Vazgeç</Btn>
          <Btn kind="primary" busy={mesgul === 'uygula'} disabled={!o || !o.satir || eslesme.raf === undefined} onClick={uygula}>{o ? `${o.satir} satırı içe aktar` : 'İçe aktar'}</Btn>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        B2B ya da başka programdan alınan depo/raf listesi. <b>Depo</b> ve <b>Raf</b> zorunlu; bir hücrede birden çok raf <b>;</b> ile
        ayrılabilir, uygun olmayan raf kodu atlanır; <b>Bölge</b>, <b>Not</b>,
        <b> Ürün</b> (kod ya da barkod) ve <b>Miktar</b> isteğe bağlı. Ürün + miktar o rafa o miktarı yazar (ilk yerleşim); miktarsız ürün,
        ürünün <b>asıl rafı</b> olur ve terminal rafa kaldırırken o rafı önerir.
      </p>
      <label className="btn" style={{ alignSelf: 'start' }}>
        <Icon name="folder" size={16} /> {mesgul === 'oku' ? 'Okunuyor…' : dosya ? dosya.ad : 'Dosya seç (.xlsx, .csv)'}
        <input type="file" accept=".xlsx,.csv,.txt" hidden onChange={(e) => yukle(e.target.files[0])} />
      </label>
      {dosya && (
        <>
          <div className="small muted">{dosya.toplam} satır · sütunları eşleştirin</div>
          <div className="grid g3">
            {Object.entries(ALAN_AD).map(([alan, ad]) => (
              <Alan key={alan} etiket={`${ad}${alan === 'raf' ? ' *' : ''}`}>
                <select className="inp" value={eslesme[alan] ?? ''} onChange={(e) => esle(alan, e.target.value)}>
                  <option value="">{alan === 'depo' ? '— hepsi tek depoya —' : '— yok —'}</option>
                  {dosya.basliklar.map((b, i) => <option key={i} value={i}>{b}</option>)}
                </select>
              </Alan>
            ))}
          </div>
          {eslesme.depo === undefined && (
            <Alan etiket="Bütün satırlar bu depoya" ipucu="Terminal rafı yalnız tanımlı olduğu depoda kabul eder; raf her depoda varsa Bütün depolar seçin">
              <select className="inp" value={sabitDepo} onChange={(e) => { setSabitDepo(e.target.value); onizle(dosya.anahtar, eslesme, depoEslesme, e.target.value); }}>
                {depolar.length > 1 && <option value="hepsi">Bütün depolar</option>}
                {depolar.map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
              </select>
            </Alan>
          )}
          {onizleme?.depolar?.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Depo eşleşmesi</h3><span className="muted small">Dosyadaki ad → Vega deposu</span></div>
              <table className="tbl">
                <tbody>
                  {onizleme.depolar.map((d) => (
                    <tr key={d.deger}>
                      <td className="mono">{d.deger || '(boş)'}</td>
                      <td className="muted small">{d.satir} satır</td>
                      <td style={{ width: 260 }}>
                        <select className="inp" value={depoEslesme[d.deger] ?? (d.depo ?? '')} onChange={(e) => { const yeni = { ...depoEslesme, [d.deger]: e.target.value }; setDepoEslesme(yeni); onizle(dosya.anahtar, eslesme, yeni); }}>
                          <option value="">— eşleşmedi, atla —</option>
                          {depolar.length > 1 && <option value="hepsi">Bütün depolar</option>}
                          {depolar.map((x) => <option key={x.ind} value={x.ind}>{x.ad}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {o && (
            <div className="grid g4">
              <div className="card stat"><span className="k">Geçerli satır</span><span className="v">{o.satir}</span></div>
              <div className="card stat"><span className="k">Raf</span><span className="v">{o.raf}</span><span className="s">{o.yeniRaf} yeni</span></div>
              <div className="card stat"><span className="k">Raf miktarı / asıl raf</span><span className="v">{o.miktarli} / {o.asilRaf}</span></div>
              <div className={`card stat ${o.hata ? 'warn' : ''}`}><span className="k">Atlanacak</span><span className="v">{o.hata}</span></div>
            </div>
          )}
          {o?.miktarli > 0 && (
            <Alan etiket="Miktarlı satırlar">
              <Secim deger={miktarModu} degis={setMiktarModu} secenekler={[['ayarla', 'Raf miktarını bu değere çek'], ['ekle', 'Rafta olanın üstüne ekle']]} />
            </Alan>
          )}
          {onizleme?.hatalar?.length > 0 && (
            <div className="tbl-scroll" style={{ maxHeight: 180, border: '1px solid var(--line)', borderRadius: 8 }}>
              <table className="tbl">
                <thead><tr><th>Satır</th><th>Neden atlanacak</th></tr></thead>
                <tbody>{onizleme.hatalar.map((h) => <tr key={h.satir}><td className="num">{h.satir}</td><td>{h.hata}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

const SAYFA_BOYU = 200;

export default function Raflar() {
  const { toast } = useApp();
  const { depo, qs, cok } = useDepo();
  const { veri, hata, yukleniyor, yukle } = useVeri(`/raflar?x=1${qs}`, [qs]);
  const [q, setQ] = useState('');
  const [bolge, setBolge] = useState('');
  const [dolu, setDolu] = useState('hepsi');
  const [secili, setSecili] = useState(new Set());
  const [pencere, setPencere] = useState(null);
  const anahtar = (r) => `${r.depo}|${r.code}`;
  const bolgeler = useMemo(() => [...new Set((veri || []).map((r) => r.zone))].sort(), [veri]);
  const liste = useMemo(() => {
    const a = q.trim().toUpperCase();
    return (veri || []).filter((r) => (!a || r.code.includes(a) || r.note.toUpperCase().includes(a)) && (!bolge || r.zone === bolge) && (dolu === 'hepsi' || (dolu === 'dolu' ? r.cesit > 0 : dolu === 'bekleyen' ? r.bekleyen > 0 : r.cesit === 0)));
  }, [veri, q, bolge, dolu]);
  // 12 bin raflık listeyi tek seferde çizmek tarayıcıyı şişiriyor; sayfa sayfa göster.
  const [sayfa, setSayfa] = useState(0);
  useEffect(() => setSayfa(0), [q, bolge, dolu, depo]);
  const sayfaSayisi = Math.max(1, Math.ceil(liste.length / SAYFA_BOYU));
  const sayfaNo = Math.min(sayfa, sayfaSayisi - 1);
  const gorunen = useMemo(() => liste.slice(sayfaNo * SAYFA_BOYU, (sayfaNo + 1) * SAYFA_BOYU), [liste, sayfaNo]);
  const hepsiSecili = liste.length > 0 && liste.every((r) => secili.has(anahtar(r)));
  const tumunuSec = () => setSecili(hepsiSecili ? new Set() : new Set(liste.map(anahtar)));
  const sec = (c) => setSecili((s) => {
    const n = new Set(s);
    if (n.has(c)) n.delete(c);
    else n.add(c);
    return n;
  });
  const depoSutun = cok && !depo;
  return (
    <>
      <SayfaBaslik baslik="Raflar" alt={veri ? `${veri.length} raf · ${veri.filter((r) => r.cesit).length} dolu` : ''}>
        <Btn icon="export" onClick={() => indir(`/raflar.csv?x=1${qs}`, 'raflar.csv').catch((e) => toast(e.message, true))}>CSV</Btn>
        <Btn icon="upload" onClick={() => setPencere('ice')}>Excel'den içe aktar</Btn>
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
          <Secim deger={dolu} degis={setDolu} secenekler={[['hepsi', 'Hepsi'], ['dolu', 'Dolu'], ['bos', 'Boş'], ['bekleyen', 'Sayılmayı bekleyen']]} />
          <div className="grow" />
          <Btn icon="printer" disabled={!secili.size} onClick={() => setPencere('etiket')}>Etiket yazdır{secili.size ? ` (${secili.size})` : ''}</Btn>
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={liste.length === 0 && (veri?.length ? 'Eşleşen raf yok.' : 'Henüz raf yok. "Toplu raf oluştur" ya da "Excel\'den içe aktar" ile başlayın.')}>
          <div className="tbl-wrap tbl-scroll" style={{ maxHeight: 'calc(100vh - 240px)' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={hepsiSecili} onChange={tumunuSec} aria-label="Hepsini seç" /></th>
                  {depoSutun && <th>Depo</th>}
                  <th>Raf</th><th>Bölge</th><th className="num">Ürün çeşidi</th><th className="num">Toplam miktar</th><th className="num" title="Rafa zimmetli ürün; parantez içi rafta hiç olmayan">Zimmetli</th><th>Son hareket</th><th>Not</th>
                </tr>
              </thead>
              <tbody>
                {gorunen.map((r) => (
                  <tr key={anahtar(r)} className="click" onClick={() => (window.location.hash = `/raf/${r.depo}/${encodeURIComponent(r.code)}`)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={secili.has(anahtar(r))} onChange={() => sec(anahtar(r))} /></td>
                    {depoSutun && <td className="muted">{r.depoAd}</td>}
                    <td className="mono" style={{ fontWeight: 600 }}>{r.code}</td>
                    <td className="muted">{r.zone}</td>
                    <td className="num">{r.cesit || ''}</td>
                    <td className="num">{r.miktar ? miktar(r.miktar) : ''}</td>
                    <td className="num">{r.zimmet ? <>{r.zimmet}{r.bekleyen ? <span className="neg"> ({r.bekleyen})</span> : ''}</> : ''}</td>
                    <td className="muted">{r.sonHareket ? tarihSaat(r.sonHareket) : ''}</td>
                    <td className="muted">{r.note}{r.source === 'TERMINAL' && <Rozet tur="b-info">terminalde açıldı</Rozet>}{r.source === 'IMPORT' && <Rozet tur="b-mute">Excel</Rozet>}{r.source === 'VEGA' && <Rozet tur="b-info">Vega kartı</Rozet>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {liste.length > SAYFA_BOYU && (
            <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)', borderBottom: 0 }}>
              <span className="muted small">{sayfaNo * SAYFA_BOYU + 1}–{Math.min(liste.length, (sayfaNo + 1) * SAYFA_BOYU)} / {liste.length} raf</span>
              <div className="grow" />
              <Btn size="sm" disabled={sayfaNo === 0} onClick={() => setSayfa(sayfaNo - 1)}>Önceki</Btn>
              <span className="small">{sayfaNo + 1} / {sayfaSayisi}</span>
              <Btn size="sm" disabled={sayfaNo >= sayfaSayisi - 1} onClick={() => setSayfa(sayfaNo + 1)}>Sonraki</Btn>
            </div>
          )}
        </Durum>
      </div>
      {pencere === 'toplu' && <TopluOlustur kapat={() => setPencere(null)} tamam={(k) => { setPencere(null); setSecili(new Set(k)); yukle(); }} />}
      {pencere === 'tek' && <TekEkle kapat={() => setPencere(null)} tamam={() => { setPencere(null); yukle(); }} />}
      {pencere === 'ice' && <IceAktar kapat={() => setPencere(null)} tamam={() => { setPencere(null); yukle(); }} />}
      {pencere === 'etiket' && <EtiketPenceresi tur="raf" kodlar={[...secili]} kapat={() => setPencere(null)} />}
    </>
  );
}

export function RafDetay({ depo, kod }) {
  const { toast } = useApp();
  const { veri: d, hata, yukleniyor, yukle } = useVeri(`/raf/${depo}/${encodeURIComponent(kod)}`);
  const [sor, onay] = useOnay();
  const [etiket, setEtiket] = useState(false);
  const [not, setNot] = useState(null);
  const [tasi, setTasi] = useState(null);
  const [aktar, setAktar] = useState(null);
  const aktarKaydet = async () => {
    try {
      const r = await api(`${yol}/bosalt`, { method: 'POST', body: { hedef: aktar } });
      toast(`${r.urun} ürün ve ${r.zimmet} zimmet ${aktar} rafına aktarıldı`);
      setAktar(null);
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const yol = `/raf/${depo}/${encodeURIComponent(kod)}`;
  const sil = async () => {
    if (!(await sor('Raf silinsin mi?', `${kod} rafı tanımlardan kalkar, bu rafa verilmiş zimmetler de silinir. Terminaller bir sonraki eşitlemede bu rafı tanımaz.`, { tamam: 'Sil', tehlike: true }))) return;
    try {
      await api(yol, { method: 'DELETE' });
      toast('Raf silindi');
      window.location.hash = '/raflar';
    } catch (e) {
      toast(e.message, true);
    }
  };
  const notKaydet = async () => {
    try {
      await api(yol, { method: 'PUT', body: { note: not } });
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
          <SayfaBaslik baslik={<span className="mono">{kod}</span>} alt={d.raf ? `${d.depoAd} deposu · ${d.raf.zone} bölgesi${d.raf.note ? ' · ' + d.raf.note : ''}` : `${d.depoAd} deposunda tanımlı değil`} geri={['/raflar', 'Raflar']}>
            {d.raf && <Btn icon="edit" onClick={() => setNot(d.raf.note || '')}>Not</Btn>}
            {d.raf && <Btn icon="printer" onClick={() => setEtiket(true)}>Etiket</Btn>}
            {d.icerik.length > 0 && <Btn icon="transfer" onClick={() => setAktar('')}>Başka rafa aktar</Btn>}
            {d.raf && <Btn kind="danger" icon="trash" onClick={sil}>Sil</Btn>}
          </SayfaBaslik>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><Icon name="box" /><h2>Raftaki ürünler</h2><div className="grow" /><span className="muted">{d.icerik.filter((u) => u.qty > 0).length} çeşit{d.icerik.some((u) => !u.qty) ? ` · ${d.icerik.filter((u) => !u.qty).length} sayılmayı bekliyor` : ''}</span></div>
            {d.icerik.length === 0 ? (
              <div className="empty">Raf boş.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Ürün</th><th className="num">Miktar</th><th>Zimmet</th><th>Son değişiklik</th><th /></tr></thead>
                <tbody>
                  {d.icerik.map((u) => (
                    <tr key={u.productId} className="click" onClick={() => (window.location.hash = `/urun/${u.productId}`)}>
                      <td><div className="name">{u.name}</div><div className="code">{u.code}</div></td>
                      <td className="num">{u.qty > 0 ? <>{miktar(u.qty)} <span className="muted small">{u.unit}</span></> : <Rozet tur="b-warn">sayılmadı</Rozet>}</td>
                      <td>{u.zimmet === 'VEGA' ? <Rozet tur="b-info">Vega kartı</Rozet> : u.zimmet === 'IMPORT' ? <Rozet tur="b-mute">Excel</Rozet> : u.zimmet === 'TERMINAL' ? <Rozet tur="b-info">Terminal</Rozet> : u.zimmet ? <Rozet tur="b-mute">Elle</Rozet> : ''}</td>
                      <td className="muted">{u.updated_at ? tarihSaat(u.updated_at) : ''}</td>
                      <td style={{ width: 1 }} onClick={(e) => e.stopPropagation()}><Btn kind="ghost" size="sm" icon="transfer" title="Başka rafa taşı" onClick={() => setTasi(u)} /></td>
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
          {etiket && <EtiketPenceresi tur="raf" kodlar={[`${depo}|${kod}`]} kapat={() => setEtiket(false)} />}
          {tasi && (
            <Tasi
              urun={{ id: tasi.productId, name: tasi.name, code: tasi.code, unit: tasi.unit }}
              kaynak={{ depo: Number(depo), depoAd: d.depoAd, shelf: kod, qty: tasi.qty, zimmet: tasi.zimmet }}
              kapat={() => setTasi(null)}
              tamam={() => { setTasi(null); yukle(); }}
            />
          )}
          {aktar !== null && (
            <Modal baslik="Raftakileri başka rafa aktar" kapat={() => setAktar(null)} alt={<><Btn onClick={() => setAktar(null)}>Vazgeç</Btn><Btn kind="primary" disabled={!aktar.trim()} onClick={aktarKaydet}>Aktar</Btn></>}>
              <p className="muted" style={{ margin: 0 }}>{kod} rafındaki bütün ürünler ve elle ya da Excel'le verilmiş zimmetler hedef rafa geçer. Vega kartından gelen raf adresleri Vega'da değiştirilmelidir.</p>
              <Alan etiket="Hedef raf" ipucu="Tanımlı değilse açılır"><input className="inp mono" value={aktar} onChange={(e) => setAktar(e.target.value.toUpperCase())} autoFocus /></Alan>
            </Modal>
          )}
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
