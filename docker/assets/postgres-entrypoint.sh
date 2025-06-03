#!/bin/bash

touch /var/lib/postgresql/data/postgresql.auto.conf
touch /var/lib/postgresql/data/postgresql.conf

#Enable archiving
echo "archive_mode = on" >> /var/lib/postgresql/data/postgresql.conf
echo "archive_command = 'pgbackrest --stanza=n3o archive-push %p'" >> /var/lib/postgresql/data/postgresql.conf
echo "wal_level = replica" >> /var/lib/postgresql/data/postgresql.conf
echo "max_wal_senders = 3" >> /var/lib/postgresql/data/postgresql.conf

# Enable SSL
echo "${SSL_CERTIFICATE}" > /var/lib/postgresql/server.crt
echo "${SSL_KEY}" > /var/lib/postgresql/server.key
chmod 600 /var/lib/postgresql/server.key

echo "ssl = on" >> /var/lib/postgresql/data/postgresql.conf
echo "ssl_cert_file = '/var/lib/postgresql/server.crt'" >> /var/lib/postgresql/data/postgresql.conf
echo "ssl_key_file = '/var/lib/postgresql/server.key'" >> /var/lib/postgresql/data/postgresql.conf

#configure connection settings
echo "statement_timeout = 30000" >> /var/lib/postgresql/data/postgresql.conf
echo "tcp_keepalives_idle = 30" >> /var/lib/postgresql/data/postgresql.conf
echo "idle_session_timeout = 60000" >> /var/lib/postgresql/data/postgresql.conf

#pgbackrest config file
echo "[n3o]" >> /etc/pgbackrest/pgbackrest.conf
echo "pg1-path = /var/lib/postgresql/data/postgres" >> /etc/pgbackrest/pgbackrest.conf
echo "pg1-host-user=${POSTGRES_USER}" >> /etc/pgbackrest/pgbackrest.conf
echo "pg1-user=${POSTGRES_USER}" >> /etc/pgbackrest/pgbackrest.conf

echo "[global]" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-retention-full-type=time" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-retention-full=90" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-retention-diff=2" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-cipher-pass=${BACKUPS_PASSWORD}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-cipher-type=aes-256-cbc" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-path=/${AZURE_CONTAINER}" >> /etc/pgbackrest/pgbackrest.conf
mkdir /etc/pgbackrest/backup-repo

echo "repo1-azure-account=${AZURE_ACCOUNT}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-azure-container=${AZURE_CONTAINER}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-azure-key=${AZURE_KEY}" >> /etc/pgbackrest/pgbackrest.conf
echo "repo1-type=azure" >> /etc/pgbackrest/pgbackrest.conf
echo "process-max=4" >> /etc/pgbackrest/pgbackrest.conf

docker-entrypoint.sh postgres -c shared_buffers=256MB -c max_connections=10000 & sleep 10
pg_ctl restart -D /var/lib/postgresql/data/postgres

# sleep 10

# pgbackrest --stanza=n3o --log-level-console=debug stanza-create --repo1-path=/

# sleep 10

# pgbackrest --stanza=n3o backup --type=full --archive-timeout=600

# sleep 30

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
