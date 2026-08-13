<?php
/**
 * Blog archive.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Technical resources', 'demo_manufacturer' ); ?></p>
			<h1><?php esc_html_e( 'Guides for equipment selection and inquiry preparation', 'demo_manufacturer' ); ?></h1>
			<p class="page-header__lede"><?php esc_html_e( 'Practical information to prepare before discussing a configured product.', 'demo_manufacturer' ); ?></p>
		</div>
	</header>
	<div class="site-shell archive-content">
		<?php if ( have_posts() ) : ?>
			<div class="content-grid content-grid--three">
				<?php while ( have_posts() ) : ?>
					<?php the_post(); ?>
					<?php get_template_part( 'template-parts/card', 'post' ); ?>
				<?php endwhile; ?>
			</div>
			<?php the_posts_pagination(); ?>
		<?php else : ?>
			<?php get_template_part( 'template-parts/content', 'none' ); ?>
		<?php endif; ?>
	</div>
</main>
<?php
get_footer();
