// content-script.js — MAIN world script for Claude Sidebar Saver v5
// Runs in the page's JS context (world: "MAIN") to monkey-patch fetch/XHR
// Communicates to the ISOLATED world bridge via window.postMessage

(function() {
  'use strict';

  const CSS_MSG_PREFIX = '__CSS_INTERCEPT__';

  console.log('[CSS-Main] Content script (MAIN world) loaded');
  console.log('[CSS-Main] URL:', window.location.href);

  function postToIsolated(data) {
    window.postMessage({ source: CSS_MSG_PREFIX, payload: data }, '*');
  }

  // ── Intercept fetch ──────────
  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const [resource, config] = args;
    const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');

    const isTargetUrl = url && (
      url.includes('/messages') ||
      url.includes('/chat_conversations') ||
      url.includes('/completion') ||
      url.includes('api.anthropic.com')
    );

    if (isTargetUrl) {
      console.log('[CSS-Main] Fetch intercepted:', config && config.method || 'GET', url);

      // Capture request body
      try {
        if (config && config.body) {
          let bodyStr = '';
          if (typeof config.body === 'string') {
            bodyStr = config.body;
          } else if (config.body instanceof Blob) {
            bodyStr = await config.body.text();
          } else if (config.body instanceof ArrayBuffer) {
            bodyStr = new TextDecoder().decode(config.body);
          }

          if (bodyStr) {
            try {
              const bodyData = JSON.parse(bodyStr);
              postToIsolated({
                type: 'API_REQUEST',
                url: url,
                method: config.method || 'POST',
                body: bodyData,
                timestamp: Date.now()
              });
            } catch (e) {
              postToIsolated({
                type: 'API_REQUEST',
                url: url,
                method: config.method || 'POST',
                body: { raw: bodyStr.substring(0, 5000) },
                timestamp: Date.now()
              });
            }
          }
        }
      } catch (e) {
        console.log('[CSS-Main] Error capturing request body:', e.message);
      }
    }

    // Call original fetch
    const response = await originalFetch.apply(this, args);

    // Intercept response for target URLs
    if (isTargetUrl) {
      try {
        const cloned = response.clone();
        const ct = cloned.headers.get('content-type') || '';

        if (ct.includes('text/event-stream')) {
          // SSE streaming response
          console.log('[CSS-Main] SSE stream detected for:', url);
          const reader = cloned.body.getReader();
          const decoder = new TextDecoder();
          let assistantMsg = '';
          let alreadySent = false; // ← Fix: prevent duplicate sends

          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    try {
                      const evt = JSON.parse(line.slice(6));
                      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
                        assistantMsg += evt.delta.text;
                      }
                      if (evt.type === 'message_stop' || evt.type === 'message_delta') {
                        if (assistantMsg.length > 0 && !alreadySent) {
                          alreadySent = true; // ← Fix: mark as sent
                          console.log('[CSS-Main] Stream complete, length:', assistantMsg.length);
                          postToIsolated({
                            type: 'API_RESPONSE_STREAM_COMPLETE',
                            url: url,
                            assistantMessage: assistantMsg,
                            timestamp: Date.now()
                          });
                        }
                      }
                    } catch (pe) { /* not JSON */ }
                  }
                }
              }
              // Final flush only if message_stop wasn't received
              if (assistantMsg.length > 0 && !alreadySent) {
                postToIsolated({
                  type: 'API_RESPONSE_STREAM_COMPLETE',
                  url: url,
                  assistantMessage: assistantMsg,
                  timestamp: Date.now()
                });
              }
            } catch (se) {
              console.log('[CSS-Main] Stream read error:', se.message);
            }
          })();

        } else if (ct.includes('application/json')) {
          const data = await cloned.json();
          console.log('[CSS-Main] JSON response from:', url);
          postToIsolated({
            type: 'API_RESPONSE_JSON',
            url: url,
            data: data,
            timestamp: Date.now()
          });
        }
      } catch (e) {
        console.log('[CSS-Main] Error reading response:', e.message);
      }
    }

    return response;
  };

  // ── Intercept XMLHttpRequest ──────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._cssUrl = url;
    this._cssMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const isTarget = this._cssUrl && (
      this._cssUrl.includes('/messages') ||
      this._cssUrl.includes('/chat_conversations') ||
      this._cssUrl.includes('/completion')
    );

    if (isTarget) {
      console.log('[CSS-Main] XHR intercepted:', this._cssMethod, this._cssUrl);
      if (body) {
        try {
          postToIsolated({
            type: 'API_REQUEST',
            url: this._cssUrl,
            method: this._cssMethod,
            body: JSON.parse(body),
            timestamp: Date.now()
          });
        } catch (e) { /* not JSON */ }
      }

      this.addEventListener('load', () => {
        try {
          postToIsolated({
            type: 'API_RESPONSE_JSON',
            url: this._cssUrl,
            data: JSON.parse(this.responseText),
            timestamp: Date.now()
          });
        } catch (e) { /* not JSON */ }
      });
    }
    return origSend.call(this, body);
  };

  console.log('[CSS-Main] Fetch and XHR interceptors installed');
})();
