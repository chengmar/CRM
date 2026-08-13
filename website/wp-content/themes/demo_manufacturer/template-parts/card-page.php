<?php
/**
 * Page result card.
 *
 * @package Demo Manufacturer
 */
?>
<article <?php post_class( 'search-result' ); ?>>
	<p class="content-card__meta"><?php esc_html_e( 'Page', 'demo_manufacturer' ); ?></p>
	<h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
	<?php if ( has_excerpt() ) : ?><p><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
</article>
