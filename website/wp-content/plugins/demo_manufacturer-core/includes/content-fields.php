<?php
/**
 * Product, case-study and download fields with editorial safeguards.
 *
 * @package Demo ManufacturerCore
 */

defined( 'ABSPATH' ) || exit;

/**
 * Product fields are strings because engineering units and conditions must stay explicit.
 *
 * @return array<string, string>
 */
function demo_manufacturer_core_product_fields(): array {
	return array(
		'demo_external_id'           => __( 'Stable external ID', 'demo_manufacturer-core' ),
		'demo_sku'                   => __( 'SKU', 'demo_manufacturer-core' ),
		'demo_model'                 => __( 'Model', 'demo_manufacturer-core' ),
		'demo_reference_basis'       => __( 'Approved source reference', 'demo_manufacturer-core' ),
		'demo_specification_summary' => __( 'Specification summary', 'demo_manufacturer-core' ),
		'demo_variant_options'       => __( 'Variant options', 'demo_manufacturer-core' ),
		'demo_dimensions'            => __( 'Dimensions', 'demo_manufacturer-core' ),
		'demo_weight'                => __( 'Weight', 'demo_manufacturer-core' ),
		'demo_material'              => __( 'Material', 'demo_manufacturer-core' ),
		'demo_lead_time'             => __( 'Lead time', 'demo_manufacturer-core' ),
		'demo_moq'                   => __( 'MOQ', 'demo_manufacturer-core' ),
		'demo_warranty'              => __( 'Warranty', 'demo_manufacturer-core' ),
		'demo_customization'         => __( 'Customization scope', 'demo_manufacturer-core' ),
	);
}

/**
 * Register metadata for REST imports and editor integrations.
 */
function demo_manufacturer_core_register_content_meta(): void {
	foreach ( demo_manufacturer_core_product_fields() as $key => $label ) {
		register_post_meta(
			'demo_product',
			$key,
			array(
				'type'              => 'string',
				'single'            => true,
				'show_in_rest'      => true,
				'sanitize_callback' => 'sanitize_text_field',
				'auth_callback'     => static function (): bool {
					return current_user_can( 'edit_posts' );
				},
			)
		);
	}

	$case_fields = array(
		'demo_evidence_verified'      => 'boolean',
		'demo_publication_authorized' => 'boolean',
		'demo_evidence_reference'     => 'string',
	);

	foreach ( $case_fields as $key => $type ) {
		register_post_meta(
			'demo_case_study',
			$key,
			array(
				'type'              => $type,
				'single'            => true,
				'show_in_rest'      => true,
				'sanitize_callback' => 'boolean' === $type ? 'rest_sanitize_boolean' : 'sanitize_text_field',
				'auth_callback'     => static function (): bool {
					return current_user_can( 'edit_posts' );
				},
			)
		);
	}

	$resource_fields = array(
		'demo_resource_file_id' => 'integer',
		'demo_resource_version' => 'string',
		'demo_resource_date'    => 'string',
	);

	foreach ( $resource_fields as $key => $type ) {
		register_post_meta(
			'demo_resource',
			$key,
			array(
				'type'              => $type,
				'single'            => true,
				'show_in_rest'      => true,
				'sanitize_callback' => 'integer' === $type ? 'absint' : 'sanitize_text_field',
				'auth_callback'     => static function (): bool {
					return current_user_can( 'upload_files' );
				},
			)
		);
	}
}
add_action( 'init', 'demo_manufacturer_core_register_content_meta', 20 );

/**
 * Add focused editing panels instead of exposing raw custom fields.
 */
function demo_manufacturer_core_add_meta_boxes(): void {
	add_meta_box(
		'demo_manufacturer-product-specifications',
		__( 'Verified Product Specifications', 'demo_manufacturer-core' ),
		'demo_manufacturer_core_render_product_meta_box',
		'demo_product',
		'normal',
		'high'
	);

	add_meta_box(
		'demo_manufacturer-case-publication',
		__( 'Evidence And Publication Approval', 'demo_manufacturer-core' ),
		'demo_manufacturer_core_render_case_meta_box',
		'demo_case_study',
		'side',
		'high'
	);

	add_meta_box(
		'demo_manufacturer-download-file',
		__( 'Download File', 'demo_manufacturer-core' ),
		'demo_manufacturer_core_render_resource_meta_box',
		'demo_resource',
		'normal',
		'high'
	);
}
add_action( 'add_meta_boxes', 'demo_manufacturer_core_add_meta_boxes' );

