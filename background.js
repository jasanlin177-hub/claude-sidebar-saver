// background.js — Claude Sidebar Saver Service Worker v3
// Uses chrome.debugger API to intercept Claude extension network requests

console.log('[CSS] Service Worker v3 starting up...');

// Claude extension ID (from user's DevTools screenshot)
const CLAUDE_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

// —— ConversationManager ————————————————————————————————————

class ConversationManager {
      constructor() {
              this.STORAGE_KEY = "css_conversations";
              this.MAX_CONVERSATIONS = 200;
      }

  async getAll() {
          const data = await chrome.storage.local.get(this.STORAGE_KEY);
          return data[this.STORAGE_KEY] || [];
  }

  async getById(id) {
          const all = await this.getAll();
          return all.find((c) => c.id === id) || null;
  }

  async save(conversation) {
          const all = await this.getAll();
          const idx = all.findIndex((c) => c.id === conversation.id);
          if (idx >= 0) all[idx] = conversation;
          else {
                    all.unshift(conversation);
                    if (all.length > this.MAX_CONVERSATIONS) all.pop();
          }
          await chrome.storage.local.set({ [this.STORAGE_KEY]: all });
          return conversation;
  }

  async delete(id) {
          const all = await this.getAll();
          await chrome.storage.local.set({ [this.STORAGE_KEY]: all.filter((c) => c.id !== id) });
  }

  async getStats() {
          const all = await this.getAll();
          const totalMessages = all.reduce((sum, c) => sum + c.messages.length, 0);
          return { totalConversations: all.length, totalMessages };
  }

  createConversation(userMessage, url) {
          const now = Date.now();
          return {
                    id: `conv_${now}_${Math.random().toString(36).slice(2, 7)}`,
                    title: userMessage.length > 60 ? userMessage.slice(0, 60) + '...' : userMessage || 'Untitled',
                    url,
                    createdAt: now,
                    updatedAt: now,
                    messages: [{ role: 'user', content: userMessage, timestamp: now }],
          };
  }

  appendAssistantMessage(conversation, content) {
          conversation.messages.push({ role: 'assistant', content, timestamp: Date.now() });
          conversation.updatedAt = Date.now();
          return conversation;
  }
}

const manager = new ConversationManager();

// —— Debugger-based network interception ——————————————————————

let attachedTargets = new Set();
let pendingRequests = new Map(); // requestId -> { url, postData }
let pendingConversations = new Map(); // requestId -> conversation

// Find and attach to Claude extension tabs
async function findAndAttachClaude() {
      try {
              const targets = await chrome.debugger.getTargets();
              console.log('[CSS] Found', targets.length, 'debugger targets');

        for (const target of targets) {
                  // Match Claude extension sidepanel or any page from that extension
                if (target.url && target.url.includes(CLAUDE_EXTENSION_ID) && !attachedTargets.has(target.id)) {
                            console.log('[CSS] Found Claude target:', target.type, target.title, target.url);
                            try {
                                          const debuggee = target.tabId ? { tabId: target.tabId } : { targetId: target.id };
                                          await chrome.debugger.attach(debuggee, '1.3');
                                          await chrome.debugger.sendCommand(debuggee, 'Network.enable');
                                          attachedTargets.add(target.id);
                                          console.log('[CSS] Attached to Claude target:', target.id);
                            } catch (e) {
                                          console.log('[CSS] Failed to attach:', e.message);
                            }
                }
        }
      } catch (e) {
              console.log('[CSS] Error finding targets:', e.message);
      }
}

// Listen for debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method === 'Network.requestWillBeSent') {
              const url = params.request.url;
              const reqMethod = params.request.method;

        if (reqMethod === 'POST' && url.includes('messages')) {
                  console.log('[CSS] Intercepted POST to:', url);
                  const postData = params.request.postData;
                  if (postData) {
                              console.log('[CSS] Has postData, length:', postData.length);
                              pendingRequests.set(params.requestId, { url, postData });

                    try {
                                  const body = JSON.parse(postData);
                                  const messages = body.messages || [];
                                  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
                                  if (lastUser) {
                                                  const userText = typeof lastUser.content === 'string'
                                                    ? lastUser.content
                                                                    : (lastUser.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

                                    if (userText.trim()) {
                                                      console.log('[CSS] User message:', userText.substring(0, 100));
                                                      const conv = manager.createConversation(userText.trim(), url);
                                                      pendingConversations.set(params.requestId, conv);
                                    }
                                  }
                    } catch (e) {
                                  console.log('[CSS] Parse error:', e.message);
                    }
                  }
        }
      }

                                      if (method === 'Network.responseReceived') {
                                              const conv = pendingConversations.get(params.requestId);
                                              if (conv && params.response.status >= 200 && params.response.status < 300) {
                                                        console.log('[CSS] Response received for:', params.requestId);
                                                        // Try to get response body
                                                chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId: params.requestId }, (result) => {
                                                            if (chrome.runtime.lastError) {
                                                                          console.log('[CSS] Cannot get body yet, saving user message only');
                                                                          manager.save(conv);
                                                                          return;
                                                            }
                                                            if (result && result.body) {
                                                                          const assistantText = parseClaudeResponse(result.body);
                                                                          if (assistantText) {
                                                                                          manager.appendAssistantMessage(conv, assistantText);
                                                                                          console.log('[CSS] Got assistant reply, length:', assistantText.length);
                                                                          }
                                                            }
                                                            manager.save(conv);
                                                            console.log('[CSS] Saved conversation:', conv.id);
                                                            pendingConversations.delete(params.requestId);
                                                });
                                              }
                                      }

                                      if (method === 'Network.loadingFinished') {
                                              const conv = pendingConversations.get(params.requestId);
                                              if (conv) {
                                                        console.log('[CSS] Loading finished for:', params.requestId);
                                                        chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId: params.requestId }, (result) => {
                                                                    if (chrome.runtime.lastError) {
                                                                                  console.log('[CSS] Body error:', chrome.runtime.lastError.message);
                                                                                  manager.save(conv);
                                                                                  pendingConversations.delete(params.requestId);
                                                                                  return;
                                                                    }
                                                                    if (result && result.body) {
                                                                                  const assistantText = parseClaudeResponse(result.body);
                                                                                  if (assistantText) {
                                                                                                  manager.appendAssistantMessage(conv, assistantText);
                                                                                                  console.log('[CSS] Got assistant reply from loadingFinished, length:', assistantText.length);
                                                                                  }
                                                                    }
                                                                    manager.save(conv);
                                                                    console.log('[CSS] Saved conversation:', conv.id);
                                                                    pendingConversations.delete(params.requestId);
                                                        });
                                              }
                                      }
});

