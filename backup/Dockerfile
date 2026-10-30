# Backup-Dienst: täglicher pg_dump der Railway-Datenbank in einen Railway-Bucket (S3).
# Läuft als Railway-Cron-Dienst, siehe README.md in diesem Ordner.
# Offizielles Postgres-Image liefert pg_dump/pg_restore passend zur Server-Version 18.
FROM postgres:18-alpine

RUN apk add --no-cache bash aws-cli

COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh

# Das Postgres-Image startet sonst einen Datenbankserver. Hier soll nur das Skript laufen.
ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
