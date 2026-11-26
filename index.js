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
                        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                            <button id="ps-header-toggle" class="ps-btn ps-btn-sm" title="一键开启 / 暂停剧情掰正">● 已开启</button>
                            <button class="ps-close-btn" id="ps-close-btn">×</button>
                        </div>
                    </div>
                    <div id="ps-tabs-container"></div>
                    <div class="ps-body" id="ps-body"></div>
                    <div class="ps-footer" id="ps-footer"></div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML("beforeend", modalHtml);

        const triggerEl = document.getElementById("ps-floating-trigger");
        const headerToggleBtn = document.getElementById("ps-header-toggle");
        const closeBtn = document.getElementById("ps-close-btn");
        const overlayEl = document.getElementById("ps-modal-overlay");

        makeDraggable(triggerEl, toggleModal);

        headerToggleBtn.addEventListener("click", () => {
            const s = getSettings();
            s.enabled = !s.enabled;
            saveSettings();
            renderPanelContent();
        });

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
    function updateHeaderToggleUI(enabled) {
        const btn = document.getElementById("ps-header-toggle");
        if (!btn) return;
        if (enabled) {
            btn.textContent = "● 已开启";
            btn.style.background = "rgba(16, 185, 129, 0.2)";
            btn.style.borderColor = "rgba(110, 231, 183, 0.45)";
            btn.style.color = "#a7f3d0";
        } else {
            btn.textContent = "○ 已暂停";
            btn.style.background = "rgba(255, 255, 255, 0.06)";
            btn.style.borderColor = "rgba(255, 255, 255, 0.16)";
            btn.style.color = "rgba(255, 255, 255, 0.55)";
        }
    }

    function renderPanelContent() {
        const s = getSettings();
        const canEdit = !s.isSealed || isAuthorUnlocked;
        const badgeEl = document.getElementById("ps-mode-badge");
        const tabsEl = document.getElementById("ps-tabs-container");
        const bodyEl = document.getElementById("ps-body");
        const footerEl = document.getElementById("ps-footer");

        updateHeaderToggleUI(s.enabled);

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
                    <span class="ps-hint" style="margin:0;">右上角可随时一键开关</span>
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
            ? s.endings
