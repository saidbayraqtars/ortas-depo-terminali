import React, { useMemo, useState } from 'react';
import { Btn, Durum, indir, miktar, SayfaBaslik, Secim, tarihSaat, useApp, useDepo, useVeri } from '../lib.jsx';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const donem = (ad) => {
  const b = new Date();
  const s = new Date();
  if (ad === 'hafta') s.setDate(b.getDate() - ((b.getDay() + 6) % 7));
  else if (ad === 'ay') s.setDate(1);
  else if (ad === 'onceki') {
    s.setMonth(b.getMonth() - 1, 1);
    return [iso(s), iso(new Date(b.getFullYear(), b.getMonth(), 0))];
  }
  return [iso(s), iso(b)];
};

/** Çalışan bazlı iş raporu (prim için): kim hangi işi ne kadar yapmış. Excel sunucudan, PDF tarayıcının yazdırmasından. */
export default function Raporlar() {
  const { toast } = useApp();
  const { depo, depolar, ad } = useDepo();
  const [bas, setBas] = useState(() => donem('ay')[0]);
  const [bit, setBit] = useState(() => donem('ay')[1]);
  const [kisi, setKisi] = useState('');
  const [acik, setAcik] = useState(null);
  const qs = new URLSearchParams(Object.entries({ bas, bit, depo, kullanici: kisi }).filter(([, v]) => v)).toString();
  const { veri, hata, yukleniyor } = useVeri(`/calisan-rapor?${qs}`, [qs]);
  const tumu = useVeri('/calisan-rapor?' + new URLSearchParams(Object.entries({ bas, bit, depo }).filter(([, v]) => v)).toString(), [bas, bit, depo]);
  const kisiler = (tumu.veri?.calisanlar || []).map((c) => c.user);
  const gunlukKisi = useMemo(() => {
    const m = new Map();
    for (const g of veri?.gunluk || []) {
      if (!m.has(g.user)) m.set(g.user, []);
      m.get(g.user).push(g);
    }
    return m;
  }, [veri]);
  const turAd = (k) => veri?.turler.find((t) => t.kind === k)?.ad || k;
  // Hiç iş çıkmayan türleri kolon olarak gösterme: tablo sade kalsın.
  const turler = (veri?.turler || []).filter((t) => veri.calisanlar.some((c) => c.turler[t.kind]));
  const toplam = (veri?.calisanlar || []).reduce((a, c) => ({ satir: a.satir + c.satir, adet: a.adet + c.adet }), { satir: 0, adet: 0 });
  const secDonem = (d) => { const [a, b] = donem(d); setBas(a); setBit(b); };

  return (
    <>
      <SayfaBaslik baslik="Çalışan raporu" alt="Kim ne iş yapmış: rafa kaldırma, gönderim, kabul, sayım. Prim hesabı için.">
        <Btn icon="export" onClick={() => indir(`/calisan-rapor.xlsx?${qs}`, `calisan-raporu-${bas}-${bit}.xlsx`).catch((e) => toast(e.message, true))}>Excel</Btn>
        <Btn icon="export" onClick={() => window.print()}>PDF</Btn>
      </SayfaBaslik>
      <div className="card">
        <div className="toolbar no-print">
          <Secim deger="" degis={secDonem} secenekler={[['bugun', 'Bugün'], ['hafta', 'Bu hafta'], ['ay', 'Bu ay'], ['onceki', 'Geçen ay']]} />
          <input type="date" className="inp" style={{ width: 150 }} value={bas} onChange={(e) => setBas(e.target.value)} />
          <span className="muted">–</span>
          <input type="date" className="inp" style={{ width: 150 }} value={bit} onChange={(e) => setBit(e.target.value)} />
          <select className="inp" style={{ width: 170 }} value={kisi} onChange={(e) => setKisi(e.target.value)}>
            <option value="">Tüm çalışanlar</option>
            {kisiler.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <div className="grow" />
          <span className="muted">{veri ? `${veri.calisanlar.length} çalışan · ${miktar(toplam.satir)} iş satırı · ${miktar(toplam.adet)} adet` : ''}</span>
        </div>
        <div className="print-only" style={{ padding: '0 0 12px' }}>
          <b>Çalışan raporu</b> · {bas} / {bit} · {depo ? ad(depo) : depolar.length > 1 ? 'Bütün depolar' : ''}{kisi ? ` · ${kisi}` : ''}
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && veri.calisanlar.length === 0 && 'Bu aralıkta çalışan hareketi yok.'}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Çalışan</th><th className="num">İş satırı</th><th className="num">Adet</th><th className="num">Ürün</th><th className="num">Aktif gün</th>
                  {turler.map((t) => <th key={t.kind} className="num">{t.ad}</th>)}
                </tr>
              </thead>
              <tbody>
                {veri?.calisanlar.map((c) => (
                  <React.Fragment key={c.user}>
                    <tr className="click" onClick={() => setAcik(acik === c.user ? null : c.user)}>
                      <td><b>{c.user}</b><div className="muted small">{tarihSaat(c.ilk)} – {tarihSaat(c.son)}</div></td>
                      <td className="num">{miktar(c.satir)}</td>
                      <td className="num">{miktar(c.adet)}</td>
                      <td className="num">{miktar(c.urun)}</td>
                      <td className="num">{c.aktifGun}</td>
                      {turler.map((t) => <td key={t.kind} className="num">{c.turler[t.kind] ? <>{miktar(c.turler[t.kind].adet)} <span className="muted small">({c.turler[t.kind].satir})</span></> : <span className="muted">—</span>}</td>)}
                    </tr>
                    {acik === c.user && (
                      <tr className="detay">
                        <td colSpan={5 + turler.length}>
                          <table className="tbl">
                            <thead><tr><th>Gün</th><th>İş türü</th><th className="num">Satır</th><th className="num">Adet</th></tr></thead>
                            <tbody>
                              {(gunlukKisi.get(c.user) || []).map((g) => (
                                <tr key={g.gun + g.kind}><td className="muted">{new Date(g.gun).toLocaleDateString('tr-TR')}</td><td>{turAd(g.kind)}</td><td className="num">{miktar(g.satir)}</td><td className="num">{miktar(g.adet)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted small no-print" style={{ padding: '10px 4px 0' }}>
            Satıra tıklayınca günlük döküm açılır. "Adet" yapılan işin toplam miktarıdır; parantez içi satır sayısıdır. Geri alınan rafa kaldırmalar toplama girmez.
          </div>
        </Durum>
      </div>
    </>
  );
}
