<?php
/**
 * About page.
 *
 * @package Demo Manufacturer
 */

get_header();
$legal_entity = demo_manufacturer_theme_setting( 'legal_entity_name', 'Demo Manufacturer' );
$address      = demo_manufacturer_theme_setting( 'public_address' );
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php the_post(); ?>
		<header class="page-header page-header--media">
			<?php if ( has_post_thumbnail() ) : ?>
				<div class="page-header__media" aria-hidden="true"><?php the_post_thumbnail( 'demo_manufacturer-hero', array( 'loading' => 'eager' ) ); ?></div>
				<div class="page-header__veil" aria-hidden="true"></div>
			<?php endif; ?>
			<div class="site-shell page-header__inner">
				<?php demo_manufacturer_theme_breadcrumbs(); ?>
				<p class="eyebrow eyebrow--light"><?php esc_html_e( 'About Demo Manufacturer', 'demo_manufacturer' ); ?></p>
				<h1><?php esc_html_e( 'Custom equipment built around application data', 'demo_manufacturer' ); ?></h1>
				<p class="page-header__lede">
					<?php echo esc_html( $legal_entity ); ?>
					<?php if ( $address ) : ?><br><?php echo esc_html( $address ); ?><?php endif; ?>
				</p>
			</div>
		</header>
		<section class="section-band">
			<div class="site-shell product-detail__section-grid">
				<div>
					<p class="eyebrow"><?php esc_html_e( 'Company profile', 'demo_manufacturer' ); ?></p>
					<h2><?php esc_html_e( 'Demo Manufacturer', 'demo_manufacturer' ); ?></h2>
				</div>
				<article class="prose"><?php the_content(); ?></article>
			</div>
		</section>
	<?php endwhile; ?>
	<?php demo_manufacturer_theme_inquiry_band( __( 'Company profile', 'demo_manufacturer' ) ); ?>
</main>
<?php
get_footer();
