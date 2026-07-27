/**
 * user_management.js — User Management page logic (Phase 10)
 *
 * Per decision #4: no real authentication/login enforcement — this is
 * UI + a persisted user list only. Add User modal (username, password,
 * server-visibility restrictions) → row list with Edit/Delete → Edit modal
 * (same fields, pre-filled).
 *
 * PERSISTENCE — backed by AdminMiddleware's /api/users endpoint
 *   (backend/data/users.json) via API.getUsers()/API.saveUsers(). Every
 *   read/write still funnels through loadUsers()/saveUsers() so the rest of
 *   this file didn't need to change shape when the backend became real.
 *
 *   Passwords are stored as plain text in this placeholder store. That is
 *   ONLY acceptable because there is no real auth behind this yet (decision
 *   #4) — if/when real authentication is introduced, this must be replaced
 *   with a proper backend that hashes credentials server-side. Flagging
 *   this loudly so it isn't missed later.
 *
 * SERVER LIST — same live-MCP-servers pattern as dashboard.js/topology.js.
 *   Permissions here are per configured MCP server, not per fixed "tool".
 *   Reads backend/data/mcpconf.ini via API.getMcpServers() (the same
 *   admin-defined list Settings → MCP Servers edits) and falls back to
 *   CFG.TOOLS only if no servers are configured yet, so the page still
 *   renders something sensible on a fresh install.
 *
 * ADMIN ROW — the built-in "admin" bootstrap account is not a manageable
 *   user and is intentionally not seeded/listed here; this table only
 *   ever shows accounts an admin has explicitly created.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG   (TOOLS, legacy fallback for the server-
 *                visibility checkboxes)
 *   api.js     → window.API   (API.getMcpServers(), API.getUsers(), API.saveUsers())
 *   common.js  → window.Utils
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[user_management.js] CFG not found — did config.js load?");
    return;
  }

  /* Live MCP servers list — populated by loadServers(), falls back to
     CFG.TOOLS (legacy fixed 4) if no servers are configured yet. */
  let SERVERS = global.CFG.TOOLS || [];

  async function loadServers() {
    try {
      if (global.API && typeof global.API.getMcpServers === "function") {
        const { servers } = await global.API.getMcpServers();
        if (Array.isArray(servers) && servers.length > 0) {
          SERVERS = servers.map(s => ({
            id:        s.id,
            name:      s.name,
            shortName: s.shortName || (s.name || s.id || "").slice(0, 2).toUpperCase(),
            color:     s.color || "#6366f1",
          }));
        }
      }
    } catch (e) {
      console.warn("[user_management] getMcpServers failed, falling back to CFG.TOOLS:", e);
    }
  }

  const state = {
    users: [],
    search: "",
    editingId: null, // null = Add mode, otherwise the user id being edited
    loaded: false,
  };

  /* ─── Store (real backend — AdminMiddleware's users.json) ────────────────
   * ID scheme fix: previously `user-${idCounter++}` with idCounter reset to
   * 1 on every page load, while the actual user list persisted — so after
   * a reload, newly-created users could collide with an existing id (two
   * different accounts both named "user-1"), and Edit/Delete would then
   * act on whichever one `.find()` hit first. Now mixes Date.now() into
   * the id, same fix topology.js already used for its node ids.
   */
  async function loadUsers() {
    try {
      const { users } = await global.API.getUsers();
      if (Array.isArray(users) && users.length > 0) return users;
    } catch (e) {
      console.warn("[user_management] getUsers failed:", e);
    }
    return seedUsers();
  }

  async function saveUsers(users) {
    try {
      const result = await global.API.saveUsers({ users });
      if (!result || !result.ok) {
        console.warn("[user_management] saveUsers did not confirm ok:true");
      }
    } catch (e) {
      console.warn("[user_management] failed to persist user list:", e);
    }
  }

  let idCounter = 1;
  function nextId() { return `user-${Date.now().toString(36)}-${idCounter++}`; }

  function seedUsers() {
    // No "admin" row here on purpose — the built-in admin account isn't a
    // manageable user (see ADMIN ROW note above). Only example non-admin
    // accounts are seeded.
    const users = [
      { id: nextId(), username: "ops-viewer", password: "viewonly2024", servers: SERVERS.slice(0, 2).map(s => s.id), createdAt: new Date().toISOString() },
    ];
    saveUsers(users);
    return users;
  }

  /* ─── Rendering: table ────────────────────────────────────────────────── */
  function initials(username) {
    return (username || "?").trim().slice(0, 2).toUpperCase();
  }

  function serverChipsHtml(servers) {
    if (!servers || !servers.length) return `<span class="um-tool-chip">None</span>`;
    if (servers.includes("all")) return `<span class="um-tool-chip all">All Servers</span>`;
    return servers.map(id => {
      const server = SERVERS.find(s => s.id === id);
      return `<span class="um-tool-chip">${Utils.escapeHtml(server ? server.shortName || server.name : id)}</span>`;
    }).join("");
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) { return "—"; }
  }

  function renderTable() {
    const tbody = document.getElementById("um-table-body");
    if (!tbody) return;

    const q = state.search.trim().toLowerCase();
    const rows = state.users.filter(u => !q || u.username.toLowerCase().includes(q));

    if (!rows.length) {
      tbody.innerHTML = `<tr class="um-empty-row"><td colspan="4">No users found.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(u => `
      <tr data-id="${Utils.escapeHtml(u.id)}">
        <td>
          <div class="um-user-cell">
            <div class="um-avatar">${Utils.escapeHtml(initials(u.username))}</div>
            <span class="um-username">${Utils.escapeHtml(u.username)}</span>
          </div>
        </td>
        <td><div class="um-tool-chips">${serverChipsHtml(u.servers)}</div></td>
        <td><span style="font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)">${formatDate(u.createdAt)}</span></td>
        <td>
          <div class="um-row-actions">
            <button class="btn-icon um-edit-btn" type="button" data-id="${Utils.escapeHtml(u.id)}" title="Edit"><i data-lucide="pencil"></i></button>
            <button class="btn-icon um-delete-btn" type="button" data-id="${Utils.escapeHtml(u.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll(".um-edit-btn").forEach(btn =>
      btn.addEventListener("click", () => openModal(btn.getAttribute("data-id")))
    );
    tbody.querySelectorAll(".um-delete-btn").forEach(btn =>
      btn.addEventListener("click", () => deleteUser(btn.getAttribute("data-id")))
    );

    Utils.refreshIcons();
  }

  /* ─── Server-visibility checkbox list ─────────────────────────────────── */
  function renderServerCheckboxes(selectedServers) {
    const el = document.getElementById("um-tools-checkbox-list");
    if (!el) return;
    const hasAll = (selectedServers || []).includes("all");

    const allRow = `
      <label class="um-checkbox-row all-row">
        <input type="checkbox" id="um-tool-all" ${hasAll ? "checked" : ""} />
        All Servers
      </label>
    `;
    const serverRows = SERVERS.map(s => `
      <label class="um-checkbox-row">
        <input type="checkbox" class="um-tool-item" value="${Utils.escapeHtml(s.id)}" ${!hasAll && (selectedServers || []).includes(s.id) ? "checked" : ""} ${hasAll ? "disabled" : ""} />
        <span class="swatch" style="background:${s.color || "var(--accent-indigo,#6366f1)"}"></span>${Utils.escapeHtml(s.name)}
      </label>
    `).join("");

    el.innerHTML = allRow + serverRows;

    const allCheckbox = document.getElementById("um-tool-all");
    allCheckbox.addEventListener("change", () => {
      el.querySelectorAll(".um-tool-item").forEach(cb => {
        cb.disabled = allCheckbox.checked;
        if (allCheckbox.checked) cb.checked = false;
      });
    });
  }

  function readSelectedServers() {
    const allCheckbox = document.getElementById("um-tool-all");
    if (allCheckbox && allCheckbox.checked) return ["all"];
    return Array.from(document.querySelectorAll(".um-tool-item:checked")).map(cb => cb.value);
  }

  /* ─── Modal ───────────────────────────────────────────────────────────── */
  function openModal(userId) {
    state.editingId = userId || null;
    const title = document.getElementById("um-modal-title");
    const usernameInput = document.getElementById("um-username-input");
    const passwordInput = document.getElementById("um-password-input");
    const passwordHint = document.getElementById("um-password-hint");

    if (userId) {
      const user = state.users.find(u => u.id === userId);
      if (!user) return;
      title.textContent = "Edit User";
      usernameInput.value = user.username;
      passwordInput.value = user.password;
      passwordHint.textContent = "Leave unchanged unless you want to reset it.";
      renderServerCheckboxes(user.servers);
    } else {
      title.textContent = "Add User";
      usernameInput.value = "";
      passwordInput.value = "";
      passwordHint.textContent = "Minimum 8 characters.";
      renderServerCheckboxes([]);
    }

    document.getElementById("um-modal-overlay").classList.remove("hidden");
    Utils.refreshIcons();
  }

  function closeModal() {
    document.getElementById("um-modal-overlay").classList.add("hidden");
    state.editingId = null;
  }

  async function saveModal() {
    const username = document.getElementById("um-username-input").value.trim();
    const password = document.getElementById("um-password-input").value;
    const servers = readSelectedServers();

    if (!username) {
      Utils.showToast ? Utils.showToast("Username is required", "error") : alert("Username is required");
      return;
    }
    if (!password || password.length < 8) {
      Utils.showToast ? Utils.showToast("Password must be at least 8 characters", "error") : alert("Password must be at least 8 characters");
      return;
    }

    if (state.editingId) {
      const user = state.users.find(u => u.id === state.editingId);
      if (user) {
        user.username = username;
        user.password = password;
        user.servers = servers;
      }
    } else {
      state.users.push({
        id: nextId(), username, password, servers,
        createdAt: new Date().toISOString(),
      });
    }

    await saveUsers(state.users);
    renderTable();
    closeModal();
  }

  async function deleteUser(userId) {
    state.users = state.users.filter(u => u.id !== userId);
    await saveUsers(state.users);
    renderTable();
  }

  /* ─── Wiring ──────────────────────────────────────────────────────────── */
  function wire() {
    document.getElementById("um-add-btn").addEventListener("click", () => openModal(null));
    document.getElementById("um-modal-close-btn").addEventListener("click", closeModal);
    document.getElementById("um-modal-cancel-btn").addEventListener("click", closeModal);
    document.getElementById("um-modal-save-btn").addEventListener("click", saveModal);
    document.getElementById("um-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "um-modal-overlay") closeModal();
    });

    document.getElementById("um-password-toggle-btn").addEventListener("click", () => {
      const input = document.getElementById("um-password-input");
      const icon = document.querySelector("#um-password-toggle-btn i");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      if (icon) icon.setAttribute("data-lucide", showing ? "eye" : "eye-off");
      Utils.refreshIcons();
    });

    document.getElementById("um-search-input").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderTable();
    });
  }

  /* ─── Bootstrap ───────────────────────────────────────────────────────── */
  async function initPage() {
    await loadServers();
    state.users = await loadUsers();
    wire();
    renderTable();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }
    if (global.lucide) {
      global.lucide.createIcons();
    }
  });

  global.onTabActivated = function onTabActivated(isFirstActivation) {
    if (isFirstActivation && !state.loaded) {
      state.loaded = true;
      initPage();
    }
  };

  global.USER_MGMT = {
    reload: renderTable,
    getState: () => Object.assign({}, state),
  };

})(window);