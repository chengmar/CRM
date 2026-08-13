<?php
/**
 * Standard page template.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php the_post(); ?>
		<header class="page-header page-header--compact">
			<div class="site-shell">
				<?php demo_manufacturer_theme_breadcrumbs(); ?>
				<p class="eyebrow"><?php echo esc_html( demo_manufacturer_theme_setting( 'brand_name', 'Demo Manufacturer' ) ); ?></p>
				<h1><?php the_title(); ?></h1>
				<?php if ( has_excerpt() ) : ?>
					<p class="page-header__lede"><?php echo esc_html( get_the_excerpt() ); ?></p>
				<?php endif; ?>
			</div>
		</header>

		<div class="site-shell page-layout">
			<article <?php post_class( 'prose' ); ?>>
				<?php the_content(); ?>
			</article>
		</div>
	<?php endwhile; ?>
</main>
<?php
get_footer();
