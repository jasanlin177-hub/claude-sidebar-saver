// background.js — Claude Sidebar Saver Service Worker v5
// Fixed: message type matching, response format, Service Worker compatibility

console.log('[CSS] Service Worker v5 starting up...');

// ── ConversationManager ──────────────────────────
class ConversationManager {
  constructor() {
    this.STORAGE_KEY = 'css_conversations';
    this.MAX_CONVERSATIONS = 200;
  }

  async getAll() {
    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    return data[this.STORAGE_KEY] || [];
  }

  async save(conversations) {
    await chrome.storage.local.set({ [this.STORAGE_KEY]: conversations });
  }

  async getById(id) {
    const conversations = await this.getAll();
    return conversations.find(c => c.id === id) || null;
  }

  async deleteById(id) {
    const conversations = await this.getAll();
    const filtered = conversations.filter(c => c.id !== id);
    await this.save(filtered);
    return { deleted: conversations.length !== filtered.length };
  }

  async search(query) {
    const conversations = await this.getAll();
    if (!query) return conversations;
    const q = query.toLowerCase();
    return conversations.filter(c =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some(m => m.content.toLowerCase().includes(q))
    );
  }

  async addMessage(conversationId, role, content, metadata = {}) {
    const conversations = await this.getAll();
    let convo = conversations.find(c => c.id === conversationId);

    if (!convo) {
      convo = {
        id: conversationId,
        title: content.substring(0, 50) + (content.length > 50 ? '...' : ''),
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: metadata.source || 'claude.ai'
      };
      conversations.unshift(convo);
    }

    convo.messages.push({
      role: role,
      content: content,
      timestamp: new Date().toISOString(),
      ...metadata
    });
    convo.updatedAt = new Date().toISOString();

    if (role === 'user' && convo.messages.filter(m => m.role === 'user').length === 1) {
      convo.title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
    }

    while (conversations.length > this.MAX_CONVERSATIONS) {
      conversations.pop();
    }

    await this.save(conversations);
    console.log(`[CSS] Saved ${role} message to conversation ${conversationId}`);
    return convo;
  }

  async getStats() {
    const conversations = await this.getAll();
    const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0);
    return {
      conversationCount: conversations.length,
      messageCount: totalMessages,
      // popup.js expects these aliases
      totalConversations: conversations.length,
      totalMessages: totalMessages
    };
  }
}

const manager = new ConversationManager();

// Track current conversation context
let currentConversationId = null;
let pendingUserMessage = null;

