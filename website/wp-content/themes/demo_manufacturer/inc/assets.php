<?php
/**
 * Front-end assets.
 *
 * @package Demo Manufacturer
 */

defined( 'ABSPATH' ) || exit;

function demo_manufacturer_theme_assets(): void {
	$theme = wp_get_theme();
	$base  = get_template_directory_uri();

	wp_enqueue_style(
		'demo_manufacturer-style',
		get_stylesheet_uri(),
		array(),
		$theme->get( 'Version' )
	);

	wp_enqueue_style(
		'demo_manufacturer-base',
		$base . '/assets/css/base.css',
		array( 'demo_manufacturer-style' ),
		$theme->get( 'Version' )
	);

	wp_enqueue_style(
		'demo_manufacturer-components',
		$base . '/assets/css/components.css',
		array( 'demo_manufacturer-base' ),
		$theme->get( 'Version' )
	);

	wp_enqueue_style(
		'demo_manufacturer-templates',
		$base . '/assets/css/templates.css',
		array( 'demo_manufacturer-components' ),
		$theme->get( 'Version' )
	);

	wp_enqueue_style(
		'demo_manufacturer-relaunch',
		$base . '/assets/css/relaunch.css',
		array( 'demo_manufacturer-templates' ),
		$theme->get( 'Version' )
	);

	wp_enqueue_script(
		'demo_manufacturer-navigation',
		$base . '/assets/js/navigation.js',
		array(),
		$theme->get( 'Version' ),
		true
	);
}
add_action( 'wp_enqueue_scripts', 'demo_manufacturer_theme_assets' );
