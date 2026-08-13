<?php
/**
 * Downloads archive.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Downloads', 'demo_manufacturer' ); ?></p>
			<h1><?php esc_html_e( 'Current product and inquiry documents', 'demo_manufacturer' ); ?></h1>
			<p class="page-header__lede"><?php esc_html_e( 'Only files with an assigned document, version and publication status are listed for direct download.', 'demo_manufacturer' ); ?></p>
		</div>
	</header>
	<div class="site-shell archive-content">
		<?php if ( have_posts() ) : ?>
			<div class="resource-list">
				<?php while ( have_posts() ) : ?>
					<?php the_post(); ?>
					<?php get_template_part( 'template-parts/card', 'demo_resource' ); ?>
				<?php endwhile; ?>
			</div>
			<?php the_posts_pagination(); ?>
		<?php else : ?>
			<section class="empty-state empty-state--wide">
				<h2><?php esc_html_e( 'No verified public files are available yet', 'demo_manufacturer' ); ?></h2>
				<p><?php esc_html_e( 'The previous site listed filenames without usable documents. Current files will be published here after version and content review.', 'demo_manufacturer' ); ?></p>
				<a class="button" href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Request available documents', 'demo_manufacturer' ); ?></a>
			</section>
		<?php endif; ?>
	</div>
</main>
<?php
get_footer();
