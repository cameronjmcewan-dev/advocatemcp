<?php
/**
 * Plugin Name:  Advocate Agent
 * Plugin URI:   https://app.advocatemcp.com
 * Description:  Connects your business to the Advocate AI agent registry. AI crawlers discover your dedicated agent via /.well-known/mcp.json on your own domain.
 * Version:      1.0.0
 * Author:       Advocate
 * Author URI:   https://app.advocatemcp.com
 * License:      GPL-2.0-or-later
 * Text Domain:  advocate-agent
 */

defined( 'ABSPATH' ) || exit;

define( 'ADVOCATE_OPTION', 'advocate_agent_settings' );

// Central Advocate app that serves per-business LocalBusiness JSON-LD. The
// agent query URL a customer pastes can point anywhere; this structured-data
// API lives on one fixed host, so it is named once here.
define( 'ADVOCATE_APP_BASE', 'https://app.advocatemcp.com' );

// ---------------------------------------------------------------------------
// Activation / Deactivation
// ---------------------------------------------------------------------------

register_activation_hook( __FILE__, function () {
    advocate_add_rewrite_rule();
    flush_rewrite_rules();
} );

register_deactivation_hook( __FILE__, function () {
    flush_rewrite_rules();
} );

// ---------------------------------------------------------------------------
// Rewrite Rule — maps /.well-known/mcp.json → index.php?advocate_mcp=1
// ---------------------------------------------------------------------------

function advocate_add_rewrite_rule() {
    add_rewrite_rule( '^\.well-known/mcp\.json$', 'index.php?advocate_mcp=1', 'top' );
    add_rewrite_tag( '%advocate_mcp%', '([0-9]+)' );
}
add_action( 'init', 'advocate_add_rewrite_rule' );

// ---------------------------------------------------------------------------
// Serve the JSON
// ---------------------------------------------------------------------------

