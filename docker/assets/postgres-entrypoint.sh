#!/bin/bash

WATERMARK_FILE="/var/lib/postgresql/data/postgres"

if [ ! -f "$WATERMARK_FILE" ]; then

    #Enable archiving
    echo "archive_mode = on" >> /var/lib/postgresql/data/postgres/postgresql.conf
    echo "archive_command = 'pgbackrest --stanza=n3o archive-push %p'" >> /var/lib/postgresql/data/postgres/postgresql.conf
    echo "wal_level = replica" >> /var/lib/postgresql/data/postgres/postgresql.conf
    echo "max_wal_senders = 3" >> /var/lib/postgresql/data/postgres/postgresql.conf

    #Add SSL certificate and key
    echo "${SSL_CERTIFICATE}" > /var/lib/postgresql/server.crt
    echo "${SSL_KEY}" > /var/lib/postgresql/server.key
    
    chown postgres:postgres /var/lib/postgresql/server.key
    chmod 600 /var/lib/postgresql/server.key

    #get hba config
    cp /etc/postgres_config/pg_hba.conf  /var/lib/postgresql/data/postgres/pg_hba.conf

    # Enable SSL
    echo "ssl = on" >> /var/lib/postgresql/data/postgres/postgresql.conf
    echo "ssl_cert_file = '/var/lib/postgresql/server.crt'" >> /var/lib/postgresql/data/postgres/postgresql.conf
    echo "ssl_key_file = '/var/lib/postgresql/server.key'" >> /var/lib/postgresql/data/postgres/postgresql.conf

    #pgbackrest config file
    echo "[n3o]" >> /etc/pgbackrest/pgbackrest.conf
    echo "pg1-path = /var/lib/postgresql/data" >> /etc/pgbackrest/pgbackrest.conf

    echo "[global]" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-retention-full-type=time" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-retention-full=90" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-retention-diff=2" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-cipher-pass=${BACKUPS_PASSWORD}" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-cipher-type=aes-256-cbc" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-path=/var/lib/pgbackrest/data/backup-repo" >> /etc/pgbackrest/pgbackrest.conf

    echo "repo1-azure-account=${AZURE_ACCOUNT}" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-azure-container=${AZURE_CONTAINER}" >> /etc/pgbackrest/pgbackrest.conf
    echo "repo1-azure-key=${AZURE_KEY}" >> /etc/pgbackrest/pgbackrest.conf

    echo "repo1-type=azure" >> /etc/pgbackrest/pgbackrest.conf
    echo "process-max=4" >> /etc/pgbackrest/pgbackrest.conf

    docker-entrypoint.sh postgres -c shared_buffers=256MB -c max_connections=200 &
    sleep 10

    pg_ctl reload -D /var/lib/postgresql/data

    pgbackrest --stanza=n3o --log-level-console=info stanza-create

    echo "0 3 * * 0 postgres pgbackrest --stanza=n3o backup --type=full" >> /etc/crontab
    echo "0 3 * * 1-6 postgres pgbackrest --stanza=n3o backup --type=diff" >> /etc/crontab

    # Create watermark file
    mkdir -p /var/lib/postgresql/data/postgres
    touch "$WATERMARK_FILE"

    # Start cron daemon
    cron
    
    # Login as su user
    su - postgres

else
    docker-entrypoint.sh postgres -c shared_buffers=256MB -c max_connections=200 &
fi

tail -f /dev/null
