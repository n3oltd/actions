#!/bin/bash
#
# Container start for ResourceSpace. Renders the configuration from the
# environment, brings the plugin set to where it should be, and hands off to
# Apache in the foreground.
#
# Everything here is idempotent: a container that restarts for any reason runs
# all of it again, against a database that already exists.

set -euo pipefail

RS_HOME=/var/www/html

# ---------------------------------------------------------------------------
# Configuration. Written on every start, so the app definition is the only place
# a value is ever changed, and a running container cannot drift from it.
# ---------------------------------------------------------------------------
echo "entrypoint: rendering config.php"
php /usr/local/bin/resourcespace-render-config.php > "$RS_HOME/include/config.php"
php -l "$RS_HOME/include/config.php" > /dev/null

# ---------------------------------------------------------------------------
# The filestore and scratch directories are mounted, so they exist but may be
# owned by the mount rather than by Apache.
# ---------------------------------------------------------------------------
for dir in /var/www/filestore /var/www/scratch; do
  mkdir -p "$dir"
  chown www-data:www-data "$dir" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# Wait for the database. Azure Database for MySQL is a separate resource and may
# still be accepting its first connections while this container starts. Bounded,
# so a genuinely unreachable database fails the container rather than hanging a
# revision indefinitely.
# ---------------------------------------------------------------------------
echo "entrypoint: waiting for the database"
for attempt in $(seq 1 60); do
  if php -r '
      $c = @mysqli_connect(getenv("RS_DB_HOST"), getenv("RS_DB_USER"),
                           getenv("RS_DB_PASSWORD"), getenv("RS_DB_NAME"));
      exit($c ? 0 : 1);
  '; then
    echo "entrypoint: database reachable after ${attempt} attempt(s)"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "entrypoint: database unreachable after 60 attempts" >&2
    exit 1
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# Plugins. Activated on every start and skipped where already active, so the set
# is a property of the image rather than of whoever last used the admin screens.
#
# google_vision is deliberately absent: the clip plugin does the same job against
# a local model, which keeps a charity's assets inside their own tenant and off a
# per-image billing meter. openai_gpt is opt-in per charity and arrives as an
# environment variable rather than being activated here by default.
#
# On a fresh instance the schema does not exist until ResourceSpace's own setup
# has run, so failure here is reported and not fatal; the next start picks it up.
# ---------------------------------------------------------------------------
PLUGINS="clip simplesaml whisper csv_upload themes"
if [ "${RS_ENABLE_OPENAI_GPT:-false}" = "true" ]; then
  PLUGINS="$PLUGINS openai_gpt"
fi

echo "entrypoint: activating plugins: $PLUGINS"
RS_PLUGINS="$PLUGINS" php -r '
    include_once "/var/www/html/include/boot.php";
    foreach (preg_split("/\s+/", trim(getenv("RS_PLUGINS"))) as $plugin) {
        if ($plugin === "") { continue; }
        if (is_plugin_activated($plugin)) {
            echo "entrypoint: plugin {$plugin} already active\n";
            continue;
        }
        activate_plugin($plugin);
        echo "entrypoint: plugin {$plugin} activated\n";
    }
' || echo "entrypoint: plugin activation skipped (database not yet installed)" >&2

# ---------------------------------------------------------------------------
# Apache, in the foreground, so it is the process the platform watches.
#
# Scheduled work is not started here. It runs as a separate Container Apps Job on
# this same image with the command overridden, which keeps one scheduler for the
# instance however many web replicas are running.
# ---------------------------------------------------------------------------
echo "entrypoint: starting apache"
exec apachectl -D FOREGROUND
