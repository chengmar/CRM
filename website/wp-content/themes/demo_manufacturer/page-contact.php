<?php
/**
 * Contact and RFQ page.
 *
 * @package Demo Manufacturer
 */

$email        = demo_manufacturer_theme_setting( 'email', 'sales@example.com' );
$whatsapp     = demo_manufacturer_theme_setting( 'whatsapp_display', '+1 555 010 0000' );
$sales_team   = demo_manufacturer_theme_setting( 'sales_team_name', 'Demo Manufacturer Sales Team' );
$contact_name = demo_manufacturer_theme_setting( 'contact_name' );
$contact_role = demo_manufacturer_theme_setting( 'contact_title' );
$address      = demo_manufacturer_theme_setting( 'public_address' );
$reference    = isset( $_GET['reference'] ) ? sanitize_text_field( wp_unslash( $_GET['reference'] ) ) : '';
$form_id      = absint( get_option( 'demo_manufacturer_inquiry_form_id', 0 ) );

get_header();
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php the_post(); ?>
		<header class="page-header page-header--compact contact-header">
			<div class="site-shell">
				<?php demo_manufacturer_theme_breadcrumbs(); ?>
				<p class="eyebrow"><?php esc_html_e( 'Custom equipment inquiry', 'demo_manufacturer' ); ?></p>
				<h1><?php esc_html_e( 'Tell us what the equipment needs to do', 'demo_manufacturer' ); ?></h1>
				<p class="page-header__lede"><?php esc_html_e( 'A detailed quotation is prepared after the model, quantity, specifications, intended use and delivery scope are reviewed.', 'demo_manufacturer' ); ?></p>
			</div>
		</header>

		<div class="site-shell contact-layout">
			<aside class="contact-panel" aria-labelledby="direct-contact-title">
				<p class="eyebrow"><?php esc_html_e( 'Direct contact', 'demo_manufacturer' ); ?></p>
				<h2 id="direct-contact-title"><?php echo esc_html( $sales_team ); ?></h2>
				<?php if ( $contact_name ) : ?>
					<p class="contact-person"><?php echo esc_html( $contact_name ); ?><?php echo $contact_role ? ', ' . esc_html( $contact_role ) : ''; ?></p>
				<?php endif; ?>
				<dl class="contact-list">
					<div>
						<dt><?php esc_html_e( 'Email', 'demo_manufacturer' ); ?></dt>
						<dd><a href="mailto:<?php echo esc_attr( antispambot( $email ) ); ?>"><?php echo esc_html( antispambot( $email ) ); ?></a></dd>
					</div>
					<div>
						<dt>WhatsApp</dt>
						<dd><a href="<?php echo esc_url( demo_manufacturer_theme_whatsapp_url( $reference ) ); ?>" rel="noopener" target="_blank"><?php echo esc_html( $whatsapp ); ?></a></dd>
					</div>
					<?php if ( $address ) : ?>
						<div>
							<dt><?php esc_html_e( 'Address', 'demo_manufacturer' ); ?></dt>
							<dd><?php echo esc_html( $address ); ?></dd>
						</div>
					<?php endif; ?>
				</dl>
				<div class="contact-inputs">
					<h3><?php esc_html_e( 'Useful attachments', 'demo_manufacturer' ); ?></h3>
					<ul>
						<li><?php esc_html_e( 'Material data or process description', 'demo_manufacturer' ); ?></li>
						<li><?php esc_html_e( 'Layout, dimensions and interface drawing', 'demo_manufacturer' ); ?></li>
						<li><?php esc_html_e( 'Current equipment or installation photos', 'demo_manufacturer' ); ?></li>
						<li><?php esc_html_e( 'Required standard and delivery scope', 'demo_manufacturer' ); ?></li>
					</ul>
				</div>
			</aside>

			<section class="inquiry-form" aria-labelledby="inquiry-form-title">
				<p class="eyebrow"><?php esc_html_e( 'Project details', 'demo_manufacturer' ); ?></p>
				<h2 id="inquiry-form-title"><?php esc_html_e( 'Configured product inquiry', 'demo_manufacturer' ); ?></h2>
				<?php if ( $reference ) : ?>
					<p class="inquiry-reference"><strong><?php esc_html_e( 'Reference:', 'demo_manufacturer' ); ?></strong> <?php echo esc_html( $reference ); ?></p>
				<?php endif; ?>
				<?php if ( $form_id && shortcode_exists( 'fluentform' ) ) : ?>
					<p class="form-policy-note">
						<?php esc_html_e( 'Review how inquiry data is handled in the', 'demo_manufacturer' ); ?>
						<a href="<?php echo esc_url( home_url( '/privacy-policy/' ) ); ?>" rel="noopener" target="_blank"><?php esc_html_e( 'Privacy Policy', 'demo_manufacturer' ); ?></a>.
					</p>
					<?php echo do_shortcode( '[fluentform id="' . $form_id . '"]' ); ?>
				<?php else : ?>
					<p><?php esc_html_e( 'The inquiry form is being configured. Please use email or WhatsApp for the current local review.', 'demo_manufacturer' ); ?></p>
					<a class="button" href="mailto:<?php echo esc_attr( antispambot( $email ) ); ?>"><?php esc_html_e( 'Email Demo Manufacturer', 'demo_manufacturer' ); ?></a>
				<?php endif; ?>
			</section>
		</div>
	<?php endwhile; ?>
</main>
<?php
get_footer();
