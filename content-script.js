// Content Script for Claude Sidebar Saver v4
// Injected into Claude sidebar extension page to intercept fetch requests
// This runs in the context of the Claude sidebar page

(function() {
    'use strict';

   console.log('[CSS-ContentScript] Content script loaded in Claude sidebar page');
    console.log('[CSS-ContentScript] URL:', window.location.href);

   // Store the original fetch
   const originalFetch = window.fetch;

   // Override fetch to intercept API calls
   window.fetch = async function(...args) {
         const [resource, config] = args;
         const url = typeof resource === 'string' ? resource : resource.url;

         // Check if this is a Claude API message request
         if (url && (url.includes('/messages') || url.includes('/chat_conversations'))) {
                 console.log('[CSS-ContentScript] Intercepted fetch:', url);

           try {
                     // Capture the request body (user message)
                   if (config && config.body) {
                               let bodyData;
                               if (typeof config.body === 'string') {
                                             bodyData = JSON.parse(config.body);
                               } else if (config.body instanceof ReadableStream) {
                                             // Clone the stream to read it
                                 const cloned = config.body.tee();
                                             config.body = cloned[0];
                                             const reader = cloned[1].getReader();
                                             const chunks = [];
                                             let done = false;
                                             while (!done) {
                                                             const result = await reader.read();
                                                             done = result.done;
                                                             if (result.value) chunks.push(result.value);
                                             }
                                             const text = new TextDecoder().decode(new Uint8Array(chunks.flat()));
                                             bodyData = JSON.parse(text);
                               }

                       if (bodyData) {
                                     console.log('[CSS-ContentScript] Request body captured');
                                     // Send to background script
                                 chrome.runtime.sendMessage({
                                                 type: 'API_REQUEST',
                                                 url: url,
                                                 method: config.method || 'GET',
                                                 body: bodyData,
                                                 timestamp: Date.now()
                                 });
                       }
                   }
           } catch (e) {
                     console.log('[CSS-ContentScript] Error parsing request:', e.message);
           }
         }

         // Call original fetch and intercept the response
         const response = await originalFetch.apply(this, args);

         // Clone response to read it without consuming
         if (url && (url.includes('/messages') || url.includes('/chat_conversations'))) {
                 try {
                           const clonedResponse = response.clone();
                           const contentType = clonedResponse.headers.get('content-type') || '';

                   if (contentType.includes('text/event-stream')) {
                               // Handle SSE streaming response (Claude's typical response format)
                             console.log('[CSS-ContentScript] SSE stream response detected');
                               const reader = clonedResponse.body.getReader();
                               const decoder = new TextDecoder();
                               let fullText = '';
                               let assistantMessage = '';

                             const readStream = async () => {
                                           try {
                                                           while (true) {
                                                                             const { done, value } = await reader.read();
                                                                             if (done) break;
                                                                             const chunk = decoder.decode(value, { stream: true });
                                                                             fullText += chunk;

                                                             // Parse SSE events to extract text
                                                             const lines = chunk.split('\n');
                                                                             for (const line of lines) {
                                                                                                 if (line.startsWith('data: ')) {
                                                                                                                       try {
                                                                                                                                               const data = JSON.parse(line.slice(6));
                                                                                                                                               if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
                                                                                                                                                                         assistantMessage += data.delta.text;
                                                                                                                                                 }
                                                                                                                                               if (data.type === 'message_stop') {
                                                                                                                                                                         console.log('[CSS-ContentScript] Stream complete, message length:', assistantMessage.length);
                                                                                                                                                                         chrome.runtime.sendMessage({
                                                                                                                                                                                                     type: 'API_RESPONSE_STREAM_COMPLETE',
                                                                                                                                                                                                     url: url,
                                                                                                                                                                                                     assistantMessage: assistantMessage,
                                                                                                                                                                                                     timestamp: Date.now()
                                                                                                                                                                           });
                                                                                                                                                 }
                                                                                                                         } catch (parseErr) {
                                                                                                                                               // Not all data lines are JSON
                                                                                                                         }
                                                                                                   }
                                                                             }
                                                           }
                                           } catch (streamErr) {
                                                           console.log('[CSS-ContentScript] Stream read error:', streamErr.message);
                                           }
                             };
                               readStream(); // Don't await - let it run in background

                   } else if (contentType.includes('application/json')) {
                               // Handle JSON response
                             const data = await clonedResponse.json();
                               console.log('[CSS-ContentScript] JSON response captured from:', url);
                               chrome.runtime.sendMessage({
                                             type: 'API_RESPONSE_JSON',
                                             url: url,
                                             data: data,
                                             timestamp: Date.now()
                               });
                   }
                 } catch (e) {
                           console.log('[CSS-ContentScript] Error reading response:', e.message);
                 }
         }

         return response;
   };

   // Also intercept XMLHttpRequest as a fallback
   const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

   XMLHttpRequest.prototype.open = function(method, url, ...rest) {
         this._cssUrl = url;
         this._cssMethod = method;
         return originalXHROpen.call(this, method, url, ...rest);
   };

   XMLHttpRequest.prototype.send = function(body) {
         if (this._cssUrl && (this._cssUrl.includes('/messages') || this._cssUrl.includes('/chat_conversations'))) {
                 console.log('[CSS-ContentScript] XHR intercepted:', this._cssMethod, this._cssUrl);

           if (body) {
                     try {
                                 const bodyData = JSON.parse(body);
                                 chrome.runtime.sendMessage({
                                               type: 'API_REQUEST',
                                               url: this._cssUrl,
                                               method: this._cssMethod,
                                               body: bodyData,
                                               timestamp: Date.now()
                                 });
                     } catch (e) {
                                 // Body might not be JSON
                     }
           }

           // Listen for response
           this.addEventListener('load', function() {
                     try {
                                 const data = JSON.parse(this.responseText);
                                 chrome.runtime.sendMessage({
                                               type: 'API_RESPONSE_JSON',
                                               url: this._cssUrl,
                                               data: data,
                                               timestamp: Date.now()
                                 });
                     } catch (e) {
                                 // Response might not be JSON
                     }
           });
         }
         return originalXHRSend.call(this, body);
   };

   // Also try to observe DOM changes to capture conversation content directly
   const observer = new MutationObserver((mutations) => {
         // Look for new message elements being added
                                             for (const mutation of mutations) {
                                                     for (const node of mutation.addedNodes) {
                                                               if (node.nodeType === Node.ELEMENT_NODE) {
                                                                           // Check for common message container patterns
                                                                 const messageEl = node.querySelector ? 
                                                                               node.querySelector('[data-testid*="message"], .prose, [class*="message"]') : null;
                                                                           if (messageEl || (node.classList && (
                                                                                         node.classList.contains('prose') || 
                                                                                         node.className.includes('message')
                                                                                       ))) {
                                                                                         console.log('[CSS-ContentScript] New DOM message element detected');
                                                                                         // Small delay to let content render
                                                                             setTimeout(() => {
                                                                                             const text = (messageEl || node).textContent;
                                                                                             if (text && text.length > 0) {
                                                                                                               chrome.runtime.sendMessage({
                                                                                                                                   type: 'DOM_MESSAGE',
                                                                                                                                   content: text.substring(0, 10000), // Limit size
                                                                                                                                   timestamp: Date.now()
                                                                                                                 });
                                                                                               }
                                                                             }, 500);
                                                                           }
                                                               }
                                                     }
                                             }
   });

   // Start observing when DOM is ready
   if (document.body) {
         observer.observe(document.body, { childList: true, subtree: true });
         console.log('[CSS-ContentScript] DOM observer started');
   } else {
         document.addEventListener('DOMContentLoaded', () => {
                 observer.observe(document.body, { childList: true, subtree: true });
                 console.log('[CSS-ContentScript] DOM observer started (after DOMContentLoaded)');
         });
   }

   console.log('[CSS-ContentScript] All interceptors installed successfully');
})();
