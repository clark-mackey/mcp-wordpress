<?php
/**
 * Plugin Name: MCP WordPress login header fallback
 * Description: Lets mcp-wordpress log in with an Application Password on hosts that strip the Authorization header. Reads the same Basic credentials from the X-MCP-WP-Auth header instead. Delete this file to turn it off.
 * Version: 1.0.0
 * License: MIT
 *
 * Install: copy this one file to wp-content/mu-plugins/ (create the folder if it is missing).
 * WordPress loads it automatically; there is nothing to activate.
 *
 * It only fills in the login WordPress would have read from the Authorization header. WordPress
 * still checks the Application Password, the user's role and HTTPS exactly as before.
 */

defined( 'ABSPATH' ) || exit;

// empty(), not isset(): on hosts that strip the header, WordPress's own .htaccess rule
// (RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]) still sets it, to "".
if (
	empty( $_SERVER['PHP_AUTH_USER'] )
	&& empty( $_SERVER['HTTP_AUTHORIZATION'] )
	&& empty( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] )
	&& ! empty( $_SERVER['HTTP_X_MCP_WP_AUTH'] )
) {
	$mcp_wp_auth = (string) $_SERVER['HTTP_X_MCP_WP_AUTH'];
	if ( 0 === stripos( $mcp_wp_auth, 'basic ' ) ) {
		$mcp_wp_decoded = base64_decode( substr( $mcp_wp_auth, 6 ), true );
		if ( false !== $mcp_wp_decoded && false !== strpos( $mcp_wp_decoded, ':' ) ) {
			list( $_SERVER['PHP_AUTH_USER'], $_SERVER['PHP_AUTH_PW'] ) = explode( ':', $mcp_wp_decoded, 2 );
		}
	}
	unset( $mcp_wp_auth, $mcp_wp_decoded );
}

// The answer depends on who is asking, so a shared cache (CDN, Varnish) must never store it or
// hand it to another caller. Caches already skip requests with an Authorization header; this
// header needs saying explicitly.
if ( function_exists( 'add_filter' ) ) {
	add_filter(
		'rest_post_dispatch',
		static function ( $response ) {
			if ( ! empty( $_SERVER['HTTP_X_MCP_WP_AUTH'] ) && $response instanceof WP_HTTP_Response ) {
				$response->header( 'Cache-Control', 'private, no-store' );
				$response->header( 'Vary', 'X-MCP-WP-Auth', false );
			}
			return $response;
		}
	);
}
