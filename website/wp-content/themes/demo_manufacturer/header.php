<?php
/**
 * Site header.
 *
 * @package Demo Manufacturer
 */
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="skip-link" href="#main-content"><?php esc_html_e( 'Skip to content', 'demo_manufacturer' ); ?></a>
<header class="site-header" data-site-header>
	<div class="site-shell site-header__inner">
		<?php demo_manufacturer_theme_brand(); ?>

		<button class="menu-toggle" type="button" aria-controls="primary-navigation" aria-expanded="false" data-menu-toggle>
			<span class="screen-reader-text"><?php esc_html_e( 'Toggle navigation', 'demo_manufacturer' ); ?></span>
			<svg aria-hidden="true" class="icon icon--menu" fill="none" height="24" viewBox="0 0 24 24" width="24">
				<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
			</svg>
			<svg aria-hidden="true" class="icon icon--close" fill="none" height="24" viewBox="0 0 24 24" width="24">
				<path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
			</svg>
		</button>

		<nav class="primary-navigation" id="primary-navigation" aria-label="<?php esc_attr_e( 'Primary navigation', 'demo_manufacturer' ); ?>" data-navigation>
			<?php
			wp_nav_menu(
				array(
					'theme_location' => 'primary',
					'container'      => false,
					'fallback_cb'    => 'demo_manufacturer_theme_primary_menu_fallback',
					'menu_class'     => 'menu primary-menu',
					'depth'          => 2,
				)
			);
			?>
			<a class="button button--small header-inquiry" href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Discuss a project', 'demo_manufacturer' ); ?></a>
		</nav>
	</div>
</header>
