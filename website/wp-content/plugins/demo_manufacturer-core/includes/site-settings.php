<?php
/**
 * Central company and contact settings.
 *
 * @package Demo ManufacturerCore
 */

defined( 'ABSPATH' ) || exit;

/**
 * Confirmed public defaults. Unknown legal and personal fields stay empty.
 *
 * @return array<string, string>
 */
function demo_manufacturer_core_default_site_settings(): array {
	return array(
		'company_name'       => 'Demo Manufacturer',
		'brand_name'         => 'Demo Manufacturer',
		'legal_entity_name'  => 'Example Manufacturing Co., Ltd.',
		'legal_entity_name_zh'=> '示例制造有限公司',
		'domain'             => 'example.com',
		'canonical_host'     => 'www.example.com',
		'email'              => 'sales@example.com',
		'whatsapp_display'   => '+1 555 010 0000',
		'whatsapp_e164'      => '+15550100000',
		'sales_team_name'    => 'Demo Manufacturer Sales Team',
		'contact_name'       => 'Example Sales',
		'contact_title'      => 'Sales Representative',
		'telephone'          => '',
		'public_address'     => '123 Example Industrial Road, Example City',
		'priority_markets'   => 'Malaysia, Vietnam and other international markets',
		'launch_positioning' => 'Product catalog awaiting approved content',
	);
}

/**
 * Read one site setting with a stable fallback.
 */
function demo_manufacturer_get_site_setting( string $key, string $fallback = '' ): string {
	$settings = wp_parse_args(
		(array) get_option( 'demo_manufacturer_site', array() ),
		demo_manufacturer_core_default_site_settings()
	);

	return isset( $settings[ $key ] ) ? (string) $settings[ $key ] : $fallback;
}

/**
 * Register the option as one atomic settings object.
 */
function demo_manufacturer_core_register_site_settings(): void {
	register_setting(
		'demo_manufacturer_site_group',
		'demo_manufacturer_site',
		array(
			'type'              => 'object',
			'sanitize_callback' => 'demo_manufacturer_core_sanitize_site_settings',
			'default'           => demo_manufacturer_core_default_site_settings(),
			'show_in_rest'      => false,
		)
	);
}
add_action( 'admin_init', 'demo_manufacturer_core_register_site_settings' );

/**
 * Sanitize settings without allowing omitted fields to erase confirmed defaults.
 *
 * @param mixed $input Raw settings value.
 * @return array<string, string>
 */
function demo_manufacturer_core_sanitize_site_settings( $input ): array {
	$input    = is_array( $input ) ? $input : array();
	$existing = wp_parse_args(
		(array) get_option( 'demo_manufacturer_site', array() ),
		demo_manufacturer_core_default_site_settings()
	);
	$output   = $existing;

	$text_fields = array(
		'company_name',
		'brand_name',
		'legal_entity_name',
		'legal_entity_name_zh',
		'domain',
		'canonical_host',
		'whatsapp_display',
		'whatsapp_e164',
		'sales_team_name',
		'contact_name',
		'contact_title',
		'telephone',
		'public_address',
		'priority_markets',
		'launch_positioning',
	);

	foreach ( $text_fields as $key ) {
		if ( array_key_exists( $key, $input ) ) {
			$output[ $key ] = sanitize_text_field( (string) $input[ $key ] );
		}
	}

	if ( array_key_exists( 'email', $input ) ) {
		$output['email'] = sanitize_email( (string) $input['email'] );
	}

	return $output;
}

/**
 * Add the owner-facing settings page.
 */
function demo_manufacturer_core_add_site_settings_page(): void {
	add_options_page(
		__( 'Demo Manufacturer Site Information', 'demo_manufacturer-core' ),
		__( 'Demo Manufacturer Site', 'demo_manufacturer-core' ),
		'manage_options',
		'demo_manufacturer-site',
		'demo_manufacturer_core_render_site_settings_page'
	);
}
add_action( 'admin_menu', 'demo_manufacturer_core_add_site_settings_page' );

/**
 * Render a compact settings form with explicit pending fields.
 */
function demo_manufacturer_core_render_site_settings_page(): void {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	$settings = wp_parse_args(
		(array) get_option( 'demo_manufacturer_site', array() ),
		demo_manufacturer_core_default_site_settings()
	);

	$fields = array(
		'company_name'       => __( 'Public company name', 'demo_manufacturer-core' ),
		'brand_name'         => __( 'Brand name', 'demo_manufacturer-core' ),
		'legal_entity_name'  => __( 'Legal entity name', 'demo_manufacturer-core' ),
		'legal_entity_name_zh'=> __( 'Chinese legal entity name', 'demo_manufacturer-core' ),
		'domain'             => __( 'Owned domain', 'demo_manufacturer-core' ),
		'canonical_host'     => __( 'Production canonical host', 'demo_manufacturer-core' ),
		'email'              => __( 'Public sales email', 'demo_manufacturer-core' ),
		'whatsapp_display'   => __( 'WhatsApp display number', 'demo_manufacturer-core' ),
		'whatsapp_e164'      => __( 'WhatsApp E.164 number', 'demo_manufacturer-core' ),
		'sales_team_name'    => __( 'Public sales team name', 'demo_manufacturer-core' ),
		'contact_name'       => __( 'Public contact name', 'demo_manufacturer-core' ),
		'contact_title'      => __( 'Public contact title', 'demo_manufacturer-core' ),
		'telephone'          => __( 'Public telephone', 'demo_manufacturer-core' ),
		'public_address'     => __( 'Public address', 'demo_manufacturer-core' ),
		'priority_markets'   => __( 'Priority markets', 'demo_manufacturer-core' ),
		'launch_positioning' => __( 'One-sentence positioning', 'demo_manufacturer-core' ),
	);
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Demo Manufacturer Site Information', 'demo_manufacturer-core' ); ?></h1>
		<p><?php esc_html_e( 'Only publish legal, contact and capability information that the company has verified.', 'demo_manufacturer-core' ); ?></p>
		<form action="options.php" method="post">
			<?php settings_fields( 'demo_manufacturer_site_group' ); ?>
			<table class="form-table" role="presentation">
				<tbody>
				<?php foreach ( $fields as $key => $label ) : ?>
					<tr>
						<th scope="row">
							<label for="demo_manufacturer-site-<?php echo esc_attr( $key ); ?>"><?php echo esc_html( $label ); ?></label>
						</th>
						<td>
							<input
								class="regular-text"
								id="demo_manufacturer-site-<?php echo esc_attr( $key ); ?>"
								name="demo_manufacturer_site[<?php echo esc_attr( $key ); ?>]"
								type="<?php echo 'email' === $key ? 'email' : 'text'; ?>"
								value="<?php echo esc_attr( (string) $settings[ $key ] ); ?>"
							>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}
