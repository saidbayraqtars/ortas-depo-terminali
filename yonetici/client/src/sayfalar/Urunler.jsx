import React, { useEffect, useState } from 'react';
import { Alan, api, Ara, Btn, Durum, HAREKET, Icon, indir, miktar, Modal, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useDepo, useOnay, useVeri } from '../lib.jsx';
import EtiketPenceresi from './Etiket.jsx';

function useGecikmeli(deger, ms = 300) {
  const [d, setD] = useState(deger);
  useEffect(() => {
    const t = setTimeout(() => setD(deger), ms);
    return () => clearTimeout(t);
  }, [deger, ms]);
  return d;
}

const FILTRE = [
  ['hepsi', 'Stoklu / rafta'],
  ['rafta', 'Rafta'],
  ['yerlesmemis', 'Yerleşmemiş'],
  ['bekleyen', 'Rafa kaldırılacak'],
  ['fazla', 'Raf fazlası'],
  ['adressiz', 'Raf adresi yok'],
];

const ZIMMET = { VEGA: ['Vega kartı', 'b-info'], IMPORT: ['Excel', 'b-mute'], ADMIN: ['Elle', 'b-mute'], TERMINAL: ['Terminal', 'b-info'] };

export default function Urunler() {
  const [q, setQ] = useState('');
  const [filtre, setFiltre] = useState('hepsi');
  const ara = useGecikmeli(q);
  const { qs, depo, ad } = useDepo();
  const yol = `/urunler?filtre=${filtre}&q=${encodeURIComponent(ara)}${qs}`;
  const { veri, hata, yukleniyor } = useVeri(yol, [yol]);
  const { toast } = useApp();
  const [secili, setSecili] = useState(() => new Set());
  const [etiket, setEtiket] = useState(false);
  const sec = (id) => setSecili((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const gorunen = veri?.liste || [];
  const hepsi = gorunen.length > 0 && gorunen.every((u) => secili.has(u.id));
  return (
    <>
      <SayfaBaslik baslik="Ürün ve stok" alt={`Vega stoku ile raflardaki miktarın karşılaştırması · ${depo ? `${ad(depo)} deposu` : 'bütün depolar'}`}>
        <Btn icon="barcode" disabled={!secili.size} onClick={() => setEtiket(true)}>Barkod etiketi{secili.size ? ` (${secili.size})` : ''}</Btn>
        <Btn icon="export" onClick={() => indir(`/urunler.csv?filtre=${filtre}&q=${encodeURIComponent(ara)}${qs}`, 'urunler.csv').catch((e) => toast(e.message, true))}>Excel (CSV)</Btn>
      </SayfaBaslik>
      <div className="notice info" style={{ marginBottom: 14 }}>
        <Icon name="info" />
        <p><b>Yerleşmemiş</b> = Vega stoku − raflardaki toplam − rafa kaldırılmayı bekleyen. Artı değer rafı belli olmayan mal; eksi değer raflarda Vega'dan fazla görünen mal (sayım gerekebilir).</p>
      </div>
      <div className="card">
        <div className="toolbar">
          <Ara deger={q} degis={setQ} yer="Kod, ad ya da barkod" otomatik />
          <Secim deger={filtre} degis={setFiltre} secenekler={FILTRE} />
          <div className="grow" />
          {veri && <span className="muted">{miktar(veri.toplam)} ürün{veri.toplam > veri.liste.length ? ` (ilk ${veri.liste.length})` : ''}</span>}
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && veri.liste.length === 0 && 'Eşleşen ürün yok.'}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th style={{ width: 36 }}><input type="checkbox" checked={hepsi} onChange={() => setSecili(hepsi ? new Set() : new Set(gorunen.map((u) => u.id)))} aria-label="Hepsini seç" /></th><th>Ürün</th><th>Birim</th><th className="num">Vega stok</th><th className="num">Rafta</th><th className="num">Raf</th><th className="num">Rafa kaldırılacak</th><th className="num">Yerleşmemiş</th></tr>
              </thead>
              <tbody>
                {veri?.liste.map((u) => (
                  <tr key={u.id} className="click" onClick={() => (window.location.hash = `/urun/${u.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={secili.has(u.id)} onChange={() => sec(u.id)} /></td>
                    <td><div className="name">{u.name}</div><div className="code">{u.code}</div></td>
                    <td className="muted">{u.unit}</td>
                    <td className="num">{miktar(u.vegaStock)}</td>
                    <td className="num">{miktar(u.raf)}</td>
                    <td className="num">{u.rafSayisi || ''}</td>
                    <td className="num">{u.bekleyen ? miktar(u.bekleyen) : ''}</td>
                    <td className={`num ${u.fark > 0 ? 'neg' : u.fark < 0 ? 'pos' : 'muted'}`}>{u.fark ? miktar(u.fark, true) : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Durum>
      </div>
      {etiket && <EtiketPenceresi tur="urun" urunler={[...secili]} kapat={() => setEtiket(false)} />}
    </>
  );
}

function Duzelt({ urun, konum, kapat, tamam }) {
  const { toast } = useApp();
  const { depolar, cok, depo: secili, varsayilan } = useDepo();
  const [depo, setDepo] = useState(String(konum?.depo ?? (secili || varsayilan || depolar[0]?.ind || '')));
  const [raf, setRaf] = useState(konum?.shelf || '');
  const [qty, setQty] = useState(konum ? String(konum.qty) : '');
  const [not, setNot] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const kaydet = async () => {
    setMesgul(true);
    try {
      await api('/konum', { method: 'POST', body: { productId: urun.id, shelf: raf, qty: Number(String(qty).replace(',', '.')), not, depo } });
      toast('Raf miktarı kaydedildi');
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal baslik="Raf miktarını düzelt" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" busy={mesgul} onClick={kaydet}>Kaydet</Btn></>}>
      <div><b>{urun.name}</b> <span className="mono muted">{urun.code}</span></div>
      {cok && (
        <Alan etiket="Depo">
          <select className="inp" value={depo} onChange={(e) => setDepo(e.target.value)} disabled={Boolean(konum)}>
            {depolar.map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
          </select>
        </Alan>
      )}
      <Alan etiket="Raf" ipucu="Tanımlı bir raf kodu"><input className="inp mono" value={raf} onChange={(e) => setRaf(e.target.value.toUpperCase())} autoFocus={!konum} disabled={Boolean(konum)} /></Alan>
      <Alan etiket={`Raftaki miktar (${urun.unit})`} ipucu="0 yazılırsa ürün raftan kalkar"><input className="inp mono" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus={Boolean(konum)} /></Alan>
      <Alan etiket="Not"><input className="inp" value={not} onChange={(e) => setNot(e.target.value)} placeholder="Neden düzeltildi" /></Alan>
      <div className="notice info"><Icon name="info" /><p>Yalnız raf bilgisi değişir; Vega stoku değişmez. Vega'yı düzeltmek için sayım açın.</p></div>
    </Modal>
  );
}

function DepoSec({ depo, setDepo, kilitli }) {
  const { depolar, cok } = useDepo();
  if (!cok) return null;
  return (
    <Alan etiket="Depo">
      <select className="inp" value={depo} onChange={(e) => setDepo(e.target.value)} disabled={kilitli}>
        {depolar.map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
      </select>
    </Alan>
  );
}

/** Ürünü başka rafa taşı; miktar boşsa raftakinin hepsi. Zimmetliyse zimmet de taşınabilir. */
export function Tasi({ urun, kaynak, kapat, tamam }) {
  const { toast } = useApp();
  const [hedef, setHedef] = useState('');
  const [qty, setQty] = useState(kaynak.qty ? String(kaynak.qty) : '');
  const [zimmet, setZimmet] = useState(Boolean(kaynak.zimmet && kaynak.zimmet !== 'VEGA'));
  const [mesgul, setMesgul] = useState(false);
  const kaydet = async () => {
    setMesgul(true);
    try {
      const q = String(qty).trim() === '' ? null : Number(String(qty).replace(',', '.'));
      const r = await api('/tasi', { method: 'POST', body: { depo: kaynak.depo, productId: urun.id, from: kaynak.shelf, to: hedef, qty: q, zimmetTasi: zimmet } });
      toast(`${miktar(r.tasinan)} ${urun.unit} ${hedef} rafına taşındı`);
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal baslik="Başka rafa taşı" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" busy={mesgul} disabled={!hedef.trim()} onClick={kaydet}>Taşı</Btn></>}>
      <div><b>{urun.name}</b> <span className="mono muted">{urun.code}</span></div>
      <div className="muted small">Kaynak: <span className="mono">{kaynak.shelf}</span>{kaynak.depoAd ? ` · ${kaynak.depoAd}` : ''} · rafta {miktar(kaynak.qty || 0)}</div>
      <Alan etiket="Hedef raf" ipucu="Tanımlı değilse açılır"><input className="inp mono" value={hedef} onChange={(e) => setHedef(e.target.value.toUpperCase())} autoFocus /></Alan>
      {kaynak.qty > 0 && <Alan etiket={`Miktar (${urun.unit})`} ipucu="Boş bırakılırsa raftakinin hepsi"><input className="inp mono" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Alan>}
      {kaynak.zimmet && (
        <label className="check">
          <input type="checkbox" checked={zimmet} onChange={() => setZimmet(!zimmet)} />
          <span>Zimmeti de taşı{kaynak.zimmet === 'VEGA' ? " (Vega kartındaki adres kalır; yeni raf elle zimmetlenir)" : ''}</span>
        </label>
      )}
    </Modal>
  );
}

function Zimmetle({ urun, kapat, tamam }) {
  const { toast } = useApp();
  const { depolar, depo: secili, varsayilan } = useDepo();
  const [depo, setDepo] = useState(String(secili || varsayilan || depolar[0]?.ind || ''));
  const [raf, setRaf] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const kaydet = async () => {
    setMesgul(true);
    try {
      await api('/zimmet', { method: 'POST', body: { productId: urun.id, shelf: raf, depo } });
      toast(`${raf} rafına zimmetlendi`);
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal baslik="Rafa zimmetle" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" busy={mesgul} disabled={!raf.trim()} onClick={kaydet}>Zimmetle</Btn></>}>
      <div><b>{urun.name}</b> <span className="mono muted">{urun.code}</span></div>
      <DepoSec depo={depo} setDepo={setDepo} />
      <Alan etiket="Raf" ipucu="Tanımlı değilse açılır"><input className="inp mono" value={raf} onChange={(e) => setRaf(e.target.value.toUpperCase())} autoFocus /></Alan>
      <div className="notice info"><Icon name="info" /><p>Zimmetli ürün rafta hiç yokken de o rafta "sayılmayı bekliyor" olarak görünür. Ürün birden çok rafa zimmetlenebilir.</p></div>
    </Modal>
  );
}

export function UrunDetay({ id }) {
  const { veri: d, hata, yukleniyor, yukle } = useVeri(`/urun/${encodeURIComponent(id)}`);
  const { toast } = useApp();
  const [sor, onayPenceresi] = useOnay();
  const [duzelt, setDuzelt] = useState(null);
  const [tasi, setTasi] = useState(null);
  const [zimmetle, setZimmetle] = useState(false);
  const [etiket, setEtiket] = useState(false);
  // Raflar: miktarı olanlar + zimmetli olup rafta olmayanlar, tek listede.
  const raflar = [];
  if (d) {
    const zim = new Map((d.asilRaflar || []).map((h) => [`${h.depo}|${h.shelf}`, h]));
    for (const k of d.konumlar) raflar.push({ ...k, zimmet: zim.get(`${k.depo}|${k.shelf}`)?.source || null });
    const var_ = new Set(d.konumlar.map((k) => `${k.depo}|${k.shelf}`));
    for (const h of d.asilRaflar || []) if (!var_.has(`${h.depo}|${h.shelf}`)) raflar.push({ depo: h.depo, depoAd: h.depoAd, shelf: h.shelf, qty: 0, updated_at: null, zimmet: h.source });
  }
  const zimmetKaldir = async (k) => {
    if (!(await sor('Zimmet kaldırılsın mı?', `${d.urun.name} artık ${k.shelf} rafına zimmetli olmayacak. Raftaki miktar değişmez.`, { tamam: 'Kaldır' }))) return;
    try {
      await api('/zimmet', { method: 'DELETE', body: { productId: d.urun.id, shelf: k.shelf, depo: k.depo } });
      toast('Zimmet kaldırıldı');
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <Durum yukleniyor={yukleniyor && !d} hata={hata}>
      {d && (
        <>
          <SayfaBaslik baslik={d.urun.name} alt={<span className="mono">{d.urun.code} · {d.urun.unit}</span>} geri={['/urunler', 'Ürün ve stok']}>
            <Btn icon="barcode" onClick={() => setEtiket(true)}>Barkod etiketi</Btn>
            <Btn icon="mapPoint" onClick={() => setZimmetle(true)}>Rafa zimmetle</Btn>
            <Btn icon="plus" onClick={() => setDuzelt({})}>Rafa ekle / düzelt</Btn>
          </SayfaBaslik>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <div className="card stat"><span className="k">Vega stok</span><span className="v">{miktar(d.vegaStock)}</span></div>
            <div className="card stat"><span className="k">Raflarda</span><span className="v">{miktar(d.raf)}</span><span className="s">{d.konumlar.length} raf</span></div>
            <div className="card stat"><span className="k">Rafa kaldırılacak</span><span className="v">{miktar(d.bekleyen)}</span></div>
            <div className={`card stat ${Math.abs(d.fark) > 1e-9 ? 'warn' : ''}`}><span className="k">Yerleşmemiş</span><span className="v">{miktar(d.fark, true)}</span></div>
          </div>
          {d.depolar.length > 1 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><Icon name="layers" /><h2>Depolar</h2></div>
              <table className="tbl">
                <thead><tr><th>Depo</th><th className="num">Vega stok</th><th className="num">Raflarda</th><th className="num">Rafa kaldırılacak</th><th className="num">Yerleşmemiş</th></tr></thead>
                <tbody>
                  {d.depolar.map((x) => (
                    <tr key={x.depo}>
                      <td><b>{x.depoAd}</b></td>
                      <td className="num">{miktar(x.vegaStock)}</td>
                      <td className="num">{miktar(x.raf)}</td>
                      <td className="num">{x.bekleyen ? miktar(x.bekleyen) : ''}</td>
                      <td className={`num ${x.fark > 0 ? 'neg' : x.fark < 0 ? 'pos' : 'muted'}`}>{miktar(x.fark, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="grid g2" style={{ marginBottom: 14 }}>
            <div className="card">
              <div className="card-head"><Icon name="mapPoint" /><h2>Raflar</h2></div>
              {raflar.length === 0 ? (
                <div className="empty">Bu ürün hiçbir rafta değil ve hiçbir rafa zimmetli değil.</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>Raf</th><th>Depo</th><th className="num">Miktar</th><th>Zimmet</th><th>Son değişiklik</th><th /></tr></thead>
                  <tbody>
                    {raflar.map((k) => (
                      <tr key={`${k.depo}|${k.shelf}`}>
                        <td className="mono"><a href={`#/raf/${k.depo}/${encodeURIComponent(k.shelf)}`}>{k.shelf}</a></td>
                        <td className="muted">{k.depoAd}</td>
                        <td className="num">{k.qty > 0 ? miktar(k.qty) : <Rozet tur="b-warn">sayılmadı</Rozet>}</td>
                        <td>{k.zimmet ? <Rozet tur={(ZIMMET[k.zimmet] || [])[1]}>{(ZIMMET[k.zimmet] || [k.zimmet])[0]}</Rozet> : ''}</td>
                        <td className="muted">{k.updated_at ? tarihSaat(k.updated_at) : ''}</td>
                        <td style={{ whiteSpace: 'nowrap', width: 1 }}>
                          {k.qty > 0 && <Btn kind="ghost" size="sm" icon="edit" onClick={() => setDuzelt(k)} title="Miktarı düzelt" />}
                          <Btn kind="ghost" size="sm" icon="transfer" onClick={() => setTasi(k)} title="Başka rafa taşı" />
                          {k.zimmet && k.zimmet !== 'VEGA' && <Btn kind="ghost" size="sm" icon="x" onClick={() => zimmetKaldir(k)} title="Zimmeti kaldır" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="card">
              <div className="card-head"><Icon name="barcode" /><h2>Kart</h2></div>
              <div className="card-pad">
                <dl className="kv">
                  <dt>Vega kart no</dt><dd className="mono">{d.urun.id}</dd>
                  <dt>Barkod</dt>
                  <dd>{d.urun.barcodes?.length ? <div className="chip-list">{d.urun.barcodes.map((b) => <span className="chip" key={b}>{b}</span>)}</div> : <span className="muted">yok (terminalde ürün kodu okutulur)</span>}</dd>
                  {d.rafAdresi && <><dt>Vega raf adresi</dt><dd className="mono">{d.rafAdresi}</dd></>}
                </dl>
                {d.kabul.length > 0 && (
                  <>
                    <hr className="sep" style={{ margin: '14px 0' }} />
                    <div className="small muted" style={{ marginBottom: 6 }}>Mal kabul belgeleri</div>
                    {d.kabul.map((k) => (
                      <div key={k.id} className="row small" style={{ padding: '3px 0' }}>
                        <a className="mono" href={`#/kabul/${encodeURIComponent(k.id)}`}>{k.docNo}</a>
                        <span className="muted">{k.date} · {k.depoAd}</span>
                        <span className="grow" style={{ flex: 1 }} />
                        <span className="num">{miktar(k.shelved)}/{miktar(k.accepted)}</span>
                        {k.acik ? <Rozet tur="b-warn">açık</Rozet> : <Rozet tur="b-ok">tamam</Rozet>}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><Icon name="history" /><h2>Hareketler</h2></div>
            {d.hareketler.length === 0 ? (
              <div className="empty">Hareket yok.</div>
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead><tr><th>Zaman</th><th>Tür</th><th>Raf</th><th className="num">Miktar</th><th className="num">Sonra</th><th>Belge / not</th><th>Kim</th></tr></thead>
                  <tbody>
                    {d.hareketler.map((h) => (
                      <tr key={h.id}>
                        <td className="muted">{tarihSaat(h.ts)}</td>
                        <td><Rozet tur={(HAREKET[h.kind] || [])[1]}>{(HAREKET[h.kind] || [h.kind])[0]}</Rozet></td>
                        <td className="mono">{h.shelf}<div className="code">{h.depoAd}</div></td>
                        <td className={`num ${h.delta > 0 ? 'pos' : h.delta < 0 ? 'neg' : ''}`}>{miktar(h.delta, true)}</td>
                        <td className="num">{miktar(h.after)}</td>
                        <td className="muted">{h.ref || ''}</td>
                        <td className="muted">{h.user || '—'}{h.device ? ` · ${h.device}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {etiket && <EtiketPenceresi tur="urun" urunler={[d.urun.id]} kapat={() => setEtiket(false)} />}
          {duzelt && <Duzelt urun={d.urun} konum={duzelt.shelf ? duzelt : null} kapat={() => setDuzelt(null)} tamam={() => { setDuzelt(null); yukle(); }} />}
          {tasi && <Tasi urun={d.urun} kaynak={tasi} kapat={() => setTasi(null)} tamam={() => { setTasi(null); yukle(); }} />}
          {zimmetle && <Zimmetle urun={d.urun} kapat={() => setZimmetle(false)} tamam={() => { setZimmetle(false); yukle(); }} />}
          {onayPenceresi}
        </>
      )}
    </Durum>
  );
}
