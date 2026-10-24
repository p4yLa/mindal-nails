-- Записи клиенток. Применить: npx wrangler d1 execute mindal --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,               -- '2026-10-28' (московская дата)
  start_min   INTEGER NOT NULL,               -- начало в минутах от полуночи: 12:30 -> 750
  dur         INTEGER NOT NULL,               -- длительность процедур в минутах (без 15 минут на дезинфекцию)
  services    TEXT    NOT NULL,               -- коды услуг через запятую: 'mani_gel,ex_design'
  total       INTEGER NOT NULL,               -- сумма в рублях, посчитана на сервере
  name        TEXT    NOT NULL,
  phone       TEXT    NOT NULL,
  contact     TEXT    NOT NULL DEFAULT 'telegram', -- как удобнее связаться: telegram / whatsapp / call
  comment     TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'new', -- new / confirmed / cancelled
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Ускоряет главный запрос: «какие записи в этот день»
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (date);
