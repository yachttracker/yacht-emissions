# Datenbank-Backup (Railway-Cron-Dienst)

Täglicher `pg_dump` der Produktionsdatenbank in einen Railway-Bucket (S3-kompatibel). Grund: Der Hobby-Plan hat keine Railway-Backups; bei Verlust des Volumes wären Eigentümer-Einträge, Share-Links und Einstellungen weg und die Messdaten nur gegen Credits wiederherstellbar.

## Ablauf (`backup.sh`)
1. `pg_dump` im Custom-Format (komprimiert, ohne Besitzer/Rechte).
2. Prüfung: Mindestgröße, Archiv mit `pg_restore --list` lesbar, Tabelle `positions` enthalten.
3. Upload nach `yacht-emissions/daily/yacht-emissions_<UTC-Zeit>.dump`, danach Größe im Bucket gegenprüfen (bei Abweichung wird der Upload wieder entfernt).
4. Pro Monat eine Kopie nach `yacht-emissions/monthly/`.
5. Aufbewahrung: letzte 14 Tagesbackups, letzte 6 Monatskopien (Railway-Buckets kennen keine Lifecycle-Regeln, daher räumt das Skript selbst auf).
6. Exit 0 nur, wenn alles geklappt hat; sonst Exit 1 und Railway zeigt den Lauf als fehlgeschlagen.

Variablen: Pflicht `DATABASE_URL`, `BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` (`REGION` Standard `auto`). Optional `BACKUP_KEEP_DAILY` (14, mindestens 3), `BACKUP_KEEP_MONTHLY` (6), `BACKUP_MIN_BYTES` (2048), `BACKUP_REQUIRE_TABLE` (positions), `BACKUP_PREFIX` (yacht-emissions), `PGSSLMODE` (require).

## Einrichtung auf Railway (einmalig, per Klick)
1. **Bucket anlegen:** Projekt-Canvas → *Create* → *Bucket*, Region in Europa wählen (lässt sich später nicht ändern), Name z. B. `backups`.
2. **Dienst anlegen:** *Create* → *GitHub Repo* → `yachttracker/yacht-emissions`. In den Einstellungen des neuen Dienstes: *Source* → **Root Directory `/backup`**, Branch `main`. Railway erkennt das Dockerfile.
3. **Variablen des neuen Dienstes** (jeweils als Referenz auf die anderen Dienste, nicht als Klartext):
   - `DATABASE_URL` → `${{Postgres.DATABASE_URL}}`
   - `BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION` → jeweils `${{<Name des Buckets>.<Variable>}}`
4. **Zeitplan:** *Settings* → *Cron Schedule* → `0 3 * * *` (UTC, entspricht 04:00 bzw. 05:00 Uhr deutscher Zeit). Railway beendet den Dienst nach jedem Lauf.
5. **Testlauf:** Dienst einmal auslösen (Redeploy) und das Log prüfen: erwartet „Backup abgeschlossen“. Im Bucket müssen eine Datei unter `daily/` und eine unter `monthly/` liegen.
6. In Railway unter den Benachrichtigungen einschalten, dass fehlgeschlagene Deployments gemeldet werden (sonst fällt ein stiller Ausfall nicht auf).

## Zurückspielen
Nie direkt in die Produktion, sondern zuerst in eine leere Test-Datenbank prüfen:

```
restore.sh latest <ZIEL_DATABASE_URL>          # neuestes Tagesbackup
restore.sh yacht-emissions/monthly/<Datei> <ZIEL_DATABASE_URL>
```

Das Ziel muss PostgreSQL 17 oder neuer sein (der Dump stammt von pg_dump 18; ältere Server kennen `transaction_timeout` nicht, so in der CI beobachtet). Das Skript liegt im selben Image (`/usr/local/bin/restore.sh`) und braucht dieselben Bucket-Variablen. Ohne `CONFIRM_OVERWRITE=yes` verweigert es das Überschreiben der Datenbank aus `DATABASE_URL`. Danach den Backend-Dienst neu starten (Migrationen laufen beim Start idempotent).

**Wiederherstellungstest:** Einmal vor dem Echtbetrieb und danach gelegentlich in eine leere Test-Datenbank zurückspielen. Ein Backup gilt erst als brauchbar, wenn das einmal geklappt hat.

## Tests
`bash backup/test/run-test.sh` (braucht `TEST_ADMIN_URL` auf einen PostgreSQL-Server) spielt Dump, Upload, Monatskopie, Aufbewahrung, Fehlerfälle und Rückspielen mit Zeilenvergleich durch. Der Upload wird dabei durch einen Ersatz der AWS-CLI (`test/stub/aws`) auf ein lokales Verzeichnis abgebildet. **Nicht getestet:** das echte S3-Protokoll gegen den Railway-Bucket und der Docker-Build; das zeigt erst der erste Lauf auf Railway.

## Grenzen
- Das Backup liegt im selben Railway-Projekt wie die Datenbank. Gegen Verlust des ganzen Projekts oder Kontos schützt es nicht; bei Bedarf gelegentlich einen Dump herunterladen und außerhalb von Railway ablegen.
- Der Bucket ist laut Railway-Doku nur privat zugänglich; ob er im Ruhezustand verschlüsselt ist, ist ungeklärt (Dump enthält Eigentümernamen und Share-Key-Hashes).
- Zeitpunkt: tägliche Sicherung, im ungünstigen Fall gehen bis zu 24 Stunden Daten verloren (Messdaten sind per Rückwärtsabruf nachholbar).
