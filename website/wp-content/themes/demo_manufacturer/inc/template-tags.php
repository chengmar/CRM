<?php
/**
 * Reusable presentation helpers.
 *
 * @package Demo Manufacturer
 */

defined( 'ABSPATH' ) || exit;

/**
 * Read a confirmed company setting from the companion plugin.
 */
function demo_manufacturer_theme_setting( string $key, string $fallback = '' ): string {
	if ( function_exists( 'demo_manufacturer_get_site_setting' ) ) {
		return demo_manufacturer_get_site_setting( $key, $fallback );
	}

	return $fallback;
}

/**
 * Render the site wordmark with an optional owner-supplied logo.
 */
function demo_manufacturer_theme_brand( bool $allow_custom_logo = true ): void {
	$brand   = demo_manufacturer_theme_setting( 'brand_name', get_bloginfo( 'name' ) );
	$domain  = demo_manufacturer_theme_setting( 'canonical_host', demo_manufacturer_theme_setting( 'domain', 'example.com' ) );
	$logo_id = $allow_custom_logo ? absint( get_theme_mod( 'custom_logo', 0 ) ) : 0;
	?>
	<a class="site-brand" href="<?php echo esc_url( home_url( '/' ) ); ?>" rel="home">
		<?php if ( $logo_id ) : ?>
			<?php echo wp_get_attachment_image( $logo_id, 'full', false, array( 'class' => 'site-brand__logo', 'alt' => $brand ) ); ?>
		<?php else : ?>
			<span class="site-brand__mark" aria-hidden="true">Q</span>
		<?php endif; ?>
		<span class="site-brand__copy">
			<strong><?php echo esc_html( $brand ); ?></strong>
			<small><?php echo esc_html( $domain ); ?></small>
		</span>
	</a>
	<?php
}

/**
 * Fallback navigation keeps the site usable before menus are assigned.
 */
function demo_manufacturer_theme_primary_menu_fallback(): void {
	$items = array(
		__( 'Products', 'demo_manufacturer' )  => home_url( '/products/' ),
		__( 'Industries', 'demo_manufacturer' ) => home_url( '/industries/' ),
		__( 'About', 'demo_manufacturer' )     => home_url( '/about/' ),
		__( 'Blog', 'demo_manufacturer' )      => home_url( '/blog/' ),
		__( 'Contact', 'demo_manufacturer' )   => home_url( '/contact/' ),
	);
	?>
	<ul class="menu primary-menu">
		<?php foreach ( $items as $label => $url ) : ?>
			<li class="menu-item"><a href="<?php echo esc_url( $url ); ?>"><?php echo esc_html( $label ); ?></a></li>
		<?php endforeach; ?>
	</ul>
	<?php
}

/**
 * Build a contextual WhatsApp URL without exposing unverified contact data.
 */
function demo_manufacturer_theme_whatsapp_url( string $context = '' ): string {
	$number  = preg_replace( '/[^0-9]/', '', demo_manufacturer_theme_setting( 'whatsapp_e164', '+15550100000' ) );
	$message = __( 'Hello Demo Manufacturer, I would like to discuss a configured product requirement.', 'demo_manufacturer' );

	if ( '' !== $context ) {
		$message .= ' ' . sprintf(
			/* translators: %s is a product or page title. */
			__( 'Reference: %s', 'demo_manufacturer' ),
			$context
		);
	}

	return add_query_arg( 'text', $message, 'https://wa.me/' . $number );
}

/**
 * Build a contact URL that keeps the referring product or page visible.
 */
function demo_manufacturer_theme_inquiry_url( string $context = '' ): string {
	$url = home_url( '/contact/' );

	if ( '' !== $context ) {
		$url = add_query_arg( 'reference', $context, $url );
	}

	return $url;
}

/**
 * Small breadcrumb trail for visual navigation. Rank Math owns schema output.
 */