add_action( 'template_redirect', function () {
    if ( ! get_query_var( 'advocate_mcp' ) ) {
        return;
    }

    $settings      = get_option( ADVOCATE_OPTION, [] );
    $agent_url     = trim( $settings['agent_url'] ?? '' );
    $agent_id      = trim( $settings['agent_id'] ?? '' );
    $business_name = trim( $settings['business_name'] ?? '' ) ?: get_bloginfo( 'name' );

    if ( ! $agent_url ) {
        status_header( 503 );
        header( 'Content-Type: application/json; charset=utf-8' );
        echo wp_json_encode( [
            'error' => 'Advocate Agent plugin not configured. Visit Settings > Advocate Agent to add your agent URL.',
        ] );
        exit;
    }

    // Derive registry base URL and agent_id from the supplied agent_url
    $parsed   = wp_parse_url( $agent_url );
    $registry = ( $parsed['scheme'] ?? 'https' ) . '://' . ( $parsed['host'] ?? '' );

    // If agent_id wasn't entered manually, infer it from the URL path tail
    if ( ! $agent_id ) {
        $agent_id = basename( rtrim( $parsed['path'] ?? '', '/' ) );
    }

    $payload = [
        'schema_version' => '1.0',
        'name'           => $business_name,
        'description'    => sprintf(
            '%s is represented by an Advocate AI agent. Query the agent for pricing, availability, credentials, and a match assessment.',
            $business_name
        ),
        'advocate_agent' => [
            'registry'      => $registry,
            'agent_id'      => $agent_id,
            'query_url'     => $agent_url,
            'agent_card_url' => rtrim( $registry, '/' ) . '/agents/' . $agent_id . '/card',
            'verify_url'    => rtrim( $registry, '/' ) . '/verify/' . $agent_id,
        ],
        'tools' => [
            [
                'name'        => 'query',
                'description' => sprintf( 'Query the %s advocate agent. Returns pricing, availability, credentials, and match assessment.', $business_name ),
                'url'         => $agent_url,
                'method'      => 'GET',
                'params'      => [ 'q' => 'natural language query', 'location' => 'optional city/state' ],
            ],
        ],
        'source_domain' => wp_parse_url( home_url(), PHP_URL_HOST ),
    ];

    header( 'Content-Type: application/json; charset=utf-8' );
    header( 'Access-Control-Allow-Origin: *' );
    header( 'Cache-Control: public, max-age=3600' );
    status_header( 200 );
    echo wp_json_encode( $payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
    exit;
} );

// ---------------------------------------------------------------------------
// Structured data (JSON-LD) — inject LocalBusiness schema into <head>
// ---------------------------------------------------------------------------

/**
 * The business slug used to address this site on Advocate. Prefers the
 * explicit Business ID setting; falls back to the tail of the Agent Query URL,
 * matching how the /.well-known/mcp.json handler infers it.
 */
function advocate_resolve_agent_id( $settings ) {
    $agent_id = trim( $settings['agent_id'] ?? '' );
    if ( $agent_id ) {
        return $agent_id;
    }
    $path = wp_parse_url( trim( $settings['agent_url'] ?? '' ), PHP_URL_PATH );
    return $path ? basename( rtrim( $path, '/' ) ) : '';
}

/**
 * Whether the JSON-LD <head> block is enabled. Defaults to on: a site that has
 * never seen this toggle (settings saved before it existed) still gets the
 * structured data. The single place that spells the default, shared by the
 * settings checkbox and the wp_head guard.
 */
function advocate_jsonld_enabled( $settings ) {
    return ! array_key_exists( 'inject_jsonld', $settings ) || ! empty( $settings['inject_jsonld'] );
}

function advocate_jsonld_transient_key( $agent_id ) {
    return 'advocate_jsonld_' . $agent_id;
}

/**
 * Returns the business's LocalBusiness JSON-LD as a decoded array, or null when
 * it can't be fetched. Serves from a 1-hour transient so a page render is a DB
 * read at most once an hour, never a network call on every load. A transport
 * error, a non-200, or a non-JSON body returns null (caller skips output) and
 * is not cached, so a transient upstream blip retries on the next render.
 */
function advocate_get_jsonld( $agent_id ) {
    $cached = get_transient( advocate_jsonld_transient_key( $agent_id ) );
    if ( is_array( $cached ) ) {
        return $cached;
    }

    $url      = ADVOCATE_APP_BASE . '/api/biz/' . rawurlencode( $agent_id ) . '/jsonld';
    $response = wp_remote_get( $url, [ 'timeout' => 5 ] );

    if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
        return null;
    }

    $data = json_decode( wp_remote_retrieve_body( $response ), true );
    if ( ! is_array( $data ) || empty( $data ) ) {
        return null;
    }

    set_transient( advocate_jsonld_transient_key( $agent_id ), $data, HOUR_IN_SECONDS );
    return $data;
}

add_action( 'wp_head', function () {
    $settings = get_option( ADVOCATE_OPTION, [] );
    if ( ! advocate_jsonld_enabled( $settings ) ) {
        return;
    }

    $agent_id = advocate_resolve_agent_id( $settings );
    if ( ! $agent_id ) {
        return;
    }

    $data = advocate_get_jsonld( $agent_id );
    if ( ! $data ) {
        return;
    }

    // JSON_HEX_TAG encodes < and > so a value containing "</script>" cannot
    // break out of the script element; the escapes decode back to valid JSON-LD.
    echo "\n" . '<script type="application/ld+json">'
        . wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG )
        . '</script>' . "\n";
}, 10 );

