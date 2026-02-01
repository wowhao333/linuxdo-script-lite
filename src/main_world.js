/**
 * Main World Script
 * Injected into the page to interact directly with the Discourse Javascript API and DOM.
 */

// --- Helper Functions ---

/**
 * Retrieves the CSRF token from the document meta tags.
 * Required for making authenticated requests to the Discourse API.
 * 
 * @returns {string|null} - The CSRF token or null if not found.
 */
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || null;
}

/**
 * Performs a fetch request with necessary Discourse headers (CSRF, X-Requested-With).
 * 
 * @param {string} url - The URL to fetch.
 * @param {object} options - Fetch options (method, headers, body).
 * @returns {Promise<any>} - The JSON response.
 * @throws {Error} - If CSRF token is missing or response is not OK.
 */
async function fetchJson(url, { method = "GET", headers, body } = {}) {
  const csrf = getCsrfToken();
  if (!csrf) throw new Error("CSRF token not found");

  const resp = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-CSRF-Token": csrf,
      "X-Requested-With": "XMLHttpRequest",
      ...(headers || {})
    },
    credentials: "include",
    body
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json().catch(() => ({}));
}

/**
 * Infers the current user's username from the Discourse global object or meta tags.
 * 
 * @returns {string|null} - The username or null if not found.
 */
function inferMyUsername() {
  try {
    const u = window.Discourse?.User?.current?.();
    if (u?.username) return u.username;
  } catch {}
  // Fallback: Retrieve username from meta tag, which is reliable in Discourse environment.
  return document.querySelector('meta[name="current-user"]')?.getAttribute("content") || null;
}

let _cachedUserId = null;

/**
 * Gets the current user's ID, caching it for future calls.
 * @returns {Promise<number>} - The user ID.
 * @throws {Error} - If username cannot be inferred or ID cannot be retrieved.
 */
async function getMyUserId() {
  if (_cachedUserId) return _cachedUserId;

  const me = inferMyUsername();
  if (!me) throw new Error("Cannot infer current username");
  const data = await fetchJson(`/u/${encodeURIComponent(me)}.json`);
  const id = data?.user?.id;
  if (!id) throw new Error("Cannot read current user id");
  
  _cachedUserId = id;
  return id;
}

/**
 * Sets the notification level for a specific user (ignore/unignore).
 * 
 * @param {object} params - Parameters for the request.
 * @param {string} params.ignoreUsername - The username to modify.
 * @param {string} params.notificationLevel - The level (e.g., "ignore", "normal").
 * @param {string} [params.actingUserId] - The ID of the current user acting.
 * @param {string} [params.expiringAt] - ISO date string for expiration (optional).
 * @returns {Promise<any>} - The API response.
 */
async function setIgnoreUser({ ignoreUsername, notificationLevel, actingUserId, expiringAt }) {
  if (!ignoreUsername) throw new Error("ignoreUsername required");

  // Discourse API requires acting_user_id and form-urlencoded body
  const body = new URLSearchParams();
  body.set("notification_level", notificationLevel);
  if (expiringAt) body.set("expiring_at", expiringAt);

  const actor = actingUserId ?? (await getMyUserId());
  body.set("acting_user_id", String(actor));

  return fetchJson(`/u/${encodeURIComponent(ignoreUsername)}/notification_level.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: body.toString()
  });
}

/**
 * Generates an expiration date 100 years in the future.
 * Used for "permanent" ignore duration.
 * @returns {string} - Date string in YYYY-MM-DD format.
 */
function getDefaultExpiringAt() {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 100);
    // Format: YYYY-MM-DD
    const iso = d.toISOString(); // 2026-02-01T...
    return iso.split('T')[0];
}

window.__linuxDoIgnoreUser = {
  getMyUserId, // Exposed for debugging purposes
  ignoreUser: async (username, actingUserId) => {
    // Default to 100 years if not specified
    const expiringAt = getDefaultExpiringAt();
    return setIgnoreUser({ 
        ignoreUsername: username, 
        notificationLevel: "ignore", 
        expiringAt,
        actingUserId 
    });
  },
  unignoreUser: async (username, actingUserId) => {
    return setIgnoreUser({ 
        ignoreUsername: username, 
        notificationLevel: "normal",
        actingUserId
    });
  },
  _processBatch: async (action, usernames) => {
    console.log(`[Linux DO Script] Batch processing ${action} for ${usernames.length} users`);
    
    // Optimization: Get User ID once
    let myUserId = null;
    try {
        myUserId = await getMyUserId();
    } catch (e) {
        console.error("Failed to get acting user ID:", e);
        return [{ success: false, error: "Failed to get user ID" }];
    }

    const results = [];
    for (const username of usernames) {
      try {
        if (action === 'ignore') {
          await window.__linuxDoIgnoreUser.ignoreUser(username, myUserId);
        } else if (action === 'unignore') {
          await window.__linuxDoIgnoreUser.unignoreUser(username, myUserId);
        }
        results.push({ username, success: true });
        // Rate limiting
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`Failed to ${action} ${username}:`, e);
        results.push({ username, success: false, error: e.message });
      }
    }
    return results;
  },
  _getIgnoredUsers: async () => {
    const me = inferMyUsername();
    if (!me) throw new Error("Cannot infer current username");
    const data = await fetchJson(`/u/${encodeURIComponent(me)}.json`);
    return data?.user?.ignored_usernames ?? [];
  }
};

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.data.type && event.data.type === "LINUXDO_SCRIPT_COMMAND") {
    const { action, payload, reqId } = event.data;
    
    try {
        if (action === "syncBlocklist") {
           const { toBlock, toUnblock } = payload;
           
           if (toBlock && toBlock.length > 0) {
             await window.__linuxDoIgnoreUser._processBatch('ignore', toBlock);
           }
           if (toUnblock && toUnblock.length > 0) {
             await window.__linuxDoIgnoreUser._processBatch('unignore', toUnblock);
           }
           
           window.postMessage({ type: "LINUXDO_SCRIPT_RESPONSE", reqId, success: true }, "*");
        } else if (action === "getIgnoredUsers") {
            const users = await window.__linuxDoIgnoreUser._getIgnoredUsers();
            window.postMessage({ type: "LINUXDO_SCRIPT_RESPONSE", reqId, success: true, data: users }, "*");
        }
    } catch (error) {
        console.error("Linux DO Script Error:", error);
        window.postMessage({ 
            type: "LINUXDO_SCRIPT_RESPONSE", 
            reqId, 
            success: false, 
            error: error.message 
        }, "*");
    }
  }
});