/**
 * Render product specifications.
 */
function demo_manufacturer_core_render_product_meta_box( WP_Post $post ): void {
	wp_nonce_field( 'demo_manufacturer_save_product_fields', 'demo_manufacturer_product_fields_nonce' );
	?>
	<p><?php esc_html_e( 'Leave an item empty until the value and unit are confirmed by an authorized product owner.', 'demo_manufacturer-core' ); ?></p>
	<table class="form-table" role="presentation">
		<tbody>
		<?php foreach ( demo_manufacturer_core_product_fields() as $key => $label ) : ?>
			<tr>
				<th scope="row"><label for="<?php echo esc_attr( $key ); ?>"><?php echo esc_html( $label ); ?></label></th>
				<td>
					<input
						class="regular-text"
						id="<?php echo esc_attr( $key ); ?>"
						name="<?php echo esc_attr( $key ); ?>"
						type="text"
						value="<?php echo esc_attr( (string) get_post_meta( $post->ID, $key, true ) ); ?>"
					>
				</td>
			</tr>
		<?php endforeach; ?>
		</tbody>
	</table>
	<?php
}

/**
 * Render case verification controls.
 */
function demo_manufacturer_core_render_case_meta_box( WP_Post $post ): void {
	wp_nonce_field( 'demo_manufacturer_save_case_fields', 'demo_manufacturer_case_fields_nonce' );
	$verified   = (bool) get_post_meta( $post->ID, 'demo_evidence_verified', true );
	$authorized = (bool) get_post_meta( $post->ID, 'demo_publication_authorized', true );
	$reference  = (string) get_post_meta( $post->ID, 'demo_evidence_reference', true );
	?>
	<p>
		<label>
			<input name="demo_evidence_verified" type="checkbox" value="1" <?php checked( $verified ); ?>>
			<?php esc_html_e( 'Technical and project evidence has been verified', 'demo_manufacturer-core' ); ?>
		</label>
	</p>
	<p>
		<label>
			<input name="demo_publication_authorized" type="checkbox" value="1" <?php checked( $authorized ); ?>>
			<?php esc_html_e( 'Public use of the customer/project details and media is authorized', 'demo_manufacturer-core' ); ?>
		</label>
	</p>
	<p>
		<label for="demo_evidence_reference"><?php esc_html_e( 'Internal evidence reference', 'demo_manufacturer-core' ); ?></label>
		<input class="widefat" id="demo_evidence_reference" name="demo_evidence_reference" type="text" value="<?php echo esc_attr( $reference ); ?>">
	</p>
	<p class="description"><?php esc_html_e( 'Both approvals are required before a case study can remain published.', 'demo_manufacturer-core' ); ?></p>
	<?php
}

/**
 * Render download attachment metadata.
 */
function demo_manufacturer_core_render_resource_meta_box( WP_Post $post ): void {
	wp_nonce_field( 'demo_manufacturer_save_resource_fields', 'demo_manufacturer_resource_fields_nonce' );
	$file_id = absint( get_post_meta( $post->ID, 'demo_resource_file_id', true ) );
	?>
	<table class="form-table" role="presentation">
		<tbody>
			<tr>
				<th scope="row"><label for="demo_resource_file_id"><?php esc_html_e( 'Media attachment ID', 'demo_manufacturer-core' ); ?></label></th>
				<td>
					<input id="demo_resource_file_id" min="0" name="demo_resource_file_id" type="number" value="<?php echo esc_attr( (string) $file_id ); ?>">
					<?php if ( $file_id && wp_get_attachment_url( $file_id ) ) : ?>
						<a href="<?php echo esc_url( wp_get_attachment_url( $file_id ) ); ?>" rel="noopener" target="_blank"><?php esc_html_e( 'Open current file', 'demo_manufacturer-core' ); ?></a>
					<?php endif; ?>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="demo_resource_version"><?php esc_html_e( 'Version', 'demo_manufacturer-core' ); ?></label></th>
				<td><input id="demo_resource_version" name="demo_resource_version" type="text" value="<?php echo esc_attr( (string) get_post_meta( $post->ID, 'demo_resource_version', true ) ); ?>"></td>
			</tr>
			<tr>
				<th scope="row"><label for="demo_resource_date"><?php esc_html_e( 'Document date', 'demo_manufacturer-core' ); ?></label></th>
				<td><input id="demo_resource_date" name="demo_resource_date" type="date" value="<?php echo esc_attr( (string) get_post_meta( $post->ID, 'demo_resource_date', true ) ); ?>"></td>
			</tr>
		</tbody>
	</table>
	<?php
}

