(function () {
	'use strict';

	const toggle = document.querySelector('[data-menu-toggle]');
	const navigation = document.querySelector('[data-navigation]');

	if (toggle && navigation) {
		const closeMenu = function () {
			toggle.setAttribute('aria-expanded', 'false');
			navigation.classList.remove('is-open');
			document.body.classList.remove('menu-open');
		};

		toggle.addEventListener('click', function () {
			const opening = toggle.getAttribute('aria-expanded') !== 'true';
			toggle.setAttribute('aria-expanded', String(opening));
			navigation.classList.toggle('is-open', opening);
			document.body.classList.toggle('menu-open', opening);
		});

		navigation.addEventListener('click', function (event) {
			if (event.target.closest('a') && window.matchMedia('(max-width: 68rem)').matches) {
				closeMenu();
			}
		});

		document.addEventListener('keydown', function (event) {
			if (event.key === 'Escape' && navigation.classList.contains('is-open')) {
				closeMenu();
				toggle.focus();
			}
		});

		window.addEventListener('resize', function () {
			if (!window.matchMedia('(max-width: 68rem)').matches) {
				closeMenu();
			}
		});
	}

	document.querySelectorAll('[data-product-gallery]').forEach(function (gallery) {
		const mainImage = gallery.querySelector('[data-product-gallery-main]');
		const thumbnails = gallery.querySelectorAll('[data-gallery-src]');

		if (!mainImage || thumbnails.length < 2) {
			return;
		}

		thumbnails.forEach(function (thumbnail) {
			thumbnail.addEventListener('click', function () {
				mainImage.src = thumbnail.dataset.gallerySrc;
				mainImage.alt = thumbnail.dataset.galleryAlt || '';
				mainImage.removeAttribute('srcset');
				mainImage.removeAttribute('sizes');

				thumbnails.forEach(function (item) {
					item.setAttribute('aria-pressed', String(item === thumbnail));
				});
			});
		});
	});
}());
