// Programın kendi veritabanı (SQLite, node:sqlite). Vega'da olmayan her şey burada:
// raflar, raf stoku, rafa kaldırma ilerlemesi, sayımlar, cihazlar, terminal kullanıcıları, işlem günlüğü.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dosya = null;

const SURUM = 1;

function open(file) {
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
  if (SURUM !== Number(get("SELECT value FROM meta WHERE key='surum'")?.value)) {
    // Yeni sürümlerin göçleri buraya: if (v < 2) { ... set('surum','2') }
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
