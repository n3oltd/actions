<?php
/**
 * Renders ResourceSpace's include/config.php from the environment, at container
 * start. Writes to stdout; the entrypoint redirects it into place.
 *
 * Values are emitted with var_export rather than interpolated, so a password
 * holding a dollar sign, a quote or a backslash produces a correct config file
 * instead of a syntax error at the first request.
 *
 * Nothing charity-specific is baked into the image. Anything that varies between
 * instances arrives here as an environment variable, and anything identical
 * everywhere is a literal below.
 */

function env_required(string $name): string
{
    $value = getenv($name);
    if ($value === false || $value === '') {
        fwrite(STDERR, "config: $name must be set\n");
        exit(1);
    }
    return $value;
}

function env_optional(string $name, string $default = ''): string
{
    $value = getenv($name);
    return ($value === false) ? $default : $value;
}

function env_bool(string $name, bool $default): bool
{
    $value = getenv($name);
    if ($value === false || $value === '') {
        return $default;
    }
    return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
}

/** Emits `$name = <value>;` with the value as valid PHP. */
function setting(string $name, $value): void
{
    echo '$' . $name . ' = ' . var_export($value, true) . ";\n";
}

echo "<?php\n";
echo "// Generated at container start by resourcespace-render-config.php.\n";
echo "// Edits here are lost on the next restart; change the app definition instead.\n\n";

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------
setting('baseurl', rtrim(env_required('RS_BASE_URL'), '/'));

setting('mysql_server', env_required('RS_DB_HOST'));
setting('mysql_username', env_required('RS_DB_USER'));
setting('mysql_password', env_required('RS_DB_PASSWORD'));
setting('mysql_db', env_required('RS_DB_NAME'));

// Azure Database for MySQL requires TLS and presents a public CA, which the
// mysqlnd default trust store already carries.
setting('mysql_force_ssl', true);

setting('scramble_key', env_required('RS_SCRAMBLE_KEY'));
setting('api_scramble_key', env_required('RS_API_SCRAMBLE_KEY'));

// ---------------------------------------------------------------------------
// Storage. Identical on every instance: originals and previews are separate
// shares so each can sit on the storage tier its access pattern deserves, and
// scratch is a third share because preview generation and transcoding write far
// more than a container's ephemeral disk will hold.
// ---------------------------------------------------------------------------
setting('storagedir', '/var/www/filestore');
setting('originals_separate_storage', true);
setting('originals_separate_storage_ffmpegalts_as_previews', true);
setting('tempdir', '/var/www/scratch');

// ---------------------------------------------------------------------------
// CLIP. The service is a separate container reached over the environment's
// internal ingress; the field ids stay 0, and tagging stays off, until the
// charity has created the fields to write into.
// ---------------------------------------------------------------------------
setting('clip_service_url', env_required('RS_CLIP_SERVICE_URL'));
setting('clip_keyword_field', (int) env_optional('RS_CLIP_KEYWORD_FIELD', '0'));
setting('clip_title_field', (int) env_optional('RS_CLIP_TITLE_FIELD', '0'));

// ---------------------------------------------------------------------------
// Identity.
//
// The login page is absent in steady state: RS_ALLOW_STANDARD_LOGIN is false and
// every sign-in goes through the charity's own identity provider. ResourceSpace
// has no second factor of its own, so a reachable login page is a password-only
// door onto the whole archive. Opening it is a deployment, not a setting.
//
// Until the metadata URL is supplied the instance has no identity provider, and
// standard login must be on or nobody can reach it at all.
// ---------------------------------------------------------------------------
$metadata_url = env_optional('RS_SAML_METADATA_URL');
$allow_standard_login = env_bool('RS_ALLOW_STANDARD_LOGIN', $metadata_url === '');

if ($metadata_url === '') {
    setting('simplesaml_login', false);
    setting('simplesaml_allow_standard_login', true);
} else {
    setting('simplesaml_login', true);
    setting('simplesaml_allow_standard_login', $allow_standard_login);

    // Never prefer the local form, and never block the site outright.
    setting('simplesaml_prefer_standard_login', false);
    setting('simplesaml_site_block', false);

    // The one setting that must never change. Turning it on lets anyone whose
    // identity provider asserts the break-glass account's email address adopt
    // that account, which is a direct path to administrator.
    setting('simplesaml_create_new_match_email', false);
    setting('simplesaml_allow_duplicate_email', false);

    // Defaults to false upstream, which silently strands every user in whatever
    // group they first landed in and breaks group administration by the charity.
    setting('simplesaml_update_group', true);

    // 2: read the identity provider's metadata from its published URL.
    setting('simplesaml_rsconfig', 2);
    setting('simplesaml_idp_metadata_url', $metadata_url);
    setting('simplesaml_check_idp_cert_expiry', true);

    setting('simplesaml_group_attribute', env_optional('RS_SAML_GROUP_ATTRIBUTE', 'groups'));
    setting('simplesaml_fallback_group', env_required('RS_SAML_FALLBACK_GROUP'));

    // Carried as JSON because the setting is an array of arrays, which no scalar
    // environment variable can express, and inventing a second configuration
    // channel for one value is worse than decoding it here.
    $group_map_json = env_optional('RS_SAML_GROUP_MAP', '{}');
    $group_map = json_decode($group_map_json, true);
    if (!is_array($group_map)) {
        fwrite(STDERR, "config: RS_SAML_GROUP_MAP is not valid JSON\n");
        exit(1);
    }
    setting('simplesaml_groupmap', $group_map);

    // External share links are issued to people who will never have an account
    // with the charity's identity provider, so they must survive the absent
    // login page.
    setting('simplesaml_allow_public_shares', true);

    $sp_cert = env_optional('RS_SAML_SP_CERT');
    $sp_key  = env_optional('RS_SAML_SP_KEY');
    if ($sp_cert !== '' && $sp_key !== '') {
        setting('simplesaml_sp_certificate', $sp_cert);
        setting('simplesaml_sp_private_key', $sp_key);
    }
}
