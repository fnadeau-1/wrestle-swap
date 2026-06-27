/**
 * event-dispatch.js
 * Replaces all inline on* event handler attributes with data-* attribute delegation.
 * Loaded on every page so onclick/onchange/etc. can be removed from HTML while keeping
 * safe external-script-only CSP (no unsafe-inline in script-src).
 */
document.addEventListener('DOMContentLoaded', function () {

  // data-href="url" → navigate on click
  document.querySelectorAll('[data-href]').forEach(function (el) {
    el.addEventListener('click', function () {
      window.location.href = this.dataset.href;
    });
  });

  // data-href-blank="url" → open in new tab
  document.querySelectorAll('[data-href-blank]').forEach(function (el) {
    el.addEventListener('click', function () {
      window.open(this.dataset.hrefBlank, '_blank');
    });
  });

  // data-action="print" → window.print()
  document.querySelectorAll('[data-action="print"]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      window.print();
    });
  });

  // data-action="signin-redirect" → sign-in with current-page redirect
  document.querySelectorAll('[data-action="signin-redirect"]').forEach(function (el) {
    el.addEventListener('click', function () {
      window.location.href =
        'sign-in.html?redirect=' +
        encodeURIComponent(window.location.pathname + window.location.search);
    });
  });

  // data-onclick="fn" or "fn1,fn2" → call window.fn() on click
  document.querySelectorAll('[data-onclick]').forEach(function (el) {
    el.addEventListener('click', function () {
      this.dataset.onclick.split(',').forEach(function (fn) {
        var f = window[fn.trim()];
        if (typeof f === 'function') f();
      });
    });
  });

  // data-onclick-self="fn" → call window.fn(element) on click
  document.querySelectorAll('[data-onclick-self]').forEach(function (el) {
    el.addEventListener('click', function () {
      var f = window[this.dataset.onclickSelf];
      if (typeof f === 'function') f(this);
    });
  });

  // data-onclick-event="fn" → call window.fn(event) on click (e.g. modal close checks event.target)
  document.querySelectorAll('[data-onclick-event]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      var f = window[this.dataset.onclickEvent];
      if (typeof f === 'function') f(e);
    });
  });

  // data-onclick-overlay="fn" → call window.fn() only when click is on the overlay itself
  document.querySelectorAll('[data-onclick-overlay]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (e.target === this) {
        var f = window[this.dataset.onclickOverlay];
        if (typeof f === 'function') f();
      }
    });
  });

  // data-onchange="fn" or "fn1,fn2" → call window.fn() on change
  document.querySelectorAll('[data-onchange]').forEach(function (el) {
    el.addEventListener('change', function () {
      this.dataset.onchange.split(',').forEach(function (fn) {
        var f = window[fn.trim()];
        if (typeof f === 'function') f();
      });
    });
  });

  // data-oninput="fn" or "fn1,fn2" → call window.fn() on input
  document.querySelectorAll('[data-oninput]').forEach(function (el) {
    el.addEventListener('input', function () {
      this.dataset.oninput.split(',').forEach(function (fn) {
        var f = window[fn.trim()];
        if (typeof f === 'function') f();
      });
    });
  });

  // data-oninput-value="fn" → call window.fn(this.value) on input
  document.querySelectorAll('[data-oninput-value]').forEach(function (el) {
    el.addEventListener('input', function () {
      var f = window[this.dataset.oninputValue];
      if (typeof f === 'function') f(this.value);
    });
  });

  // data-onenter="fn" → call window.fn() when Enter key is pressed
  document.querySelectorAll('[data-onenter]').forEach(function (el) {
    el.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') {
        var f = window[this.dataset.onenter];
        if (typeof f === 'function') f();
      }
    });
  });

  // data-upload-trigger="elementId" → click target element on Enter or Space
  document.querySelectorAll('[data-upload-trigger]').forEach(function (el) {
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var target = document.getElementById(this.dataset.uploadTrigger);
        if (target) target.click();
      }
    });
  });

  // data-click-trigger="id" → click element by id on click
  document.querySelectorAll('[data-click-trigger]').forEach(function (el) {
    el.addEventListener('click', function () {
      var target = document.getElementById(this.dataset.clickTrigger);
      if (target) target.click();
    });
  });

  // data-onclick-with-arg="fn,arg" → call window.fn('arg') on click
  document.querySelectorAll('[data-onclick-with-arg]').forEach(function (el) {
    el.addEventListener('click', function () {
      var parts = this.dataset.onclickWithArg.split(',');
      var f = window[parts[0]];
      if (typeof f === 'function') f(parts[1]);
    });
  });

  // data-onclick-with-arg-self="fn,arg" → call window.fn('arg', element) on click
  document.querySelectorAll('[data-onclick-with-arg-self]').forEach(function (el) {
    el.addEventListener('click', function () {
      var parts = this.dataset.onclickWithArgSelf.split(',');
      var f = window[parts[0]];
      if (typeof f === 'function') f(parts[1], this);
    });
  });

  // data-hide-el="id" → set element display:none on click
  document.querySelectorAll('[data-hide-el]').forEach(function (el) {
    el.addEventListener('click', function () {
      var target = document.getElementById(this.dataset.hideEl);
      if (target) target.style.display = 'none';
    });
  });

  // data-dismiss="id" → hide element and remove show/active classes on click
  document.querySelectorAll('[data-dismiss]').forEach(function (el) {
    el.addEventListener('click', function () {
      var target = document.getElementById(this.dataset.dismiss);
      if (target) {
        target.style.display = 'none';
        target.classList.remove('show', 'active');
      }
    });
  });

  // data-onchange-value="fn" → call window.fn(this.value) on change
  document.querySelectorAll('[data-onchange-value]').forEach(function (el) {
    el.addEventListener('change', function () {
      var f = window[this.dataset.onchangeValue];
      if (typeof f === 'function') f(this.value);
    });
  });

});
