import {ownerEnvironment,ownerBackupAccess} from './owner-account.mjs';
import {accountBackupAccess} from './backup-account.mjs';
import {financeAccess, peopleAccess, contactsAccess, FINANCE_TOOLS, callFinanceTool} from "./finance-account.mjs";
export {FinanceAccount} from "./finance-account.mjs";
/**
 * DOTY Tracker sync Worker — multi-user + MCP (v6.2: MCP dates pinned to America/Toronto)
 *
 * KV layout:
 *   users              -> { "<username>": { hash, salt, role, createdAt } }
 *   data:<username>    -> { data: {...}, updatedAt }
 *   tracker            -> (legacy, auto-migrated to data:<admin> on bootstrap)
 *
 * Shared items (v6):
 *   An owner's schedule/todo/toBuy item can carry sharedWith: ["<recipient>", ...].
 *   The sentinel "*" in sharedWith means "every other user" (incl. future users).
 *   On GET /data, the worker overlays shadow copies of shared items into the
 *   recipient's same-named project (auto-created if missing). Shadow items
 *   have id "shared:<owner>:<origId>", sharedFrom=<owner>, readOnly=true.
 *   Completion is a single shared flag — a shadow's completed mirrors the owner
 *   item directly. On PUT /data, shadow items are stripped from the recipient's
 *   payload; completion always routes back to the owner item, and admin/manager
 *   edits route the full item (title/date/etc.) back too.
 *
 * Auth: Authorization: Basic base64(username:password)
 *
 * Endpoints:
 *   POST /auth                                          -> { ok, role, username, bootstrapped? }
 *   POST /auth/change-password  body { oldPassword, newPassword }   -> { ok }
 *   GET  /data[?as=<username>]                          -> { data, updatedAt }   (?as admin-only)
 *   PUT  /data        body { data, prevUpdatedAt? }     -> { ok, updatedAt } | 409 stale
 *   GET  /users                                         -> { users: [...] }
 *   GET  /time/all                                      -> { entries: [...] }   (admin or manager)
 *   POST /time/for-user  body { username, projectName, date, hours, note? }     (admin or manager)
 *   POST /projects/broadcast       body { name, deadline? }   -> { ok, addedTo, skipped }   (admin or manager)
 *   POST /projects/broadcast-note  body { project, text }     -> { ok, addedTo }            (admin or manager)
 *   GET  /admin/users                                   -> { users: [...] }
 *   POST /admin/users   body { username, password }
 *   POST /admin/users/reset-password  body { username, password }
 *   POST /admin/users/set-role  body { username, role }   role in {user, manager, admin}
 *   DELETE /admin/users/<username>
 *   POST /admin/mcp-token   body { label? }  -> { token, url }        (admin)
 *   GET  /admin/mcp-tokens                   -> { tokens: [...] }     (admin)
 *   DELETE /admin/mcp-tokens/<token>                                  (admin)
 *
 *   POST /mcp?token=<token>   -> MCP JSON-RPC over HTTP (bearer/query token, no Basic)
 *
 * Bootstrap: if no users exist, POST /auth accepts DOTY_PASSWORD as the password
 * and creates the first admin with the username you chose.
 */

const USERS_KEY = "users";
const LEGACY_DATA_KEY = "tracker";
const MCP_TOKEN_PREFIX = "mcp:";
const MCP_SERVER_NAME = "doty-tracker";
const MCP_SERVER_VERSION = "2.3.0-review";
const MCP_PROTOCOL_VERSION = "2025-03-26";

const legacyWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const corsOrigin =
      allowed === "*" || origin === allowed ? (origin || allowed) : allowed;
    const cors = {
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id",
      "access-control-max-age": "86400",
      "vary": "origin",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!env.DOTY_PASSWORD) {
      return json({ error: "server not configured: missing DOTY_PASSWORD" }, 500, cors);
    }

    // ---- /mcp (bearer/query token — no Basic auth) ----
    if (url.pathname === "/mcp") {
      return handleMcp(request, url, env, cors);
    }

    const { username, password } = parseBasic(request.headers.get("authorization") || "");
    if (!username || !password) return json({ error: "unauthorized" }, 401, cors);

    const users = await loadUsers(env);

    // ---- /auth: login + bootstrap ----
    if (url.pathname === "/auth" && request.method === "POST") {
      const userCount = Object.keys(users).length;
      if (userCount === 0) {
        if (!timingSafeEqual(password, env.DOTY_PASSWORD)) {
          return json({ error: "unauthorized" }, 401, cors);
        }
        if (!validUsername(username)) {
          return json({ error: "invalid username: 3-20 chars, a-z 0-9 -" }, 400, cors);
        }
        const salt = randomHex(16);
        const hash = await sha256Hex(salt + password);
        users[username] = { hash, salt, role: "admin", createdAt: new Date().toISOString() };
        await saveUsers(env, users);
        const legacy = env.OWNER_ACCOUNT_MODE==='fresh-v8'?null:await env.DOTY_KV.get(LEGACY_DATA_KEY);
        if (legacy) {
          await env.DOTY_KV.put(dataKey(username), legacy);
          await env.DOTY_KV.delete(LEGACY_DATA_KEY);
        }
        return json({ ok: true, role: "admin", username, bootstrapped: true }, 200, cors);
      }
      if (!(await verifyCreds(users, username, password))) {
        return json({ error: "unauthorized" }, 401, cors);
      }
      return json({ ok: true, role: users[username].role, username }, 200, cors);
    }

    if (!(await verifyCreds(users, username, password))) {
      return json({ error: "unauthorized" }, 401, cors);
    }
    const me = users[username];
    if(env.OWNER_ACCOUNT_MODE==='fresh-v8'&&request.method==='DELETE'&&url.pathname.startsWith('/admin/users/'))return json({error:'V8 account deletion needs a separately reviewed lifecycle; no users or account records changed.'},409,cors);

    if(url.pathname==='/account/backup'){
      if(url.searchParams.has('as'))return json({error:'Backups require your own account.'},403,cors);
      if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed'},405,cors);
      if(request.method==='POST'){try{return json(await ownerBackupAccess({env,username,role:me.role},await request.json()),200,{...cors,'cache-control':'no-store'});}catch(e){return json({error:e.message},e.status||400,{...cors,'cache-control':'no-store'});}}
      try{return json(await accountBackupAccess({env,username,role:me.role}),200,{...cors,'cache-control':'no-store'});}catch(e){return json({error:e.message},e.status||400,{...cors,'cache-control':'no-store'});}
    }
    // Private finance is separate from whole-state KV sync and share routing.
    if (["/finance/review","/finance/people","/finance/contacts"].includes(url.pathname)) {
      if (url.searchParams.has("as")) return json({error:"cross-user finance unavailable"},403,cors);
      if (!["GET","POST"].includes(request.method)) return json({error:"method not allowed"},405,cors);
      try {
        if(url.pathname==="/finance/contacts"){const b=request.method==="POST"?await request.json():null;if(b&&Object.keys(b).some(k=>k!=="mutation"))return json({error:"Invalid contacts request"},400,cors);const archived=url.searchParams.get("include_archived");if(archived!==null&&!["true","false"].includes(archived))return json({error:"Invalid archive filter"},400,cors);return json(await contactsAccess({env,username,role:me.role},request.method==="GET"?{search:url.searchParams.get("search")||"",...(archived!==null?{include_archived:archived==="true"}:{})}:{},b?.mutation||null),200,{...cors,"cache-control":"no-store"});}
        if(url.pathname==="/finance/people"){const b=request.method==="POST"?await request.json():null;if(b&&Object.keys(b).some(k=>k!=="mutation"))return json({error:"Invalid People request"},400,cors);return json(await peopleAccess({env,username,role:me.role},b?.mutation||null),200,{...cors,"cache-control":"no-store"});}
        const args = request.method === "GET" ? {project_id:url.searchParams.get("project_id")} : await request.json();
        return json(await financeAccess({env,username,role:me.role}, args, request.method === "POST", "browser"),200,{...cors,"cache-control":"no-store"});
      } catch(e) { return json({error:e.message},e.status||400,{...cors,"cache-control":"no-store"}); }
    }

    // ---- /auth/change-password (self-serve) ----
    if (url.pathname === "/auth/change-password" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const oldPassword = String(body.oldPassword || "");
      const newPassword = String(body.newPassword || "");
      if (!oldPassword) return json({ error: "missing oldPassword" }, 400, cors);
      if (newPassword.length < 4) return json({ error: "password too short (min 4 chars)" }, 400, cors);
      // Require oldPassword to match the basic-auth password (defense-in-depth).
      if (!timingSafeEqual(oldPassword, password)) {
        return json({ error: "old password incorrect" }, 401, cors);
      }
      const salt = randomHex(16);
      const hash = await sha256Hex(salt + newPassword);
      users[username].salt = salt;
      users[username].hash = hash;
      await saveUsers(env, users);
      return json({ ok: true }, 200, cors);
    }

    // ---- /data ----
    if (url.pathname === "/data" && request.method === "GET") {
      const asUser = (url.searchParams.get("as") || "").toLowerCase();
      let target = username;
      if (asUser && asUser !== username) {
        if (me.role !== "admin") return json({ error: "admin only" }, 403, cors);
        if (!users[asUser]) return json({ error: "user not found" }, 404, cors);
        target = asUser;
      }
      const rec = await loadUserDataRaw(env, target);
      if (!rec) return json({ data: null, updatedAt: null }, 200, cors);
      const data = rec.data || {};
      // Overlay shared items from other users onto the recipient's data.
      const others = await loadAllDataExcept(env, target, users);
      const shares = findSharesFor(others, target);
      overlayShares(data, shares, target);
      return json({ data, updatedAt: rec.updatedAt || null }, 200, cors);
    }

    if (url.pathname === "/data" && request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      if (!body || typeof body !== "object" || !("data" in body)) {
        return json({ error: "expected { data: ... }" }, 400, cors);
      }
      // Serialize PUTs through a per-user queue and enforce CAS via prevUpdatedAt
      // so concurrent web sessions can't blind-overwrite each other's writes.
      // Missing prevUpdatedAt = force write (back-compat).
      if(env.OWNER_ACCOUNT_MODE==='fresh-v8'&&!("prevUpdatedAt" in body))return json({error:"Explicit tracker revision required in V8"},409,cors);
      const hasPrev = env.OWNER_ACCOUNT_MODE==='fresh-v8'||("prevUpdatedAt" in body && body.prevUpdatedAt != null);
      const result = await __enqueueMutate(username, async () => {
        if (hasPrev) {
          const storedAt = await env_get_updatedAt(env, username);
          if ((env.OWNER_ACCOUNT_MODE==='fresh-v8'||storedAt) && storedAt !== body.prevUpdatedAt) {
            return { conflict: true, storedUpdatedAt: storedAt };
          }
        }
        const updatedAt = await saveUserDataWithShareRouting(env, username, body.data || {}, me.role);
        return { conflict: false, updatedAt };
      });
      if (result.conflict) {
        return json({
          error: "stale",
          code: "stale_version",
          storedUpdatedAt: result.storedUpdatedAt,
          prevUpdatedAt: body.prevUpdatedAt,
        }, 409, cors);
      }
      return json({ ok: true, updatedAt: result.updatedAt }, 200, cors);
    }

    // ---- /users : lightweight list (any authed user) ----
    if (url.pathname === "/users" && request.method === "GET") {
      const names = Object.keys(users).sort();
      return json({ users: names }, 200, cors);
    }

    // ---- /projects/broadcast (admin or manager) — fan a project to every user ----
    if (url.pathname === "/projects/broadcast" && request.method === "POST") {
      if (me.role !== "admin" && me.role !== "manager") {
        return json({ error: "admin or manager only" }, 403, cors);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const name = String(body.name || "").trim();
      const deadline = body.deadline ? String(body.deadline).trim() : null;
      if (!name) return json({ error: "name required" }, 400, cors);
      if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return json({ error: "deadline must be YYYY-MM-DD" }, 400, cors);
      const addedTo = [];
      const skipped = [];
      const lowName = name.toLowerCase();
      for (const targetUser of Object.keys(users)) {
        const existing = (await loadUserDataRaw(env, targetUser)) ||
                         { data: { projects: [], timeEntries: [], settings: {}, view: "today", initialized: true }, updatedAt: null };
        const data = existing.data || {};
        data.projects = Array.isArray(data.projects) ? data.projects : [];
        if (data.projects.some(p => (p.name || "").toLowerCase() === lowName)) {
          skipped.push(targetUser);
          continue;
        }
        data.projects.push({
          id: rid(), createdVersion: "8.0", name, deadline,
          notes: "", schedule: [], todos: [], toBuy: [],
        });
        await env.DOTY_KV.put(dataKey(targetUser),
          JSON.stringify({ data, updatedAt: new Date().toISOString() }));
        addedTo.push(targetUser);
      }
      return json({ ok: true, addedTo, skipped }, 200, cors);
    }

    // ---- /projects/broadcast-note (admin or manager) — append a note to every user's same-named project ----
    if (url.pathname === "/projects/broadcast-note" && request.method === "POST") {
      if (me.role !== "admin" && me.role !== "manager") {
        return json({ error: "admin or manager only" }, 403, cors);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const projName = String(body.project || "").trim();
      const text = String(body.text || "").trim();
      if (!projName || !text) return json({ error: "project and text required" }, 400, cors);
      const lowName = projName.toLowerCase();
      const addedTo = [];
      for (const targetUser of Object.keys(users)) {
        // Route each write through the per-user queue so a concurrent PUT /data
        // from the same user's browser can't interleave and clobber the note.
        await __enqueueMutate(targetUser, async () => {
          const existing = (await loadUserDataRaw(env, targetUser)) ||
                           { data: { projects: [], timeEntries: [], settings: {}, view: "today", initialized: true }, updatedAt: null };
          const data = existing.data || {};
          data.projects = Array.isArray(data.projects) ? data.projects : [];
          let proj = data.projects.find(p => (p.name || "").toLowerCase() === lowName);
          if (!proj) {
            proj = { id: rid(), createdVersion: "8.0", name: projName, deadline: null, notes: "", schedule: [], todos: [], toBuy: [] };
            data.projects.push(proj);
          }
          proj.notes = (proj.notes ? proj.notes + "\n" : "") + text;
          await env.DOTY_KV.put(dataKey(targetUser),
            JSON.stringify({ data, updatedAt: new Date().toISOString() }));
        });
        addedTo.push(targetUser);
      }
      return json({ ok: true, addedTo }, 200, cors);
    }

    // ---- /time/all (admin or manager) — every user's time entries, project names resolved ----
    if (url.pathname === "/time/all" && request.method === "GET") {
      if (me.role !== "admin" && me.role !== "manager") {
        return json({ error: "admin or manager only" }, 403, cors);
      }
      const entries = [];
      for (const un of Object.keys(users)) {
        const rec = await loadUserDataRaw(env, un);
        if (!rec || !rec.data) continue;
        const projById = {};
        for (const p of (rec.data.projects || [])) projById[p.id] = p.name;
        for (const e of (rec.data.timeEntries || [])) {
          entries.push({
            username: un,
            projectName: projById[e.projectId] || "(unknown project)",
            date: e.date || null,
            hours: e.hours || 0,
            note: e.note || "",
            loggedBy: e.loggedBy || un,
          });
        }
      }
      return json({ entries }, 200, cors);
    }

    // ---- /time/for-user (admin or manager) — log a time entry into another user's tracker ----
    if (url.pathname === "/time/for-user" && request.method === "POST") {
      if (me.role !== "admin" && me.role !== "manager") {
        return json({ error: "admin or manager only" }, 403, cors);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const target = String(body.username || "").toLowerCase();
      const projName = String(body.projectName || "").trim();
      const date = String(body.date || "").trim();
      const hours = Number(body.hours);
      const note = String(body.note || "");
      if (!users[target]) return json({ error: "user not found" }, 404, cors);
      if (!projName) return json({ error: "projectName required" }, 400, cors);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400, cors);
      if (!(hours > 0)) return json({ error: "hours must be greater than 0" }, 400, cors);
      const result = await __enqueueMutate(target, async () => {
        const rec = (await loadUserDataRaw(env, target)) ||
                    { data: { projects: [], timeEntries: [], settings: {}, view: "today", initialized: true }, updatedAt: null };
        const data = rec.data || {};
        data.projects = Array.isArray(data.projects) ? data.projects : [];
        data.timeEntries = Array.isArray(data.timeEntries) ? data.timeEntries : [];
        let proj = data.projects.find(p => (p.name || "").toLowerCase() === projName.toLowerCase());
        if (!proj) {
          proj = { id: rid(), createdVersion: "8.0", name: projName, deadline: null, notes: "", schedule: [], todos: [], toBuy: [] };
          data.projects.push(proj);
        }
        data.timeEntries.push({
          id: rid(), projectId: proj.id, date, hours, note,
          createdAt: Date.now(), loggedBy: username,
        });
        const updatedAt = new Date().toISOString();
        await env.DOTY_KV.put(dataKey(target), JSON.stringify({ data, updatedAt }));
        return env.OWNER_WRITE_AT?.(target)||updatedAt;
      });
      return json({ ok: true, updatedAt: result }, 200, cors);
    }

    if (url.pathname.startsWith("/admin/") && me.role !== "admin") {
      return json({ error: "admin only" }, 403, cors);
    }

    if (url.pathname === "/admin/users" && request.method === "GET") {
      const list = [];
      for (const [un, u] of Object.entries(users)) {
        const raw = await env.DOTY_KV.get(dataKey(un));
        let lastUpdatedAt = null;
        if (raw) { try { lastUpdatedAt = JSON.parse(raw).updatedAt || null; } catch {} }
        list.push({ username: un, role: u.role, createdAt: u.createdAt, lastUpdatedAt });
      }
      list.sort((a, b) => a.username.localeCompare(b.username));
      return json({ users: list }, 200, cors);
    }

    if (url.pathname === "/admin/users" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const newUsername = String(body.username || "").toLowerCase();
      const newPassword = String(body.password || "");
      if (!validUsername(newUsername)) return json({ error: "invalid username" }, 400, cors);
      if (newPassword.length < 4) return json({ error: "password too short (min 4 chars)" }, 400, cors);
      if (users[newUsername]) return json({ error: "username already exists" }, 409, cors);
      const salt = randomHex(16);
      const hash = await sha256Hex(salt + newPassword);
      users[newUsername] = { hash, salt, role: "user", createdAt: new Date().toISOString() };
      await saveUsers(env, users);
      const adminRaw = await env.DOTY_KV.get(dataKey(username));
      const seeded = { projects: [], timeEntries: [], settings: {}, view: "today", initialized: true };
      if (adminRaw) {
        try {
          const rec = JSON.parse(adminRaw);
          if (rec && rec.data && Array.isArray(rec.data.projects)) {
            seeded.projects = rec.data.projects.map(p => ({
              id: rid(), name: p.name, deadline: p.deadline || null,
              notes: "", schedule: [], todos: [], toBuy: [],
            }));
          }
        } catch {}
      }
      await env.DOTY_KV.put(dataKey(newUsername),
        JSON.stringify({ data: seeded, updatedAt: new Date().toISOString() }));
      return json({ ok: true, username: newUsername }, 200, cors);
    }

    if (url.pathname === "/admin/users/reset-password" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const target = String(body.username || "").toLowerCase();
      const newPassword = String(body.password || "");
      if (!users[target]) return json({ error: "user not found" }, 404, cors);
      if (newPassword.length < 4) return json({ error: "password too short (min 4 chars)" }, 400, cors);
      const salt = randomHex(16);
      const hash = await sha256Hex(salt + newPassword);
      users[target].salt = salt;
      users[target].hash = hash;
      await saveUsers(env, users);
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/admin/users/set-role" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400, cors); }
      const target = String(body.username || "").toLowerCase();
      const role = String(body.role || "");
      if (!users[target]) return json({ error: "user not found" }, 404, cors);
      if (!["user", "manager", "admin"].includes(role)) {
        return json({ error: "role must be user, manager, or admin" }, 400, cors);
      }
      // Prevent admin from demoting themselves and locking out the system.
      if (target === username && role !== "admin") {
        return json({ error: "can't change your own role" }, 400, cors);
      }
      users[target].role = role;
      await saveUsers(env, users);
      return json({ ok: true, username: target, role }, 200, cors);
    }

    const delMatch = url.pathname.match(/^\/admin\/users\/([a-z0-9-]{3,20})$/);
    if (delMatch && request.method === "DELETE") {
      const target = delMatch[1];
      if (!users[target]) return json({ error: "user not found" }, 404, cors);
      if (target === username) return json({ error: "can't delete yourself" }, 400, cors);
      delete users[target];
      await saveUsers(env, users);
      await env.DOTY_KV.delete(dataKey(target));
      // Cascade: revoke any MCP tokens minted for the deleted user.
      const tokList = await env.DOTY_KV.list({ prefix: MCP_TOKEN_PREFIX });
      for (const k of tokList.keys) {
        const raw = await env.DOTY_KV.get(k.name);
        try { if (JSON.parse(raw).username === target) await env.DOTY_KV.delete(k.name); } catch {}
      }
      return json({ ok: true }, 200, cors);
    }

    // ---- /admin/mcp-token: mint a connector token (admin) ----
    if (url.pathname === "/admin/mcp-token" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch {}
      const token = randomHex(24);
      const rec = {
        username,  // token acts as the minting admin
        label: body.label ? String(body.label).slice(0, 40) : "",
        createdAt: new Date().toISOString(),
      };
      await env.DOTY_KV.put(MCP_TOKEN_PREFIX + token, JSON.stringify(rec));
      return json({ ok: true, token, url: `${url.origin}/mcp?token=${token}` }, 200, cors);
    }

    if (url.pathname === "/admin/mcp-tokens" && request.method === "GET") {
      const list = await env.DOTY_KV.list({ prefix: MCP_TOKEN_PREFIX });
      const tokens = [];
      for (const k of list.keys) {
        const raw = await env.DOTY_KV.get(k.name);
        try { tokens.push({ token: k.name.slice(MCP_TOKEN_PREFIX.length), ...JSON.parse(raw) }); } catch {}
      }
      tokens.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return json({ tokens }, 200, cors);
    }

    const tokDel = url.pathname.match(/^\/admin\/mcp-tokens\/([a-f0-9]{8,})$/);
    if (tokDel && request.method === "DELETE") {
      await env.DOTY_KV.delete(MCP_TOKEN_PREFIX + tokDel[1]);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: "not found" }, 404, cors);
  },
};

