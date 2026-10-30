#!/usr/bin/env bash
# Datenbank-Backup: pg_dump -> Railway-Bucket (S3-kompatibel).
# Läuft als Railway-Cron-Dienst und beendet sich nach dem Lauf (Exit 0 = Backup geprüft und hochgeladen,
# Exit 1 = Fehler, Railway zeigt den Lauf dann als fehlgeschlagen).
#
# Pflicht-Variablen (Railway: per Variable Reference aus Postgres bzw. Bucket):
#   DATABASE_URL  Verbindung zur Datenbank (privates Netz)
#   BUCKET, ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY   (REGION optional, Standard "auto")
# Optional:
#   BACKUP_PREFIX (yacht-emissions), BACKUP_KEEP_DAILY (14), BACKUP_KEEP_MONTHLY (6),
#   BACKUP_MIN_BYTES (2048), BACKUP_REQUIRE_TABLE (positions), PGSSLMODE (require)
set -Eeuo pipefail

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FEHLER: $*" >&2; exit 1; }
trap 'die "Abbruch in Zeile $LINENO"' ERR

: "${DATABASE_URL:?DATABASE_URL fehlt}"
: "${BUCKET:?BUCKET fehlt}"
: "${ENDPOINT:?ENDPOINT fehlt}"
: "${ACCESS_KEY_ID:?ACCESS_KEY_ID fehlt}"
: "${SECRET_ACCESS_KEY:?SECRET_ACCESS_KEY fehlt}"

REGION="${REGION:-auto}"
PREFIX="${BACKUP_PREFIX:-yacht-emissions}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
MIN_BYTES="${BACKUP_MIN_BYTES:-2048}"
REQUIRE_TABLE="${BACKUP_REQUIRE_TABLE-positions}"

# Aufbewahrung nie unter 3 Stück, sonst könnte ein Tippfehler alles löschen.
[[ "$KEEP_DAILY" =~ ^[0-9]+$ && "$KEEP_DAILY" -ge 3 ]] || die "BACKUP_KEEP_DAILY muss eine Zahl >= 3 sein"
[[ "$KEEP_MONTHLY" =~ ^[0-9]+$ && "$KEEP_MONTHLY" -ge 1 ]] || die "BACKUP_KEEP_MONTHLY muss eine Zahl >= 1 sein"

export PGSSLMODE="${PGSSLMODE:-require}"
export AWS_ACCESS_KEY_ID="$ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true
AWS=(aws --endpoint-url "$ENDPOINT")

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MONTH="${STAMP:0:6}"
NAME="${PREFIX}_${STAMP}.dump"
FILE="$(mktemp -d)/${NAME}"
trap 'rm -rf "$(dirname "$FILE")"' EXIT

log "Backup startet: ${NAME}"

# 1. Dump (Custom-Format, komprimiert, ohne Besitzer/Rechte, damit er in jede Datenbank passt)
pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --no-privileges --file="$FILE"
SIZE="$(wc -c < "$FILE" | tr -d ' ')"
log "Dump erstellt: ${SIZE} Bytes"

# 2. Prüfung: nicht zu klein, Archiv lesbar, erwartete Tabelle enthalten
[[ "$SIZE" -ge "$MIN_BYTES" ]] || die "Dump kleiner als ${MIN_BYTES} Bytes, wird nicht hochgeladen"
LIST="$(pg_restore --list "$FILE")" || die "Dump ist nicht lesbar (pg_restore --list)"
if [[ -n "$REQUIRE_TABLE" ]]; then
  grep -Eq "TABLE( DATA)? public ${REQUIRE_TABLE}( |\$)" <<<"$LIST" || die "Tabelle ${REQUIRE_TABLE} fehlt im Dump"
fi
log "Dump geprüft (lesbar, Tabelle ${REQUIRE_TABLE:-–} vorhanden)"

# 3. Hochladen und Größe im Bucket gegenprüfen
KEY="${PREFIX}/daily/${NAME}"
"${AWS[@]}" s3 cp "$FILE" "s3://${BUCKET}/${KEY}" --only-show-errors
REMOTE_SIZE="$("${AWS[@]}" s3api head-object --bucket "$BUCKET" --key "$KEY" --query ContentLength --output text)"
if [[ "$REMOTE_SIZE" != "$SIZE" ]]; then
  # Unvollständigen Upload entfernen, damit er nicht als gültiges Backup zählt oder ein gutes verdrängt.
  "${AWS[@]}" s3api delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null || true
  die "Größe im Bucket (${REMOTE_SIZE}) weicht vom Dump (${SIZE}) ab, Upload entfernt"
fi
log "Hochgeladen: ${KEY} (${REMOTE_SIZE} Bytes, Größe bestätigt)"

# Hilfsfunktion: Schlüssel unter einem Präfix, aufsteigend nach Name (= nach Zeit)
list_keys() {
  local out
  out="$("${AWS[@]}" s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" --query 'Contents[].Key' --output text)"
  [[ -z "$out" || "$out" == "None" ]] && return 0
  tr '\t' '\n' <<<"$out" | sort
}

# 4. Monatskopie, falls es für diesen Monat noch keine gibt
MONTHLY_PREFIX="${PREFIX}/monthly/"
EXISTING_MONTHLY="$(list_keys "${MONTHLY_PREFIX}${PREFIX}_${MONTH}")"
if [[ -z "$EXISTING_MONTHLY" ]]; then
  "${AWS[@]}" s3 cp "s3://${BUCKET}/${KEY}" "s3://${BUCKET}/${MONTHLY_PREFIX}${NAME}" --only-show-errors
  log "Monatskopie angelegt: ${MONTHLY_PREFIX}${NAME}"
fi

# 5. Aufräumen (Fehler hier lassen das Backup nicht scheitern, werden aber gemeldet)
prune() {
  local prefix="$1" keep="$2" pattern total n
  pattern="^${prefix}${PREFIX}_[0-9]{8}T[0-9]{6}Z\.dump$"
  mapfile -t keys < <(list_keys "$prefix" | grep -E "$pattern" || true)
  total="${#keys[@]}"
  if (( total > keep )); then
    n=$(( total - keep ))
    for k in "${keys[@]:0:n}"; do
      "${AWS[@]}" s3api delete-object --bucket "$BUCKET" --key "$k" >/dev/null
      log "Gelöscht (älter als die letzten ${keep}): ${k}"
    done
  fi
  log "Bestand ${prefix}: $(( total > keep ? keep : total )) Dateien"
}
prune "${PREFIX}/daily/" "$KEEP_DAILY" || log "WARNUNG: Aufräumen (daily) fehlgeschlagen"
prune "$MONTHLY_PREFIX" "$KEEP_MONTHLY" || log "WARNUNG: Aufräumen (monthly) fehlgeschlagen"

log "Backup abgeschlossen"
