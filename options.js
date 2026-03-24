// options.js — Claude Sidebar Saver Options Page

const $ = (id) => document.getElementById(id);

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function loadSettings() {
  const { notion_token = "", notion_database_id = "" } =
    await chrome.storage.sync.get(["notion_token", "notion_database_id"]);
  $("notion-token").value = notion_token;
  $("notion-db").value = notion_database_id;
}

async function saveSettings() {
  const token = $("notion-token").value.trim();
  const dbId = $("notion-db").value.trim();
  await chrome.storage.sync.set({
    notion_token: token,
    notion_database_id: dbId,
  });
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function showStatus(msg, type = "info") {
  const bar = $("status-bar");
  const icon = $("status-icon");
  const text = $("status-text");

  bar.hidden = false;
  bar.className = `status-bar status-${type}`;
  icon.textContent =
    type === "success" ? "✅" : type === "error" ? "❌" : "⏳";
  text.textContent = msg;

  if (type !== "loading") {
    setTimeout(() => (bar.hidden = true), 4000);
  }
}

// ─── Notion connection test ───────────────────────────────────────────────────

async function testNotionConnection() {
  const token = $("notion-token").value.trim();
  const dbId = $("notion-db").value.trim();

  if (!token) return showStatus("請填入 Notion Integration Token", "error");
  if (!dbId) return showStatus("請填入 Notion Database ID", "error");

  showStatus("正在測試連線…", "loading");

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    });

    if (res.status === 200) {
      const db = await res.json();
      const title =
        db.title?.[0]?.plain_text || "Notion 資料庫";
      showStatus(`連線成功！已連接到「${title}」`, "success");
    } else if (res.status === 401) {
      showStatus("Token 無效或已過期，請重新取得", "error");
    } else if (res.status === 404) {
      showStatus("找不到資料庫，請確認 ID 是否正確且 Integration 已被加入", "error");
    } else {
      const err = await res.json();
      showStatus(`連線失敗：${err.message || res.status}`, "error");
    }
  } catch (err) {
    showStatus(`網路錯誤：${err.message}`, "error");
  }
}

// ─── Storage stats ────────────────────────────────────────────────────────────

async function loadStorageStats() {
  try {
    const data = await chrome.storage.local.get("css_conversations");
    const convs = data.css_conversations || [];
    const totalMessages = convs.reduce((s, c) => s + c.messages.length, 0);
    const byteSize = new TextEncoder().encode(JSON.stringify(convs)).length;
    const sizeStr =
      byteSize > 1024 * 1024
        ? `${(byteSize / 1024 / 1024).toFixed(2)} MB`
        : `${(byteSize / 1024).toFixed(1)} KB`;

    $("store-conversations").textContent = convs.length;
    $("store-messages").textContent = totalMessages;
    $("store-size").textContent = sizeStr;
  } catch (_) {
    $("store-conversations").textContent = "—";
    $("store-messages").textContent = "—";
    $("store-size").textContent = "—";
  }
}

async function clearAllConversations() {
  if (
    !confirm(
      "確定要刪除所有儲存的對話嗎？\n此操作無法復原。"
    )
  )
    return;
  await chrome.storage.local.remove("css_conversations");
  await loadStorageStats();
  showStatus("所有對話已清除", "success");
}

// ─── Token visibility toggle ──────────────────────────────────────────────────

function toggleTokenVisibility() {
  const input = $("notion-token");
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadStorageStats();

  $("btn-save").addEventListener("click", async () => {
    await saveSettings();
    showStatus("設定已儲存！", "success");
  });

  $("btn-test").addEventListener("click", testNotionConnection);

  $("btn-clear-all").addEventListener("click", clearAllConversations);

  $("toggle-token").addEventListener("click", toggleTokenVisibility);

  // Auto-save on input blur
  [$("notion-token"), $("notion-db")].forEach((el) => {
    el.addEventListener("blur", () => saveSettings().catch(() => {}));
  });
});
