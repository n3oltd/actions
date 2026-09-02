#!/bin/bash
#
# Changes to the bundled plugins, applied at build time. Every required patch
# asserts its text is present exactly once, so a release that has edited one of
# these lines fails the build here rather than producing an image whose plugin is
# unforked -- which starts, serves, and writes vectors the service cannot read.

set -euo pipefail

RS_ROOT="${1:?usage: resourcespace-fork.sh <resourcespace root>}"
CLIP="$RS_ROOT/plugins/clip"
SIMPLESAML="$RS_ROOT/plugins/simplesaml"

# sed is avoided: these strings carry regex metacharacters and PHP sigils, and a
# sed that silently matches nothing is the failure being guarded against.
replace() {
  php -r '
    $file = $argv[1]; $from = $argv[2]; $to = $argv[3]; $required = $argv[4] === "required";
    if (!is_file($file)) {
      fwrite(STDERR, "fork: missing file $file\n");
      exit($required ? 1 : 0);
    }
    $src = file_get_contents($file);
    $n = substr_count($src, $from);
    if ($n !== 1) {
      fwrite(STDERR, "fork: found $n occurrences (wanted 1) of\n  $from\nin $file\n");
      exit($required ? 1 : 0);
    }
    file_put_contents($file, str_replace($from, $to, $src));
    fwrite(STDOUT, "fork: patched " . basename($file) . "\n");
  ' "$1" "$2" "$3" "${4:-required}"
}

# SigLIP2 embeds to 768 where the stock model embeds to 512.

replace "$CLIP/include/clip_functions.php" \
  'count($vector) !== 512' \
  'count($vector) !== 768'

replace "$CLIP/scripts/tagdb_tools/tagdb_build_titles.php" \
  "unpack('f512'" \
  "unpack('f768'"

# The keyword path drops the urldecode the title path applies, so an encoded
# multi-word term is stored literally.

replace "$CLIP/include/clip_functions.php" \
  'ucfirst($result->tag)' \
  'ucfirst(urldecode($result->tag))'

# The only retrieval dial that can be retuned without re-embedding the archive,
# so it belongs in config rather than in a hook.

replace "$CLIP/hooks/all.php" \
  '$search = "A photo of a " . $search;' \
  '$search = $clip_search_prefix . $search;'

replace "$CLIP/hooks/all.php" \
  'global $clip_search_cutoff,' \
  'global $clip_search_prefix, $clip_search_cutoff,'

cat >> "$CLIP/config/config.php" <<'PHP'

// Prepended to a natural-language query before it is embedded. The one retrieval
// dial that can be changed without re-embedding the archive.
$clip_search_prefix = "A photo of a ";
PHP
echo "fork: appended \$clip_search_prefix to config.php"

# Optional: a stale comment is worth a warning, not a failed build.

replace "$CLIP/include/clip_functions.php" \
  'Returns a 512-float array' \
  'Returns a 768-float array' optional

replace "$CLIP/include/clip_functions.php" \
  'A 512-element array of float values' \
  'A 768-element array of float values' optional

replace "$CLIP/include/clip_functions.php" \
  'to obtain a 512-float vector' \
  'to obtain a 768-float vector' optional

# Upstream defaults the service provider onto SimpleSAMLphp 1.x's www route so an
# existing deployment need not re-exchange metadata with its provider, and says
# plainly that the web server must then alias www to public. Nothing here does,
# so the asserted entity ID names a path that 404s while the assertion consumer
# service answers under public. A first deployment has no metadata to preserve.
if [ -d "$SIMPLESAML/lib/www" ]; then
  echo "fork: simplesaml now ships lib/www; revisit \$simplesaml_use_www" >&2
  exit 1
fi
test -d "$SIMPLESAML/lib/public"

replace "$SIMPLESAML/config/config.php" \
  '$simplesaml_use_www = true;' \
  '$simplesaml_use_www = false;'

echo "fork: complete"
