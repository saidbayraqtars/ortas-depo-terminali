import React, { useState } from 'react';
import { api, Btn, Durum, HAREKET, Icon, indir, miktar, Modal, Rozet, SayfaBaslik, tarihSaat, useApp, useDepo, useVeri } from '../lib.jsx';

/** Terminalden yapılan rafa kaldırmayı geri alma onayı (POST /hareket/:id/geri-al). */
export function RafaGeriAl({ h, kapat, tamam }) {
  const { toast } = useApp();
  const [not, setNot] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const onayla = async () => {
    setMesgul(true);
    try {
      const r = await api(`/hareket/${h.id}/geri-al`, { method: 'POST', body: { not } });
      toast(`Geri alındı: ${r.raf} rafından ${miktar(r.geriAlinan)} adet düşüldü${r.belgeSatiri ? '; belgede yeniden bekliyor' : ''}`);
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal
      baslik="Rafa kaldırma geri alınsın mı?"
      kapat={kapat}
      alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="danger solid" icon="undo" busy={mesgul} onClick={onayla}>Geri al</Btn></>}
    >
      <div className="stack">
        <div>
          <b>{h.urunAd}</b> · <span className="mono">{h.urunKod}</span>
          <div className="muted">{h.depoAd} · <span className="mono">{h.shelf}</span> rafı · {miktar(h.delta)} adet · {tarihSaat(h.ts)} · {h.user || '—'}{h.device ? ` · ${h.device}` : ''}</div>
        </div>
        <p style={{ margin: 0 }}>
          Ürün <b>{h.shelf}</b> rafından düşülür{h.ref ? `; ${h.ref} belgesinde bu miktar yeniden "rafa kaldırılacak" görünür, terminalden yeniden rafa kaldırılabilir` : ''}.
          Raf boşalırsa terminalden verilmiş raf adresi de kalkar (raf adresi yazımı açıksa Vega kartı güncellenir). Vega'da fiş olmadığından Vega'ya başka bir şey yazılmaz.
        </p>
        <label className="field">
          <span>Not (neden geri alındı?)</span>
          <input className="inp" value={not} onChange={(e) => setNot(e.target.value)} placeholder="Yanlış rafa kaldırıldı" maxLength={300} autoFocus />
        </label>
        <div className="notice warn"><Icon name="warning" /><p>Rafta o miktar kalmadıysa (sonradan raftan alındı ya da taşındı) geri alınmaz. Geri alma günlüğe yazılır.</p></div>
      </div>
    </Modal>
  );
}

const bugun = () => new Date().toISOString().slice(0, 10);
const gunOnce = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export default function Hareketler() {
  const { toast } = useApp();
  const [f, setF] = useState({ bas: gunOnce(7), bit: bugun(), tur: '', kullanici: '', cihaz: '', raf: '' });
  const [gorunum, setGorunum] = useState('hareket');
  const { depo, cok } = useDepo();
  const qs = new URLSearchParams(Object.entries({ ...f, depo }).filter(([, v]) => v)).toString();
  const { veri, hata, yukleniyor, yukle } = useVeri(gorunum === 'hareket' ? `/hareketler?${qs}` : null, [qs, gorunum]);
  const [geriAl, setGeriAl] = useState(null);
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
              <option value="PUTAWAY,PUTAWAY_GERI">Rafa kaldırma (geri almalar dahil)</option>
              <option value="TRANSFER_IN,TRANSFER_OUT">Transfer (raftan rafa)</option>
              <option value="TRANSFER_OUT_DEPO,TRANSFER_IN_DEPO">Depolar arası transfer</option>
              <option value="COUNT">Sayım</option>
              <option value="ADJUST">Düzeltme</option>
              <option value="DEPO_BIRLESTIR">Bekleme deposu geçişi</option>
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
                <thead><tr><th>Zaman</th><th>Tür</th><th>Ürün</th><th>Raf</th>{cok && !depo && <th>Depo</th>}<th className="num">Miktar</th><th className="num">Sonra</th><th>Belge / not</th><th>Kullanıcı</th><th>Cihaz</th><th></th></tr></thead>
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
                      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        {h.kind === 'PUTAWAY' && h.delta > 0 && (h.geri_at
                          ? <span title={`${tarihSaat(h.geri_at)} · ${h.geri_user || ''}${h.geri_not ? ` · ${h.geri_not}` : ''}`}><Rozet tur="b-mute">Geri alındı</Rozet></span>
                          : <Btn size="sm" icon="undo" onClick={() => setGeriAl(h)}>Geri al</Btn>)}
                      </td>
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
      {geriAl && <RafaGeriAl h={geriAl} kapat={() => setGeriAl(null)} tamam={() => { setGeriAl(null); yukle(); }} />}
    </>
  );
}