function demo_manufacturer_theme_breadcrumbs(): void {
	if ( is_front_page() ) {
		return;
	}

	$items = array(
		array(
			'label' => __( 'Home', 'demo_manufacturer' ),
			'url'   => home_url( '/' ),
		),
	);

	if ( is_singular( 'demo_product' ) ) {
		$items[] = array( 'label' => __( 'Products', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'demo_product' ) );
	} elseif ( is_singular( 'demo_solution' ) ) {
		$items[] = array( 'label' => __( 'Solutions', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'demo_solution' ) );
	} elseif ( is_singular( 'demo_case_study' ) ) {
		$items[] = array( 'label' => __( 'Cases', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'demo_case_study' ) );
	} elseif ( is_singular( 'demo_resource' ) ) {
		$items[] = array( 'label' => __( 'Downloads', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'demo_resource' ) );
	} elseif ( is_singular( 'post' ) ) {
		$items[] = array( 'label' => __( 'Blog', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'post' ) );
	} elseif ( is_tax( 'demo_product_category' ) ) {
		$items[] = array( 'label' => __( 'Products', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'demo_product' ) );
	} elseif ( is_tax( 'demo_industry' ) ) {
		$items[] = array( 'label' => __( 'Industries', 'demo_manufacturer' ), 'url' => home_url( '/industries/' ) );
	} elseif ( is_tax( 'demo_application' ) ) {
		$items[] = array( 'label' => __( 'Applications', 'demo_manufacturer' ), 'url' => get_post_type_archive_link( 'demo_product' ) );
	}

	if ( is_singular() ) {
		$items[] = array( 'label' => wp_strip_all_tags( get_the_title() ), 'url' => '' );
	} elseif ( is_tax() ) {
		$term       = get_queried_object();
		$term_title = $term instanceof WP_Term ? $term->name : single_term_title( '', false );
		$items[]    = array( 'label' => wp_strip_all_tags( $term_title ), 'url' => '' );
	} elseif ( is_home() ) {
		$items[] = array( 'label' => __( 'Blog', 'demo_manufacturer' ), 'url' => '' );
	} elseif ( is_post_type_archive() ) {
		$post_type_object = get_queried_object();
		$archive_title    = $post_type_object instanceof WP_Post_Type ? $post_type_object->labels->name : post_type_archive_title( '', false );
		$items[]          = array( 'label' => wp_strip_all_tags( $archive_title ), 'url' => '' );
	} elseif ( is_search() ) {
		$items[] = array( 'label' => __( 'Search', 'demo_manufacturer' ), 'url' => '' );
	}
	?>
	<nav class="breadcrumbs" aria-label="<?php esc_attr_e( 'Breadcrumb', 'demo_manufacturer' ); ?>">
		<ol>
			<?php foreach ( $items as $index => $item ) : ?>
				<li>
					<?php if ( '' !== $item['url'] && $index < count( $items ) - 1 ) : ?>
						<a href="<?php echo esc_url( $item['url'] ); ?>"><?php echo esc_html( $item['label'] ); ?></a>
					<?php else : ?>
						<span aria-current="page"><?php echo esc_html( $item['label'] ); ?></span>
					<?php endif; ?>
				</li>
			<?php endforeach; ?>
		</ol>
	</nav>
	<?php
}

/**
 * Return only verified product fields that have an explicit saved value.
 *
 * @return array<string, string>
 */
