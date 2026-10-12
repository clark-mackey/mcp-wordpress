<?php
/**
 * Plugin Name: MCP WordPress theme access
 * Description: Lets one named user (an Editor) change menus and block-theme template parts (header, footer) through the REST API, but only when that user logs in with an Application Password, which is how mcp-wordpress connects. Delete this file to turn it off.
 * Version: 1.0.0
 * License: MIT
 *
 * Install: copy this one file to wp-content/mu-plugins/ (create the folder if it is missing).
 * WordPress loads it automatically; there is nothing to activate.
 *
 * Editors cannot edit menus or template parts because WordPress reserves that for the
 * edit_theme_options capability. This file grants that one capability, and only when all of
 * these are true:
 *   1. the request logged in with an Application Password (not a browser cookie login),
 *   2. the logged-in user's login name is the one set just below,
 *   3. the capability being checked is edit_theme_options.
 * It changes no role, grants nothing else, and the same user logging in through the browser
 * gets no extra access.
 */

defined( 'ABSPATH' ) || exit;

// The WordPress login name of the AI user. Change it here, or define the same constant in wp-config.php.
if ( ! defined( 'MCP_WP_THEME_ACCESS_LOGIN' ) ) {
	define( 'MCP_WP_THEME_ACCESS_LOGIN', 'ai-editor' );
}

/**
 * Remembers which user ID authenticated with an Application Password during this request.
 * PHP starts every request with a clean slate, so the flag never carries over to another request.
 *
 * @param int|null $set A user ID to record, or null to just read.
 * @return int The recorded user ID, or 0.
 */
function mcp_wp_theme_access_app_user( $set = null ) {
	static $user_id = 0;
	if ( null !== $set ) {
		$user_id = (int) $set;
	}
	return $user_id;
}

// Fires only when WordPress has just checked a valid Application Password.
add_action(
	'application_password_did_authenticate',
	static function ( $user ) {
		if ( is_object( $user ) && ! empty( $user->ID ) ) {
			mcp_wp_theme_access_app_user( $user->ID );
		}
	}
);

add_filter(
	'user_has_cap',
	static function ( $allcaps, $caps, $args, $user = null ) {
		if (
			is_object( $user )
			&& ! empty( $user->ID )
			&& is_array( $caps )
			&& in_array( 'edit_theme_options', $caps, true )
			&& mcp_wp_theme_access_app_user() === (int) $user->ID
			&& MCP_WP_THEME_ACCESS_LOGIN === $user->user_login
		) {
			$allcaps['edit_theme_options'] = true;
		}
		return $allcaps;
	},
	10,
	4
);
