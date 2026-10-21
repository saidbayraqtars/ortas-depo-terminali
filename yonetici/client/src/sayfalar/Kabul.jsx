import React, { useMemo, useState } from 'react';
import { api, Ara, Btn, Durum, Icon, Ilerleme, miktar, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useDepo, useOnay, useVeri } from '../lib.jsx';

export default function Kabul() {
  const [durum, setDurum] = useState('acik');
  const [q, setQ] = useState('');
  const { qs, cok, depo } = useDepo();
  const { veri, hata, yukleniyor } = useVeri(`/kabul?durum=${durum}${qs}`, [durum, qs]);
  const liste = useMemo(() => {
    const a = q.trim().toLocaleUpperCase('tr');
    return (veri || []).filter((b) => !a || b.docNo.toLocaleUpperCase('tr').includes(a) || b.supplier.toLocaleUpperCase('tr').includes(a));
  }, [veri, q]);
  return (
    <>
      <SayfaBaslik baslik="Mal kabul" alt="Vega'da kabul edilen belgeler ve rafa kaldırma ilerlemesi" />
      <div className="card">
        <div className="toolbar">
          <Secim deger={durum} degis={setDurum} secenekler={[['acik', 'Rafa kaldırılacak'], ['kapali', 'Tamamlanan'], ['tumu', 'Tümü']]} />
          <Ara deger={q} degis={setQ} yer="Belge no ya da tedarikçi" />
          <div className="grow" />
          <span className="muted">{liste.length} belge</span>
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={liste.length === 0 && 'Bu listede belge yok. Vega\'da kabul tarihi Ayarlar › Mal kabul başlangıcından eski olanlar gelmez.'}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Tarih</th>{cok && !depo && <th>Depo</th>}<th>Belge</th><th>Tür</th><th>Tedarikçi</th><th className="num">Kalem</th><th>İlerleme</th><th className="num">Kalan</th><th /></tr>
              </thead>
              <tbody>
                {liste.map((b) => (
                  <tr key={b.id} className="click" onClick={() => (window.location.hash = `/kabul/${encodeURIComponent(b.id)}`)}>
                    <td className="muted">{b.date}</td>
                    {cok && !depo && <td>{b.depoAd}</td>}
                    <td className="mono">{b.docNo}</td>
                    <td className="muted">{b.tur}</td>
                    <td>{b.supplier || '—'}</td>
                    <td className="num">{b.biten}/{b.kalemSayisi}</td>
                    <td style={{ width: 140 }}><Ilerleme oran={b.kalemSayisi ? b.biten / b.kalemSayisi : 0} /></td>
                    <td className="num">{miktar(b.kalan)}</td>
                    <td>{b.elleKapali ? <Rozet tur="b-mute">Elle kapatıldı</Rozet> : b.acik ? <Rozet tur="b-warn">Bekliyor</Rozet> : <Rozet tur="b-ok">Tamam</Rozet>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Durum>
      </div>
    </>
  );
}

export function KabulDetay({ id }) {
  const { toast } = useApp();
  const { veri: b, hata, yukleniyor, yukle } = useVeri(`/kabul/${encodeURIComponent(id)}`);
  const [sor, onayPenceresi] = useOnay();
  const kapatAc = async (kapat) => {
    if (kapat && !(await sor('Belge kapatılsın mı?', 'Kalan satırlar terminalde görünmez ve "rafa kaldırılacak" sayılmaz. Mal rafa kaldırılmadan başka yere konduysa kullanın. Sonra yeniden açılabilir.', { tamam: 'Kapat' }))) return;
    try {
      await api(`/kabul/${encodeURIComponent(id)}/${kapat ? 'kapat' : 'ac'}`, { method: 'POST', body: {} });
      toast(kapat ? 'Belge kapatıldı' : 'Belge yeniden açıldı');
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <Durum yukleniyor={yukleniyor && !b} hata={hata}>
      {b && (
        <>
          <SayfaBaslik baslik={<span className="mono">{b.docNo}</span>} alt={`${b.depoAd} deposu · ${b.tur} · ${b.date} · ${b.supplier || 'tedarikçi yok'}`} geri={['/kabul', 'Mal kabul']}>
            {b.elleKapali ? <Btn icon="refresh" onClick={() => kapatAc(false)}>Yeniden aç</Btn> : b.acik ? <Btn icon="x" onClick={() => kapatAc(true)}>Elle kapat</Btn> : null}
          </SayfaBaslik>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h2>Satırlar</h2><div className="grow" /><span className="muted">{b.biten}/{b.kalemSayisi} tamam · kalan {miktar(b.kalan)}</span></div>
            <table className="tbl">
              <thead><tr><th>Ürün</th><th className="num">Kabul</th><th className="num">Rafa kaldırılan</th><th className="num">Kalan</th><th>İlerleme</th></tr></thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.id} className="click" onClick={() => (window.location.hash = `/urun/${l.productId}`)}>
                    <td><div className="name">{l.urunAd}</div><div className="code">{l.urunKod}</div></td>
                    <td className="num">{miktar(l.accepted)} <span className="muted small">{l.unit}</span></td>
                    <td className="num">{miktar(l.shelved)}</td>
                    <td className="num">{miktar(Math.max(0, l.accepted - l.shelved))}</td>
                    <td style={{ width: 140 }}><Ilerleme oran={l.accepted ? l.shelved / l.accepted : 0} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="card-head"><Icon name="history" /><h2>Rafa kaldırma kayıtları</h2></div>
            {b.hareketler.length === 0 ? (
              <div className="empty">Bu belgeden henüz rafa kaldırma yok.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Zaman</th><th>Ürün</th><th>Raf</th><th className="num">Miktar</th><th>Kim</th></tr></thead>
                <tbody>
                  {b.hareketler.map((h) => (
                    <tr key={h.id}>
                      <td className="muted">{tarihSaat(h.ts)}</td>
                      <td><div className="name">{h.urunAd}</div><div className="code">{h.urunKod}</div></td>
                      <td className="mono"><a href={`#/raf/${h.depo}/${encodeURIComponent(h.shelf)}`}>{h.shelf}</a></td>
                      <td className="num">{miktar(h.delta)}</td>
                      <td className="muted">{h.user} · {h.device}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {onayPenceresi}
        </>
      )}
    </Durum>
  );
}
