/**
 * about_faq.js — About & FAQ static placeholder page (Phase 12)
 *
 * Static content only, no data fetching. This file exists so the page
 * follows the same load/header convention as every other page
 * (Utils.initHeader() + lucide icon refresh + the onTabActivated hook the
 * shell expects every tab to expose, even when it's a no-op) — same
 * reasoning as auto_escalation.js (Phase 11).
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 */

(function (global) {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }
    if (global.lucide) {
      global.lucide.createIcons();
    }
  });

  global.onTabActivated = function onTabActivated(/* isFirstActivation */) {};

})(window);