/**
 * Check common permissions before saving a custom panel.
 */
function demo_manufacturer_core_can_save_meta( int $post_id, string $nonce_name, string $nonce_action ): bool {
	if ( wp_is_post_autosave( $post_id ) || wp_is_post_revision( $post_id ) ) {
		return false;
	}

	if ( ! isset( $_POST[ $nonce_name ] ) ) {
		return false;
	}

	$nonce = sanitize_text_field( wp_unslash( $_POST[ $nonce_name ] ) );
	if ( ! wp_verify_nonce( $nonce, $nonce_action ) ) {
		return false;
	}

	return current_user_can( 'edit_post', $post_id );
}

/**
 * Confirm that both case-study publication approvals are explicitly enabled.
 */
function demo_manufacturer_core_case_is_approved_for_publication( int $post_id ): bool {
	$accepted_values = array( true, 1, '1' );
	$verified        = get_post_meta( $post_id, 'demo_evidence_verified', true );
	$authorized      = get_post_meta( $post_id, 'demo_publication_authorized', true );

	return in_array( $verified, $accepted_values, true ) && in_array( $authorized, $accepted_values, true );
}

/**
 * Whether the current request is being served by the REST API.
 */
function demo_manufacturer_core_is_rest_request(): bool {
	return defined( 'REST_REQUEST' ) && REST_REQUEST;
}

/**
 * Queue a final approval check after a multi-step REST write completes.
 */
function demo_manufacturer_core_queue_case_publication_check( int $post_id ): void {
	if ( ! isset( $GLOBALS['demo_manufacturer_core_case_publication_checks'] ) || ! is_array( $GLOBALS['demo_manufacturer_core_case_publication_checks'] ) ) {
		$GLOBALS['demo_manufacturer_core_case_publication_checks'] = array();
	}

	$GLOBALS['demo_manufacturer_core_case_publication_checks'][ $post_id ] = true;
}

/**
 * Remove a completed approval check from the request-level queue.
 */
function demo_manufacturer_core_dequeue_case_publication_check( int $post_id ): void {
	if ( isset( $GLOBALS['demo_manufacturer_core_case_publication_checks'][ $post_id ] ) ) {
		unset( $GLOBALS['demo_manufacturer_core_case_publication_checks'][ $post_id ] );
	}
}

/**
 * Track wp_insert_post() batches so meta_input updates are checked as one unit.
 *
 * @param array<string, mixed> $data Prepared post data.
 * @return array<string, mixed>
 */
function demo_manufacturer_core_track_case_write_start( array $data ): array {
	if ( isset( $data['post_type'] ) && 'demo_case_study' === $data['post_type'] ) {
		$depth = isset( $GLOBALS['demo_manufacturer_core_case_write_depth'] ) ? (int) $GLOBALS['demo_manufacturer_core_case_write_depth'] : 0;
		$GLOBALS['demo_manufacturer_core_case_write_depth'] = $depth + 1;
	}

	return $data;
}
add_filter( 'wp_insert_post_data', 'demo_manufacturer_core_track_case_write_start' );

/**
 * Force a published case back to draft unless both approvals are present.
 */
