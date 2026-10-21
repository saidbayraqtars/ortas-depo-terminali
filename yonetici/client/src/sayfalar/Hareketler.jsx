import React, { useState } from 'react';
import { Btn, Durum, HAREKET, Icon, indir, miktar, Rozet, SayfaBaslik, tarihSaat, useApp, useDepo, useVeri } from '../lib.jsx';

const bugun = () => new Date().toISOString().slice(0, 10);
const gunOnce = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export default function Hareketler() {
  const { toast } = useApp();
  const [f, setF] = useState({ bas: gunOnce(7), bit: bugun(), tur: '', kullanici: '', cihaz: '', raf: '' });
  const [gorunum, setGorunum] = useState('hareket');
  const { depo, cok } = useDepo();
  const qs = new URLSearchParams(Object.entries({ ...f, depo }).filter(([, v]) => v)).toString();
  const { veri, hata, yukleniyor } = useVeri(gorunum === 'hareket' ? `/hareketler?${qs}` : null, [qs, gorunum]);
  const islem = useVeri(gorunum === 'islem' ? '/islemler?hatali=1' : null, [gorunum]);
  const d = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <>
      <SayfaBaslik baslik="Hareketler" alt="Raflardaki her değişiklik: kim, ne zaman, hangi cihazla">
        <div className="seg">
          <button className={gorunum === 'hareket' ? 'on' : ''} onClick={() => setGorunum('hareket')}>Raf hareketleri</button>
          <button className={gorunum === 'islem' ? 'on' : ''} onClick={() => setGorunum('islem')}>Reddedilen işlemler</button>
        </div>
        {gorunum === 'hareket' && <Btn icon="export" onClick={() => indir(`/hareketler.csv?${qs}`, 'hareketler.csv').catch((e) => toast(e.message, true))}>Excel (CSV)</Btn>}
      </SayfaBaslik>
      {gorunum === 'hareket' ? (
        <div className="card">
          <div className="toolbar">
            <input type="date" className="inp" style={{ width: 150 }} value={f.bas} onChange={d('bas')} />
            <span className="muted">–</span>
            <input type="date" className="inp" style={{ width: 150 }} value={f.bit} onChange={d('bit')} />
            <select className="inp" style={{ width: 170 }} value={f.tur} onChange={d('tur')}>
              <option value="">Tüm türler</option>
              <option value="PUTAWAY">Rafa kaldırma</option>
              <option value="TRANSFER_IN,TRANSFER_OUT">Transfer</option>
              <option value="COUNT">Sayım</option>
              <option value="ADJUST">Düzeltme</option>
            </select>
            <select className="inp" style={{ width: 150 }} value={f.kullanici} onChange={d('kullanici')}>
              <option value="">Tüm kullanıcılar</option>
              {veri?.kisiler.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select className="inp" style={{ width: 140 }} value={f.cihaz} onChange={d('cihaz')}>
              <option value="">Tüm cihazlar</option>
              {veri?.cihazlar.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input className="inp mono" style={{ width: 120 }} placeholder="Raf" value={f.raf} onChange={(e) => setF((x) => ({ ...x, raf: e.target.value.toUpperCase() }))} />
            <div className="grow" />
            {veri && <span className="muted">{miktar(veri.toplam)} hareket{veri.toplam > veri.liste.length ? ` (son ${veri.liste.length})` : ''}</span>}
          </div>
          <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && veri.liste.length === 0 && 'Bu aralıkta hareket yok.'}>
            <div className="tbl-wrap tbl-scroll" style={{ maxHeight: 'calc(100vh - 220px)' }}>
              <table className="tbl">
                <thead><tr><th>Zaman</th><th>Tür</th><th>Ürün</th><th>Raf</th>{cok && !depo && <th>Depo</th>}<th className="num">Miktar</th><th className="num">Sonra</th><th>Belge / not</th><th>Kullanıcı</th><th>Cihaz</th></tr></thead>
                <tbody>
                  {veri?.liste.map((h) => (
                    <tr key={h.id} className="click" onClick={() => (window.location.hash = `/urun/${h.product_id}`)}>
                      <td className="muted">{tarihSaat(h.ts)}</td>
                      <td><Rozet tur={(HAREKET[h.kind] || [])[1]}>{(HAREKET[h.kind] || [h.kind])[0]}</Rozet></td>
                      <td><div className="name">{h.urunAd}</div><div className="code">{h.urunKod}</div></td>
                      <td className="mono">{h.shelf}</td>
                      {cok && !depo && <td className="muted">{h.depoAd}</td>}
                      <td className={`num ${h.delta > 0 ? 'pos' : h.delta < 0 ? 'neg' : ''}`}>{miktar(h.delta, true)}</td>
                      <td className="num">{miktar(h.after)}</td>
                      <td className="muted">{h.ref || ''}</td>
                      <td>{h.user || '—'}</td>
                      <td className="muted">{h.device || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Durum>
        </div>
      ) : (
        <div className="card">
          <div className="notice info" style={{ margin: 16 }}><Icon name="info" /><p>Sunucunun kalıcı olarak reddettiği işlemler. Terminalde "Hata" olarak görünürler; kullanıcı silebilir.</p></div>
          <Durum yukleniyor={islem.yukleniyor && !islem.veri} hata={islem.hata} bos={islem.veri && islem.veri.length === 0 && 'Reddedilen işlem yok.'}>
            <table className="tbl">
              <thead><tr><th>Alındı</th><th>Tür</th><th>Kullanıcı</th><th>Cihaz</th><th>Hata</th><th>İçerik</th></tr></thead>
              <tbody>
                {islem.veri?.map((o) => (
                  <tr key={o.id}>
                    <td className="muted">{tarihSaat(o.received_at)}</td>
                    <td className="mono small">{o.type}</td>
                    <td>{o.user}</td>
                    <td className="muted">{o.device}</td>
                    <td><Rozet tur="b-err">{o.error}</Rozet></td>
                    <td className="mono small muted" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(o.payload)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Durum>
        </div>
      )}
    </>
  );
}
