/**
 * Isolated World Script
 * Handles UI interactions and communication between the Main World and Background script.
 * This script runs in a separate environment with access to the DOM but not the Main World's JavaScript variables.
 */

// --- State Management ---
const STATE = {
  configUrl: "https://raw.githubusercontent.com/wowhao333/linuxdo-config/refs/heads/main/user-blocklist.conf", // Default configuration URL
  syncMode: "merge", // Synchronization mode: "merge" (additive) or "overwrite" (replace all)
  autoScrollToMain: true, // Auto-redirect to main post
  isSyncing: false
};

/**
 * Loads user settings from Chrome storage.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["linuxdo_configUrl", "linuxdo_syncMode", "linuxdo_autoScrollToMain"], (result) => {
      if (result.linuxdo_configUrl) STATE.configUrl = result.linuxdo_configUrl;
      if (result.linuxdo_syncMode) STATE.syncMode = result.linuxdo_syncMode;
      if (result.linuxdo_autoScrollToMain !== undefined) STATE.autoScrollToMain = result.linuxdo_autoScrollToMain;
      resolve();
    });
  });
}

/**
 * Saves current settings to Chrome storage.
 * @returns {Promise<void>}
 */
async function saveSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      "linuxdo_configUrl": STATE.configUrl,
      "linuxdo_syncMode": STATE.syncMode,
      "linuxdo_autoScrollToMain": STATE.autoScrollToMain
    }, resolve);
  });
}

/**
 * Sends a message to the Main World and waits for a response.
 * Uses window.postMessage for cross-world communication.
 * 
 * @param {string} action - The action to perform (e.g., "getIgnoredUsers").
 * @param {any} [payload] - Optional data payload to send.
 * @returns {Promise<any>} - The response data from the Main World.
 */
function sendToMain(action, payload) {
  return new Promise((resolve) => {
    const reqId = Math.random().toString(36).substring(7);
    
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data.type === "LINUXDO_SCRIPT_RESPONSE" && event.data.reqId === reqId) {
        window.removeEventListener("message", handler);
        resolve(event.data);
      }
    };
    
    window.addEventListener("message", handler);
    window.postMessage({ type: "LINUXDO_SCRIPT_COMMAND", action, payload, reqId }, "*");
  });
}

// Listen for URL changes from Main World (Immediate reaction)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data.type === "LINUXDO_URL_CHANGE") {
    checkAndRedirect();
  }
});

/**
 * Fetches the configuration file via the Background script.
 * 
 * @param {string} url - The URL of the configuration file.
 * @returns {Promise<string>} - The content of the configuration file.
 * @throws {Error} - If the fetch operation fails.
 */
function fetchConfig(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "fetchConfig", url }, (response) => {
      if (response && response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || "Unknown fetch error"));
      }
    });
  });
}

// --- Logic ---

/**
 * Checks current URL and redirects to main post if needed.
 * Logic:
 * 1. Must be enabled in settings.
 * 2. Must be a topic URL with post ID > 1.
 * 3. Must be a NEW entry (different topic ID than before), to avoid interrupting scrolling.
 */
let lastTopicId = null;

function checkAndRedirect() {
  if (!STATE.autoScrollToMain) return;

  const url = window.location.href;
  // Regex: https://linux.do/t/[slug]/[topic_id]/[post_id]
  // Note: Handle optional slug or structure variations if needed, but standard is /t/topic/123/456
  const match = url.match(/\/t\/[^/]+\/(\d+)\/(\d+)/);

  if (match) {
    const topicId = match[1];
    const postId = parseInt(match[2], 10);

    // If it's the first time seeing this topic (Entry) AND we are not at post 1
    if (topicId !== lastTopicId) {
      lastTopicId = topicId; // Update tracking

      if (postId > 1) {
        const newUrl = url.replace(/\/\d+$/, "/1");
        log(`Redirecting to main post: ${newUrl}`);
        sendToMain("navigateTo", { url: newUrl });
      }
    }
  } else {
    // Not a topic page (or main post without ID), reset tracker
    // Check if it's a topic page without post ID (e.g. /t/slug/123) -> that implies post 1, so update tracker
    const matchTopicOnly = url.match(/\/t\/[^/]+\/(\d+)/);
    if (matchTopicOnly) {
        lastTopicId = matchTopicOnly[1];
    } else {
        lastTopicId = null;
    }
  }
}

