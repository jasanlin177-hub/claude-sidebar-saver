// popup.js — Claude Sidebar Saver UI Controller

// ─── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError)
        return reject(new Error(chrome.runtime.lastError.message));
      if (!res.ok) return reject(new Error(res.error || "Unknown error"));
      resolve(res.data);
    });
  });
}

let toastTimer;
function showToast(msg, type = "info", duration = 2500) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function triggerDownload(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── State ────────────────────────────────────────────────────────────────────

let allConversations = [];
let currentConvId = null;

// ─── Stats ────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const stats = await sendMessage("getStats");
    $("stat-conversations").textContent = stats.totalConversations;
    $("stat-messages").textContent = stats.totalMessages;
  } catch (_) {}
}

// ─── Conversation List ────────────────────────────────────────────────────────

async function loadConversations(query = "") {
  try {
    allConversations = await sendMessage("getConversations", { query });
    renderList(allConversations);
  } catch (err) {
    showToast("載入失敗：" + err.message, "error");
  }
}

function renderList(convs) {
  const list = $("conv-list");
  const empty = $("empty-state");

  // Clear previous items (keep empty-state)
  [...list.querySelectorAll(".conv-item")].forEach((el) => el.remove());

  if (convs.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  convs.forEach((conv) => {
    const item = document.createElement("div");
    item.className = "conv-item";
    item.dataset.id = conv.id;

    const msgCount = conv.messages.length;
    const initial = conv.title.trim()[0]?.toUpperCase() || "C";

    item.innerHTML = `
      <div class="conv-avatar">${initial}</div>
      <div class="conv-body">
        <div class="conv-title">${escapeHtml(conv.title)}</div>
        <div class="conv-meta">
          <span>${formatDate(conv.updatedAt)}</span>
          <span>${msgCount} 則訊息</span>
        </div>
      </div>
      <div class="conv-actions">
        <button class="mini-btn btn-export" title="匯出 Markdown">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <button class="mini-btn btn-notion" title="同步 Notion">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
        </button>
        <button class="mini-btn btn-delete danger" title="刪除">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    `;

    // Click main body → open detail
    item.querySelector(".conv-body").addEventListener("click", () =>
      openDetail(conv.id)
    );
    item.querySelector(".conv-avatar").addEventListener("click", () =>
      openDetail(conv.id)
    );

    // Export
    item.querySelector(".btn-export").addEventListener("click", async (e) => {
      e.stopPropagation();
      await exportMarkdown(conv.id, conv.title);
    });

    // Notion
    item.querySelector(".btn-notion").addEventListener("click", async (e) => {
      e.stopPropagation();
      await syncNotion(conv.id);
    });

    // Delete
    item.querySelector(".btn-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteConversation(conv.id, item);
    });

    list.appendChild(item);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

async function openDetail(id) {
  currentConvId = id;
  const panel = $("detail-panel");
  const conv = await sendMessage("getConversation", { id });
  if (!conv) return showToast("找不到對話", "error");

  $("detail-title").textContent = conv.title;
  $("detail-meta").textContent = `${formatDate(conv.createdAt)} · ${conv.messages.length} 則訊息`;

  const msgContainer = $("detail-messages");
  msgContainer.innerHTML = "";
  for (const msg of conv.messages) {
    const bubble = document.createElement("div");
    bubble.className = `msg-bubble ${msg.role}`;
    const roleLabel =
      msg.role === "user" ? "🧑 使用者" : "🤖 Claude";
    bubble.innerHTML = `<div class="msg-role">${roleLabel}</div>${escapeHtml(msg.content)}`;
    msgContainer.appendChild(bubble);
  }

  panel.hidden = false;
}

function closeDetail() {
  $("detail-panel").hidden = true;
  currentConvId = null;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function exportMarkdown(id, title) {
  try {
    showToast("正在產生 Markdown…", "info", 4000);
    const { markdown } = await sendMessage("exportMarkdown", { id });
    const filename = `claude-${(title || "conversation")
      .replace(/[^\w\u4e00-\u9fff]/g, "-")
      .slice(0, 40)}.md`;
    triggerDownload(filename, markdown);
    showToast("✅ Markdown 已下載", "success");
  } catch (err) {
    showToast("匯出失敗：" + err.message, "error");
  }
}

async function syncNotion(id) {
  try {
    showToast("⏳ 同步到 Notion 中…", "info", 8000);
    const result = await sendMessage("syncToNotion", { id });
    showToast("✅ 已同步到 Notion！", "success", 3000);
    if (result?.pageUrl) {
      setTimeout(() => chrome.tabs.create({ url: result.pageUrl }), 800);
    }
  } catch (err) {
    showToast("Notion 同步失敗：" + err.message, "error", 4000);
  }
}

async function deleteConversation(id, itemEl) {
  if (!confirm("確定要刪除這則對話嗎？")) return;
  try {
    await sendMessage("deleteConversation", { id });
    itemEl?.remove();
    allConversations = allConversations.filter((c) => c.id !== id);
    if (allConversations.length === 0) $("empty-state").hidden = false;
    loadStats();
    showToast("已刪除", "info");
  } catch (err) {
    showToast("刪除失敗：" + err.message, "error");
  }
}

// ─── Init & Event Bindings ────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadStats();
  await loadConversations();

  // Search
  const searchInput = $("search-input");
  const clearBtn = $("btn-clear-search");
  let searchTimer;

  searchInput.addEventListener("input", () => {
    const val = searchInput.value.trim();
    clearBtn.classList.toggle("visible", val.length > 0);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadConversations(val), 250);
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.classList.remove("visible");
    loadConversations();
  });

  // Back button
  $("btn-back").addEventListener("click", closeDetail);

  // Detail panel actions
  $("detail-btn-export").addEventListener("click", async () => {
    if (!currentConvId) return;
    const conv = allConversations.find((c) => c.id === currentConvId);
    await exportMarkdown(currentConvId, conv?.title);
  });

  $("detail-btn-notion").addEventListener("click", async () => {
    if (currentConvId) await syncNotion(currentConvId);
  });

  $("detail-btn-delete").addEventListener("click", async () => {
    if (!currentConvId) return;
    await deleteConversation(currentConvId, null);
    closeDetail();
    await loadConversations($("search-input").value.trim());
  });

  // Export all
  $("btn-export-all").addEventListener("click", async () => {
    try {
      showToast("⏳ 正在匯出所有對話…", "info", 6000);
      const { markdown } = await sendMessage("exportAllMarkdown");
      triggerDownload(
        `claude-all-conversations-${Date.now()}.md`,
        markdown
      );
      showToast("✅ 全部匯出完成！", "success");
    } catch (err) {
      showToast("匯出失敗：" + err.message, "error");
    }
  });

  // Options page
  $("btn-options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
