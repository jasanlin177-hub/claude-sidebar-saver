// background.js — Claude Sidebar Saver Service Worker

// ─── ConversationManager ────────────────────────────────────────────────────

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

// ─── webRequest: intercept user messages ────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    if (!details.url.includes("/api/")) return;

    try {
      const bodyBytes = details.requestBody?.raw?.[0]?.bytes;
      if (!bodyBytes) return;
      const bodyText = new TextDecoder("utf-8").decode(bodyBytes);
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

      manager.pendingRequests.set(details.requestId, {
        userMessage: userText.trim(),
        url: details.initiator || details.url,
      });
    } catch (_) {
      // JSON parse failed or unexpected shape — silently skip
    }
  },
  { urls: ["*://claude.ai/api/*", "*://api.anthropic.com/*"] },
  ["requestBody"]
);

// ─── webRequest: intercept completed response ────────────────────────────────

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const pending = manager.pendingRequests.get(details.requestId);
    if (!pending) return;
    manager.pendingRequests.delete(details.requestId);

    // Re-fetch the same endpoint to read the response body
    try {
      const resp = await fetch(details.url);
      const rawText = await resp.text();
      const assistantText = parseSSEOrJSON(rawText);
      if (!assistantText) return;

      const conversation = manager.createConversation(
        pending.userMessage,
        pending.url
      );
      manager.appendAssistantMessage(conversation, assistantText);
      await manager.save(conversation);

      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "Claude Sidebar Saver",
        message: `已儲存對話：${conversation.title}`,
      });
    } catch (err) {
      console.warn("[CSS] Failed to capture response:", err);
    }
  },
  { urls: ["*://claude.ai/api/*", "*://api.anthropic.com/*"] }
);

// ─── SSE / JSON response parser ──────────────────────────────────────────────

function parseSSEOrJSON(raw) {
  // Try SSE streaming format first (data: {...}\n)
  const sseLines = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]");

  if (sseLines.length > 0) {
    const parts = [];
    for (const line of sseLines) {
      try {
        const obj = JSON.parse(line);
        // Anthropic streaming delta
        const delta =
          obj?.delta?.text ||
          obj?.completion ||
          obj?.content?.[0]?.text ||
          "";
        if (delta) parts.push(delta);
      } catch (_) {}
    }
    if (parts.length > 0) return parts.join("");
  }

  // Fallback: plain JSON
  try {
    const obj = JSON.parse(raw);
    return (
      obj?.content?.[0]?.text ||
      obj?.completion ||
      obj?.message?.content?.[0]?.text ||
      null
    );
  } catch (_) {
    return null;
  }
}

// ─── Markdown exporter ───────────────────────────────────────────────────────

function conversationToMarkdown(conv) {
  const date = new Date(conv.createdAt).toLocaleString("zh-TW");
  const lines = [
    `# ${conv.title}`,
    ``,
    `> **時間**：${date}  `,
    `> **來源**：${conv.url}`,
    ``,
    `---`,
    ``,
  ];
  for (const msg of conv.messages) {
    const role = msg.role === "user" ? "🧑 **使用者**" : "🤖 **Claude**";
    lines.push(role, "", msg.content, "", "---", "");
  }
  return lines.join("\n");
}

// ─── Notion sync ─────────────────────────────────────────────────────────────

async function syncToNotion(conversationId) {
  const { notion_token, notion_database_id } = await chrome.storage.sync.get([
    "notion_token",
    "notion_database_id",
  ]);

  if (!notion_token || !notion_database_id) {
    throw new Error("請先在設定頁面填入 Notion Token 和 Database ID");
  }

  const conv = await manager.getById(conversationId);
  if (!conv) throw new Error("找不到對話");

  const NOTION_API = "https://api.notion.com/v1";
  const headers = {
    Authorization: `Bearer ${notion_token}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  // Helper: split text into ≤2000-char rich_text chunks
  function richText(text) {
    const chunks = [];
    for (let i = 0; i < text.length; i += 2000) {
      chunks.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
    }
    return chunks;
  }

  // Build blocks for all messages
  function buildMessageBlocks(messages) {
    const blocks = [];
    for (const msg of messages) {
      const label = msg.role === "user" ? "🧑 使用者" : "🤖 Claude";
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: label } }] },
      });
      // Split long content into paragraph blocks (each block body ≤ 2000 chars)
      const content = msg.content || "";
      for (let i = 0; i < content.length; i += 2000) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: richText(content.slice(i, i + 2000)) },
        });
      }
      blocks.push({
        object: "block",
        type: "divider",
        divider: {},
      });
    }
    return blocks;
  }

  // Create the Notion page
  const pageRes = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      parent: { database_id: notion_database_id },
      properties: {
        title: {
          title: richText(conv.title.slice(0, 2000)),
        },
      },
    }),
  });

  if (!pageRes.ok) {
    const err = await pageRes.json();
    throw new Error(`Notion 建立頁面失敗：${err.message || pageRes.status}`);
  }

  const page = await pageRes.json();
  const pageId = page.id;

  // Append blocks in chunks of 100 (Notion API limit)
  const allBlocks = buildMessageBlocks(conv.messages);
  for (let i = 0; i < allBlocks.length; i += 100) {
    const chunk = allBlocks.slice(i, i + 100);
    const appendRes = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ children: chunk }),
    });
    if (!appendRes.ok) {
      const err = await appendRes.json();
      throw new Error(`Notion 附加內容失敗：${err.message || appendRes.status}`);
    }
  }

  return { pageId, pageUrl: page.url };
}

// ─── Message handler (popup ↔ background) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case "getConversations": {
        const all = await manager.getAll();
        const query = (msg.query || "").toLowerCase();
        const filtered = query
          ? all.filter(
              (c) =>
                c.title.toLowerCase().includes(query) ||
                c.messages.some((m) =>
                  m.content.toLowerCase().includes(query)
                )
            )
          : all;
        return filtered;
      }
      case "getConversation":
        return await manager.getById(msg.id);

      case "deleteConversation":
        await manager.delete(msg.id);
        return { ok: true };

      case "exportMarkdown": {
        const conv = await manager.getById(msg.id);
        if (!conv) throw new Error("Not found");
        return { markdown: conversationToMarkdown(conv) };
      }
      case "exportAllMarkdown": {
        const all = await manager.getAll();
        const combined = all.map(conversationToMarkdown).join("\n\n---\n\n");
        return { markdown: combined };
      }
      case "syncToNotion":
        return await syncToNotion(msg.id);

      case "getStats":
        return await manager.getStats();

      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  };

  handle()
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // keep channel open for async
});
