// Belge kilidi: mal kabul / rafa kaldırma belgesini ve gelen transfer belgesini ekranında açan terminal belgeyi tutar;
// aynı anda ikinci bir terminal aynı belgeye girerse "Ahmet (TRM-03) kullanıyor" uyarısı alır. Kilit ARAYÜZ KORUMASIDIR:
// işlemleri reddetmez (çakışmayı miktar sınırları çözer: rafa kaldırmada belge satırının kalanı, transferde açık miktar).
// Sayım kapsam dışıdır.
//
// belge_kilit tablosu veritabanında durur (sunucu yeniden başlasa da kilitler düşmez). Tutan terminal 30 sn'de bir nabız
// yollar; nabız 3 dk gelmezse kilit düşer (terminal kapandı, çıktı, bağlantısı koptu). Yönetici kilidi açınca satır silinmez,
// durumu ACILDI olur: tutan terminal bir sonraki nabızda öğrenir, bekleyen işini kaydedip belgeden çıkar; sessizce yeniden
// kilit almaz.
const crypto = require('crypto');
const db = require('./db');
const log = require('./log');

const SURE = 3 * 60 * 1000;
const now = () => Date.now();
const TURLER = ['KABUL', 'TRANSFER'];

const guncel = (r) => r.durum === 'ACIK' && now() - r.nabiz_at < SURE;

function tutan(r) {
  return { user: r.user || '', device: r.device || '', since: r.alindi_at, mesaj: `${r.user || 'Başka kullanıcı'} (${r.device || '?'}) kullanıyor` };
}

function temizle() {
  db.run('DELETE FROM belge_kilit WHERE nabiz_at < ?', now() - 24 * 3600 * 1000);
}

/** Belgeyi alır. Dolu ve tutan başka cihazsa { ok: false, holder }, değilse { ok: true, token }. */
function al({ belgeId, tur = 'KABUL', belgeNo = '', user = '', device = '' }) {
  const id = String(belgeId || '').slice(0, 120);
  if (!id) throw Object.assign(new Error('Belge kimliği gerekli'), { status: 400 });
  const t = TURLER.includes(tur) ? tur : 'KABUL';
  return db.tx(() => {
    const r = db.get('SELECT * FROM belge_kilit WHERE belge_id=?', id);
    // Aynı cihaz yeniden girerse (uygulama yeniden açıldı) kendi kilidini devralır.
    if (r && guncel(r) && r.device !== String(device)) return { ok: false, holder: tutan(r) };
    const token = crypto.randomBytes(12).toString('hex');
    db.run(
      `INSERT INTO belge_kilit(belge_id, tur, belge_no, user, device, token, durum, alindi_at, nabiz_at) VALUES(?,?,?,?,?,?, 'ACIK', ?, ?)
       ON CONFLICT(belge_id) DO UPDATE SET tur=excluded.tur, belge_no=excluded.belge_no, user=excluded.user, device=excluded.device,
         token=excluded.token, durum='ACIK', alindi_at=excluded.alindi_at, nabiz_at=excluded.nabiz_at`,
      id, t, String(belgeNo || '').slice(0, 60), String(user).slice(0, 60), String(device).slice(0, 60), token, now(), now(),
    );
    return { ok: true, token, sureSn: SURE / 1000 };
  });
}

/**
 * Tutan terminalin nabzı. neden: 'yonetici' (yönetici kilidi açtı), 'baska' (süre dolmuş, başkası aldı), 'yok' (kayıt yok).
 * Süresi dolmuş ama kimsenin almadığı kendi kilidi sessizce sürer.
 */
function nabiz({ belgeId, token }) {
  const r = db.get('SELECT * FROM belge_kilit WHERE belge_id=?', String(belgeId || ''));
  if (!r) return { ok: false, neden: 'yok' };
  if (r.token !== String(token || '')) return { ok: false, neden: 'baska', holder: tutan(r) };
  if (r.durum !== 'ACIK') return { ok: false, neden: 'yonetici' };
  db.run('UPDATE belge_kilit SET nabiz_at=? WHERE belge_id=?', now(), r.belge_id);
  return { ok: true };
}

/** Belgeden çıkış, kabulü bitirme, oturum kapanması. Başkasının kilidine dokunmaz. */
function birak({ belgeId, token }) {
  const r = db.get('SELECT token FROM belge_kilit WHERE belge_id=?', String(belgeId || ''));
  if (r && r.token === String(token || '')) db.run('DELETE FROM belge_kilit WHERE belge_id=?', String(belgeId));
  return { ok: true };
}

/** Terminal listelerinde 🔒 göstermek için: şu an tutulan belgeler. */
function liste() {
  return db
    .all("SELECT * FROM belge_kilit WHERE durum='ACIK' ORDER BY alindi_at")
    .filter(guncel)
    .map((r) => ({ id: r.belge_id, tur: r.tur, no: r.belge_no, user: r.user || '', device: r.device || '', since: r.alindi_at, last: r.nabiz_at }));
}

/** Yönetici ekranı: tutulan belgeler, kim/hangi cihaz/ne zamandır/son nabız. */
function yoneticiListesi(etiketle = () => ({})) {
  temizle();
  return liste().map((k) => ({ ...k, ...etiketle(k), sureDk: Math.max(0, Math.round((now() - k.since) / 60000)) }));
}

function yoneticiAc(belgeId, kim = 'yönetici') {
  const r = db.get("SELECT * FROM belge_kilit WHERE belge_id=? AND durum='ACIK'", String(belgeId || ''));
  if (!r) return false;
  db.run("UPDATE belge_kilit SET durum='ACILDI' WHERE belge_id=?", r.belge_id);
  log.bilgi(`Belge kilidi açıldı (${kim}): ${r.belge_no || r.belge_id} · ${r.user} (${r.device})`);
  return true;
}

function yoneticiSifirla(kim = 'yönetici') {
  const n = db.run("UPDATE belge_kilit SET durum='ACILDI' WHERE durum='ACIK'").changes;
  if (n) log.bilgi(`Bütün belge kilitleri sıfırlandı (${kim}): ${n} kilit`);
  return Number(n);
}

module.exports = { al, nabiz, birak, liste, yoneticiListesi, yoneticiAc, yoneticiSifirla, SURE };