/* ---------- shared-items helpers ---------- */
const SHARED_ITEM_ID_PREFIX = "shared:";
const SHARED_PROJ_ID_PREFIX = "shared-proj:";

async function loadUserDataRaw(env, username) {
  const raw = await env.DOTY_KV.get(dataKey(username));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function loadAllDataExcept(env, excludeUsername, usersMap) {
  const users = usersMap || await loadUsers(env);
  const out = {};
  for (const un of Object.keys(users)) {
    if (un === excludeUsername) continue;
    const rec = await loadUserDataRaw(env, un);
    if (rec && rec.data) out[un] = rec.data;
  }
  return out;
}
// "*" in sharedWith means "every other user" (including users added later).
const SHARE_ALL = "*";
const SHARE_KINDS = ["schedule", "todos", "toBuy"];
const SHADOW_EDITABLE = ["title", "date", "time", "qty", "url", "needsConfirmation", "subcontractor"];

function findSharesFor(othersData, recipient) {
  const shares = [];
  for (const [owner, data] of Object.entries(othersData || {})) {
    for (const p of (data.projects || [])) {
      for (const kind of SHARE_KINDS) {
        for (const it of (p[kind] || [])) {
          if (Array.isArray(it.sharedWith) &&
              (it.sharedWith.includes(recipient) || it.sharedWith.includes(SHARE_ALL))) {
            shares.push({ owner, projectName: p.name, kind, item: it });
          }
        }
      }
    }
  }
  return shares;
}
function overlayShares(data, shares, recipient) {
  data.projects = data.projects || [];
  for (const share of shares) {
    let proj = data.projects.find(p => (p.name || "").toLowerCase() === share.projectName.toLowerCase());
    if (!proj) {
      proj = {
        id: SHARED_PROJ_ID_PREFIX + share.owner + ":" + share.projectName,
        name: share.projectName,
        deadline: null, notes: "",
        schedule: [], todos: [], toBuy: [],
        sharedVirtual: true,
      };
      data.projects.push(proj);
    }
    proj[share.kind] = proj[share.kind] || [];
    const shadow = { ...share.item };
    delete shadow.sharedWith;
    delete shadow.completionsByUser; // legacy field, no longer used (v6: single shared flag)
    shadow.id = SHARED_ITEM_ID_PREFIX + share.owner + ":" + share.item.id;
    shadow.sharedFrom = share.owner;
    shadow.readOnly = true;
    // v6: completion is a single shared flag — mirror the owner item directly.
    shadow.completed = !!share.item.completed;
    shadow.completedAt = share.item.completedAt || null;
    proj[share.kind].push(shadow);
  }
  return data;
}
async function saveUserDataWithShareRouting(env, username, data, role) {
  const canEditShares = role === "admin" || role === "manager";
  const ownerRecs = {};
  const ownerDirty = {};
  const cleanProjects = [];
  for (const p of (data.projects || [])) {
    const { schedule, todos, toBuy, sharedVirtual, ...restProj } = p;
    const cleanProj = {
      ...restProj,
      schedule: [],
      todos: [],
      toBuy: [],
    };
    const srcByKind = { schedule, todos, toBuy };
    for (const kind of SHARE_KINDS) {
      for (const it of (srcByKind[kind] || [])) {
        const isShadow = it && typeof it.id === "string" && it.id.startsWith(SHARED_ITEM_ID_PREFIX) && it.sharedFrom;
        if (isShadow) {
          const owner = it.sharedFrom;
          const prefix = SHARED_ITEM_ID_PREFIX + owner + ":";
          const origId = it.id.startsWith(prefix) ? it.id.slice(prefix.length) : null;
          if (!origId) continue;
          if (!ownerRecs[owner]) {
            ownerRecs[owner] = await loadUserDataRaw(env, owner);
          }
          const ownerData = ownerRecs[owner] && ownerRecs[owner].data;
          if (ownerData) {
            const changed = applyShadowChangeToOwner(ownerData, origId, kind, it, canEditShares);
            if (changed) ownerDirty[owner] = true;
          }
        } else {
          cleanProj[kind].push(it);
        }
      }
    }
    const isVirtual = !!sharedVirtual || (typeof cleanProj.id === "string" && cleanProj.id.startsWith(SHARED_PROJ_ID_PREFIX));
    if (isVirtual) cleanProj.id = rid();
    const hasRealContent =
      cleanProj.schedule.length > 0 ||
      cleanProj.todos.length > 0 ||
      (Array.isArray(cleanProj.toBuy) && cleanProj.toBuy.length > 0) ||
      (cleanProj.notes && String(cleanProj.notes).trim().length > 0) ||
      cleanProj.deadline;
    if (!isVirtual || hasRealContent) {
      cleanProjects.push(cleanProj);
    }
  }
  const cleanData = { ...data, projects: cleanProjects };
  for (const [owner, rec] of Object.entries(ownerRecs)) {
    if (!ownerDirty[owner] || !rec || !rec.data) continue;
    const ownerUpdatedAt = new Date().toISOString();
    await env.DOTY_KV.put(dataKey(owner),
      JSON.stringify({ data: rec.data, updatedAt: ownerUpdatedAt }));
  }
  const updatedAt = new Date().toISOString();
  await env.DOTY_KV.put(dataKey(username),
    JSON.stringify({ data: cleanData, updatedAt }));
  return env.OWNER_WRITE_AT?.(username)||updatedAt;
}
// Route a recipient's change to a shadow item back to the owner's real item.
// Completion always routes (v6: anyone can check a shared item). Admin/manager
// edits also route the full editable field set back to the owner.
function applyShadowChangeToOwner(ownerData, origId, kind, shadow, canEdit) {
  for (const p of (ownerData.projects || [])) {
    for (const it of (p[kind] || [])) {
      if (it.id === origId) {
        let changed = false;
        if (it.completed !== !!shadow.completed) {
          it.completed = !!shadow.completed;
          changed = true;
        }
        if ((it.completedAt || null) !== (shadow.completedAt || null)) {
          it.completedAt = shadow.completedAt || null;
          changed = true;
        }
        if (canEdit) {
          for (const field of SHADOW_EDITABLE) {
            const newVal = shadow[field];
            if (newVal === undefined) {
              if (field in it) { delete it[field]; changed = true; }
            } else if (it[field] !== newVal) {
              it[field] = newVal;
              changed = true;
            }
          }
        }
        return changed;
      }
    }
  }
  return false;
}

/* ---------- write race guard (used by PUT /data) ---------- */
const __mutateQueue = new Map(); // username -> Promise

function __enqueueMutate(username, taskFn) {
  const prev = __mutateQueue.get(username) || Promise.resolve();
  const next = prev.catch(() => {}).then(taskFn);
  __mutateQueue.set(username, next);
  next.finally(() => { if (__mutateQueue.get(username) === next) __mutateQueue.delete(username); }).catch(() => {});
  return next;
}

async function env_get_updatedAt(env, username) {
  const raw = await env.DOTY_KV.get(dataKey(username));
  if (!raw) return null;
  try { const rec = JSON.parse(raw); return rec.updatedAt || null; } catch { return null; }
}

/* ---------- helpers ---------- */
function dataKey(u) { return "data:" + u; }
function validUsername(u) { return typeof u === "string" && /^[a-z0-9-]{3,20}$/.test(u); }
async function loadUsers(env) {
  const raw = await env.DOTY_KV.get(USERS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
async function saveUsers(env, users) { await env.DOTY_KV.put(USERS_KEY, JSON.stringify(users)); }
async function verifyCreds(users, username, password) {
  const u = users[username];
  if (!u) return false;
  const hash = await sha256Hex(u.salt + password);
  return timingSafeEqual(hash, u.hash);
}
function parseBasic(header) {
  if (!header.startsWith("Basic ")) return {};
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(":");
    if (idx < 0) return {};
    return { username: decoded.slice(0, idx).toLowerCase(), password: decoded.slice(idx + 1) };
  } catch { return {}; }
}
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

/* ============================================================
   MCP (v6.1) — JSON-RPC over HTTP, token auth.
   All writes go through mutate(): per-user queue + reload/CAS
   retry + saveUserDataWithShareRouting (same path as PUT /data).
   delete_item soft-archives to match the web UI.
   ============================================================ */

async function handleMcp(request, url, env, cors) {
  const mcpCors = { ...cors, "content-type": "application/json" };
  let token = url.searchParams.get("token") || "";
  if (!token) {
    const h = request.headers.get("authorization") || "";
    if (h.toLowerCase().startsWith("bearer ")) token = h.slice(7).trim();
  }
  if (!token) return new Response(JSON.stringify({ error: "missing token" }), { status: 401, headers: mcpCors });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: mcpCors });
  }
  const tokRaw = await env.DOTY_KV.get(MCP_TOKEN_PREFIX + token);
  if (!tokRaw) return new Response(JSON.stringify({ error: "invalid token" }), { status: 401, headers: mcpCors });
  let tokRec; try { tokRec = JSON.parse(tokRaw); } catch { return new Response(JSON.stringify({ error: "token corrupt" }), { status: 500, headers: mcpCors }); }
  const users = await loadUsers(env);
  const me = users[tokRec.username];
  if (!me) return new Response(JSON.stringify({ error: "token user missing" }), { status: 401, headers: mcpCors });

  let rpc;
  try { rpc = await request.json(); } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }), { status: 200, headers: mcpCors });
  }
  const ctx = { env, username: tokRec.username, role: me.role };
  const requests = Array.isArray(rpc) ? rpc : [rpc];
  const responses = [];
  for (const req of requests) {
    const resp = await dispatchRpc(req, ctx);
    if (resp) responses.push(resp);
  }
  if (Array.isArray(rpc)) return new Response(JSON.stringify(responses), { status: 200, headers: mcpCors });
  if (responses.length === 0) return new Response(null, { status: 202, headers: cors });
  return new Response(JSON.stringify(responses[0]), { status: 200, headers: mcpCors });
}

