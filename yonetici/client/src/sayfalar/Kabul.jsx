import React, { useMemo, useState } from 'react';
import { api, Ara, Btn, Durum, Icon, Ilerleme, miktar, Modal, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useDepo, useOnay, useVeri } from '../lib.jsx';

// Depolar arası gönderim belgeleri (Vega 37/129 ve terminalden kabul edilenler); gerisi alış belgesidir.
const depoArasi = (b) => b.izahat === 'D37' || b.izahat === 'D129';

/** Satırdaki "Bekliyor" yerine malın rafa gidip gitmediğini açıkça söyler. */
function RafDurumu({ b }) {
  if (b.elleKapali) return <Rozet tur="b-mute">Elle kapatıldı</Rozet>;
  if (!b.acik) return <Rozet tur="b-ok">Rafa kalktı</Rozet>;
  return b.kalan >= b.kabul - 1e-9 ? <Rozet tur="b-warn">Rafa kalkmadı</Rozet> : <Rozet tur="b-info">Kısmen kalktı</Rozet>;
}

const gunAd = (ts) => new Date(ts).toLocaleDateString('tr-TR');

/** Rafa bekleyen ürünler: belge eşleşmesi yok; ürün başına gelen − rafa kaldırılan (sunucu `bekleyenUrunler`). */
function BekleyenUrunler() {
  const { cok, depo, setDepo, ad } = useDepo();
  const [q, setQ] = useState('');
  const { veri, hata, yukleniyor } = useVeri('/bekleyen?limit=5000');
  const liste = useMemo(() => {
    const a = q.trim().toLocaleLowerCase('tr');
    return (veri?.urunler || []).filter((u) => (!depo || u.depo === Number(depo))
      && (!a || u.urunKod.toLocaleLowerCase('tr').includes(a) || u.urunAd.toLocaleLowerCase('tr').includes(a)));
  }, [veri, q, depo]);
  const ozet = veri?.ozet;
  // Depo seçiliyken o depoda bekleyen yoksa 0 gösterilir (bütün depoların toplamı değil); diğer depodakiler ayrıca söylenir.
  const depoOzet = depo && ozet ? ozet.depolar.find((d) => d.depo === Number(depo)) || { urun: 0, adet: 0 } : null;
  const gosterilen = depoOzet || ozet;
  const baska = depoOzet ? ozet.urun - depoOzet.urun : 0;
  return (
    <>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="card stat"><span className="k">Rafa bekleyen ürün</span><span className="v">{gosterilen ? miktar(gosterilen.urun) : '—'}</span><span className="s">çeşit{depoOzet ? ` · ${ad(depo)}` : ''}</span></div>
        <div className="card stat"><span className="k">Rafa bekleyen adet</span><span className="v">{gosterilen ? miktar(gosterilen.adet) : '—'}</span><span className="s">toplam miktar</span></div>
        {cok && !depo && ozet?.depolar.map((d) => (
          <div className="card stat" key={d.depo}><span className="k">{d.depoAd}</span><span className="v">{miktar(d.adet)}</span><span className="s">{miktar(d.urun)} ürün</span></div>
        ))}
      </div>
      {baska > 0 && (
        <div className="notice info" style={{ margin: '0 0 12px', alignItems: 'center' }}>
          <Icon name="package" />
          <p style={{ flex: 1 }}>{ad(depo)} dışındaki depolarda {baska} ürün daha rafa bekliyor ({ozet.depolar.filter((d) => d.depo !== Number(depo)).map((d) => `${d.depoAd}: ${miktar(d.adet)} adet`).join(', ')}).</p>
          <Btn onClick={() => setDepo('')}>Bütün depoları göster</Btn>
        </div>
      )}
      <div className="card">
        <div className="toolbar">
          <Ara deger={q} degis={setQ} yer="Stok kodu ya da ürün adı" />
          <div className="grow" />
          <span className="muted">{liste.length} ürün</span>
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={liste.length === 0 && 'Rafa kaldırılmayı bekleyen ürün yok.'}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Ürün</th>{cok && !depo && <th>Depo</th>}<th className="num">Gelen</th><th className="num">Rafa kaldırılan</th><th className="num">Bekleyen</th><th>İlk giriş</th></tr>
              </thead>
              <tbody>
                {liste.map((u) => (
                  <tr key={`${u.depo}|${u.productId}`} className="click" onClick={() => (window.location.hash = `/urun/${u.productId}`)}>
                    <td><div className="name">{u.urunAd}</div><div className="code">{u.urunKod}</div></td>
                    {cok && !depo && <td>{u.depoAd}</td>}
                    <td className="num">{miktar(u.gelen)}</td>
                    <td className="num">{miktar(u.rafa)}</td>
                    <td className="num"><b>{miktar(u.bekleyen)}</b> <span className="muted small">{u.birim}</span></td>
                    <td className="muted">{gunAd(u.enEski)}{u.belgeSayisi > 1 ? ` · ${u.belgeSayisi} belge` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Durum>
        <div className="muted small" style={{ padding: '10px 4px 0' }}>
          Bekleyen = milattan beri Vega'da kabul edilen − aynı ürün için rafa kaldırılan (belgeli ya da belgesiz fark etmez). Mal önce rafa konup fatura sonra girilse de toplam doğru çıkar.
        </div>
      </div>
    </>
  );
}

export default function Kabul() {
  const [sekme, setSekme] = useState('urun');
  const [durum, setDurum] = useState('tumu');
  const [tur, setTur] = useState('hepsi');
  const [q, setQ] = useState('');
  const { cok, depo, setDepo, ad } = useDepo();
  const { durum: sunucuDurum } = useApp();
  // Bütün depolar alınır, seçili depo burada süzülür: menüdeki sayı bütün depoları sayıyor; seçili depoda belge
  // yokken liste boş kalıp sayıyla çelişmesin, başka depodaki belge söylensin.
  const { veri, hata, yukleniyor } = useVeri(`/kabul?durum=${durum}`, [durum]);
  const { liste, baska } = useMemo(() => {
    const a = q.trim().toLocaleUpperCase('tr');
    const ara = (veri || []).filter((b) => (!a || b.docNo.toLocaleUpperCase('tr').includes(a) || b.supplier.toLocaleUpperCase('tr').includes(a))
      && (tur === 'hepsi' || (tur === 'depo' ? depoArasi(b) : !depoArasi(b))));
    const secili = ara.filter((b) => !depo || b.depo === Number(depo));
    return { liste: secili, baska: ara.length - secili.length };
  }, [veri, q, depo, tur]);
  const milat = sunucuDurum?.kabulBaslangic ? new Date(`${sunucuDurum.kabulBaslangic}T00:00:00`).toLocaleDateString('tr-TR') : '';
  return (
    <>
      <SayfaBaslik baslik="Mal kabul" alt={`Rafa kaldırılmayı bekleyen mal ürün bazlı izlenir${milat ? ` · ${milat} ve sonrası (Ayarlar › Mal kabul'den değişir)` : ''}`}>
        <Secim deger={sekme} degis={setSekme} secenekler={[['urun', 'Bekleyen ürünler'], ['belge', 'Belgeler']]} />
      </SayfaBaslik>
      {sekme === 'urun' ? <BekleyenUrunler /> : (
        <div className="card">
          <div className="toolbar">
            <Secim deger={durum} degis={setDurum} secenekler={[['tumu', 'Tümü'], ['acik', 'Rafa kalkmamış'], ['kapali', 'Rafa kalkmış']]} />
            <select className="inp" style={{ width: 160 }} value={tur} onChange={(e) => setTur(e.target.value)} title="Belge türü">
              <option value="hepsi">Tüm belgeler</option>
              <option value="alis">Alış belgeleri</option>
              <option value="depo">Depolar arası</option>
            </select>
            <Ara deger={q} degis={setQ} yer="Belge no ya da tedarikçi" />
            <div className="grow" />
            <span className="muted">{liste.length} belge</span>
          </div>
          {baska > 0 && (
            <div className="notice info" style={{ margin: '0 0 12px', alignItems: 'center' }}>
              <Icon name="package" />
              <p style={{ flex: 1 }}>{ad(depo)} dışındaki depolarda {baska} belge daha var.</p>
              <Btn onClick={() => setDepo('')}>Bütün depoları göster</Btn>
            </div>
          )}
          <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={liste.length === 0 && "Bu listede belge yok. Vega'da kabul tarihi Ayarlar › Mal kabul başlangıcından eski olanlar gelmez."}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Tarih</th>{cok && !depo && <th>Depo</th>}<th>Belge</th><th>Tür</th><th>Tedarikçi</th><th className="num">Kalem</th><th className="num">Kalan</th><th /></tr>
                </thead>
                <tbody>
                  {liste.map((b) => (
                    <tr key={b.id} className="click" onClick={() => (window.location.hash = `/kabul/${encodeURIComponent(b.id)}`)}>
                      <td className="muted">{b.date}</td>
                      {cok && !depo && <td>{b.depoAd}</td>}
                      <td className="mono">{b.docNo}</td>
                      <td className="muted">{depoArasi(b) ? <Rozet tur="b-info">{b.tur}</Rozet> : b.tur}</td>
                      <td>{b.supplier || '—'}</td>
                      <td className="num">{b.biten}/{b.kalemSayisi}</td>
                      <td className="num">{miktar(b.kalan)}</td>
                      <td><RafDurumu b={b} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Durum>
          <div className="muted small" style={{ padding: '10px 4px 0' }}>
            Belgeler kayıt içindir; hangi belgenin kapandığına bakılmaz. Rafa bekleyen mal "Bekleyen ürünler" sekmesinde ürün bazlı hesaplanır.
          </div>
        </div>
      )}
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
