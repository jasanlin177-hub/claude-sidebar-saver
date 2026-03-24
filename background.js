// background.js — Claude Sidebar Saver Service Worker v2
// Fixed: broader URL matching + debug logging

console.log('[CSS] Service Worker starting up...');

// —— ConversationManager ————————————————————————————

class ConversationManager {
    constructor() {
          this.STORAGE_KEY = "css_conversations";
          this.MAX_CONVERSATIONS = 200;
          this.pendingRequests = new Map(); // requestId → { conversationId, userMessage }
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
        if (idx >= 0) {
                all[idx] = conversation;
        } else {
                all.unshift(conversation);
                if (all.length > this.MAX_CONVERSATIONS) all.pop();
        }
        await chrome.storage.local.set({ [this.STORAGE_KEY]: all });
        return conversation;
  }

  async delete(id) {
        const all = await this.getAll();
        const filtered = all.filter((c) => c.id !== id);
        await chrome.storage.local.set({ [this.STORAGE_KEY]: filtered });
  }

  async getStats() {
        const all = await this.getAll();
        const totalMessages = all.reduce((sum, c) => sum + c.messages.length, 0);
        return { totalConversations: all.length, totalMessages };
  }

  createConversation(userMessage, url) {
        const now = Date.now();
        const title =
                userMessage.length > 60
            ? userMessage.slice(0, 60) + "…"
                  : userMessage || "Untitled Conversation";
        return {
                id: `conv_${now}_${Math.random().toString(36).slice(2, 7)}`,
                title,
                url,
                createdAt: now,
                updatedAt: now,
                messages: [{ role: "user", content: userMessage, timestamp: now }],
        };
  }

  appendAssistantMessage(conversation, content) {
        conversation.messages.push({
                role: "assistant",
                content,
                timestamp: Date.now(),
        });
        conversation.updatedAt = Date.now();
        return conversation;
  }
}

const manager = new ConversationManager();

// —— Helper: detect if URL is a Claude messages API ————————————

function isClaudeMessagesAPI(url) {
    // Matches various possible Claude API endpoints
  if (url.includes('messages') && (
        url.includes('anthropic.com') ||
        url.includes('claude.ai') ||
        url.includes('api.') 
        )) return true;
    // Also match the beta endpoint seen in DevTools
  if (url.includes('messages?beta=true')) return true;
    return false;
}

// —— webRequest: intercept user messages ————————————————————————

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
          console.log('[CSS] onBeforeRequest:', details.method, details.url);

      if (details.method !== "POST") return;
          if (!isClaudeMessagesAPI(details.url)) return;

      console.log('[CSS] Matched Claude API request:', details.url);

      try {
              const bodyBytes = details.requestBody?.raw?.[0]?.bytes;
              if (!bodyBytes) {
                        console.log('[CSS] No request body found');
                        return;
              }
              const bodyText = new TextDecoder("utf-8").decode(bodyBytes);
              console.log('[CSS] Request body preview:', bodyText.substring(0, 200));
              const body = JSON.parse(bodyText);

            // Claude API sends messages array; grab the last user turn
            const messages = body.messages || body.prompt?.messages || [];
              const lastUser = [...messages].reverse().find((m) => m.role === "user");
              if (!lastUser) return;

            const userText =
                      typeof lastUser.content === "string"
                  ? lastUser.content
                        : lastUser.content
                      ?.filter((b) => b.type === "text")
                      .map((b) => b.text)
                      .join("\n") || "";

            if (!userText.trim()) return;

            console.log('[CSS] Captured user message:', userText.substring(0, 100));

            manager.pendingRequests.set(details.requestId, {
                      userMessage: userText.trim(),
                      url: details.initiator || details.url,
            });
      } catch (e) {
              console.log('[CSS] Parse error:', e.message);
      }
    },
  {
        urls: [
                "*://api.anthropic.com/*",
                "*://claude.ai/*",
                "*://*.anthropic.com/*",
                "*://*.claude.ai/*"
              ]
  },
    ["requestBody"]
  );

// —— webRequest: intercept completed response ————————————————————

chrome.webRequest.onCompleted.addListener(
    async (details) => {
          console.log('[CSS] onCompleted:', details.url, 'status:', details.statusCode);

      const pending = manager.pendingRequests.get(details.requestId);
          if (!pending) return;
          manager.pendingRequests.delete(details.requestId);

      if (details.statusCode < 200 || details.statusCode >= 300) return;

      console.log('[CSS] Fetching response for:', details.url);

      try {
              // Re-fetch the conversation list from Claude's API to get the assistant reply
            // Since we can't read the streaming response body directly,
            // we save what we have and mark for later update
            const conversation = manager.createConversation(
                      pending.userMessage,
                      pending.url
                    );

            // Try to get the response by fetching the URL again (works for non-streaming)
            const resp = await fetch(details.url, {
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
            }).catch(() => null);

            if (resp && resp.ok) {
                      const text = await resp.text();
                      // Try to parse SSE or JSON response
                const assistantText = parseClaudeResponse(text);
                      if (assistantText) {
                                  manager.appendAssistantMessage(conversation, assistantText);
                      }
            }

            await manager.save(conversation);
              console.log('[CSS] Saved conversation:', conversation.id);

      } catch (e) {
              console.log('[CSS] Error saving conversation:', e.message);
      }
    },
  {
        urls: [
                "*://api.anthropic.com/*",
                "*://claude.ai/*",
                "*://*.anthropic.com/*",
                "*://*.claude.ai/*"
              ]
  }
  );

