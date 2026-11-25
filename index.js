const MODULE_NAME = "st_plot_steering";
const PROMPT_KEY = "st_plot_steering_prompt";

const defaultState = {
    enabled: true,
    storyTitle: "未命名剧情线",
    plotline: "",
    endings: [
        { id: "end_1", name: "结局 A", desc: "", prob: 50 },
        { id: "end_2", name: "结局 B", desc: "", prob: 50 }
    ],
    nodes: [],
    passwordHash: "",
    authorPasswordHash: "",
    isSealed: false
};

let isUnlocked = false;
let isAuthorUnlocked = false;
let activeTab = "fate";
let editingNodeId = null;

function hashPassword(str) {
    if (!str) return "";
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return "ps_" + Math.abs(hash).toString(36) + "_" + str.length;
}

function getContextSafe() {
    try {
        return window.SillyTavern ? window.SillyTavern.getContext() : {};
    } catch (e) {
        return {};
    }
}

function getSettings() {
    const ctx = getContextSafe();
    const extSettings = ctx.extensionSettings || (window._psFallbackSettings = window._psFallbackSettings || {});
    if (!extSettings[MODULE_NAME]) {
        extSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultState));
    }
    if (typeof extSettings[MODULE_NAME].authorPasswordHash === "undefined") {
        extSettings[MODULE_NAME].authorPasswordHash = "";
    }
    return extSettings[MODULE_NAME];
}

function saveSettings() {
    try {
        const ctx = getContextSafe();
        if (typeof ctx.saveSettingsDebounced === "function") {
            ctx.saveSettingsDebounced();
        }
        injectPlotPrompt();
    } catch (e) {
        console.warn("[Plot Steering] 保存设置异常:", e);
    }
}

function injectPlotPrompt() {
    try {
        const ctx = getContextSafe();
        if (typeof ctx.setExtensionPrompt !== "function") return;

        const s = getSettings();
        const promptType = ctx.extension_prompt_types ? ctx.extension_prompt_types.IN_PROMPT : 1;

        if (!s.enabled || (!s.plotline.trim() && s.endings.length === 0)) {
            ctx.setExtensionPrompt(PROMPT_KEY, "", promptType, 0);
            return;
        }

        const endingsText = s.endings
            .map((e, i) => `${i + 1}. [ID:${e.id}] ${e.name}（当前偏向 ${e.prob}%）：${e.desc || "无详细描述"}`)
            .join("\n");

        const recentNodes = s.nodes.slice(-5)
            .map((n, idx) => `节点${s.nodes.length - Math.min(5, s.nodes.length) + idx + 1}：${n.summary}`)
            .join("\n");

        const promptText = [
            "[系统隐藏指令：剧情大纲与结局掰正系统]",
            "你必须在保持角色扮演自然流畅的前提下，严格遵循以下剧情大纲，并根据当前互动走向动态推进结局。如果玩家做出重大反转行为，请合理调整结局偏向，最终导向最契合的终局。",
            "",
            "【主线大纲】",
            s.plotline || "（未设定）",
            "",
            "【预设结局分支】",
            endingsText,
            "",
            "【已确认的关键命运节点（若玩家修改了以下总结，请严格以修改后的事实为准）】",
            recentNodes || "（暂无节点）",
            "",
            "【强制输出格式】",
            "在每次回复的最后，必须附加一个隐藏的 JSON 判定块，格式如下（百分比总和需为100，summary 需简明总结本轮导致结局偏向的关键判定，供节点记录）：",
            "<plot_steer>",
            "{",
            `  "probs": { ${s.endings.map(e => `"${e.id}": ${e.prob}`).join(", ")} },`,
            '  "summary": "本轮关键剧情判定与结局偏向原因总结"',
            "}",
            "</plot_steer>"
        ].join("\n");

        ctx.setExtensionPrompt(PROMPT_KEY, promptText, promptType, 1);
    } catch (e) {
        console.warn("[Plot Steering] 注入大纲异常:", e);
    }
}

