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

# A scope configured but not reached is indistinguishable from no scope at all.
if [ -n "${RS_SCOPING_JSON:-}" ]; then
  php -r '
      include "/var/www/html/include/config.php";
      if (!function_exists("GlobalHookHandleuserref")) {
          fwrite(STDERR, "entrypoint: scoping is configured but the hook was not reached\n");
          exit(1);
      }
      echo "entrypoint: scoping hook installed\n";
  ' || exit 1
fi

# The platform terminates TLS at its ingress and forwards here over plain HTTP,
# so the port the server sees is 80 and self-referential URLs it builds carry it.
# SimpleSAMLphp composes the address it returns a user to that way, producing an
# https URL on port 80, which no browser can reach. Naming the canonical port is
# what removes it. The hostname is per-instance, so this cannot be baked.
RS_HOST=$(php -r 'echo parse_url(getenv("RS_BASE_URL"), PHP_URL_HOST) ?: "";')
[ -n "$RS_HOST" ] || { echo "entrypoint: RS_BASE_URL has no host" >&2; exit 1; }
VHOST=/etc/apache2/sites-enabled/000-default.conf
if ! grep -q UseCanonicalName "$VHOST"; then
  sed -i "s|<VirtualHost \*:80>|<VirtualHost *:80>\n\tServerName ${RS_HOST}:443\n\tUseCanonicalName On|" "$VHOST"
fi
grep -q "ServerName ${RS_HOST}:443" "$VHOST" || {
  echo "entrypoint: could not set the canonical server name" >&2; exit 1; }
echo "entrypoint: canonical name ${RS_HOST}:443"

# Mounted, so they exist but may be owned by the mount rather than by Apache.
for dir in /var/www/filestore /var/www/scratch; do
  mkdir -p "$dir"
  chown www-data:www-data "$dir" 2>/dev/null || true
done

php -r '
    $primary = getenv("RS_BRAND_PRIMARY");
    if ($primary === false || $primary === "") { exit(0); }

    $mix = function (string $hex, string $with, float $ratio): string {
        [$r, $g, $b] = sscanf($hex, "#%2x%2x%2x");
        [$R, $G, $B] = sscanf($with, "#%2x%2x%2x");
        return sprintf("#%02x%02x%02x",
            (int) round($r + ($R - $r) * $ratio),
            (int) round($g + ($G - $g) * $ratio),
            (int) round($b + ($B - $b) * $ratio));
    };
    file_put_contents("/var/www/html/plugins/n3o_branding/css/style.css", sprintf(
        ".mode-n3o {\n" .
        "    --colour-brand-primary-default: %s;\n" .
        "    --colour-brand-primary-hover: %s;\n" .
        "    --colour-brand-primary-dark: %s;\n" .
        "    --colour-brand-primary-darkest: %s;\n" .
        "    --colour-brand-primary-light: %s;\n" .
        "    --colour-brand-primary-lightest: %s;\n" .
        "}\n" .
        // The credit on the login page is editable site text upstream, so
        // removing it on a branded instance is a supported choice, not a patch.
        "#login-footer {\n    display: none;\n}\n",
        $primary,
        $mix($primary, "#ffffff", 0.10),
        $mix($primary, "#000000", 0.35),
        $mix($primary, "#000000", 0.65),
        $mix($primary, "#ffffff", 0.85),
        $mix($primary, "#ffffff", 0.93)));

    foreach (["RS_BRAND_LOGO" => "logo.svg", "RS_BRAND_LOGO_DARK" => "logo-dark.svg",
              "RS_BRAND_FAVICON" => "favicon.svg"] as $var => $name) {
        $encoded = getenv($var);
        if ($encoded === false || $encoded === "") { continue; }
        $bytes = base64_decode($encoded, true);
        if ($bytes === false) {
            fwrite(STDERR, "entrypoint: {$var} is not valid base64\n");
            exit(1);
        }
        file_put_contents("/var/www/html/gfx/brand/{$name}", $bytes);
    }
    echo "entrypoint: branding rendered\n";
