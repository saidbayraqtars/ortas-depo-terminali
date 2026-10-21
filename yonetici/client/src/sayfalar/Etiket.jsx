import React, { useEffect, useState } from 'react';
import { Alan, api, Btn, Icon, Modal, useApp } from '../lib.jsx';

// Raf ve ürün etiketi. HTML ve barkod sunucuda üretilir (server/etiket.js); aynı çıktı önizlemede, PDF'te ve
// etiket yazıcısında. Yazıcı sunucu bilgisayarına bağlı olandır; ağdan açılan ekrandan da oraya basılır.
export default function EtiketPenceresi({ tur = 'raf', kodlar = [], urunler = [], kapat }) {
  const { toast } = useApp();
  const [bilgi, setBilgi] = useState(null);
  const [ayar, setAyar] = useState(null);
  const [yazicilar, setYazicilar] = useState([]);
  const [bicim, setBicim] = useState('');
  const [yazici, setYazici] = useState('');
  const [adet, setAdet] = useState('1');
  const [onizleme, setOnizleme] = useState('');
  const [mesgul, setMesgul] = useState('');
  const sayi = tur === 'urun' ? urunler.length : kodlar.length;

  useEffect(() => {
    Promise.all([api('/etiket/bicimler'), api('/ayarlar'), api('/yazicilar').catch(() => [])])
      .then(([b, a, y]) => {
        setBilgi(b);
        setAyar(a.etiket);
        setYazicilar(y);
        setBicim(tur === 'urun' ? a.etiket.urunBicim : a.etiket.rafBicim);
        setYazici(a.etiket.yazici || '');
      })
      .catch((e) => toast(e.message, true));
  }, [tur, toast]);

  useEffect(() => {
    if (!bicim) return;
    api('/etiket/onizle', { method: 'POST', body: { tur, kodlar: kodlar.slice(0, 24), urunler: urunler.slice(0, 24), bicim } })
      .then((r) => setOnizleme(r.html))
      .catch((e) => toast(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bicim, tur, kodlar.join(','), urunler.join(','), toast]);

  const govde = () => ({ tur, kodlar, urunler, bicim, adet: Number(adet) || 1, yazici });
  const toplam = sayi * (Number(adet) || 1);

  const yazdir = async () => {
    setMesgul('yazici');
    try {
      const r = await api('/etiket/yazdir', { method: 'POST', body: govde() });
      toast(`${r.etiket} etiket ${r.yazici} yazıcısına gönderildi`);
      // Seçilen yazıcı ve boyut bir dahaki sefere hazır gelsin.
      if (ayar && (ayar.yazici !== yazici || ayar[tur === 'urun' ? 'urunBicim' : 'rafBicim'] !== bicim)) {
        api('/ayarlar', { method: 'PUT', body: { etiket: { yazici, [tur === 'urun' ? 'urunBicim' : 'rafBicim']: bicim } } }).catch(() => {});
      }
      kapat();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };

  const pdf = async () => {
    setMesgul('pdf');
    try {
      await api('/etiket/pdf', { method: 'POST', body: govde() });
      kapat();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setMesgul('');
    }
  };

  const tarayici = async () => {
    // Masaüstü dışında (geliştirme) tarayıcının yazdırma penceresi.
    const r = await api('/etiket/onizle', { method: 'POST', body: govde() });
    const w = window.open('', '_blank');
    w.document.write(r.html);
    w.document.close();
    setTimeout(() => w.print(), 400);
  };

  return (
    <Modal
      genis
      baslik={`${tur === 'urun' ? 'Ürün barkod etiketi' : 'Raf etiketi'} (${sayi} ${tur === 'urun' ? 'ürün' : 'raf'})`}
      kapat={kapat}
      alt={
        <>
          <Btn onClick={kapat}>Vazgeç</Btn>
          {bilgi?.pdf && <Btn icon="export" busy={mesgul === 'pdf'} onClick={pdf}>PDF</Btn>}
          {!bilgi?.yazdirabilir && !bilgi?.pdf && <Btn icon="printer" onClick={tarayici}>Yazdır</Btn>}
          {bilgi?.yazdirabilir && <Btn kind="primary" icon="printer" busy={mesgul === 'yazici'} onClick={yazdir}>{toplam} etiketi yazıcıya gönder</Btn>}
        </>
      }
    >
      <div className="grid g3">
        <Alan etiket="Etiket boyutu">
          <select className="inp" value={bicim} onChange={(e) => setBicim(e.target.value)}>
            {(bilgi?.bicimler || []).map((b) => <option key={b.kod} value={b.kod}>{b.ad}</option>)}
          </select>
        </Alan>
        <Alan etiket="Yazıcı" ipucu={bilgi?.yazdirabilir ? 'Sunucu bilgisayarındaki yazıcılar' : 'Yazıcı yalnız masaüstü programında'}>
          <select className="inp" value={yazici} onChange={(e) => setYazici(e.target.value)} disabled={!bilgi?.yazdirabilir}>
            <option value="">Windows varsayılanı</option>
            {yazicilar.map((y) => <option key={y.ad} value={y.ad}>{y.ad}{y.varsayilan ? ' (varsayılan)' : ''}</option>)}
          </select>
        </Alan>
        <Alan etiket={tur === 'urun' ? 'Her üründen adet' : 'Her raftan adet'}>
          <input className="inp mono" value={adet} onChange={(e) => setAdet(e.target.value.replace(/\D/g, '').slice(0, 3))} />
        </Alan>
      </div>
      <div className="notice info">
        <Icon name="info" />
        <p>Etiket yazıcısının sürücüsünde kâğıt boyutu seçilen etiketle aynı olmalı. PDF'ten basarken ölçek "%100 / gerçek boyut". {tur === 'urun' ? 'Geçerli EAN-13 barkod olduğu gibi, yoksa ürün kodu Code 128 olarak basılır.' : ''}</p>
      </div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: '#f3f4f2' }}>
        <iframe title="Önizleme" srcDoc={onizleme} style={{ width: '100%', height: 340, border: 0, background: '#fff' }} />
      </div>
    </Modal>
  );
}
