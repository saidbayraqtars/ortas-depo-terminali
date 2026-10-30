import React, { useMemo, useState } from 'react';
import { Alan, api, Btn, Durum, Icon, Modal, Rozet, SayfaBaslik, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

/** İzin listesinin kayıtlı hali: null = hepsi. Şablonla aynıysa şablon adı, değilse "Özel". */
function rolAdi(u, sablonlar) {
  if (u.perms === null) return ['Tam yetkili', 'b-ok'];
  const s = sablonlar.find((x) => x.id === u.role);
  return [s && s.id !== 'tam' ? s.ad : 'Özel', u.perms.length ? 'b-info' : 'b-mute'];
}

function Duzenle({ kullanici, katalog, kapat, tamam }) {
  const { toast } = useApp();
  const yeni = !kullanici;
  const [username, setUsername] = useState(kullanici?.username || '');
  const [name, setName] = useState(kullanici?.name || '');
  const [pin, setPin] = useState('');
  const hepsi = katalog.izinler.map((i) => i.id);
  // Yeni kullanıcı: eski davranış gibi tam yetkiyle başlar; yönetici formdan daraltır.
  const [izinler, setIzinler] = useState(() => new Set(kullanici ? (kullanici.perms ?? hepsi) : hepsi));
  const [rol, setRol] = useState(kullanici?.role || 'tam');
  const [tumDepolar, setTumDepolar] = useState(kullanici ? kullanici.depots === null : true);
  const [depolar, setDepolar] = useState(() => new Set(kullanici?.depots || []));
  const gruplar = useMemo(() => {
    const m = new Map();
    for (const i of katalog.izinler) {
      if (!m.has(i.grup)) m.set(i.grup, []);
      m.get(i.grup).push(i);
    }
    return [...m];
  }, [katalog]);

  const sablonSec = (s) => {
    setRol(s.id);
    setIzinler(new Set(s.izinler === '*' ? hepsi : s.izinler));
  };
  const izinDegis = (id) => {
    setRol('ozel');
    setIzinler((x) => {
      const y = new Set(x);
      if (y.has(id)) y.delete(id);
      else y.add(id);
      return y;
    });
  };
  const depoDegis = (id) =>
    setDepolar((x) => {
      const y = new Set(x);
      if (y.has(id)) y.delete(id);
      else y.add(id);
      return y;
    });

  const tamYetki = hepsi.every((i) => izinler.has(i));
  const kaydet = async (e) => {
    e?.preventDefault();
    if (!tumDepolar && depolar.size === 0) return toast('En az bir depo seçin ya da "Tüm depolar"ı işaretleyin', true);
    const yetki = { perms: tamYetki ? '*' : [...izinler], role: tamYetki ? 'tam' : rol, depots: tumDepolar ? '*' : [...depolar] };
    try {
      if (yeni) await api('/kullanicilar', { method: 'POST', body: { username, name, pin, ...yetki } });
      else await api(`/kullanici/${encodeURIComponent(kullanici.username)}`, { method: 'PUT', body: { name, ...(pin ? { pin } : {}), ...yetki } });
      toast('Kaydedildi; terminallere bir sonraki eşitlemede gider');
      tamam();
    } catch (er) {
      toast(er.message, true);
    }
  };
  return (
    <Modal genis baslik={yeni ? 'Yeni kullanıcı' : kullanici.username} kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" onClick={kaydet}>Kaydet</Btn></>}>
      <form className="stack" onSubmit={kaydet}>
        {yeni && <Alan etiket="Kullanıcı adı" ipucu="Terminalde girişte yazılır; küçük harf, boşluksuz (ornek: ismail)"><input className="inp mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))} autoFocus /></Alan>}
        <Alan etiket="Ad soyad"><input className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!yeni} /></Alan>
        <Alan etiket={yeni ? 'Şifre' : 'Yeni şifre'} ipucu={yeni ? '4-8 haneli rakam' : 'Boş bırakılırsa değişmez'}><input className="inp mono" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} /></Alan>

        <div>
          <div className="field"><span>Hangi depolarda çalışabilir?</span></div>
          <label className="check" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={tumDepolar} onChange={(e) => setTumDepolar(e.target.checked)} />
            <span><b>Tüm depolar</b></span>
          </label>
          {!tumDepolar && (
            <div className="row wrap" style={{ gap: '6px 18px', margin: '8px 0 0 26px' }}>
              {katalog.depolar.map((d) => (
                <label key={d.ind} className="check"><input type="checkbox" checked={depolar.has(d.ind)} onChange={() => depoDegis(d.ind)} /><span>{d.ad}</span></label>
              ))}
            </div>
          )}
          <div className="muted small" style={{ marginTop: 6 }}>
            Seçilen depolar dışında bu kullanıcı işlem yapamaz: o depodan mal çıkaramaz, gönderim ve kabul yapamaz. Toybelen personeli için yalnızca Toybelen deposunu seçin.
          </div>
        </div>

        <div>
          <div className="field"><span>Yetkiler</span></div>
          <div className="seg" style={{ margin: '6px 0 10px', flexWrap: 'wrap' }}>
            {katalog.sablonlar.map((s) => (
              <button key={s.id} type="button" className={rol === s.id && (s.izinler === '*' ? tamYetki : true) ? 'on' : ''} onClick={() => sablonSec(s)}>{s.ad}</button>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
            {gruplar.map(([grup, liste]) => (
              <div key={grup} className="stack" style={{ gap: 8 }}>
                <b className="small">{grup}</b>
                {liste.map((i) => (
                  <label key={i.id} className="check">
                    <input type="checkbox" checked={izinler.has(i.id)} onChange={() => izinDegis(i.id)} />
                    <span>{i.ad}{i.not ? <><br /><span className="muted small">{i.not}</span></> : null}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>Ürün ve raf sorgusu herkese açıktır. Bir şablon yalnız kutuları doldurur; sonra tek tek değiştirebilirsiniz.</div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export default function Kullanicilar() {
  const { toast } = useApp();
  const { veri, hata, yukleniyor, yukle } = useVeri('/kullanicilar');
  const katalog = useVeri('/izinler').veri;
  const [duzenle, setDuzenle] = useState(null);
  const [sor, onay] = useOnay();
  const depoAd = (id) => katalog?.depolar.find((d) => d.ind === id)?.ad || String(id);
  const aktiflik = async (u) => {
    try {
      await api(`/kullanici/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { active: !u.active } });
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const sil = async (u) => {
    if (!(await sor('Kullanıcı silinsin mi?', `${u.username} terminallerde giriş yapamaz. Geçmiş hareketlerdeki adı kalır.`, { tamam: 'Sil', tehlike: true }))) return;
    try {
      await api(`/kullanici/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
      yukle();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return (
    <>
      <SayfaBaslik baslik="Kullanıcılar" alt="Terminalde giriş yapan depo personeli ve yetkileri">
        <Btn kind="primary" icon="plus" disabled={!katalog} onClick={() => setDuzenle({})}>Yeni kullanıcı</Btn>
      </SayfaBaslik>
      <div className="notice info" style={{ marginBottom: 14 }}>
        <Icon name="info" />
        <p>
          Her kullanıcı için hangi işlemleri yapabileceğini ve hangi depolarda çalışabileceğini seçin. Terminal menüyü buna göre daraltır; sunucu da yetkisiz işlemi reddeder
          (<a href="#/hareketler">Hareketler</a> sayfasındaki işlem günlüğünde "Reddedilen" görünür). Şifre terminale düz gitmez (tuzlu özet); yetki ve şifre değişikliği bir sonraki eşitlemede geçerli olur.
        </p>
      </div>
      <div className="card">
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && veri.length === 0 && 'Henüz kullanıcı yok.'}>
          <table className="tbl">
            <thead><tr><th>Kullanıcı adı</th><th>Ad</th><th>Yetki</th><th>Depolar</th><th>Durum</th><th>Eklendi</th><th /></tr></thead>
            <tbody>
              {veri?.map((u) => {
                const [ad, tur] = rolAdi(u, katalog?.sablonlar || []);
                return (
                  <tr key={u.username}>
                    <td className="mono">{u.username}</td>
                    <td><b>{u.name}</b></td>
                    <td>
                      <Rozet tur={tur}>{ad}</Rozet>
                      {u.perms !== null && <div className="muted small" style={{ marginTop: 4 }}>{u.perms.length ? `${u.perms.length} izin` : 'yalnız sorgu'}</div>}
                    </td>
                    <td>{u.depots === null ? <span className="muted">Tüm depolar</span> : u.depots.map(depoAd).join(', ')}</td>
                    <td>{u.active ? <Rozet tur="b-ok">Aktif</Rozet> : <Rozet tur="b-mute">Kapalı</Rozet>}</td>
                    <td className="muted">{tarihSaat(u.created_at)}</td>
                    <td>
                      <div className="btns" style={{ justifyContent: 'flex-end' }}>
                        <Btn size="sm" icon="key" disabled={!katalog} onClick={() => setDuzenle(u)}>Düzenle / yetki</Btn>
                        <Btn size="sm" onClick={() => aktiflik(u)}>{u.active ? 'Kapat' : 'Aç'}</Btn>
                        <Btn size="sm" kind="danger ghost" icon="trash" onClick={() => sil(u)} title="Sil" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Durum>
      </div>
      {duzenle && katalog && <Duzenle kullanici={duzenle.username ? duzenle : null} katalog={katalog} kapat={() => setDuzenle(null)} tamam={() => { setDuzenle(null); yukle(); }} />}
      {onay}
    </>
  );
}
