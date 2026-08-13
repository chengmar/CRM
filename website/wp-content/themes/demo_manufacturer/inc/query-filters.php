<?php
/**
 * Archive behavior.
 *
 * @package Demo Manufacturer
 */

defined( 'ABSPATH' ) || exit;

/**
 * Merge the two required case approvals into an existing meta query.
 *
 * @param mixed $existing Existing meta query value.
 * @return array<int|string, mixed>
 */
function demo_manufacturer_theme_public_case_meta_query( $existing = array() ): array {
	$required = array(
		'relation' => 'AND',
		array(
			'key'     => 'demo_evidence_verified',
			'value'   => '1',
			'compare' => '=',
		),
		array(
			'key'     => 'demo_publication_authorized',
			'value'   => '1',
			'compare' => '=',
		),
	);

	if ( empty( $existing ) || ! is_array( $existing ) ) {
		return $required;
	}

	return array(
		'relation' => 'AND',
		$existing,
		$required,
	);
}

/**
 * Merge the verified-product condition into an existing meta query.
 *
 * Legacy CRM-WEB records remain directly addressable for route continuity, but
 * they are not presented as current catalog entries.
 *
 * @param mixed $existing Existing meta query value.
 * @return array<int|string, mixed>
 */
function demo_manufacturer_theme_public_product_meta_query( $existing = array() ): array {
	$required = array(
		'relation' => 'OR',
		array(
			'key'     => 'demo_external_id',
			'compare' => 'NOT EXISTS',
		),
		array(
			'key'     => 'demo_external_id',
			'value'   => 'CRM-WEB-',
			'compare' => 'NOT LIKE',
		),
	);

	if ( empty( $existing ) || ! is_array( $existing ) ) {
		return $required;
	}

	return array(
		'relation' => 'AND',
		$existing,
		$required,
	);
}

/**
 * Keep archive rows visually complete where possible.
 */
function demo_manufacturer_theme_archive_queries( WP_Query $query ): void {
	if ( is_admin() || ! $query->is_main_query() ) {
		return;
	}

	if ( $query->is_post_type_archive( array( 'demo_product', 'demo_solution', 'demo_case_study' ) ) || $query->is_tax( array( 'demo_product_category', 'demo_industry', 'demo_application' ) ) ) {
		$query->set( 'posts_per_page', 12 );
	}

	if ( $query->is_post_type_archive( 'demo_product' ) || $query->is_tax( 'demo_product_category' ) ) {
		$query->set( 'meta_query', demo_manufacturer_theme_public_product_meta_query( $query->get( 'meta_query' ) ) );
		$query->set(
			'orderby',
			array(
				'menu_order' => 'ASC',
				'date'       => 'DESC',
			)
		);
	}

	if ( $query->is_post_type_archive( 'demo_case_study' ) ) {
		$query->set( 'meta_query', demo_manufacturer_theme_public_case_meta_query( $query->get( 'meta_query' ) ) );
	}

	if ( $query->is_search() || $query->is_tax( array( 'demo_industry', 'demo_application' ) ) ) {
		$query->set( 'demo_manufacturer_require_public_cases', true );
	}

	if ( $query->is_post_type_archive( 'demo_resource' ) ) {
		$query->set( 'posts_per_page', 12 );
	}
}
add_action( 'pre_get_posts', 'demo_manufacturer_theme_archive_queries' );

/**
 * Hide unapproved cases in queries that can also contain other post types.
 */
function demo_manufacturer_theme_filter_mixed_case_results( string $where, WP_Query $query ): string {
	if ( ! $query->get( 'demo_manufacturer_require_public_cases' ) ) {
		return $where;
	}

	global $wpdb;

	$where .= $wpdb->prepare(
		" AND ( {$wpdb->posts}.post_type <> %s OR (\n"
		. "EXISTS ( SELECT 1 FROM {$wpdb->postmeta} demo_case_evidence WHERE demo_case_evidence.post_id = {$wpdb->posts}.ID AND demo_case_evidence.meta_key = %s AND demo_case_evidence.meta_value = %s )\n"
		. "AND EXISTS ( SELECT 1 FROM {$wpdb->postmeta} demo_case_authorization WHERE demo_case_authorization.post_id = {$wpdb->posts}.ID AND demo_case_authorization.meta_key = %s AND demo_case_authorization.meta_value = %s )\n"
		. ') )',
		'demo_case_study',
		'demo_evidence_verified',
		'1',
		'demo_publication_authorized',
		'1'
	);

	return $where;
}
add_filter( 'posts_where', 'demo_manufacturer_theme_filter_mixed_case_results', 10, 2 );

/**
 * Apply the same mixed-content guard to the core REST search endpoint.
 *
 * @param array<string, mixed> $query_args Search query arguments.
 * @return array<string, mixed>
 */
function demo_manufacturer_theme_filter_rest_search_cases( array $query_args ): array {
	$query_args['demo_manufacturer_require_public_cases'] = true;

	return $query_args;
}
add_filter( 'rest_post_search_query', 'demo_manufacturer_theme_filter_rest_search_cases' );

/**
 * Keep empty evidence-dependent sections out of the primary navigation.
 *
 * @param array<int, WP_Post> $items Menu items.
 * @param stdClass            $args  Menu arguments.
 * @return array<int, WP_Post>
 */
function demo_manufacturer_theme_hide_empty_primary_routes( array $items, stdClass $args ): array {
	if ( 'primary' !== ( $args->theme_location ?? '' ) ) {
		return $items;
	}

	$verified_cases = get_posts(
		array(
			'post_type'      => 'demo_case_study',
			'post_status'    => 'publish',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'no_found_rows'  => true,
			'meta_query'     => demo_manufacturer_theme_public_case_meta_query(),
		)
	);
	$resource_counts = wp_count_posts( 'demo_resource' );
	$visibility      = array(
		'cases'     => ! empty( $verified_cases ),
		'downloads' => isset( $resource_counts->publish ) && (int) $resource_counts->publish > 0,
	);

	return array_values(
		array_filter(
			$items,
			static function ( WP_Post $item ) use ( $visibility ): bool {
				$key = sanitize_title( $item->title );

				return ! array_key_exists( $key, $visibility ) || $visibility[ $key ];
			}
		)
	);
}
add_filter( 'wp_nav_menu_objects', 'demo_manufacturer_theme_hide_empty_primary_routes', 10, 2 );
