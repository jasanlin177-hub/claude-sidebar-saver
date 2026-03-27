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
    let url = '';
    let method = 'GET';
    let reqBodyStr = null;

    // 安全地提取 URL 與 Method
    try {
      if (typeof resource === 'string') {
        url = resource;
      } else if (resource instanceof URL) {
        url = resource.href;
      } else if (resource instanceof Request) {
        url = resource.url;
        method = resource.method;
      }
      if (config && config.method) method = config.method;

      const isTargetUrl = url && (
        url.includes('/messages') ||
        url.includes('/chat_conversations') ||
        url.includes('/completion') ||
        url.includes('api.anthropic.com')
      );

      // 提取 Request Body (排除 OPTIONS 請求)
      if (isTargetUrl && method !== 'OPTIONS') {
        if (config && config.body) {
          if (typeof config.body === 'string') reqBodyStr = config.body;
        } else if (resource instanceof Request && !resource.bodyUsed) {
          try {
            reqBodyStr = await resource.clone().text();
          } catch(e) {}
        }

        if (reqBodyStr) {
          try {
            postToIsolated({
              type: 'API_REQUEST',
              url: url,
              method: method,
              body: JSON.parse(reqBodyStr),
              timestamp: Date.now()
            });
          } catch (e) {
            postToIsolated({
              type: 'API_REQUEST',
              url: url,
              method: method,
              body: { raw: reqBodyStr.substring(0, 5000) },
              timestamp: Date.now()
            });
          }
        }
      }
    } catch (e) {
      console.log('[CSS-Main] Error capturing request body:', e.message);
    }

    // Call original fetch
    const response = await originalFetch.apply(this, args);

    // 處理 Response
    try {
      const urlToCheck = url || (response && response.url) || '';
      const isTargetUrl = urlToCheck && (
        urlToCheck.includes('/messages') ||
        urlToCheck.includes('/chat_conversations') ||
        urlToCheck.includes('/completion') ||
        urlToCheck.includes('api.anthropic.com')
      );

      if (isTargetUrl && response.ok) {
        const cloned = response.clone();
        const ct = cloned.headers.get('content-type') || '';

        if (ct.includes('text/event-stream')) {
          console.log('[CSS-Main] SSE stream detected for:', urlToCheck);
          const reader = cloned.body.getReader();
          const decoder = new TextDecoder();
          let assistantMsg = '';
          let alreadySent = false;
          let buffer = ''; // 加入 Buffer 解決 Chunk 被截斷的問題

          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 保留最後一行不完整的 Chunk

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('data:')) {
                    const dataContent = trimmed.slice(5).trim();
                    if (dataContent === '[DONE]') continue;
                    
                    try {
                      const evt = JSON.parse(dataContent);
                      if ((evt.type === 'content_block_delta' || evt.type === 'text_delta') && evt.delta && evt.delta.text) {
                        assistantMsg += evt.delta.text;
                      } else if (evt.type === 'completion' && evt.completion) {
                        assistantMsg += evt.completion;
                      }
                      
                      if (evt.type === 'message_stop' || evt.type === 'message_delta' || evt.stop_reason) {
                        if (assistantMsg.length > 0 && !alreadySent) {
                          alreadySent = true;
                          console.log('[CSS-Main] Stream complete, length:', assistantMsg.length);
                          postToIsolated({
                            type: 'API_RESPONSE_STREAM_COMPLETE',
                            url: urlToCheck,
                            assistantMessage: assistantMsg,
                            timestamp: Date.now()
                          });
                        }
                      }
                    } catch (pe) { /* not JSON */ }
                  }
                }
              }
              // 最終強制輸出
              if (assistantMsg.length > 0 && !alreadySent) {
                postToIsolated({
                  type: 'API_RESPONSE_STREAM_COMPLETE',
                  url: urlToCheck,
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
          console.log('[CSS-Main] JSON response from:', urlToCheck);
          postToIsolated({
            type: 'API_RESPONSE_JSON',
            url: urlToCheck,
            data: data,
            timestamp: Date.now()
          });
        }
      }
    } catch (e) {
      console.log('[CSS-Main] Error reading response:', e.message);
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
