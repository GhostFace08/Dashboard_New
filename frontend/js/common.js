/**
 * common.js — Unified MCP Dashboard
 *
 * Renders the shared navigation chrome (sidebar or fallback header + theme
 * toggle) and exposes window.Utils — shared formatters, parsers, and
 * normalizers used across all page JS files.
 *
 * ── Change 5: SPA Shell mode ──────────────────────────────────────────────────
 *
 * The app now runs as a single-page shell (index.html) that hosts each page
 * inside a persistent <iframe>.  The shell calls Utils.initHeader() once and
 * owns the nav chrome DOM.  Page iframes must NOT render a second copy.
 *
 * initHeader() detects its execution context:
 *
 *   1. Shell (index.html, window === top, #frame-container present)
 *      → Renders the collapsible sidebar into shell's #sidebar-root, built
 *        from window.CFG.SIDEBAR_NAV (config.js) — grouped sections, one
 *        source of truth shared with index.html's iframe registry.
 *      → Uses shell-relative hrefs for nav links (pages/xxx.html).
 *      → Theme toggle propagates to all frames via window.Shell.propagateTheme().
 *      → Collapse state persists in localStorage, independent of theme.
 *
 *   2. Page iframe (window !== top)
 *      → Returns immediately — the shell owns the nav chrome.
 *
 *   3. Standalone page opened directly (dev / fallback — window === top,
 *      but #frame-container is absent)
 *      → Renders the ORIGINAL flat top header into #header-root using
 *        page-relative hrefs (TABS_STANDALONE, unchanged from pre-Phase-3
 *        behaviour). Every page/*.html still carries a #header-root div for
 *        exactly this case — only the shell's chrome changed.
 *
 * LOAD ORDER (every HTML page must still follow for its own JS deps):
 *   1. config.js   → window.CFG
 *   2. api.js      → window.API
 *   3. common.js   → window.Utils   (this file)
 *   4. page JS
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[common.js] window.CFG not found — load config.js first.");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     1. THEME
  ═══════════════════════════════════════════════════════════════════════════ */

  var THEME_KEY = "mcp-theme";

  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || "dark"; }
    catch (e) { return "dark"; }
  }

  function applyTheme(theme) {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }

  function toggleTheme() {
    var next = getTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);

    /* Propagate to all iframes when running in the shell */
    if (global.Shell && typeof global.Shell.propagateTheme === "function") {
      global.Shell.propagateTheme(next);
    }

    /* Swap the icon without re-rendering the whole header */
    var btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.innerHTML = next === "dark"
        ? '<i data-lucide="sun"  style="width:14px;height:14px;display:block"></i>'
        : '<i data-lucide="moon" style="width:14px;height:14px;display:block"></i>';
      if (global.lucide) lucide.createIcons();
    }
  }

  /* Apply stored theme immediately (before first paint) to avoid flash */
  applyTheme(getTheme());

  /* ═══════════════════════════════════════════════════════════════════════════
     2. ACTIVE TAB DETECTION
  ═══════════════════════════════════════════════════════════════════════════ */

  /* Maps a pathname substring to a tab id — order matters, most-specific first */
  var PATH_TO_TAB = [
    { match: "ai_monitoring", tab: "ai-monitoring" },
    { match: "ai_chat",       tab: "ai-chat"       },
    { match: "settings",      tab: "settings"      },
    { match: "dashboard",     tab: "dashboard"     }
  ];

  function detectActiveTab() {
    var path = global.location.pathname.toLowerCase();
    for (var i = 0; i < PATH_TO_TAB.length; i++) {
      if (path.indexOf(PATH_TO_TAB[i].match) !== -1) return PATH_TO_TAB[i].tab;
    }
    return "dashboard";
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     3. TAB DEFINITIONS
  ═══════════════════════════════════════════════════════════════════════════ */

  /*
   * STANDALONE tabs — hrefs relative to a page inside pages/ folder.
   * Used when a page is opened directly (e.g. during development).
   * The shell no longer uses a flat tab list (see SIDEBAR_NAV in config.js
   * for the grouped sidebar structure) — this remains only for the dev
   * fallback described in the file header comment above.
   */
  var TABS_STANDALONE = [
    { id: "dashboard",     label: "Observability", href: "dashboard.html"     },
    { id: "ai-chat",       label: "AI Chat",       href: "ai_chat.html"       },
    { id: "ai-monitoring", label: "AI Monitoring", href: "ai_monitoring.html" },
    { id: "settings",      label: "Settings",      href: "settings.html"      }
  ];

  /* ═══════════════════════════════════════════════════════════════════════════
     4. HEADER HTML BUILDER
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildHeaderHTML(activeTab, tabs) {
    var theme = getTheme();

    var tabsHTML = tabs.map(function (t) {
      var isActive = t.id === activeTab;
      var checkIcon = isActive
        ? '<i data-lucide="check" style="width:14px;height:14px;display:block;flex-shrink:0"></i>'
        : "";
      return '<a'
        + ' href="' + t.href + '"'
        + ' class="header-tab' + (isActive ? ' active' : '') + '"'
        + ' aria-current="' + (isActive ? 'page' : 'false') + '"'
        + ' data-tab="' + t.id + '"'
        + '>'
        + checkIcon
        + t.label.toUpperCase()
        + '</a>';
    }).join("");

    var themeIcon = theme === "dark" ? "sun" : "moon";

    return '<header id="app-header">'
      + '<div class="header-left">' + tabsHTML + '</div>'
      + '<div class="header-right">'
      + '<button id="theme-toggle-btn" class="header-icon-btn" title="Toggle theme" aria-label="Toggle theme">'
      + '<i data-lucide="' + themeIcon + '" style="width:14px;height:14px;display:block"></i>'
      + '</button>'
      + '<button class="header-btn header-btn-ghost">Sign In</button>'
      + '<button class="header-btn header-btn-primary">Register</button>'
      + '</div>'
      + '</header>';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     5. HEADER CSS  (injected once into <head> — keeps pages clean)
  ═══════════════════════════════════════════════════════════════════════════ */

  var HEADER_CSS = [
    "#app-header{",
      "display:flex;align-items:center;gap:8px;",
      "height:48px;padding:0 16px;",
      "background:var(--sidebar);border-bottom:1px solid var(--border);",
      "flex-shrink:0;position:sticky;top:0;z-index:var(--z-header);",
    "}",
    ".header-left{display:flex;align-items:center;gap:4px;flex:1;}",
    ".header-right{display:flex;align-items:center;gap:8px;flex-shrink:0;}",
    ".header-tab{",
      "display:inline-flex;align-items:center;gap:6px;",
      "padding:6px 16px;",
      "border-radius:var(--radius-sm);border:1px solid transparent;",
      "font-family:var(--font-sans);font-size:13px;font-weight:400;",
      "color:var(--muted-foreground);text-decoration:none;white-space:nowrap;",
      "transition:color var(--transition),background var(--transition),border-color var(--transition);",
    "}",
    ".header-tab:hover{color:var(--foreground);}",
    ".header-tab.active{",
      "background:var(--card);border-color:var(--border);",
      "color:var(--foreground);font-weight:500;",
    "}",
    ".header-tab.active i,.header-tab.active svg{color:var(--primary);}",
    ".header-icon-btn{",
      "width:32px;height:32px;",
      "display:flex;align-items:center;justify-content:center;",
      "border-radius:var(--radius-sm);border:1px solid var(--border);",
      "background:none;color:var(--muted-foreground);cursor:pointer;",
      "transition:color var(--transition),background var(--transition);",
    "}",
    ".header-icon-btn:hover{color:var(--foreground);background:var(--secondary);}",
    ".header-btn{",
      "padding:6px 12px;border-radius:var(--radius-sm);",
      "font-family:var(--font-sans);font-size:12px;cursor:pointer;white-space:nowrap;",
      "transition:color var(--transition),background var(--transition),border-color var(--transition);",
    "}",
    ".header-btn-ghost{border:1px solid var(--border);background:none;color:var(--muted-foreground);}",
    ".header-btn-ghost:hover{color:var(--foreground);background:var(--secondary);}",
    ".header-btn-primary{border:1px solid rgba(99,102,241,0.4);background:rgba(99,102,241,0.1);color:var(--primary);}",
    ".header-btn-primary:hover{background:rgba(99,102,241,0.2);}"
  ].join("");

  function injectHeaderCSS() {
    if (document.getElementById("mcp-header-css")) return;
    var style = document.createElement("style");
    style.id = "mcp-header-css";
    style.textContent = HEADER_CSS;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     5b. SIDEBAR  (Phase 3 — replaces the flat top header inside the shell)

     Grouped, collapsible icon-rail sidebar. Built from window.CFG.SIDEBAR_NAV
     so index.html's iframe registry and this rendering stay in lockstep —
     add a page to that one array and it shows up here automatically.
  ═══════════════════════════════════════════════════════════════════════════ */

  var SIDEBAR_COLLAPSE_KEY = "mcp-sidebar-collapsed";

  /* ── Account profile popup (mock — no real auth backend, decision #4) ──── */
  var MOCK_PROFILE = { username: "admin", password: "Passw0rd!23" };
  var profilePopupInjected = false;

  function injectProfilePopup() {
    if (profilePopupInjected) return;
    profilePopupInjected = true;
    var html = ''
      + '<div id="profile-popup-overlay" class="modal-overlay hidden">'
      +   '<div class="modal-box" style="max-width:360px" onclick="event.stopPropagation()">'
      +     '<div class="modal-header">'
      +       '<h3>Account</h3>'
      +       '<button class="btn-icon" id="profile-popup-close"><i data-lucide="x" style="width:14px;height:14px"></i></button>'
      +     '</div>'
      +     '<div class="modal-body" id="profile-popup-body">'
      +       buildProfileViewHTML()
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.insertAdjacentHTML("beforeend", html);

    document.getElementById("profile-popup-overlay").addEventListener("click", closeProfilePopup);
    document.getElementById("profile-popup-close").addEventListener("click", closeProfilePopup);
    wireProfileViewEvents();
  }

  function buildProfileViewHTML() {
    return ''
      + '<label class="sfield">'
      +   '<span class="sfield-label">Username</span>'
      +   '<input type="text" class="input" value="' + MOCK_PROFILE.username + '" readonly />'
      + '</label>'
      + '<label class="sfield" style="margin-top:10px">'
      +   '<span class="sfield-label">Password</span>'
      +   '<div class="flex gap-2 items-center">'
      +     '<input type="password" id="profile-password-field" class="input input-mono" value="' + MOCK_PROFILE.password + '" readonly style="flex:1" />'
      +     '<button class="btn-icon" id="profile-password-toggle" title="Show/hide password"><i data-lucide="eye" style="width:14px;height:14px"></i></button>'
      +   '</div>'
      + '</label>'
      + '<div class="flex gap-2" style="margin-top:16px">'
      +   '<button class="btn btn-ghost" id="profile-change-pw-btn" style="flex:1;font-size:12px">Change Password</button>'
      +   '<button class="btn btn-destructive" id="profile-logout-btn" style="flex:1;font-size:12px">Log Out</button>'
      + '</div>';
  }

  function buildChangePasswordHTML() {
    return ''
      + '<label class="sfield">'
      +   '<span class="sfield-label">Current Password</span>'
      +   '<input type="password" id="cp-current" class="input input-mono" />'
      + '</label>'
      + '<label class="sfield" style="margin-top:10px">'
      +   '<span class="sfield-label">New Password</span>'
      +   '<input type="password" id="cp-new" class="input input-mono" />'
      + '</label>'
      + '<label class="sfield" style="margin-top:10px">'
      +   '<span class="sfield-label">Confirm New Password</span>'
      +   '<input type="password" id="cp-confirm" class="input input-mono" />'
      + '</label>'
      + '<div class="flex gap-2" style="margin-top:16px">'
      +   '<button class="btn btn-ghost" id="cp-cancel" style="flex:1;font-size:12px">Cancel</button>'
      +   '<button class="btn btn-primary" id="cp-save" style="flex:1;font-size:12px">Save</button>'
      + '</div>';
  }

  function wireProfileViewEvents() {
    var body = document.getElementById("profile-popup-body");
    if (!body) return;

    var pwField = document.getElementById("profile-password-field");
    var pwToggle = document.getElementById("profile-password-toggle");
    if (pwToggle && pwField) {
      pwToggle.addEventListener("click", function () {
        var showing = pwField.type === "text";
        pwField.type = showing ? "password" : "text";
        pwToggle.innerHTML = '<i data-lucide="' + (showing ? "eye" : "eye-off") + '" style="width:14px;height:14px"></i>';
        if (global.lucide) global.lucide.createIcons();
      });
    }

    var changeBtn = document.getElementById("profile-change-pw-btn");
    if (changeBtn) {
      changeBtn.addEventListener("click", function () {
        body.innerHTML = buildChangePasswordHTML();
        wireChangePasswordEvents();
      });
    }

    var logoutBtn = document.getElementById("profile-logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        closeProfilePopup();
        window.alert("Logged out. (No live session to end yet — there's no real authentication behind this UI.)");
      });
    }
  }

  function wireChangePasswordEvents() {
    var body = document.getElementById("profile-popup-body");
    document.getElementById("cp-cancel").addEventListener("click", function () {
      body.innerHTML = buildProfileViewHTML();
      wireProfileViewEvents();
    });
    document.getElementById("cp-save").addEventListener("click", function () {
      var current = document.getElementById("cp-current").value;
      var next    = document.getElementById("cp-new").value;
      var confirm2 = document.getElementById("cp-confirm").value;
      if (current !== MOCK_PROFILE.password) { window.alert("Current password is incorrect."); return; }
      if (!next || next.length < 4) { window.alert("New password must be at least 4 characters."); return; }
      if (next !== confirm2) { window.alert("New password and confirmation do not match."); return; }
      MOCK_PROFILE.password = next;
      body.innerHTML = buildProfileViewHTML();
      wireProfileViewEvents();
      window.alert("Password updated.");
    });
  }

  function openProfilePopup() {
    injectProfilePopup();
    var body = document.getElementById("profile-popup-body");
    if (body) { body.innerHTML = buildProfileViewHTML(); wireProfileViewEvents(); }
    document.getElementById("profile-popup-overlay").classList.remove("hidden");
    if (global.lucide) global.lucide.createIcons();
  }

  function closeProfilePopup() {
    var overlay = document.getElementById("profile-popup-overlay");
    if (overlay) overlay.classList.add("hidden");
  }


  function getSidebarCollapsed() {
    try { return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1"; }
    catch (e) { return false; }
  }

  function setSidebarCollapsed(collapsed) {
    try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (e) {}
    var aside = document.getElementById("app-sidebar");
    if (aside) aside.classList.toggle("collapsed", collapsed);
  }

  /*
   * A page not yet built (SIDEBAR_NAV item.ready === false, Phases 6-12)
   * still gets a nav entry and a live tab — clicking it shows this inline
   * placeholder instead of a broken iframe pointed at a file that doesn't
   * exist yet. index.html swaps it for the real `href` via `ready` the same
   * turn that page's file is delivered — no other change needed here.
   */
  function buildComingSoonSrcdoc(label) {
    return "data:text/html," + encodeURIComponent(
      "<!DOCTYPE html><html><head><meta charset='UTF-8'>"
      + "<style>"
      + "html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;"
      + "font-family:-apple-system,Segoe UI,Inter,sans-serif;background:#14141c;color:#9497ac;}"
      + "@media (prefers-color-scheme: light){html,body{background:#f7f7fb;color:#6b7086;}}"
      + ".wrap{text-align:center;}"
      + ".label{font-size:15px;font-weight:600;margin-bottom:6px;}"
      + ".sub{font-size:12px;opacity:0.8;}"
      + "</style></head><body><div class='wrap'>"
      + "<div class='label'>" + label + "</div>"
      + "<div class='sub'>This section is under development.</div>"
      + "</div></body></html>"
    );
  }

  function buildSidebarHTML(activeTab, collapsed) {
    var groups = (global.CFG && global.CFG.SIDEBAR_NAV) || [];
    var theme = getTheme();
    var themeIcon = theme === "dark" ? "sun" : "moon";

    var groupsHTML = groups.map(function (group) {
      var labelHTML = group.label
        ? '<div class="nav-section-label">' + group.label + '</div>'
        : "";
      var itemsHTML = group.items.map(function (item) {
        var isActive = item.id === activeTab;
        var soonBadge = item.ready ? "" : '<span class="nav-soon-badge">Soon</span>';
        return '<a'
          + ' href="' + item.href + '"'
          + ' class="sidebar-nav-item' + (isActive ? ' active' : '') + '"'
          + ' aria-current="' + (isActive ? 'page' : 'false') + '"'
          + ' data-tab="' + item.id + '"'
          + ' title="' + item.label + '"'
          + '>'
          + '<i data-lucide="' + item.icon + '" class="nav-item-icon"></i>'
          + '<span class="nav-item-label">' + item.label + '</span>'
          + soonBadge
          + '</a>';
      }).join("");
      return '<div class="nav-group">' + labelHTML + itemsHTML + '</div>';
    }).join('<div class="nav-divider"></div>');

    return ''
      + '<aside id="app-sidebar" class="app-sidebar' + (collapsed ? ' collapsed' : '') + '">'
      +   '<div class="sidebar-top">'
      +     '<button id="sidebar-toggle-btn" class="sidebar-icon-btn" title="Toggle sidebar" aria-label="Toggle sidebar">'
      +       '<i data-lucide="menu"></i>'
      +     '</button>'
      +     '<div class="sidebar-brand">'
      +       '<span class="sidebar-brand-mark">M</span>'
      +       '<span class="sidebar-brand-text">MCP Dashboard</span>'
      +     '</div>'
      +     '<button id="theme-toggle-btn" class="sidebar-icon-btn sidebar-top-theme-btn" title="Toggle theme" aria-label="Toggle theme">'
      +       '<i data-lucide="' + themeIcon + '"></i>'
      +     '</button>'
      +   '</div>'
      +   '<nav class="sidebar-nav">' + groupsHTML + '</nav>'
      +   '<div class="sidebar-footer">'
      +     '<div class="sidebar-user" id="sidebar-user-btn" title="Account" role="button" tabindex="0">'
      +       '<div class="sidebar-avatar">A</div>'
      +       '<span class="sidebar-user-name nav-item-label">Admin</span>'
      +     '</div>'
      +   '</div>'
      + '</aside>';
  }

  var SIDEBAR_CSS = [
    ":root{--sidebar-w:240px;--sidebar-w-collapsed:68px;}",
    "#sidebar-root{height:100%;}",
    ".app-sidebar{",
      "display:flex;flex-direction:column;height:100%;width:var(--sidebar-w);",
      "background:var(--sidebar);border-right:1px solid var(--sidebar-border);",
      "flex-shrink:0;overflow:hidden;",
      "transition:width var(--transition);",
    "}",
    ".app-sidebar.collapsed{width:var(--sidebar-w-collapsed);}",

    ".sidebar-top{",
      "display:flex;align-items:center;gap:10px;flex-shrink:0;",
      "height:48px;padding:0 12px;border-bottom:1px solid var(--sidebar-border);",
    "}",
    ".sidebar-brand{display:flex;align-items:center;gap:8px;overflow:hidden;min-width:0;}",
    ".sidebar-brand-mark{",
      "width:22px;height:22px;flex-shrink:0;border-radius:6px;background:var(--gradient-primary,var(--primary));",
      "color:#fff;font-family:var(--font-sans);font-size:12px;font-weight:700;",
      "display:flex;align-items:center;justify-content:center;",
    "}",
    ".sidebar-brand-text{",
      "font-family:var(--font-sans);font-size:13px;font-weight:600;color:var(--sidebar-foreground);",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    "}",
    ".app-sidebar.collapsed .sidebar-brand-text{display:none;}",
    ".app-sidebar.collapsed .sidebar-brand-mark{display:none;}",
    ".app-sidebar.collapsed .sidebar-top{flex-direction:column;justify-content:center;height:auto;padding:8px 0;gap:8px;}",

    ".sidebar-top-theme-btn{margin-left:auto;flex-shrink:0;}",
    ".app-sidebar.collapsed .sidebar-top-theme-btn{margin-left:0;}",

    ".sidebar-nav{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 8px;}",
    ".nav-group{display:flex;flex-direction:column;gap:2px;}",
    ".nav-section-label{",
      "font-family:var(--font-sans);font-size:10px;font-weight:600;letter-spacing:0.06em;",
      "color:var(--muted-foreground);text-transform:uppercase;",
      "padding:8px 10px 4px;white-space:nowrap;",
    "}",
    ".app-sidebar.collapsed .nav-section-label{display:none;}",
    ".nav-divider{height:1px;background:var(--sidebar-border);margin:10px 8px;flex-shrink:0;}",

    ".sidebar-nav-item{",
      "display:flex;align-items:center;gap:10px;",
      "padding:8px 10px;margin:0 0 2px;border-radius:var(--radius-sm);",
      "font-family:var(--font-sans);font-size:13px;font-weight:400;",
      "color:var(--sidebar-foreground);text-decoration:none;white-space:nowrap;",
      "border-left:2px solid transparent;",
      "transition:color var(--transition),background var(--transition),border-color var(--transition);",
    "}",
    ".sidebar-nav-item:hover{background:var(--secondary);color:var(--foreground);}",
    ".sidebar-nav-item.active{",
      "background:var(--secondary);border-left-color:var(--sidebar-primary);",
      "color:var(--foreground);font-weight:500;",
    "}",
    ".sidebar-nav-item.active .nav-item-icon{color:var(--sidebar-primary);}",
    ".nav-item-icon{width:16px;height:16px;flex-shrink:0;display:block;}",
    ".nav-item-label{overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;}",
    ".app-sidebar.collapsed .sidebar-nav-item{justify-content:center;padding:8px;border-left:none;}",
    ".app-sidebar.collapsed .nav-item-label,.app-sidebar.collapsed .nav-soon-badge{display:none;}",

    ".nav-soon-badge{",
      "flex-shrink:0;font-family:var(--font-sans);font-size:9px;font-weight:600;",
      "padding:2px 6px;border-radius:999px;background:var(--muted);color:var(--muted-foreground);",
      "letter-spacing:0.02em;",
    "}",

    ".sidebar-footer{",
      "display:flex;align-items:center;gap:8px;flex-shrink:0;",
      "padding:10px 8px;border-top:1px solid var(--sidebar-border);",
    "}",
    ".sidebar-user{display:flex;align-items:center;gap:8px;overflow:hidden;min-width:0;flex:1 1 auto;cursor:pointer;border:none;background:none;padding:0;border-radius:var(--radius-sm);}",
    ".sidebar-user:hover{background:var(--secondary);}",
    ".sidebar-avatar{",
      "width:26px;height:26px;flex-shrink:0;border-radius:50%;background:var(--secondary);",
      "color:var(--secondary-foreground);font-family:var(--font-sans);font-size:12px;font-weight:600;",
      "display:flex;align-items:center;justify-content:center;",
    "}",
    ".sidebar-user-name{",
      "font-family:var(--font-sans);font-size:12px;color:var(--sidebar-foreground);",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    "}",
    ".app-sidebar.collapsed .sidebar-footer{flex-direction:column;}",

    ".sidebar-icon-btn{",
      "width:30px;height:30px;flex-shrink:0;",
      "display:flex;align-items:center;justify-content:center;",
      "border-radius:var(--radius-sm);border:1px solid var(--border);",
      "background:none;color:var(--muted-foreground);cursor:pointer;",
      "transition:color var(--transition),background var(--transition);",
    "}",
    ".sidebar-icon-btn i,.sidebar-icon-btn svg{width:14px;height:14px;display:block;}",
    ".sidebar-icon-btn:hover{color:var(--foreground);background:var(--secondary);}",

    /* Shell layout: sidebar + frame-container sit side by side now */
    "#app{flex-direction:row;}"
  ].join("");

  function injectSidebarCSS() {
    if (document.getElementById("mcp-sidebar-css")) return;
    var style = document.createElement("style");
    style.id = "mcp-sidebar-css";
    style.textContent = SIDEBAR_CSS;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     6. INIT HEADER  (Change 5 — SPA-aware)
  ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Utils.initHeader(activeTabOverride?)
   *
   * Context-aware header initialiser.
   *
   * @param {string} [activeTabOverride]  Tab id to highlight initially.
   *   In the shell this is the DEFAULT_TAB passed by index.html.
   *   In standalone pages it is auto-detected from window.location.pathname
   *   when omitted.
   */
  function initHeader(activeTabOverride) {
    /* ── 1. Inside an iframe: shell owns the nav chrome — do nothing ── */
    if (global !== global.top) {
      /* Page iframes must NOT render a header/sidebar.  Return silently. */
      return;
    }

    /* ── 2. Detect context: SPA shell vs standalone page ── */
    var isShell = !!document.getElementById("frame-container");
    var activeTab = activeTabOverride || detectActiveTab();

    if (isShell) {
      /* ── SHELL: grouped collapsible sidebar into #sidebar-root ── */
      injectSidebarCSS();

      var sidebarRoot = document.getElementById("sidebar-root");
      if (!sidebarRoot) {
        console.warn("[common.js] #sidebar-root not found — sidebar not injected.");
        return;
      }

      sidebarRoot.innerHTML = buildSidebarHTML(activeTab, getSidebarCollapsed());

      var themeBtn = document.getElementById("theme-toggle-btn");
      if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

      var collapseBtn = document.getElementById("sidebar-toggle-btn");
      if (collapseBtn) {
        collapseBtn.addEventListener("click", function () {
          setSidebarCollapsed(!getSidebarCollapsed());
        });
      }

      var userBtn = document.getElementById("sidebar-user-btn");
      if (userBtn) {
        userBtn.addEventListener("click", openProfilePopup);
        userBtn.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProfilePopup(); }
        });
      }

      /*
       * Nav item clicks are intercepted by the shell's own click listener
       * (in index.html), which calls Shell.showTab() instead of navigating.
       * We do NOT add a second listener here to avoid double-firing.
       */
    } else {
      /* ── STANDALONE: original flat top header into #header-root ── */
      injectHeaderCSS();

      var root = document.getElementById("header-root");
      if (!root) {
        console.warn("[common.js] #header-root not found — header not injected.");
        return;
      }

      root.innerHTML = buildHeaderHTML(activeTab, TABS_STANDALONE);

      var toggleBtn = document.getElementById("theme-toggle-btn");
      if (toggleBtn) toggleBtn.addEventListener("click", toggleTheme);

      /* Tab link clicks in STANDALONE mode navigate normally via href. */
    }

    /* ── Refresh Lucide icons ── */
    if (global.lucide) {
      lucide.createIcons();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     7. UTILS — shared formatters, parsers, and normalizers
  ═══════════════════════════════════════════════════════════════════════════ */

  function formatFullDate(d) {
    if (!d || isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true
    });
  }

  function formatHeaderDate(d) { return formatFullDate(d); }

  function formatDuration(start, end) {
    if (!start || isNaN(start.getTime())) return "—";
    var e = end ? end.getTime() : Date.now();
    if (isNaN(e)) return "—";
    var diff = Math.max(0, e - start.getTime());

    var days    = Math.floor(diff / 86400000); diff -= days    * 86400000;
    var hours   = Math.floor(diff / 3600000);  diff -= hours   * 3600000;
    var minutes = Math.floor(diff / 60000);    diff -= minutes * 60000;
    var seconds = Math.floor(diff / 1000);

    var parts = [];
    if (days)    parts.push(days    + " day"  + (days    > 1 ? "s" : ""));
    if (hours)   parts.push(hours   + " hr"   + (hours   > 1 ? "s" : ""));
    if (minutes) parts.push(minutes + " min"  + (minutes > 1 ? "s" : ""));
    if (seconds || !parts.length) parts.push(seconds + " sec" + (seconds !== 1 ? "s" : ""));
    return parts.join(", ");
  }

  function parseDynatraceTime(str) {
    if (!str) return null;
    var cleaned = str.replace(/\.(\d{3})\d+Z$/, ".$1Z");
    var d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  function parseOpManagerTime(str) {
    if (!str) return null;
    var match = str.match(/^(\d{1,2})\s([A-Za-z]{3})\s(\d{4})\s(\d{1,2}):(\d{2}):(\d{2})\s(AM|PM)\sIST$/);
    if (!match) return null;
    var MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    var h = Number(match[4]);
    if (match[7] === "PM" && h < 12) h += 12;
    if (match[7] === "AM" && h === 12) h = 0;
    var d = new Date(Number(match[3]), MONTHS[match[2]], Number(match[1]), h, Number(match[5]), Number(match[6]));
    return isNaN(d.getTime()) ? null : d;
  }

  function parseSourceTime(raw, source) {
    if (raw === null || raw === undefined || raw === "") return null;
    switch (source) {
      case "dynatrace":   return parseDynatraceTime(String(raw));
      case "opmanager":   return parseOpManagerTime(String(raw));
      case "heal":
      case "appdynamics": {
        var ts = Number(raw);
        if (!isFinite(ts) || ts <= 0) return null;
        var d = new Date(ts);
        return isNaN(d.getTime()) ? null : d;
      }
      default: {
        var d2 = new Date(raw);
        if (!isNaN(d2.getTime())) return d2;
        var ts2 = Number(raw);
        if (isFinite(ts2) && ts2 > 0) { var d3 = new Date(ts2); return isNaN(d3.getTime()) ? null : d3; }
        return null;
      }
    }
  }

  function normalizeSeverity(raw, source) {
    var value = String(raw == null ? "" : raw).trim();
    var lower = value.toLowerCase();
    switch (source) {
      case "dynatrace": {
        var sev = Number(value);
        if (sev >= 4) return "Critical"; if (sev === 3) return "High";
        if (sev === 2) return "Medium";  return "Low";
      }
      case "opmanager":
        if (lower.indexOf("critical") !== -1) return "Critical";
        if (lower.indexOf("major") !== -1 || lower.indexOf("trouble") !== -1) return "High";
        if (lower.indexOf("warning") !== -1 || lower.indexOf("minor") !== -1) return "Medium";
        return "Low";
      case "heal":
        if (lower === "critical") return "Critical"; if (lower === "severe") return "High";
        if (lower === "warning" || lower === "medium") return "Medium"; return "Low";
      case "appdynamics":
        if (lower === "critical") return "Critical"; if (lower === "high") return "High";
        if (lower === "medium" || lower === "warning") return "Medium"; return "Low";
      default:
        if (lower.indexOf("critical") !== -1) return "Critical";
        if (lower.indexOf("high") !== -1 || lower.indexOf("major") !== -1 || lower.indexOf("severe") !== -1) return "High";
        if (lower.indexOf("medium") !== -1 || lower.indexOf("warning") !== -1) return "Medium";
        return "Low";
    }
  }

  function normalizeStatus(raw, source) {
    var s = String(raw == null ? "" : raw).trim().toUpperCase();
    switch (source) {
      case "dynatrace":
        return (["ACTIVE","OPEN","REFRESHED","ONGOING"].indexOf(s) !== -1) ? "Active" : "Resolved";
      case "opmanager":
        return (["CLEAR","CLEARED","RESOLVED"].indexOf(s) !== -1) ? "Resolved" : "Active";
      case "heal":
        return (["OPEN","ACTIVE","ONGOING","NEW"].indexOf(s) !== -1) ? "Active" : "Resolved";
      case "appdynamics":
        return (["OPEN","ACTIVE","ONGOING"].indexOf(s) !== -1) ? "Active" : "Resolved";
      default:
        if (["ACTIVE","OPEN","ONGOING","NEW"].indexOf(s) !== -1) return "Active";
        if (["CLEAR","CLEARED","CLOSED","RESOLVED"].indexOf(s) !== -1) return "Resolved";
        return "Resolved";
    }
  }

  /**
   * normalizeCategory — Change (Settings-driven categorization)
   *
   * Categorization no longer reads a mapped "category" field from the source
   * payload (that mapping is being removed from Settings entirely). Instead
   * it matches keywords the user has defined in Settings → Issue
   * Categorization (backend/data/category.json → categoryRules, shape
   * [{ keyword, category }]) against a free-text blob built from the issue's
   * title + description. First matching rule wins. No match → "Other".
   *
   * searchText: pre-built lowercase-agnostic text (e.g. title + " " + description)
   */
  function normalizeCategory(searchText, categoryRules) {
    var lower = String(searchText == null ? "" : searchText).toLowerCase();
    if (Array.isArray(categoryRules)) {
      for (var j = 0; j < categoryRules.length; j++) {
        var rule = categoryRules[j];
        if (rule && rule.keyword && lower.indexOf(String(rule.keyword).toLowerCase()) !== -1) {
          return rule.category;
        }
      }
    }
    return "Other";
  }

  function resolveField(item, fieldPath) {
    if (!fieldPath || !item) return null;
    var arrayMatch = fieldPath.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      var base = item[arrayMatch[1]];
      return Array.isArray(base) ? (base[Number(arrayMatch[2])] != null ? base[Number(arrayMatch[2])] : null) : null;
    }
    if (fieldPath in item) return item[fieldPath];
    return fieldPath.split(".").reduce(function (cur, seg) {
      if (cur == null || typeof cur !== "object") return null;
      return cur[seg] != null ? cur[seg] : null;
    }, item);
  }

  function detectSource(item) {
    if (!item || typeof item !== "object") return "unknown";
    if (item.display_id !== undefined || item["event.id"] !== undefined) return "dynatrace";
    if (item.alarmId !== undefined || item.deviceName !== undefined)     return "opmanager";
    if (item.signalName !== undefined || item.applicationName !== undefined) return "heal";
    if (item.incidentStatus !== undefined || item.detectedTimeInMillis !== undefined) return "appdynamics";
    return "unknown";
  }

  function normalizeIssue(item, source, mapping, categoryRules, index) {
    var cfg = global.CFG || {};
    var sourceMap = (mapping && mapping[source]) || (cfg.DEFAULT_MAPPING && cfg.DEFAULT_MAPPING[source]) || {};

    var rawIssueId     = resolveField(item, sourceMap.issueId)         || ("#" + index);
    var rawTitle       = resolveField(item, sourceMap.title)           || "—";
    var rawApplication = resolveField(item, sourceMap.application)     || "—";
    var rawAffectedRaw = resolveField(item, sourceMap.affectedEntities);
    var rawSeverity    = resolveField(item, sourceMap.severity);
    var rawStatus      = resolveField(item, sourceMap.status);
    var rawStartTime   = resolveField(item, sourceMap.startTime);
    var rawEndTime     = resolveField(item, sourceMap.endTime);
    var rawDescription = resolveField(item, sourceMap.description)     || "";

    var affectedEntities = Array.isArray(rawAffectedRaw)
      ? rawAffectedRaw.join(", ")
      : String(rawAffectedRaw || rawApplication || "—");

    var severity = normalizeSeverity(rawSeverity, source);
    var category = normalizeCategory(String(rawTitle) + " " + String(rawDescription), categoryRules);
    var status   = normalizeStatus(rawStatus, source);

    var startDate = parseSourceTime(rawStartTime, source);
    var endDate   = parseSourceTime(rawEndTime, source);

    var startTime = formatFullDate(startDate);
    var endTime   = status === "Active" ? "—" : formatFullDate(endDate || startDate);
    var duration  = formatDuration(startDate, status === "Active" ? null : (endDate || startDate));
    var ts        = startDate ? startDate.getTime() : 0;
    var endTs     = endDate ? endDate.getTime() : (status === "Active" ? null : ts);

    return {
      id: rawIssueId + "-" + source + "-" + index,
      source: source,
      issueId: String(rawIssueId),
      application: String(rawApplication),
      title: String(rawTitle),
      affectedEntities: String(affectedEntities),
      severity: severity,
      category: category,
      description: String(rawDescription),
      status: status,
      startTime: startTime,
      endTime: endTime,
      duration: duration,
      ts: ts,
      endTs: endTs
    };
  }

  function normalizeAllIssues(rawData, mapping, categoryRules) {
    var groups = Array.isArray(rawData && rawData.allIssues)
      ? rawData.allIssues
      : Array.isArray(rawData) ? rawData : [];

    var rows = [];
    groups.forEach(function (group) {
      var items = Array.isArray(group) ? group : (Array.isArray(group && group.data) ? group.data : []);
      items.forEach(function (item) {
        var source = detectSource(item);
        var row    = normalizeIssue(item, source, mapping, categoryRules, rows.length);
        rows.push(Object.assign({}, row, { srNo: rows.length + 1 }));
      });
    });
    return rows;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Category accent colors — deterministic hash → palette, since categories
     are now user-defined in Settings and can't be hardcoded per name.
  ═══════════════════════════════════════════════════════════════════════════ */
  var CATEGORY_PALETTE = [
    "var(--accent-indigo)",
    "var(--accent-teal)",
    "var(--accent-amber)",
    "var(--accent-rose)",
    "var(--accent-violet)",
    "var(--accent-green)",
    "var(--accent-cyan)",
    "var(--accent-orange)",
  ];
  var OTHER_COLOR = "var(--muted-foreground)";

  function categoryColor(name) {
    if (!name || name === "Other") return OTHER_COLOR;
    var str = String(name);
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    var idx = Math.abs(hash) % CATEGORY_PALETTE.length;
    return CATEGORY_PALETTE[idx];
  }

  function toDatetimeLocalValue(d) {
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments;
      var ctx  = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function refreshIcons() {
    if (global.lucide) lucide.createIcons();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     7b. TOASTS — small floating top-right confirmation popups
     Utils.showToast(message, type?, opts?)
       type: "success" | "error" | "info" | "warning"  (default "info")
       opts.duration: ms before auto-dismiss (default 5000)
     Used for save/test/change confirmations (Settings, User Management, ...).
     Works in every document that loads common.js — including page iframes,
     which each have their own document and so need their own container —
     no dependency on the shell/sidebar being present.
  ═══════════════════════════════════════════════════════════════════════════ */

  var TOAST_CSS = [
    "#mcp-toast-root{",
      "position:fixed;top:14px;right:14px;z-index:9999;",
      "display:flex;flex-direction:column;gap:8px;",
      "max-width:320px;pointer-events:none;",
    "}",
    ".mcp-toast{",
      "pointer-events:auto;display:flex;align-items:flex-start;gap:8px;",
      "min-width:200px;max-width:320px;padding:9px 10px;border-radius:var(--radius-sm);",
      "background:var(--card);color:var(--card-foreground);",
      "box-shadow:var(--shadow-card-hover);border:1px solid var(--border);",
      "border-left:3px solid var(--muted-foreground);",
      "font-family:var(--font-sans);font-size:12px;line-height:1.45;",
      "opacity:0;transform:translateX(16px);",
      "transition:opacity 180ms ease,transform 180ms ease;",
    "}",
    ".mcp-toast.show{opacity:1;transform:translateX(0);}",
    ".mcp-toast.hide{opacity:0;transform:translateX(16px);}",
    ".mcp-toast.success{border-left-color:var(--accent-green,#10b981);}",
    ".mcp-toast.error{border-left-color:var(--accent-red,#e5534b);}",
    ".mcp-toast.warning{border-left-color:var(--accent-amber,#e5a030);}",
    ".mcp-toast.info{border-left-color:var(--accent-indigo,#6366f1);}",
    ".mcp-toast-icon{flex-shrink:0;width:15px;height:15px;margin-top:1px;}",
    ".mcp-toast-icon.success{color:var(--accent-green,#10b981);}",
    ".mcp-toast-icon.error{color:var(--accent-red,#e5534b);}",
    ".mcp-toast-icon.warning{color:var(--accent-amber,#e5a030);}",
    ".mcp-toast-icon.info{color:var(--accent-indigo,#6366f1);}",
    ".mcp-toast-msg{flex:1 1 auto;min-width:0;word-break:break-word;}",
    ".mcp-toast-close{",
      "flex-shrink:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center;",
      "border-radius:4px;color:var(--muted-foreground);margin:-2px -2px 0 0;",
    "}",
    ".mcp-toast-close:hover{background:var(--secondary);color:var(--foreground);}",
  ].join("");

  function injectToastCSS() {
    if (document.getElementById("mcp-toast-css")) return;
    var style = document.createElement("style");
    style.id = "mcp-toast-css";
    style.textContent = TOAST_CSS;
    document.head.appendChild(style);
  }

  function getToastRoot() {
    injectToastCSS();
    var root = document.getElementById("mcp-toast-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "mcp-toast-root";
      document.body.appendChild(root);
    }
    return root;
  }

  var TOAST_ICONS = {
    success: "check-circle-2",
    error:   "x-circle",
    warning: "alert-triangle",
    info:    "info"
  };

  /**
   * Utils.showToast(message, type, opts)
   * Small color-coded floating popup, top-right, auto-dismisses after
   * opts.duration ms (default 5000) and always has a manual close button.
   */
  function showToast(message, type, opts) {
    type = (type === "success" || type === "error" || type === "warning") ? type : "info";
    var duration = (opts && typeof opts.duration === "number") ? opts.duration : 5000;

    var root = getToastRoot();
    var el = document.createElement("div");
    el.className = "mcp-toast " + type;
    el.setAttribute("role", type === "error" ? "alert" : "status");

    var iconName = TOAST_ICONS[type];
    el.innerHTML =
        '<i data-lucide="' + iconName + '" class="mcp-toast-icon ' + type + '"></i>'
      + '<span class="mcp-toast-msg"></span>'
      + '<button type="button" class="mcp-toast-close" aria-label="Dismiss" title="Dismiss">'
      +   '<i data-lucide="x" style="width:12px;height:12px;display:block"></i>'
      + '</button>';
    /* Message set via textContent (not innerHTML) so caller-supplied text
       can never inject markup. */
    el.querySelector(".mcp-toast-msg").textContent = message;

    root.appendChild(el);
    if (global.lucide && typeof global.lucide.createIcons === "function") {
      global.lucide.createIcons({ nameAttr: "data-lucide", attrs: {}, icons: undefined });
    }

    var dismissed = false;
    var timer = null;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      el.classList.remove("show");
      el.classList.add("hide");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }

    el.querySelector(".mcp-toast-close").addEventListener("click", dismiss);
    timer = setTimeout(dismiss, duration);

    /* Trigger enter transition on next frame */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add("show"); });
    });

    return { dismiss: dismiss };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     8. PUBLIC SURFACE
  ═══════════════════════════════════════════════════════════════════════════ */

  global.Utils = Object.freeze({
    /* Header */
    initHeader:   initHeader,
    toggleTheme:  toggleTheme,
    getTheme:     getTheme,
    applyTheme:   applyTheme,
    refreshIcons: refreshIcons,

    /* Toasts */
    showToast: showToast,

    /* Sidebar (shell only) */
    getSidebarCollapsed:     getSidebarCollapsed,
    setSidebarCollapsed:     setSidebarCollapsed,
    buildComingSoonSrcdoc:   buildComingSoonSrcdoc,

    /* Formatters */
    formatFullDate:        formatFullDate,
    formatHeaderDate:      formatHeaderDate,
    formatDuration:        formatDuration,
    toDatetimeLocalValue:  toDatetimeLocalValue,
    escapeHtml:            escapeHtml,
    debounce:              debounce,

    /* Parsers */
    parseDynatraceTime: parseDynatraceTime,
    parseOpManagerTime: parseOpManagerTime,
    parseSourceTime:    parseSourceTime,

    /* Normalizers */
    normalizeSeverity:  normalizeSeverity,
    normalizeStatus:    normalizeStatus,
    normalizeCategory:  normalizeCategory,
    resolveField:       resolveField,
    detectSource:       detectSource,
    normalizeIssue:     normalizeIssue,
    normalizeAllIssues: normalizeAllIssues,
    categoryColor:      categoryColor
  });

})(window);