import React, { useEffect, useState } from 'react';
import { api, Btn, Durum, HAREKET, Icon, kilitDestegiYok, miktar, once, Rozet, SayfaBaslik, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

const ISLEM_AD = { PUTAWAY: 'Rafa kaldırma', TRANSFER: 'Transfer', COUNT_SUBMIT: 'Sayım gönderimi', SHELF_ARRANGE: 'Raf düzenleme' };

function Kurulum({ d }) {
  const adim = [
    [d.vega.ok, 'Vega bağlantısı', 'Ayarlar › Vega: sunucu, firma ve depo seçin.', '/ayarlar'],
    [d.sayilar.raf > 0, 'Raflar', 'Raflar › Toplu raf oluştur, sonra etiketleri yazdırın.', '/raflar'],
    [d.sayilar.kullanici > 0, 'Terminal kullanıcıları', 'Kullanıcılar › Yeni kullanıcı (ad ve 4-8 haneli şifre).', '/kullanicilar'],
    [d.cihazlar.length > 0, 'Cihazlar', 'Cihazlar › Yeni cihaz; terminalde Ayarlar › QR ile kur.', '/cihazlar'],
  ];
  if (adim.every((a) => a[0])) return null;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head"><Icon name="info" /><h2>Kurulum</h2></div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        {adim.map(([tamam, ad, aciklama, yol], i) => (
          <a key={ad} href={'#' + yol} className="row" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className={`badge ${tamam ? 'b-ok' : 'b-mute'}`} style={{ width: 26, justifyContent: 'center' }}>{tamam ? <Icon name="check" size={14} /> : i + 1}</span>
            <b style={{ minWidth: 190 }}>{ad}</b>
            <span className="muted">{aciklama}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * Açık belgeler: mal kabul / rafa kaldırma / gelen transfer belgesini şu an ekranında tutan terminaller (belge kilidi).
 * Kilit arayüz korumasıdır; açmak işlemleri silmez, tutan terminal bekleyen işini kaydedip belgeden çıkar.
 * Kilit durumu ana veriyi değiştirmediği için liste kendisi 10 sn'de bir yenilenir.
 */
function AcikBelgeler() {
  const { toast } = useApp();
  const { veri, hata, yukleniyor, yukle } = useVeri('/kilitler');
  const [sor, onay] = useOnay();
  useEffect(() => {
    const t = setInterval(yukle, 10000);
    return () => clearInterval(t);
  }, [yukle]);
  const liste = veri?.liste || [];
  const ac = async (k) => {
    if (!(await sor('Bu kilit açılsın mı?', `${k.belgeNo}: ${k.user || '?'} (${k.device}) bu belgeyi kullanıyor.

Açılırsa terminal bekleyen işini kaydedip belgeden çıkar; kaydedilenler silinmez. Başka bir terminal belgeye girebilir.`, { tamam: 'Kilidi aç', tehlike: true }))) return;
    try {
      await api('/kilitler/ac', { method: 'POST', body: { belgeId: k.id } });
      toast('Kilit açıldı');
      yukle();
    } catch (e) {
      toast(e.message, true);
      yukle();
    }
  };
  const sifirla = async () => {
    if (!(await sor('Tüm kilitler sıfırlansın mı?', `${liste.length} belgedeki kilit kalkar. Belgeyi kullanan çalışanların terminalleri bekleyen işlerini kaydedip belgeden çıkar; yaptıkları işler kaydedilir, kaybolmaz.

Çalışanlar uyarılmadan kilit düşer; gerekirse önce kendilerine haber verin.`, { tamam: 'Tümünü sıfırla', tehlike: true }))) return;
    try {
      const r = await api('/kilitler/sifirla', { method: 'POST' });
      toast(`${r.sifirlanan} kilit sıfırlandı`);
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <Icon name="lock" /><h2>Açık belgeler</h2><div className="grow" />
        <Btn size="sm" kind="danger" disabled={!liste.length} onClick={sifirla}>Tüm kilitleri sıfırla</Btn>
      </div>
      <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && !liste.length && 'Şu an hiçbir belge bir terminalde açık değil. Terminal bir belgeye girince burada görünür; çıkınca ya da 3 dakika nabız vermezse kalkar.'}>
        <table className="tbl">
          <thead><tr><th>Belge</th><th>Kim</th><th>Cihaz</th><th>Ne zamandır</th><th>Son nabız</th><th /></tr></thead>
          <tbody>
            {liste.map((k) => (
              <tr key={k.id}>
                <td>
                  <div className="row" style={{ gap: 8 }}><Icon name="lock" size={14} /><b className="mono">{k.belgeNo}</b>{k.tur === 'TRANSFER' && <Rozet tur="b-info">gelen transfer</Rozet>}</div>
                  {(k.firma || k.depoAd) && <div className="muted small">{[k.firma, k.depoAd].filter(Boolean).join(' · ')}</div>}
                </td>
                <td>{k.user || '—'}</td>
                <td className="mono">{k.device}</td>
                <td className="muted">{k.sureDk < 1 ? 'az önce' : `${k.sureDk} dk`} · {tarihSaat(k.since)}</td>
                <td className="muted">{once(k.last)}</td>
                <td><div className="btns" style={{ justifyContent: 'flex-end' }}><Btn size="sm" onClick={() => ac(k)}>Bu kilidi aç</Btn></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Durum>
      {onay}
    </div>
  );
}

export default function Ozet() {
  const { durum: d, toast, yenile } = useApp();
  const [yenileniyor, setYenileniyor] = useState(false);
  if (!d) return null;
  const s = d.sayilar;
  const v = d.vega;
  const bugun = Object.fromEntries((d.bugun || []).map((x) => [x.type, x]));

  const vegaYenile = async () => {
    setYenileniyor(true);
    try {
      const r = await api('/vega/yenile', { method: 'POST' });
      if (r.ok) toast('Vega verisi yenilendi');
      else toast(r.hata || 'Vega okunamadı', true);
      yenile();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setYenileniyor(false);
    }
  };

  return (
    <>
      <SayfaBaslik baslik="Özet" alt={new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} />
      <Kurulum d={d} />
      {!v.ok && v.hazir && v.hata && (
        <div className="notice err" style={{ marginBottom: 14 }}>
          <Icon name="wifiOff" />
          <p>Vega'ya ulaşılamıyor: {v.hata}. {v.at ? `Terminaller ${tarihSaat(v.at)} tarihli son veriyle çalışmaya devam ediyor.` : ''}</p>
        </div>
      )}
      {(d.kopruler || []).map((k) => (
        <div key={k.ad} className={`notice ${k.bagli ? 'info' : 'warn'}`} style={{ marginBottom: 14 }}>
          <Icon name={k.bagli ? 'wifi' : 'wifiOff'} />
          <p><b>{k.ad}:</b> {k.bagli ? 'bağlı' : 'bağlı değil'} · son görülme {once(k.son)} ({k.ip}){k.surum ? ` · sürüm ${k.surum}` : ''}.{!k.bagli && ' Köprü bilgisayarı kapalı ya da VPN kopuk olabilir; o şubedeki terminaller çevrimdışı çalışır ve işlemleri sonra gönderir.'}</p>
        </div>
      ))}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <a className="card stat" href="#/kabul">
          <span className="k"><Icon name="package" size={16} /> Açık mal kabul</span>
          <span className="v">{s.acikBelge}</span>
          <span className="s">{s.bekleyenKalem} kalem rafa kaldırılmayı bekliyor</span>
        </a>
        <a className={`card stat ${s.onayBekleyen ? 'warn' : ''}`} href="#/sayimlar">
          <span className="k"><Icon name="count" size={16} /> Sayımlar</span>
          <span className="v">{s.onayBekleyen}</span>
          <span className="s">onay bekliyor · {s.acikSayim} sayım sürüyor</span>
        </a>
        <a className="card stat" href="#/raflar">
          <span className="k"><Icon name="layers" size={16} /> Raflar</span>
          <span className="v">{s.doluRaf}<small className="muted" style={{ fontSize: 15 }}> / {s.raf}</small></span>
          <span className="s">dolu raf · {s.rafUrun} ürün rafta</span>
        </a>
        <a className="card stat" href="#/hareketler">
          <span className="k"><Icon name="history" size={16} /> Bugün</span>
          <span className="v">{(bugun.PUTAWAY?.n || 0) + (bugun.TRANSFER?.n || 0) + (bugun.COUNT_SUBMIT?.n || 0) + (bugun.SHELF_ARRANGE?.n || 0)}</span>
          <span className="s">
            {bugun.PUTAWAY?.n || 0} rafa kaldırma · {bugun.TRANSFER?.n || 0} transfer · {bugun.COUNT_SUBMIT?.n || 0} sayım{bugun.SHELF_ARRANGE?.n ? ` · ${bugun.SHELF_ARRANGE.n} raf düzenleme` : ''}
            {s.hataliIslem ? ` · ${s.hataliIslem} reddedildi` : ''}
          </span>
        </a>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head">
            <Icon name="mobile" /><h2>Terminaller</h2><div className="grow" />
            <a className="btn sm" href="#/cihazlar">Cihazlar</a>
          </div>
          {d.cihazlar.length === 0 ? (
            <div className="empty">Henüz cihaz yok. Cihazlar ekranından ekleyin.</div>
          ) : (
            <table className="tbl">
              <thead><tr><th>Cihaz</th><th>Kullanıcı</th><th>Son bağlantı</th><th>Sürüm</th></tr></thead>
              <tbody>
                {d.cihazlar.map((c) => {
                  const canli = c.last_seen && Date.now() - c.last_seen < 3 * 60 * 1000;
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <span className={`pill ${canli ? 'on' : 'off'}`} style={{ padding: '0 6px' }}>{canli ? '●' : '○'}</span>
                          <b>{c.name}</b>{!c.active && <Rozet tur="b-mute">kapalı</Rozet>}
                        </div>
                      </td>
                      <td>{c.last_user || '—'}</td>
                      <td className="muted">{once(c.last_seen)}{c.last_ip ? ` · ${c.last_ip}` : ''}</td>
                      <td className="mono small">{c.app_version || '—'}{kilitDestegiYok(c.app_version) && <div><Rozet tur="b-warn">kilit desteği yok</Rozet></div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <Icon name="database" /><h2>Vega</h2><div className="grow" />
            <Btn size="sm" icon="refresh" busy={yenileniyor || v.calisiyor} onClick={vegaYenile}>Şimdi yenile</Btn>
          </div>
          <div className="card-pad">
            {v.hazir ? (
              <dl className="kv">
                <dt>Durum</dt>
                <dd>{v.ok ? <Rozet tur="b-ok">Bağlı</Rozet> : <Rozet tur="b-err">Ulaşılamıyor</Rozet>}</dd>
                <dt>Firma / dönem</dt>
                <dd className="mono">{v.firma ? `F${String(v.firma).padStart(4, '0')} · D${String(v.donem).padStart(4, '0')}` : '—'}</dd>
                <dt>Depo</dt>
                <dd>{v.depoAd || '—'}</dd>
                <dt>Stok kartı</dt>
                <dd>{miktar(v.urun)}</dd>
                <dt>Son okuma</dt>
                <dd>{v.at ? `${tarihSaat(v.at)}${v.sureMs ? ` (${(v.sureMs / 1000).toFixed(1)} sn)` : ''}` : '—'}{v.at && v.degisiklik === false && <span className="muted small"> · değişiklik yok</span>}</dd>
                <dt>Son deneme</dt>
                <dd>{v.deneme ? `${tarihSaat(v.deneme)}${v.tetik ? ` · ${v.tetik}` : ''}` : '—'}{v.calisiyor && <span className="muted small"> · okunuyor</span>}{v.ardisikHata > 0 && <Rozet tur="b-err">{v.ardisikHata} kez üst üste hata</Rozet>}</dd>
                <dt>Sonraki okuma</dt>
                <dd>{v.sonraki ? new Date(v.sonraki).toLocaleTimeString('tr-TR') : '—'}</dd>
                {v.sureler && v.sureMs > 5000 && (
                  <>
                    <dt>Sorgu süreleri</dt>
                    <dd className="muted small">{Object.entries(v.sureler).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)} sn`).join(' · ')}</dd>
                  </>
                )}
              </dl>
            ) : (
              <div className="notice warn"><Icon name="warning" /><p>Vega bağlantısı ayarlanmadı. <a href="#/ayarlar">Ayarlar</a></p></div>
            )}
          </div>
        </div>
      </div>

      <AcikBelgeler />

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head"><Icon name="history" /><h2>Son hareketler</h2><div className="grow" /><a className="btn sm" href="#/hareketler">Tümü</a></div>
        {d.sonHareketler.length === 0 ? (
          <div className="empty">Henüz hareket yok.</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Zaman</th><th>Tür</th><th>Ürün</th><th>Raf</th><th className="num">Miktar</th><th>Kim</th></tr></thead>
            <tbody>
              {d.sonHareketler.map((h) => (
                <tr key={h.id} className="click" onClick={() => (window.location.hash = `/urun/${h.product_id}`)}>
                  <td className="muted">{tarihSaat(h.ts)}</td>
                  <td><Rozet tur={(HAREKET[h.kind] || [])[1]}>{(HAREKET[h.kind] || [h.kind])[0]}</Rozet></td>
                  <td><div className="name">{h.urunAd}</div><div className="code">{h.urunKod}</div></td>
                  <td className="mono">{h.shelf}{d.depolar?.length > 1 && <div className="code">{h.depoAd}</div>}</td>
                  <td className={`num ${h.delta > 0 ? 'pos' : h.delta < 0 ? 'neg' : ''}`}>{miktar(h.delta, true)}</td>
                  <td className="muted">{h.user || '—'}{h.device ? ` · ${h.device}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export { ISLEM_AD };