// Settings-page action: clear the cached JSON-LD so the next page load re-fetches.
add_action( 'admin_post_advocate_refresh_jsonld', function () {
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_die( 'Insufficient permissions.' );
    }
    check_admin_referer( 'advocate_refresh_jsonld' );

    $agent_id = advocate_resolve_agent_id( get_option( ADVOCATE_OPTION, [] ) );
    if ( $agent_id ) {
        delete_transient( advocate_jsonld_transient_key( $agent_id ) );
    }

    wp_safe_redirect( add_query_arg(
        [ 'page' => 'advocate-agent', 'advocate_jsonld_refreshed' => '1' ],
        admin_url( 'options-general.php' )
    ) );
    exit;
} );

// ---------------------------------------------------------------------------
// Admin Settings Page
// ---------------------------------------------------------------------------

add_action( 'admin_menu', function () {
    add_options_page(
        'Advocate Agent',
        'Advocate Agent',
        'manage_options',
        'advocate-agent',
        'advocate_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting(
        ADVOCATE_OPTION,
        ADVOCATE_OPTION,
        [
            'sanitize_callback' => function ( $input ) {
                return [
                    'agent_url'     => esc_url_raw( trim( $input['agent_url'] ?? '' ) ),
                    'agent_id'      => sanitize_text_field( trim( $input['agent_id'] ?? '' ) ),
                    'business_name' => sanitize_text_field( trim( $input['business_name'] ?? '' ) ),
                    'inject_jsonld' => ! empty( $input['inject_jsonld'] ),
                ];
            },
        ]
    );
} );

