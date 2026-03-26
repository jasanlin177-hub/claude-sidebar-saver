// background.js — Claude Sidebar Saver Service Worker v4
// Receives messages from content script injected into claude.ai
// Also monitors webRequest for API calls

console.log('[CSS] Service Worker v4 starting up...');

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

          // Update title from first user message
          if (role === 'user' && convo.messages.filter(m => m.role === 'user').length === 1) {
                      convo.title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
          }

          // Trim old conversations
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
                        messageCount: totalMessages
            };
  }
}

const manager = new ConversationManager();

// Track current conversation context
let currentConversationId = null;
let pendingUserMessage = null;

// ── Handle messages from content script ──────────
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
        console.log('[CSS] External message received:', message.type);
        handleContentMessage(message, sender);
        sendResponse({ received: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('[CSS] Message received:', message.type, 'from:', sender.url || sender.id);

                                       if (message.type === 'GET_STATS') {
                                                 manager.getStats().then(stats => sendResponse(stats));
                                                 return true; // async response
                                       }

                                       if (message.type === 'GET_CONVERSATIONS') {
                                                 manager.getAll().then(convos => sendResponse(convos));
                                                 return true;
                                       }

                                       if (message.type === 'EXPORT_MARKDOWN') {
                                                 exportToMarkdown(message.conversationId).then(result => sendResponse(result));
                                                 return true;
                                       }

                                       if (message.type === 'EXPORT_ALL_MARKDOWN') {
                                                 exportAllToMarkdown().then(result => sendResponse(result));
                                                 return true;
                                       }

                                       if (message.type === 'CLEAR_DATA') {
                                                 manager.save([]).then(() => sendResponse({ success: true }));
                                                 return true;
                                       }

                                       handleContentMessage(message, sender);
        sendResponse({ received: true });
        return false;
});

async function handleContentMessage(message, sender) {
        try {
                  switch (message.type) {
                        case 'API_REQUEST': {
                                      console.log('[CSS] API Request intercepted:', message.url);
                                      const body = message.body;

                                      // Extract conversation ID from URL or body
                                      const urlMatch = message.url.match(/chat_conversations\/([a-f0-9-]+)/);
                                      if (urlMatch) {
                                                      currentConversationId = urlMatch[1];
                                      } else if (body && body.conversation_id) {
                                                      currentConversationId = body.conversation_id;
                                      } else {
                                                      currentConversationId = 'conv_' + Date.now();
                                      }

                                      // Extract user message
                                      if (body) {
                                                      let userText = '';
                                                      if (body.prompt) {
                                                                        userText = body.prompt;
                                                      } else if (body.messages && Array.isArray(body.messages)) {
                                                                        const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
                                                                        if (lastUserMsg) {
                                                                                            if (typeof lastUserMsg.content === 'string') {
                                                                                                                  userText = lastUserMsg.content;
                                                                                                  } else if (Array.isArray(lastUserMsg.content)) {
                                                                                                                  userText = lastUserMsg.content
                                                                                                                    .filter(c => c.type === 'text')
                                                                                                                    .map(c => c.text)
                                                                                                                    .join('\n');
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
                                                                        assistantText = data.content
                                                                          .filter(c => c.type === 'text')
                                                                          .map(c => c.text)
                                                                          .join('\n');
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
                                      // DOM messages are backup - only use if no API interception
                                      break;
                        }
                  }
        } catch (error) {
                  console.error('[CSS] Error handling message:', error);
        }
}

// ── webRequest listener (for claude.ai web requests) ──────────
chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
                  console.log('[CSS] webRequest detected:', details.method, details.url);
                  // Note: In MV3 we can see URLs but not request bodies via webRequest
          // The content script handles body capture
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

// ── Markdown Export ──────────
async function exportToMarkdown(conversationId) {
        const conversations = await manager.getAll();
        const convo = conversations.find(c => c.id === conversationId);
        if (!convo) return { success: false, error: 'Conversation not found' };

  const markdown = formatConversationMarkdown(convo);
        const blob = new Blob([markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);

  const filename = `claude-${convo.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50)}-${Date.now()}.md`;

  await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
  });

  return { success: true, filename: filename };
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

  const blob = new Blob([allMarkdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
            url: url,
            filename: `claude-all-conversations-${Date.now()}.md`,
            saveAs: true
  });

  return { success: true, count: conversations.length };
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

// ── Initialize ──────────
updateBadge();
console.log('[CSS] Service Worker v4 initialized. Content script will intercept claude.ai requests.');
