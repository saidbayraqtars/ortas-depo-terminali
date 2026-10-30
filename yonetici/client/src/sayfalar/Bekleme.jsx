import React, { useState } from 'react';
import { Alan, api, Btn, Durum, Icon, miktar, Rozet, SayfaBaslik, Secim, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';
import { RafaGeriAl } from './Hareketler.jsx';

const UZUN_GUN = 7;

function Satir({ etiket, children }) {
  return <tr><td className="muted">{etiket}</td><td className="num">{children}</td></tr>;
}

/** Açınca ne olacağı; sunucu önizlemesi (hiçbir kayda dokunmaz). */
function Onizleme({ o }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <tbody>
          <Satir etiket={`Malın durduğu depoya (${o.hedefAd}) taşınacak raf kaydı`}>{miktar(o.raf.satir)} satır · {miktar(o.raf.urun)} ürün · {miktar(o.raf.adet)} adet</Satir>
          <Satir etiket="Taşınacak raf tanımı · raf adresi">{miktar(o.rafTanimi)} · {miktar(o.zimmet)}</Satir>
          <Satir etiket={`${o.hedefAd}'de görünecek bekleme faturası`}>{miktar(o.belgeTasinan.belge)} belge · {miktar(o.belgeTasinan.kalem)} kalem</Satir>
          <Satir etiket="İş olmaktan çıkacak grup içi transfer">{miktar(o.belgeGizlenen.belge)} belge · {miktar(o.belgeGizlenen.kalem)} kalem</Satir>
          <Satir etiket="Transferden rafa kalkıp açık faturadan düşülecek">{miktar(o.mahsup.urun)} ürün · {miktar(o.mahsup.adet)} adet</Satir>
          <Satir etiket="Çift rafa kaldırılmış olabilecek">{o.cift.urun ? <Rozet tur="b-warn">{miktar(o.cift.urun)} ürün · en çok {miktar(o.cift.adet)} adet</Rozet> : 'Yok'}</Satir>
          {o.kullanici.length > 0 && <Satir etiket="Yetkisi hedef depoya çevrilecek kullanıcı">{o.kullanici.join(', ')}</Satir>}
        </tbody>
      </table>
    </div>
  );
}

