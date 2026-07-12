/* Divinity theme — minimal progressive-enhancement JS */
(function () {
  'use strict';

  /* Mobile nav toggle */
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-menu-toggle]');
    if (toggle) {
      var nav = document.getElementById('SiteNav');
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.toggle('nav-locked', open);
    }
    if (e.target.closest('[data-menu-close]')) {
      var n = document.getElementById('SiteNav');
      if (n) n.classList.remove('is-open');
      document.body.classList.remove('nav-locked');
    }
    // Mobile: expand/collapse a nav item's submenu
    var sub = e.target.closest('[data-submenu]');
    if (sub) {
      e.preventDefault();
      var item = sub.closest('.nav-item');
      if (item) item.classList.toggle('is-open');
    }
  });

  /* Search overlay */
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-search-toggle]')) {
      var s = document.getElementById('SearchOverlay');
      if (s) { s.hidden = !s.hidden; if (!s.hidden) { var i = s.querySelector('input[type=search]'); if (i) i.focus(); } }
    }
    if (e.target.closest('[data-search-close]')) {
      var so = document.getElementById('SearchOverlay'); if (so) so.hidden = true;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var so = document.getElementById('SearchOverlay'); if (so && !so.hidden) so.hidden = true;
    }
  });

  /* Sticky-header shadow on scroll */
  var header = document.querySelector('[data-header]');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-stuck', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* Client-side filter chips on collection / grids (data-filter) */
  document.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-filter]');
    if (!chip) return;
    var group = chip.closest('[data-filter-group]');
    if (!group) return;
    var key = chip.getAttribute('data-filter');
    group.querySelectorAll('[data-filter]').forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
    var target = document.getElementById(group.getAttribute('data-filter-target'));
    if (!target) return;
    target.querySelectorAll('[data-tags]').forEach(function (item) {
      var tags = item.getAttribute('data-tags') || '';
      item.hidden = !(key === 'all' || tags.split(' ').indexOf(key) !== -1);
    });
  });

  /* Quantity steppers */
  document.addEventListener('click', function (e) {
    var step = e.target.closest('[data-qty]');
    if (!step) return;
    var input = step.parentNode.querySelector('input[type=number]');
    if (!input) return;
    var v = parseInt(input.value, 10) || 1;
    v += step.getAttribute('data-qty') === 'up' ? 1 : -1;
    input.value = Math.max(parseInt(input.min || '1', 10), v);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
})();
