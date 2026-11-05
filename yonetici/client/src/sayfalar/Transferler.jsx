import React, { useState } from 'react';
import { GeriAl } from './VegaYazimlari.jsx';
import { Alan, api, Btn, Durum, Icon, miktar, Modal, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

const DURUM = {
  BEKLIYOR: ['Vega\'ya yazılacak', 'b-warn'],
  YAZILDI: ['Vega\'ya yazıldı', 'b-ok'],
  HATA: ['Yazılamadı', 'b-err'],
  GERI: ['Geri alındı', 'b-mute'],
};

/** Eksik ya da fazla çıkan kabulü reddeder: kabul geri alınır, gönderim terminale döner; not terminalde belgenin üstünde görünür. */
function Reddet({ tur, f, yukle }) {
  const { toast } = useApp();
  const [acik, setAcik] = useState(false);
  const [not, setNot] = useState(`${f.ad || f.kod}: kaç adet olmalıydı? Kontrol edip yeniden girin.`);
  const [mesgul, setMesgul] = useState(false);
  const gonder = async () => {
    setMesgul(true);
    try {
      const r = await api('/transfer/tekrar', { method: 'POST', body: { tur, id: f.id, not } });
      toast(`${r.sevkNo || 'Gönderim'} terminale geri gönderildi${r.vegaSilindi ? "; Vega'daki kabul fişi silindi" : ''}`);
      setAcik(false);
      yukle();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <>
      <Btn size="sm" onClick={() => setAcik(true)}>Reddet</Btn>
      {acik && (
        <Modal baslik="Terminale geri gönderilsin mi?" kapat={() => setAcik(false)} alt={<><Btn onClick={() => setAcik(false)}>Vazgeç</Btn><Btn kind="primary" busy={mesgul} onClick={gonder}>Geri gönder</Btn></>}>
          <div className="stack" style={{ gridTemplateColumns: 'minmax(0, 1fr)', width: '100%' }}>
          <p style={{ margin: 0, whiteSpace: 'normal' }}>
            <b>{f.sevk_no || f.sevk_ind}</b> gönderiminin kabulü geri alınır: alıcı depodaki raf girişi düşer, Vega'ya yazılmış kabul fişi varsa silinir,
            belge terminalde yeniden açılır. Aşağıdaki not terminalde belgenin üstünde görünür.
          </p>
          <Alan etiket="Terminale not" ipucu="Kabul eden kişi bu notu görüp belgeyi yeniden sayar.">
            <textarea className="inp" style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }} rows={3} value={not} maxLength={300} onChange={(e) => setNot(e.target.value)} autoFocus />
          </Alan>
          </div>
        </Modal>
      )}
    </>
  );
}

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
        <td className="muted">{tarihSaat(f.created_at)}<div className="small">{f.user}</div></td>
        <td><span className="mono">{f.sevk_no || f.sevk_ind}</span><div className="muted small">{f.fromAd} → {f.toAd}</div></td>
        <td><div className="name">{f.ad}</div><div className="code">{f.kod}</div></td>
        <td className="num">{miktar(f.sent)}</td>
        <td className="num">{miktar(f.received)}</td>
        <td className="num"><b className="neg">−{miktar(f.eksik)}</b> <span className="muted small">eksik</span></td>
        <td>
          <Rozet tur={dtur}>{dad}</Rozet>
          {f.cozum && <div className="muted small" style={{ marginTop: 4 }}>{f.cozum}</div>}
        </td>
        <td style={{ textAlign: 'right' }}>
          {f.durum === 'ACIK' ? <><Btn size="sm" onClick={() => setAcik((x) => !x)}>Çöz</Btn> <Reddet tur="fark" f={f} yukle={yukle} /></> : <Btn size="sm" busy={mesgul} onClick={() => gonder('ac')}>Yeniden aç</Btn>}
        </td>
      </tr>
      {acik && (
        <tr>
          <td colSpan={8} style={{ background: 'var(--ground)' }}>
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

const FAZLA_DURUM = {
  BEKLIYOR: ['Onay bekliyor', 'b-warn'],
  ONAYLANDI: ['Alıcıya eklendi', 'b-ok'],
  REDDEDILDI: ['Reddedildi', 'b-mute'],
};

/** Belgeden fazla gelen mal: yönetici onaylarsa alıcı depoda rafa kaldırılacak belge olarak eklenir. */
function FazlaSatiri({ f, yukle }) {
  const { toast } = useApp();
  const [mesgul, setMesgul] = useState(false);
  const karar = async (yol) => {
    setMesgul(true);
    try {
      await api(`/transfer/fazla/${f.id}/${yol}`, { method: 'POST', body: {} });
      toast(yol === 'onayla' ? `${f.toAd} deposuna eklendi; Rafa Kaldır'da (fazla) belgesi olarak görünür` : 'Fazla reddedildi');
      yukle();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  const [dad, dtur] = FAZLA_DURUM[f.durum] || [f.durum, 'b-mute'];
  return (
    <tr>
      <td className="muted">{tarihSaat(f.created_at)}<div className="small">{f.user}</div></td>
      <td><span className="mono">{f.sevk_no || f.sevk_ind}</span><div className="muted small">{f.fromAd} → {f.toAd}</div></td>
      <td><div className="name">{f.ad}</div><div className="code">{f.kod}</div></td>
      <td className="num">{miktar(f.sent)}</td>
      <td className="num">{miktar(f.sent + f.qty)}</td>
      <td className="num"><b className="pos">+{miktar(f.qty)}</b> <span className="muted small">fazla</span></td>
      <td><Rozet tur={dtur}>{dad}</Rozet>{f.karar_user && <div className="muted small" style={{ marginTop: 4 }}>{f.karar_user} · {tarihSaat(f.karar_at)}</div>}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {f.durum === 'BEKLIYOR' && <><Btn size="sm" kind="primary" icon="check" busy={mesgul} onClick={() => karar('onayla')}>Alıcıya ekle</Btn> <Reddet tur="fazla" f={f} yukle={yukle} /></>}
      </td>
    </tr>
  );
}

function IslemSatiri({ t, yukle }) {
  const { toast } = useApp();
  const [ac, setAc] = useState(false);
  const [mesgul, setMesgul] = useState(false);
  const [geriAl, setGeriAl] = useState(false);
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
          {t.geri_at && <div className="muted small" style={{ marginTop: 4 }}>{tarihSaat(t.geri_at)} · {t.geri_user}{t.geri_not ? ` · ${t.geri_not}` : ''}</div>}
        </td>
        <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
          {(t.durum === 'HATA' || t.durum === 'BEKLIYOR') && <Btn size="sm" busy={mesgul} icon="refresh" onClick={yeniden}>Yeniden dene</Btn>}
          {t.durum !== 'GERI' && <Btn size="sm" kind="danger" icon="undo" onClick={() => setGeriAl(true)}>Geri al</Btn>}
          {geriAl && (
            <GeriAl
              y={{ tur: gonder ? 'TRANSFER_GONDERIM' : 'TRANSFER_KABUL', durum: t.durum, id: t.id, tanim: gonder ? 'Depo gönderim fişi (128)' : 'Gönderim kabul fişi (129)', belgeNo: t.belge_no || t.sevk_no, depo: `${t.fromAd} → ${t.toAd}`, kalem: t.satirlar.length, adet: t.toplam }}
              kapat={() => setGeriAl(false)}
              tamam={() => { setGeriAl(false); yukle(); }}
            />
          )}
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

/** Kabul bekleyen ürünü kapatır (mal gelmedi ya da Vega'da başka yoldan kabul edildi): gönderimlere "kayıp" eksik olarak yazılır. */
function UrunKapat({ u, yukle }) {
  const { toast } = useApp();
  const [sor, onayPenceresi] = useOnay();
  const kapat = async () => {
    if (!(await sor('Ürün kapatılsın mı?', `${u.kod} · ${miktar(u.open)} ${u.birim || 'adet'} terminallerde kabul listesinden kalkar. Gelmeyen mal "kayıp" eksik olarak kaydedilir (Eksik / fazla sekmesinde görünür, oradan "Bulundu" yapılabilir). Vega'daki belgeler değişmez. Mal gelmediyse ya da Vega'da başka yoldan kabul edildiyse kullanın.`, { tamam: 'Kapat' }))) return;
    try {
      await api('/transfer/urun-kapat', { method: 'POST', body: { kaynak: u.kaynak, hedef: u.hedef, productId: u.productId } });
      toast('Ürün kapatıldı');
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
  const bekleyenFazla = veri?.fazlalar.filter((f) => f.durum === 'BEKLIYOR').length || 0;
  // Eksik ve fazla tek listede: karar bekleyenler üstte, sonra yeniden eskiye.
  const bekliyor = (f) => (f.tur === 'fazla' ? f.durum === 'BEKLIYOR' : f.durum === 'ACIK');
  const farklar = veri ? [...veri.farklar.map((f) => ({ ...f, tur: 'eksik' })), ...veri.fazlalar.map((f) => ({ ...f, tur: 'fazla' }))].sort((a, b) => bekliyor(b) - bekliyor(a) || b.created_at - a.created_at) : [];
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
                  secenekler={[['fark', `Eksik / fazla${acikFark + bekleyenFazla ? ` (${acikFark + bekleyenFazla})` : ''}`], ['islem', 'Gönderim ve kabuller'], ['urun', `Kabul bekleyen ürünler (${veri.acikUrunler.length})`], ['acik', `Yoldaki gönderimler (${veri.acik.length})`]]}
                />
                <div className="grow" />
                {veri.yoldaAd && <span className="muted">Yoldaki depo: {veri.yoldaAd}</span>}
              </div>
              {sekme === 'fark' && (
                <>
                  <div className="muted small" style={{ padding: '0 16px 10px' }}>
                    Kabulde fiziken gelenle belgedeki fark. Eksik: çözülene kadar kayıtlı kalır. Fazla: siz onaylayınca alıcı depoya eklenir. İkisi de Vega'ya yazılmaz.
                  </div>
                  {farklar.length === 0 ? (
                    <div className="empty">Eksik ya da fazla kayıt yok.</div>
                  ) : (
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead><tr><th>Kabul</th><th>Gönderim</th><th>Ürün</th><th className="num">Gönderilen</th><th className="num">Alınan</th><th className="num">Fark</th><th>Durum</th><th /></tr></thead>
                        <tbody>{farklar.map((f) => (f.tur === 'fazla' ? <FazlaSatiri key={`z${f.id}`} f={f} yukle={yukle} /> : <FarkSatiri key={`k${f.id}`} f={f} yukle={yukle} />))}</tbody>
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
              {sekme === 'urun' && (
                <>
                  <div className="muted small" style={{ padding: '0 16px 10px' }}>
                    Terminalde Gönderim Kabul ekranının listesi: gönderim belgesine bakılmaz, ürün başına gönderilen − alınan. Mal gelmediyse "Kapat" ile listeden kaldırın.
                  </div>
                  {veri.acikUrunler.length === 0 ? (
                    <div className="empty">Kabul bekleyen ürün yok.</div>
                  ) : (
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead><tr><th>Ürün</th><th>Depo</th><th className="num">Gönderilen</th><th className="num">Alınan</th><th className="num">Bekleyen</th><th>İlk gönderim</th><th /></tr></thead>
                        <tbody>
                          {veri.acikUrunler.map((u) => (
                            <tr key={`${u.kaynak}|${u.hedef}|${u.productId}`}>
                              <td><div className="name">{u.ad}</div><div className="code">{u.kod}</div></td>
                              <td>{u.fromAd} <span className="muted">→</span> {u.toAd}</td>
                              <td className="num">{miktar(u.sent)}</td>
                              <td className="num">{miktar(u.alinan)}</td>
                              <td className="num"><b>{miktar(u.open)}</b> <span className="muted small">{u.birim}</span></td>
                              <td className="muted">{u.enEski ? new Date(u.enEski).toLocaleDateString('tr-TR') : '—'}{u.belgeSayisi > 1 ? ` · ${u.belgeSayisi} gönderim` : ''}</td>
                              <td style={{ textAlign: 'right' }}><UrunKapat u={u} yukle={yukle} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
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
