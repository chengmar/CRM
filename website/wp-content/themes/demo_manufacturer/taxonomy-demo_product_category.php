<?php
/**
 * Product category archive.
 *
 * @package Demo Manufacturer
 */

$term       = get_queried_object();
$categories = get_terms(
	array(
		'taxonomy'   => 'demo_product_category',
		'hide_empty' => true,
	)
);

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--product">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Product category', 'demo_manufacturer' ); ?></p>
			<h1><?php single_term_title(); ?></h1>
			<?php if ( term_description() ) : ?>
				<div class="page-header__lede"><?php echo wp_kses_post( term_description() ); ?></div>
			<?php else : ?>
				<p class="page-header__lede"><?php esc_html_e( 'Review available product records and request a configuration based on your operating conditions.', 'demo_manufacturer' ); ?></p>
			<?php endif; ?>
		</div>
	</header>

	<div class="site-shell archive-content">
		<?php if ( $categories && ! is_wp_error( $categories ) ) : ?>
			<nav class="taxonomy-nav" aria-label="<?php esc_attr_e( 'Product categories', 'demo_manufacturer' ); ?>">
				<a href="<?php echo esc_url( get_post_type_archive_link( 'demo_product' ) ); ?>"><?php esc_html_e( 'All products', 'demo_manufacturer' ); ?></a>
				<?php foreach ( $categories as $category ) : ?>
					<a <?php echo (int) $term->term_id === (int) $category->term_id ? 'aria-current="page"' : ''; ?> href="<?php echo esc_url( get_term_link( $category ) ); ?>"><?php echo esc_html( $category->name ); ?></a>
				<?php endforeach; ?>
			</nav>
		<?php endif; ?>

		<?php if ( have_posts() ) : ?>
			<div class="content-grid content-grid--four">
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
	<?php demo_manufacturer_theme_inquiry_band( single_term_title( '', false ) ); ?>
</main>
<?php
get_footer();
