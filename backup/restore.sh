#!/usr/bin/env bash
# Backup zurückspielen.
# Aufruf: restore.sh <latest|Schlüssel> <ZIEL_DATABASE_URL>
# Standardmäßig wird NICHT in die Produktionsdatenbank (DATABASE_URL) geschrieben, sondern nur in ein
# anderes Ziel. Zum Überschreiben der Produktion: CONFIRM_OVERWRITE=yes setzen.
# Variablen wie bei backup.sh (BUCKET, ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BACKUP_PREFIX).
set -Eeuo pipefail

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FEHLER: $*" >&2; exit 1; }

WHICH="${1:-}"; TARGET="${2:-}"
[[ -n "$WHICH" && -n "$TARGET" ]] || die "Aufruf: restore.sh <latest|Schlüssel> <ZIEL_DATABASE_URL>"
: "${BUCKET:?BUCKET fehlt}"; : "${ENDPOINT:?ENDPOINT fehlt}"
: "${ACCESS_KEY_ID:?ACCESS_KEY_ID fehlt}"; : "${SECRET_ACCESS_KEY:?SECRET_ACCESS_KEY fehlt}"

if [[ -n "${DATABASE_URL:-}" && "$TARGET" == "$DATABASE_URL" && "${CONFIRM_OVERWRITE:-}" != "yes" ]]; then
  die "Ziel ist die Produktionsdatenbank. Nur mit CONFIRM_OVERWRITE=yes."
fi

PREFIX="${BACKUP_PREFIX:-yacht-emissions}"
export PGSSLMODE="${PGSSLMODE:-require}"
export AWS_ACCESS_KEY_ID="$ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${REGION:-auto}" AWS_EC2_METADATA_DISABLED=true
AWS=(aws --endpoint-url "$ENDPOINT")

if [[ "$WHICH" == "latest" ]]; then
  out="$("${AWS[@]}" s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/daily/" --query 'Contents[].Key' --output text)"
  [[ -n "$out" && "$out" != "None" ]] || die "Keine Backups gefunden"
  WHICH="$(tr '\t' '\n' <<<"$out" | sort | tail -n 1)"
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FILE="${TMP}/restore.dump"
log "Lade ${WHICH}"
"${AWS[@]}" s3 cp "s3://${BUCKET}/${WHICH}" "$FILE" --only-show-errors
pg_restore --list "$FILE" >/dev/null || die "Archiv nicht lesbar"
log "Spiele zurück (--clean --if-exists)"
pg_restore --dbname="$TARGET" --clean --if-exists --no-owner --no-privileges --exit-on-error "$FILE"
log "Fertig"
