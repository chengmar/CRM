<?php
/**
 * Download card.
 *
 * @package Demo Manufacturer
 */

$file_id = absint( get_post_meta( get_the_ID(), 'demo_resource_file_id', true ) );
$file    = $file_id ? wp_get_attachment_url( $file_id ) : '';
$version = trim( (string) get_post_meta( get_the_ID(), 'demo_resource_version', true ) );
?>
<article <?php post_class( 'resource-card' ); ?>>
	<div class="resource-card__icon" aria-hidden="true">
		<svg fill="none" height="28" viewBox="0 0 24 24" width="28">
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8m-6-6 6 6m-6-6v6h6M12 12v6m-3-3 3 3 3-3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
		</svg>
	</div>
	<div>
		<p class="content-card__meta">
			<?php esc_html_e( 'Technical document', 'demo_manufacturer' ); ?>
			<?php if ( '' !== $version ) : ?> / <?php echo esc_html( $version ); ?><?php endif; ?>
		</p>
		<h3><?php the_title(); ?></h3>
		<?php if ( has_excerpt() ) : ?><p><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
		<?php if ( $file ) : ?>
			<a class="text-link" href="<?php echo esc_url( $file ); ?>" download><?php esc_html_e( 'Download file', 'demo_manufacturer' ); ?></a>
		<?php else : ?>
			<a class="text-link" href="<?php echo esc_url( demo_manufacturer_theme_inquiry_url( get_the_title() ) ); ?>"><?php esc_html_e( 'Request this document', 'demo_manufacturer' ); ?></a>
		<?php endif; ?>
	</div>
</article>