function demo_manufacturer_core_enforce_case_publication( int $post_id ): bool {
	$post = get_post( $post_id );

	if ( ! $post instanceof WP_Post || 'demo_case_study' !== $post->post_type || 'publish' !== $post->post_status ) {
		return true;
	}

	if ( demo_manufacturer_core_case_is_approved_for_publication( $post_id ) ) {
		return true;
	}

	if ( ! isset( $GLOBALS['demo_manufacturer_core_case_guard_enforcing'] ) || ! is_array( $GLOBALS['demo_manufacturer_core_case_guard_enforcing'] ) ) {
		$GLOBALS['demo_manufacturer_core_case_guard_enforcing'] = array();
	}

	if ( ! empty( $GLOBALS['demo_manufacturer_core_case_guard_enforcing'][ $post_id ] ) ) {
		return false;
	}

	$GLOBALS['demo_manufacturer_core_case_guard_enforcing'][ $post_id ] = true;
	$result = wp_update_post(
		array(
			'ID'          => $post_id,
			'post_status' => 'draft',
		),
		true
	);
	unset( $GLOBALS['demo_manufacturer_core_case_guard_enforcing'][ $post_id ] );

	if ( is_wp_error( $result ) ) {
		return false;
	}

	if ( is_admin() && get_current_user_id() > 0 ) {
		set_transient( 'demo_manufacturer_case_guard_' . get_current_user_id(), '1', MINUTE_IN_SECONDS );
	}

	return true;
}

/**
 * Save verified product specifications.
 */
function demo_manufacturer_core_save_product_fields( int $post_id ): void {
	if ( ! demo_manufacturer_core_can_save_meta( $post_id, 'demo_manufacturer_product_fields_nonce', 'demo_manufacturer_save_product_fields' ) ) {
		return;
	}

	foreach ( demo_manufacturer_core_product_fields() as $key => $label ) {
		$value = isset( $_POST[ $key ] ) ? sanitize_text_field( wp_unslash( $_POST[ $key ] ) ) : '';
		if ( '' === $value ) {
			delete_post_meta( $post_id, $key );
		} else {
			update_post_meta( $post_id, $key, $value );
		}
	}
}
add_action( 'save_post_demo_product', 'demo_manufacturer_core_save_product_fields' );

/**
 * Save case controls from the classic editor.
 */
function demo_manufacturer_core_save_case_fields( int $post_id ): void {
	if ( ! empty( $GLOBALS['demo_manufacturer_core_case_guard_enforcing'][ $post_id ] ) ) {
		return;
	}

	if ( ! demo_manufacturer_core_can_save_meta( $post_id, 'demo_manufacturer_case_fields_nonce', 'demo_manufacturer_save_case_fields' ) ) {
		return;
	}

	$verified   = isset( $_POST['demo_evidence_verified'] );
	$authorized = isset( $_POST['demo_publication_authorized'] );
	$reference  = isset( $_POST['demo_evidence_reference'] ) ? sanitize_text_field( wp_unslash( $_POST['demo_evidence_reference'] ) ) : '';

	update_post_meta( $post_id, 'demo_evidence_verified', $verified );
	update_post_meta( $post_id, 'demo_publication_authorized', $authorized );
	update_post_meta( $post_id, 'demo_evidence_reference', $reference );
}
add_action( 'save_post_demo_case_study', 'demo_manufacturer_core_save_case_fields' );

/**
 * Complete a post-write batch after meta_input and editor meta have been saved.
 */
function demo_manufacturer_core_finish_case_write( int $post_id ): void {
	$depth = isset( $GLOBALS['demo_manufacturer_core_case_write_depth'] ) ? (int) $GLOBALS['demo_manufacturer_core_case_write_depth'] : 0;
	if ( $depth > 1 ) {
		$GLOBALS['demo_manufacturer_core_case_write_depth'] = $depth - 1;
	} else {
		unset( $GLOBALS['demo_manufacturer_core_case_write_depth'] );
	}

	if ( demo_manufacturer_core_is_rest_request() ) {
		demo_manufacturer_core_queue_case_publication_check( $post_id );
		return;
	}

	demo_manufacturer_core_enforce_case_publication( $post_id );
	demo_manufacturer_core_dequeue_case_publication_check( $post_id );
}
add_action( 'save_post_demo_case_study', 'demo_manufacturer_core_finish_case_write', PHP_INT_MAX );

/**
 * Recheck after all standard wp_insert_post() hooks have completed.
 */
function demo_manufacturer_core_enforce_case_after_insert( int $post_id, WP_Post $post ): void {
	if ( 'demo_case_study' !== $post->post_type ) {
		return;
	}

	if ( 'publish' !== get_post_status( $post_id ) ) {
		demo_manufacturer_core_dequeue_case_publication_check( $post_id );
		return;
	}

	if ( demo_manufacturer_core_is_rest_request() ) {
		demo_manufacturer_core_queue_case_publication_check( $post_id );
		return;
	}

	demo_manufacturer_core_enforce_case_publication( $post_id );
	demo_manufacturer_core_dequeue_case_publication_check( $post_id );
}
add_action( 'wp_after_insert_post', 'demo_manufacturer_core_enforce_case_after_insert', 99, 2 );