function advocate_settings_page() {
    $settings       = get_option( ADVOCATE_OPTION, [] );
    $agent_url      = $settings['agent_url'] ?? '';
    $agent_id       = $settings['agent_id'] ?? '';
    $business_name  = $settings['business_name'] ?? get_bloginfo( 'name' );
    $mcp_url        = home_url( '/.well-known/mcp.json' );
    $inject_jsonld  = advocate_jsonld_enabled( $settings );
    $resolved_id    = advocate_resolve_agent_id( $settings );
    $jsonld_url     = $resolved_id ? ADVOCATE_APP_BASE . '/api/biz/' . rawurlencode( $resolved_id ) . '/jsonld' : '';

    // Derive verify URL
    $verify_url = '';
    if ( $agent_url && $agent_id ) {
        $parsed     = wp_parse_url( $agent_url );
        $registry   = ( $parsed['scheme'] ?? 'https' ) . '://' . ( $parsed['host'] ?? '' );
        $verify_url = rtrim( $registry, '/' ) . '/verify/' . $agent_id;
    }
    ?>
    <div class="wrap">
        <h1>Advocate Agent</h1>

        <?php if ( isset( $_GET['advocate_jsonld_refreshed'] ) ) : ?>
            <div class="notice notice-success is-dismissible">
                <p>Structured data cache cleared. Your next page load will fetch a fresh copy.</p>
            </div>
        <?php endif; ?>

        <p>
            Connect your business to the <a href="https://app.advocatemcp.com" target="_blank">Advocate AI registry</a>.
            Once configured, AI crawlers will discover your dedicated agent at
            <a href="<?php echo esc_url( $mcp_url ); ?>" target="_blank"><code><?php echo esc_html( $mcp_url ); ?></code></a>.
        </p>

        <?php if ( $agent_url ) : ?>
            <div class="notice notice-success inline">
                <p>
                    <strong>Active.</strong>
                    Your Advocate agent is discoverable at
                    <a href="<?php echo esc_url( $mcp_url ); ?>" target="_blank"><?php echo esc_html( $mcp_url ); ?></a>.
                </p>
            </div>
        <?php else : ?>
            <div class="notice notice-warning inline">
                <p><strong>Not configured.</strong> Paste your Advocate agent URL below to activate discovery.</p>
            </div>
        <?php endif; ?>

        <form method="post" action="options.php">
            <?php settings_fields( ADVOCATE_OPTION ); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="advocate_agent_url">Agent Query URL</label></th>
                    <td>
                        <input
                            type="url"
                            id="advocate_agent_url"
                            name="<?php echo esc_attr( ADVOCATE_OPTION ); ?>[agent_url]"
                            value="<?php echo esc_attr( $agent_url ); ?>"
                            class="regular-text"
                            placeholder="https://app.advocatemcp.com/query/your-business-id"
                        />
                        <p class="description">
                            Copy this from your Advocate dashboard.
                            Looks like: <code>https://app.advocatemcp.com/query/your-business-id</code>
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="advocate_agent_id">Business ID</label></th>
                    <td>
                        <input
                            type="text"
                            id="advocate_agent_id"
                            name="<?php echo esc_attr( ADVOCATE_OPTION ); ?>[agent_id]"
                            value="<?php echo esc_attr( $agent_id ); ?>"
                            class="regular-text"
                            placeholder="your-business-id"
                        />
                        <p class="description">
                            Your unique business slug on Advocate (e.g. <code>dmre-land-broker</code>).
                            Found in the URL of your dashboard page. If left blank it is inferred from the Agent URL above.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="advocate_business_name">Business Name</label></th>
                    <td>
                        <input
                            type="text"
                            id="advocate_business_name"
                            name="<?php echo esc_attr( ADVOCATE_OPTION ); ?>[business_name]"
                            value="<?php echo esc_attr( $business_name ); ?>"
                            class="regular-text"
                        />
                        <p class="description">
                            Your business name as it should appear in the AI discovery file.
                            Defaults to your WordPress site title.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Structured data</th>
                    <td>
                        <label for="advocate_inject_jsonld">
                            <input
                                type="checkbox"
                                id="advocate_inject_jsonld"
                                name="<?php echo esc_attr( ADVOCATE_OPTION ); ?>[inject_jsonld]"
                                value="1"
                                <?php checked( $inject_jsonld ); ?>
                            />
                            Inject structured data (JSON-LD) into page head
                        </label>
                        <p class="description">
                            Adds a <code>LocalBusiness</code> schema block to your site&rsquo;s
                            <code>&lt;head&gt;</code>, sourced live from your Advocate profile.
                            Uncheck this if another plugin already outputs JSON-LD for this business.
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button( 'Save Settings' ); ?>
        </form>

        <?php if ( $jsonld_url ) : ?>
            <hr>
            <h2>Structured data cache</h2>
            <p>
                Your JSON-LD is served from
                <a href="<?php echo esc_url( $jsonld_url ); ?>" target="_blank"><code><?php echo esc_html( $jsonld_url ); ?></code></a>
                and cached on this site for one hour. After updating your business details on Advocate,
                clear the cache to pull the new data immediately.
            </p>
            <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
                <input type="hidden" name="action" value="advocate_refresh_jsonld" />
                <?php wp_nonce_field( 'advocate_refresh_jsonld' ); ?>
                <?php submit_button( 'Refresh structured data cache', 'secondary', 'submit', false ); ?>
            </form>
        <?php endif; ?>

        <?php if ( $agent_url ) : ?>
            <hr>
            <h2>Verify Configuration</h2>
            <p>Confirm that AI crawlers can find your agent:</p>
            <p>
                <a href="<?php echo esc_url( $mcp_url ); ?>" target="_blank" class="button">
                    View /.well-known/mcp.json &rarr;
                </a>
                <?php if ( $verify_url ) : ?>
                    &nbsp;
                    <a href="<?php echo esc_url( $verify_url ); ?>" target="_blank" class="button button-secondary">
                        Run Advocate Verification Check &rarr;
                    </a>
                <?php endif; ?>
            </p>
            <h3>How AI crawlers find you</h3>
            <ol>
                <li>An AI crawler visits your site and fetches <code>/.well-known/mcp.json</code>.</li>
                <li>This plugin returns a JSON document pointing to your agent on the Advocate registry.</li>
                <li>The crawler queries your agent directly — getting structured pricing, availability, and credentials — instead of scraping your site.</li>
            </ol>
        <?php endif; ?>
    </div>
    <?php
}