async function dispatchRpc(req, ctx) {
  const { id, method, params } = req || {};
  if (req && req.jsonrpc !== "2.0") return rpcError(id, -32600, "invalid request");
  const isNotification = (id === undefined || id === null);
  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    if (method === "notifications/initialized" || method === "initialized") return null;
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOL_DEFS });
    if (method === "tools/call") {
      const impl = TOOL_IMPLS[params?.name];
      if (!impl) return rpcError(id, -32601, `unknown tool: ${params?.name}`);
      const text = await impl(params?.arguments || {}, ctx);
      return rpcResult(id, { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }] });
    }
    if (isNotification) return null;
    return rpcError(id, -32601, `method not found: ${method}`);
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, -32603, `internal error: ${err.message || err}`);
  }
}
function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

/* ---------- MCP data access ---------- */
async function withData(ctx, fn) {
  const rec = await loadUserDataRaw(ctx.env, ctx.username);
  const data = rec ? (rec.data || {}) : {};
  const users = await loadUsers(ctx.env);
  const others = await loadAllDataExcept(ctx.env, ctx.username, users);
  overlayShares(data, findSharesFor(others, ctx.username), ctx.username);
  return fn(data);
}
// Write path: per-user queue + reload/CAS retry, saving through the same
// share-routing pipeline as PUT /data (role-aware).
async function mutate(ctx, fn) {
  return __enqueueMutate(ctx.username, async () => {
    const MAX_ATTEMPTS = 3;
    let lastResult;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const rec = (await loadUserDataRaw(ctx.env, ctx.username)) ||
                  { data: { projects: [], timeEntries: [], settings: {}, view: "today", initialized: true }, updatedAt: null };
      const startUpdatedAt = rec.updatedAt || null;
      const data = rec.data || {};
      const users = await loadUsers(ctx.env);
      const others = await loadAllDataExcept(ctx.env, ctx.username, users);
      overlayShares(data, findSharesFor(others, ctx.username), ctx.username);
      lastResult = fn(data);
      const freshAt = await env_get_updatedAt(ctx.env, ctx.username);
      if (freshAt !== startUpdatedAt && attempt < MAX_ATTEMPTS) continue; // someone wrote meanwhile — retry from fresh
      await saveUserDataWithShareRouting(ctx.env, ctx.username, data, ctx.role);
      return lastResult;
    }
    return lastResult;
  });
}

