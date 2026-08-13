<?php
/**
 * Not found template.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main error-page">
	<div class="site-shell error-page__inner">
		<p class="error-code">404</p>
		<p class="eyebrow"><?php esc_html_e( 'Page not found', 'demo_manufacturer' ); ?></p>
		<h1><?php esc_html_e( 'This address does not contain a published page.', 'demo_manufacturer' ); ?></h1>
		<p><?php esc_html_e( 'The item may have moved, remained under review, or never been approved for publication.', 'demo_manufacturer' ); ?></p>
		<div class="button-row">
			<a class="button" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php esc_html_e( 'Return home', 'demo_manufacturer' ); ?></a>
			<a class="button button--outline" href="<?php echo esc_url( get_post_type_archive_link( 'demo_product' ) ); ?>"><?php esc_html_e( 'Browse products', 'demo_manufacturer' ); ?></a>
		</div>
	</div>
</main>
<?php
get_footer();
