import { extension_settings } from "../../../extensions.js";
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types
} from "../../../../script.js";

const MODULE_NAME = "st_plot_steering";
const PROMPT_KEY = "st_plot_steering_prompt";

// 默认数据结构
const defaultState = {
    enabled: true,
    storyTitle: "未命名剧情线",
    plotline: "",
    endings: [
        { id: "end_1", name: "结局 A", desc: "", prob: 50 },
        { id: "end_2", name: "结局 B", desc: "", prob: 50 }
    ],
    nodes: [], // { id, turn, summary, probs: { end_1: 60, end_2: 40 }, timestamp }
    passwordHash: "", // 空字符串表示未设密码
    isSealed: false   // true = 导入的作者封包，永久锁定密码修改权
};

// 运行时会话状态（刷新页面后自动重新锁定，防剧透）
let isUnlocked = false;
let activeTab = "fate"; // "fate" | "edit"
let editingNodeId = null;

// 轻量级本地哈希（兼容 http 局域网环境，不依赖 crypto.subtle）
function hashPassword(str) {
    if (!str) return "";
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return "ps_" + Math.abs(hash).toString(36) + "_" + str.length;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultState);
    }
    return extension_settings[MODULE_NAME];
}

function saveSettings() {
    saveSettingsDebounced();
    injectPlotPrompt();
}

/* =========================================
   核心：向 AI 注入剧情大纲与结局判定指令
   ========================================= */
