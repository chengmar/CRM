<?php
/**
 * Product archive.
 *
 * @package Demo Manufacturer
 */

$public_product_ids = get_posts(
	array(
		'post_type'      => 'demo_product',
		'post_status'    => 'publish',
		'posts_per_page' => -1,
		'fields'         => 'ids',
		'no_found_rows'  => true,
		'meta_query'     => demo_manufacturer_theme_public_product_meta_query(),
	)
);
$categories = $public_product_ids
	? get_terms(
		array(
			'taxonomy'   => 'demo_product_category',
			'hide_empty' => true,
			'object_ids' => $public_product_ids,
		)
	)
	: array();

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--product page-header--product-media">
		<?php if ( have_posts() && has_post_thumbnail( $GLOBALS['wp_query']->posts[0] ) ) : ?>
			<div class="page-header__media" aria-hidden="true">
				<?php echo get_the_post_thumbnail( $GLOBALS['wp_query']->posts[0], 'demo_manufacturer-hero', array( 'loading' => 'eager', 'fetchpriority' => 'high' ) ); ?>
			</div>
			<div class="page-header__veil" aria-hidden="true"></div>
		<?php endif; ?>
		<div class="site-shell page-header__inner">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow eyebrow--light"><?php esc_html_e( 'Demo Manufacturer product range', 'demo_manufacturer' ); ?></p>
			<h1><?php esc_html_e( 'Equipment configured around your application.', 'demo_manufacturer' ); ?></h1>
			<p class="page-header__lede"><?php esc_html_e( 'Review approved product entries, then send the required model, quantity, specifications and delivery information.', 'demo_manufacturer' ); ?></p>
		</div>
	</header>

	<div class="site-shell archive-content">
		<?php if ( $categories && ! is_wp_error( $categories ) ) : ?>
			<nav class="taxonomy-nav" aria-label="<?php esc_attr_e( 'Product categories', 'demo_manufacturer' ); ?>">
				<a aria-current="page" href="<?php echo esc_url( get_post_type_archive_link( 'demo_product' ) ); ?>"><?php esc_html_e( 'All products', 'demo_manufacturer' ); ?></a>
				<?php foreach ( $categories as $category ) : ?>
					<a href="<?php echo esc_url( get_term_link( $category ) ); ?>"><?php echo esc_html( $category->name ); ?></a>
				<?php endforeach; ?>
			</nav>
		<?php endif; ?>

		<?php if ( have_posts() ) : ?>
			<div class="content-grid product-archive__grid">
				<?php while ( have_posts() ) : ?>
					<?php the_post(); ?>
					<?php get_template_part( 'template-parts/card', 'demo_product' ); ?>
				<?php endwhile; ?>
			</div>
			<?php the_posts_pagination(); ?>
		<?php else : ?>
			<?php get_template_part( 'template-parts/content', 'none' ); ?>
		<?php endif; ?>
	</div>
	<?php demo_manufacturer_theme_inquiry_band( __( 'Product catalog', 'demo_manufacturer' ) ); ?>
</main>
<?php
get_footer();