/* ---------- MCP matchers + formatters ---------- */
// The worker runs on UTC; James is in Toronto. All "what day is it" math is
// pinned to America/Toronto (DST-safe via Intl) so evening updates don't
// roll into tomorrow. en-CA locale formats as YYYY-MM-DD directly.
function mcpToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
// UTC-noon epoch for a YYYY-MM-DD — safe base for pure calendar-day arithmetic.
function dayBaseUTC(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}
function findProject(data, name) {
  const projects = data.projects || [];
  if (!name) return null;
  const low = String(name).toLowerCase().trim();
  return projects.find(p => (p.name||"").toLowerCase() === low)
      || projects.find(p => (p.name||"").toLowerCase().startsWith(low))
      || projects.find(p => (p.name||"").toLowerCase().includes(low))
      || null;
}
function findItem(list, needle) {
  const low = String(needle||"").toLowerCase().trim();
  if (!low) return null;
  return list.find(it => (it.title||"").toLowerCase() === low)
      || list.find(it => (it.title||"").toLowerCase().startsWith(low))
      || list.find(it => (it.title||"").toLowerCase().includes(low))
      || null;
}
function fmtItem(it, kind) {
  const bits = [];
  if (kind === "schedule") bits.push(`${it.date}${it.time ? " " + it.time : ""}`);
  bits.push(it.title);
  const flags = [];
  if (it.completed) flags.push("✓ done");
  if (it.needsConfirmation) flags.push("needs confirm");
  if (it.subcontractor) flags.push("SUB");
  if (it.url) flags.push(it.url);
  if (it.qty && it.qty > 1) flags.push(`qty ${it.qty}`);
  return `  • ${bits.join(" — ")}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`;
}
function fmtOverview(data) {
  const projects = data.projects || [];
  const today = mcpToday();
  const lines = [`Today (${today}):`];
  let todayCount = 0, confirmCount = 0, overdueCount = 0;
  for (const p of projects) {
    for (const it of (p.schedule || [])) {
      if (it.completed) continue;
      if (it.date === today) { lines.push(`  • [${p.name}] ${it.time ? it.time + " " : ""}${it.title}${it.subcontractor ? " [SUB]" : ""}`); todayCount++; }
      if (it.date < today) overdueCount++;
      if (it.needsConfirmation) confirmCount++;
    }
  }
  if (!todayCount) lines.push("  nothing scheduled.");
  if (overdueCount) lines.push(`\n⚠ ${overdueCount} overdue scheduled item(s) — use list_projects / get_project to see them.`);
  lines.push(`\nAwaiting confirmation: ${confirmCount}`);
  lines.push("\nProjects:");
  for (const p of projects) {
    const s = (p.schedule||[]).filter(x=>!x.completed).length;
    const t = (p.todos||[]).filter(x=>!x.completed).length;
    const b = (p.toBuy||[]).filter(x=>!x.completed).length;
    lines.push(`  - ${p.name}${p.deadline ? " (due " + p.deadline + ")" : ""}: ${s} scheduled, ${t} to-do, ${b} to-buy`);
  }
  if (!projects.length) lines.push("  (none yet — use add_project)");
  return lines.join("\n");
}
function fmtProject(p) {
  const lines = [`${p.name}${p.deadline ? " (due " + p.deadline + ")" : ""}`];
  if (p.notes) lines.push(`Notes:\n${p.notes.split("\n").map(l => "  " + l).join("\n")}`);
  const sched = [...(p.schedule||[])].sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  lines.push("", `Schedule (${sched.filter(x=>!x.completed).length} open):`);
  lines.push(sched.length ? sched.map(it=>fmtItem(it,"schedule")).join("\n") : "  (empty)");
  lines.push("", `To-do (${(p.todos||[]).filter(x=>!x.completed).length} open):`);
  lines.push((p.todos||[]).length ? p.todos.map(it=>fmtItem(it,"todo")).join("\n") : "  (empty)");
  lines.push("", `To-buy (${(p.toBuy||[]).filter(x=>!x.completed).length} open):`);
  lines.push((p.toBuy||[]).length ? p.toBuy.map(it=>fmtItem(it,"buy")).join("\n") : "  (empty)");
  const archN = (p.archivedSchedule||[]).length + (p.archivedTodos||[]).length + (p.archivedToBuy||[]).length;
  if (archN) lines.push("", `Archived: ${archN} item(s) (recoverable via restore_item)`);
  return lines.join("\n");
}

