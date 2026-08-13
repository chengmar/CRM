<?php
/**
 * Generic search result card.
 *
 * @package Demo Manufacturer
 */

$post_type        = get_post_type();
$post_type_object = $post_type ? get_post_type_object( $post_type ) : null;
$content_label    = $post_type_object instanceof WP_Post_Type ? $post_type_object->labels->singular_name : __( 'Content', 'demo_manufacturer' );
?>
<article <?php post_class( 'search-result' ); ?>>
	<p class="content-card__meta"><?php echo esc_html( $content_label ); ?></p>
	<h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
	<?php if ( has_excerpt() ) : ?><p><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
</article>
