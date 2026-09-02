#!/bin/bash
#
# Applies N3O's changes to the ResourceSpace CLIP plugin, at build time, against
# the release checked out by docker/resourcespace.
#
# Every required patch asserts that the text it replaces is present exactly once.
# That is the point of this script: when the pinned release moves and upstream has
# edited one of these lines, the build fails here and names the file, rather than
# producing an image where the plugin is quietly unforked. An unforked plugin is
# the worst outcome available -- it starts, serves, and writes 512-dimension
# vectors into a database the service reads as 768.
#
# The service itself is not patched. It is replaced wholesale by
# resourcespace-clip-service.py in the CLIP image, which carries its own notes.

set -euo pipefail

RS_ROOT="${1:?usage: resourcespace-fork.sh <resourcespace root>}"
CLIP="$RS_ROOT/plugins/clip"

# Exact, whole-string replacement that fails unless the original appears exactly
# once. sed is avoided deliberately: these strings carry regex metacharacters and
# PHP sigils, and a sed that silently matches nothing is the failure being guarded
# against.
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

# ---------------------------------------------------------------------------
# Dimensions. SigLIP2 embeds to 768 where the stock model embedded to 512.
# ---------------------------------------------------------------------------

replace "$CLIP/include/clip_functions.php" \
  'count($vector) !== 512' \
  'count($vector) !== 768'

replace "$CLIP/scripts/tagdb_tools/tagdb_build_titles.php" \
  "unpack('f512'" \
  "unpack('f768'"

# ---------------------------------------------------------------------------
# The keyword path drops urldecode where the title path applies it, so an encoded
# multi-word term is stored as the literal "Food%20distribution".
# ---------------------------------------------------------------------------

replace "$CLIP/include/clip_functions.php" \
  'ucfirst($result->tag)' \
  'ucfirst(urldecode($result->tag))'

# ---------------------------------------------------------------------------
# The query prefix was tuned for OpenAI CLIP. SigLIP2 was trained on a different
# distribution, and this is the only quality dial that can be retuned without
# re-embedding the archive, so it belongs in config rather than in a hook.
# ---------------------------------------------------------------------------

replace "$CLIP/hooks/all.php" \
  '$search = "A photo of a " . $search;' \
  '$search = $clip_search_prefix . $search;'

replace "$CLIP/hooks/all.php" \
  'global $clip_search_cutoff,' \
  'global $clip_search_prefix, $clip_search_cutoff,'

cat >> "$CLIP/config/config.php" <<'PHP'

// Prepended to a natural-language query before it is embedded. Tuned for OpenAI
// CLIP upstream; SigLIP2 trained on a different distribution, and this is the one
// retrieval dial that can be changed without re-embedding anything.
$clip_search_prefix = "A photo of a ";
PHP
echo "fork: appended \$clip_search_prefix to config.php"

# ---------------------------------------------------------------------------
# Documentation. Not required: a stale comment is worth a warning, not a failed
# build.
# ---------------------------------------------------------------------------

replace "$CLIP/include/clip_functions.php" \
  'Returns a 512-float array' \
  'Returns a 768-float array' optional

replace "$CLIP/include/clip_functions.php" \
  'A 512-element array of float values' \
  'A 768-element array of float values' optional

replace "$CLIP/include/clip_functions.php" \
  'to obtain a 512-float vector' \
  'to obtain a 768-float vector' optional

echo "fork: complete"
