#!/bin/bash
set -euo pipefail

OLD_BIN=/usr/lib/postgresql/17/bin
NEW_BIN=/usr/lib/postgresql/18/bin

: "${PGDATA:?PGDATA is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
# Read from the running cluster before it is stopped; pg_controldata stopped reporting locale in
# 15, and pg_upgrade rejects a new cluster whose locale does not match the old one.
: "${PG_LOCALE:?PG_LOCALE is required}"
: "${PG_ENCODING:?PG_ENCODING is required}"

NEW="${PGDATA}.new"
RETAINED="${PGDATA}.pg17"

die() { echo "postgres-upgrade: $*" >&2; exit 1; }
control() { $OLD_BIN/pg_controldata -D "$PGDATA" | awk -F': +' -v k="$1" '$0 ~ k {print $2}'; }

[ -f "$PGDATA/PG_VERSION" ] || die "no cluster at $PGDATA"
version=$(cat "$PGDATA/PG_VERSION")
[ "$version" = "17" ] || die "expected a version 17 cluster at $PGDATA, found $version"

# Leftovers mean a previous run stopped partway. Resolving that is a judgement about which copy
# holds the tenant's data, so it is never made here.
[ -e "$RETAINED" ] && die "$RETAINED exists; a previous run left state behind"
[ -e "$NEW" ] && die "$NEW exists; a previous run left state behind"

state=$(control 'Database cluster state')
[ "$state" = "shut down" ] || die "cluster state is '$state'; pg_upgrade needs a clean shutdown"

used=$(du -sk "$PGDATA" | cut -f1)
free=$(df -Pk "$(dirname "$PGDATA")" | awk 'NR==2 {print $4}')
[ "$free" -gt "$used" ] || die "copy needs ${used}kB, volume has ${free}kB free"

# 18 initdb turns checksums on and pg_upgrade refuses a mismatch. Enabling them on the old
# cluster rather than disabling them on the new is the direction that gains something, and the
# cluster is already stopped, which is the only time it can be done.
if [ "$(control 'Data page checksum version')" = "0" ]; then
  echo "postgres-upgrade: enabling data checksums"
  $OLD_BIN/pg_checksums --enable -D "$PGDATA"
fi

trap 'rm -rf "$NEW"' ERR

$NEW_BIN/initdb -D "$NEW" --locale="$PG_LOCALE" --encoding="$PG_ENCODING" -U "$POSTGRES_USER"

cd /tmp
for phase in --check ''; do
  $NEW_BIN/pg_upgrade --old-bindir="$OLD_BIN" --new-bindir="$NEW_BIN" \
                      --old-datadir="$PGDATA" --new-datadir="$NEW" \
                      --username="$POSTGRES_USER" ${phase}
done

# initdb writes a narrower pg_hba than the image entrypoint does, and the entrypoint only writes
# one for a data directory it created, so an upgraded cluster would silently stop accepting
# anything but loopback.
cp "$PGDATA/pg_hba.conf" "$PGDATA/pg_ident.conf" "$NEW/"

trap - ERR

mv "$PGDATA" "$RETAINED"
mv "$NEW" "$PGDATA"

echo "postgres-upgrade: $PGDATA is now $(cat "$PGDATA/PG_VERSION"); the previous cluster is at $RETAINED"