// ── Unified message handler (popup + content script) ──────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[CSS] Message received:', message.type, 'from:', sender.url || sender.id);

  // Normalize type: popup uses camelCase, content script uses UPPER_SNAKE_CASE
  const type = message.type;

  // --- Popup handlers (camelCase) → respond with { ok, data } ---
  if (type === 'getStats') {
    manager.getStats().then(stats => {
      sendResponse({ ok: true, data: stats });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === 'getConversations') {
    const query = message.query || '';
    manager.search(query).then(convos => {
      sendResponse({ ok: true, data: convos });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === 'getConversation') {
    manager.getById(message.id).then(convo => {
      if (convo) {
        sendResponse({ ok: true, data: convo });
      } else {
        sendResponse({ ok: false, error: 'Conversation not found' });
      }
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === 'deleteConversation') {
    manager.deleteById(message.id).then(result => {
      sendResponse({ ok: true, data: result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === 'exportMarkdown') {
    exportToMarkdown(message.id).then(result => {
      sendResponse({ ok: true, data: result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === 'exportAllMarkdown') {
    exportAllToMarkdown().then(result => {
      sendResponse({ ok: true, data: result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === 'syncToNotion') {
    syncToNotion(message.id).then(result => {
      sendResponse({ ok: true, data: result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  // --- Content script handlers (UPPER_SNAKE_CASE) ---
  if (type === 'GET_STATS') {
    manager.getStats().then(stats => sendResponse(stats));
    return true;
  }

  if (type === 'GET_CONVERSATIONS') {
    manager.getAll().then(convos => sendResponse(convos));
    return true;
  }

  if (type === 'EXPORT_MARKDOWN') {
    exportToMarkdown(message.conversationId).then(result => sendResponse(result));
    return true;
  }

  if (type === 'EXPORT_ALL_MARKDOWN') {
    exportAllToMarkdown().then(result => sendResponse(result));
    return true;
  }

  if (type === 'CLEAR_DATA') {
    manager.save([]).then(() => sendResponse({ success: true }));
    return true;
  }

  // --- Content script intercept messages ---
  handleContentMessage(message, sender);
  sendResponse({ received: true });
  return false;
});

// Also listen for external messages (if needed)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[CSS] External message received:', message.type);
  handleContentMessage(message, sender);
  sendResponse({ received: true });
});

async function handleContentMessage(message, sender) {
  try {
    switch (message.type) {
      case 'API_REQUEST': {
        console.log('[CSS] API Request intercepted:', message.url);
        const body = message.body;
        let extractedId = null;

        // 嘗試從 URL 提取 ID
        const urlMatch = message.url.match(/chat_conversations\/([a-f0-9-]+)/);
        if (urlMatch) extractedId = urlMatch[1];

        // 如果 URL 沒有，嘗試從 Body 提取 (Claude 建立新對話時會把 uuid 放這裡)
        if (!extractedId && body) {
          if (body.uuid) extractedId = body.uuid;
          else if (body.conversation_uuid) extractedId = body.conversation_uuid;
          else if (body.conversation_id) extractedId = body.conversation_id;
        }

        if (extractedId) {
          currentConversationId = extractedId;
        } else if (!currentConversationId) {
          currentConversationId = 'conv_' + Date.now();
        }

        if (body) {
          let userText = '';
          if (body.prompt) {
            userText = body.prompt;
          } else if (body.text) {
            userText = body.text;
          } else if (body.messages && Array.isArray(body.messages)) {
            const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
            if (lastUserMsg) {
              if (typeof lastUserMsg.content === 'string') {
                userText = lastUserMsg.content;
              } else if (Array.isArray(lastUserMsg.content)) {
                userText = lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
              }
            }
          }

          if (userText) {
            pendingUserMessage = userText;
            await manager.addMessage(currentConversationId, 'user', userText, {
              source: 'content-script',
              url: message.url
            });
            updateBadge();
          }
        }
        break;
      }

      case 'API_RESPONSE_STREAM_COMPLETE': {
        console.log('[CSS] Stream response complete, length:', message.assistantMessage.length);
        if (message.assistantMessage && currentConversationId) {
          await manager.addMessage(currentConversationId, 'assistant', message.assistantMessage, {
            source: 'content-script-stream'
          });
          updateBadge();
        }
        break;
      }

      case 'API_RESPONSE_JSON': {
        console.log('[CSS] JSON response from:', message.url);
        const data = message.data;
        if (data && currentConversationId) {
          let assistantText = '';
          if (data.completion) {
            assistantText = data.completion;
          } else if (data.content && Array.isArray(data.content)) {
            assistantText = data.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          }
          if (assistantText) {
            await manager.addMessage(currentConversationId, 'assistant', assistantText, {
              source: 'content-script-json'
            });
            updateBadge();
          }
        }
        break;
      }

      case 'DOM_MESSAGE': {
        console.log('[CSS] DOM message captured, length:', message.content.length);
        break;
      }
    }
  } catch (error) {
    console.error('[CSS] Error handling message:', error);
  }
}

// ── webRequest listener ──────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    console.log('[CSS] webRequest detected:', details.method, details.url);
  },
  {
    urls: [
      '*://api.anthropic.com/*',
      '*://claude.ai/api/*',
      '*://*.claude.ai/api/*'
    ]
  }
);

// ── Badge update ──────────
async function updateBadge() {
  try {
    const stats = await manager.getStats();
    const text = stats.messageCount > 0 ? String(stats.messageCount) : '';
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: '#6B4CE6' });
  } catch (e) {
    // Badge update is non-critical
  }
}

// ── Markdown Export (Service Worker compatible) ──────────
async function exportToMarkdown(conversationId) {
  const conversations = await manager.getAll();
  const convo = conversations.find(c => c.id === conversationId);
  if (!convo) return { success: false, error: 'Conversation not found' };

  const markdown = formatConversationMarkdown(convo);
  // Return markdown string to popup for client-side download
  return { success: true, markdown: markdown, title: convo.title };
}

async function exportAllToMarkdown() {
  const conversations = await manager.getAll();
  if (conversations.length === 0) return { success: false, error: 'No conversations' };

  let allMarkdown = '# Claude Conversations Export\n\n';
  allMarkdown += `Exported: ${new Date().toISOString()}\n`;
  allMarkdown += `Total conversations: ${conversations.length}\n\n---\n\n`;

  for (const convo of conversations) {
    allMarkdown += formatConversationMarkdown(convo) + '\n\n---\n\n';
  }

  return { success: true, markdown: allMarkdown, count: conversations.length };
}

function formatConversationMarkdown(convo) {
  let md = `## ${convo.title}\n\n`;
  md += `**ID:** ${convo.id}\n`;
  md += `**Created:** ${convo.createdAt}\n`;
  md += `**Updated:** ${convo.updatedAt}\n`;
  md += `**Messages:** ${convo.messages.length}\n\n`;

  for (const msg of convo.messages) {
    const roleLabel = msg.role === 'user' ? '**User**' : '**Claude**';
    md += `### ${roleLabel}\n`;
    md += `*${msg.timestamp}*\n\n`;
    md += msg.content + '\n\n';
  }

  return md;
}

// ── Notion Sync ──────────
async function syncToNotion(conversationId) {
  // Requires user to configure Notion API key in options page
  const options = await chrome.storage.sync.get(['notion_token', 'notion_database_id']);
  if (!options.notion_token || !options.notion_database_id) {
    throw new Error('請先在設定頁面配置 Notion API Key 和 Database ID');
  }

  const convo = await manager.getById(conversationId);
  if (!convo) throw new Error('找不到對話');

  const markdown = formatConversationMarkdown(convo);

  // Notion API call
  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${options.notion_token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      parent: { database_id: options.notion_database_id },
      properties: {
        Name: { title: [{ text: { content: convo.title } }] }
      },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: markdown.substring(0, 2000) } }]
          }
        }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || 'Notion API error');
  }

  const page = await response.json();
  return { pageUrl: page.url };
}

// ── Initialize ──────────
updateBadge();
console.log('[CSS] Service Worker v5 initialized.');
