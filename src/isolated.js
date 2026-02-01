/**
 * Isolated World Script
 * Handles UI interactions and communication between the Main World and Background script.
 * This script runs in a separate environment with access to the DOM but not the Main World's JavaScript variables.
 */

// --- State Management ---
const STATE = {
  configUrl: "https://raw.githubusercontent.com/wowhao333/linuxdo-config/refs/heads/main/user-blocklist.conf", // Default configuration URL
  syncMode: "merge", // Synchronization mode: "merge" (additive) or "overwrite" (replace all)
  isSyncing: false
};

/**
 * Loads user settings from Chrome storage.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["linuxdo_configUrl", "linuxdo_syncMode"], (result) => {
      if (result.linuxdo_configUrl) STATE.configUrl = result.linuxdo_configUrl;
      if (result.linuxdo_syncMode) STATE.syncMode = result.linuxdo_syncMode;
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
      "linuxdo_syncMode": STATE.syncMode
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
  header.textContent = "🛡️ Blocklist Sync";
  header.style.cssText = "font-weight: bold; margin-bottom: 10px; display: flex; justify-content: space-between;";
  
  const closeBtn = document.createElement('span');
  closeBtn.textContent = "✖";
  closeBtn.style.cursor = "pointer";
  closeBtn.onclick = () => container.style.display = 'none';
  header.appendChild(closeBtn);
  
  container.appendChild(header);

  // Config URL Input
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'GitHub Raw URL...';
  urlInput.value = STATE.configUrl;
  urlInput.style.cssText = "width: 100%; margin-bottom: 10px; padding: 5px; background: #333; color: white; border: 1px solid #555;";
  urlInput.onchange = (e) => { STATE.configUrl = e.target.value; saveSettings(); };
  container.appendChild(urlInput);

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
  container.appendChild(modeContainer);

  // Sync Button
  const syncBtn = document.createElement('button');
  syncBtn.id = "linuxdo-sync-btn";
  syncBtn.textContent = "Sync Now";
  syncBtn.style.cssText = "width: 100%; padding: 8px; background: #007bff; color: white; border: none; cursor: pointer; border-radius: 4px;";
  syncBtn.onclick = performSync;
  container.appendChild(syncBtn);

  // Log Area
  logArea = document.createElement('div');
  logArea.style.cssText = "margin-top: 10px; font-size: 12px; color: #aaa; max-height: 100px; overflow-y: auto;";
  container.appendChild(logArea);

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
});
