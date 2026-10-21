import React, { useState } from 'react';
import { Alan, api, Btn, Durum, Icon, Modal, Rozet, SayfaBaslik, tarihSaat, useApp, useOnay, useVeri } from '../lib.jsx';

function Duzenle({ kullanici, kapat, tamam }) {
  const { toast } = useApp();
  const yeni = !kullanici;
  const [username, setUsername] = useState(kullanici?.username || '');
  const [name, setName] = useState(kullanici?.name || '');
  const [pin, setPin] = useState('');
  const kaydet = async (e) => {
    e?.preventDefault();
    try {
      if (yeni) await api('/kullanicilar', { method: 'POST', body: { username, name, pin } });
      else await api(`/kullanici/${encodeURIComponent(kullanici.username)}`, { method: 'PUT', body: { name, ...(pin ? { pin } : {}) } });
      toast('Kaydedildi; terminallere bir sonraki eşitlemede gider');
      tamam();
    } catch (er) {
      toast(er.message, true);
    }
  };
  return (
    <Modal baslik={yeni ? 'Yeni kullanıcı' : kullanici.username} kapat={kapat} alt={<><Btn onClick={kapat}>Vazgeç</Btn><Btn kind="primary" onClick={kaydet}>Kaydet</Btn></>}>
      <form className="stack" onSubmit={kaydet}>
        {yeni && <Alan etiket="Kullanıcı adı" ipucu="Terminalde girişte yazılır; küçük harf, boşluksuz (ornek: ismail)"><input className="inp mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))} autoFocus /></Alan>}
        <Alan etiket="Ad soyad"><input className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!yeni} /></Alan>
        <Alan etiket={yeni ? 'Şifre' : 'Yeni şifre'} ipucu={yeni ? '4-8 haneli rakam' : 'Boş bırakılırsa değişmez'}><input className="inp mono" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} /></Alan>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export default function Kullanicilar() {
  const { toast } = useApp();
  const { veri, hata, yukleniyor, yukle } = useVeri('/kullanicilar');
  const [duzenle, setDuzenle] = useState(null);
  const [sor, onay] = useOnay();
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
      <SayfaBaslik baslik="Kullanıcılar" alt="Terminalde giriş yapan depo personeli">
        <Btn kind="primary" icon="plus" onClick={() => setDuzenle({})}>Yeni kullanıcı</Btn>
      </SayfaBaslik>
      <div className="notice info" style={{ marginBottom: 14 }}>
        <Icon name="info" />
        <p>Şifre terminale düz gitmez (tuzlu özet). Terminal internetsizken de giriş yapabilsin diye kullanıcı listesi cihazda saklanır; şifre değişince bir sonraki eşitlemede geçerli olur.</p>
      </div>
      <div className="card">
        <Durum yukleniyor={yukleniyor && !veri} hata={hata} bos={veri && veri.length === 0 && 'Henüz kullanıcı yok.'}>
          <table className="tbl">
            <thead><tr><th>Kullanıcı adı</th><th>Ad</th><th>Durum</th><th>Eklendi</th><th /></tr></thead>
            <tbody>
              {veri?.map((u) => (
                <tr key={u.username}>
                  <td className="mono">{u.username}</td>
                  <td><b>{u.name}</b></td>
                  <td>{u.active ? <Rozet tur="b-ok">Aktif</Rozet> : <Rozet tur="b-mute">Kapalı</Rozet>}</td>
                  <td className="muted">{tarihSaat(u.created_at)}</td>
                  <td>
                    <div className="btns" style={{ justifyContent: 'flex-end' }}>
                      <Btn size="sm" icon="key" onClick={() => setDuzenle(u)}>Düzenle / şifre</Btn>
                      <Btn size="sm" onClick={() => aktiflik(u)}>{u.active ? 'Kapat' : 'Aç'}</Btn>
                      <Btn size="sm" kind="danger ghost" icon="trash" onClick={() => sil(u)} title="Sil" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Durum>
      </div>
      {duzenle && <Duzenle kullanici={duzenle.username ? duzenle : null} kapat={() => setDuzenle(null)} tamam={() => { setDuzenle(null); yukle(); }} />}
      {onay}
    </>
  );
}