/* ---------- MCP tool definitions ---------- */
const TOOL_DEFS = [
  ...FINANCE_TOOLS,
  { name: "overview",
    description: "Snapshot of everything: today's schedule, overdue count, confirmation queue, and per-project open counts. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_today",
    description: "Today's scheduled items plus anything awaiting confirmation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_week",
    description: "Scheduled items for the next 7 days, grouped by day.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_projects",
    description: "All projects with deadlines and open item counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_project",
    description: "Full detail for one project: schedule, to-dos, to-buy list (with product links), notes, archived count.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Project name (fuzzy match ok)." } }, required: ["project"], additionalProperties: false } },
  { name: "add_project",
    description: "Create a new project.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" },
      deadline: { type: "string", description: "YYYY-MM-DD. Optional." },
    }, required: ["name"], additionalProperties: false } },
  { name: "update_project",
    description: "Rename a project, change its deadline, and/or append a line to its notes. Only provided fields change.",
    inputSchema: { type: "object", properties: {
      project: { type: "string", description: "Current project name (fuzzy match ok)." },
      new_name: { type: "string" },
      deadline: { type: "string", description: "YYYY-MM-DD, or empty string to clear." },
      append_note: { type: "string", description: "Line to append to project notes." },
    }, required: ["project"], additionalProperties: false } },
  { name: "add_schedule_items",
    description: "Add one or more scheduled items to a project in a single atomic write. Always use this for schedule items, even a single one.",
    inputSchema: { type: "object", properties: {
      project: { type: "string" },
      items: { type: "array", minItems: 1, items: { type: "object", properties: {
        text: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        time: { type: "string", description: "HH:MM 24h. Optional." },
        needs_confirm: { type: "boolean", description: "Waiting on a callback." },
        subcontractor: { type: "boolean", description: "Item is a subcontractor visit." },
      }, required: ["text"], additionalProperties: false } },
    }, required: ["project", "items"], additionalProperties: false } },
  { name: "add_todos",
    description: "Add one or more to-do items to a project in a single atomic write.",
    inputSchema: { type: "object", properties: {
      project: { type: "string" },
      texts: { type: "array", minItems: 1, items: { type: "string" } },
    }, required: ["project", "texts"], additionalProperties: false } },
  { name: "add_to_buy",
    description: "Add one or more items to a project's to-buy list in a single atomic write. Each can carry a product URL and quantity.",
    inputSchema: { type: "object", properties: {
      project: { type: "string" },
      items: { type: "array", minItems: 1, items: { type: "object", properties: {
        text: { type: "string" },
        url: { type: "string", description: "Product purchase link. Optional." },
        qty: { type: "number", description: "Quantity. Optional." },
      }, required: ["text"], additionalProperties: false } },
    }, required: ["project", "items"], additionalProperties: false } },
  { name: "update_item",
    description: "Edit an existing item's fields. Match by project + text fragment. Only provided fields change. To clear a field, pass an empty string.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["schedule", "todo", "buy"] },
      project: { type: "string" },
      match: { type: "string", description: "Text fragment of the current title." },
      title: { type: "string" },
      date: { type: "string", description: "Schedule only. YYYY-MM-DD." },
      time: { type: "string", description: "Schedule only. HH:MM 24h, empty to clear." },
      needs_confirm: { type: "boolean" },
      subcontractor: { type: "boolean", description: "Schedule only." },
      url: { type: "string", description: "To-buy only. Empty to clear." },
      qty: { type: "number", description: "To-buy only." },
    }, required: ["kind", "project", "match"], additionalProperties: false } },
  { name: "check_item",
    description: "Mark an item done (schedule/todo) or got (to-buy). Match by project + text fragment. Pass done:false to un-check.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["schedule", "todo", "buy"] },
      project: { type: "string" },
      match: { type: "string" },
      done: { type: "boolean", description: "Defaults true." },
    }, required: ["kind", "project", "match"], additionalProperties: false } },
  { name: "confirm_item",
    description: "Clear the needs-confirmation flag on a schedule item (the callback came through).",
    inputSchema: { type: "object", properties: {
      project: { type: "string" }, match: { type: "string" },
    }, required: ["project", "match"], additionalProperties: false } },
  { name: "delete_item",
    description: "Move an item to the project's Archive (recoverable — this matches the web UI's delete). Use restore_item to bring it back.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["schedule", "todo", "buy"] },
      project: { type: "string" },
      match: { type: "string" },
    }, required: ["kind", "project", "match"], additionalProperties: false } },
  { name: "restore_item",
    description: "Restore an archived item back to its live list (uncompleted).",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["schedule", "todo", "buy"] },
      project: { type: "string" },
      match: { type: "string" },
    }, required: ["kind", "project", "match"], additionalProperties: false } },
  { name: "log_time",
    description: "Log legacy hours against a project. Kept for compatibility; does not create billable labour, worker pay or a financial transaction.",
    inputSchema: { type: "object", properties: {
      project: { type: "string" },
      hours: { type: "number" },
      date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      note: { type: "string" },
    }, required: ["project", "hours"], additionalProperties: false } },
  { name: "time_summary",
    description: "Legacy hours by project for today / this week / this month. Excludes structured financial labour; never convert these hours to days or add them to bills automatically.",
    inputSchema: { type: "object", properties: {
      scope: { type: "string", enum: ["today", "week", "month"] },
    }, additionalProperties: false } },
];

