<?php
/**
 * Search results.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Search', 'demo_manufacturer' ); ?></p>
			<h1>
				<?php
				printf(
					/* translators: %s is the search phrase. */
					esc_html__( 'Results for “%s”', 'demo_manufacturer' ),
					esc_html( get_search_query() )
				);
				?>
			</h1>
			<?php get_search_form(); ?>
		</div>
	</header>
	<div class="site-shell archive-content">
		<?php if ( have_posts() ) : ?>
			<div class="search-results-list">
				<?php while ( have_posts() ) : ?>
					<?php the_post(); ?>
					<?php get_template_part( 'template-parts/card', get_post_type() ); ?>
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
