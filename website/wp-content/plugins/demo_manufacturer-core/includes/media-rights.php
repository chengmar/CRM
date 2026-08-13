<?php
/**
 * Publication safeguards for media migrated from the previous website.
 *
 * @package Demo ManufacturerCore
 */

defined( 'ABSPATH' ) || exit;

/**
 * Determine whether an attachment may be rendered in the requested environment.
 *
 * Ordinary owner uploads are unaffected. Only migration candidates carrying a
 * source URL require explicit confirmation before they can render outside local.
 */
function demo_manufacturer_core_media_is_publishable( int $attachment_id, ?string $environment_type = null ): bool {
	if ( 'attachment' !== get_post_type( $attachment_id ) ) {
		return false;
	}

	$source_url = (string) get_post_meta( $attachment_id, '_demo_manufacturer_source_url', true );
	if ( '' === $source_url ) {
		return true;
	}

	$environment_type = $environment_type ?? wp_get_environment_type();
	if ( 'local' === $environment_type ) {
		return true;
	}

	return 'owner-confirmed' === (string) get_post_meta( $attachment_id, '_demo_manufacturer_rights_status', true );
}

/**
 * Hide unconfirmed migration media from every standard featured-image call.
 *
 * @param int|false $thumbnail_id Attachment ID or false when no thumbnail exists.
 * @return int|false
 */
function demo_manufacturer_core_filter_post_thumbnail_id( $thumbnail_id ) {
	$attachment_id = absint( $thumbnail_id );
	if ( $attachment_id && ! demo_manufacturer_core_media_is_publishable( $attachment_id ) ) {
		return false;
	}

	return $thumbnail_id;
}
add_filter( 'post_thumbnail_id', 'demo_manufacturer_core_filter_post_thumbnail_id' );

/**
 * Add an explicit rights decision to migrated attachments in the media editor.
 *
 * @param array<string, mixed> $form_fields Existing attachment fields.
 * @param WP_Post              $post        Attachment post.
 * @return array<string, mixed>
 */
function demo_manufacturer_core_attachment_rights_field( array $form_fields, WP_Post $post ): array {
	$source_url = (string) get_post_meta( $post->ID, '_demo_manufacturer_source_url', true );
	if ( '' === $source_url ) {
		return $form_fields;
	}

	$current = (string) get_post_meta( $post->ID, '_demo_manufacturer_rights_status', true );
	$options = array(
		'pending-owner-confirmation' => __( 'Pending owner confirmation', 'demo_manufacturer-core' ),
		'owner-confirmed'            => __( 'Owner confirmed for public use', 'demo_manufacturer-core' ),
		'rejected'                   => __( 'Rejected - do not publish', 'demo_manufacturer-core' ),
	);
	$html    = '<select name="attachments[' . absint( $post->ID ) . '][demo_manufacturer_rights_status]">';
	foreach ( $options as $value => $label ) {
		$html .= '<option value="' . esc_attr( $value ) . '" ' . selected( $current, $value, false ) . '>' . esc_html( $label ) . '</option>';
	}
	$html .= '</select>';

	$form_fields['demo_manufacturer_rights_status'] = array(
		'label' => __( 'Public-use rights', 'demo_manufacturer-core' ),
		'input' => 'html',
		'html'  => $html,
		'helps' => sprintf(
			/* translators: %s: source URL recorded during migration. */
			__( 'Migrated from %s. Unconfirmed media is visible locally but hidden from featured-image output on staging and production.', 'demo_manufacturer-core' ),
			esc_url( $source_url )
		),
	);

	return $form_fields;
}
add_filter( 'attachment_fields_to_edit', 'demo_manufacturer_core_attachment_rights_field', 10, 2 );

/**
 * Persist only known rights states from the media editor.
 *
 * @param array<string, mixed> $post       Attachment post data.
 * @param array<string, mixed> $attachment Submitted attachment fields.
 * @return array<string, mixed>
 */
function demo_manufacturer_core_save_attachment_rights_field( array $post, array $attachment ): array {
	if ( ! isset( $attachment['demo_manufacturer_rights_status'] ) || ! current_user_can( 'upload_files' ) ) {
		return $post;
	}

	$status  = sanitize_key( (string) $attachment['demo_manufacturer_rights_status'] );
	$allowed = array( 'pending-owner-confirmation', 'owner-confirmed', 'rejected' );
	if ( in_array( $status, $allowed, true ) ) {
		update_post_meta( (int) $post['ID'], '_demo_manufacturer_rights_status', $status );
	}

	return $post;
}
add_filter( 'attachment_fields_to_save', 'demo_manufacturer_core_save_attachment_rights_field', 10, 2 );