// Handle debugger detach
chrome.debugger.onDetach.addListener((source, reason) => {
      console.log('[CSS] Debugger detached:', reason);
      // Remove from attached set
                                       attachedTargets.forEach(id => {
                                               attachedTargets.delete(id);
                                       });
      // Try to re-attach after a delay
                                       setTimeout(findAndAttachClaude, 3000);
});

// Periodically check for Claude extension targets
setInterval(findAndAttachClaude, 10000);

// Initial attach
setTimeout(findAndAttachClaude, 2000);

// —— Parse Claude response (JSON or SSE) ——————————————————————

function parseClaudeResponse(text) {
      try {
              const json = JSON.parse(text);
              if (json.content) {
                        return json.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
              }
              if (json.completion) return json.completion;
      } catch (_) {}

  // SSE format
  const parts = [];
      for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') break;
              try {
                        const obj = JSON.parse(data);
                        if (obj.type === 'content_block_delta' && obj.delta?.text) parts.push(obj.delta.text);
                        else if (obj.delta?.type === 'text_delta' && obj.delta?.text) parts.push(obj.delta.text);
                        else if (obj.completion) parts.push(obj.completion);
              } catch (_) {}
      }
      return parts.join('') || null;
}

// —— Message handler (popup <-> background) ——————————————————

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      console.log('[CSS] Message:', msg.type);
      handleMessage(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
});

async function handleMessage(msg) {
      switch (msg.type) {
          case 'getConversations': return await manager.getAll();
          case 'getConversation': return await manager.getById(msg.id);
          case 'deleteConversation': { await manager.delete(msg.id); return { ok: true }; }
          case 'getStats': return await manager.getStats();
          case 'exportMarkdown': {
                    const c = await manager.getById(msg.id);
                    if (!c) throw new Error('Not found');
                    return { markdown: toMarkdown(c) };
          }
          case 'exportAllMarkdown': {
                    const all = await manager.getAll();
                    return { markdown: all.map(toMarkdown).join('\n\n---\n\n') };
          }
          case 'syncToNotion': {
                    const c = await manager.getById(msg.id);
                    if (!c) throw new Error('Not found');
                    return await syncToNotion(c);
          }
          case 'attachDebugger': {
                    await findAndAttachClaude();
                    return { ok: true, attached: attachedTargets.size };
          }
          default: throw new Error('Unknown: ' + msg.type);
      }
}

// —— Markdown ——————————————————————————————————————————————

function toMarkdown(conv) {
      let md = `# ${conv.title}\n\n**Date:** ${new Date(conv.createdAt).toLocaleString()}\n**URL:** ${conv.url || 'N/A'}\n\n---\n\n`;
      for (const m of conv.messages) {
              md += `${m.role === 'user' ? '**You**' : '**Claude**'}\n\n${m.content}\n\n`;
      }
      return md;
}

// —— Notion sync ——————————————————————————————————————————

async function syncToNotion(conv) {
      const { notionToken, notionDatabaseId } = await chrome.storage.sync.get(['notionToken', 'notionDatabaseId']);
      if (!notionToken || !notionDatabaseId) throw new Error('Notion not configured. Go to Options.');

  const pageRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: { Authorization: `Bearer ${notionToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
          body: JSON.stringify({
                    parent: { database_id: notionDatabaseId },
                    properties: {
                                Name: { title: [{ text: { content: conv.title.slice(0, 200) } }] },
                                Date: { date: { start: new Date(conv.createdAt).toISOString() } },
                                Messages: { number: conv.messages.length },
                    },
          }),
  });
      if (!pageRes.ok) { const e = await pageRes.json(); throw new Error('Notion: ' + e.message); }
      const page = await pageRes.json();

  const blocks = [];
      for (const m of conv.messages) {
              blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: m.role === 'user' ? 'You' : 'Claude' } }] } });
              const c = m.content || '';
              for (let i = 0; i < c.length; i += 1990) {
                        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: c.slice(i, i + 1990) } }] } });
              }
              blocks.push({ object: 'block', type: 'divider', divider: {} });
      }

  for (let i = 0; i < blocks.length; i += 100) {
          const r = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children`, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${notionToken}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
                    body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
          });
          if (!r.ok) { const e = await r.json(); throw new Error('Notion blocks: ' + e.message); }
  }

  return { ok: true, pageId: page.id, pageUrl: page.url };
}

console.log('[CSS] Service Worker v3 initialized. Will attach to Claude extension...');
