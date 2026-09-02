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
  # Verified TLS on the trust store the application uses, so the probe cannot
  # pass where the application would fail.
  if php -r '
      $c = mysqli_init();
      mysqli_options($c, MYSQLI_OPT_CONNECT_TIMEOUT, 5);
      mysqli_ssl_set($c, NULL, NULL, NULL, "/etc/ssl/certs", NULL);
      $ok = @mysqli_real_connect($c, getenv("RS_DB_HOST"), getenv("RS_DB_USER"),
                                 getenv("RS_DB_PASSWORD"), getenv("RS_DB_NAME"),
                                 3306, NULL, 0);
      exit($ok ? 0 : 1);
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
# than of whoever last used the admin screens. google_vision is absent: clip
# does the same work locally.
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
' || {
    # Activation cannot succeed before the schema exists, which is the only
    # case where failure is expected.
    if php -r '
        $c = mysqli_init();
        mysqli_ssl_set($c, NULL, NULL, NULL, "/etc/ssl/certs", NULL);
        @mysqli_real_connect($c, getenv("RS_DB_HOST"), getenv("RS_DB_USER"),
                             getenv("RS_DB_PASSWORD"), getenv("RS_DB_NAME"), 3306, NULL, 0);
        exit(@mysqli_query($c, "SELECT 1 FROM resource LIMIT 1") !== false ? 0 : 1);
    '; then
      echo "entrypoint: plugin activation failed on an installed instance" >&2
      exit 1
    fi
    echo "entrypoint: plugins await installation" >&2
  }

# An unresolved tool is silent: previews and metadata simply never appear.
php -r '
    include_once "/var/www/html/include/boot.php";
    $missing = [];
    foreach (["im-convert", "im-identify", "im-mogrify", "ghostscript", "ffmpeg",
              "ffprobe", "exiftool", "pdftotext", "python", "php"] as $utility) {
        if (get_utility_path($utility) === false) { $missing[] = $utility; }
    }
    if ($missing !== []) {
        fwrite(STDERR, "entrypoint: unresolved: " . implode(" ", $missing) . "\n");
        exit(1);
    }
    echo "entrypoint: media tools resolved\n";
' || exit 1

# Foreground, so Apache is the process the platform watches. Scheduled work runs
# as a separate job, which keeps one scheduler however many replicas there are.
echo "entrypoint: starting apache"
exec apachectl -D FOREGROUND