function Kurulum({ v, tamam }) {
  const { toast, yenile } = useApp();
  const [secili, setSecili] = useState(() => new Set(v.depolar.map(Number)));
  const [hedef, setHedef] = useState(v.hedef ? String(v.hedef) : '');
  const [o, setO] = useState(null);
  const [mesgul, setMesgul] = useState('');
  const [sor, onayPenceresi] = useOnay();
  const govde = () => ({ depolar: [...secili], hedef: Number(hedef) });
  const degisti = (f) => (...a) => { setO(null); f(...a); };
  const onizle = async () => {
    setMesgul('onizle');
    try {
      setO(await api('/bekleme/onizle', { method: 'POST', body: govde() }));
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };
  const ac = async () => {
    const metin = `${o.depoAdlari.join(', ')} depolarının belgeleri ve raf kayıtları ${o.hedefAd} deposunda çalışacak. Önce program verisinin yedeği alınır.\n\nVega'ya hiçbir şey yazılmaz.`;
    if (!(await sor('Bekleme depoları açılsın mı?', metin, { tamam: 'Aç', tehlike: true }))) return;
    setMesgul('ac');
    try {
      await api('/bekleme/ac', { method: 'POST', body: govde() });
      toast('Bekleme depoları açıldı');
      yenile();
      tamam();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };
  return (
    <div className="card">
      {onayPenceresi}
      <div className="card-head"><Icon name="layers" /><h2>Sanal bekleme depoları</h2></div>
      <div className="card-pad stack">
        <p className="muted" style={{ margin: 0 }}>
          Fiyatlandırma bitmeden stoğa geçmesin diye Vega'da açılmış ama fiziken ayrı bir yeri olmayan depolar. Mal zaten aşağıda seçilen depoda durur.
          Açılınca çalışan belgeyi orada görür, raf kaydı oraya yazılır ve muhasebenin kestiği 37 fişi ikinci kez iş çıkarmaz.
        </p>
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Bekleme depoları (Ortaş: TRANSFER SPCT 106, TRANSFER PCC 109)</div>
          <div className="stack" style={{ gap: 8 }}>
            {v.secenekler.map((d) => (
              <label key={d.ind} className="check">
                <input
                  type="checkbox"
                  checked={secili.has(d.ind)}
                  onChange={degisti(() => setSecili((s) => {
                    const n = new Set(s);
                    n.has(d.ind) ? n.delete(d.ind) : n.add(d.ind);
                    return n;
                  }))}
                />
                <span>{d.ad} <span className="muted small">({d.ind})</span></span>
              </label>
            ))}
          </div>
        </div>
        <Alan etiket="Malın fiziken durduğu depo" ipucu="Ortaş: MERKEZ">
          <select className="inp" style={{ width: 280 }} value={hedef} onChange={degisti((e) => setHedef(e.target.value))}>
            <option value="">Seçin</option>
            {v.secenekler.filter((d) => !secili.has(d.ind)).map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
          </select>
        </Alan>
        {o && o.engeller.length > 0 && <div className="notice err"><Icon name="alert" /><p>{o.engeller.join(' · ')}</p></div>}
        {o && !o.engeller.length && (
          <>
            <Onizleme o={o} />
            {o.cift.urun > 0 && <div className="notice warn"><Icon name="warning" /><p>Çift şüpheli ürünler kendiliğinden düzeltilmez; açtıktan sonra bu sayfadaki listeden tek tek geri alınır.</p></div>}
          </>
        )}
      </div>
      <div className="modal-foot" style={{ justifyContent: 'flex-start' }}>
        <Btn kind={o && !o.engeller.length ? '' : 'primary'} busy={mesgul === 'onizle'} onClick={onizle}>Önizle</Btn>
        {o && !o.engeller.length && <Btn kind="primary" busy={mesgul === 'ac'} onClick={ac}>Bekleme depolarını aç</Btn>}
      </div>
    </div>
  );
}

function Bekleyenler({ liste }) {
  const [uzun, setUzun] = useState(false);
  const gorunen = uzun ? liste.filter((x) => (x.gun ?? 0) >= UZUN_GUN) : liste;
  return (
    <>
      <div className="toolbar">
        <label className="check"><input type="checkbox" checked={uzun} onChange={(e) => setUzun(e.target.checked)} /><span>Yalnız {UZUN_GUN} günü geçenler</span></label>
        <div className="grow" />
        <span className="muted">{miktar(gorunen.length)} satır</span>
      </div>
      <Durum bos={gorunen.length === 0 && 'Fiyatlandırma bekleyen mal yok.'}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Ürün</th><th>Vega deposu</th><th className="num">Bekleyen</th><th className="num">Rafta</th><th className="num">Gün</th></tr></thead>
            <tbody>
              {gorunen.map((x) => (
                <tr key={`${x.depo}-${x.productId}`} className="click" onClick={() => (window.location.hash = `/urun/${x.productId}`)}>
                  <td><div className="name">{x.urunAd}</div><div className="code">{x.urunKod}</div></td>
                  <td className="muted">{x.depoAd}</td>
                  <td className="num">{miktar(x.vega)}</td>
                  <td className="num">{miktar(x.rafta)}</td>
                  <td className="num">{x.gun === null ? '—' : x.gun >= UZUN_GUN ? <Rozet tur="b-warn">{x.gun}</Rozet> : x.gun}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Durum>
    </>
  );
}

function Hazirlar({ liste, toplam }) {
  return (
    <Durum bos={liste.length === 0 && 'Muhasebenin geçirip rafa kalkmamış malı yok.'}>
      {toplam > liste.length && <div className="notice info" style={{ margin: 12 }}><Icon name="info" /><p>{miktar(toplam)} üründen en çok bekleyen {miktar(liste.length)} tanesi gösteriliyor.</p></div>}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Ürün</th><th className="num">Rafa kaldırılacak</th><th className="num">Rafta</th><th>Belge</th></tr></thead>
          <tbody>
            {liste.map((x) => (
              <tr key={x.productId} className="click" onClick={() => (window.location.hash = `/urun/${x.productId}`)}>
                <td><div className="name">{x.urunAd}</div><div className="code">{x.urunKod}</div></td>
                <td className="num">{miktar(x.miktar)}</td>
                <td className="num">{miktar(x.rafta)}</td>
                <td className="mono small">{x.belgeler.join(', ')}{x.belgeSayisi > x.belgeler.length ? ` +${x.belgeSayisi - x.belgeler.length}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Durum>
  );
}

function Ciftler({ liste, yukle }) {
  const [geriAl, setGeriAl] = useState(null);
  return (
    <Durum bos={liste.length === 0 && 'Çift rafa kaldırılmış görünen ürün yok.'}>
      <div className="notice warn" style={{ margin: 12 }}>
        <Icon name="warning" />
        <p>Bu ürünler eski düzende hem bekleme faturasından hem Merkez'e gelen transferden rafa kalkmış. Raftaki malı kontrol edin; fazla kayıt varsa transfer hareketini geri alın. Fatura ilerlemesi değişmez.</p>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Ürün</th><th className="num">Fatura</th><th className="num">Faturadan</th><th className="num">Transferden</th><th className="num">Olası fazla</th><th>Transfer hareketleri</th></tr></thead>
          <tbody>
            {liste.map((x) => (
              <tr key={x.productId}>
                <td><div className="name">{x.urunAd}</div><div className="code">{x.urunKod}</div></td>
                <td className="num">{miktar(x.fatura)}</td>
                <td className="num">{miktar(x.faturadan)}</td>
                <td className="num">{miktar(x.transferden)}</td>
                <td className="num"><Rozet tur="b-warn">{miktar(x.fazla)}</Rozet></td>
                <td>
                  <div className="stack" style={{ gap: 6 }}>
                    {x.hareketler.map((h) => (
                      <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="mono small">{h.shelf} · {miktar(h.delta)}</span>
                        <span className="muted small">{tarihSaat(h.ts)} · {h.user || '—'}</span>
                        <Btn size="sm" icon="undo" onClick={() => setGeriAl({ ...h, ref: null, urunAd: x.urunAd, urunKod: x.urunKod })}>Geri al</Btn>
                      </div>
                    ))}
                    {!x.hareketler.length && <span className="muted small">Hareket bulunamadı; Raflar sayfasından düzeltin</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {geriAl && <RafaGeriAl h={geriAl} kapat={() => setGeriAl(null)} tamam={() => { setGeriAl(null); yukle(); }} />}
    </Durum>
  );
}

function Rapor({ v, yukle }) {
  const { toast, yenile } = useApp();
  const [sekme, setSekme] = useState('bekleyen');
  const [sor, onayPenceresi] = useOnay();
  const ad = (i) => v.secenekler.find((d) => d.ind === Number(i))?.ad || String(i);
  const kapat = async () => {
    const metin = 'Raf kayıtları hedef depoda kalır. Grup içi 37 fişleri yeniden rafa kaldırılacak belge olarak görünür ve bekleme belgeleri kendi deposuna döner; yani çift iş riski geri gelir.\n\nYalnız bir sorun çıkarsa kapatın.';
    if (!(await sor('Bekleme depoları kapatılsın mı?', metin, { tamam: 'Kapat', tehlike: true }))) return;
    try {
      await api('/bekleme/kapat', { method: 'POST', body: {} });
      toast('Bekleme depoları kapatıldı');
      yenile();
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const uzun = v.bekleyen.filter((x) => (x.gun ?? 0) >= UZUN_GUN).length;
  return (
    <>
      {onayPenceresi}
      <div className="notice info" style={{ marginBottom: 14, alignItems: 'center' }}>
        <Icon name="info" />
        <p style={{ flex: 1 }}>
          <b>{v.depolar.map(ad).join(', ')}</b> belgeleri <b>{ad(v.hedef)}</b> deposunda çalışıyor. Grup içi 37 fişi iş üretmez, stok grup toplamıyla karşılaştırılır.
          {v.gecis ? <span className="muted"> Açıldı: {tarihSaat(v.gecis.at)} · {v.gecis.kim}</span> : null}
        </p>
        <Btn onClick={kapat}>Kapat</Btn>
      </div>
      <div className="card">
        <div className="toolbar">
          <Secim
            deger={sekme}
            degis={setSekme}
            secenekler={[
              ['bekleyen', `Fiyat bekleyen (${miktar(v.bekleyen.length)}${uzun ? ` · ${miktar(uzun)} uzun` : ''})`],
              ['hazir', `Geçti, rafa kalkmadı (${miktar(v.hazirToplam || 0)})`],
              ['cift', `Çift şüphesi (${miktar(v.cift.length)})`],
            ]}
          />
        </div>
        {sekme === 'bekleyen' && <Bekleyenler liste={v.bekleyen} />}
        {sekme === 'hazir' && <Hazirlar liste={v.hazir} toplam={v.hazirToplam || 0} />}
        {sekme === 'cift' && <Ciftler liste={v.cift} yukle={yukle} />}
      </div>
    </>
  );
}

export default function Bekleme() {
  const { veri, hata, yukleniyor, yukle } = useVeri('/bekleme');
  return (
    <>
      <SayfaBaslik baslik="Bekleme depoları" alt="Fiyatlandırma bekleyen sanal depolar: rafa kaldırma beklemez, 37 fişi çift iş çıkarmaz" />
      <Durum yukleniyor={yukleniyor && !veri} hata={hata}>
        {veri && (veri.aktif ? <Rapor v={veri} yukle={yukle} /> : <Kurulum v={veri} tamam={yukle} />)}
      </Durum>
    </>
  );
}
