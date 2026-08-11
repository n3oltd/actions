#!/bin/bash

touch /var/lib/postgresql/data/postgresql.auto.conf
touch /var/lib/postgresql/data/postgres/postgresql.conf
touch /etc/pgbackrest/pgbackrest.conf
touch /etc/pgbackrest/run-backup.sh

sed -i "/archive_mode/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/archive_command/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/wal_level/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/max_wal_senders/d" /var/lib/postgresql/data/postgres/postgresql.conf
sed -i "/max_replication_slots/d" /var/lib/postgresql/data/postgres/postgresql.conf

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
  echo "ssl = on"
  echo "ssl_cert_file = '/var/lib/postgresql/server.crt'"
  echo "ssl_key_file = '/var/lib/postgresql/server.key'"
  
} >> /var/lib/postgresql/data/postgres/postgresql.conf

# /ssl/d matches the three settings written above, so every tenant runs with ssl off.
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

chmod 600 /etc/pgbackrest/pgbackrest.conf

# Unit of tcp_keepalives_idle is seconds and idle_session_timeout is milliseconds
exec docker-entrypoint.sh postgres \
          -c archive_mode="${POSTGRES_ARCHIVE_MODE:-on}" \
          -c archive_command="pgbackrest --stanza=n3o archive-push %p" \
          -c wal_level="${POSTGRES_WAL_LEVEL:-replica}" \
          -c max_wal_senders="${POSTGRES_MAX_WAL_SENDERS:-3}" \
          -c max_replication_slots="${POSTGRES_MAX_REPLICATION_SLOTS:-10}" \
          -c logging_collector=on \
          -c log_directory="log" \
          -c log_filename="postgresql-%Y-%m-%d_%H%M%S.log" \
          -c log_rotation_age=1d \
          -c log_rotation_size="${POSTGRES_LOG_ROTATION_SIZE:-0}" \
          -c log_line_prefix="%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h " \
          -c log_min_duration_statement="${POSTGRES_LOG_MIN_DURATION_STATEMENT:-0}" \
          -c log_checkpoints=on \
          -c log_connections=on \
          -c log_disconnections=on \
          -c log_lock_waits=on \
          -c shared_buffers="${POSTGRES_SHARED_BUFFERS}" \
          -c max_connections="${POSTGRES_MAX_CONNECTIONS}" \
          -c work_mem="${POSTGRES_WORK_MEM}" \
          -c tcp_keepalives_idle="${POSTGRES_TCP_KEEPALIVES_IDLE}" \
          -c idle_session_timeout="${POSTGRES_IDLE_SESSION_TIMEOUT}" \
          -c password_encryption=scram-sha-256 &

until pg_isready -U "${POSTGRES_USER}" -d :"${POSTGRES_USER}"; do
  echo "Waiting for Postgres to be ready..."
  sleep 2
done

# Unlogged: ALTER ROLE is not redacted and log/ sits inside PGDATA, which is backed up. The
# superuser is rewritten because docker-entrypoint sets it only at initdb; pgbouncer needs SCRAM.
psql -U "${POSTGRES_USER}" -d postgres -v role="${POSTGRES_USER}" -v su_pw="${POSTGRES_PASSWORD}" <<'EOSQL'
SET log_min_duration_statement = -1;
SET log_statement = 'none';
SET password_encryption = 'scram-sha-256';
ALTER ROLE :"role" PASSWORD :'su_pw';
EOSQL

if [ -n "${AGENT_RO_PASSWORD}" ] && [ -n "${AGENT_RW_PASSWORD}" ]; then
  psql -U "${POSTGRES_USER}" -d postgres -v ro_pw="${AGENT_RO_PASSWORD}" -v rw_pw="${AGENT_RW_PASSWORD}" <<'EOSQL'
SET log_min_duration_statement = -1;
SET log_statement = 'none';
SET password_encryption = 'scram-sha-256';
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'n3o_agent_ro') THEN CREATE ROLE n3o_agent_ro LOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'n3o_agent_rw') THEN CREATE ROLE n3o_agent_rw LOGIN; END IF; END $$;
ALTER ROLE n3o_agent_ro PASSWORD :'ro_pw';
ALTER ROLE n3o_agent_rw PASSWORD :'rw_pw';
GRANT pg_read_all_data TO n3o_agent_ro;
GRANT pg_read_all_data, pg_write_all_data TO n3o_agent_rw;
EOSQL
fi

pg_pid=$!
wait "$pg_pid"