function injectPlotPrompt() {
    const s = getSettings();
    if (!s.enabled || (!s.plotline.trim() && s.endings.length === 0)) {
        setExtensionPrompt(PROMPT_KEY, "", extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const endingsText = s.endings
        .map((e, i) => `${i + 1}. [ID:${e.id}] ${e.name}（当前偏向 ${e.prob}%）：${e.desc || "无详细描述"}`)
        .join("\n");

    const recentNodes = s.nodes.slice(-5)
        .map((n, idx) => `节点${s.nodes.length - Math.min(5, s.nodes.length) + idx + 1}：${n.summary}`)
        .join("\n");

    const promptText = `
[系统隐藏指令：剧情大纲与结局掰正系统]
你必须在保持角色扮演自然流畅的前提下，严格遵循以下剧情大纲，并根据当前互动走向动态推进结局。如果玩家做出重大反转行为，请合理调整结局偏向，最终导向最契合的终局。

【主线大纲】
${s.plotline || "（未设定）"}

【预设结局分支】
${endingsText}

【已确认的关键命运节点（若玩家修改了以下总结，请严格以修改后的事实为准）】
${recentNodes || "（暂无节点）"}

【强制输出格式】
在每次回复的最后，必须附加一个隐藏的 JSON 判定块，格式如下（百分比总和需为100，summary 需简明总结本轮导致结局偏向的关键判定，供节点记录）：
<plot_steer>
{
  "probs": { ${s.endings.map(e => `"${e.id}": ${e.prob}`).join(", ")} },
  "summary": "本轮关键剧情判定与结局偏向原因总结"
}
</plot_steer>
`.trim();

    setExtensionPrompt(PROMPT_KEY, promptText, extension_prompt_types.IN_PROMPT, 1);
}

/* =========================================
   核心：解析 AI 回复中的 <plot_steer> 判定块
   ========================================= */
function handleIncomingMessage(messageId) {
    const s = getSettings();
    if (!s.enabled) return;

    const context = SillyTavern.getContext();
    const chat = context.chat;
    if (!chat || !chat.length) return;

    const msg = typeof messageId === "number" ? chat[messageId] : chat[chat.length - 1];
    if (!msg || msg.is_user || !msg.mes) return;

    const regex = /<plot_steer>([\s\S]*?)<\/plot_steer>/i;
    const match = msg.mes.match(regex);
    if (!match) return;

    try {
        const data = JSON.parse(match[1].trim());
        if (data.probs && typeof data.probs === "object") {
            s.endings.forEach(e => {
                if (typeof data.probs[e.id] === "number") {
                    e.prob = Math.max(0, Math.min(100, Math.round(data.probs[e.id])));
                }
            });
        }

        const newNode = {
            id: "node_" + Date.now(),
            turn: chat.length,
            summary: data.summary || "本轮剧情推进，结局偏向已更新。",
            probs: Object.fromEntries(s.endings.map(e => [e.id, e.prob])),
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        };

        // 避免同一消息重复记录
        const exists = s.nodes.some(n => n.turn === newNode.turn && n.summary === newNode.summary);
        if (!exists) {
            s.nodes.push(newNode);
            saveSettings();
            if ($("#ps-modal-overlay").hasClass("ps-open")) {
                renderPanelContent();
            }
        }
    } catch (err) {
        console.warn("[Plot Steering] 解析 <plot_steer> 失败:", err);
    }
}

/* =========================================
   UI 渲染：悬浮微发光圆环 + 毛玻璃面板
   ========================================= */
function initUI() {
    if ($("#ps-floating-trigger").length) return;

    // 1. 悬浮触发器
    const triggerHtml = `
        <div id="ps-floating-trigger" title="剧情大纲掰正插件">
            <div class="ps-glow-ring"></div>
            <div class="ps-pinned-rect"></div>
        </div>
    `;
    $("body").append(triggerHtml);

    // 2. 毛玻璃弹窗容器
    const modalHtml = `
        <div id="ps-modal-overlay">
            <div id="ps-panel">
                <div class="ps-header">
                    <div class="ps-title-wrap">
                        <span class="ps-title">PLOT STEERING</span>
                        <span id="ps-mode-badge" class="ps-badge">作者模式</span>
                    </div>
                    <button class="ps-close-btn" id="ps-close-btn">×</button>
                </div>
                <div id="ps-tabs-container"></div>
                <div class="ps-body" id="ps-body"></div>
                <div class="ps-footer" id="ps-footer"></div>
            </div>
        </div>
    `;
    $("body").append(modalHtml);

    // 绑定拖拽与点击（区分拖拽和点击）
    makeDraggable($("#ps-floating-trigger"), () => {
        openModal();
    });

    $("#ps-close-btn").on("click", closeModal);
    $("#ps-modal-overlay").on("click", function (e) {
        if (e.target === this) closeModal();
    });
}

function makeDraggable($el, onClick) {
    let isDragging = false;
    let moved = false;
    let startX, startY, origRight, origTop;

    $el.on("mousedown touchstart", function (e) {
        isDragging = true;
        moved = false;
        const point = e.type === "touchstart" ? e.originalEvent.touches[0] : e;
        startX = point.clientX;
        startY = point.clientY;
        const rect = $el[0].getBoundingClientRect();
        origTop = rect.top;
        origRight = window.innerWidth - rect.right;
    });

    $(document).on("mousemove touchmove", function (e) {
        if (!isDragging) return;
        const point = e.type === "touchmove" ? e.originalEvent.touches[0] : e;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        if (moved) {
            $el.css({
                top: Math.max(10, Math.min(window.innerHeight - 60, origTop + dy)) + "px",
                right: Math.max(10, Math.min(window.innerWidth - 60, origRight - dx)) + "px"
            });
        }
    });

    $(document).on("mouseup touchend", function () {
        if (isDragging) {
            isDragging = false;
            if (!moved && onClick) onClick();
        }
    });
}

function openModal() {
    renderPanelContent();
    $("#ps-modal-overlay").addClass("ps-open");
}

function closeModal() {
    $("#ps-modal-overlay").removeClass("ps-open");
}

/* =========================================
   主视图路由：锁定页 vs 解锁页
   ========================================= */
function renderPanelContent() {
    const s = getSettings();
    const $badge = $("#ps-mode-badge");
    const $tabs = $("#ps-tabs-container");
    const $body = $("#ps-body");
    const $footer = $("#ps-footer");

    if (s.isSealed) {
        $badge.text("已封印 · 防剧透包").addClass("ps-sealed");
    } else {
        $badge.text("作者编辑模式").removeClass("ps-sealed");
    }

    // 如果设置了密码且当前未解锁 -> 显示锁定界面
    if (s.passwordHash && !isUnlocked) {
        $tabs.empty();
        $body.html(`
            <div class="ps-lock-screen">
                <div class="ps-lock-icon">🔒</div>
                <div style="font-size:15px;font-weight:500;">${escapeHtml(s.storyTitle)}</div>
                <div class="ps-lock-desc">
                    当前剧情线与结局大纲已加密锁定。<br>
                    剧情仍在后台正常推进，输入密码后可查看结局偏向与命运节点。
                </div>
                <div class="ps-input-row">
                    <input type="password" id="ps-unlock-input" class="ps-input" placeholder="输入解锁密码..." />
                    <button id="ps-unlock-btn" class="ps-btn ps-btn-primary">解锁</button>
                </div>
                <div id="ps-unlock-error" style="color:#ff8a8a;font-size:12px;min-height:16px;"></div>
            </div>
        `);

        $footer.html(`
            <div class="ps-footer-group">
                <label class="ps-btn ps-btn-sm" style="cursor:pointer;">
                    导入剧情封包
                    <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
                </label>
            </div>
            <div class="ps-footer-group">
                <span class="ps-hint" style="margin:0;">状态：${s.enabled ? "后台掰正运行中" : "已暂停"}</span>
            </div>
        `);

        $("#ps-unlock-btn").on("click", attemptUnlock);
        $("#ps-unlock-input").on("keydown", e => { if (e.key === "Enter") attemptUnlock(); });
        $("#ps-import-file").on("change", handleImportPackage);
        return;
    }

    // 已解锁或未设密码 -> 显示双标签页
    $tabs.html(`
        <div class="ps-tabs">
            <div class="ps-tab ${activeTab === "fate" ? "ps-active" : ""}" data-tab="fate">结局走向 & 命运节点</div>
            <div class="ps-tab ${activeTab === "edit" ? "ps-active" : ""}" data-tab="edit">${s.isSealed ? "大纲内容（只读）" : "大纲与结局编辑"}</div>
        </div>
    `);

    $(".ps-tab").on("click", function () {
        activeTab = $(this).data("tab");
        renderPanelContent();
    });

    if (activeTab === "fate") {
        renderFateTab($body);
    } else {
        renderEditTab($body);
    }

    renderFooter($footer);
}

function attemptUnlock() {
    const s = getSettings();
    const val = $("#ps-unlock-input").val();
    if (hashPassword(val) === s.passwordHash) {
        isUnlocked = true;
        renderPanelContent();
    } else {
        $("#ps-unlock-error").text("密码错误，无法解锁。");
    }
}

/* =========================================
   标签页 1：结局百分比 & 命运节点（支持逆天改命）
   ========================================= */
function renderFateTab($body) {
    const s = getSettings();

    const probsHtml = s.endings.length
        ? s.endings.map(e => `
            <div class="ps-prob-item">
                <div class="ps-prob-head">
                    <span>${escapeHtml(e.name)}</span>
                    <span style="opacity:0.85;font-weight:500;">${e.prob}%</span>
                </div>
                <div class="ps-prob-bar-bg">
                    <div class="ps-prob-bar-fill" style="width:${e.prob}%;"></div>
                </div>
            </div>
        `).join("")
        : `<div class="ps-hint">尚未设置任何结局。</div>`;

    const nodesHtml = s.nodes.length
        ? [...s.nodes].reverse().map((node, revIdx) => {
            const realIdx = s.nodes.length - 1 - revIdx;
            const isEditing = editingNodeId === node.id;
            return `
                <div class="ps-node-card">
                    <div class="ps-node-header">
                        <span>节点 #${realIdx + 1} · 第 ${node.turn} 轮 · ${node.timestamp || ""}</span>
                        <div class="ps-node-actions">
                            ${isEditing
                                ? `<button class="ps-btn ps-btn-primary ps-btn-sm ps-save-node" data-id="${node.id}">保存</button>
                                   <button class="ps-btn ps-btn-sm ps-cancel-node">取消</button>`
                                : `<button class="ps-btn ps-btn-sm ps-edit-node" data-id="${node.id}">编辑 / 改命</button>
                                   <button class="ps-btn ps-btn-danger ps-btn-sm ps-rewind-node" data-idx="${realIdx}" title="倒回至此节点并清除之后的记录">倒回至此</button>`
                            }
                        </div>
                    </div>
                    ${isEditing
                        ? `<textarea class="ps-textarea ps-node-edit-input" data-id="${node.id}">${escapeHtml(node.summary)}</textarea>`
                        : `<div class="ps-node-text">${escapeHtml(node.summary)}</div>`
                    }
                </div>
            `;
        }).join("")
        : `<div class="ps-hint">暂无命运节点。开始对话后，AI 每轮的重大判定总结将自动出现在这里，你可以随时编辑或倒回。</div>`;

    $body.html(`
        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">当前结局偏向百分比</span>
                <button id="ps-add-manual-node" class="ps-btn ps-btn-sm">+ 手动记录节点</button>
            </div>
            ${probsHtml}
        </div>
        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">重大判定节点（可篡改 / 倒回）</span>
            </div>
            ${nodesHtml}
        </div>
    `);

    // 绑定节点编辑事件
    $(".ps-edit-node").on("click", function () {
        editingNodeId = $(this).data("id");
        renderPanelContent();
    });

    $(".ps-cancel-node").on("click", function () {
        editingNodeId = null;
        renderPanelContent();
    });

    $(".ps-save-node").on("click", function () {
        const id = $(this).data("id");
        const newText = $(`.ps-node-edit-input[data-id="${id}"]`).val().trim();
        const node = s.nodes.find(n => n.id === id);
        if (node && newText) {
            node.summary = newText;
            saveSettings();
        }
        editingNodeId = null;
        renderPanelContent();
    });

    // 倒回至此节点（清除该节点之后的所有节点，并恢复当时的百分比）
    $(".ps-rewind-node").on("click", function () {
        const idx = Number($(this).data("idx"));
        if (!confirm(`确定要倒回至节点 #${idx + 1} 吗？该节点之后的走向记录将被清除，结局百分比将恢复至该节点状态。`)) return;
        const targetNode = s.nodes[idx];
        s.nodes = s.nodes.slice(0, idx + 1);
        if (targetNode && targetNode.probs) {
            s.endings.forEach(e => {
                if (typeof targetNode.probs[e.id] === "number") {
                    e.prob = targetNode.probs[e.id];
                }
            });
        }
        saveSettings();
        renderPanelContent();
    });

    // 手动添加节点（方便玩家直接写一条“逆天改命”指令注入）
    $("#ps-add-manual-node").on("click", function () {
        const newNode = {
            id: "node_" + Date.now(),
            turn: s.nodes.length + 1,
            summary: "【手动干预】在此输入你想要扭转的剧情事实...",
            probs: Object.fromEntries(s.endings.map(e => [e.id, e.prob])),
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        };
        s.nodes.push(newNode);
        editingNodeId = newNode.id;
        saveSettings();
        renderPanelContent();
    });
}

/* =========================================
   标签页 2：大纲与结局编辑（封印模式下防误改密码）
   ========================================= */
function renderEditTab($body) {
    const s = getSettings();
    const disabledAttr = s.isSealed ? "disabled" : "";

    const endingsEditorHtml = s.endings.map((e, idx) => `
        <div class="ps-ending-card">
            <div class="ps-ending-top">
                <input type="text" class="ps-input ps-end-name" data-idx="${idx}" value="${escapeHtml(e.name)}" placeholder="结局名称（如：BE · 永夜）" ${disabledAttr} />
                ${!s.isSealed ? `<button class="ps-btn ps-btn-danger ps-btn-sm ps-del-ending" data-idx="${idx}">删除</button>` : ""}
            </div>
            <textarea class="ps-textarea ps-end-desc" data-idx="${idx}" placeholder="触发条件、剧情走向与终局大纲..." style="min-height:58px;" ${disabledAttr}>${escapeHtml(e.desc)}</textarea>
        </div>
    `).join("");

    $body.html(`
        ${s.isSealed ? `<div class="ps-hint" style="margin-bottom:14px;color:rgba(255,226,165,0.85);">此剧情线为作者封印包：可查看大纲，但无法修改原始密码与作者设定，防止误操作。</div>` : ""}

        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">剧情线名称</span>
            </div>
            <input type="text" id="ps-story-title" class="ps-input" value="${escapeHtml(s.storyTitle)}" placeholder="输入剧情线名称..." ${disabledAttr} />
        </div>

        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">主线剧情大纲（随每次聊天发送给 AI）</span>
            </div>
            <textarea id="ps-plotline" class="ps-textarea" placeholder="输入核心世界观、主线脉络、关键转折点..." ${disabledAttr}>${escapeHtml(s.plotline)}</textarea>
        </div>

        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">结局分支设定（共 ${s.endings.length} 个）</span>
                ${!s.isSealed ? `<button id="ps-add-ending" class="ps-btn ps-btn-sm">+ 添加结局</button>` : ""}
            </div>
            <div id="ps-endings-list">${endingsEditorHtml}</div>
        </div>

        ${!s.isSealed ? `
        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">防剧透密码设置（每条剧情线独立）</span>
            </div>
            <div class="ps-input-row" style="max-width:100%;">
                <input type="password" id="ps-new-password" class="ps-input" placeholder="${s.passwordHash ? "已设置密码（输入新密码可覆盖）" : "设置解锁密码..."}" />
                <button id="ps-set-password-btn" class="ps-btn">保存密码</button>
            </div>
            <div class="ps-hint">设置密码后，点击下方「导出加密封包」发给玩家，玩家导入后将永久锁定密码，无法手滑修改。</div>
        </div>
        ` : ""}
    `);

    if (!s.isSealed) {
        $("#ps-story-title").on("input", function () { s.storyTitle = $(this).val(); saveSettings(); });
        $("#ps-plotline").on("input", function () { s.plotline = $(this).val(); saveSettings(); });

        $(".ps-end-name").on("input", function () {
            s.endings[$(this).data("idx")].name = $(this).val();
            saveSettings();
        });
        $(".ps-end-desc").on("input", function () {
            s.endings[$(this).data("idx")].desc = $(this).val();
            saveSettings();
        });

        $("#ps-add-ending").on("click", function () {
            const newId = "end_" + Date.now();
            s.endings.push({ id: newId, name: `结局 ${s.endings.length + 1}`, desc: "", prob: 0 });
            saveSettings();
            renderPanelContent();
        });

        $(".ps-del-ending").on("click", function () {
            s.endings.splice($(this).data("idx"), 1);
            saveSettings();
            renderPanelContent();
        });

        $("#ps-set-password-btn").on("click", function () {
            const pwd = $("#ps-new-password").val().trim();
            if (!pwd) {
                if (confirm("密码为空将清除当前密码保护，确定吗？")) {
                    s.passwordHash = "";
                    saveSettings();
                    alert("已清除密码保护。");
                    renderPanelContent();
                }
                return;
            }
            s.passwordHash = hashPassword(pwd);
            saveSettings();
            $("#ps-new-password").val("");
            alert("密码已保存！下次刷新或点击「立即锁定」后生效。");
            renderPanelContent();
        });
    }
}

/* =========================================
   底部工具栏：导出封印包 / 导入 / 锁定 / 开关
   ========================================= */
function renderFooter($footer) {
    const s = getSettings();

    $footer.html(`
        <div class="ps-footer-group">
            <button id="ps-toggle-enable" class="ps-btn ps-btn-sm">
                ${s.enabled ? "● 掰正已开启" : "○ 掰正已暂停"}
            </button>
            ${s.passwordHash ? `<button id="ps-lock-now" class="ps-btn ps-btn-sm">立即锁定</button>` : ""}
        </div>
        <div class="ps-footer-group">
            <label class="ps-btn ps-btn-sm" style="cursor:pointer;">
                导入封包
                <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
            </label>
            ${!s.isSealed
                ? `<button id="ps-export-sealed" class="ps-btn ps-btn-primary ps-btn-sm">导出加密封包</button>`
                : `<button id="ps-reset-author" class="ps-btn ps-btn-danger ps-btn-sm" title="清空当前封包并新建空白剧情线">新建空白线</button>`
            }
        </div>
    `);

    $("#ps-toggle-enable").on("click", function () {
        s.enabled = !s.enabled;
        saveSettings();
        renderPanelContent();
    });

    $("#ps-lock-now").on("click", function () {
        isUnlocked = false;
        renderPanelContent();
    });

    $("#ps-import-file").on("change", handleImportPackage);

    $("#ps-export-sealed").on("click", function () {
        if (!s.passwordHash) {
            if (!confirm("你还没有设置密码，确定要导出无密码封包吗？")) return;
        }
        const pkg = {
            version: "1.0",
            isSealed: true, // 导入后永久进入封印模式
            storyTitle: s.storyTitle,
            plotline: s.plotline,
            endings: s.endings.map(e => ({ ...e, prob: Math.round(100 / Math.max(1, s.endings.length)) })),
            passwordHash: s.passwordHash
        };
        const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${s.storyTitle || "plot"}_sealed.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $("#ps-reset-author").on("click", function () {
        if (!confirm("将清空当前封印包并回到空白作者模式，确定吗？")) return;
        extension_settings[MODULE_NAME] = structuredClone(defaultState);
        isUnlocked = true;
        saveSettings();
        renderPanelContent();
    });
}

function handleImportPackage(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (evt) {
        try {
            const pkg = JSON.parse(evt.target.result);
            if (!pkg.endings || typeof pkg.plotline !== "string") {
                alert("无效的剧情封包文件。");
                return;
            }
            extension_settings[MODULE_NAME] = {
                enabled: true,
                storyTitle: pkg.storyTitle || "导入的剧情线",
                plotline: pkg.plotline,
                endings: pkg.endings,
                nodes: [],
                passwordHash: pkg.passwordHash || "",
                isSealed: true // 导入即永久锁定编辑与改密权限
            };
            isUnlocked = !pkg.passwordHash; // 有密码则默认锁定
            saveSettings();
            renderPanelContent();
            alert("剧情封包导入成功！已自动锁定防剧透。");
        } catch (err) {
            alert("读取封包失败，请检查 JSON 格式。");
        }
    };
    reader.readAsText(file);
}

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, """);
}

/* =========================================
   插件初始化入口
   ========================================= */
jQuery(async () => {
    getSettings();
    initUI();
    injectPlotPrompt();

    eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        injectPlotPrompt();
    });
});