/**
 * Enforce the invariant when either approval value changes independently.
 *
 * @param mixed $meta_id Metadata row ID, or IDs for deleted metadata.
 */
function demo_manufacturer_core_enforce_case_after_meta_change( $meta_id, int $post_id, string $meta_key ): void {
	unset( $meta_id );

	if ( ! in_array( $meta_key, array( 'demo_evidence_verified', 'demo_publication_authorized' ), true ) ) {
		return;
	}

	if ( 'demo_case_study' !== get_post_type( $post_id ) ) {
		return;
	}

	do_action( 'rank_math/sitemap/invalidate_object_type', 'post', $post_id );

	$write_depth = isset( $GLOBALS['demo_manufacturer_core_case_write_depth'] ) ? (int) $GLOBALS['demo_manufacturer_core_case_write_depth'] : 0;
	if ( $write_depth > 0 || demo_manufacturer_core_is_rest_request() ) {
		demo_manufacturer_core_queue_case_publication_check( $post_id );
		return;
	}

	demo_manufacturer_core_enforce_case_publication( $post_id );
}
add_action( 'added_post_meta', 'demo_manufacturer_core_enforce_case_after_meta_change', 10, 3 );
add_action( 'updated_post_meta', 'demo_manufacturer_core_enforce_case_after_meta_change', 10, 3 );
add_action( 'deleted_post_meta', 'demo_manufacturer_core_enforce_case_after_meta_change', 10, 3 );

/**
 * REST metadata is saved after wp_insert_post(), so validate once it is final.
 */
function demo_manufacturer_core_enforce_case_after_rest_insert( WP_Post $post ): void {
	demo_manufacturer_core_enforce_case_publication( $post->ID );
	demo_manufacturer_core_dequeue_case_publication_check( $post->ID );

	$current_post = get_post( $post->ID );
	if ( $current_post instanceof WP_Post ) {
		$post->post_status = $current_post->post_status;
	}
}
add_action( 'rest_after_insert_demo_case_study', 'demo_manufacturer_core_enforce_case_after_rest_insert', 99 );

/**
 * Catch failed or custom REST writes that do not reach rest_after_insert.
 */
function demo_manufacturer_core_run_deferred_case_publication_checks(): void {
	if ( empty( $GLOBALS['demo_manufacturer_core_case_publication_checks'] ) || ! is_array( $GLOBALS['demo_manufacturer_core_case_publication_checks'] ) ) {
		return;
	}

	$post_ids = array_map( 'absint', array_keys( $GLOBALS['demo_manufacturer_core_case_publication_checks'] ) );
	unset( $GLOBALS['demo_manufacturer_core_case_publication_checks'] );

	foreach ( $post_ids as $post_id ) {
		demo_manufacturer_core_enforce_case_publication( $post_id );
	}
}
add_action( 'shutdown', 'demo_manufacturer_core_run_deferred_case_publication_checks' );

/**
 * Restrict public REST collections to cases with both approvals.
 *
 * @param array<string, mixed> $args REST post query arguments.
 * @return array<string, mixed>
 */
function demo_manufacturer_core_filter_public_case_rest_query( array $args, WP_REST_Request $request ): array {
	if ( 'edit' === $request->get_param( 'context' ) && current_user_can( 'edit_posts' ) ) {
		return $args;
	}

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

	if ( ! empty( $args['meta_query'] ) && is_array( $args['meta_query'] ) ) {
		$args['meta_query'] = array(
			'relation' => 'AND',
			$args['meta_query'],
			$required,
		);
	} else {
		$args['meta_query'] = $required;
	}

	return $args;
}
add_filter( 'rest_demo_case_study_query', 'demo_manufacturer_core_filter_public_case_rest_query', 10, 2 );

/**
 * Return a public 404 before a direct REST read of an unapproved case.
 *
 * @param WP_REST_Response|WP_HTTP_Response|WP_Error|null $response Result from an earlier preemption filter.
 * @param array<string, mixed>                            $handler  Matched route handler.
 * @return WP_REST_Response|WP_HTTP_Response|WP_Error|null
 */
