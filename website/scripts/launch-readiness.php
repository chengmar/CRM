<?php
/**
 * Read-only launch gate for the Demo Manufacturer WordPress site.
 *
 * Usage: wp eval-file scripts/launch-readiness.php
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	exit;
}

require_once ABSPATH . 'wp-admin/includes/plugin.php';

$blockers = array();
$warnings = array();

if ( 'demo_manufacturer' !== get_stylesheet() ) {
	$blockers[] = 'The active theme is not Demo Manufacturer.';
}
if ( ! has_custom_logo() ) {
	$blockers[] = 'An owner-approved production logo is not configured.';
}

$required_plugins = array(
	'demo_manufacturer-core/demo_manufacturer-core.php' => 'Demo Manufacturer Core',
	'seo-by-rank-math/rank-math.php' => 'Rank Math SEO',
	'fluentform/fluentform.php'       => 'Fluent Forms',
	'wp-mail-smtp/wp_mail_smtp.php'  => 'WP Mail SMTP',
	'updraftplus/updraftplus.php'    => 'UpdraftPlus',
);
foreach ( $required_plugins as $plugin_file => $plugin_name ) {
	if ( ! is_plugin_active( $plugin_file ) ) {
		$blockers[] = $plugin_name . ' is not active.';
	}
}

$site_settings = function_exists( 'demo_manufacturer_core_default_site_settings' )
	? wp_parse_args( (array) get_option( 'demo_manufacturer_site', array() ), demo_manufacturer_core_default_site_settings() )
	: (array) get_option( 'demo_manufacturer_site', array() );
$required_settings = array(
	'legal_entity_name' => 'Legal entity name',
	'canonical_host'    => 'Production canonical host',
	'sales_team_name'   => 'Public sales team name',
	'contact_name'      => 'Public contact name',
	'contact_title'     => 'Public contact title',
	'public_address'    => 'Public address',
	'priority_markets'  => 'Priority markets',
	'email'             => 'Public sales email',
	'whatsapp_e164'     => 'WhatsApp E.164 number',
);
foreach ( $required_settings as $setting_key => $label ) {
	if ( '' === trim( (string) ( $site_settings[ $setting_key ] ?? '' ) ) ) {
		$blockers[] = $label . ' is not configured in Settings > Demo Manufacturer Site.';
	}
}

if ( 'production' === wp_get_environment_type() && ! empty( $site_settings['canonical_host'] ) ) {
	$home_host      = strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) );
	$canonical_host = strtolower( trim( (string) $site_settings['canonical_host'] ) );
	if ( str_contains( $canonical_host, '://' ) ) {
		$canonical_host = (string) wp_parse_url( $canonical_host, PHP_URL_HOST );
	}
	$canonical_host = trim( $canonical_host, '/ ' );
	if ( $home_host !== $canonical_host ) {
		$blockers[] = sprintf( 'WordPress home host (%s) does not match the configured canonical host (%s).', $home_host, $canonical_host );
	}
}

$migration_media = get_posts(
	array(
		'post_type'      => 'attachment',
		'post_status'    => 'inherit',
		'posts_per_page' => -1,
		'meta_key'       => '_demo_manufacturer_source_url',
		'fields'         => 'ids',
		'no_found_rows'  => true,
	)
);
$unconfirmed_media = array_filter(
	$migration_media,
	static function ( int $attachment_id ): bool {
		return ! function_exists( 'demo_manufacturer_core_media_is_publishable' )
			|| ! demo_manufacturer_core_media_is_publishable( $attachment_id, 'production' );
	}
);
if ( $unconfirmed_media ) {
	$blockers[] = sprintf( '%d migrated media item(s) still lack owner confirmation for public use.', count( $unconfirmed_media ) );
}

$published_products = get_posts(
	array(
		'post_type'      => 'demo_product',
		'post_status'    => 'publish',
		'posts_per_page' => -1,
		'fields'         => 'ids',
		'no_found_rows'  => true,
	)
);
$placeholder_products = array_filter(
	$published_products,
	static function ( int $product_id ): bool {
		return str_starts_with( (string) get_post_meta( $product_id, 'demo_external_id', true ), 'CRM-WEB-' );
	}
);
if ( $placeholder_products ) {
	$blockers[] = sprintf( '%d published product family/families still use bootstrap placeholder records.', count( $placeholder_products ) );
}

$published_cases = get_posts(
	array(
		'post_type'      => 'demo_case_study',
		'post_status'    => 'publish',
		'posts_per_page' => -1,
		'fields'         => 'ids',
		'no_found_rows'  => true,
	)
);
$unauthorized_cases = array_filter(
	$published_cases,
	static function ( int $case_id ): bool {
		return ! function_exists( 'demo_manufacturer_core_case_is_approved_for_publication' )
			|| ! demo_manufacturer_core_case_is_approved_for_publication( $case_id );
	}
);
if ( $unauthorized_cases ) {
	$blockers[] = sprintf( '%d published case study/studies lack evidence verification or publication authorization.', count( $unauthorized_cases ) );
}

$smtp_settings = (array) get_option( 'wp_mail_smtp', array() );
$smtp_mailer   = (string) ( $smtp_settings['mail']['mailer'] ?? '' );
if ( '' === $smtp_mailer || 'mail' === $smtp_mailer ) {
	$blockers[] = 'WP Mail SMTP is still using the unauthenticated PHP mail transport.';
}

$files_interval    = (string) get_option( 'updraft_interval', '' );
$database_interval = (string) get_option( 'updraft_interval_database', '' );
$backup_service    = get_option( 'updraft_service', '' );
if ( '' === $files_interval || 'manual' === $files_interval || '' === $database_interval || 'manual' === $database_interval ) {
	$blockers[] = 'Scheduled file and database backups are not both configured in UpdraftPlus.';
}
if ( empty( $backup_service ) ) {
	$blockers[] = 'An off-site UpdraftPlus backup destination is not configured.';
}

global $wpdb;
$submission_table = $wpdb->prefix . 'fluentform_submissions';
if ( $submission_table === $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $submission_table ) ) ) {
	$submission_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$submission_table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	if ( $submission_count > 0 && 'production' !== wp_get_environment_type() ) {
		$warnings[] = sprintf( '%d local/staging inquiry submission(s) should be reviewed before creating a production database snapshot.', $submission_count );
	}
}

$not_found_table = $wpdb->prefix . 'rank_math_404_logs';
if ( $not_found_table === $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $not_found_table ) ) ) {
	$not_found_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$not_found_table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	if ( $not_found_count > 0 && 'production' !== wp_get_environment_type() ) {
		$warnings[] = sprintf( '%d local/staging 404-monitor row(s) should be reviewed before creating a production database snapshot.', $not_found_count );
	}
}

foreach ( $warnings as $warning ) {
	WP_CLI::warning( $warning );
}
foreach ( $blockers as $blocker ) {
	WP_CLI::log( 'BLOCKER: ' . $blocker );
}

if ( $blockers ) {
	WP_CLI::error( sprintf( 'Launch readiness failed with %d blocker(s). No data was changed.', count( $blockers ) ) );
}

WP_CLI::success( 'Launch readiness checks passed. Complete the manual delivery, inbox and restore tests in the launch runbook.' );
