#!/usr/bin/env bash
# Test für backup.sh/restore.sh mit echter PostgreSQL und einem Ersatz für die AWS-CLI.
# Aufruf: TEST_ADMIN_URL=postgresql://postgres:pw@localhost:5432/postgres bash backup/test/run-test.sh
# Getestet wird: Dump, Prüfungen, Upload, Monatskopie, Aufbewahrung, Fehlerfälle, Rückspielen mit Zeilenvergleich.
# Nicht getestet: echtes S3-Protokoll, Docker-Image (erster Lauf auf Railway).
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT_BACKUP="$(dirname "$HERE")"
ADMIN="${TEST_ADMIN_URL:?TEST_ADMIN_URL fehlt}"
base="${ADMIN%/*}"          # postgresql://user:pw@host:port
SRC="${base}/backup_src"; DST="${base}/backup_dst"
export STUB_S3_DIR="$(mktemp -d)"; export PATH="$HERE/stub:$PATH"
export PGSSLMODE=disable
export BUCKET=testbucket ENDPOINT=http://stub ACCESS_KEY_ID=x SECRET_ACCESS_KEY=y
trap 'rm -rf "$STUB_S3_DIR"; psql "$ADMIN" -qc "DROP DATABASE IF EXISTS backup_src" -c "DROP DATABASE IF EXISTS backup_dst" >/dev/null 2>&1 || true' EXIT
annot() { [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error::$(printf '%s' "$*" | tr '\n' '|' | cut -c1-900)" || true; }
fail() { echo "FEHLGESCHLAGEN: $*" >&2; annot "FEHLGESCHLAGEN: $* | $(tail -n 5 /tmp/bt*.log 2>/dev/null)"; exit 1; }
trap 'rc=$?; annot "Zeile $LINENO Exit $rc: $BASH_COMMAND | $(tail -n 5 /tmp/bt*.log 2>/dev/null)"' ERR
[[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::notice::$(pg_dump --version) / $(pg_restore --version) / Server $(psql "$ADMIN" -Atc 'show server_version')" || true
ok() { echo "OK: $*"; }

psql "$ADMIN" -qc "DROP DATABASE IF EXISTS backup_src" -c "DROP DATABASE IF EXISTS backup_dst" -c "CREATE DATABASE backup_src" -c "CREATE DATABASE backup_dst"
psql "$SRC" -q <<'SQL'
CREATE TABLE positions (id serial PRIMARY KEY, mmsi bigint, name text, co2_kg_h double precision, ts timestamptz);
INSERT INTO positions (mmsi,name,co2_kg_h,ts) SELECT 244000000+g, 'Yacht '||g, g*1.5, now() FROM generate_series(1,3000) g;
CREATE TABLE owners (id serial PRIMARY KEY, alias text UNIQUE, name text);
INSERT INTO owners (alias,name) VALUES ('Owner A','Test A'),('Owner B','Test B');
SQL
export DATABASE_URL="$SRC"

# 1. Normaler Lauf
bash "$ROOT_BACKUP/backup.sh" >/tmp/bt1.log 2>&1 || { cat /tmp/bt1.log; fail "Lauf 1"; }
n=$(find "$STUB_S3_DIR/testbucket/yacht-emissions/daily" -type f | wc -l); [[ "$n" == 1 ]] || fail "daily erwartet 1, ist $n"
m=$(find "$STUB_S3_DIR/testbucket/yacht-emissions/monthly" -type f | wc -l); [[ "$m" == 1 ]] || fail "monthly erwartet 1, ist $m"
ok "Lauf 1: ein Tagesbackup, eine Monatskopie"

# 2. Rückspielen und Zeilenvergleich
CONFIRM_OVERWRITE= bash "$ROOT_BACKUP/restore.sh" latest "$DST" >/tmp/bt2.log 2>&1 || { cat /tmp/bt2.log; fail "restore"; }
a=$(psql "$SRC" -Atc "SELECT count(*)||'/'||sum(co2_kg_h)||'/'||(SELECT count(*) FROM owners) FROM positions")
b=$(psql "$DST" -Atc "SELECT count(*)||'/'||sum(co2_kg_h)||'/'||(SELECT count(*) FROM owners) FROM positions")
[[ "$a" == "$b" ]] || fail "Zeilen/Summen weichen ab: $a vs $b"
ok "Rückspielen: identisch ($a)"

# 3. restore verweigert Produktions-Ziel
if bash "$ROOT_BACKUP/restore.sh" latest "$SRC" >/dev/null 2>&1; then fail "restore auf DATABASE_URL hätte verweigert werden müssen"; fi
ok "restore verweigert Produktionsdatenbank ohne Bestätigung"

# 4. Aufbewahrung: 20 alte Tagesbackups anlegen, KEEP=5, danach genau 5
d="$STUB_S3_DIR/testbucket/yacht-emissions/daily"
for i in $(seq 1 20); do touch "$d/yacht-emissions_202601$(printf %02d $i)T030000Z.dump"; done
BACKUP_KEEP_DAILY=5 bash "$ROOT_BACKUP/backup.sh" >/tmp/bt4.log 2>&1 || { cat /tmp/bt4.log; fail "Lauf 4"; }
n=$(find "$d" -type f | wc -l); [[ "$n" == 5 ]] || fail "daily nach Aufräumen erwartet 5, ist $n"
newest=$(find "$d" -type f | sort | tail -1); [[ "$(wc -c < "$newest")" -gt 2048 ]] || fail "neuester Dump wurde gelöscht oder ist leer"
ok "Aufbewahrung: genau 5 Tagesbackups, neuester erhalten"

# 5. Monatskopie nicht doppelt im selben Monat
m=$(find "$STUB_S3_DIR/testbucket/yacht-emissions/monthly" -type f | wc -l); [[ "$m" == 1 ]] || fail "monthly erwartet 1, ist $m"
ok "Monatskopie nicht doppelt"

# 6. Fehlerfälle
cnt() { find "$STUB_S3_DIR/testbucket" -type f | wc -l; }
before=$(cnt)
if STUB_WRONG_SIZE=1 bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "falsche Größe im Bucket muss scheitern"; fi
[[ "$(cnt)" == "$before" ]] || fail "fehlerhafter Upload wurde nicht entfernt"
ok "falsche Größe im Bucket → Exit 1, fehlerhafter Upload entfernt"
if STUB_FAIL=cp bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "Upload-Fehler muss scheitern"; fi
ok "Upload-Fehler → Exit 1"
if BACKUP_MIN_BYTES=99999999 bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "zu kleiner Dump muss scheitern"; fi
[[ "$(cnt)" == "$before" ]] || fail "bei zu kleinem Dump darf nichts im Bucket landen"
ok "zu kleiner Dump → Exit 1, kein Upload"
if DATABASE_URL="${base}/gibtesnicht" bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "kaputte DB-URL muss scheitern"; fi
ok "nicht erreichbare Datenbank → Exit 1"
if BACKUP_REQUIRE_TABLE=gibtesnicht bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "fehlende Tabelle muss scheitern"; fi
ok "fehlende Pflichttabelle → Exit 1"
if BACKUP_KEEP_DAILY=1 bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "KEEP < 3 muss abgelehnt werden"; fi
ok "BACKUP_KEEP_DAILY < 3 abgelehnt"
unset BUCKET; if bash "$ROOT_BACKUP/backup.sh" >/dev/null 2>&1; then fail "fehlende Variable muss scheitern"; fi
ok "fehlende Variable → Exit 1"
echo "ALLE TESTS BESTANDEN"
