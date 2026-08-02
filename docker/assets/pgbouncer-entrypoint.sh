#!/bin/bash
set -e
export PATH="$PATH:/usr/sbin"

PG_CONFIG_DIR=/etc/pgbouncer
PG_CONFIG_FILE="${PG_CONFIG_DIR}/pgbouncer.ini"
AUTH_FILE="${PG_CONFIG_DIR}/userlist.txt"

mkdir -p "$PG_CONFIG_DIR"

# No credential is needed here: postgres shares the pod's network namespace and pg_hba grants
# trust on 127.0.0.1.
until pg_isready -h "${HOST}" -p "${PORT}" -U "${POSTGRES_USER}" >/dev/null 2>&1; do
  echo "Waiting for Postgres before reading the SCRAM verifier..."
  sleep 2
done

VERIFIER=$(psql -h "${HOST}" -p "${PORT}" -U "${POSTGRES_USER}" -d postgres -tAc \
  "SELECT rolpassword FROM pg_authid WHERE rolname = current_user")

if [[ "$VERIFIER" != SCRAM-SHA-256\$* ]]; then
  echo "No SCRAM verifier for ${POSTGRES_USER} (got '${VERIFIER:0:16}'); refusing to start." >&2
  exit 1
fi

# Only the admin console reads this; application logins go through auth_query. A verifier cannot
# be replayed into a login, so nothing password-equivalent lands on disk.
umask 077
printf '"%s" "%s"\n' "${POSTGRES_USER}" "${VERIFIER}" > "$AUTH_FILE"

cat > "$PG_CONFIG_FILE" <<EOF
[databases]
* = host=${HOST} port=${PORT} auth_user=${POSTGRES_USER}

[pgbouncer]
listen_addr = ${LISTEN_ADDR}
listen_port = ${LISTEN_PORT}
auth_type = scram-sha-256
auth_file = ${AUTH_FILE}
auth_dbname = postgres
admin_users = ${POSTGRES_USER}
stats_users = ${POSTGRES_USER}
logfile = /dev/stdout
pidfile = /var/run/pgbouncer/pgbouncer.pid
pool_mode = transaction
max_client_conn = ${MAX_CONNECTIONS}
max_db_connections = ${MAX_CONNECTIONS}
max_user_connections = ${MAX_CONNECTIONS}
max_prepared_statements = 100
server_reset_query = DISCARD ALL
server_idle_timeout = ${POSTGRES_IDLE_SESSION_TIMEOUT}
server_fast_close = 1
client_idle_timeout = 300
idle_transaction_timeout = 300
ignore_startup_parameters = extra_float_digits
stats_period = 0
verbose = 0
EOF

exec "$@"
