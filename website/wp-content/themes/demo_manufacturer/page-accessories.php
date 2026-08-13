<?php
/**
 * Legacy accessories route backed by product records.
 *
 * @package Demo Manufacturer
 */

$accessories = new WP_Query(
	array(
		'post_type'      => 'demo_product',
		'post_status'    => 'publish',
		'posts_per_page' => 12,
		'tax_query'      => array(
			array(
				'taxonomy' => 'demo_product_category',
				'field'    => 'slug',
				'terms'    => array( 'accessories' ),
			),
		),
		'orderby'        => array(
			'menu_order' => 'ASC',
			'date'       => 'DESC',
		),
	)
);

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'sample product components', 'demo_manufacturer' ); ?></p>
			<h1><?php esc_html_e( 'Accessories and replacement parts', 'demo_manufacturer' ); ?></h1>
			<p class="page-header__lede"><?php esc_html_e( 'Match each component to the existing assembly, interfaces, operating conditions, electrical data and requested delivery scope.', 'demo_manufacturer' ); ?></p>
		</div>
	</header>
	<div class="site-shell archive-content">
		<?php if ( $accessories->have_posts() ) : ?>
			<div class="content-grid content-grid--four">
				<?php while ( $accessories->have_posts() ) : ?>
					<?php $accessories->the_post(); ?>
					<?php get_template_part( 'template-parts/card', 'demo_product' ); ?>
				<?php endwhile; ?>
			</div>
		<?php else : ?>
			<?php get_template_part( 'template-parts/content', 'none' ); ?>
		<?php endif; ?>
		<?php wp_reset_postdata(); ?>
	</div>
	<?php demo_manufacturer_theme_inquiry_band( __( 'sample product components', 'demo_manufacturer' ) ); ?>
</main>
<?php
get_footer();
