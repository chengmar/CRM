<?php
/**
 * Bootstrap a product-neutral local site.
 *
 * Run with: wp eval-file scripts/bootstrap-local.php
 */

defined( 'ABSPATH' ) || exit;

/**
 * Create or update one structural page without seeding product content.
 */
function demo_bootstrap_page( string $slug, string $title, string $content = '' ): int {
	$existing = get_page_by_path( $slug, OBJECT, 'page' );
	$post     = array(
		'post_type'    => 'page',
		'post_status'  => 'publish',
		'post_name'    => $slug,
		'post_title'   => $title,
		'post_content' => $content,
	);

	if ( $existing instanceof WP_Post ) {
		$post['ID'] = $existing->ID;
	}

	$result = wp_insert_post( $post, true );
	if ( is_wp_error( $result ) ) {
		throw new RuntimeException( $result->get_error_message() );
	}

	return (int) $result;
}

$home_id = demo_bootstrap_page(
	'home',
	'Home',
	'<p>This installation contains the reusable catalog and inquiry architecture. No product line is preloaded.</p>'
);
demo_bootstrap_page(
	'about',
	'About',
	'<p>Add verified company information here before publishing the site.</p>'
);
demo_bootstrap_page(
	'contact',
	'Contact',
	'<p>Configure an approved contact route before accepting public inquiries.</p>'
);
$privacy_id = demo_bootstrap_page(
	'privacy-policy',
	'Privacy Policy',
	'<p>Replace this placeholder with a policy reviewed for the intended market and data flow.</p>'
);

update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $home_id );
update_option( 'page_for_privacy_policy', $privacy_id );
update_option( 'blogname', 'Example Catalog' );
update_option( 'blogdescription', 'Product catalog awaiting approved content' );
update_option( 'permalink_structure', '/%postname%/' );

$settings = function_exists( 'demo_manufacturer_core_default_site_settings' )
	? demo_manufacturer_core_default_site_settings()
	: array();
update_option( 'demo_manufacturer_site', $settings, false );

flush_rewrite_rules();

WP_CLI::success( 'Product-neutral site structure created. Product catalog remains empty.' );