function demo_manufacturer_theme_product_specs( int $post_id ): array {
	$labels = array(
		'demo_sku'                   => __( 'SKU', 'demo_manufacturer' ),
		'demo_model'                 => __( 'Model', 'demo_manufacturer' ),
		'demo_reference_basis'       => __( 'Approved source reference', 'demo_manufacturer' ),
		'demo_specification_summary' => __( 'Specification summary', 'demo_manufacturer' ),
		'demo_variant_options'       => __( 'Variant options', 'demo_manufacturer' ),
		'demo_dimensions'            => __( 'Dimensions', 'demo_manufacturer' ),
		'demo_weight'                => __( 'Weight', 'demo_manufacturer' ),
		'demo_material'              => __( 'Material', 'demo_manufacturer' ),
		'demo_lead_time'             => __( 'Lead time', 'demo_manufacturer' ),
		'demo_moq'                   => __( 'MOQ', 'demo_manufacturer' ),
		'demo_warranty'              => __( 'Warranty', 'demo_manufacturer' ),
		'demo_customization'         => __( 'Customization', 'demo_manufacturer' ),
	);
	$specs = array();

	foreach ( $labels as $key => $label ) {
		$value = trim( (string) get_post_meta( $post_id, $key, true ) );
		if ( '' !== $value ) {
			$specs[ $label ] = $value;
		}
	}

	return $specs;
}

/**
 * Return product-specific inputs for a useful custom-equipment discussion.
 *
 * @return array<int, string>
 */
function demo_manufacturer_theme_product_selection_inputs( int $post_id ): array {
	unset( $post_id );

	return array(
		__( 'Required model, variant or intended use', 'demo_manufacturer' ),
		__( 'Required quantity and delivery location', 'demo_manufacturer' ),
		__( 'Required specifications and acceptance criteria', 'demo_manufacturer' ),
		__( 'Available drawings, references or supporting documents', 'demo_manufacturer' ),
		__( 'Requested delivery scope and schedule', 'demo_manufacturer' ),
	);
}

/**
 * Return owner-provided product attachments for one or more media roles.
 *
 * @param array<int, string> $roles Media role keys.
 * @return array<int, WP_Post>
 */
function demo_manufacturer_theme_product_media( int $post_id, array $roles ): array {
	if ( ! $roles ) {
		return array();
	}

	$attachments = get_posts(
		array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'post_parent'    => $post_id,
			'posts_per_page' => -1,
			'post__not_in'   => array_filter( array( get_post_thumbnail_id( $post_id ) ) ),
			'meta_query'     => array(
				array(
					'key'     => '_demo_manufacturer_media_role',
					'value'   => $roles,
					'compare' => 'IN',
				),
			),
			'orderby'        => array( 'menu_order' => 'ASC', 'ID' => 'ASC' ),
		)
	);

	if ( function_exists( 'demo_manufacturer_core_media_is_publishable' ) ) {
		$attachments = array_filter(
			$attachments,
			static function ( WP_Post $attachment ): bool {
				return demo_manufacturer_core_media_is_publishable( $attachment->ID );
			}
		);
	}

	return array_values( $attachments );
}

/**
 * Render a contextual inquiry band.
 */
function demo_manufacturer_theme_inquiry_band( string $context = '' ): void {
	?>
	<section class="inquiry-band" aria-labelledby="inquiry-band-title">
		<div class="site-shell inquiry-band__inner">
			<div>
				<p class="eyebrow eyebrow--light"><?php esc_html_e( 'Start a technical discussion', 'demo_manufacturer' ); ?></p>
				<h2 id="inquiry-band-title"><?php esc_html_e( 'Tell us what the equipment needs to do.', 'demo_manufacturer' ); ?></h2>
				<p><?php esc_html_e( 'Share your application details and Demo Manufacturer Sales Team will review the next step.', 'demo_manufacturer' ); ?></p>
			</div>
			<div class="button-row">
				<a class="button button--light" href="<?php echo esc_url( demo_manufacturer_theme_inquiry_url( $context ) ); ?>"><?php esc_html_e( 'Send an inquiry', 'demo_manufacturer' ); ?></a>
				<a class="button button--outline-light" href="<?php echo esc_url( demo_manufacturer_theme_whatsapp_url( $context ) ); ?>" rel="noopener" target="_blank"><?php esc_html_e( 'WhatsApp', 'demo_manufacturer' ); ?></a>
			</div>
		</div>
	</section>
	<?php
}
