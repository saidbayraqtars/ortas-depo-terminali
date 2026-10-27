import React, { useEffect, useState } from 'react';
import { Alan, api, Btn, Icon, Rozet, SayfaBaslik, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

const TURLER = [
  ['20', 'Alış faturası (20)'],
  ['26', 'Alış irsaliyesi (26)'],
  ['32', 'Stok giriş fişi (32)'],
  ['D37', 'Depolar arası transfer — giren depoda'],
  ['D129', 'Depo gönderiminin kabulü — alan şubede'],
];

/** İşaretli bilinen türler + elle yazılan diğer IZAHAT numaraları. */
function kabulGovde(k) {
  const bilinen = k.izahat.filter((x) => TURLER.some(([t]) => t === x));
  const diger = k.ekTur === undefined ? k.izahat.filter((x) => !bilinen.includes(x)) : k.ekTur.split(/[^\d]+/).filter(Boolean);
  return { izahat: [...new Set([...bilinen, ...diger])], baslangic: k.baslangic };
}

function Bolum({ ikon, baslik, aciklama, children, alt }) {
  return (
    <div className="card">
      <div className="card-head"><Icon name={ikon} /><h2>{baslik}</h2></div>
      <div className="card-pad stack">
        {aciklama && <p className="muted" style={{ margin: 0 }}>{aciklama}</p>}
        {children}
      </div>
      {alt && <div className="modal-foot" style={{ justifyContent: 'flex-start' }}>{alt}</div>}
    </div>
  );
}

function VegaAyari({ a, kaydet }) {
  const { toast } = useApp();
  const [v, setV] = useState({ ...a.vega, password: '' });
  const [firmalar, setFirmalar] = useState(null);
  const [donemler, setDonemler] = useState([]);
  const [depolar, setDepolar] = useState([]);
  const [mesgul, setMesgul] = useState('');
  const d = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  const govde = () => ({ ...v, ...(v.password ? {} : { password: undefined }) });
  // Varsayılan depo yalnız kullanılan depolardan seçilir (hiçbiri seçili değilse hepsi).
  const kullanilan = (v.depolar || []).length ? depolar.filter((x) => v.depolar.map(Number).includes(x.ind)) : depolar;

  const yukleFirma = async (firma, sessiz) => {
    if (!firma) return;
    try {
      const [dn, dp] = await Promise.all([
        api('/vega/donemler', { method: 'POST', body: { ...govde(), firma } }),
        api('/vega/depolar', { method: 'POST', body: { ...govde(), firma } }),
      ]);
      setDonemler(dn);
      setDepolar(dp);
    } catch (e) {
      if (!sessiz) toast(e.message, true);
    }
  };

  useEffect(() => {
    if (a.vega.firma) {
      api('/vega/firmalar', { method: 'POST', body: {} }).then(setFirmalar).catch(() => {});
      yukleFirma(a.vega.firma, true);
    }
  }, []);

  const dene = async () => {
    setMesgul('dene');
    try {
      const r = await api('/vega/dene', { method: 'POST', body: govde() });
      setFirmalar(r.firmalar);
      toast(`Bağlantı tamam · ${r.firmalar.length} firma`);
      if (r.firmalar.length === 1 && !v.firma) {
        setV((x) => ({ ...x, firma: r.firmalar[0].ind }));
        yukleFirma(r.firmalar[0].ind);
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };

  const sec = (firma) => {
    setV((x) => ({ ...x, firma: Number(firma) || null, donem: null, depo: null }));
    setDonemler([]);
    setDepolar([]);
    yukleFirma(Number(firma));
  };

  const kaydetVega = async () => {
    setMesgul('kaydet');
    await kaydet({ vega: { ...govde(), firma: v.firma ? Number(v.firma) : null, donem: v.donem ? Number(v.donem) : null, depo: v.depo ? Number(v.depo) : null, depolar: (v.depolar || []).map(Number) } });
    setMesgul('');
  };

  return (
    <Bolum
      ikon="database"
      baslik="Vega bağlantısı"
      aciklama="Ürünler, stok ve mal kabul belgeleri buradan okunur. Onaylanan sayım fişleri buraya yazılır."
      alt={<><Btn icon="refresh" busy={mesgul === 'dene'} onClick={dene}>Bağlantıyı dene</Btn><Btn kind="primary" busy={mesgul === 'kaydet'} onClick={kaydetVega} disabled={!v.firma}>Kaydet</Btn></>}
    >
      <div className="grid g3">
        <Alan etiket="SQL Server" ipucu="Örnek: SUNUCU\SQLEXPRESS ya da 192.168.1.10"><input className="inp mono" value={v.server || ''} onChange={d('server')} /></Alan>
        <Alan etiket="Port" ipucu="Boş: 1433 ya da adlandırılmış örnek"><input className="inp mono" value={v.port || ''} onChange={d('port')} /></Alan>
        <Alan etiket="Veritabanı"><input className="inp mono" value={v.database || ''} onChange={d('database')} /></Alan>
        <Alan etiket="Kullanıcı"><input className="inp mono" value={v.user || ''} onChange={d('user')} /></Alan>
        <Alan etiket="Parola" ipucu={a.vega.hasPassword ? 'Kayıtlı; değiştirmek için yazın' : ''}><input className="inp" type="password" value={v.password} onChange={d('password')} placeholder={a.vega.hasPassword ? '••••••' : ''} /></Alan>
      </div>
      <div className="grid g3">
        <Alan etiket="Firma">
          <select className="inp" value={v.firma || ''} onChange={(e) => sec(e.target.value)}>
            <option value="">{firmalar ? 'Seçin' : 'Önce bağlantıyı deneyin'}</option>
            {(firmalar || (v.firma ? [{ ind: v.firma, ad: `F${String(v.firma).padStart(4, '0')}` }] : [])).map((f) => <option key={f.ind} value={f.ind}>F{String(f.ind).padStart(4, '0')} · {f.ad}</option>)}
          </select>
        </Alan>
        <Alan etiket="Dönem" ipucu="Otomatik: yıl değişince yeni dönemi kendisi seçer">
          <select className="inp" value={v.donem || ''} onChange={(e) => setV((x) => ({ ...x, donem: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">Otomatik (bu yıl)</option>
            {donemler.map((x) => <option key={x.ind} value={x.ind}>D{String(x.ind).padStart(4, '0')} · {x.yil}</option>)}
          </select>
        </Alan>
        <Alan etiket="Varsayılan depo" ipucu="Terminal ilk açılışta bu depoda başlar; terminalden değiştirilebilir">
          <select className="inp" value={v.depo || ''} onChange={(e) => setV((x) => ({ ...x, depo: Number(e.target.value) || null }))}>
            <option value="">İlk depo</option>
            {(depolar.length ? kullanilan : v.depo ? [{ ind: v.depo, ad: String(v.depo) }] : []).map((x) => <option key={x.ind} value={x.ind}>{x.ad} ({x.ind})</option>)}
          </select>
        </Alan>
      </div>
      {depolar.length > 1 && (
        <Alan etiket="Kullanılan depolar" ipucu="Hiçbiri seçilmezse firmanın bütün depoları. Mal kabul belgeleri, stok ve raflar yalnız seçili depolardan gelir.">
          <div className="chip-list" style={{ maxHeight: 140, overflow: 'auto', gap: 10 }}>
            {depolar.map((x) => {
              const secili = (v.depolar || []).map(Number).includes(x.ind);
              return (
                <label key={x.ind} className="check" style={{ minWidth: 180 }}>
                  <input type="checkbox" checked={secili} onChange={() => setV((y) => {
                    const yeni = secili ? (y.depolar || []).filter((d) => Number(d) !== x.ind) : [...(y.depolar || []), x.ind];
                    // Varsayılan depo kullanılanlardan çıkarsa sunucu sessizce ilk depoyu alırdı; seçimi boşalt.
                    const depo = !yeni.length || yeni.map(Number).includes(Number(y.depo)) ? y.depo : null;
                    return { ...y, depolar: yeni, depo };
                  })} />
                  <span>{x.ad} <span className="muted small">({x.ind})</span></span>
                </label>
              );
            })}
          </div>
        </Alan>
      )}
    </Bolum>
  );
}

function EtiketAyari({ a, kaydet }) {
  const { toast } = useApp();
  const [e, setE] = useState({ ...a.etiket });
  const [bilgi, setBilgi] = useState(null);
  const [yazicilar, setYazicilar] = useState([]);
  const [mesgul, setMesgul] = useState(false);
  useEffect(() => {
    api('/etiket/bicimler').then(setBilgi).catch(() => {});
    api('/yazicilar').then(setYazicilar).catch(() => {});
  }, []);
  const deneme = async () => {
    setMesgul(true);
    try {
      await kaydet({ etiket: e }, 'Etiket ayarı kaydedildi');
      const r = await api('/etiket/yazdir', { method: 'POST', body: { tur: 'raf', kodlar: ['DENEME-01'], bicim: e.rafBicim, yazici: e.yazici } });
      toast(`Deneme etiketi ${r.yazici} yazıcısına gönderildi`);
    } catch (er) {
      toast(er.message, true);
    } finally {
      setMesgul(false);
    }
  };
  return (
    <Bolum
      ikon="printer"
      baslik="Etiket yazıcısı"
      aciklama="Bu bilgisayara bağlı etiket yazıcısı. Yönetim ekranından ve terminallerden (Ürün Sorgu / Raf Sorgu › Etiket bas) istenen etiketler buradan çıkar."
      alt={<><Btn kind="primary" onClick={() => kaydet({ etiket: e }, 'Etiket ayarı kaydedildi')}>Kaydet</Btn>{bilgi?.yazdirabilir && <Btn icon="printer" busy={mesgul} onClick={deneme}>Deneme etiketi bas</Btn>}</>}
    >
      {!bilgi?.yazdirabilir && <div className="notice warn"><Icon name="warning" /><p>Yazıcıya yalnız masaüstü programı basabilir (şu an tarayıcıdan/geliştirme sunucusundan açık).</p></div>}
      <div className="grid g3">
        <Alan etiket="Yazıcı">
          <select className="inp" value={e.yazici || ''} onChange={(x) => setE({ ...e, yazici: x.target.value })}>
            <option value="">Windows varsayılanı</option>
            {yazicilar.map((y) => <option key={y.ad} value={y.ad}>{y.ad}{y.varsayilan ? ' (varsayılan)' : ''}</option>)}
          </select>
        </Alan>
        <Alan etiket="Ürün etiketi boyutu">
          <select className="inp" value={e.urunBicim} onChange={(x) => setE({ ...e, urunBicim: x.target.value })}>
            {(bilgi?.bicimler || []).map((b) => <option key={b.kod} value={b.kod}>{b.ad}</option>)}
          </select>
        </Alan>
        <Alan etiket="Raf etiketi boyutu">
          <select className="inp" value={e.rafBicim} onChange={(x) => setE({ ...e, rafBicim: x.target.value })}>
            {(bilgi?.bicimler || []).map((b) => <option key={b.kod} value={b.kod}>{b.ad}</option>)}
          </select>
        </Alan>
      </div>
      <label className="check"><input type="checkbox" checked={e.rafGoster !== false} onChange={(x) => setE({ ...e, rafGoster: x.target.checked })} /><span><b>Ürün etiketine rafını yaz</b><br /><span className="muted small">Ürünün en çok bulunduğu raf etiketin köşesine basılır.</span></span></label>
    </Bolum>
  );
}

export default function Ayarlar() {
  const { toast, durum, yenile } = useApp();
  const { veri: a, yukle } = useVeri('/ayarlar');
  const yedekler = useVeri('/yedekler');
  const [taslak, setTaslak] = useState(null);
  const [parola, setParola] = useState('');
  const [fis, setFis] = useState(null);
  const [acilis, setAcilis] = useState(null);
  const [mesgul, setMesgul] = useState('');
  const [sor, onayPenceresi] = useOnay();

  useEffect(() => {
    // Yalnız ilk yüklemede: bir bölüm kaydedilince diğer bölümlerdeki kaydedilmemiş değişiklik silinmesin.
    if (a) setTaslak((t) => t || { kabul: { ...a.kabul }, rafAdresi: { alan: '', depo: null, ...a.rafAdresi }, urun: { ...a.urun }, sayim: { ...a.sayim }, port: a.port, yenileme: a.yenileme });
  }, [a]);
  useEffect(() => {
    api('/vega/fis-varsayilan').then(setFis).catch(() => {});
    window.masaustu?.acilistaBaslat?.().then(setAcilis).catch(() => {});
  }, []);

  const kaydet = async (govde, mesaj = 'Ayarlar kaydedildi') => {
    try {
      const r = await api('/ayarlar', { method: 'PUT', body: govde });
      toast(r.portDegisti ? 'Kaydedildi. Port değişikliği program yeniden açılınca geçerli olur.' : mesaj);
      yukle();
      yenile();
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  };

  if (!a || !taslak) return null;
  const t = taslak;
  const setT = (yol, deger) => setTaslak((x) => {
    const n = JSON.parse(JSON.stringify(x));
    const p = yol.split('.');
    let o = n;
    for (const k of p.slice(0, -1)) o = o[k];
    o[p.at(-1)] = deger;
    return n;
  });
  const tur = (k) => {
    const s = new Set(t.kabul.izahat);
    s.has(k) ? s.delete(k) : s.add(k);
    setT('kabul.izahat', [...s]);
  };

  const yedekAl = async () => {
    setMesgul('yedek');
    try {
      const r = await api('/yedek', { method: 'POST' });
      toast(`Yedek alındı: ${r.ad}`);
      yedekler.yukle();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };
  const klasor = (ne) => api('/klasor', { method: 'POST', body: { ne } }).catch((e) => toast(e.message, true));

  return (
    <>
      <SayfaBaslik baslik="Ayarlar" />
      {onayPenceresi}
      <div className="stack">
        <VegaAyari a={a} kaydet={(g) => kaydet(g, 'Vega ayarı kaydedildi, veri okunuyor')} />

        <div className="grid g2">
          <Bolum ikon="package" baslik="Mal kabul" aciklama="Vega'da depoya giren hangi belgeler rafa kaldırılacak iş olarak terminale gelsin?"
            alt={<Btn kind="primary" onClick={() => kaydet({ kabul: kabulGovde(t.kabul) })}>Kaydet</Btn>}>
            <div className="stack" style={{ gap: 8 }}>
              {TURLER.map(([k, ad]) => (
                <label key={k} className="check"><input type="checkbox" checked={t.kabul.izahat.includes(k)} onChange={() => tur(k)} /><span>{ad}</span></label>
              ))}
            </div>
            <Alan etiket="Diğer belge türleri (IZAHAT)" ipucu="Örnek: depolar arası transferin giriş türü. Virgülle ayırın.">
              <input
                className="inp mono"
                style={{ width: 180 }}
                value={t.kabul.ekTur ?? t.kabul.izahat.filter((k) => !TURLER.some(([x]) => x === k)).join(', ')}
                onChange={(e) => setT('kabul.ekTur', e.target.value.replace(/[^\d, ]/g, ''))}
              />
            </Alan>
            <Alan etiket="Başlangıç tarihi" ipucu="Bundan eski belgeler gelmez (kurulum günü önerilir)">
              <input type="date" className="inp" style={{ width: 180 }} value={t.kabul.baslangic || ''} onChange={(e) => setT('kabul.baslangic', e.target.value)} />
            </Alan>
          </Bolum>
          <EtiketAyari a={a} kaydet={kaydet} />
        </div>

        <div className="grid g2">
          <Bolum ikon="mapPoint" baslik="Vega'daki raf adresi" aciklama="Ürünün raf adresleri Vega stok kartının bir özel kod alanında durur. Program ya bu alanı okuyup ürünü o raflara zimmetler ya da zimmetleri bu alana kendisi yazar. Birden çok raf virgülle: A-01-02, B-03-01."
            alt={<Btn kind="primary" onClick={async () => {
              if (t.rafAdresi.yaz && !t.rafAdresi.alan) {
                toast('"Program bu alana yazsın" için önce stok kartı alanını yazın (Ortaş: KOD10)', true);
                return;
              }
              const ilkYazma = t.rafAdresi.yaz && t.rafAdresi.alan && (!a.rafAdresi?.yaz || a.rafAdresi.alan !== t.rafAdresi.alan);
              if (ilkYazma && !(await sor(
                `${t.rafAdresi.alan} alanına yazılsın mı?`,
                `Bütün stok kartlarında ${t.rafAdresi.alan} alanındaki mevcut bilgi silinecek, yerine yalnız raf adresleri yazılacak.\nKartların eski değerleri programda saklanır.`,
                { tamam: 'Sil ve yaz', tehlike: true },
              ))) return;
              kaydet({ rafAdresi: t.rafAdresi }, 'Kaydedildi, Vega okunuyor');
            }}>Kaydet</Btn>}>
            <div className="grid g2">
              <Alan etiket="Stok kartı alanı" ipucu="Boş = kullanılmaz. Ortaş: KOD10">
                <input className="inp mono" value={t.rafAdresi.alan || ''} placeholder="KOD10" onChange={(e) => setT('rafAdresi.alan', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
              </Alan>
              <Alan etiket="Raflar hangi depoda">
                <select className="inp" value={t.rafAdresi.yaz && t.rafAdresi.tumDepolar !== false ? 'hepsi' : t.rafAdresi.depo ?? ''} onChange={(e) => { const v = e.target.value; setT('rafAdresi.tumDepolar', v === 'hepsi'); if (v !== 'hepsi') setT('rafAdresi.depo', v === '' ? null : Number(v)); }}>
                  {t.rafAdresi.yaz && <option value="hepsi">Bütün depolar (kartta hepsi)</option>}
                  <option value="">Varsayılan depo</option>
                  {(durum?.depolar || []).map((d) => <option key={d.ind} value={d.ind}>{d.ad}</option>)}
                </select>
              </Alan>
            </div>
            <label className="check">
              <input type="checkbox" checked={Boolean(t.rafAdresi.yaz)} onChange={(e) => setT('rafAdresi.yaz', e.target.checked)} />
              <span><b>Program bu alana yazsın</b><br /><span className="muted small">Terminalde rafa kaldırılan, transfer edilen ya da sayımda bulunan ürünün rafı, ayrıca Excel ve yönetici zimmetleri karta yazılır (zimmet değişince ~3 sn sonra). Alandaki eski bilgi silinir (ilk değerler programda saklanır); Vega'da bu alan elle değiştirilmemeli.</span></span>
            </label>
            {!t.rafAdresi.yaz && (
              <label className="check">
                <input type="checkbox" checked={Boolean(t.rafAdresi.yeniRafAc)} onChange={(e) => setT('rafAdresi.yeniRafAc', e.target.checked)} />
                <span><b>Tanımsız adresleri raf olarak aç</b><br /><span className="muted small">Kapalıyken yalnız Raflar'da tanımlı kodlar alınır; alanda raf olmayan bilgi (araç modeli gibi) varsa kapalı tutun.</span></span>
              </label>
            )}
            {durum?.vega?.rafAdresi?.yaz && (
              <div className={`notice ${durum.vega.rafAdresi.hata ? 'warn' : 'info'}`}>
                <Icon name={durum.vega.rafAdresi.hata ? 'warning' : 'info'} />
                <p>
                  {durum.vega.rafAdresi.hata
                    ? <>Vega'ya yazılamadı: {durum.vega.rafAdresi.hata}</>
                    : <>{durum.vega.rafAdresi.urun?.toLocaleString('tr-TR')} ürünün {durum.vega.rafAdresi.adres?.toLocaleString('tr-TR')} raf adresi {durum.vega.rafAdresi.alan} alanında. Son yazmada {durum.vega.rafAdresi.yazilan?.toLocaleString('tr-TR')} kart güncellendi.</>}
                  {durum.vega.rafAdresi.baskaDepo > 0 && <> {durum.vega.rafAdresi.baskaDepo.toLocaleString('tr-TR')} zimmet başka depoda; kartta tek alan olduğundan yalnız {durum.vega.rafAdresi.depoAd || 'seçili depo'} adresleri yazılır.</>}
                  {durum.vega.rafAdresi.elle > 0 && <> Vega'da elle değiştirilmiş {durum.vega.rafAdresi.elle} kartın üzerine yazıldı.</>}
                  {durum.vega.rafAdresi.sigmayan > 0 && <> {durum.vega.rafAdresi.sigmayan} kartın adresleri {durum.vega.rafAdresi.uzunluk} karaktere sığmadı, ilk raflar yazıldı (ör. {durum.vega.rafAdresi.sigmayanListe.slice(0, 3).join(', ')}).</>}
                </p>
              </div>
            )}
            {durum?.vega?.rafAdresi?.alan && !durum.vega.rafAdresi.yaz && (
              <div className="notice info">
                <Icon name="info" />
                <p>
                  {durum.vega.rafAdresi.urun.toLocaleString('tr-TR')} ürün, {durum.vega.rafAdresi.adres.toLocaleString('tr-TR')} raf adresi okundu.
                  {durum.vega.rafAdresi.tanimsiz > 0 && <> Raflar'da tanımlı olmayan {durum.vega.rafAdresi.tanimsiz.toLocaleString('tr-TR')} farklı değer alınmadı (en sık: {durum.vega.rafAdresi.tanimsizListe.slice(0, 5).map((x) => `${x.adres} ${x.kart}`).join(', ')}).</>}
                  {durum.vega.rafAdresi.gecersiz?.length > 0 && <> Raf kodu biçimine uymayan {durum.vega.rafAdresi.gecersiz.length >= 50 ? '50+' : durum.vega.rafAdresi.gecersiz.length} değer atlandı (ör. {durum.vega.rafAdresi.gecersiz.slice(0, 3).map((g) => `${g.code}: ${g.adres}`).join(', ')}).</>}
                </p>
              </div>
            )}
            {durum?.vega?.rafAdresi?.kullanilmiyor && (
              <div className="notice warn"><Icon name="warning" /><p>Raflar için seçilen depo "Kullanılan depolar" arasında değil; zimmetler terminale gitmez. Vega ayarından depoyu ekleyin.</p></div>
            )}
            {t.rafAdresi.alan && a.rafAdresi?.alan === t.rafAdresi.alan && durum?.vega?.ok && !durum?.vega?.rafAdresi?.alan && (
              <div className="notice warn"><Icon name="warning" /><p>{t.rafAdresi.alan} alanı Vega stok kartlarında bulunamadı.</p></div>
            )}
          </Bolum>
        </div>

        {/* Kurulumda bir kez bakılır; varsayılanlar çoğu firmada doğru. */}
        <details className="card gelismis">
          <summary className="card-head" style={{ cursor: 'pointer' }}><Icon name="settings" /><h2>Gelişmiş ayarlar</h2><span className="muted small">— genelde değiştirmeye gerek yok</span></summary>
          <div className="card-pad stack">
        <div className="grid g2">
          <Bolum ikon="mobile" baslik="Terminaldeki ürün listesi" aciklama="Terminal internetsiz çalışmak için ürün listesini saklar. Liste küçük olursa eşitleme hızlı olur."
            alt={<Btn kind="primary" onClick={() => kaydet({ urun: t.urun })}>Kaydet</Btn>}>
            <label className="check"><input type="radio" name="kapsam" checked={t.urun.kapsam === 'aktif'} onChange={() => setT('urun.kapsam', 'aktif')} />
              <span><b>Kullanılan kartlar</b><br /><span className="muted small">Depoda stoğu olan, son {t.urun.gun} günde hareket gören, rafta ya da açık belgede olan kartlar.</span></span></label>
            {t.urun.kapsam === 'aktif' && (
              <Alan etiket="Hareket süresi (gün)"><input className="inp mono" style={{ width: 120 }} value={t.urun.gun} onChange={(e) => setT('urun.gun', e.target.value.replace(/\D/g, ''))} /></Alan>
            )}
            <label className="check"><input type="radio" name="kapsam" checked={t.urun.kapsam === 'tum'} onChange={() => setT('urun.kapsam', 'tum')} />
              <span><b>Tüm kartlar</b><br /><span className="muted small">{durum?.vega.urun ? `${durum.vega.urun.toLocaleString('tr-TR')} kart` : ''} — eski terminallerde yavaşlayabilir.</span></span></label>
          </Bolum>
        </div>

        <div className="grid g2">
          <Bolum ikon="count" baslik="Vega'ya yazılan sayım fişi" aciklama="Onaylanan sayım Vega'ya sayım fişi olarak yazılırken fişin üst bilgisi. Boş bırakılan alan Vega'daki mevcut belgelerden kendiliğinden okunur; çoğu firmada boş bırakılır."
            alt={<Btn kind="primary" onClick={() => kaydet({ sayim: t.sayim })}>Kaydet</Btn>}>
            <div className="grid g2">
              <Alan etiket="Belge no öneki" ipucu={`Vega'nın kendi serisiyle çakışmasın: ${t.sayim.onek || 'T'}0000001`}><input className="inp mono" value={t.sayim.onek || ''} onChange={(e) => setT('sayim.onek', e.target.value.toUpperCase().slice(0, 3))} /></Alan>
              <Alan etiket="Vega kullanıcı no (USERNO)" ipucu="Fiş Vega'da hangi kullanıcı kesmiş gibi görünsün"><input className="inp mono" value={t.sayim.userno ?? ''} placeholder={fis ? String(fis.userno) : ''} onChange={(e) => setT('sayim.userno', e.target.value.replace(/\D/g, '') || null)} /></Alan>
              <Alan etiket="Şube (OZELKOD1)" ipucu="Vega belgesindeki Şube alanı; şube raporları buna göre süzer"><input className="inp" value={t.sayim.ozelkod1 ?? ''} placeholder={fis?.ozelkod1 || ''} onChange={(e) => setT('sayim.ozelkod1', e.target.value || null)} /></Alan>
              <Alan etiket="Kasa (OZELKOD2)" ipucu="Vega belgesindeki Kasa alanı; stok fişinde para hareketi yok, yalnız rapor süzgeci"><input className="inp" value={t.sayim.ozelkod2 ?? ''} placeholder={fis?.ozelkod2 || ''} onChange={(e) => setT('sayim.ozelkod2', e.target.value || null)} /></Alan>
            </div>
          </Bolum>

          <Bolum ikon="server" baslik="Sunucu" alt={<Btn kind="primary" onClick={() => kaydet({ port: Number(t.port), yenileme: Number(t.yenileme) })}>Kaydet</Btn>}>
            <div className="grid g2">
              <Alan etiket="Port" ipucu="Terminaller bu porta bağlanır"><input className="inp mono" value={t.port} onChange={(e) => setT('port', e.target.value.replace(/\D/g, ''))} /></Alan>
              <Alan etiket="Vega yenileme (sn)" ipucu="Yeni belge ve stok bu aralıkla gelir"><input className="inp mono" value={t.yenileme} onChange={(e) => setT('yenileme', e.target.value.replace(/\D/g, ''))} /></Alan>
            </div>
            {acilis !== null && (
              <label className="check">
                <input type="checkbox" checked={acilis} onChange={async (e) => { const v = e.target.checked; await window.masaustu.acilistaBaslat(v); setAcilis(v); toast(v ? 'Windows açılınca başlayacak' : 'Otomatik başlatma kapandı'); }} />
                <span><b>Windows açılınca başlat</b><br /><span className="muted small">Terminaller çalışsın diye program bu bilgisayarda hep açık kalmalı (pencere kapanınca saat yanında çalışır).</span></span>
              </label>
            )}
          </Bolum>
        </div>
          </div>
        </details>

        <div className="grid g2">
          <Bolum ikon="lock" baslik="Güvenlik" aciklama="Parola belirlenirse program açılırken sorulur ve yönetim ekranına ağdaki başka bilgisayardan da girilebilir (http://sunucu-adresi:port).">
            <div className="row">
              {a.yoneticiParolaVar ? <Rozet tur="b-ok">Parola var</Rozet> : <Rozet tur="b-mute">Parola yok</Rozet>}
            </div>
            <div className="row wrap">
              <input className="inp" type="password" style={{ maxWidth: 240 }} placeholder="Yeni parola (en az 4)" value={parola} onChange={(e) => setParola(e.target.value)} />
              <Btn kind="primary" disabled={parola.length < 4} onClick={async () => { if (await kaydet({ yoneticiParola: parola }, 'Parola belirlendi')) setParola(''); }}>Parolayı kaydet</Btn>
              {a.yoneticiParolaVar && <Btn kind="danger" onClick={() => kaydet({ yoneticiParola: '' }, 'Parola kaldırıldı')}>Kaldır</Btn>}
            </div>
          </Bolum>

          <Bolum ikon="folder" baslik="Yedek ve dosyalar" aciklama="Program verisi (raflar, raf stoku, sayımlar, kullanıcılar) her gün kendiliğinden yedeklenir; son 30 yedek saklanır. Vega'nın yedeği ayrıca alınmalı.">
            <div className="btns">
              <Btn icon="database" busy={mesgul === 'yedek'} onClick={yedekAl}>Şimdi yedekle</Btn>
              {durum?.masaustu && <Btn icon="folder" onClick={() => klasor('yedek')}>Yedek klasörü</Btn>}
              {durum?.masaustu && <Btn icon="history" onClick={() => klasor('gunluk')}>Günlük kayıtları</Btn>}
            </div>
            <div className="small muted">Son yedek: {tarihSaat(durum?.sonYedek)} · Veri: <span className="mono">{a.dosyalar.veri}</span></div>
            {yedekler.veri?.length > 0 && (
              <div className="tbl-scroll" style={{ maxHeight: 160, border: '1px solid var(--line-soft)', borderRadius: 8 }}>
                <table className="tbl">
                  <tbody>
                    {yedekler.veri.slice(0, 10).map((y) => (
                      <tr key={y.ad}><td className="mono small">{y.ad}</td><td className="num small">{(y.boyut / 1048576).toFixed(1)} MB</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Bolum>
        </div>

        <Bolum ikon="info" baslik="Hakkında">
          <dl className="kv">
            <dt>Program</dt><dd>Ortaş Depo Yönetici {durum?.surum}</dd>
            <dt>Terminal uygulaması</dt><dd>{durum?.apk ? `${durum.apk.versionName} (${(durum.apk.boyut / 1048576).toFixed(1)} MB)` : 'yok'}</dd>
            <dt>Destek</dt><dd>ArcTeknik · Said Bayraktar</dd>
          </dl>
          {window.masaustu?.guncellemeDenetle && <div><Btn icon="refresh" onClick={() => window.masaustu.guncellemeDenetle().then((m) => toast(m)).catch((e) => toast(e.message, true))}>Güncellemeyi denetle</Btn></div>}
        </Bolum>
      </div>
    </>
  );
}
