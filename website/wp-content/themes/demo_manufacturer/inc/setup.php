<?php
/**
 * Theme supports and navigation locations.
 *
 * @package Demo Manufacturer
 */

defined( 'ABSPATH' ) || exit;

function demo_manufacturer_theme_setup(): void {
	load_theme_textdomain( 'demo_manufacturer', get_template_directory() . '/languages' );

	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'responsive-embeds' );
	add_theme_support( 'align-wide' );
	add_theme_support( 'editor-styles' );
	add_theme_support(
		'html5',
		array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script', 'navigation-widgets' )
	);
	add_theme_support(
		'custom-logo',
		array(
			'height'      => 96,
			'width'       => 320,
			'flex-height' => true,
			'flex-width'  => true,
		)
	);

	register_nav_menus(
		array(
			'primary' => __( 'Primary Navigation', 'demo_manufacturer' ),
			'footer'  => __( 'Footer Navigation', 'demo_manufacturer' ),
		)
	);

	add_image_size( 'demo_manufacturer-card', 720, 540, true );
	add_image_size( 'demo_manufacturer-editorial', 1200, 900, false );
	add_image_size( 'demo_manufacturer-hero', 1920, 1080, true );
}
add_action( 'after_setup_theme', 'demo_manufacturer_theme_setup' );

/**
 * Keep front-end content widths predictable for embeds and editor previews.
 */
function demo_manufacturer_theme_content_width(): void {
	$GLOBALS['content_width'] = 1184;
}
add_action( 'after_setup_theme', 'demo_manufacturer_theme_content_width', 0 );