// —— Also monitor ALL requests for debugging ———————————————————

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
          if (details.method === "POST") {
                  console.log('[CSS-DEBUG] POST request to:', details.url);
          }
    },
  { urls: ["<all_urls>"] },
    ["requestBody"]
  );

// —— Helper: parse Claude streaming/JSON response ——————————————

function parseClaudeResponse(text) {
    try {
          // Try direct JSON first
      const json = JSON.parse(text);
          if (json.content) {
                  return json.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join("\n");
          }
          if (json.completion) return json.completion;
    } catch (_) {}

  // Try SSE format: data: {...}
  const lines = text.split("\n");
    const parts = [];
    for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break;
          try {
                  const obj = JSON.parse(data);
                  if (obj.type === "content_block_delta" && obj.delta?.text) {
                            parts.push(obj.delta.text);
                  } else if (obj.delta?.type === "text_delta" && obj.delta?.text) {
                            parts.push(obj.delta.text);
                  } else if (obj.completion) {
                            parts.push(obj.completion);
                  }
          } catch (_) {}
    }
    return parts.join("") || null;
}

// —— Message handler (popup ↔ background) ————————————————————

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    console.log('[CSS] Message received:', msg.type);
    handleMessage(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true; // keep channel open for async
});

async function handleMessage(msg) {
    switch (msg.type) {
      case "getConversations": {
              return await manager.getAll();
      }
      case "getConversation": {
              return await manager.getById(msg.id);
      }
      case "deleteConversation": {
              await manager.delete(msg.id);
              return { ok: true };
      }
      case "getStats": {
              return await manager.getStats();
      }
      case "exportMarkdown": {
              const conv = await manager.getById(msg.id);
              if (!conv) throw new Error("Conversation not found");
              return { markdown: conversationToMarkdown(conv) };
      }
      case "exportAllMarkdown": {
              const all = await manager.getAll();
              const md = all.map(conversationToMarkdown).join("\n\n---\n\n");
              return { markdown: md };
      }
      case "syncToNotion": {
              const conv = await manager.getById(msg.id);
              if (!conv) throw new Error("Conversation not found");
              return await syncConversationToNotion(conv);
      }
      default:
              throw new Error(`Unknown message type: ${msg.type}`);
    }
}

// —— Markdown export ——————————————————————————————————————————

function conversationToMarkdown(conv) {
    const date = new Date(conv.createdAt).toLocaleString();
    let md = `# ${conv.title}\n\n`;
    md += `**Date:** ${date}  \n`;
    md += `**URL:** ${conv.url || "N/A"}  \n\n`;
    md += `---\n\n`;
    for (const msg of conv.messages) {
          const role = msg.role === "user" ? "**You**" : "**Claude**";
          md += `${role}\n\n${msg.content}\n\n`;
    }
    return md;
}

// —— Notion sync ——————————————————————————————————————————————

async function syncConversationToNotion(conv) {
    const { notionToken, notionDatabaseId } = await chrome.storage.sync.get([
          "notionToken",
          "notionDatabaseId",
        ]);

  if (!notionToken || !notionDatabaseId) {
        throw new Error("Notion token or database ID not configured. Please go to Options.");
  }

  // Create the page
  const pageRes = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
                Authorization: `Bearer ${notionToken}`,
                "Content-Type": "application/json",
                "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
                parent: { database_id: notionDatabaseId },
                properties: {
                          Name: { title: [{ text: { content: conv.title.slice(0, 200) } }] },
                          Date: { date: { start: new Date(conv.createdAt).toISOString() } },
                          Messages: { number: conv.messages.length },
                },
        }),
  });

  if (!pageRes.ok) {
        const err = await pageRes.json();
        throw new Error(`Notion API error: ${err.message}`);
  }

  const page = await pageRes.json();
    const pageId = page.id;

  // Build blocks from messages (max 100 per request, 2000 chars per rich_text)
  const allBlocks = [];
    for (const msg of conv.messages) {
          const label = msg.role === "user" ? "You" : "Claude";
          allBlocks.push({
                  object: "block",
                  type: "heading_3",
                  heading_3: { rich_text: [{ text: { content: label } }] },
          });

      // Split content into 2000-char chunks
      const content = msg.content || "";
          for (let i = 0; i < content.length; i += 1990) {
                  allBlocks.push({
                            object: "block",
                            type: "paragraph",
                            paragraph: {
                                        rich_text: [{ text: { content: content.slice(i, i + 1990) } }],
                            },
                  });
          }
          allBlocks.push({ object: "block", type: "divider", divider: {} });
    }

  // Upload in batches of 100
  for (let i = 0; i < allBlocks.length; i += 100) {
        const batch = allBlocks.slice(i, i + 100);
        const batchRes = await fetch(
                `https://api.notion.com/v1/blocks/${pageId}/children`,
          {
                    method: "PATCH",
                    headers: {
                                Authorization: `Bearer ${notionToken}`,
                                "Content-Type": "application/json",
                                "Notion-Version": "2022-06-28",
                    },
                    body: JSON.stringify({ children: batch }),
          }
              );
        if (!batchRes.ok) {
                const err = await batchRes.json();
                throw new Error(`Notion blocks error: ${err.message}`);
        }
  }

  return { ok: true, pageId, pageUrl: page.url };
}

console.log('[CSS] Service Worker initialized. Listening for Claude API requests...');
