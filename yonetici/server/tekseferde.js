// Yöneticinin uzun süren (Vega'ya yazan/silen) işlemlerinin aynı anda ikinci kez başlamasını önler: çift tıklama, iki yönetici.
// Durum kontrolü `await` öncesinde yapıldığı için ikinci istek ilki bitmeden aynı kontrolden geçip işlemi ikinci kez uygulardı
// (transfer geri almada raf stoku iki kez döner, sayım onayında ilk fişin numaraları ezilir). Anahtar işlem + kayıt kimliğidir.
const suren = new Set();

/** Aynı anahtarla bir işlem sürerken ikincisi 409 ile reddedilir. */
async function tekSeferde(anahtar, fn, mesaj = 'Bu işlem şu an sürüyor; bitince yeniden deneyin') {
  if (suren.has(anahtar)) throw Object.assign(new Error(mesaj), { status: 409 });
  suren.add(anahtar);
  try {
    return await fn();
  } finally {
    suren.delete(anahtar);
  }
}

const mesgul = (anahtar) => suren.has(anahtar);

module.exports = { tekSeferde, mesgul };
