<?php
/**
 * Industry taxonomy archive.
 *
 * @package Demo Manufacturer
 */

$term_name = single_term_title( '', false );

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Industry', 'demo_manufacturer' ); ?></p>
			<h1><?php echo esc_html( $term_name ); ?></h1>
			<?php if ( term_description() ) : ?>
				<div class="page-header__lede"><?php echo wp_kses_post( term_description() ); ?></div>
			<?php else : ?>
				<p class="page-header__lede"><?php esc_html_e( 'Review equipment, application guidance and verified projects related to this industry. Final selection depends on the actual process, material, duty and site conditions.', 'demo_manufacturer' ); ?></p>
			<?php endif; ?>
		</div>
	</header>

	<div class="site-shell archive-content">
		<?php if ( have_posts() ) : ?>
			<div class="content-grid content-grid--three">
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
	<?php demo_manufacturer_theme_inquiry_band( $term_name ); ?>
</main>
<?php
get_footer();
