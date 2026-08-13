<?php
/**
 * Site footer.
 *
 * @package Demo Manufacturer
 */

$email        = demo_manufacturer_theme_setting( 'email', 'sales@example.com' );
$whatsapp     = demo_manufacturer_theme_setting( 'whatsapp_display', '+1 555 010 0000' );
$legal        = demo_manufacturer_theme_setting( 'legal_entity_name', 'Demo Manufacturer' );
$address      = demo_manufacturer_theme_setting( 'public_address' );
$team         = demo_manufacturer_theme_setting( 'sales_team_name', 'Demo Manufacturer Sales Team' );
$contact_name = demo_manufacturer_theme_setting( 'contact_name' );
$contact_role = demo_manufacturer_theme_setting( 'contact_title' );
$footer_products = get_posts(
	array(
		'post_type'      => 'demo_product',
		'post_status'    => 'publish',
		'posts_per_page' => 2,
		'orderby'        => array( 'menu_order' => 'ASC', 'date' => 'DESC' ),
		'meta_query'     => array(
			'relation' => 'OR',
			array( 'key' => 'demo_external_id', 'compare' => 'NOT EXISTS' ),
			array( 'key' => 'demo_external_id', 'value' => 'CRM-WEB-', 'compare' => 'NOT LIKE' ),
		),
	)
);
?>
<footer class="site-footer">
	<div class="site-shell site-footer__grid">
		<div class="site-footer__brand">
			<?php demo_manufacturer_theme_brand( false ); ?>
			<p><?php echo esc_html( demo_manufacturer_theme_setting( 'launch_positioning', get_bloginfo( 'description' ) ) ); ?></p>
		</div>

		<div class="site-footer__navigation">
			<h2><?php esc_html_e( 'Products', 'demo_manufacturer' ); ?></h2>
			<a href="<?php echo esc_url( get_post_type_archive_link( 'demo_product' ) ); ?>"><?php esc_html_e( 'All equipment', 'demo_manufacturer' ); ?></a>
			<?php foreach ( $footer_products as $footer_product ) : ?>
				<a href="<?php echo esc_url( get_permalink( $footer_product ) ); ?>"><?php echo esc_html( get_the_title( $footer_product ) ); ?></a>
			<?php endforeach; ?>
		</div>

		<div class="site-footer__navigation">
			<h2><?php esc_html_e( 'Company', 'demo_manufacturer' ); ?></h2>
			<a href="<?php echo esc_url( home_url( '/about/' ) ); ?>"><?php esc_html_e( 'About Demo Manufacturer', 'demo_manufacturer' ); ?></a>
			<a href="<?php echo esc_url( home_url( '/industries/' ) ); ?>"><?php esc_html_e( 'Applications', 'demo_manufacturer' ); ?></a>
			<a href="<?php echo esc_url( home_url( '/blog/' ) ); ?>"><?php esc_html_e( 'Technical guides', 'demo_manufacturer' ); ?></a>
			<a href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Contact', 'demo_manufacturer' ); ?></a>
		</div>

		<div class="site-footer__contact">
			<h2><?php echo esc_html( $team ); ?></h2>
			<?php if ( $contact_name ) : ?>
				<p><?php echo esc_html( $contact_name ); ?><?php echo $contact_role ? '<br>' . esc_html( $contact_role ) : ''; ?></p>
			<?php endif; ?>
			<a href="mailto:<?php echo esc_attr( antispambot( $email ) ); ?>"><?php echo esc_html( antispambot( $email ) ); ?></a>
			<a href="<?php echo esc_url( demo_manufacturer_theme_whatsapp_url() ); ?>" rel="noopener" target="_blank">WhatsApp <?php echo esc_html( $whatsapp ); ?></a>
			<?php if ( $address ) : ?><p class="site-footer__address"><?php echo esc_html( $address ); ?></p><?php endif; ?>
		</div>
	</div>

	<div class="site-shell site-footer__legal">
		<span>
			<?php
			printf(
				/* translators: 1: current year, 2: legal entity name. */
				esc_html__( 'Copyright %1$s %2$s.', 'demo_manufacturer' ),
				esc_html( gmdate( 'Y' ) ),
				esc_html( $legal )
			);
			?>
		</span>
		<a href="<?php echo esc_url( home_url( '/privacy-policy/' ) ); ?>"><?php esc_html_e( 'Privacy Policy', 'demo_manufacturer' ); ?></a>
	</div>
</footer>

<div class="mobile-inquiry-bar" aria-label="<?php esc_attr_e( 'Quick contact', 'demo_manufacturer' ); ?>">
	<a href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Inquiry', 'demo_manufacturer' ); ?></a>
	<a href="<?php echo esc_url( demo_manufacturer_theme_whatsapp_url() ); ?>" rel="noopener" target="_blank">WhatsApp</a>
</div>
<?php wp_footer(); ?>
</body>
</html>
