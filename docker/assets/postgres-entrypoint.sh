#!/bin/bash

touch /var/lib/postgresql/data/postgresql.auto.conf
touch /var/lib/postgresql/data/postgresql.conf

#Enable archiving
# Remove exosting config values
sed -i "/archive_mode/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/archive_command/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/wal_level/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/max_wal_senders/d" /var/lib/postgresql/data/postgresql.conf

echo "archive_mode = on" >> /var/lib/postgresql/data/postgresql.conf
echo "archive_command = 'pgbackrest --stanza=n3o archive-push %p'" >> /var/lib/postgresql/data/postgresql.conf
echo "wal_level = replica" >> /var/lib/postgresql/data/postgresql.conf
echo "max_wal_senders = 3" >> /var/lib/postgresql/data/postgresql.conf

# Enable SSL
# Remove exosting config values
sed -i "/ssl/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/ssl_cert_file/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/ssl_key_file/d" /var/lib/postgresql/data/postgresql.conf

echo "${SSL_CERTIFICATE}" > /var/lib/postgresql/server.crt
echo "${SSL_KEY}" > /var/lib/postgresql/server.key
chmod 600 /var/lib/postgresql/server.key

echo "ssl = on" >> /var/lib/postgresql/data/postgresql.conf
echo "ssl_cert_file = '/var/lib/postgresql/server.crt'" >> /var/lib/postgresql/data/postgresql.conf
echo "ssl_key_file = '/var/lib/postgresql/server.key'" >> /var/lib/postgresql/data/postgresql.conf

#configure connection settings
sed -i "/statement_timeout/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/tcp_keepalives_idle/d" /var/lib/postgresql/data/postgresql.conf
sed -i "/idle_session_timeout/d" /var/lib/postgresql/data/postgresql.conf

echo "statement_timeout = 30000" >> /var/lib/postgresql/data/postgresql.conf
echo "tcp_keepalives_idle = 30" >> /var/lib/postgresql/data/postgresql.conf
echo "idle_session_timeout = 60000" >> /var/lib/postgresql/data/postgresql.conf

#pgbackrest config file
sed -i '/^\[n3o\]/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^pg1-path/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^pg1-host-user/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^pg1-user/d' /etc/pgbackrest/pgbackrest.conf

echo "[n3o]" >> /etc/pgbackrest/pgbackrest.conf
echo "pg1-path = /var/lib/postgresql/data/postgres" >> /etc/pgbackrest/pgbackrest.conf
echo "pg1-host-user=${POSTGRES_USER}" >> /etc/pgbackrest/pgbackrest.conf
echo "pg1-user=${POSTGRES_USER}" >> /etc/pgbackrest/pgbackrest.conf


sed -i '/^\[global\]/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-retention-full-type/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-retention-full=/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-retention-diff/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-cipher-pass/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-cipher-type/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-path/d' /etc/pgbackrest/pgbackrest.conf

echo "[global]" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-retention-full-type=time" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-retention-full=90" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-retention-diff=2" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-cipher-pass=${BACKUPS_PASSWORD}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-cipher-type=aes-256-cbc" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-path=/${AZURE_CONTAINER}" >> /etc/pgbackrest/pgbackrest.conf
mkdir /etc/pgbackrest/backup-repo

sed -i '/^repo1-azure-account/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-azure-container/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-azure-key/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^repo1-type/d' /etc/pgbackrest/pgbackrest.conf
sed -i '/^process-max/d' /etc/pgbackrest/pgbackrest.conf

echo "repo1-azure-account=${AZURE_ACCOUNT}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-azure-container=${AZURE_CONTAINER}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-azure-key=${AZURE_KEY}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-type=azure" >> /etc/pgbackrest/pgbackrest.conf
echo "process-max=4" >> /etc/pgbackrest/pgbackrest.conf

docker-entrypoint.sh postgres -c shared_buffers=256MB -c max_connections=10000 & sleep 10
pg_ctl restart -D /var/lib/postgresql/data/postgres

# Create the one-time pgbackrest initialisation script to create a stanza
INIT_SCRIPT="/etc/pgbackrest/pgbackrest-init.sh"

rm -f "$INIT_SCRIPT"

echo "if [ ! -f /var/lib/postgresql/.cron_installed ]; then" >> "$INIT_SCRIPT"
echo "  echo "Running pgBackRest stanza-create and first backup"" >> "$INIT_SCRIPT"
echo "  pgbackrest --stanza=n3o stanza-create" >> "$INIT_SCRIPT"
echo "  pgbackrest --stanza=n3o backup" >> "$INIT_SCRIPT"
echo "  touch /var/lib/postgresql/.cron_installed" >> "$INIT_SCRIPT"
echo "fi" >> "$INIT_SCRIPT"

chmod +x "$INIT_SCRIPT"

# Add Cron Jobs
CRON_FILE="/etc/pgbackrest/cron_job"
touch "$CRON_FILE"
chmod 0644 "$CRON_FILE"

echo "*/10 * * * * postgres /etc/pgbackrest/pgbackrest-init.sh" >> "$CRON_FILE"
echo "0 3 * * 0 postgres pgbackrest --stanza=n3o backup --type=full" >> "$CRON_FILE"
echo "0 3 * * 1-6 postgres pgbackrest --stanza=n3o backup --type=diff" >> "$CRON_FILE"
crontab "$CRON_FILE"
rm "$CRON_FILE"

tail -f /dev/null

while sleep 60; do
  if ! pgrep -f postgres > /dev/null; then
    echo "Postgres not running"
    exit 1
  fi
done
