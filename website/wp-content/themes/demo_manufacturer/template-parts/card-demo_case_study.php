<?php
/**
 * Verified case-study card.
 *
 * @package Demo Manufacturer
 */
?>
<article <?php post_class( 'content-card case-card' ); ?>>
	<a class="content-card__media" href="<?php the_permalink(); ?>" aria-hidden="true" tabindex="-1">
		<?php if ( has_post_thumbnail() ) : ?>
			<?php the_post_thumbnail( 'demo_manufacturer-card', array( 'loading' => 'lazy' ) ); ?>
		<?php else : ?>
			<span class="media-placeholder"><?php esc_html_e( 'Project image pending', 'demo_manufacturer' ); ?></span>
		<?php endif; ?>
	</a>
	<div class="content-card__body">
		<p class="content-card__meta"><?php esc_html_e( 'Verified case study', 'demo_manufacturer' ); ?></p>
		<h3><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h3>
		<?php if ( has_excerpt() ) : ?><p><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
		<a class="text-link" href="<?php the_permalink(); ?>"><?php esc_html_e( 'View case', 'demo_manufacturer' ); ?></a>
	</div>
</article>
