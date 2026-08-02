#!/bin/bash
set -euo pipefail

OLD_BIN=/usr/lib/postgresql/17/bin
NEW_BIN=/usr/lib/postgresql/18/bin

: "${PGDATA:?PGDATA is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
# pg_controldata stopped reporting locale in 15, and pg_upgrade accepts a mismatch silently, so
# the guard below is the only thing standing between a wrong value and changed lc_* settings.
: "${PG_LOCALE:?PG_LOCALE is required}"
: "${PG_ENCODING:?PG_ENCODING is required}"

NEW="${PGDATA}.new"
RETAINED="${PGDATA}.pg17"

die() { echo "postgres-upgrade: $*" >&2; exit 1; }
control() { $OLD_BIN/pg_controldata -D "$PGDATA" | awk -F': +' -v k="$1" '$0 ~ k {print $2}'; }

# Only an interruption between the two renames produces this, and the new cluster is complete by
# then. Leaving it is the dangerous option: the entrypoint reads an absent PGDATA as a new tenant.
if [ ! -e "$PGDATA" ] && [ -d "$NEW" ] && [ -d "$RETAINED" ]; then
  mv "$NEW" "$PGDATA"
  echo "postgres-upgrade: completed the interrupted rename; $PGDATA is now $(cat "$PGDATA/PG_VERSION")"
  exit 0
fi

[ -f "$PGDATA/PG_VERSION" ] || die "no cluster at $PGDATA"
version=$(cat "$PGDATA/PG_VERSION")
[ "$version" = "17" ] || die "expected a version 17 cluster at $PGDATA, found $version"

# Resolving leftovers is a judgement about which copy holds the tenant's data, never made here.
[ -e "$RETAINED" ] && die "$RETAINED exists; a previous run left state behind"
[ -e "$NEW" ] && die "$NEW exists; a previous run left state behind"

# fsGroup adds group bits on mount; PostgreSQL refuses to start on them.
chmod 0700 "$PGDATA"

state=$(control 'Database cluster state')
[ "$state" = "shut down" ] || die "cluster state is '$state'; pg_upgrade needs a clean shutdown"

old_locale=$(sed -n "s/^lc_monetary = '\([^']*\)'.*/\1/p" "$PGDATA/postgresql.conf" | tail -1)
[ -z "$old_locale" ] || [ "$old_locale" = "$PG_LOCALE" ] \
  || die "PG_LOCALE is '$PG_LOCALE' but the cluster was built with '$old_locale'"

# pg_upgrade copies neither pg_wal nor log; the margin covers the new cluster's own footprint.
used=$(du -sk --exclude=pg_wal --exclude=log "$PGDATA" | cut -f1)
free=$(df -Pk "$(dirname "$PGDATA")" | awk 'NR==2 {print $4}')
[ "$free" -gt $((used * 12 / 10)) ] || die "copy needs ${used}kB plus margin, volume has ${free}kB free"

# 18's initdb turns checksums on and pg_upgrade refuses a mismatch; a stopped cluster is the
# only time they can be enabled.
if [ "$(control 'Data page checksum version')" = "0" ]; then
  echo "postgres-upgrade: enabling data checksums"
  $OLD_BIN/pg_checksums --enable -D "$PGDATA"
fi

# pg_upgrade writes its log inside the new cluster.
salvage() {
  if [ -d "$NEW/pg_upgrade_output.d" ]; then
    rm -rf "${PGDATA}.upgrade-failed"
    mv "$NEW/pg_upgrade_output.d" "${PGDATA}.upgrade-failed" || true
  fi
  rm -rf "$NEW"
}
trap salvage ERR

$NEW_BIN/initdb -D "$NEW" --locale="$PG_LOCALE" --encoding="$PG_ENCODING" -U "$POSTGRES_USER"

# errexit exempts the left of &&, so joining these would skip the trap and reach the renames.
upgrade=("$NEW_BIN/pg_upgrade" --old-bindir="$OLD_BIN" --new-bindir="$NEW_BIN"
         --old-datadir="$PGDATA" --new-datadir="$NEW" --username="$POSTGRES_USER")
"${upgrade[@]}" --check
"${upgrade[@]}"

# initdb writes a narrower pg_hba, and the entrypoint only writes one for a directory it made.
cp "$PGDATA/pg_hba.conf" "$PGDATA/pg_ident.conf" "$NEW/"

trap - ERR

mv "$PGDATA" "$RETAINED"
mv "$NEW" "$PGDATA"

cat <<EOF
postgres-upgrade: $PGDATA is now $(cat "$PGDATA/PG_VERSION"); the previous cluster is at $RETAINED

pg_upgrade assigned a new system identifier, so pgBackRest will reject every WAL segment this
cluster archives until its stanza is repointed. Until that is done there is no PITR and pg_wal
cannot recycle. Once the pod is serving, run against it:

  pgbackrest --stanza=n3o stanza-upgrade
  pgbackrest --stanza=n3o --type=full backup
  pgbackrest --stanza=n3o check
EOF
