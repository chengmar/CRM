<?php
/**
 * Download detail.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php
		the_post();
		$file_id = absint( get_post_meta( get_the_ID(), 'demo_resource_file_id', true ) );
		$file    = $file_id ? wp_get_attachment_url( $file_id ) : '';
		?>
		<header class="page-header page-header--compact">
			<div class="site-shell">
				<?php demo_manufacturer_theme_breadcrumbs(); ?>
				<p class="eyebrow"><?php esc_html_e( 'Technical download', 'demo_manufacturer' ); ?></p>
				<h1><?php the_title(); ?></h1>
				<?php if ( has_excerpt() ) : ?><p class="page-header__lede"><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
			</div>
		</header>
		<div class="site-shell page-layout">
			<article class="prose">
				<?php the_content(); ?>
				<?php if ( $file ) : ?>
					<p><a class="button" href="<?php echo esc_url( $file ); ?>" download><?php esc_html_e( 'Download current file', 'demo_manufacturer' ); ?></a></p>
				<?php else : ?>
					<p><a class="button" href="<?php echo esc_url( demo_manufacturer_theme_inquiry_url( get_the_title() ) ); ?>"><?php esc_html_e( 'Request this document', 'demo_manufacturer' ); ?></a></p>
				<?php endif; ?>
			</article>
		</div>
	<?php endwhile; ?>
</main>
<?php
get_footer();
