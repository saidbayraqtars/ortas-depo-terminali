// Programın kendi veritabanı (SQLite, node:sqlite). Vega'da olmayan her şey burada:
// raflar, raf stoku, rafa kaldırma ilerlemesi, sayımlar, cihazlar, terminal kullanıcıları, işlem günlüğü.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dosya = null;

let secenek = {};

/** `varsayilanDepo`: çok depoya geçerken (sürüm 2) eski kayıtların bağlanacağı Vega deposu. */
function open(file, ayar = {}) {
  secenek = ayar;
  dosya = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate();
  return db;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)');
  const v = Number(get("SELECT value FROM meta WHERE key='surum'")?.value || 0);
  if (v < 1) {
    db.exec(`
      CREATE TABLE shelf(
        code TEXT PRIMARY KEY,
        zone TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'ADMIN',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE location(
        product_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        qty REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(product_id, shelf)
      );
      CREATE INDEX ix_location_shelf ON location(shelf);
      CREATE TABLE receipt_state(
        receipt_id TEXT PRIMARY KEY,
        closed INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER,
        note TEXT
      );
      CREATE TABLE receipt_shelved(
        line_id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        shelved REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX ix_receipt_shelved ON receipt_shelved(receipt_id);
      CREATE TABLE device(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        last_ip TEXT,
        last_name TEXT,
        last_user TEXT,
        app_version TEXT
      );
      CREATE TABLE app_user(
        username TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        salt TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE count_session(
        id TEXT PRIMARY KEY,
        no TEXT NOT NULL,
        title TEXT NOT NULL,
        blind INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'RAF',
        status TEXT NOT NULL DEFAULT 'OPEN',
        source TEXT NOT NULL DEFAULT 'ADMIN',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        vega_docs TEXT,
        vega_written_at INTEGER
      );
      CREATE TABLE count_line(
        session_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        product_id TEXT NOT NULL,
        terminal_system REAL NOT NULL DEFAULT 0,
        server_before REAL NOT NULL DEFAULT 0,
        counted REAL NOT NULL,
        user TEXT,
        device TEXT,
        submitted_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, shelf, product_id)
      );
      CREATE TABLE op(
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        device TEXT,
        user TEXT,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX ix_op_created ON op(created_at);
      CREATE TABLE movement(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        delta REAL NOT NULL,
        after REAL NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT,
        user TEXT,
        device TEXT,
        op_id TEXT
      );
      CREATE INDEX ix_movement_product ON movement(product_id, ts);
      CREATE INDEX ix_movement_shelf ON movement(shelf, ts);
      CREATE INDEX ix_movement_ts ON movement(ts);
      CREATE TABLE vega_cache(key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    set('surum', '1');
  }
  if (Number(get("SELECT value FROM meta WHERE key='surum'")?.value) < 2) {
    // 2: çok depo. Raf, raf stoku, hareket ve sayım depoya bağlı; eski kayıtlar önceki tek depoya yazılır.
    const d = Number(secenek.varsayilanDepo) || 0;
    db.exec(`
      CREATE TABLE shelf2(
        depo INTEGER NOT NULL,
        code TEXT NOT NULL,
        zone TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'ADMIN',
        created_at INTEGER NOT NULL,
        PRIMARY KEY(depo, code)
      );
      INSERT INTO shelf2 SELECT ${d}, code, zone, note, source, created_at FROM shelf;
      DROP TABLE shelf;
      ALTER TABLE shelf2 RENAME TO shelf;
      CREATE TABLE location2(
        depo INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        qty REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(depo, product_id, shelf)
      );
      INSERT INTO location2 SELECT ${d}, product_id, shelf, qty, updated_at FROM location;
      DROP TABLE location;
      ALTER TABLE location2 RENAME TO location;
      CREATE INDEX ix_location_shelf ON location(depo, shelf);
      CREATE INDEX ix_location_product ON location(product_id);
      ALTER TABLE movement ADD COLUMN depo INTEGER NOT NULL DEFAULT ${d};
      ALTER TABLE count_session ADD COLUMN depo INTEGER NOT NULL DEFAULT ${d};
      -- Ürünün asıl rafı (Excel'den, B2B'deki raf bilgisi): rafa kaldırırken öneri; miktar tutmaz.
      CREATE TABLE product_home(
        depo INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(depo, product_id)
      );
    `);
    set('surum', '2');
  }
  if (Number(get("SELECT value FROM meta WHERE key='surum'")?.value) < 3) {
    // 3: ürün bir depoda birden çok rafa zimmetlenebilir; kaynak (IMPORT, VEGA, ADMIN) tutulur.
    db.exec(`
      CREATE TABLE product_home2(
        depo INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ADMIN',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(depo, product_id, shelf)
      );
      INSERT INTO product_home2 SELECT depo, product_id, shelf, 'IMPORT', updated_at FROM product_home;
      DROP TABLE product_home;
      ALTER TABLE product_home2 RENAME TO product_home;
      CREATE INDEX ix_home_shelf ON product_home(depo, shelf);
    `);
    set('surum', '3');
  }
  if (Number(get("SELECT value FROM meta WHERE key='surum'")?.value) < 4) {
    // 4: program raf adresini Vega kartına yazınca alanın yazılmadan önceki değeri (eski) ve son yazılan değer.
    db.exec(`
      CREATE TABLE vega_alan(
        alan TEXT NOT NULL,
        product_id TEXT NOT NULL,
        eski TEXT NOT NULL,
        yazilan TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(alan, product_id)
      );
    `);
    set('surum', '4');
  }
  if (Number(get("SELECT value FROM meta WHERE key='surum'")?.value) < 5) {
    // 5: raf sayımının kapsamı, virgülle ayrılmış raf önekleri ("K1,K2"); boş = bütün raflar (bkz. kapsam.js).
    // count_shelf: sayımda gönderilen raflar; boş raf da sayılmış olur (count_line'da satırı yoktur).
    db.exec(`
      ALTER TABLE count_session ADD COLUMN scope TEXT NOT NULL DEFAULT '';
      CREATE TABLE count_shelf(
        session_id TEXT NOT NULL,
        shelf TEXT NOT NULL,
        user TEXT,
        device TEXT,
        submitted_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, shelf)
      );
    `);
    if (get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='count_line'")) {
      db.exec('INSERT OR IGNORE INTO count_shelf SELECT session_id, shelf, MAX(user), MAX(device), MAX(submitted_at) FROM count_line GROUP BY session_id, shelf');
    }
    set('surum', '5');
  }
  if (Number(get("SELECT value FROM meta WHERE key='surum'")?.value) < 6) {
    // 6: depolar arası transfer. transfer: terminalden gelen gönderim (SEND, Vega 128) ve kabul (RECEIVE, Vega 129);
    // durum: BEKLIYOR (Vega'ya yazılacak) / YAZILDI / HATA. transfer_line: satırlar. transfer_fark: kabulde gelmeyen
    // (eksik) miktar, çözülene kadar kayıtlı kalır. transfer_kapali: kabulü bitirilen gönderim (terminallerde açık görünmez).
    db.exec(`
      CREATE TABLE transfer(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        from_depo INTEGER NOT NULL,
        to_depo INTEGER NOT NULL,
        sevk_ind INTEGER,
        sevk_no TEXT,
        durum TEXT NOT NULL DEFAULT 'BEKLIYOR',
        hata TEXT,
        deneme INTEGER NOT NULL DEFAULT 0,
        vega_ind INTEGER,
        belge_no TEXT,
        user TEXT,
        device TEXT,
        created_at INTEGER NOT NULL,
        yazildi_at INTEGER
      );
      CREATE INDEX ix_transfer_durum ON transfer(durum);
      CREATE TABLE transfer_line(
        transfer_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        qty REAL NOT NULL,
        shelf TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(transfer_id, product_id, shelf)
      );
      CREATE TABLE transfer_fark(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_id TEXT NOT NULL,
        sevk_ind INTEGER NOT NULL,
        sevk_no TEXT,
        from_depo INTEGER NOT NULL,
        to_depo INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        sent REAL NOT NULL,
        received REAL NOT NULL,
        eksik REAL NOT NULL,
        user TEXT,
        device TEXT,
        created_at INTEGER NOT NULL,
        durum TEXT NOT NULL DEFAULT 'ACIK',
        cozum TEXT,
        cozum_at INTEGER,
        cozum_user TEXT
      );
      CREATE INDEX ix_transfer_fark_durum ON transfer_fark(durum, from_depo, to_depo, product_id);
      CREATE TABLE transfer_kapali(
        sevk_ind INTEGER PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    set('surum', '6');
  }
}

function get(sql, ...args) {
  return db.prepare(sql).get(...args);
}

function all(sql, ...args) {
  return db.prepare(sql).all(...args);
}

function run(sql, ...args) {
  return db.prepare(sql).run(...args);
}

function set(key, value) {
  run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

function meta(key, def = null) {
  const r = get('SELECT value FROM meta WHERE key=?', key);
  return r ? r.value : def;
}

/** fn içindeki her şey tek işlemde; hata olursa geri alınır. İç içe çağrılabilir. */
let derinlik = 0;
function tx(fn) {
  if (derinlik > 0) return fn();
  derinlik++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  } finally {
    derinlik--;
  }
}

/** Çalışan veritabanının tutarlı kopyası. */
function backup(hedef) {
  fs.mkdirSync(path.dirname(hedef), { recursive: true });
  if (fs.existsSync(hedef)) fs.unlinkSync(hedef);
  db.exec(`VACUUM INTO '${hedef.replace(/'/g, "''")}'`);
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = { open, get, all, run, tx, set, meta, backup, close, file: () => dosya };
