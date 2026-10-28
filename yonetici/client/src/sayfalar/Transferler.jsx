import React, { useState } from 'react';
import { api, Btn, Durum, Icon, miktar, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

const DURUM = {
  BEKLIYOR: ['Vega\'ya yazılacak', 'b-warn'],
  YAZILDI: ['Vega\'ya yazıldı', 'b-ok'],
  HATA: ['Yazılamadı', 'b-err'],
};

const FARK_DURUM = {
  ACIK: ['Eksik açık', 'b-warn'],
  KAYIP: ['Kayıp', 'b-mute'],
  BULUNDU: ['Bulundu', 'b-ok'],
};

function FarkSatiri({ f, yukle }) {
  const { toast } = useApp();
  const [acik, setAcik] = useState(false);
  const [cozum, setCozum] = useState('KAYIP');
  const [not, setNot] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const gonder = async (yol, govde = {}) => {
    setMesgul(true);
    try {
      await api(`/transfer/fark/${f.id}/${yol}`, { method: 'POST', body: govde });
      toast(yol === 'coz' ? 'Eksik çözüldü olarak işaretlendi' : 'Eksik yeniden açıldı');
      setAcik(false);
      yukle();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  const [dad, dtur] = FARK_DURUM[f.durum] || [f.durum, 'b-mute'];
  return (
    <>
      <tr>
        <td className="muted">{tarihSaat(f.created_at)}</td>
        <td className="mono">{f.sevk_no || f.sevk_ind}</td>
        <td>{f.fromAd} <span className="muted">→</span> {f.toAd}</td>
        <td><div className="name">{f.ad}</div><div className="code">{f.kod}</div></td>
        <td className="num">{miktar(f.sent)}</td>
        <td className="num">{miktar(f.received)}</td>
        <td className="num"><b>{miktar(f.eksik)}</b></td>
        <td className="muted">{f.user}</td>
        <td>
          <Rozet tur={dtur}>{dad}</Rozet>
          {f.cozum && <div className="muted small" style={{ marginTop: 4 }}>{f.cozum}</div>}
        </td>
        <td style={{ textAlign: 'right' }}>
          {f.durum === 'ACIK' ? <Btn size="sm" onClick={() => setAcik((x) => !x)}>Çöz</Btn> : <Btn size="sm" busy={mesgul} onClick={() => gonder('ac')}>Yeniden aç</Btn>}
        </td>
      </tr>
      {acik && (
        <tr>
          <td colSpan={10} style={{ background: 'var(--ground)' }}>
            <div className="toolbar" style={{ margin: 0 }}>
              <Secim deger={cozum} degis={setCozum} secenekler={[['KAYIP', 'Bulunamadı, kayıp'], ['BULUNDU', 'Bulundu, Vega\'da kabul edilecek']]} />
              <input className="inp" style={{ flex: 1, minWidth: 220 }} placeholder="Not (nerede, neden eksik?)" value={not} onChange={(e) => setNot(e.target.value)} />
              <Btn kind="primary" busy={mesgul} onClick={() => gonder('coz', { cozum, not })}>Kaydet</Btn>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>
              "Bulundu" seçilirse mal Vega'da ayrıca kabul edilir (yoldaki depodan alan depoya 129 fişi); program o miktarı yeniden açık gönderim olarak gösterir.
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function IslemSatiri({ t, yukle }) {
  const { toast } = useApp();
  const [ac, setAc] = useState(false);
  const [mesgul, setMesgul] = useState(false);
  const [ad, tur] = DURUM[t.durum] || [t.durum, 'b-mute'];
  const gonder = t.kind === 'SEND';
  const yeniden = async () => {
    setMesgul(true);
    try {
      await api(`/transfer/${encodeURIComponent(t.id)}/yeniden`, { method: 'POST', body: {} });
      toast('Yeniden denenecek');
      yukle();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <>
      <tr className="click" onClick={() => setAc((x) => !x)}>
        <td className="muted">{tarihSaat(t.created_at)}</td>
        <td>{gonder ? 'Gönderim (128)' : 'Kabul (129)'}{t.kismi ? <div><Rozet tur="b-info">kısmi kabul</Rozet></div> : null}</td>
        <td>{t.fromAd} <span className="muted">→</span> {t.toAd}</td>
        <td className="num">{t.satirlar.length} kalem · {miktar(t.toplam)}</td>
        <td className="muted">{t.user} · {t.device}</td>
        <td className="mono">{t.belge_no || '—'}</td>
        <td>
          <Rozet tur={tur}>{ad}</Rozet>
          {t.hata && <div className="muted small" style={{ marginTop: 4, color: 'var(--err)' }}>{t.hata}{t.deneme ? ` (deneme ${t.deneme})` : ''}</div>}
        </td>
        <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
          {(t.durum === 'HATA' || t.durum === 'BEKLIYOR') && <Btn size="sm" busy={mesgul} icon="refresh" onClick={yeniden}>Yeniden dene</Btn>}
        </td>
      </tr>
      {ac && (
        <tr>
          <td colSpan={8} style={{ background: 'var(--ground)' }}>
            <table className="tbl">
              <thead><tr><th>Ürün</th><th>Raf</th><th className="num">Miktar</th></tr></thead>
              <tbody>
                {t.satirlar.map((l, i) => (
                  <tr key={i}>
                    <td><div className="name">{l.ad}</div><div className="code">{l.kod}</div></td>
                    <td className="mono">{l.shelf || (gonder ? 'rafsız' : '—')}{l.otomatik ? <div className="muted small">raf otomatik seçildi</div> : null}</td>
                    <td className="num">{miktar(l.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function AcikKapat({ ind, yukle }) {
  const { toast } = useApp();
  const [sor, onayPenceresi] = useOnay();
  const kapat = async () => {
    if (!(await sor('Gönderim kapatılsın mı?', "Terminallerde kabul listesinden kalkar. Kalan miktar \"kayıp\" eksik olarak kaydedilir (Eksikler sekmesinde görünür). Vega'daki belge değişmez. Gönderim Vega'da zaten kabul edilmişse ya da hatalı görünüyorsa kullanın.", { tamam: 'Kapat' }))) return;
    try {
      await api(`/transfer/acik/${ind}/kapat`, { method: 'POST', body: {} });
      toast('Gönderim kapatıldı');
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <>
      <Btn size="sm" onClick={kapat}>Kapat</Btn>
      {onayPenceresi}
    </>
  );
}

export default function Transferler() {
  const { toast } = useApp();
  const [sekme, setSekme] = useState('fark');
  const { veri, hata, yukleniyor, yukle } = useVeri('/transfer');
  const [mesgul, setMesgul] = useState(false);
  const yenile = async () => {
    setMesgul(true);
    try {
      await api('/transfer/yenile', { method: 'POST', body: {} });
      yukle();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  const acikFark = veri?.farklar.filter((f) => f.durum === 'ACIK').length || 0;
  return (
    <>
      <SayfaBaslik baslik="Depo transferi" alt="Terminalden gönderilen ve kabul edilen depolar arası transferler; kabulde gelmeyen mal">
        <Btn icon="refresh" busy={mesgul} onClick={yenile}>Vega'dan yenile</Btn>
      </SayfaBaslik>
      <Durum yukleniyor={yukleniyor && !veri} hata={hata}>
        {veri && (
          <>
            {!veri.ayar.aktif && (
              <div className="notice warn" style={{ marginBottom: 14 }}>
                <Icon name="warning" />
                <p>Depolar arası transfer kapalı: terminalde ekranı görünmez. <a href="#/ayarlar">Ayarlar › Depolar arası transfer</a>'den açın.</p>
              </div>
            )}
            {veri.ayar.aktif && !veri.yolda && (
              <div className="notice err" style={{ marginBottom: 14 }}>
                <Icon name="alert" />
                <p>Yoldaki depo bulunamadı (Vega'da adı TRANSFER olan depo yok). Ayarlar › Depolar arası transfer'de yoldaki depoyu seçin.</p>
              </div>
            )}
            {veri.hatali > 0 && (
              <div className="notice err" style={{ marginBottom: 14 }}>
                <Icon name="alert" />
                <p>{veri.hatali} transfer Vega'ya yazılamadı. Aşağıda "Gönderim ve kabuller" listesinde hatayı görüp yeniden deneyebilirsiniz.</p>
              </div>
            )}
            {veri.bekleyen > 0 && (
              <div className="notice info" style={{ marginBottom: 14 }}>
                <Icon name="info" />
                <p>{veri.bekleyen} transfer Vega'ya yazılmayı bekliyor (Vega'ya ulaşılamıyorsa kısa aralıklarla yeniden denenir).</p>
              </div>
            )}
            <div className="card">
              <div className="toolbar">
                <Secim
                  deger={sekme}
                  degis={setSekme}
                  secenekler={[['fark', `Eksikler${acikFark ? ` (${acikFark})` : ''}`], ['islem', 'Gönderim ve kabuller'], ['acik', `Yoldaki gönderimler (${veri.acik.length})`]]}
                />
                <div className="grow" />
                {veri.yoldaAd && <span className="muted">Yoldaki depo: {veri.yoldaAd}</span>}
              </div>
              {sekme === 'fark' && (
                <>
                  <div className="muted small" style={{ padding: '0 16px 10px' }}>
                    Kabulde gelmeyen mal burada çözülene kadar kalır: hangi depo gönderdi, hangi ürün, kaç adet eksik. Gönderim terminallerde kapanır; eksik miktar Vega'da yoldaki depoda durur.
                  </div>
                  {veri.farklar.length === 0 ? (
                    <div className="empty">Eksik kayıt yok.</div>
                  ) : (
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead><tr><th>Kabul zamanı</th><th>Gönderim</th><th>Depo</th><th>Ürün</th><th className="num">Gönderilen</th><th className="num">Alınan</th><th className="num">Eksik</th><th>Kabul eden</th><th>Durum</th><th /></tr></thead>
                        <tbody>{veri.farklar.map((f) => <FarkSatiri key={f.id} f={f} yukle={yukle} />)}</tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
              {sekme === 'islem' &&
                (veri.transferler.length === 0 ? (
                  <div className="empty">Terminalden henüz depolar arası transfer yapılmadı.</div>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead><tr><th>Zaman</th><th>İşlem</th><th>Depo</th><th className="num">Kalem · miktar</th><th>Kim</th><th>Vega belge no</th><th>Durum</th><th /></tr></thead>
                      <tbody>{veri.transferler.map((t) => <IslemSatiri key={t.id} t={t} yukle={yukle} />)}</tbody>
                    </table>
                  </div>
                ))}
              {sekme === 'acik' &&
                (veri.acik.length === 0 ? (
                  <div className="empty">Kabul bekleyen gönderim yok.</div>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead><tr><th>Tarih</th><th>Gönderim no</th><th>Depo</th><th>Satırlar</th><th /></tr></thead>
                      <tbody>
                        {veri.acik.map((s) => (
                          <tr key={s.ind}>
                            <td className="muted">{s.tarih}</td>
                            <td className="mono">{s.no}</td>
                            <td>{s.fromAd} <span className="muted">→</span> {s.toAd}</td>
                            <td>{s.satirlar.map((l) => `${l.kod} × ${miktar(l.open)}`).join(', ')}</td>
                            <td style={{ textAlign: 'right' }}><AcikKapat ind={s.ind} yukle={yukle} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          </>
        )}
      </Durum>
    </>
  );
}
