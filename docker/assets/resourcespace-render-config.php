<?php
/**
 * Renders include/config.php from the environment, to stdout.
 *
 * Values are emitted with var_export rather than interpolated: a generated
 * password holding a dollar sign, a quote or a backslash would otherwise produce
 * a syntax error at the first request.
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

function setting(string $name, $value): void
{
    echo '$' . $name . ' = ' . var_export($value, true) . ";\n";
}

echo "<?php\n";
echo "// Generated at container start by resourcespace-render-config.php.\n";
echo "// Edits here are lost on the next restart; change the app definition instead.\n\n";

setting('baseurl', rtrim(env_required('RS_BASE_URL'), '/'));
setting('applicationname', env_required('RS_APPLICATION_NAME'));

if (env_optional('RS_BRAND_PRIMARY') !== '') {
    setting('colour_theme', 'n3o');
    setting('plugins', ['n3o_branding']);
    if (env_optional('RS_BRAND_LOGO') !== '') {
        setting('linkedheaderimgsrc', '/gfx/brand/logo.svg');
        // A wordmark drawn for a dark header is unreadable on a light page, so
        // the two are separate files and the same one only when there is one.
        setting('linkedheaderimgsrc_dark', env_optional('RS_BRAND_LOGO_DARK') !== ''
            ? '/gfx/brand/logo-dark.svg'
            : '/gfx/brand/logo.svg');
    }
    if (env_optional('RS_BRAND_FAVICON') !== '') {
        setting('header_favicon', 'gfx/brand/favicon.svg');
    }
}

setting('mysql_server', env_required('RS_DB_HOST'));
setting('mysql_username', env_required('RS_DB_USER'));
setting('mysql_password', env_required('RS_DB_PASSWORD'));
setting('mysql_db', env_required('RS_DB_NAME'));

// The CA path is load-bearing: mysqli_ssl_set() is a no-op without a trust
// store, and the server refuses plaintext.
setting('use_mysqli_ssl', true);
setting('mysqli_ssl_ca_path', '/etc/ssl/certs');

// config.default.php declares none of these, and an unset path resolves to false.
setting('imagemagick_path', '/usr/bin');
setting('ghostscript_path', '/usr/bin');
setting('ghostscript_executable', 'gs');
setting('ffmpeg_path', '/usr/bin');
setting('exiftool_path', '/usr/bin');
setting('pdftotext_path', '/usr/bin');
setting('python_path', '/usr/bin');
setting('php_path', '/usr/bin');
setting('unoconv_path', '/usr/bin');

setting('collection_download', true);
setting('use_zip_extension', true);

// Where a provider creates accounts, asking for one is a dead end for whoever
// follows the link and a queue nobody is watching for whoever does not.
setting('allow_account_request', env_optional('RS_SAML_METADATA_URL') === '');

// Without both of these ResourceSpace calls mail(), and there is no MTA here.
setting('use_smtp', true);
setting('use_phpmailer', true);
setting('smtp_secure', 'tls');
setting('smtp_host', env_required('RS_SMTP_HOST'));
setting('smtp_port', (int) env_required('RS_SMTP_PORT'));
setting('smtp_auth', true);
setting('smtp_username', env_required('RS_SMTP_USERNAME'));
setting('smtp_password', env_required('RS_SMTP_PASSWORD'));

setting('email_from', env_required('RS_EMAIL_FROM'));
setting('email_notify', env_required('RS_EMAIL_NOTIFY'));

setting('scramble_key', env_required('RS_SCRAMBLE_KEY'));
setting('api_scramble_key', env_required('RS_API_SCRAMBLE_KEY'));

// Identical on every instance. Scratch is a share rather than local disk because
// transcoding writes more than a container's ephemeral storage holds.
setting('storagedir', '/var/www/filestore');
setting('originals_separate_storage', true);
setting('originals_separate_storage_ffmpegalts_as_previews', true);
setting('tempdir', '/var/www/scratch');

setting('clip_service_url', env_required('RS_CLIP_SERVICE_URL'));

// Zero keeps tagging off until the fields to write into exist.
setting('clip_keyword_field', (int) env_optional('RS_CLIP_KEYWORD_FIELD', '0'));
setting('clip_title_field', (int) env_optional('RS_CLIP_TITLE_FIELD', '0'));

// The plugin's own config/config.php is loaded after this file and copies its
// variables to global scope, so anything it declares cannot be set from here.
// These go to the plugins table instead, which include_plugin_config() applies
// last, and the entrypoint writes from the array emitted below.
//
// No second factor here, so a reachable login page is a password-only route
// into the archive. Absent an identity provider it has to stay reachable.
$metadata_url = env_optional('RS_SAML_METADATA_URL');
$allow_standard_login = env_bool('RS_ALLOW_STANDARD_LOGIN', $metadata_url === '');

if ($metadata_url === '') {
    $simplesaml = [
        'simplesaml_login' => false,
        'simplesaml_allow_standard_login' => true,
    ];
} else {
    $group_map = json_decode(env_optional('RS_SAML_GROUP_MAP', '[]'), true);
    if (!is_array($group_map)) {
        fwrite(STDERR, "config: RS_SAML_GROUP_MAP is not valid JSON\n");
        exit(1);
    }

    $attributes = json_decode(env_optional('RS_SAML_ATTRIBUTES', '{}'), true);
    if (!is_array($attributes)) {
        fwrite(STDERR, "config: RS_SAML_ATTRIBUTES is not valid JSON\n");
        exit(1);
    }

    $simplesaml = [
        'simplesaml_login' => true,
        'simplesaml_allow_standard_login' => $allow_standard_login,

        // Upstream defaults this true, which offers the login form instead of
        // the provider and never starts single sign-on at all.
        'simplesaml_prefer_standard_login' => false,
        'simplesaml_site_block' => false,

        // Enabling this lets anyone whose provider asserts the N3O support
        // account's email address adopt it, a direct path to administrator.
        'simplesaml_create_new_match_email' => false,
        'simplesaml_allow_duplicate_email' => false,

        // Upstream defaults this false, which strands every user in the group
        // they first landed in.
        'simplesaml_update_group' => true,

        // 2 reads the provider's metadata from its published URL.
        'simplesaml_rsconfig' => 2,
        'simplesaml_metadata_url' => $metadata_url,
        'simplesaml_check_idp_cert_expiry' => true,

        // A provider names its claims what it likes, and the plugin matches on
        // the exact name: one that is wrong yields an account with no username,
        // no address and no groups rather than an error.
        'simplesaml_username_attribute' => $attributes['username'] ?? 'uid',
        'simplesaml_fullname_attribute' => $attributes['fullname'] ?? 'cn',
        'simplesaml_email_attribute' => $attributes['email'] ?? 'mail',
        'simplesaml_group_attribute' => $attributes['groups'] ?? 'groups',
        'simplesaml_fallback_group' => (int) env_required('RS_SAML_FALLBACK_GROUP'),
        'simplesaml_groupmap' => $group_map,

        // Share links go to people with no account at the provider, so they
        // have to survive the absent login page.
        'simplesaml_allow_public_shares' => true,
    ];

    // Checked before a user is created, so somebody outside the entitlement
    // gets no account rather than a restricted one. The provider's own
    // assignment check cannot serve here: it does not traverse nested groups,
    // and claims do.
    $entitlement = env_optional('RS_SAML_ENTITLEMENT');
    if ($entitlement !== '') {
        $simplesaml['simplesaml_authorisation_claim_name'] =
            $simplesaml['simplesaml_group_attribute'];
        $simplesaml['simplesaml_authorisation_claim_value'] = $entitlement;
    }

    // Not declared by the plugin, so these survive here, and a private key is
    // better left in a file rendered from the vault than written to the database.
    $sp_cert = env_optional('RS_SAML_SP_CERT');
    $sp_key  = env_optional('RS_SAML_SP_KEY');
    if ($sp_cert !== '' && $sp_key !== '') {
        setting('simplesaml_sp_certificate', $sp_cert);
        setting('simplesaml_sp_private_key', $sp_key);
    }
}

setting('n3o_plugin_config', ['simplesaml' => $simplesaml]);

$scoping_json = env_optional('RS_SCOPING_JSON');
if ($scoping_json !== '') {
    $scoping = json_decode($scoping_json, true);
    if (!is_array($scoping)) {
        fwrite(STDERR, "config: RS_SCOPING_JSON is not valid JSON\n");
        exit(1);
    }
    if (isset($scoping['field'], $scoping['shared'], $scoping['offices'])) {
        setting('n3o_scoping', $scoping);
        echo "require_once '/usr/local/lib/resourcespace-scoping.php';\n";
    }
}