function demo_manufacturer_core_block_public_case_rest_read( $response, array $handler, WP_REST_Request $request ) {
	unset( $handler );

	if ( null !== $response || ! in_array( $request->get_method(), array( 'GET', 'HEAD' ), true ) ) {
		return $response;
	}

	if ( ! preg_match( '#^/wp/v2/case-studies/(\d+)/?$#', $request->get_route(), $matches ) ) {
		return $response;
	}

	$post_id = absint( $matches[1] );
	$post    = get_post( $post_id );
	if ( ! $post instanceof WP_Post || 'demo_case_study' !== $post->post_type || demo_manufacturer_core_case_is_approved_for_publication( $post_id ) ) {
		return $response;
	}

	if ( 'edit' === $request->get_param( 'context' ) && current_user_can( 'edit_post', $post_id ) ) {
		return $response;
	}

	return new WP_Error(
		'rest_case_not_public',
		__( 'Case study not found.', 'demo_manufacturer-core' ),
		array( 'status' => 404 )
	);
}
add_filter( 'rest_request_before_callbacks', 'demo_manufacturer_core_block_public_case_rest_read', 10, 3 );

/**
 * Exclude unapproved cases from Rank Math XML and HTML sitemap entries.
 *
 * @param mixed  $url    Sitemap entry data.
 * @param string $type   Sitemap object type.
 * @param object $object Sitemap source object.
 * @return mixed
 */
function demo_manufacturer_core_filter_case_sitemap_entry( $url, string $type, $object ) {
	if ( 'post' !== $type || ! is_object( $object ) || ! isset( $object->ID, $object->post_type ) || 'demo_case_study' !== $object->post_type ) {
		return $url;
	}

	return demo_manufacturer_core_case_is_approved_for_publication( absint( $object->ID ) ) ? $url : false;
}
add_filter( 'rank_math/sitemap/entry', 'demo_manufacturer_core_filter_case_sitemap_entry', 10, 3 );

/**
 * Clear any sitemap generated before the approval filter was installed.
 */
function demo_manufacturer_core_refresh_case_sitemap_guard_cache(): void {
	$cache_version = '1';
	$option_name   = 'demo_manufacturer_case_sitemap_guard_cache_version';

	if ( $cache_version === get_option( $option_name ) || ! class_exists( '\\RankMath\\Sitemap\\Cache' ) ) {
		return;
	}

	\RankMath\Sitemap\Cache::invalidate_storage( 'demo_case_study' );
	update_option( $option_name, $cache_version, false );
}
add_action( 'init', 'demo_manufacturer_core_refresh_case_sitemap_guard_cache', 99 );

/**
 * Explain why a case was not published.
 */
function demo_manufacturer_core_case_guard_notice(): void {
	$key = 'demo_manufacturer_case_guard_' . get_current_user_id();
	if ( ! get_transient( $key ) ) {
		return;
	}

	delete_transient( $key );
	?>
	<div class="notice notice-error is-dismissible">
		<p><?php esc_html_e( 'The case study was kept as a draft because verified evidence and public-use authorization are both required.', 'demo_manufacturer-core' ); ?></p>
	</div>
	<?php
}
add_action( 'admin_notices', 'demo_manufacturer_core_case_guard_notice' );

/**
 * Save download attachment metadata.
 */
function demo_manufacturer_core_save_resource_fields( int $post_id ): void {
	if ( ! demo_manufacturer_core_can_save_meta( $post_id, 'demo_manufacturer_resource_fields_nonce', 'demo_manufacturer_save_resource_fields' ) ) {
		return;
	}

	$file_id = isset( $_POST['demo_resource_file_id'] ) ? absint( $_POST['demo_resource_file_id'] ) : 0;
	$version = isset( $_POST['demo_resource_version'] ) ? sanitize_text_field( wp_unslash( $_POST['demo_resource_version'] ) ) : '';
	$date    = isset( $_POST['demo_resource_date'] ) ? sanitize_text_field( wp_unslash( $_POST['demo_resource_date'] ) ) : '';

	update_post_meta( $post_id, 'demo_resource_file_id', $file_id );
	update_post_meta( $post_id, 'demo_resource_version', $version );
	update_post_meta( $post_id, 'demo_resource_date', $date );
}
add_action( 'save_post_demo_resource', 'demo_manufacturer_core_save_resource_fields' );