// Monitor URL changes
let lastUrl = window.location.href;
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    checkAndRedirect();
  }
}, 500);

/**
 * Parses the raw configuration text into a list of usernames.
 * Ignores empty lines and lines starting with '#'.
 * 
 * @param {string} text - The raw text content of the configuration file.
 * @returns {string[]} - An array of valid usernames.
 */
function parseConfig(text) {
  const users = [];
  const lines = text.split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    users.push(line);
  }
  return users;
}

/**
 * Executes the synchronization process.
 * Fetches the remote config, compares it with local state, and updates the blocklist.
 * @returns {Promise<void>}
 */
async function performSync() {
  if (STATE.isSyncing) return;
  STATE.isSyncing = true;
  updateUI();

  try {
    log("Fetching config from GitHub...");
    const configText = await fetchConfig(STATE.configUrl);
    const remoteUsers = parseConfig(configText);
    log(`Found ${remoteUsers.length} users in remote config.`);

    log("Getting current ignored users...");
    
    // In 'overwrite' mode, we need the full current list to determine who to unblock.
    // In 'merge' mode, we fetch it to avoid redundant API calls for users already blocked.
    
    let toBlock = [];
    let toUnblock = [];

    if (STATE.syncMode === "overwrite") {
        const resp = await sendToMain("getIgnoredUsers");
        const currentIgnored = resp.data || [];
        
        const remoteSet = new Set(remoteUsers);
        const currentSet = new Set(currentIgnored);
        
        toBlock = remoteUsers.filter(u => !currentSet.has(u));
        toUnblock = currentIgnored.filter(u => !remoteSet.has(u));
    } else {
        // Merge mode: Only add new users.
        // Optimization: Fetch current list to filter out existing ignored users.
        const resp = await sendToMain("getIgnoredUsers");
        const currentIgnored = new Set(resp.data || []);
        toBlock = remoteUsers.filter(u => !currentIgnored.has(u));
    }

    log(`Syncing: Blocking ${toBlock.length}, Unblocking ${toUnblock.length}...`);
    
    if (toBlock.length > 0 || toUnblock.length > 0) {
        await sendToMain("syncBlocklist", { toBlock, toUnblock });
        log("Sync completed successfully!");
    } else {
        log("Already up to date.");
    }

  } catch (error) {
    log(`Error: ${error.message}`);
    console.error(error);
  } finally {
    STATE.isSyncing = false;
    updateUI();
  }
}

// --- UI ---
let panel = null;
let logArea = null;