' || exit 1

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

# A plugin's own config is loaded after include/config.php and wins, so settings
# it declares reach it only through the plugins table.
php -r '
    include_once "/var/www/html/include/boot.php";
    foreach ($GLOBALS["n3o_plugin_config"] ?? [] as $plugin => $config) {
        if (!is_plugin_activated($plugin)) {
            echo "entrypoint: {$plugin} not active, config not written\n";
            continue;
        }
        set_plugin_config($plugin, $config);
        echo "entrypoint: {$plugin} config written\n";
    }
' || {
    if php -r '
        $c = mysqli_init();
        mysqli_ssl_set($c, NULL, NULL, NULL, "/etc/ssl/certs", NULL);
        @mysqli_real_connect($c, getenv("RS_DB_HOST"), getenv("RS_DB_USER"),
                             getenv("RS_DB_PASSWORD"), getenv("RS_DB_NAME"), 3306, NULL, 0);
        exit(@mysqli_query($c, "SELECT 1 FROM plugins LIMIT 1") !== false ? 0 : 1);
    '; then
      echo "entrypoint: plugin config failed on an installed instance" >&2
      exit 1
    fi
    echo "entrypoint: plugin config awaits installation" >&2
  }

php -r '
    $required = ["mysqli", "curl", "dom", "gd", "intl", "mbstring", "xml",
                 "zip", "ldap", "imap", "json", "apcu"];
    $missing = array_values(array_filter($required, fn($e) => !extension_loaded($e)));
    if ($missing !== []) {
        fwrite(STDERR, "entrypoint: missing php extensions: " . implode(" ", $missing) . "\n");
        exit(1);
    }
    echo "entrypoint: php extensions present\n";
' || exit 1

# An unresolved tool is silent: previews and metadata simply never appear.
php -r '
    include_once "/var/www/html/include/boot.php";
    $missing = [];
    foreach (["im-convert", "im-identify", "im-mogrify", "ghostscript", "ffmpeg",
              "ffprobe", "exiftool", "pdftotext", "python", "php",
              "unoconv"] as $utility) {
        if (get_utility_path($utility) === false) { $missing[] = $utility; }
    }
    if (!file_exists($GLOBALS["mysql_bin_path"] . "/mysqldump")) {
        $missing[] = "mysqldump";
    }
    if (trim((string) shell_exec("command -v inkscape")) === "") {
        $missing[] = "inkscape";
    }
    if ($missing !== []) {
        fwrite(STDERR, "entrypoint: unresolved: " . implode(" ", $missing) . "\n");
        exit(1);
    }
    echo "entrypoint: media tools resolved\n";
' || exit 1

# Usergroup 3 and the hash form are what setup.php uses. Reset every start, so
# the vault remains the only place the password is written down.
php -r '
    include_once "/var/www/html/include/boot.php";
    $user = "n3o-support";
    $installed = ps_value(
        "SELECT COUNT(*) value FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ?", ["s", "user"], 0);
    if (!$installed) {
        echo "entrypoint: support account awaits installation\n";
        exit(0);
    }
    $hash = rs_password_hash("RS{$user}" . getenv("RS_SUPPORT_PASSWORD"));
    if (ps_value("SELECT COUNT(*) value FROM user WHERE username = ?", ["s", $user], 0) == 0) {
        ps_query(
            "INSERT INTO user (username, password, fullname, email, usergroup)
             VALUES (?, ?, ?, ?, 3)",
            ["s", $user, "s", $hash, "s", "N3O Support", "s", "support@n3o.cloud"]);
        echo "entrypoint: {$user} created\n";
    } else {
        ps_query("UPDATE user SET password = ? WHERE username = ?", ["s", $hash, "s", $user]);
        echo "entrypoint: {$user} password reset\n";
    }
' || exit 1

# Foreground, so Apache is the process the platform watches. Scheduled work runs
# as a separate job, which keeps one scheduler however many replicas there are.
echo "entrypoint: starting apache"
exec apachectl -D FOREGROUND
