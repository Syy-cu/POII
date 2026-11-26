(() => {
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
        passwordHash: "",
        authorPasswordHash: "",
        isSealed: false
    };

    let isUnlocked = false;
    let isAuthorUnlocked = false;
    let activeTab = "fate";
    let eventsBound = false;

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
        const s = extSettings[MODULE_NAME];
        if (typeof s.authorPasswordHash === "undefined") s.authorPasswordHash = "";
        if (!Array.isArray(s.endings) || s.endings.length === 0) {
            s.endings = JSON.parse(JSON.stringify(defaultState.endings));
        }
        return s;
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

    function escapeHtml(str) {
        const amp = String.fromCharCode(38);
        return String(str || "")
            .replace(/&/g, amp + "amp;")
            .replace(/</g, amp + "lt;")
            .replace(/>/g, amp + "gt;")
            .replace(/"/g, amp + "quot;");
    }

    /* =========================================
       记住密码（本地存储）
       ========================================= */
    function getAuthStorageKey(s) {
        return "ps_remember_" + (s.passwordHash || "none") + "_" + (s.authorPasswordHash || "none");
    }

    function restoreSavedAuth() {
        try {
            const s = getSettings();
            const saved = localStorage.getItem(getAuthStorageKey(s));
            if (saved === "author" && s.authorPasswordHash) {
                isUnlocked = true;
                isAuthorUnlocked = true;
            } else if (saved === "player" && s.passwordHash) {
                isUnlocked = true;
                isAuthorUnlocked = false;
            }
        } catch (e) {}
    }

    function clearSavedAuth() {
        try {
            const s = getSettings();
            localStorage.removeItem(getAuthStorageKey(s));
        } catch (e) {}
    }

    /* =========================================
       解析当前消息中的结局百分比
       ========================================= */
    function parseProbsFromText(text) {
        if (!text) return null;
        const regex = /<plot_steer>([\s\S]*?)<\/plot_steer>/i;
        const match = text.match(regex);
        if (!match) return null;
        try {
            const data = JSON.parse(match[1].trim());
            return data && data.probs && typeof data.probs === "object" ? data.probs : null;
        } catch (e) {
            return null;
        }
    }

    function applyProbsToEndings(probs) {
        if (!probs || typeof probs !== "object") return false;
        const s = getSettings();
        let changed = false;
        s.endings.forEach(e => {
            if (typeof probs[e.id] === "number") {
                const nextProb = Math.max(0, Math.min(100, Math.round(probs[e.id])));
                if (e.prob !== nextProb) {
                    e.prob = nextProb;
                    changed = true;
                }
            }
        });
        return changed;
    }

    function syncProbsFromCurrentMessage(messageId) {
        try {
            const s = getSettings();
            if (!s.enabled) return;

            const ctx = getContextSafe();
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            if (!chat.length) return;

            const idx = typeof messageId === "number" ? messageId : chat.length - 1;
            const msg = chat[idx];
            if (!msg || msg.is_user || !msg.mes) return;

            const probs = parseProbsFromText(msg.mes);
            if (probs) {
                applyProbsToEndings(probs);
                saveSettings();
                const overlay = document.getElementById("ps-modal-overlay");
                if (overlay && overlay.classList.contains("ps-open")) {
                    renderPanelContent();
                }
            }
        } catch (err) {
            console.warn("[Plot Steering] 解析 <plot_steer> 失败:", err);
        }
    }

    /* =========================================
       核心：向 AI 注入剧情大纲与结局占比判定指令
       ========================================= */
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

            const promptText = [
                "[系统隐藏指令：剧情大纲与结局占比掰正系统]",
                "你必须在保持角色扮演自然流畅的前提下，严格遵循以下主线大纲与结局设定。请结合当前对话历史与已有记忆/设定判断当前进度：已经发生或已经完成的剧情与线索直接跳过，绝不重复触发，顺着当前进度自然往后推进；若玩家做出重大反转或改变了既有记忆事实，请根据最新事实重新评估并调整各结局偏向。",
                "",
                "【主线大纲】",
                s.plotline || "（未设定）",
                "",
                "【预设结局分支】",
                endingsText,
                "",
                "【强制输出格式】",
                "在每次回复的最末尾，必须附加一个隐藏的 JSON 判定块，严格使用 <plot_steer> 和 </plot_steer> 包裹（不要套用代码块），只输出各结局百分比（总和需为 100）：",
                "<plot_steer>",
                "{",
                `  "probs": { ${s.endings.map(e => `"${e.id}": ${e.prob}`).join(", ")} }`,
                "}",
                "</plot_steer>"
            ].join("\n");

            ctx.setExtensionPrompt(PROMPT_KEY, promptText, promptType, 1);
        } catch (e) {
            console.warn("[Plot Steering] 注入大纲异常:", e);
        }
    }

    /* =========================================
       纯原生 DOM 挂载圆环与面板
       ========================================= */
    function initUI() {
        if (!document.body) return false;
        if (document.getElementById("ps-floating-trigger")) return true;

        const triggerHtml = `
            <div id="ps-floating-trigger" title="点击打开 / 关闭剧情大纲插件">
                <div class="ps-glow-ring"></div>
                <div class="ps-pinned-rect"></div>
            </div>
        `;
        document.body.insertAdjacentHTML("beforeend", triggerHtml);

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
        document.body.insertAdjacentHTML("beforeend", modalHtml);

        const triggerEl = document.getElementById("ps-floating-trigger");
        const closeBtn = document.getElementById("ps-close-btn");
        const overlayEl = document.getElementById("ps-modal-overlay");

        makeDraggable(triggerEl, toggleModal);

        closeBtn.addEventListener("click", closeModal);
        overlayEl.addEventListener("click", (e) => {
            if (e.target === overlayEl) closeModal();
        });

        return true;
    }

    function makeDraggable(el, onClick) {
        let isDragging = false;
        let moved = false;
        let startX = 0, startY = 0, origRight = 28, origTop = 120;
        let lastTouchTime = 0;

        const onStart = (e) => {
            if (e.type === "mousedown" && Date.now() - lastTouchTime < 500) return;
            if (e.type === "touchstart") lastTouchTime = Date.now();

            isDragging = true;
            moved = false;
            const point = e.touches ? e.touches[0] : e;
            startX = point.clientX;
            startY = point.clientY;
            const rect = el.getBoundingClientRect();
            origTop = rect.top;
            origRight = window.innerWidth - rect.right;
        };

        const onMove = (e) => {
            if (!isDragging) return;
            // 面板打开处于邻居停靠状态时，禁止拖拽，确保轻点一下必定关闭
            if (document.body.classList.contains("ps-modal-active")) return;

            const point = e.touches ? e.touches[0] : e;
            const dx = point.clientX - startX;
            const dy = point.clientY - startY;
            if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
            if (moved) {
                el.style.top = Math.max(10, Math.min(window.innerHeight - 60, origTop + dy)) + "px";
                el.style.right = Math.max(10, Math.min(window.innerWidth - 60, origRight - dx)) + "px";
            }
        };

        const onEnd = (e) => {
            if (e.type === "mouseup" && Date.now() - lastTouchTime < 500) return;
            if (e.type === "touchend") lastTouchTime = Date.now();

            if (isDragging) {
                isDragging = false;
                if (!moved && onClick) {
                    if (e.cancelable) e.preventDefault();
                    onClick();
                }
            }
        };

        el.addEventListener("mousedown", onStart);
        el.addEventListener("touchstart", onStart, { passive: true });
        document.addEventListener("mousemove", onMove);
        document.addEventListener("touchmove", onMove, { passive: true });
        document.addEventListener("mouseup", onEnd);
        document.addEventListener("touchend", onEnd, { passive: false });
    }

    function toggleModal() {
        const overlay = document.getElementById("ps-modal-overlay");
        if (overlay && overlay.classList.contains("ps-open")) {
            closeModal();
        } else {
            openModal();
        }
    }

    function openModal() {
        restoreSavedAuth();
        renderPanelContent();
        const overlay = document.getElementById("ps-modal-overlay");
        if (overlay) overlay.classList.add("ps-open");
        document.body.classList.add("ps-modal-active");
    }

    function closeModal() {
        const overlay = document.getElementById("ps-modal-overlay");
        if (overlay) overlay.classList.remove("ps-open");
        document.body.classList.remove("ps-modal-active");
    }

    /* =========================================
       面板渲染
       ========================================= */
    function renderPanelContent() {
        const s = getSettings();
        const canEdit = !s.isSealed || isAuthorUnlocked;
        const badgeEl = document.getElementById("ps-mode-badge");
        const tabsEl = document.getElementById("ps-tabs-container");
        const bodyEl = document.getElementById("ps-body");
        const footerEl = document.getElementById("ps-footer");

        if (s.isSealed) {
            badgeEl.textContent = isAuthorUnlocked ? "已封印 · 作者已提权" : "已封印 · 防剧透包";
            badgeEl.classList.add("ps-sealed");
        } else {
            badgeEl.textContent = "作者编辑模式";
            badgeEl.classList.remove("ps-sealed");
        }

        const hasAnyPassword = Boolean(s.passwordHash || s.authorPasswordHash);

        if (hasAnyPassword && !isUnlocked) {
            tabsEl.innerHTML = "";
            bodyEl.innerHTML = `
                <div class="ps-lock-screen">
                    <div class="ps-lock-icon">🔒</div>
                    <div style="font-size:15px;font-weight:500;">${escapeHtml(s.storyTitle)}</div>
                    <div class="ps-lock-desc">
                        当前剧情线与结局大纲已加密锁定。<br>
                        输入玩家密码可查看结局占比；输入作者密码可直接进入编辑模式。
                    </div>
                    <div class="ps-input-row">
                        <input type="password" id="ps-unlock-input" class="ps-input" placeholder="输入解锁密码或作者密码..." />
                        <button id="ps-unlock-btn" class="ps-btn ps-btn-primary">解锁</button>
                    </div>
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;opacity:0.85;cursor:pointer;margin-top:4px;user-select:none;">
                        <input type="checkbox" id="ps-remember-pwd" checked />
                        记住密码（下次点圆环直接进入）
                    </label>
                    <div id="ps-unlock-error" style="color:#ff8a8a;font-size:12px;min-height:16px;"></div>
                </div>
            `;

            footerEl.innerHTML = `
                <div class="ps-footer-group">
                    <label class="ps-btn ps-btn-sm" style="cursor:pointer;">
                        导入剧情封包
                        <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
                    </label>
                </div>
                <div class="ps-footer-group">
                    <span class="ps-hint" style="margin:0;">状态：${s.enabled ? "后台掰正运行中" : "已暂停"}</span>
                </div>
            `;

            document.getElementById("ps-unlock-btn").addEventListener("click", attemptUnlock);
            document.getElementById("ps-unlock-input").addEventListener("keydown", (e) => {
                if (e.key === "Enter") attemptUnlock();
            });
            document.getElementById("ps-import-file").addEventListener("change", handleImportPackage);
            return;
        }

        tabsEl.innerHTML = `
            <div class="ps-tabs">
                <div class="ps-tab ${activeTab === "fate" ? "ps-active" : ""}" data-tab="fate">结局偏向占比</div>
                <div class="ps-tab ${activeTab === "edit" ? "ps-active" : ""}" data-tab="edit">${canEdit ? "大纲与结局编辑" : "大纲内容（只读）"}</div>
            </div>
        `;

        tabsEl.querySelectorAll(".ps-tab").forEach(tab => {
            tab.addEventListener("click", () => {
                activeTab = tab.getAttribute("data-tab");
                renderPanelContent();
            });
        });

        if (activeTab === "fate") {
            renderFateTab(bodyEl);
        } else {
            renderEditTab(bodyEl);
        }

        renderFooter(footerEl);
    }

    function attemptUnlock() {
        const s = getSettings();
        const inputEl = document.getElementById("ps-unlock-input");
        const errEl = document.getElementById("ps-unlock-error");
        const rememberEl = document.getElementById("ps-remember-pwd");
        const shouldRemember = rememberEl ? rememberEl.checked : false;
        const hashed = hashPassword(inputEl ? inputEl.value : "");

        if (s.authorPasswordHash && hashed === s.authorPasswordHash) {
            isUnlocked = true;
            isAuthorUnlocked = true;
            if (shouldRemember) {
                try { localStorage.setItem(getAuthStorageKey(s), "author"); } catch (e) {}
            } else {
                clearSavedAuth();
            }
            renderPanelContent();
            return;
        }

        if (s.passwordHash && hashed === s.passwordHash) {
            isUnlocked = true;
            isAuthorUnlocked = false;
            if (shouldRemember) {
                try { localStorage.setItem(getAuthStorageKey(s), "player"); } catch (e) {}
            } else {
                clearSavedAuth();
            }
            renderPanelContent();
            return;
        }

        if (errEl) errEl.textContent = "密码错误，无法解锁。";
    }

    function renderFateTab(bodyEl) {
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

        bodyEl.innerHTML = `
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">当前结局偏向百分比</span>
                    <button id="ps-reset-probs" class="ps-btn ps-btn-sm">均分重置</button>
                </div>
                ${probsHtml}
                <div class="ps-hint" style="margin-top:12px;">
                    每轮回复将根据当前对话与已有记忆重新判定各结局占比；若玩家修改了记忆或设定，后续轮次会自动按新事实重新计算。
                </div>
            </div>
        `;

        document.getElementById("ps-reset-probs").addEventListener("click", () => {
            if (!s.endings.length) return;
            const avg = Math.round(100 / s.endings.length);
            s.endings.forEach((e, idx) => {
                e.prob = idx === 0 ? 100 - avg * (s.endings.length - 1) : avg;
            });
            saveSettings();
            renderPanelContent();
        });
    }

    function renderEditTab(bodyEl) {
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
                    <span class="ps-label">1. 玩家防剧透密码（给玩家查看结局占比用，不可改大纲）</span>
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

        bodyEl.innerHTML = `
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
        `;

        if (!canEdit && s.authorPasswordHash) {
            const tryElevate = () => {
                const input = document.getElementById("ps-author-elevate-input");
                const err = document.getElementById("ps-author-elevate-err");
                if (hashPassword(input ? input.value : "") === s.authorPasswordHash) {
                    isAuthorUnlocked = true;
                    try { localStorage.setItem(getAuthStorageKey(s), "author"); } catch (e) {}
                    renderPanelContent();
                } else if (err) {
                    err.textContent = "作者密码错误。";
                }
            };
            document.getElementById("ps-author-elevate-btn").addEventListener("click", tryElevate);
            document.getElementById("ps-author-elevate-input").addEventListener("keydown", (e) => {
                if (e.key === "Enter") tryElevate();
            });
        }

        if (canEdit) {
            document.getElementById("ps-story-title").addEventListener("input", (e) => {
                s.storyTitle = e.target.value;
                saveSettings();
            });
            document.getElementById("ps-plotline").addEventListener("input", (e) => {
                s.plotline = e.target.value;
                saveSettings();
            });

            bodyEl.querySelectorAll(".ps-end-name").forEach(inp => {
                inp.addEventListener("input", () => {
                    s.endings[Number(inp.getAttribute("data-idx"))].name = inp.value;
                    saveSettings();
                });
            });

            bodyEl.querySelectorAll(".ps-end-desc").forEach(ta => {
                ta.addEventListener("input", () => {
                    s.endings[Number(ta.getAttribute("data-idx"))].desc = ta.value;
                    saveSettings();
                });
            });

            document.getElementById("ps-add-ending").addEventListener("click", () => {
                s.endings.push({ id: "end_" + Date.now(), name: `结局 ${s.endings.length + 1}`, desc: "", prob: 0 });
                saveSettings();
                renderPanelContent();
            });

            bodyEl.querySelectorAll(".ps-del-ending").forEach(btn => {
                btn.addEventListener("click", () => {
                    s.endings.splice(Number(btn.getAttribute("data-idx")), 1);
                    saveSettings();
                    renderPanelContent();
                });
            });

            document.getElementById("ps-set-password-btn").addEventListener("click", () => {
                const inp = document.getElementById("ps-new-password");
                const pwd = inp ? inp.value.trim() : "";
                if (!pwd) {
                    if (confirm("密码为空将清除玩家防剧透密码，确定吗？")) {
                        clearSavedAuth();
                        s.passwordHash = "";
                        saveSettings();
                        alert("已清除玩家密码。");
                        renderPanelContent();
                    }
                    return;
                }
                clearSavedAuth();
                s.passwordHash = hashPassword(pwd);
                saveSettings();
                if (inp) inp.value = "";
                alert("玩家防剧透密码已保存！");
                renderPanelContent();
            });

            document.getElementById("ps-set-author-password-btn").addEventListener("click", () => {
                const inp = document.getElementById("ps-new-author-password");
                const pwd = inp ? inp.value.trim() : "";
                if (!pwd) {
                    if (confirm("密码为空将清除作者管理密码，确定吗？")) {
                        clearSavedAuth();
                        s.authorPasswordHash = "";
                        saveSettings();
                        alert("已清除作者密码。");
                        renderPanelContent();
                    }
                    return;
                }
                clearSavedAuth();
                s.authorPasswordHash = hashPassword(pwd);
                saveSettings();
                if (inp) inp.value = "";
                alert("作者管理密码已保存！封印导出后凭此密码可随时解除只读编辑。");
                renderPanelContent();
            });
        }
    }

    function renderFooter(footerEl) {
        const s = getSettings();
        const canEdit = !s.isSealed || isAuthorUnlocked;
        const hasAnyPassword = Boolean(s.passwordHash || s.authorPasswordHash);

        footerEl.innerHTML = `
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
                    : `<button id="ps-reset-author" class="ps-btn ps-btn-danger ps-btn-sm">新建空白线</button>`
                }
            </div>
        `;

        document.getElementById("ps-toggle-enable").addEventListener("click", () => {
            s.enabled = !s.enabled;
            saveSettings();
            renderPanelContent();
        });

        const lockBtn = document.getElementById("ps-lock-now");
        if (lockBtn) {
            lockBtn.addEventListener("click", () => {
                clearSavedAuth();
                isUnlocked = false;
                isAuthorUnlocked = false;
                renderPanelContent();
            });
        }

        document.getElementById("ps-import-file").addEventListener("change", handleImportPackage);

        const exportBtn = document.getElementById("ps-export-sealed");
        if (exportBtn) {
            exportBtn.addEventListener("click", () => {
                if (!s.passwordHash && !s.authorPasswordHash) {
                    if (!confirm("你还没有设置任何密码，确定要导出无密码封包吗？")) return;
                }
                const pkg = {
                    version: "1.2",
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
        }

        const resetBtn = document.getElementById("ps-reset-author");
        if (resetBtn) {
            resetBtn.addEventListener("click", () => {
                if (!confirm("将清空当前封印包并回到空白作者模式，确定吗？")) return;
                clearSavedAuth();
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
    }

    function handleImportPackage(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
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

    /* =========================================
       可靠启动：监听消息接收、重说切换、编辑与切聊天
       ========================================= */
    function bindSillyTavernEvents() {
        if (eventsBound) return;
        const ctx = getContextSafe();
        if (ctx.eventSource && ctx.event_types) {
            const ev = ctx.event_types;
            if (ev.MESSAGE_RECEIVED) ctx.eventSource.on(ev.MESSAGE_RECEIVED, syncProbsFromCurrentMessage);
            if (ev.MESSAGE_SWIPED) ctx.eventSource.on(ev.MESSAGE_SWIPED, () => syncProbsFromCurrentMessage());
            if (ev.MESSAGE_EDITED) ctx.eventSource.on(ev.MESSAGE_EDITED, () => syncProbsFromCurrentMessage());
            if (ev.CHAT_CHANGED) ctx.eventSource.on(ev.CHAT_CHANGED, injectPlotPrompt);
            eventsBound = true;
            injectPlotPrompt();
        }
    }

    function start() {
        restoreSavedAuth();
        initUI();
        bindSillyTavernEvents();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }

    window.addEventListener("load", start);

    let retries = 0;
    const timer = setInterval(() => {
        retries++;
        const uiReady = initUI();
        bindSillyTavernEvents();
        if ((uiReady && eventsBound) || retries >= 15) {
            clearInterval(timer);
        }
    }, 600);
})();