/* ---------- MCP tool implementations ---------- */
const ARCH_KEY = { schedule: "archivedSchedule", todo: "archivedTodos", buy: "archivedToBuy" };
const LIVE_KEY = { schedule: "schedule", todo: "todos", buy: "toBuy" };

const TOOL_IMPLS = {
  ...Object.fromEntries(FINANCE_TOOLS.map(tool=>[tool.name,(args,ctx)=>callFinanceTool(tool.name,args,ctx)])),
  overview: (a, ctx) => withData(ctx, (d) => fmtOverview(d)),

  list_today: (a, ctx) => withData(ctx, (d) => {
    const today = mcpToday();
    const lines = [`Today (${today}):`];
    let n = 0;
    for (const p of (d.projects || [])) {
      for (const it of (p.schedule || [])) {
        if (!it.completed && it.date === today) { lines.push(`  • [${p.name}] ${it.time ? it.time + " " : ""}${it.title}${it.subcontractor ? " [SUB]" : ""}${it.needsConfirmation ? " [needs confirm]" : ""}`); n++; }
      }
    }
    if (!n) lines.push("  nothing scheduled.");
    const confirmQ = [];
    for (const p of (d.projects || []))
      for (const it of (p.schedule || []))
        if (!it.completed && it.needsConfirmation) confirmQ.push(`  • [${p.name}] ${it.date}${it.time ? " " + it.time : ""} — ${it.title}`);
    if (confirmQ.length) lines.push("", "Awaiting confirmation:", ...confirmQ);
    return lines.join("\n");
  }),

  list_week: (a, ctx) => withData(ctx, (d) => {
    const base = dayBaseUTC(mcpToday());
    const days = {};
    for (let i = 0; i < 7; i++) {
      days[new Date(base + i * 86400000).toISOString().slice(0, 10)] = [];
    }
    for (const p of (d.projects || []))
      for (const it of (p.schedule || []))
        if (!it.completed && days[it.date]) days[it.date].push(`  • [${p.name}] ${it.time ? it.time + " " : ""}${it.title}${it.subcontractor ? " [SUB]" : ""}`);
    const lines = ["Next 7 days:"];
    for (const [iso, items] of Object.entries(days)) {
      const label = new Date(dayBaseUTC(iso)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
      lines.push(`${label}:`);
      lines.push(items.length ? items.join("\n") : "  (none)");
    }
    return lines.join("\n");
  }),

  list_projects: (a, ctx) => withData(ctx, (d) => {
    const projects = d.projects || [];
    if (!projects.length) return "No projects yet — use add_project.";
    return ["Projects:", ...projects.map(p => {
      const s = (p.schedule||[]).filter(x=>!x.completed).length;
      const t = (p.todos||[]).filter(x=>!x.completed).length;
      const b = (p.toBuy||[]).filter(x=>!x.completed).length;
      return `- ${p.name}${p.deadline ? " (due " + p.deadline + ")" : ""}: ${s} scheduled, ${t} to-do, ${b} to-buy · project_id: ${p.id}${p.sharedVirtual ? " (shared view; finance unavailable)" : ""}`;
    })].join("\n");
  }),

  get_project: (a, ctx) => withData(ctx, (d) => {
    const p = findProject(d, a.project);
    return p ? fmtProject(p) : `No project matching "${a.project}".`;
  }),

  add_project: (a, ctx) => mutate(ctx, (d) => {
    d.projects = d.projects || [];
    const name = String(a.name || "").trim();
    if (!name) return "Name required.";
    if (d.projects.some(p => (p.name||"").toLowerCase() === name.toLowerCase())) return `A project named "${name}" already exists.`;
    if (a.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(a.deadline)) return "Deadline must be YYYY-MM-DD.";
    d.projects.push({ id: rid(), createdVersion: "8.0", name, deadline: a.deadline || null, notes: "", schedule: [], todos: [], toBuy: [] });
    return `Created project "${name}"${a.deadline ? " (due " + a.deadline + ")" : ""}.`;
  }),

  update_project: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const did = [];
    if (a.new_name && a.new_name.trim()) {
      const nn = a.new_name.trim();
      if (d.projects.some(x => x !== p && (x.name||"").toLowerCase() === nn.toLowerCase())) return `A project named "${nn}" already exists.`;
      did.push(`renamed "${p.name}" → "${nn}"`); p.name = nn;
    }
    if (a.deadline !== undefined) {
      if (a.deadline === "") { p.deadline = null; did.push("cleared deadline"); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(a.deadline)) { p.deadline = a.deadline; did.push(`deadline → ${a.deadline}`); }
      else return "Deadline must be YYYY-MM-DD or empty string to clear.";
    }
    if (a.append_note && a.append_note.trim()) {
      p.notes = (p.notes ? p.notes + "\n" : "") + a.append_note.trim();
      did.push("note appended");
    }
    return did.length ? `${p.name}: ${did.join("; ")}.` : "Nothing to change — provide new_name, deadline, or append_note.";
  }),

  add_schedule_items: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    p.schedule = p.schedule || [];
    const added = [];
    for (const spec of (a.items || [])) {
      if (!spec || !String(spec.text||"").trim()) continue;
      const date = spec.date || mcpToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `Date must be YYYY-MM-DD (got "${spec.date}").`;
      if (spec.time && !/^\d{1,2}:\d{2}$/.test(spec.time)) return `Time must be HH:MM (got "${spec.time}").`;
      const item = { id: rid(), title: spec.text.trim(), date, time: spec.time || null,
        needsConfirmation: !!spec.needs_confirm, completed: false, completedAt: null };
      if (spec.subcontractor) item.subcontractor = true;
      p.schedule.push(item);
      added.push(`${date}${spec.time ? " " + spec.time : ""} — ${spec.text.trim()}${spec.subcontractor ? " [SUB]" : ""}${spec.needs_confirm ? " [needs confirm]" : ""}`);
    }
    if (!added.length) return "No valid items provided.";
    return `Added ${added.length} schedule item(s) to ${p.name}:\n` + added.map(x => "  • " + x).join("\n");
  }),

  add_todos: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const texts = (a.texts || []).map(t => String(t||"").trim()).filter(Boolean);
    if (!texts.length) return "No texts provided.";
    p.todos = p.todos || [];
    for (const t of texts) p.todos.push({ id: rid(), title: t, needsConfirmation: false, completed: false, completedAt: null });
    return `Added ${texts.length} to-do(s) to ${p.name}:\n` + texts.map(t => "  • " + t).join("\n");
  }),

  add_to_buy: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    p.toBuy = p.toBuy || [];
    const added = [];
    for (const spec of (a.items || [])) {
      if (!spec || !String(spec.text||"").trim()) continue;
      const item = { id: rid(), title: spec.text.trim(), qty: spec.qty || null, completed: false, needsConfirmation: false };
      if (spec.url && /^https?:\/\//i.test(spec.url)) item.url = spec.url;
      else if (spec.url) item.url = "https://" + spec.url;
      p.toBuy.push(item);
      added.push(`${spec.text.trim()}${spec.qty ? " ×" + spec.qty : ""}${item.url ? " (" + item.url + ")" : ""}`);
    }
    if (!added.length) return "No valid items provided.";
    return `Added ${added.length} to-buy item(s) to ${p.name}:\n` + added.map(x => "  • " + x).join("\n");
  }),

  update_item: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const list = p[LIVE_KEY[a.kind]] || [];
    const it = findItem(list, a.match);
    if (!it) return `No ${a.kind} item matching "${a.match}" on ${p.name}.`;
    const did = [];
    if (a.title !== undefined && String(a.title).trim()) { it.title = String(a.title).trim(); did.push("title"); }
    if (a.kind === "schedule") {
      if (a.date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return "Date must be YYYY-MM-DD.";
        it.date = a.date; did.push("date");
      }
      if (a.time !== undefined) {
        if (a.time === "") { it.time = null; did.push("time cleared"); }
        else if (/^\d{1,2}:\d{2}$/.test(a.time)) { it.time = a.time; did.push("time"); }
        else return "Time must be HH:MM or empty to clear.";
      }
      if (a.subcontractor !== undefined) { if (a.subcontractor) it.subcontractor = true; else delete it.subcontractor; did.push("subcontractor"); }
    }
    if (a.kind === "buy") {
      if (a.url !== undefined) {
        if (a.url === "") { delete it.url; did.push("url cleared"); }
        else { it.url = /^https?:\/\//i.test(a.url) ? a.url : "https://" + a.url; did.push("url"); }
      }
      if (a.qty !== undefined) { it.qty = a.qty || null; did.push("qty"); }
    }
    if (a.needs_confirm !== undefined) { it.needsConfirmation = !!a.needs_confirm; did.push("needs_confirm"); }
    return did.length ? `Updated ${a.kind} "${it.title}" on ${p.name}: ${did.join(", ")}.` : "Nothing to change.";
  }),

  check_item: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const it = findItem(p[LIVE_KEY[a.kind]] || [], a.match);
    if (!it) return `No ${a.kind} item matching "${a.match}" on ${p.name}.`;
    const done = a.done !== false;
    it.completed = done;
    it.completedAt = done ? Date.now() : null;
    return `${done ? "Checked off" : "Reopened"} ${a.kind}: "${it.title}" on ${p.name}.`;
  }),

  confirm_item: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const it = findItem(p.schedule || [], a.match);
    if (!it) return `No schedule item matching "${a.match}" on ${p.name}.`;
    it.needsConfirmation = false;
    return `Confirmed: "${it.title}" on ${p.name}.`;
  }),

  delete_item: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const list = p[LIVE_KEY[a.kind]] || [];
    const it = findItem(list, a.match);
    if (!it) return `No ${a.kind} item matching "${a.match}" on ${p.name}.`;
    const idx = list.indexOf(it);
    list.splice(idx, 1);
    it._archivedAt = Date.now();
    const ak = ARCH_KEY[a.kind];
    p[ak] = p[ak] || [];
    p[ak].push(it);
    return `Moved to Archive: "${it.title}" (${a.kind}) on ${p.name}. Recoverable via restore_item.`;
  }),

  restore_item: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const arch = p[ARCH_KEY[a.kind]] || [];
    const it = findItem(arch, a.match);
    if (!it) return `No archived ${a.kind} item matching "${a.match}" on ${p.name}.`;
    arch.splice(arch.indexOf(it), 1);
    it.completed = false;
    it.completedAt = null;
    delete it._archivedAt;
    const lk = LIVE_KEY[a.kind];
    p[lk] = p[lk] || [];
    p[lk].push(it);
    return `Restored "${it.title}" to ${p.name} ${a.kind} list.`;
  }),

  log_time: (a, ctx) => mutate(ctx, (d) => {
    const p = findProject(d, a.project);
    if (!p) return `No project matching "${a.project}".`;
    const hours = Number(a.hours);
    if (!(hours > 0)) return "Hours must be > 0.";
    const date = a.date || mcpToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Date must be YYYY-MM-DD.";
    d.timeEntries = d.timeEntries || [];
    d.timeEntries.push({ id: rid(), projectId: p.id, date, hours, note: a.note || "", createdAt: Date.now() });
    return `Logged ${hours}h on ${p.name} (${date})${a.note ? " — " + a.note : ""}.`;
  }),

  time_summary: (a, ctx) => withData(ctx, (d) => {
    const scope = a.scope || "today";
    const todayISO = mcpToday();
    let sinceISO;
    if (scope === "today") sinceISO = todayISO;
    else if (scope === "week") {
      const base = dayBaseUTC(todayISO);
      const dow = new Date(base).getUTCDay(); // 0 = Sunday, in Toronto calendar terms
      sinceISO = new Date(base - dow * 86400000).toISOString().slice(0, 10);
    } else {
      sinceISO = todayISO.slice(0, 8) + "01";
    }
    const projById = {};
    for (const p of (d.projects || [])) projById[p.id] = p.name;
    const byProj = {};
    let total = 0;
    for (const e of (d.timeEntries || [])) {
      if (!e.date || e.date < sinceISO) continue;
      const name = projById[e.projectId] || "(deleted project)";
      byProj[name] = (byProj[name] || 0) + (+e.hours || 0);
      total += (+e.hours || 0);
    }
    if (!total) return `No time logged ${scope}.`;
    return [`Time ${scope} (total ${total.toFixed(2)}h):`,
      ...Object.entries(byProj).sort((x,y)=>y[1]-x[1]).map(([n,h]) => `  - ${n}: ${h.toFixed(2)}h`)].join("\n");
  }),
};
// Fresh owner mode changes storage routing only; authorization remains above.
export default {async fetch(request,env){try{return await legacyWorker.fetch(request,ownerEnvironment(env));}catch(e){const origin=request.headers.get('origin')||'',allowed=env.ALLOWED_ORIGIN||'*';return json({error:e.message},e.status||500,{'cache-control':'no-store','access-control-allow-origin':allowed==='*'?origin||'*':allowed,'vary':'origin'});}}};