function createUI() {
  const container = document.createElement('div');
  container.id = 'linuxdo-sync-panel';
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 300px;
    background: #222;
    color: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    z-index: 9999;
    font-family: sans-serif;
    display: none;
    flex-direction: column;
    padding: 15px;
  `;

  const header = document.createElement('div');
  header.textContent = "Linux DO Script Lite";
  header.style.cssText = "font-weight: bold; margin-bottom: 15px; display: flex; justify-content: space-between; border-bottom: 1px solid #444; padding-bottom: 10px;";
  
  const closeBtn = document.createElement('span');
  closeBtn.textContent = "✖";
  closeBtn.style.cursor = "pointer";
  closeBtn.onclick = () => container.style.display = 'none';
  header.appendChild(closeBtn);
  
  container.appendChild(header);

  // --- Section 1: Blocklist Sync ---
  const syncSection = document.createElement('fieldset');
  syncSection.style.cssText = "border: 1px solid #444; margin-bottom: 15px; padding: 10px; border-radius: 4px;";
  const syncLegend = document.createElement('legend');
  syncLegend.textContent = "Blocklist Sync";
  syncLegend.style.cssText = "padding: 0 5px; color: #ccc; font-size: 0.9em;";
  syncSection.appendChild(syncLegend);

  // Config URL Input
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'GitHub Raw URL...';
  urlInput.value = STATE.configUrl;
  urlInput.style.cssText = "width: 100%; margin-bottom: 10px; padding: 5px; background: #333; color: white; border: 1px solid #555; box-sizing: border-box;";
  urlInput.onchange = (e) => { STATE.configUrl = e.target.value; saveSettings(); };
  syncSection.appendChild(urlInput);

  // Mode Selection
  const modeContainer = document.createElement('div');
  modeContainer.style.marginBottom = "10px";
  
  const label1 = document.createElement('label');
  label1.style.marginRight = "10px";
  const radio1 = document.createElement('input');
  radio1.type = "radio";
  radio1.name = "syncMode";
  radio1.value = "merge";
  radio1.checked = STATE.syncMode === "merge";
  radio1.onchange = (e) => { if(e.target.checked) { STATE.syncMode = "merge"; saveSettings(); } };
  label1.appendChild(radio1);
  label1.appendChild(document.createTextNode(" Merge (Add only)"));
  
  const label2 = document.createElement('label');
  const radio2 = document.createElement('input');
  radio2.type = "radio";
  radio2.name = "syncMode";
  radio2.value = "overwrite";
  radio2.checked = STATE.syncMode === "overwrite";
  radio2.onchange = (e) => { if(e.target.checked) { STATE.syncMode = "overwrite"; saveSettings(); } };
  label2.appendChild(radio2);
  label2.appendChild(document.createTextNode(" Overwrite"));

  modeContainer.appendChild(label1);
  modeContainer.appendChild(label2);
  syncSection.appendChild(modeContainer);

  // Sync Button
  const syncBtn = document.createElement('button');
  syncBtn.id = "linuxdo-sync-btn";
  syncBtn.textContent = "Sync Now";
  syncBtn.style.cssText = "width: 100%; padding: 8px; background: #007bff; color: white; border: none; cursor: pointer; border-radius: 4px;";
  syncBtn.onclick = performSync;
  syncSection.appendChild(syncBtn);

  // Log Area
  logArea = document.createElement('div');
  logArea.textContent = "// Log output area";
  logArea.style.cssText = "margin: 10px -10px -10px -10px; font-size: 12px; color: #aaa; max-height: 80px; overflow-y: auto; background: #111; padding: 5px 10px; border-top: 1px solid #444;";
  syncSection.appendChild(logArea);

  container.appendChild(syncSection);

  // --- Section 2: Feature ---
  const featureSection = document.createElement('fieldset');
  featureSection.style.cssText = "border: 1px solid #444; margin-bottom: 0px; padding: 10px; border-radius: 4px;";
  const featureLegend = document.createElement('legend');
  featureLegend.textContent = "Feature";
  featureLegend.style.cssText = "padding: 0 5px; color: #ccc; font-size: 0.9em;";
  featureSection.appendChild(featureLegend);

  const labelScroll = document.createElement('label');
  labelScroll.style.cssText = "display: flex; align-items: center; cursor: pointer;";
  
  const checkScroll = document.createElement('input');
  checkScroll.type = "checkbox";
  checkScroll.checked = STATE.autoScrollToMain;
  checkScroll.style.marginRight = "8px";
  checkScroll.onchange = (e) => { 
    STATE.autoScrollToMain = e.target.checked; 
    saveSettings(); 
  };

  labelScroll.appendChild(checkScroll);
  labelScroll.appendChild(document.createTextNode("Auto-redirect to Main Post"));
  featureSection.appendChild(labelScroll);

  container.appendChild(featureSection);

  document.body.appendChild(container);
  panel = container;

  // Toggle Button (Small icon)
  const toggleBtn = document.createElement('div');
  toggleBtn.textContent = "🛡️";
  toggleBtn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 40px;
    height: 40px;
    background: #333;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 9998;
    box-shadow: 0 2px 5px rgba(0,0,0,0.5);
    font-size: 20px;
  `;
  toggleBtn.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  };
  document.body.appendChild(toggleBtn);
}

function updateUI() {
  const btn = document.getElementById('linuxdo-sync-btn');
  if (btn) {
    btn.disabled = STATE.isSyncing;
    btn.textContent = STATE.isSyncing ? "Syncing..." : "Sync Now";
    btn.style.opacity = STATE.isSyncing ? "0.7" : "1";
  }
}

function log(msg) {
  if (logArea) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }
}

// --- Init ---
loadSettings().then(() => {
  createUI();
  // Initial check on load
  checkAndRedirect();
});
