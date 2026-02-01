/**
 * Background Service Worker
 * Handles cross-origin requests that cannot be performed directly in content scripts due to CORS policies.
 */

/**
 * Listen for messages from content scripts.
 * Primary function is to proxy fetch requests to bypass CORS restrictions.
 * 
 * @param {object} request - The message request object.
 * @param {object} sender - Information about the script context that sent the message.
 * @param {function} sendResponse - Function to call (at most once) when you have a response.
 * @returns {boolean} - Returns true to indicate that the response is sent asynchronously.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchConfig") {
    fetch(request.url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.text();
      })
      .then(text => sendResponse({ success: true, data: text }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
