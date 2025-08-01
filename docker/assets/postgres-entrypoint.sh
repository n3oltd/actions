#!/bin/bash

touch /var/lib/postgresql/data/postgresql.auto.conf
touch /var/lib/postgresql/data/postgres/postgresql.conf
touch /etc/pgbackrest/pgbackrest.conf
touch /etc/pgbackrest/run-backup.sh

sed -i "/archive_mode/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/archive_command/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/wal_level/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/max_wal_senders/d" /var/lib/postgresql/data/postgres/postgresql.conf

sed -i "/logging_collector/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_directory/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_filename/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_rotation_age/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_rotation_size/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_line_prefix/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_min_duration_statement/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_checkpoints/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_connections/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_disconnections/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/log_lock_waits/d" /var/lib/postgresql/data/postgres/postgresql.conf

{
  echo "archive_mode = on"
  echo "archive_command = 'pgbackrest --stanza=n3o archive-push %p'"
  echo "wal_level = replica"
  echo "max_wal_senders = 3"
  echo "ssl = on"
  echo "ssl_cert_file = '/var/lib/postgresql/server.crt'"
  echo "ssl_key_file = '/var/lib/postgresql/server.key'"
  
  echo "logging_collector = on"
  echo "log_directory = 'log'"
  echo "log_filename = 'postgresql-%Y-%m-%d.log'"
  echo "log_rotation_age = 1d"
  echo "log_rotation_size = 0"
  echo "log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '"
  echo "log_min_duration_statement = 0"
  echo "log_checkpoints = on"
  echo "log_connections = on"
  echo "log_disconnections = on"
  echo "log_lock_waits = on"
} >> /var/lib/postgresql/data/postgres/postgresql.conf

sed -i "/ssl/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/ssl_cert_file/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/ssl_key_file/d" /var/lib/postgresql/data/postgres/postgresql.conf
echo "${SSL_CERTIFICATE}" > /var/lib/postgresql/server.crt
echo "${SSL_KEY}" > /var/lib/postgresql/server.key
chmod 600 /var/lib/postgresql/server.key

{
  echo "[n3o]"
  echo "pg1-path = /var/lib/postgresql/data/postgres"
  echo "pg1-host-user=${POSTGRES_USER}"
  echo "pg1-user=${POSTGRES_USER}"
  
  echo "[global]"
  echo "repo1-retention-full-type=time"
  echo "repo1-retention-full=90"
  echo "repo1-retention-diff=2"
  echo "repo1-cipher-pass=${BACKUPS_PASSWORD}"
  echo "repo1-cipher-type=aes-256-cbc"
  echo "repo1-path=/${AZURE_CONTAINER}"  
} >> /etc/pgbackrest/pgbackrest.conf

mkdir /etc/pgbackrest/backup-repo

{
  echo "repo1-azure-account=${AZURE_ACCOUNT}"
  echo "repo1-azure-container=${AZURE_CONTAINER}"
  echo "repo1-azure-key=${AZURE_KEY}"
  echo "repo1-type=azure"
  echo "process-max=2"
  echo "buffer-size=8MiB"
  echo "start-fast=y"
} >> /etc/pgbackrest/pgbackrest.conf

# Unit of tcp_keepalives_idle is seconds and idle_session_timeout is milliseconds
exec docker-entrypoint.sh postgres \
          -c shared_buffers="${POSTGRES_SHARED_BUFFERS}" \
          -c max_connections="${POSTGRES_MAX_CONNECTIONS}" \
          -c work_mem="${POSTGRES_WORK_MEM}" \
          -c tcp_keepalives_idle="${POSTGRES_TCP_KEEPALIVES_IDLE}" \
          -c idle_session_timeout="${POSTGRES_IDLE_SESSION_TIMEOUT}" &

until pg_isready -U "${POSTGRES_USER}" -d :"${POSTGRES_USER}"; do
  echo "Waiting for Postgres to be ready..."
  sleep 2
done

pg_pid=$!
wait "$pg_pid"
