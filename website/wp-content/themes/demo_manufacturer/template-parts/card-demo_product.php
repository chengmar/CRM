<?php
/**
 * Product card.
 *
 * @package Demo Manufacturer
 */

$terms = get_the_terms( get_the_ID(), 'demo_product_category' );
$model = trim( (string) get_post_meta( get_the_ID(), 'demo_model', true ) );
?>
<article <?php post_class( 'product-card' ); ?>>
	<a class="product-card__media" href="<?php the_permalink(); ?>" aria-hidden="true" tabindex="-1">
		<?php if ( has_post_thumbnail() ) : ?>
			<?php the_post_thumbnail( 'medium_large', array( 'loading' => 'lazy' ) ); ?>
		<?php else : ?>
			<span class="media-placeholder"><?php esc_html_e( 'Product image pending', 'demo_manufacturer' ); ?></span>
		<?php endif; ?>
	</a>
	<div class="product-card__body">
		<div class="product-card__meta">
			<?php if ( $terms && ! is_wp_error( $terms ) ) : ?>
				<span><?php echo esc_html( $terms[0]->name ); ?></span>
			<?php else : ?>
				<span><?php esc_html_e( 'Equipment', 'demo_manufacturer' ); ?></span>
			<?php endif; ?>
			<?php if ( '' !== $model ) : ?>
				<span><?php echo esc_html( $model ); ?></span>
			<?php endif; ?>
		</div>
		<h3><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h3>
		<a class="text-link" href="<?php the_permalink(); ?>"><?php esc_html_e( 'View product', 'demo_manufacturer' ); ?></a>
	</div>
</article>
