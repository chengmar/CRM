<?php
/**
 * Standard post template.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php the_post(); ?>
		<article <?php post_class( 'article-page' ); ?>>
			<header class="article-header">
				<div class="site-shell article-header__inner">
					<?php demo_manufacturer_theme_breadcrumbs(); ?>
					<p class="eyebrow"><?php echo esc_html( get_the_date() ); ?></p>
					<h1><?php the_title(); ?></h1>
					<?php if ( has_excerpt() ) : ?>
						<p class="article-header__lede"><?php echo esc_html( get_the_excerpt() ); ?></p>
					<?php endif; ?>
				</div>
			</header>

			<?php if ( has_post_thumbnail() ) : ?>
				<figure class="site-shell article-featured-media">
					<?php the_post_thumbnail( 'demo_manufacturer-hero', array( 'loading' => 'eager' ) ); ?>
				</figure>
			<?php endif; ?>

			<div class="site-shell article-body prose">
				<?php the_content(); ?>
			</div>
		</article>
	<?php endwhile; ?>
	<?php demo_manufacturer_theme_inquiry_band( get_the_title() ); ?>
</main>
<?php
get_footer();
