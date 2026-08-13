<?php
/**
 * Empty content state.
 *
 * @package Demo Manufacturer
 */
?>
<section class="empty-state">
	<h2><?php esc_html_e( 'No published items yet', 'demo_manufacturer' ); ?></h2>
	<p><?php esc_html_e( 'Use the inquiry page to request current product or document information.', 'demo_manufacturer' ); ?></p>
	<a class="button" href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Contact Demo Manufacturer', 'demo_manufacturer' ); ?></a>
</section>
