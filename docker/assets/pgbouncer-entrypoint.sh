#!/bin/bash
set -e
export PATH="$PATH:/usr/sbin"

PG_CONFIG_DIR=/etc/pgbouncer
PG_CONFIG_FILE="${PG_CONFIG_DIR}/pgbouncer.ini"
AUTH_FILE="${PG_CONFIG_DIR}/userlist.txt"

mkdir -p "$PG_CONFIG_DIR"
touch "$AUTH_FILE"

if ! grep -q "^\"${POSTGRES_USER}\"" "$AUTH_FILE"; then
    HASH="md5$(echo -n "${POSTGRES_PASSWORD}${POSTGRES_USER}" | md5sum | awk '{print $1}')"
  echo "\"${POSTGRES_USER}\" \"$HASH\"" >> "$AUTH_FILE"
fi

cat > "$PG_CONFIG_FILE" <<EOF
[databases]
* = host=${HOST} port=${PORT} auth_user=${POSTGRES_USER}

[pgbouncer]
listen_addr = ${LISTEN_ADDR}
listen_port = ${LISTEN_PORT}
auth_type = md5
auth_file = ${AUTH_FILE}
admin_users = ${POSTGRES_USER}
stats_users = ${POSTGRES_USER}
listen_port = 6432                             
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
logfile = /dev/stdout
pidfile = /var/run/pgbouncer/pgbouncer.pid
pool_mode = transaction
max_db_connections = ${MAX_CONNECTIONS}
max_user_connections = ${MAX_CONNECTIONS}
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
