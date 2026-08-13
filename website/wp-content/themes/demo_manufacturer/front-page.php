<?php
/**
 * Product-neutral front page.
 *
 * @package Demo Manufacturer
 */

$products = new WP_Query(
	array(
		'post_type'      => 'demo_product',
		'post_status'    => 'publish',
		'posts_per_page' => 6,
		'no_found_rows'  => true,
		'orderby'        => array( 'menu_order' => 'ASC', 'date' => 'DESC' ),
	)
);

get_header();
?>
<main id="main-content" class="site-main site-main--home">
	<section class="home-hero" aria-labelledby="home-hero-title">
		<div class="home-hero__veil" aria-hidden="true"></div>
		<div class="site-shell home-hero__inner">
			<p class="eyebrow eyebrow--light"><?php esc_html_e( 'Reusable B2B catalog architecture', 'demo_manufacturer' ); ?></p>
			<h1 id="home-hero-title"><?php esc_html_e( 'Product catalog ready for new content', 'demo_manufacturer' ); ?></h1>
			<p><?php esc_html_e( 'No product line is bundled with this repository. Add only current, reviewed information for the next approved launch.', 'demo_manufacturer' ); ?></p>
			<div class="button-row">
				<a class="button button--light" href="<?php echo esc_url( get_post_type_archive_link( 'demo_product' ) ); ?>"><?php esc_html_e( 'Open catalog', 'demo_manufacturer' ); ?></a>
				<a class="button button--outline-light" href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Contact', 'demo_manufacturer' ); ?></a>
			</div>
		</div>
	</section>

	<section class="process-section section-band section-band--surface" aria-labelledby="process-title">
		<div class="site-shell section-heading">
			<p class="eyebrow"><?php esc_html_e( 'Content workflow', 'demo_manufacturer' ); ?></p>
			<h2 id="process-title"><?php esc_html_e( 'Add a new product line through reviewable steps', 'demo_manufacturer' ); ?></h2>
		</div>
		<ol class="site-shell process-list">
			<li><span>01</span><h3><?php esc_html_e( 'Supply source material', 'demo_manufacturer' ); ?></h3><p><?php esc_html_e( 'Provide current product-owner documents and publication rights.', 'demo_manufacturer' ); ?></p></li>
			<li><span>02</span><h3><?php esc_html_e( 'Review facts', 'demo_manufacturer' ); ?></h3><p><?php esc_html_e( 'Confirm names, specifications, claims and available media.', 'demo_manufacturer' ); ?></p></li>
			<li><span>03</span><h3><?php esc_html_e( 'Create catalog entries', 'demo_manufacturer' ); ?></h3><p><?php esc_html_e( 'Enter approved content through the product and taxonomy structures.', 'demo_manufacturer' ); ?></p></li>
			<li><span>04</span><h3><?php esc_html_e( 'Authorize publication', 'demo_manufacturer' ); ?></h3><p><?php esc_html_e( 'Publish only after technical, legal and owner review.', 'demo_manufacturer' ); ?></p></li>
		</ol>
	</section>

	<?php if ( $products->have_posts() ) : ?>
		<section class="product-showcase section-band section-band--surface" aria-labelledby="product-showcase-title">
			<div class="site-shell section-heading">
				<p class="eyebrow"><?php esc_html_e( 'Approved catalog', 'demo_manufacturer' ); ?></p>
				<h2 id="product-showcase-title"><?php esc_html_e( 'Current products', 'demo_manufacturer' ); ?></h2>
			</div>
			<div class="site-shell content-grid product-showcase__grid">
				<?php while ( $products->have_posts() ) : $products->the_post(); ?>
					<?php get_template_part( 'template-parts/card', 'demo_product' ); ?>
				<?php endwhile; ?>
			</div>
		</section>
	<?php else : ?>
		<section class="section-band" aria-labelledby="empty-catalog-title">
			<div class="site-shell section-heading">
				<h2 id="empty-catalog-title"><?php esc_html_e( 'Catalog not populated', 'demo_manufacturer' ); ?></h2>
				<p><?php esc_html_e( 'Create reviewed product entries when the new launch material is ready.', 'demo_manufacturer' ); ?></p>
			</div>
		</section>
	<?php endif; ?>
	<?php wp_reset_postdata(); ?>

	<?php demo_manufacturer_theme_inquiry_band(); ?>
</main>
<?php
get_footer();
