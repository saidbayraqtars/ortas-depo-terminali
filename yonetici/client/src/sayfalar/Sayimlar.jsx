import React, { useMemo, useState } from 'react';
import { Alan, api, Btn, Durum, Icon, indir, miktar, Modal, Rozet, SAYIM_DURUM, SayfaBaslik, Secim, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

function YeniSayim({ kapat, tamam }) {
  const { toast } = useApp();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('RAF');
  const [blind, setBlind] = useState(true);
  const [note, setNote] = useState('');
  const ac = async () => {
    try {
      const r = await api('/sayimlar', { method: 'POST', body: { title: title || (kind === 'GENEL' ? 'Genel sayım' : 'Raf sayımı'), kind, blind, note } });
      toast(`${r.no} açıldı; terminallerde bir dakika içinde görünür`);
      tamam(r.id);
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <Modal baslik="Yeni sayım" kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" onClick={ac}>Sayımı aç</Btn></>}>
      <Alan etiket="Başlık" ipucu="Terminalde görünür: Koridor A, Yıl sonu sayımı…"><input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Alan>
      <Alan etiket="Sayım türü">
        <Secim deger={kind} degis={setKind} secenekler={[['RAF', 'Raf sayımı'], ['GENEL', 'Genel sayım (Vega\'ya yazılır)']]} />
      </Alan>
      <div className={`notice ${kind === 'GENEL' ? 'warn' : 'info'}`}>
        <Icon name="info" />
        <p>
          {kind === 'GENEL'
            ? 'Onaylarken sayılan ürünlerin Vega stoku, raflardaki toplam + rafa kaldırılmayı bekleyen miktara çekilir (sayım giriş/çıkış fişi). Depo baştan sona sayılmalı.'
            : 'Yalnız raf miktarları düzelir; Vega stoku değişmez. İlk yerleşim ve bölüm sayımları için.'}
        </p>
      </div>
      <label className="check"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /><span><b>Kör sayım</b><br /><span className="muted small">Sayan kişi sistemdeki miktarı görmez.</span></span></label>
      <Alan etiket="Not"><input className="inp" value={note} onChange={(e) => setNote(e.target.value)} /></Alan>
    </Modal>
  );
}

export default function Sayimlar() {
  const { veri, hata, yukleniyor, yukle } = useVeri('/sayimlar');
  const [yeni, setYeni] = useState(false);
  const [filtre, setFiltre] = useState('aktif');
  const liste = (veri || []).filter((s) => filtre === 'tumu' || (filtre === 'aktif' ? ['OPEN', 'CLOSED'].includes(s.status) : ['APPROVED', 'CANCELLED'].includes(s.status)));
  return (
    <>
      <SayfaBaslik baslik="Sayımlar" alt="Açılan sayım terminallerde görünür; terminalden gönderilen sayım burada onaylanır">
        <Btn kind="primary" icon="plus" onClick={() => setYeni(true)}>Yeni sayım</Btn>
      </SayfaBaslik>
      <div className="card">
        <div className="toolbar">
          <Secim deger={filtre} degis={setFiltre} secenekler={[['aktif', 'Süren ve onay bekleyen'], ['bitti', 'Bitenler'], ['tumu', 'Tümü']]} />
        </div>
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={liste.length === 0 && 'Bu listede sayım yok.'}>
          <table className="tbl">
            <thead><tr><th>No</th><th>Başlık</th><th>Tür</th><th>Durum</th><th className="num">Raf</th><th className="num">Kalem</th><th className="num">Farklı</th><th>Açılış</th><th>Vega fişi</th></tr></thead>
            <tbody>
              {liste.map((s) => (
                <tr key={s.id} className="click" onClick={() => (window.location.hash = `/sayim/${s.id}`)}>
                  <td className="mono">{s.no}</td>
                  <td><b>{s.title}</b>{s.source === 'TERMINAL' && <div className="muted small">Terminalde başlatıldı · {s.note}</div>}</td>
                  <td>{s.kind === 'GENEL' ? <Rozet tur="b-acc">Genel</Rozet> : <Rozet tur="b-mute">Raf</Rozet>}{s.blind ? <span className="muted small"> · kör</span> : ''}</td>
                  <td><Rozet tur={SAYIM_DURUM[s.status][1]}>{SAYIM_DURUM[s.status][0]}</Rozet></td>
                  <td className="num">{s.raf || ''}</td>
                  <td className="num">{s.kalem || ''}</td>
                  <td className="num">{s.rafFarkli || ''}</td>
                  <td className="muted">{tarihSaat(s.created_at)}</td>
                  <td className="mono small">{s.vega_docs ? s.vega_docs.map((d) => d.belgeNo).join(', ') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Durum>
      </div>
      {yeni && <YeniSayim kapat={() => setYeni(false)} tamam={(id) => { setYeni(false); yukle(); window.location.hash = `/sayim/${id}`; }} />}
    </>
  );
}

function OnayPenceresi({ ozet, dahil, kapat, tamam }) {
  const { toast, durum } = useApp();
  const genel = ozet.oturum.kind === 'GENEL';
  const [vegaYaz, setVegaYaz] = useState(genel);
  const farkli = ozet.urunler.filter((u) => u.vegadaVar && Math.abs(u.fark) > 1e-9);
  const [secili, setSecili] = useState(() => new Set(farkli.map((u) => u.productId)));
  const [mesgul, setMesgul] = useState(false);
  const giris = farkli.filter((u) => secili.has(u.productId) && u.fark > 0).length;
  const cikis = farkli.filter((u) => secili.has(u.productId) && u.fark < 0).length;
  const onayla = async () => {
    setMesgul(true);
    try {
      const r = await api(`/sayim/${ozet.oturum.id}/onayla`, { method: 'POST', body: { vegaYaz, stoknolar: [...secili], dahilSayilmayan: dahil } });
      const docs = r.sonuc?.docs || [];
      toast(vegaYaz ? (docs.length ? `Vega'ya yazıldı: ${docs.map((d) => d.belgeNo).join(', ')}` : 'Vega ile fark kalmadı; fiş kesilmedi') : 'Sayım onaylandı');
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Modal genis baslik={`${ozet.oturum.no} onayla`} kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" icon="check" busy={mesgul} onClick={onayla} disabled={vegaYaz && !durum?.vega.ok}>{vegaYaz ? 'Onayla ve Vega\'ya yaz' : 'Onayla'}</Btn></>}>
      <p style={{ margin: 0 }}>Raf miktarları sayım gönderilirken zaten güncellendi. Onay sayımı kapatır{vegaYaz ? ' ve Vega stokunu düzeltir' : ''}.</p>
      <label className="check">
        <input type="checkbox" checked={vegaYaz} onChange={(e) => setVegaYaz(e.target.checked)} />
        <span><b>Vega'ya sayım fişi yaz</b><br /><span className="muted small">Fark, fiş kesilirken Vega'daki o anki stoka göre yeniden hesaplanır. Artı fark sayım giriş (93), eksi fark sayım çıkış (94) fişine gider.</span></span>
      </label>
      {vegaYaz && !durum?.vega.ok && <div className="notice err"><Icon name="wifiOff" /><p>Vega'ya şu an ulaşılamıyor.</p></div>}
      {vegaYaz && !genel && <div className="notice warn"><Icon name="warning" /><p>Bu bir raf sayımı. Ürünün sayılmayan yerlerde (rafsız, başka bölümde) malı varsa Vega stoku eksik düşer. Emin değilseniz yalnız gerçekten tamamı sayılan ürünleri seçin.</p></div>}
      {vegaYaz && (
        <>
          <div className="row">
            <b>{secili.size} ürün seçili</b>
            <span className="muted">· {giris} giriş · {cikis} çıkış</span>
            <div style={{ flex: 1 }} />
            <Btn size="sm" onClick={() => setSecili(new Set(farkli.map((u) => u.productId)))}>Hepsi</Btn>
            <Btn size="sm" onClick={() => setSecili(new Set())}>Hiçbiri</Btn>
          </div>
          <div className="tbl-scroll" style={{ maxHeight: 320, border: '1px solid var(--line)', borderRadius: 8 }}>
            <table className="tbl">
              <thead><tr><th /><th>Ürün</th><th className="num">Olması gereken</th><th className="num">Vega</th><th className="num">Fark</th></tr></thead>
              <tbody>
                {farkli.map((u) => (
                  <tr key={u.productId}>
                    <td style={{ width: 34 }}><input type="checkbox" checked={secili.has(u.productId)} onChange={() => setSecili((s) => { const n = new Set(s); n.has(u.productId) ? n.delete(u.productId) : n.add(u.productId); return n; })} /></td>
                    <td><div className="name">{u.name}</div><div className="code">{u.code}</div></td>
                    <td className="num">{miktar(u.hedef)}</td>
                    <td className="num">{miktar(u.vegaStock)}</td>
                    <td className={`num ${u.fark > 0 ? 'pos' : 'neg'}`}>{miktar(u.fark, true)}</td>
                  </tr>
                ))}
                {farkli.length === 0 && <tr><td colSpan={5} className="empty">Vega ile fark yok.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

export function SayimDetay({ id }) {
  const { toast } = useApp();
  const [dahil, setDahil] = useState(false);
  const [gorunum, setGorunum] = useState('urun');
  const { veri: o, hata, yukleniyor, yukle } = useVeri(`/sayim/${id}${dahil ? '?dahil=1' : ''}`, [dahil]);
  const [onay, setOnay] = useState(false);
  const [sor, onayPenceresi] = useOnay();
  const [sadeceFark, setSadeceFark] = useState(false);

  const durumDegis = async (ne, soru) => {
    if (soru && !(await sor(...soru))) return;
    try {
      await api(`/sayim/${id}/${ne}`, { method: 'POST', body: {} });
      toast('Kaydedildi');
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };

  const urunler = useMemo(() => (o ? o.urunler.filter((u) => !sadeceFark || Math.abs(u.fark) > 1e-9) : []), [o, sadeceFark]);
  const satirlar = useMemo(() => (o ? o.satirlar.filter((l) => !sadeceFark || Math.abs(l.fark) > 1e-9) : []), [o, sadeceFark]);

  return (
    <Durum yukleniyor={yukleniyor && !o} hata={hata}>
      {o && (() => {
        const s = o.oturum;
        const docs = s.vega_docs?.docs || [];
        return (
          <>
            <SayfaBaslik baslik={<><span className="mono">{s.no}</span> · {s.title}</>} alt={<>{s.kind === 'GENEL' ? 'Genel sayım' : 'Raf sayımı'}{s.blind ? ' · kör' : ''} · açılış {tarihSaat(s.created_at)}{s.note ? ` · ${s.note}` : ''}</>} geri={['/sayimlar', 'Sayımlar']}>
              <Rozet tur={SAYIM_DURUM[s.status][1]}>{SAYIM_DURUM[s.status][0]}</Rozet>
              <Btn icon="export" onClick={() => indir(`/sayim/${id}/csv?tur=${gorunum === 'raf' ? 'raf' : 'urun'}${dahil ? '&dahil=1' : ''}`, `${s.no}.csv`).catch((e) => toast(e.message, true))}>CSV</Btn>
              {s.status === 'OPEN' && <Btn icon="lock" onClick={() => durumDegis('kapat', ['Sayım kapatılsın mı?', 'Terminallerde görünmez olur; onay için hazır hale gelir. Gerekirse yeniden açılabilir.', { tamam: 'Kapat' }])}>Sayımı kapat</Btn>}
              {s.status === 'CLOSED' && <Btn icon="refresh" onClick={() => durumDegis('ac')}>Yeniden aç</Btn>}
              {['OPEN', 'CLOSED'].includes(s.status) && <Btn kind="danger" icon="x" onClick={() => durumDegis('iptal', ['Sayım iptal edilsin mi?', 'Raf miktarları sayım gönderilirken güncellendi; iptal bunları geri almaz, yalnız sayımı kapatır ve Vega\'ya yazılmasını engeller.', { tamam: 'İptal et', tehlike: true }])}>İptal</Btn>}
              {['OPEN', 'CLOSED'].includes(s.status) && <Btn kind="primary" icon="check" disabled={!o.satirlar.length} onClick={() => setOnay(true)}>Onayla</Btn>}
              {s.status === 'APPROVED' && <Btn icon="undo" onClick={() => durumDegis('geri-al', ['Onay geri alınsın mı?', docs.length ? `Vega'daki ${docs.map((d) => d.belgeNo).join(', ')} fişleri silinir ve sayım "onay bekliyor"a döner.` : 'Sayım "onay bekliyor" durumuna döner.', { tamam: 'Geri al', tehlike: docs.length > 0 }])}>Onayı geri al</Btn>}
            </SayfaBaslik>

            {s.status === 'OPEN' && <div className="notice info" style={{ marginBottom: 14 }}><Icon name="info" /><p>Sayım sürüyor. Terminaller raf raf sayıp gönderdikçe aşağıdaki liste dolar. Aynı raf tekrar sayılırsa son gönderim geçerlidir.</p></div>}
            {docs.length > 0 && (
              <div className="notice ok" style={{ marginBottom: 14 }}>
                <Icon name="check" />
                <p>Vega'ya yazıldı ({tarihSaat(s.vega_written_at)}): {docs.map((d) => `${d.belgeNo} (${d.giris ? 'giriş' : 'çıkış'}, ${d.kalem} kalem)`).join(' · ')}</p>
              </div>
            )}

            <div className="grid g4" style={{ marginBottom: 14 }}>
              <div className="card stat"><span className="k">Sayılan raf</span><span className="v">{o.raflar.length}</span></div>
              <div className="card stat"><span className="k">Raf kalemi</span><span className="v">{o.toplam.kalem}</span><span className="s">{o.toplam.rafFarkli} kalemde rafta fark</span></div>
              <div className="card stat"><span className="k">Ürün</span><span className="v">{o.toplam.urun}</span></div>
              <div className={`card stat ${o.toplam.vegaFarkli ? 'warn' : ''}`}><span className="k">Vega ile farklı</span><span className="v">{o.toplam.vegaFarkli}</span></div>
            </div>

            <div className="card">
              <div className="toolbar">
                <Secim deger={gorunum} degis={setGorunum} secenekler={[['urun', 'Ürün bazında (Vega)'], ['raf', 'Raf bazında']]} />
                <label className="check"><input type="checkbox" checked={sadeceFark} onChange={(e) => setSadeceFark(e.target.checked)} /><span>Yalnız farklılar</span></label>
                {gorunum === 'urun' && s.status !== 'APPROVED' && (
                  <label className="check" title="Genel sayımda: hiç okutulmayan ama Vega'da stoğu olan ürünler de listeye girer (olması gereken = raflardaki + bekleyen)">
                    <input type="checkbox" checked={dahil} onChange={(e) => setDahil(e.target.checked)} /><span>Sayılmayan stoklu ürünleri ekle</span>
                  </label>
                )}
              </div>
              {gorunum === 'urun' ? (
                urunler.length === 0 ? <div className="empty">Henüz sayım gelmedi.</div> : (
                  <div className="tbl-wrap tbl-scroll" style={{ maxHeight: 'calc(100vh - 330px)' }}>
                    <table className="tbl">
                      <thead><tr><th>Ürün</th><th>Sayılan raflar</th><th className="num">Sayılan</th><th className="num">Diğer raflar</th><th className="num">Rafa kaldırılacak</th><th className="num">Olması gereken</th><th className="num">Vega</th><th className="num">Fark</th></tr></thead>
                      <tbody>
                        {urunler.map((u) => (
                          <tr key={u.productId} className="click" onClick={() => (window.location.hash = `/urun/${u.productId}`)}>
                            <td><div className="name">{u.name}</div><div className="code">{u.code}</div></td>
                            <td className="mono small">{u.sayilmadi ? <Rozet tur="b-mute">sayılmadı</Rozet> : u.raflar.join(', ')}</td>
                            <td className="num">{miktar(u.sayilan)}</td>
                            <td className="num">{u.digerRaflar ? miktar(u.digerRaflar) : ''}</td>
                            <td className="num">{u.bekleyen ? miktar(u.bekleyen) : ''}</td>
                            <td className="num">{miktar(u.hedef)}</td>
                            <td className="num">{miktar(u.vegaStock)}</td>
                            <td className={`num ${u.fark > 0 ? 'pos' : u.fark < 0 ? 'neg' : 'muted'}`}>{miktar(u.fark, true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : satirlar.length === 0 ? <div className="empty">Henüz sayım gelmedi.</div> : (
                <div className="tbl-wrap tbl-scroll" style={{ maxHeight: 'calc(100vh - 330px)' }}>
                  <table className="tbl">
                    <thead><tr><th>Raf</th><th>Ürün</th><th className="num">Önceki</th><th className="num">Sayılan</th><th className="num">Fark</th><th>Sayan</th><th>Zaman</th></tr></thead>
                    <tbody>
                      {satirlar.map((l) => (
                        <tr key={l.shelf + l.product_id}>
                          <td className="mono"><a href={`#/raf/${encodeURIComponent(l.shelf)}`}>{l.shelf}</a></td>
                          <td><div className="name">{l.urunAd}</div><div className="code">{l.urunKod}</div></td>
                          <td className="num">{miktar(l.server_before)}</td>
                          <td className="num">{miktar(l.counted)}</td>
                          <td className={`num ${l.fark > 0 ? 'pos' : l.fark < 0 ? 'neg' : 'muted'}`}>{miktar(l.fark, true)}</td>
                          <td className="muted">{l.user} · {l.device}</td>
                          <td className="muted">{tarihSaat(l.submitted_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {onay && <OnayPenceresi ozet={o} dahil={dahil} kapat={() => setOnay(false)} tamam={() => { setOnay(false); yukle(); }} />}
            {onayPenceresi}
          </>
        );
      })()}
    </Durum>
  );
}
