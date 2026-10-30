import React, { useState } from 'react';
import { api, Btn, Durum, Icon, miktar, Modal, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useVeri } from '../lib.jsx';

const DURUM = {
  YAZILDI: ['Vega\'da', 'b-ok'],
  BEKLIYOR: ['Yazılacak', 'b-warn'],
  HATA: ['Yazılamadı', 'b-err'],
  GERI: ['Geri alındı', 'b-mute'],
};

/** Geri almanın ne yapacağı, işlem türüne göre; onay penceresinde gösterilir. */
function aciklama(y) {
  if (y.tur === 'TRANSFER_GONDERIM') {
    return y.durum === 'YAZILDI'
      ? "Vega'daki depo gönderim fişi silinir, gönderen depoda raflardan düşen mal raflara geri konur. Gönderimin kabulü başlamışsa geri alınmaz: önce kabul fişini geri alın."
      : "Fiş Vega'ya yazılmamıştı; yazılmayacak. Gönderen depoda raflardan düşen mal raflara geri konur.";
  }
  if (y.tur === 'TRANSFER_KABUL') {
    return y.durum === 'YAZILDI'
      ? "Vega'daki gönderim kabul fişi silinir, alan depoda rafa giren mal raflardan düşülür, kabulde açılan eksik kayıtları silinir. Gönderim terminallerde yeniden açık görünür."
      : "Fiş Vega'ya yazılmamıştı; yazılmayacak. Alan depoda rafa giren mal raflardan düşülür. Gönderim yeniden açık görünür.";
  }
  return "Sayımın Vega'ya yazılan fark fişleri silinir ve sayım yeniden \"Onay bekliyor\" durumuna döner. Raf miktarları sayılan değerde kalır.";
}

export function GeriAl({ y, kapat, tamam }) {
  const { toast } = useApp();
  const [not, setNot] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const sayim = y.tur === 'SAYIM';
  const onayla = async () => {
    setMesgul(true);
    try {
      const r = sayim
        ? await api(`/sayim/${encodeURIComponent(y.id)}/geri-al`, { method: 'POST', body: {} })
        : await api(`/transfer/${encodeURIComponent(y.id)}/geri-al`, { method: 'POST', body: { not } });
      toast(r?.vegaSilindi === false ? 'Geri alındı (Vega\'ya yazılmamıştı)' : 'Geri alındı; Vega fişi silindi');
      for (const u of r?.uyarilar || []) toast(u, true);
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal
      baslik="Geri alınsın mı?"
      kapat={kapat}
      alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="danger solid" icon="undo" busy={mesgul} onClick={onayla}>Geri al</Btn></>}
    >
      <div className="stack">
        <div>
          <b>{y.tanim}</b> · <span className="mono">{y.belgeNo || '—'}</span>
          <div className="muted">{y.depo}{y.kalem ? ` · ${y.kalem} kalem` : ''}{y.adet ? ` · ${miktar(y.adet)} adet` : ''}</div>
        </div>
        <p style={{ margin: 0 }}>{aciklama(y)}</p>
        {!sayim && (
          <label className="field">
            <span>Not (neden geri alındı?)</span>
            <input className="inp" value={not} onChange={(e) => setNot(e.target.value)} placeholder="Yanlış depodan gönderildi" maxLength={300} autoFocus />
          </label>
        )}
        <div className="notice warn"><Icon name="warning" /><p>Geri alma günlüğe yazılır. Vega'da bu fişe başka bir belge bağlandıysa işlem reddedilir.</p></div>
      </div>
    </Modal>
  );
}

export default function VegaYazimlari() {
  const { veri, hata, yukleniyor, yukle } = useVeri('/vega-yazimlari');
  const [tur, setTur] = useState('hepsi');
  const [durum, setDurum] = useState('aktif');
  const [geriAl, setGeriAl] = useState(null);
  const liste = (veri?.liste || []).filter((y) => {
    if (tur === 'transfer' && !y.tur.startsWith('TRANSFER')) return false;
    if (tur === 'sayim' && y.tur !== 'SAYIM') return false;
    if (durum === 'aktif') return y.durum !== 'GERI' && y.durum !== 'CLOSED' && y.durum !== 'OPEN' && y.durum !== 'CANCELLED';
    if (durum === 'geri') return y.durum === 'GERI';
    return true;
  });
  return (
    <>
      <SayfaBaslik baslik="Vega'ya yazılanlar" alt="Programın Vega'ya yazdığı fişler; yanlış yapılan işlemi buradan geri alabilirsiniz">
        <Btn icon="refresh" onClick={yukle}>Yenile</Btn>
      </SayfaBaslik>
      <div className="notice info" style={{ marginBottom: 14 }}>
        <Icon name="info" />
        <p>
          Geri alınca Vega'daki fiş silinir ve programdaki raf stoku eski haline döner. Yalnızca programın yazdığı fişler listelenir;
          Vega'da elle girilen belgelere dokunulmaz. Raf adresi (KOD10) yazımları ve hareketler için <a href="#/hareketler">Hareketler</a>'e bakın.
        </p>
      </div>
      <div className="card">
        <div className="toolbar">
          <Secim deger={tur} degis={setTur} secenekler={[['hepsi', 'Hepsi'], ['transfer', 'Depo transferi'], ['sayim', 'Sayım']]} />
          <Secim deger={durum} degis={setDurum} secenekler={[['aktif', 'Vega\'da duranlar'], ['geri', 'Geri alınanlar'], ['hepsi', 'Hepsi']]} />
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && liste.length === 0 && 'Gösterilecek kayıt yok.'}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Zaman</th><th>Fiş</th><th>Belge no</th><th>Depo</th><th className="num">Kalem · adet</th><th>Kim</th><th>Durum</th><th /></tr></thead>
              <tbody>
                {liste.map((y) => {
                  const [ad, rozet] = DURUM[y.durum] || [y.durum, 'b-mute'];
                  const geriAlinabilir = y.durum !== 'GERI' && (y.tur === 'SAYIM' ? y.durum === 'YAZILDI' : ['YAZILDI', 'BEKLIYOR', 'HATA'].includes(y.durum));
                  return (
                    <tr key={`${y.tur}-${y.id}`}>
                      <td className="muted">{tarihSaat(y.zaman)}</td>
                      <td>{y.tanim}{y.sayimNo ? <div className="muted small">{y.sayimNo}</div> : null}</td>
                      <td className="mono">{y.belgeNo || '—'}</td>
                      <td>{y.depo}</td>
                      <td className="num">{y.kalem}{y.adet ? ` · ${miktar(y.adet)}` : ''}</td>
                      <td className="muted">{y.kullanici ? `${y.kullanici}${y.cihaz ? ' · ' + y.cihaz : ''}` : '—'}</td>
                      <td>
                        <Rozet tur={rozet}>{ad}</Rozet>
                        {y.hata && <div className="small" style={{ color: 'var(--err)', marginTop: 4 }}>{y.hata}</div>}
                        {y.geriAt && <div className="muted small" style={{ marginTop: 4 }}>{tarihSaat(y.geriAt)} · {y.geriKullanici}{y.geriNot ? ` · ${y.geriNot}` : ''}</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {geriAlinabilir && <Btn size="sm" kind="danger" icon="undo" onClick={() => setGeriAl(y)}>Geri al</Btn>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Durum>
      </div>
      {geriAl && <GeriAl y={geriAl} kapat={() => setGeriAl(null)} tamam={() => { setGeriAl(null); yukle(); }} />}
    </>
  );
}
