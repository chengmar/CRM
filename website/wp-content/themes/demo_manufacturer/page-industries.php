<?php
/**
 * Legacy industries route backed by verified taxonomy records.
 *
 * @package Demo Manufacturer
 */

$industries = get_terms(
	array(
		'taxonomy'   => 'demo_industry',
		'hide_empty' => false,
	)
);

get_header();
?>
<main id="main-content" class="site-main">
	<header class="page-header page-header--compact">
		<div class="site-shell">
			<?php demo_manufacturer_theme_breadcrumbs(); ?>
			<p class="eyebrow"><?php esc_html_e( 'Industries', 'demo_manufacturer' ); ?></p>
			<h1><?php esc_html_e( 'Start with the process and material conditions', 'demo_manufacturer' ); ?></h1>
			<p class="page-header__lede"><?php esc_html_e( 'Industry labels are a starting point. Equipment selection depends on the actual material or gas, required duty, interfaces, operating schedule and safety requirements.', 'demo_manufacturer' ); ?></p>
		</div>
	</header>
	<div class="site-shell archive-content">
		<?php if ( $industries && ! is_wp_error( $industries ) ) : ?>
			<div class="industry-list">
				<?php foreach ( $industries as $industry ) : ?>
					<article>
						<span><?php echo esc_html( str_pad( (string) ( array_search( $industry, $industries, true ) + 1 ), 2, '0', STR_PAD_LEFT ) ); ?></span>
						<h2><a href="<?php echo esc_url( get_term_link( $industry ) ); ?>"><?php echo esc_html( $industry->name ); ?></a></h2>
						<?php if ( $industry->description ) : ?><p><?php echo esc_html( $industry->description ); ?></p><?php endif; ?>
					</article>
				<?php endforeach; ?>
			</div>
		<?php else : ?>
			<?php get_template_part( 'template-parts/content', 'none' ); ?>
		<?php endif; ?>
	</div>
	<?php demo_manufacturer_theme_inquiry_band( __( 'Industry application', 'demo_manufacturer' ) ); ?>
</main>
<?php
get_footer();
