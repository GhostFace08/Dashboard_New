/**
 * auto_escalation.js — Auto-Escalation placeholder page (Phase 11)
 *
 * Per decision #5: blank/under-development placeholder. This page carries
 * no data or logic — real escalation-rule integration is a separate,
 * future discussion, explicitly out of scope here. This file exists only
 * so the page follows the same load/header convention as every other page
 * (Utils.initHeader() + lucide icon refresh + the onTabActivated hook the
 * shell expects every tab to expose, even when it's a no-op).
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

  /* No data to load — present for parity with the shell's tab-activation
     contract (Shell calls this on every tab it hosts). */
  global.onTabActivated = function onTabActivated(/* isFirstActivation */) {};

})(window);
