<?php
/**
 * Plugin Name: Demo Manufacturer Core
 * Description: Durable content types, company settings and editorial safeguards for example.com.
 * Version: 0.4.0
 * Requires at least: 7.0
 * Requires PHP: 8.3
 * Author: Demo Manufacturer
 * Text Domain: demo_manufacturer-core
 */

defined( 'ABSPATH' ) || exit;

define( 'DEMO_MANUFACTURER_CORE_VERSION', '0.4.0' );
define( 'DEMO_MANUFACTURER_CORE_PATH', plugin_dir_path( __FILE__ ) );
define( 'DEMO_MANUFACTURER_CORE_URL', plugin_dir_url( __FILE__ ) );

require_once DEMO_MANUFACTURER_CORE_PATH . 'includes/content-types.php';
require_once DEMO_MANUFACTURER_CORE_PATH . 'includes/site-settings.php';
require_once DEMO_MANUFACTURER_CORE_PATH . 'includes/content-fields.php';
require_once DEMO_MANUFACTURER_CORE_PATH . 'includes/media-rights.php';

/**
 * Install durable defaults without replacing any values already saved by an editor.
 */
function demo_manufacturer_core_activate(): void {
	add_option( 'demo_manufacturer_site', demo_manufacturer_core_default_site_settings() );
	demo_manufacturer_core_register_content_types();
	demo_manufacturer_core_register_taxonomies();
	flush_rewrite_rules();
}
register_activation_hook( __FILE__, 'demo_manufacturer_core_activate' );

function demo_manufacturer_core_deactivate(): void {
	flush_rewrite_rules();
}
register_deactivation_hook( __FILE__, 'demo_manufacturer_core_deactivate' );
