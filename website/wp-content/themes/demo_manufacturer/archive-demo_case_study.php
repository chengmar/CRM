<?php
/**
 * Verified case-study archive.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Case studies', 'demo_manufacturer' ); ?></p>
			<h1><?php esc_html_e( 'Published only after evidence and permission review', 'demo_manufacturer' ); ?></h1>
			<p class="page-header__lede"><?php esc_html_e( 'Project details appear here only when technical evidence and public-use authorization are both recorded.', 'demo_manufacturer' ); ?></p>
		</div>
	</header>
	<div class="site-shell archive-content">
		<?php if ( have_posts() ) : ?>
			<div class="content-grid content-grid--three">
				<?php while ( have_posts() ) : ?>
					<?php the_post(); ?>
					<?php get_template_part( 'template-parts/card', 'demo_case_study' ); ?>
				<?php endwhile; ?>
			</div>
			<?php the_posts_pagination(); ?>
		<?php else : ?>
			<section class="empty-state empty-state--wide">
				<h2><?php esc_html_e( 'No verified public cases are available yet', 'demo_manufacturer' ); ?></h2>
				<p><?php esc_html_e( 'Existing project claims are under evidence and publication-rights review. Use the inquiry page to discuss a similar operating condition privately.', 'demo_manufacturer' ); ?></p>
				<a class="button" href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Discuss an application', 'demo_manufacturer' ); ?></a>
			</section>
		<?php endif; ?>
	</div>
</main>
<?php
get_footer();
