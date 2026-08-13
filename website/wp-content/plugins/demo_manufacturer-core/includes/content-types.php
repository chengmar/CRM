<?php
/**
 * Business content types and taxonomies.
 *
 * @package Demo ManufacturerCore
 */

defined( 'ABSPATH' ) || exit;

/**
 * Register content that must survive theme changes.
 */
function demo_manufacturer_core_register_content_types(): void {
	$common_supports = array( 'title', 'editor', 'excerpt', 'thumbnail', 'revisions', 'author', 'custom-fields' );

	register_post_type(
		'demo_product',
		array(
			'labels' => array(
				'name'               => __( 'Products', 'demo_manufacturer-core' ),
				'singular_name'      => __( 'Product', 'demo_manufacturer-core' ),
				'add_new_item'       => __( 'Add New Product', 'demo_manufacturer-core' ),
				'edit_item'          => __( 'Edit Product', 'demo_manufacturer-core' ),
				'view_item'          => __( 'View Product', 'demo_manufacturer-core' ),
				'search_items'       => __( 'Search Products', 'demo_manufacturer-core' ),
				'not_found'          => __( 'No products found.', 'demo_manufacturer-core' ),
				'featured_image'     => __( 'Primary product image', 'demo_manufacturer-core' ),
				'set_featured_image' => __( 'Set primary product image', 'demo_manufacturer-core' ),
			),
			'public'       => true,
			'show_in_rest' => true,
			'rest_base'    => 'products',
			'menu_icon'    => 'dashicons-hammer',
			'has_archive'  => 'products',
			'rewrite'      => array(
				'slug'       => 'products',
				'with_front' => false,
			),
			'supports'     => $common_supports,
		)
	);

	register_post_type(
		'demo_solution',
		array(
			'labels' => array(
				'name'          => __( 'Solutions', 'demo_manufacturer-core' ),
				'singular_name' => __( 'Solution', 'demo_manufacturer-core' ),
				'add_new_item'  => __( 'Add New Solution', 'demo_manufacturer-core' ),
				'edit_item'     => __( 'Edit Solution', 'demo_manufacturer-core' ),
			),
			'public'       => true,
			'show_in_rest' => true,
			'rest_base'    => 'solutions',
			'menu_icon'    => 'dashicons-admin-tools',
			'has_archive'  => 'solutions',
			'rewrite'      => array(
				'slug'       => 'solutions',
				'with_front' => false,
			),
			'supports'     => $common_supports,
		)
	);

	register_post_type(
		'demo_case_study',
		array(
			'labels' => array(
				'name'          => __( 'Case Studies', 'demo_manufacturer-core' ),
				'singular_name' => __( 'Case Study', 'demo_manufacturer-core' ),
				'add_new_item'  => __( 'Add New Case Study', 'demo_manufacturer-core' ),
				'edit_item'     => __( 'Edit Case Study', 'demo_manufacturer-core' ),
			),
			'public'       => true,
			'show_in_rest' => true,
			'rest_base'    => 'case-studies',
			'menu_icon'    => 'dashicons-portfolio',
			'has_archive'  => 'cases',
			'rewrite'      => array(
				'slug'       => 'cases',
				'with_front' => false,
			),
			'supports'     => $common_supports,
		)
	);

	register_post_type(
		'demo_resource',
		array(
			'labels' => array(
				'name'          => __( 'Downloads', 'demo_manufacturer-core' ),
				'singular_name' => __( 'Download', 'demo_manufacturer-core' ),
				'add_new_item'  => __( 'Add New Download', 'demo_manufacturer-core' ),
				'edit_item'     => __( 'Edit Download', 'demo_manufacturer-core' ),
			),
			'public'       => true,
			'show_in_rest' => true,
			'rest_base'    => 'downloads',
			'menu_icon'    => 'dashicons-media-document',
			'has_archive'  => 'downloads',
			'rewrite'      => array(
				'slug'       => 'downloads',
				'with_front' => false,
			),
			'supports'     => $common_supports,
		)
	);
}
add_action( 'init', 'demo_manufacturer_core_register_content_types' );

/**
 * Register product discovery taxonomies.
 */
function demo_manufacturer_core_register_taxonomies(): void {
	register_taxonomy(
		'demo_product_category',
		array( 'demo_product' ),
		array(
			'labels' => array(
				'name'          => __( 'Product Categories', 'demo_manufacturer-core' ),
				'singular_name' => __( 'Product Category', 'demo_manufacturer-core' ),
			),
			'public'            => true,
			'hierarchical'      => true,
			'show_admin_column' => true,
			'show_in_rest'      => true,
			'rest_base'         => 'product-categories',
			'rewrite'           => array(
				'slug'       => 'product-category',
				'with_front' => false,
			),
		)
	);

	register_taxonomy(
		'demo_industry',
		array( 'demo_product', 'demo_solution', 'demo_case_study' ),
		array(
			'labels' => array(
				'name'          => __( 'Industries', 'demo_manufacturer-core' ),
				'singular_name' => __( 'Industry', 'demo_manufacturer-core' ),
			),
			'public'            => true,
			'hierarchical'      => true,
			'show_admin_column' => true,
			'show_in_rest'      => true,
			'rest_base'         => 'industries',
			'rewrite'           => array(
				'slug'       => 'industry',
				'with_front' => false,
			),
		)
	);

	register_taxonomy(
		'demo_application',
		array( 'demo_product', 'demo_solution', 'demo_case_study' ),
		array(
			'labels' => array(
				'name'          => __( 'Applications', 'demo_manufacturer-core' ),
				'singular_name' => __( 'Application', 'demo_manufacturer-core' ),
			),
			'public'            => true,
			'hierarchical'      => true,
			'show_admin_column' => true,
			'show_in_rest'      => true,
			'rest_base'         => 'applications',
			'rewrite'           => array(
				'slug'       => 'application',
				'with_front' => false,
			),
		)
	);
}
add_action( 'init', 'demo_manufacturer_core_register_taxonomies' );
