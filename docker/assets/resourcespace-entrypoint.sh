#!/bin/bash
#
# Everything here is idempotent: a restart runs all of it again against a database
# that already exists.

set -euo pipefail

RS_HOME=/var/www/html

# Written on every start, so a running container cannot drift from the app
# definition.
echo "entrypoint: rendering config.php"
php /usr/local/bin/resourcespace-render-config.php > "$RS_HOME/include/config.php"
php -l "$RS_HOME/include/config.php" > /dev/null

# Mounted, so they exist but may be owned by the mount rather than by Apache.
for dir in /var/www/filestore /var/www/scratch; do
  mkdir -p "$dir"
  chown www-data:www-data "$dir" 2>/dev/null || true
done

# Bounded, so an unreachable database fails the container rather than hanging a
# revision indefinitely.
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

# Activated on every start, so the plugin set is a property of the image rather
# than of whoever last used the admin screens. google_vision is absent because
# clip does the same work against a local model, keeping assets in the tenant.
# Failure is not fatal: on a fresh instance the schema does not exist yet.
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

# Foreground, so Apache is the process the platform watches. Scheduled work runs
# as a separate job, which keeps one scheduler however many replicas there are.
echo "entrypoint: starting apache"
exec apachectl -D FOREGROUND