function handleIncomingMessage(messageId) {
    try {
        const s = getSettings();
        if (!s.enabled) return;

        const ctx = getContextSafe();
        const chat = ctx.chat;
        if (!chat || !chat.length) return;

        const msg = typeof messageId === "number" ? chat[messageId] : chat[chat.length - 1];
        if (!msg || msg.is_user || !msg.mes) return;

        const regex = /<plot_steer>([\s\S]*?)<\/plot_steer>/i;
        const match = msg.mes.match(regex);
        if (!match) return;

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

function initUI() {
    if (document.getElementById("ps-floating-trigger")) return;

    const triggerHtml = `
        <div id="ps-floating-trigger" title="剧情大纲掰正插件" style="z-index: 99998;">
            <div class="ps-glow-ring"></div>
            <div class="ps-pinned-rect"></div>
        </div>
    `;
    $("body").append(triggerHtml);

    const modalHtml = `
        <div id="ps-modal-overlay" style="z-index: 99999;">
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

function renderPanelContent() {
    const s = getSettings();
    const canEdit = !s.isSealed || isAuthorUnlocked;
    const $badge = $("#ps-mode-badge");
    const $tabs = $("#ps-tabs-container");
    const $body = $("#ps-body");
    const $footer = $("#ps-footer");

    if (s.isSealed) {
        $badge.text(isAuthorUnlocked ? "已封印 · 作者已提权" : "已封印 · 防剧透包").addClass("ps-sealed");
    } else {
        $badge.text("作者编辑模式").removeClass("ps-sealed");
    }

    const hasAnyPassword = Boolean(s.passwordHash || s.authorPasswordHash);

    if (hasAnyPassword && !isUnlocked) {
        $tabs.empty();
        $body.html(`
            <div class="ps-lock-screen">
                <div class="ps-lock-icon">🔒</div>
                <div style="font-size:15px;font-weight:500;">${escapeHtml(s.storyTitle)}</div>
                <div class="ps-lock-desc">
                    当前剧情线与结局大纲已加密锁定。<br>
                    输入玩家密码可查看走向与节点；输入作者密码可直接进入编辑模式。
                </div>
                <div class="ps-input-row">
                    <input type="password" id="ps-unlock-input" class="ps-input" placeholder="输入解锁密码或作者密码..." />
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

    $tabs.html(`
        <div class="ps-tabs">
            <div class="ps-tab ${activeTab === "fate" ? "ps-active" : ""}" data-tab="fate">结局走向 & 命运节点</div>
            <div class="ps-tab ${activeTab === "edit" ? "ps-active" : ""}" data-tab="edit">${canEdit ? "大纲与结局编辑" : "大纲内容（只读）"}</div>
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
    const hashed = hashPassword(val);

    if (s.authorPasswordHash && hashed === s.authorPasswordHash) {
        isUnlocked = true;
        isAuthorUnlocked = true;
        renderPanelContent();
        return;
    }

    if (s.passwordHash && hashed === s.passwordHash) {
        isUnlocked = true;
        isAuthorUnlocked = false;
        renderPanelContent();
        return;
    }

    $("#ps-unlock-error").text("密码错误，无法解锁。");
}

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

function renderEditTab($body) {
    const s = getSettings();
    const canEdit = !s.isSealed || isAuthorUnlocked;
    const disabledAttr = canEdit ? "" : "disabled";

    const endingsEditorHtml = s.endings.map((e, idx) => `
        <div class="ps-ending-card">
            <div class="ps-ending-top">
                <input type="text" class="ps-input ps-end-name" data-idx="${idx}" value="${escapeHtml(e.name)}" placeholder="结局名称（如：BE · 永夜）" ${disabledAttr} />
                ${canEdit ? `<button class="ps-btn ps-btn-danger ps-btn-sm ps-del-ending" data-idx="${idx}">删除</button>` : ""}
            </div>
            <textarea class="ps-textarea ps-end-desc" data-idx="${idx}" placeholder="触发条件、剧情走向与终局大纲..." style="min-height:58px;" ${disabledAttr}>${escapeHtml(e.desc)}</textarea>
        </div>
    `).join("");

    let sealedBannerHtml = "";
    if (!canEdit) {
        const elevateBox = s.authorPasswordHash
            ? `<div class="ps-input-row" style="max-width:100%;margin-top:4px;">
                   <input type="password" id="ps-author-elevate-input" class="ps-input" placeholder="作者本人测试/修改？输入作者密码解除只读..." />
                   <button id="ps-author-elevate-btn" class="ps-btn ps-btn-primary">解锁编辑</button>
               </div>
               <div id="ps-author-elevate-err" style="color:#ff8a8a;font-size:11.5px;"></div>`
            : `<div class="ps-hint" style="margin:0;">（该封包导出时未设置作者管理密码，无法提权编辑）</div>`;

        sealedBannerHtml = `
            <div class="ps-ending-card" style="border-color:rgba(255,215,130,0.3);margin-bottom:16px;">
                <div class="ps-hint" style="margin:0;color:rgba(255,226,165,0.9);">
                    此剧情线为作者封印包（只读模式），防止玩家误改设定。
                </div>
                ${elevateBox}
            </div>
        `;
    }

    const passwordSectionHtml = canEdit ? `
        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">1. 玩家防剧透密码（给玩家查看结局与节点用，不可改大纲）</span>
            </div>
            <div class="ps-input-row" style="max-width:100%;">
                <input type="password" id="ps-new-password" class="ps-input" placeholder="${s.passwordHash ? "已设置玩家密码（输入新密码可覆盖）" : "设置玩家解锁密码..."}" />
                <button id="ps-set-password-btn" class="ps-btn">保存玩家密码</button>
            </div>
        </div>
        <div class="ps-section">
            <div class="ps-section-header">
                <span class="ps-label">2. 作者管理密码（仅作者本人保留，封印后也可解锁编辑）</span>
            </div>
            <div class="ps-input-row" style="max-width:100%;">
                <input type="password" id="ps-new-author-password" class="ps-input" placeholder="${s.authorPasswordHash ? "已设置作者密码（输入新密码可覆盖）" : "设置作者管理密码..."}" />
                <button id="ps-set-author-password-btn" class="ps-btn">保存作者密码</button>
            </div>
            <div class="ps-hint">建议两个密码设成不一样的：发给玩家“玩家密码”，自己留着“作者密码”方便随时测试和修改大纲。</div>
        </div>
    ` : "";

    $body.html(`
        ${sealedBannerHtml}
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
                ${canEdit ? `<button id="ps-add-ending" class="ps-btn ps-btn-sm">+ 添加结局</button>` : ""}
            </div>
            <div id="ps-endings-list">${endingsEditorHtml}</div>
        </div>
        ${passwordSectionHtml}
    `);

    if (!canEdit && s.authorPasswordHash) {
        const tryElevate = () => {
            const val = $("#ps-author-elevate-input").val();
            if (hashPassword(val) === s.authorPasswordHash) {
                isAuthorUnlocked = true;
                renderPanelContent();
            } else {
                $("#ps-author-elevate-err").text("作者密码错误。");
            }
        };
        $("#ps-author-elevate-btn").on("click", tryElevate);
        $("#ps-author-elevate-input").on("keydown", e => { if (e.key === "Enter") tryElevate(); });
    }

    if (canEdit) {
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
                if (confirm("密码为空将清除玩家防剧透密码，确定吗？")) {
                    s.passwordHash = "";
                    saveSettings();
                    alert("已清除玩家密码。");
                    renderPanelContent();
                }
                return;
            }
            s.passwordHash = hashPassword(pwd);
            saveSettings();
            $("#ps-new-password").val("");
            alert("玩家防剧透密码已保存！");
            renderPanelContent();
        });

        $("#ps-set-author-password-btn").on("click", function () {
            const pwd = $("#ps-new-author-password").val().trim();
            if (!pwd) {
                if (confirm("密码为空将清除作者管理密码，确定吗？")) {
                    s.authorPasswordHash = "";
                    saveSettings();
                    alert("已清除作者密码。");
                    renderPanelContent();
                }
                return;
            }
            s.authorPasswordHash = hashPassword(pwd);
            saveSettings();
            $("#ps-new-author-password").val("");
            alert("作者管理密码已保存！封印导出后凭此密码可随时解除只读编辑。");
            renderPanelContent();
        });
    }
}

function renderFooter($footer) {
    const s = getSettings();
    const canEdit = !s.isSealed || isAuthorUnlocked;
    const hasAnyPassword = Boolean(s.passwordHash || s.authorPasswordHash);

    $footer.html(`
        <div class="ps-footer-group">
            <button id="ps-toggle-enable" class="ps-btn ps-btn-sm">
                ${s.enabled ? "● 掰正已开启" : "○ 掰正已暂停"}
            </button>
            ${hasAnyPassword ? `<button id="ps-lock-now" class="ps-btn ps-btn-sm">立即锁定</button>` : ""}
        </div>
        <div class="ps-footer-group">
            <label class="ps-btn ps-btn-sm" style="cursor:pointer;">
                导入封包
                <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
            </label>
            ${canEdit
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
        isAuthorUnlocked = false;
        renderPanelContent();
    });

    $("#ps-import-file").on("change", handleImportPackage);

    $("#ps-export-sealed").on("click", function () {
        if (!s.passwordHash && !s.authorPasswordHash) {
            if (!confirm("你还没有设置任何密码，确定要导出无密码封包吗？")) return;
        }
        const pkg = {
            version: "1.1",
            isSealed: true,
            storyTitle: s.storyTitle,
            plotline: s.plotline,
            endings: s.endings.map(e => ({ ...e, prob: Math.round(100 / Math.max(1, s.endings.length)) })),
            passwordHash: s.passwordHash,
            authorPasswordHash: s.authorPasswordHash
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
        const ctx = getContextSafe();
        if (ctx.extensionSettings) {
            ctx.extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultState));
        }
        isUnlocked = true;
        isAuthorUnlocked = true;
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
            const ctx = getContextSafe();
            if (ctx.extensionSettings) {
                ctx.extensionSettings[MODULE_NAME] = {
                    enabled: true,
                    storyTitle: pkg.storyTitle || "导入的剧情线",
                    plotline: pkg.plotline,
                    endings: pkg.endings,
                    nodes: [],
                    passwordHash: pkg.passwordHash || "",
                    authorPasswordHash: pkg.authorPasswordHash || "",
                    isSealed: true
                };
            }
            isUnlocked = !pkg.passwordHash && !pkg.authorPasswordHash;
            isAuthorUnlocked = false;
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
   安全初始化：先画圆环，再挂后台逻辑，带兜底检查
   ========================================= */
function bootPlugin() {
    try {
        initUI();
    } catch (e) {
        console.error("[Plot Steering] UI 初始化失败:", e);
    }

    try {
        getSettings();
        injectPlotPrompt();
        const ctx = getContextSafe();
        if (ctx.eventSource && ctx.event_types) {
            ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, handleIncomingMessage);
            ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, injectPlotPrompt);
        }
    } catch (e) {
        console.warn("[Plot Steering] 后台初始化异常:", e);
    }
}

jQuery(() => {
    bootPlugin();
    setTimeout(initUI, 1500);
});
