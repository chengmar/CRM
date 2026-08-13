<?php
/**
 * Product detail.
 *
 * @package Demo Manufacturer
 */

get_header();
?>
<main id="main-content" class="site-main">
	<?php while ( have_posts() ) : ?>
		<?php
		the_post();
		$product_id = get_the_ID();
		$model      = trim( (string) get_post_meta( $product_id, 'demo_model', true ) );
		$specs      = demo_manufacturer_theme_product_specs( $product_id );
		$categories = get_the_terms( $product_id, 'demo_product_category' );
		$industries = get_the_terms( $product_id, 'demo_industry' );
		$apps       = get_the_terms( $product_id, 'demo_application' );
		$photos     = demo_manufacturer_theme_product_media( $product_id, array( 'product', 'manufacturing', 'assembly', 'packaging' ) );
		$drawings   = demo_manufacturer_theme_product_media( $product_id, array( 'drawing' ) );
		$inputs     = demo_manufacturer_theme_product_selection_inputs( $product_id );
		$hero_media_ids = array_filter( array( get_post_thumbnail_id( $product_id ) ) );
		foreach ( array_slice( $photos, 0, 3 ) as $hero_media ) {
			$hero_media_ids[] = (int) $hero_media->ID;
		}
		$hero_media_ids = array_values( array_unique( $hero_media_ids ) );
		$hero_specs     = array_slice( $specs, 0, 4, true );
		if ( '' !== $model && isset( $hero_specs['Model'] ) ) {
			unset( $hero_specs['Model'] );
		}
		?>
		<article <?php post_class( 'product-detail' ); ?>>
			<div class="site-shell product-detail__breadcrumb">
				<?php demo_manufacturer_theme_breadcrumbs(); ?>
			</div>

			<header class="site-shell product-hero">
				<div class="product-gallery" data-product-gallery>
					<div class="product-gallery__stage">
					<?php if ( $hero_media_ids ) : ?>
						<?php echo wp_get_attachment_image( $hero_media_ids[0], 'large', false, array( 'loading' => 'eager', 'fetchpriority' => 'high', 'data-product-gallery-main' => '' ) ); ?>
					<?php else : ?>
						<span class="media-placeholder"><?php esc_html_e( 'Verified product image pending', 'demo_manufacturer' ); ?></span>
					<?php endif; ?>
					</div>
					<?php if ( count( $hero_media_ids ) > 1 ) : ?>
						<div class="product-gallery__thumbs" aria-label="<?php esc_attr_e( 'Product images', 'demo_manufacturer' ); ?>">
							<?php foreach ( $hero_media_ids as $hero_media_index => $hero_media_id ) : ?>
								<?php
								$hero_media_src = wp_get_attachment_image_src( $hero_media_id, 'large' );
								$hero_media_alt = get_post_meta( $hero_media_id, '_wp_attachment_image_alt', true );
								?>
								<?php if ( $hero_media_src ) : ?>
									<button class="product-gallery__thumb" type="button" aria-pressed="<?php echo 0 === $hero_media_index ? 'true' : 'false'; ?>" data-gallery-src="<?php echo esc_url( $hero_media_src[0] ); ?>" data-gallery-alt="<?php echo esc_attr( $hero_media_alt ); ?>">
										<?php echo wp_get_attachment_image( $hero_media_id, 'thumbnail', false, array( 'loading' => 'lazy' ) ); ?>
									</button>
								<?php endif; ?>
							<?php endforeach; ?>
						</div>
					<?php endif; ?>
				</div>

				<div class="product-hero__summary">
					<?php if ( $categories && ! is_wp_error( $categories ) ) : ?>
						<p class="eyebrow"><?php echo esc_html( $categories[0]->name ); ?></p>
					<?php else : ?>
						<p class="eyebrow"><?php esc_html_e( 'Product', 'demo_manufacturer' ); ?></p>
					<?php endif; ?>
					<h1><?php the_title(); ?></h1>
					<?php if ( '' !== $model ) : ?>
						<p class="product-model"><span><?php esc_html_e( 'Model', 'demo_manufacturer' ); ?></span> <?php echo esc_html( $model ); ?></p>
					<?php endif; ?>
					<?php if ( has_excerpt() ) : ?>
						<p class="product-hero__lede"><?php echo esc_html( get_the_excerpt() ); ?></p>
					<?php endif; ?>
					<?php if ( $hero_specs ) : ?>
						<dl class="product-hero__facts">
							<?php foreach ( $hero_specs as $hero_spec_label => $hero_spec_value ) : ?>
								<div><dt><?php echo esc_html( $hero_spec_label ); ?></dt><dd><?php echo esc_html( $hero_spec_value ); ?></dd></div>
							<?php endforeach; ?>
						</dl>
					<?php endif; ?>
					<div class="button-row">
						<a class="button" href="<?php echo esc_url( demo_manufacturer_theme_inquiry_url( get_the_title() ) ); ?>"><?php esc_html_e( 'Request technical review', 'demo_manufacturer' ); ?></a>
						<a class="button button--outline" href="<?php echo esc_url( demo_manufacturer_theme_whatsapp_url( get_the_title() ) ); ?>" rel="noopener" target="_blank"><?php esc_html_e( 'WhatsApp', 'demo_manufacturer' ); ?></a>
					</div>
					<p class="product-context-note"><?php esc_html_e( 'Demo Manufacturer prepares a detailed quotation after the duty, dimensions, interfaces and requested scope are reviewed.', 'demo_manufacturer' ); ?></p>
				</div>
			</header>

			<?php if ( $specs ) : ?>
				<section class="section-band section-band--surface product-specifications" aria-labelledby="product-specifications-title">
					<div class="site-shell product-detail__section-grid">
						<div>
							<p class="eyebrow"><?php esc_html_e( 'Published data', 'demo_manufacturer' ); ?></p>
							<h2 id="product-specifications-title"><?php esc_html_e( 'Verified specifications', 'demo_manufacturer' ); ?></h2>
							<p><?php esc_html_e( 'Published values are tied to the named reference drawing or configuration. Final values remain project-specific.', 'demo_manufacturer' ); ?></p>
						</div>
						<div class="specification-table" role="table" aria-label="<?php esc_attr_e( 'Product specifications', 'demo_manufacturer' ); ?>">
							<?php foreach ( $specs as $label => $value ) : ?>
								<div class="specification-table__row" role="row">
									<span role="rowheader"><?php echo esc_html( $label ); ?></span>
									<strong role="cell"><?php echo esc_html( $value ); ?></strong>
								</div>
							<?php endforeach; ?>
						</div>
					</div>
				</section>
			<?php endif; ?>

			<section class="section-band product-overview" aria-labelledby="product-overview-title">
				<div class="site-shell product-detail__section-grid">
					<div>
						<p class="eyebrow"><?php esc_html_e( 'Product overview', 'demo_manufacturer' ); ?></p>
						<h2 id="product-overview-title"><?php esc_html_e( 'Configuration, options and intended use', 'demo_manufacturer' ); ?></h2>
					</div>
					<div class="prose">
						<?php the_content(); ?>
					</div>
				</div>
			</section>

			<?php if ( $photos ) : ?>
				<section class="section-band section-band--surface product-media" aria-labelledby="product-media-title">
					<div class="site-shell section-heading">
						<p class="eyebrow"><?php esc_html_e( 'Owner-provided media', 'demo_manufacturer' ); ?></p>
						<h2 id="product-media-title"><?php esc_html_e( 'Product, manufacturing and packing views', 'demo_manufacturer' ); ?></h2>
					</div>
					<div class="site-shell product-media__grid">
						<?php foreach ( $photos as $media ) : ?>
							<figure>
								<a href="<?php echo esc_url( wp_get_attachment_url( $media->ID ) ); ?>" target="_blank" rel="noopener">
									<?php echo wp_get_attachment_image( $media->ID, 'medium_large', false, array( 'loading' => 'lazy' ) ); ?>
								</a>
								<?php $caption = wp_get_attachment_caption( $media->ID ) ?: $media->post_title; ?>
								<?php if ( $caption ) : ?><figcaption><?php echo esc_html( $caption ); ?></figcaption><?php endif; ?>
							</figure>
						<?php endforeach; ?>
					</div>
				</section>
			<?php endif; ?>

			<?php if ( $drawings ) : ?>
				<section class="section-band product-drawings" aria-labelledby="product-drawings-title">
					<div class="site-shell section-heading">
						<p class="eyebrow"><?php esc_html_e( 'Reference only', 'demo_manufacturer' ); ?></p>
						<h2 id="product-drawings-title"><?php esc_html_e( 'Supplied reference drawings', 'demo_manufacturer' ); ?></h2>
						<p><?php esc_html_e( 'These drawings describe specific supplied examples. Dimensions, units and interfaces must be reconfirmed for each project.', 'demo_manufacturer' ); ?></p>
					</div>
					<div class="site-shell product-drawings__grid">
						<?php foreach ( $drawings as $media ) : ?>
							<figure>
								<a href="<?php echo esc_url( wp_get_attachment_url( $media->ID ) ); ?>" target="_blank" rel="noopener">
									<?php echo wp_get_attachment_image( $media->ID, 'large', false, array( 'loading' => 'lazy' ) ); ?>
								</a>
								<?php $caption = wp_get_attachment_caption( $media->ID ) ?: $media->post_title; ?>
								<?php if ( $caption ) : ?><figcaption><?php echo esc_html( $caption ); ?></figcaption><?php endif; ?>
							</figure>
						<?php endforeach; ?>
					</div>
				</section>
			<?php endif; ?>

			<section class="section-band section-band--surface selection-inputs" aria-labelledby="selection-inputs-title">
				<div class="site-shell product-detail__section-grid">
					<div>
						<p class="eyebrow"><?php esc_html_e( 'For a detailed proposal', 'demo_manufacturer' ); ?></p>
						<h2 id="selection-inputs-title"><?php esc_html_e( 'Information to include with your inquiry', 'demo_manufacturer' ); ?></h2>
					</div>
					<ul class="check-list">
						<?php foreach ( $inputs as $input ) : ?>
							<li><?php echo esc_html( $input ); ?></li>
						<?php endforeach; ?>
					</ul>
				</div>
			</section>

			<?php if ( ( $industries && ! is_wp_error( $industries ) ) || ( $apps && ! is_wp_error( $apps ) ) ) : ?>
				<div class="site-shell product-taxonomies">
					<?php foreach ( array_merge( $industries ?: array(), $apps ?: array() ) as $term ) : ?>
						<a href="<?php echo esc_url( get_term_link( $term ) ); ?>"><?php echo esc_html( $term->name ); ?></a>
					<?php endforeach; ?>
				</div>
			<?php endif; ?>
		</article>

		<?php
		$related_args = array(
			'post_type'      => 'demo_product',
			'post_status'    => 'publish',
			'posts_per_page' => 3,
			'post__not_in'   => array( $product_id ),
			'no_found_rows'  => true,
		);
		if ( $categories && ! is_wp_error( $categories ) ) {
			$related_args['tax_query'] = array(
				array(
					'taxonomy' => 'demo_product_category',
					'field'    => 'term_id',
					'terms'    => wp_list_pluck( $categories, 'term_id' ),
				),
			);
		}
		$related = new WP_Query( $related_args );
		?>
		<?php if ( $related->have_posts() ) : ?>
			<section class="section-band related-content" aria-labelledby="related-products-title">
				<div class="site-shell section-heading section-heading--row">
					<h2 id="related-products-title"><?php esc_html_e( 'Related products', 'demo_manufacturer' ); ?></h2>
					<a class="text-link" href="<?php echo esc_url( get_post_type_archive_link( 'demo_product' ) ); ?>"><?php esc_html_e( 'All products', 'demo_manufacturer' ); ?></a>
				</div>
				<div class="site-shell content-grid content-grid--three">
					<?php while ( $related->have_posts() ) : ?>
						<?php $related->the_post(); ?>
						<?php get_template_part( 'template-parts/card', 'demo_product' ); ?>
					<?php endwhile; ?>
				</div>
			</section>
		<?php endif; ?>
		<?php wp_reset_postdata(); ?>

		<?php demo_manufacturer_theme_inquiry_band( get_the_title( $product_id ) ); ?>
	<?php endwhile; ?>
</main>
<?php
get_footer();
