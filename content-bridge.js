// content-bridge.js — ISOLATED world bridge for Claude Sidebar Saver v4
// Listens for postMessage from MAIN world content-script.js
// Forwards messages to background.js via chrome.runtime.sendMessage

(function() {
    'use strict';

   const CSS_MSG_PREFIX = '__CSS_INTERCEPT__';

   console.log('[CSS-Bridge] Bridge script (ISOLATED world) loaded');
    console.log('[CSS-Bridge] URL:', window.location.href);

   // Listen for messages from MAIN world
   window.addEventListener('message', (event) => {
         // Only accept messages from our own page
                               if (event.source !== window) return;
         if (!event.data || event.data.source !== CSS_MSG_PREFIX) return;

                               const payload = event.data.payload;
         if (!payload || !payload.type) return;

                               console.log('[CSS-Bridge] Forwarding message:', payload.type);

                               // Forward to background script
                               try {
                                       chrome.runtime.sendMessage(payload, (response) => {
                                                 if (chrome.runtime.lastError) {
                                                             console.log('[CSS-Bridge] Send error:', chrome.runtime.lastError.message);
                                                 } else {
                                                             console.log('[CSS-Bridge] Message forwarded successfully:', payload.type);
                                                 }
                                       });
                               } catch (e) {
                                       console.log('[CSS-Bridge] Error sending message:', e.message);
                               }
   });

   console.log('[CSS-Bridge] Bridge listener installed, waiting for messages from MAIN world');
})();
