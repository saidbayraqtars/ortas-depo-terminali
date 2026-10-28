// Belge kilidi: alma, çakışma, nabız, süre aşımı, yönetici açması/sıfırlaması, token; HTTP uç noktaları.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-kilit-'));
const config = require('../server/config');
const db = require('../server/db');
const kilit = require('../server/kilit');
config.init(path.join(dir, 'config.json'));
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const gercekSimdi = Date.now;
const ileri = (dk) => { Date.now = () => gercekSimdi() + dk * 60000; };
test.afterEach(() => { Date.now = gercekSimdi; });

const al = (belgeId, user, device, tur = 'KABUL') => kilit.al({ belgeId, tur, belgeNo: `No-${belgeId}`, user, device });

test('kilit alınır; belge doluysa başka cihaza "kim kullanıyor" döner, aynı cihaz devralır', () => {
  const a = al('D20-1', 'Ahmet', 'TRM-03');
  assert.ok(a.ok && a.token && a.sureSn === 180);
  const b = al('D20-1', 'Veli', 'TRM-05');
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.holder.mesaj, 'Ahmet (TRM-03) kullanıyor');
  assert.deepStrictEqual(kilit.liste().map((k) => [k.id, k.user, k.device]), [['D20-1', 'Ahmet', 'TRM-03']]);
  // Başka belge serbest.
  assert.ok(al('D20-2', 'Veli', 'TRM-05').ok);
  // Aynı cihaz (uygulama yeniden açıldı) kendi kilidini devralır, eski token geçersiz olur.
  const a2 = al('D20-1', 'Ahmet', 'TRM-03');
  assert.ok(a2.ok && a2.token !== a.token);
  assert.strictEqual(kilit.nabiz({ belgeId: 'D20-1', token: a.token }).ok, false);
  assert.ok(kilit.nabiz({ belgeId: 'D20-1', token: a2.token }).ok);
  assert.throws(() => kilit.al({ belgeId: '' }), /Belge kimliği/);
});

test('nabızsız 3 dakika sonra kilit düşer; nabız süreyi uzatır; kimse almadıysa eski sahibin nabzı sürer', () => {
  const x = al('D20-10', 'Ahmet', 'TRM-03');
  ileri(2);
  assert.strictEqual(al('D20-10', 'Veli', 'TRM-05').ok, false, '2 dk: hâlâ dolu');
  assert.ok(kilit.nabiz({ belgeId: 'D20-10', token: x.token }).ok);
  Date.now = () => gercekSimdi() + 4.5 * 60000;
  assert.strictEqual(kilit.liste().some((k) => k.id === 'D20-10'), true, 'nabızdan sonra 2,5 dk geçti: düşmedi');
  Date.now = () => gercekSimdi() + 6 * 60000;
  assert.strictEqual(kilit.liste().some((k) => k.id === 'D20-10'), false, 'nabızsız 3 dk geçti');
  // Kimse almadıysa eski sahibin nabzı kilidi sessizce sürdürür (bağlantı kısa süre koptu).
  assert.ok(kilit.nabiz({ belgeId: 'D20-10', token: x.token }).ok);
  assert.strictEqual(kilit.liste().some((k) => k.id === 'D20-10'), true);
  // Süre dolunca başkası alabilir; eski sahibin nabzı "başka" der.
  Date.now = () => gercekSimdi() + 12 * 60000;
  const y = al('D20-10', 'Veli', 'TRM-05');
  assert.ok(y.ok);
  const eski = kilit.nabiz({ belgeId: 'D20-10', token: x.token });
  assert.deepStrictEqual([eski.ok, eski.neden, eski.holder.device], [false, 'baska', 'TRM-05']);
});

test('bırakma: yalnız tutan token bırakabilir; bırakılan belge hemen alınabilir', () => {
  const x = al('D20-20', 'Ahmet', 'TRM-03');
  kilit.birak({ belgeId: 'D20-20', token: 'sahte' });
  assert.strictEqual(al('D20-20', 'Veli', 'TRM-05').ok, false);
  kilit.birak({ belgeId: 'D20-20', token: x.token });
  assert.ok(al('D20-20', 'Veli', 'TRM-05').ok);
  assert.strictEqual(kilit.nabiz({ belgeId: 'YOK-1', token: 'x' }).neden, 'yok');
});

test('yönetici: tek kilit açılır, tutan sonraki nabızda öğrenir ve sessizce yeniden almaz; hepsi sıfırlanabilir', () => {
  const x = al('D20-30', 'Ahmet', 'TRM-03', 'TRANSFER');
  const y = al('D20-31', 'Mehmet', 'TRM-07');
  const liste = kilit.yoneticiListesi();
  assert.ok(liste.find((k) => k.id === 'D20-30' && k.tur === 'TRANSFER' && k.user === 'Ahmet' && k.device === 'TRM-03' && k.sureDk === 0));
  assert.strictEqual(kilit.yoneticiAc('YOK', 'y'), false);
  assert.ok(kilit.yoneticiAc('D20-30', 'y'));
  assert.deepStrictEqual(kilit.nabiz({ belgeId: 'D20-30', token: x.token }), { ok: false, neden: 'yonetici' });
  assert.strictEqual(kilit.liste().some((k) => k.id === 'D20-30'), false, 'açılan belge artık dolu görünmez');
  // Başka biri alabilir; eski sahip yine yönetici nedenini alır değil, "baska" nedenini.
  const z = al('D20-30', 'Veli', 'TRM-05');
  assert.ok(z.ok);
  assert.strictEqual(kilit.nabiz({ belgeId: 'D20-30', token: x.token }).neden, 'baska');

  const n = kilit.yoneticiSifirla('y');
  assert.ok(n >= 2);
  assert.strictEqual(kilit.nabiz({ belgeId: 'D20-31', token: y.token }).neden, 'yonetici');
  assert.strictEqual(kilit.nabiz({ belgeId: 'D20-30', token: z.token }).neden, 'yonetici');
  assert.deepStrictEqual(kilit.liste(), []);
});

test('kilitler veritabanında durur: yeniden açılan veritabanında nabız hâlâ geçerli', () => {
  const x = al('D20-40', 'Ahmet', 'TRM-03');
  db.close();
  db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });
  assert.ok(kilit.nabiz({ belgeId: 'D20-40', token: x.token }).ok);
  assert.strictEqual(al('D20-40', 'Veli', 'TRM-05').ok, false, 'sunucu yeniden başlasa da kilit düşmedi');
});
