<?php
/**
 * Verified case detail.
 *
 * @package Demo Manufacturer
 */

$accepted_values = array( true, 1, '1' );
$approved        = function_exists( 'demo_manufacturer_core_case_is_approved_for_publication' )
	? demo_manufacturer_core_case_is_approved_for_publication( get_the_ID() )
	: in_array( get_post_meta( get_the_ID(), 'demo_evidence_verified', true ), $accepted_values, true )
		&& in_array( get_post_meta( get_the_ID(), 'demo_publication_authorized', true ), $accepted_values, true );

if ( ! $approved ) {
	global $wp_query;
	$wp_query->set_404();
	status_header( 404 );
	nocache_headers();
	get_template_part( '404' );
	return;
}

get_header();
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php the_post(); ?>
		<article <?php post_class( 'article-page' ); ?>>
			<header class="article-header">
				<div class="site-shell article-header__inner">
					<?php demo_manufacturer_theme_breadcrumbs(); ?>
					<p class="eyebrow"><?php esc_html_e( 'Verified case study', 'demo_manufacturer' ); ?></p>
					<h1><?php the_title(); ?></h1>
					<?php if ( has_excerpt() ) : ?><p class="article-header__lede"><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
				</div>
			</header>
			<?php if ( has_post_thumbnail() ) : ?>
				<figure class="site-shell article-featured-media"><?php the_post_thumbnail( 'demo_manufacturer-hero', array( 'loading' => 'eager' ) ); ?></figure>
			<?php endif; ?>
			<div class="site-shell article-body prose"><?php the_content(); ?></div>
		</article>
		<?php demo_manufacturer_theme_inquiry_band( get_the_title() ); ?>
	<?php endwhile; ?>
</main>
<?php
get_footer();
