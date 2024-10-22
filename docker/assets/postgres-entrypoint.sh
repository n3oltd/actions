#!/bin/bash

docker-entrypoint.sh postgres -c shared_buffers=256MB -c max_connections=200 &

sleep 10

echo "archive_mode = on" >> /var/lib/postgresql/data/postgresql.conf
echo "archive_command = 'pgbackrest --stanza=DataServer archive-push %p'" >> /var/lib/postgresql/data/postgresql.conf
echo "wal_level = replica" >> /var/lib/postgresql/data/postgresql.conf
echo "max_wal_senders = 3" >> /var/lib/postgresql/data/postgresql.conf

pg_ctl reload -D /var/lib/postgresql/data

pgbackrest --stanza=DataServer --log-level-console=info stanza-create

echo "0 3 * * 0 postgres pgbackrest --stanza=DataServer backup --type=full" >> /etc/crontab
echo "0 3 * * 1-6 postgres pgbackrest --stanza=DataServer backup --type=diff" >> /etc/crontab

tail -f /dev/null
