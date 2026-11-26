(() => {
    const MODULE_NAME = "st_plot_steering";
    const PROMPT_KEY = "st_plot_steering_prompt";

    function createBlankProfile(title = "未命名剧情线") {
        return {
            id: "pkg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
            storyTitle: title,
            plotline: "",
            endings: [
                { id: "end_1", name: "结局 A", desc: "", prob: 0 },
                { id: "end_2", name: "结局 B", desc: "", prob: 0 }
            ],
            passwordHash: "",
            authorPasswordHash: "",
            isSealed: false,
            updatedAt: Date.now()
        };
    }

    // 每个封包在当前浏览器会话中的解锁状态（互不干扰）
    const sessionAuthMap = {};
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

    /* =========================================
       多存档封包库管理（自动迁移旧版单条数据）
       ========================================= */
    function getStore() {
        const ctx = getContextSafe();
        const extSettings = ctx.extensionSettings || (window._psFallbackSettings = window._psFallbackSettings || {});

        if (!extSettings[MODULE_NAME]) {
            const first = createBlankProfile();
            extSettings[MODULE_NAME] = {
                enabled: true,
                activeProfileId: first.id,
                profiles: [first]
            };
        }

        const root = extSettings[MODULE_NAME];

        // 兼容迁移旧版数据结构
        if (!Array.isArray(root.profiles)) {
            const migrated = {
                id: "pkg_migrated_" + Date.now(),
                storyTitle: root.storyTitle || "未命名剧情线",
                plotline: root.plotline || "",
                endings: Array.isArray(root.endings) && root.endings.length
                    ? root.endings.map(e => ({
                        id: e.id || ("end_" + Date.now()),
                        name: e.name || "未命名结局",
                        desc: e.desc || "",
                        prob: typeof e.prob === "number" ? e.prob : 0
                    }))
                    : [
                        { id: "end_1", name: "结局 A", desc: "", prob: 0 },
                        { id: "end_2", name: "结局 B", desc: "", prob: 0 }
                    ],
                passwordHash: root.passwordHash || "",
                authorPasswordHash: root.authorPasswordHash || "",
                isSealed: Boolean(root.isSealed),
                updatedAt: Date.now()
            };
            root.enabled = typeof root.enabled === "boolean" ? root.enabled : true;
            root.profiles = [migrated];
            root.activeProfileId = migrated.id;
            delete root.storyTitle;
            delete root.plotline;
            delete root.endings;
            delete root.passwordHash;
            delete root.authorPasswordHash;
            delete root.isSealed;
        }

        if (root.profiles.length === 0) {
            const blank = createBlankProfile();
            root.profiles.push(blank);
            root.activeProfileId = blank.id;
        }

        if (!root.profiles.some(p => p.id === root.activeProfileId)) {
            root.activeProfileId = root.profiles[0].id;
        }

        return root;
    }

    function getActiveProfile() {
        const store = getStore();
        let profile = store.profiles.find(p => p.id === store.activeProfileId);
        if (!profile) {
            profile = store.profiles[0];
            store.activeProfileId = profile.id;
        }
        if (typeof profile.authorPasswordHash === "undefined") profile.authorPasswordHash = "";
        if (!Array.isArray(profile.endings) || profile.endings.length === 0) {
            profile.endings = [
                { id: "end_1", name: "结局 A", desc: "", prob: 0 },
                { id: "end_2", name: "结局 B", desc: "", prob: 0 }
            ];
        }
        return profile;
    }

    function saveSettings() {
        try {
            const profile = getActiveProfile();
            profile.updatedAt = Date.now();
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
       按封包独立的「记住密码」状态
       ========================================= */
    function getAuthStorageKey(p) {
        return `ps_remember_${p.id}_${p.passwordHash || "none"}_${p.authorPasswordHash || "none"}`;
    }

    function getProfileAuth(p) {
        const hasAnyPassword = Boolean(p.passwordHash || p.authorPasswordHash);
        if (!hasAnyPassword) {
            return { isUnlocked: true, isAuthorUnlocked: true };
        }

        if (sessionAuthMap[p.id]) {
            return sessionAuthMap[p.id];
        }

        try {
            const saved = localStorage.getItem(getAuthStorageKey(p));
            if (saved === "author" && p.authorPasswordHash) {
                sessionAuthMap[p.id] = { isUnlocked: true, isAuthorUnlocked: true };
                return sessionAuthMap[p.id];
            }
            if (saved === "player" && p.passwordHash) {
                sessionAuthMap[p.id] = { isUnlocked: true, isAuthorUnlocked: false };
                return sessionAuthMap[p.id];
            }
        } catch (e) {}

        return { isUnlocked: false, isAuthorUnlocked: false };
    }

    function setProfileAuth(p, isUnlocked, isAuthorUnlocked, remember) {
        sessionAuthMap[p.id] = { isUnlocked, isAuthorUnlocked };
        try {
            if (remember && isUnlocked) {
                localStorage.setItem(getAuthStorageKey(p), isAuthorUnlocked ? "author" : "player");
            } else {
                localStorage.removeItem(getAuthStorageKey(p));
            }
        } catch (e) {}
    }

    function clearProfileAuth(p) {
        delete sessionAuthMap[p.id];
        try {
            localStorage.removeItem(getAuthStorageKey(p));
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
        const p = getActiveProfile();
        let changed = false;
        p.endings.forEach(e => {
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
            const store = getStore();
            if (!store.enabled) return;

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
       核心：向 AI 注入当前启用封包的大纲与结局占比指令
       ========================================= */
    function injectPlotPrompt() {
        try {
            const ctx = getContextSafe();
            if (typeof ctx.setExtensionPrompt !== "function") return;

            const store = getStore();
            const p = getActiveProfile();
            const promptType = ctx.extension_prompt_types ? ctx.extension_prompt_types.IN_PROMPT : 1;

            if (!store.enabled || (!p.plotline.trim() && p.endings.length === 0)) {
                ctx.setExtensionPrompt(PROMPT_KEY, "", promptType, 0);
                return;
            }

            const endingsText = p.endings
                .map((e, i) => `${i + 1}. [ID:${e.id}] ${e.name}（当前偏向 ${e.prob}%）：${e.desc || "无详细描述"}`)
                .join("\n");

            const promptText = [
                "[系统隐藏指令：剧情大纲与结局占比掰正系统]",
                "你必须在保持角色扮演自然流畅的前提下，严格遵循以下主线大纲与结局设定。请结合当前对话历史与已有记忆/设定判断当前进度：已经发生或已经完成的剧情与线索直接跳过，绝不重复触发，顺着当前进度自然往后推进；若玩家做出重大反转或改变了既有记忆事实，请根据最新事实重新评估并调整各结局偏向（所有结局初始均为 0%，随剧情触发逐步增加，各结局总和不超过 100%）。",
                "",
                "【主线大纲】",
                p.plotline || "（未设定）",
                "",
                "【预设结局分支】",
                endingsText,
                "",
                "【强制输出格式】",
                "在每次回复的最末尾，必须附加一个隐藏的 JSON 判定块，严格使用 <plot_steer> 和 </plot_steer> 包裹（不要套用代码块），只输出各结局当前百分比（初始为 0，总和不超过 100）：",
                "<plot_steer>",
                "{",
                `  "probs": { ${p.endings.map(e => `"${e.id}": ${e.prob}`).join(", ")} }`,
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
            const store = getStore();
            store.enabled = !store.enabled;
            saveSettings();
            renderPanelContent();
        });

        closeBtn.addEventListener("click", closeModal);
        overlayEl.addEventListener("click", (e) => {
            if (e.target === overlayEl) closeModal();
        });

        return true;
    }

    /* =========================================
       0 延迟丝滑跟手拖拽（GPU translate3d 硬件加速）
       ========================================= */
    function makeDraggable(el, onClick) {
        let isDragging = false;
        let moved = false;
        let startX = 0, startY = 0;
        let baseTop = 120, baseRight = 28;
        let curDx = 0, curDy = 0;
        let lastTouchTime = 0;

        const onStart = (e) => {
            if (e.type === "mousedown" && Date.now() - lastTouchTime < 500) return;
            if (e.type === "touchstart") lastTouchTime = Date.now();

            isDragging = true;
            moved = false;
            curDx = 0;
            curDy = 0;

            const point = e.touches ? e.touches[0] : e;
            startX = point.clientX;
            startY = point.clientY;

            const rect = el.getBoundingClientRect();
            baseTop = rect.top;
            baseRight = window.innerWidth - rect.right;
        };

        const onMove = (e) => {
            if (!isDragging) return;
            if (document.body.classList.contains("ps-modal-active")) return;

            const point = e.touches ? e.touches[0] : e;
            const rawDx = point.clientX - startX;
            const rawDy = point.clientY - startY;

            if (!moved && (Math.abs(rawDx) > 5 || Math.abs(rawDy) > 5)) {
                moved = true;
                el.classList.add("ps-dragging");
            }

            if (moved) {
                if (e.cancelable) e.preventDefault();
                const w = el.offsetWidth || 48;
                const h = el.offsetHeight || 48;
                const minDx = -(window.innerWidth - baseRight - w - 8);
                const maxDx = baseRight - 8;
                const minDy = -(baseTop - 8);
                const maxDy = window.innerHeight - baseTop - h - 8;

                curDx = Math.max(minDx, Math.min(maxDx, rawDx));
                curDy = Math.max(minDy, Math.min(maxDy, rawDy));
                el.style.transform = `translate3d(${curDx}px, ${curDy}px, 0)`;
            }
        };

        const onEnd = (e) => {
            if (e.type === "mouseup" && Date.now() - lastTouchTime < 500) return;
            if (e.type === "touchend") lastTouchTime = Date.now();

            if (!isDragging) return;
            isDragging = false;

            if (moved) {
                el.style.top = (baseTop + curDy) + "px";
                el.style.right = (baseRight - curDx) + "px";
                el.style.transform = "";
                requestAnimationFrame(() => {
                    el.classList.remove("ps-dragging");
                });
            } else {
                el.classList.remove("ps-dragging");
                if (onClick) {
                    if (e.cancelable) e.preventDefault();
                    onClick();
                }
            }
        };

        el.addEventListener("mousedown", onStart);
        el.addEventListener("touchstart", onStart, { passive: true });
        window.addEventListener("mousemove", onMove, { passive: false });
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("mouseup", onEnd);
        window.addEventListener("touchend", onEnd, { passive: false });
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
        const store = getStore();
        const p = getActiveProfile();
        const auth = getProfileAuth(p);
        const canEdit = !p.isSealed || auth.isAuthorUnlocked;
        const badgeEl = document.getElementById("ps-mode-badge");
        const tabsEl = document.getElementById("ps-tabs-container");
        const bodyEl = document.getElementById("ps-body");
        const footerEl = document.getElementById("ps-footer");

        updateHeaderToggleUI(store.enabled);

        if (p.isSealed) {
            badgeEl.textContent = auth.isAuthorUnlocked ? "已封印 · 作者已提权" : "已封印 · 防剧透包";
            badgeEl.classList.add("ps-sealed");
        } else {
            badgeEl.textContent = "作者编辑模式";
            badgeEl.classList.remove("ps-sealed");
        }

        const hasAnyPassword = Boolean(p.passwordHash || p.authorPasswordHash);

        // 锁定状态：仍允许切换到「封包列表」查看/切换其他已存封包
        if (hasAnyPassword && !auth.isUnlocked) {
            tabsEl.innerHTML = `
                <div class="ps-tabs">
                    <div class="ps-tab ${activeTab !== "library" ? "ps-active" : ""}" data-tab="fate">🔒 解锁当前封包</div>
                    <div class="ps-tab ${activeTab === "library" ? "ps-active" : ""}" data-tab="library">已存封包 (${store.profiles.length})</div>
                </div>
            `;

            tabsEl.querySelectorAll(".ps-tab").forEach(tab => {
                tab.addEventListener("click", () => {
                    activeTab = tab.getAttribute("data-tab");
                    renderPanelContent();
                });
            });

            if (activeTab === "library") {
                renderLibraryTab(bodyEl);
                renderFooter(footerEl, false);
                return;
            }

            bodyEl.innerHTML = `
                <div class="ps-lock-screen">
                    <div class="ps-lock-icon">🔒</div>
                    <div style="font-size:15px;font-weight:500;">${escapeHtml(p.storyTitle)}</div>
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

            renderFooter(footerEl, false);

            document.getElementById("ps-unlock-btn").addEventListener("click", attemptUnlock);
            document.getElementById("ps-unlock-input").addEventListener("keydown", (e) => {
                if (e.key === "Enter") attemptUnlock();
            });
            return;
        }

        tabsEl.innerHTML = `
            <div class="ps-tabs">
                <div class="ps-tab ${activeTab === "fate" ? "ps-active" : ""}" data-tab="fate">结局偏向占比</div>
                <div class="ps-tab ${activeTab === "edit" ? "ps-active" : ""}" data-tab="edit">${canEdit ? "大纲与结局" : "大纲(只读)"}</div>
                <div class="ps-tab ${activeTab === "library" ? "ps-active" : ""}" data-tab="library">已存封包 (${store.profiles.length})</div>
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
        } else if (activeTab === "edit") {
            renderEditTab(bodyEl);
        } else {
            renderLibraryTab(bodyEl);
        }

        renderFooter(footerEl, true);
    }

    function attemptUnlock() {
        const p = getActiveProfile();
        const inputEl = document.getElementById("ps-unlock-input");
        const errEl = document.getElementById("ps-unlock-error");
        const rememberEl = document.getElementById("ps-remember-pwd");
        const shouldRemember = rememberEl ? rememberEl.checked : false;
        const hashed = hashPassword(inputEl ? inputEl.value : "");

        if (p.authorPasswordHash && hashed === p.authorPasswordHash) {
            setProfileAuth(p, true, true, shouldRemember);
            renderPanelContent();
            return;
        }

        if (p.passwordHash && hashed === p.passwordHash) {
            setProfileAuth(p, true, false, shouldRemember);
            renderPanelContent();
            return;
        }

        if (errEl) errEl.textContent = "密码错误，无法解锁。";
    }

    function renderFateTab(bodyEl) {
        const p = getActiveProfile();

        const probsHtml = p.endings.length
            ? p.endings.map(e => `
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
                    <span class="ps-label">当前封包：${escapeHtml(p.storyTitle)}</span>
                    <button id="ps-reset-probs" class="ps-btn ps-btn-sm">清零重置</button>
                </div>
                ${probsHtml}
                <div class="ps-hint" style="margin-top:12px;">
                    所有结局初始默认 0%，每轮回复将根据当前对话与已有记忆重新判定各结局占比；切换到其他封包时，当前封包的进度会自动独立保存。
                </div>
            </div>
        `;

        document.getElementById("ps-reset-probs").addEventListener("click", () => {
            if (!p.endings.length) return;
            p.endings.forEach(e => {
                e.prob = 0;
            });
            saveSettings();
            renderPanelContent();
        });
    }

    function renderEditTab(bodyEl) {
        const p = getActiveProfile();
        const auth = getProfileAuth(p);
        const canEdit = !p.isSealed || auth.isAuthorUnlocked;
        const disabledAttr = canEdit ? "" : "disabled";

        const endingsEditorHtml = p.endings.map((e, idx) => `
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
            const elevateBox = p.authorPasswordHash
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
                    <input type="password" id="ps-new-password" class="ps-input" placeholder="${p.passwordHash ? "已设置玩家密码（输入新密码可覆盖）" : "设置玩家解锁密码..."}" />
                    <button id="ps-set-password-btn" class="ps-btn">保存玩家密码</button>
                </div>
            </div>
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">2. 作者管理密码（仅作者本人保留，封印后也可解锁编辑）</span>
                </div>
                <div class="ps-input-row" style="max-width:100%;">
                    <input type="password" id="ps-new-author-password" class="ps-input" placeholder="${p.authorPasswordHash ? "已设置作者密码（输入新密码可覆盖）" : "设置作者管理密码..."}" />
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
                <input type="text" id="ps-story-title" class="ps-input" value="${escapeHtml(p.storyTitle)}" placeholder="输入剧情线名称..." ${disabledAttr} />
            </div>
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">主线剧情大纲（随每次聊天发送给 AI）</span>
                </div>
                <textarea id="ps-plotline" class="ps-textarea" placeholder="输入核心世界观、主线脉络、关键转折点..." ${disabledAttr}>${escapeHtml(p.plotline)}</textarea>
            </div>
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">结局分支设定（共 ${p.endings.length} 个，默认均从 0% 起步）</span>
                    ${canEdit ? `<button id="ps-add-ending" class="ps-btn ps-btn-sm">+ 添加结局</button>` : ""}
                </div>
                <div id="ps-endings-list">${endingsEditorHtml}</div>
            </div>
            ${passwordSectionHtml}
        `;

        if (!canEdit && p.authorPasswordHash) {
            const tryElevate = () => {
                const input = document.getElementById("ps-author-elevate-input");
                const err = document.getElementById("ps-author-elevate-err");
                if (hashPassword(input ? input.value : "") === p.authorPasswordHash) {
                    setProfileAuth(p, true, true, true);
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
                p.storyTitle = e.target.value;
                saveSettings();
            });
            document.getElementById("ps-plotline").addEventListener("input", (e) => {
                p.plotline = e.target.value;
                saveSettings();
            });

            bodyEl.querySelectorAll(".ps-end-name").forEach(inp => {
                inp.addEventListener("input", () => {
                    p.endings[Number(inp.getAttribute("data-idx"))].name = inp.value;
                    saveSettings();
                });
            });

            bodyEl.querySelectorAll(".ps-end-desc").forEach(ta => {
                ta.addEventListener("input", () => {
                    p.endings[Number(ta.getAttribute("data-idx"))].desc = ta.value;
                    saveSettings();
                });
            });

            document.getElementById("ps-add-ending").addEventListener("click", () => {
                p.endings.push({ id: "end_" + Date.now(), name: `结局 ${p.endings.length + 1}`, desc: "", prob: 0 });
                saveSettings();
                renderPanelContent();
            });

            bodyEl.querySelectorAll(".ps-del-ending").forEach(btn => {
                btn.addEventListener("click", () => {
                    p.endings.splice(Number(btn.getAttribute("data-idx")), 1);
                    saveSettings();
                    renderPanelContent();
                });
            });

            document.getElementById("ps-set-password-btn").addEventListener("click", () => {
                const inp = document.getElementById("ps-new-password");
                const pwd = inp ? inp.value.trim() : "";
                if (!pwd) {
                    if (confirm("密码为空将清除玩家防剧透密码，确定吗？")) {
                        clearProfileAuth(p);
                        p.passwordHash = "";
                        saveSettings();
                        alert("已清除玩家密码。");
                        renderPanelContent();
                    }
                    return;
                }
                clearProfileAuth(p);
                p.passwordHash = hashPassword(pwd);
                setProfileAuth(p, true, true, true);
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
                        clearProfileAuth(p);
                        p.authorPasswordHash = "";
                        saveSettings();
                        alert("已清除作者密码。");
                        renderPanelContent();
                    }
                    return;
                }
                clearProfileAuth(p);
                p.authorPasswordHash = hashPassword(pwd);
                setProfileAuth(p, true, true, true);
                saveSettings();
                if (inp) inp.value = "";
                alert("作者管理密码已保存！封印导出后凭此密码可随时解除只读编辑。");
                renderPanelContent();
            });
        }
    }

    /* =========================================
       已导入 / 已存剧情封包列表（多存档自由切换）
       ========================================= */
    function renderLibraryTab(bodyEl) {
        const store = getStore();
        const activeId = store.activeProfileId;

        const listHtml = store.profiles.map(item => {
            const isActive = item.id === activeId;
            const probsSummary = item.endings.map(e => `${escapeHtml(e.name)} ${e.prob}%`).join(" · ");
            const lockBadge = (item.passwordHash || item.authorPasswordHash) ? "🔒" : "🔓";
            const typeBadge = item.isSealed ? "封印包" : "草稿/自建";

            return `
                <div class="ps-pkg-card ${isActive ? "ps-pkg-active" : ""}">
                    <div class="ps-pkg-info">
                        <div class="ps-pkg-title">
                            <span>${lockBadge} ${escapeHtml(item.storyTitle || "未命名剧情线")}</span>
                            <span class="ps-badge ${item.isSealed ? "ps-sealed" : ""}">${typeBadge}</span>
                            ${isActive ? `<span class="ps-badge" style="background:rgba(16,185,129,0.22);color:#a7f3d0;border-color:rgba(110,231,183,0.4);">当前启用</span>` : ""}
                        </div>
                        <div class="ps-pkg-meta">
                            进度存档：${probsSummary || "暂无结局"}
                        </div>
                    </div>
                    <div class="ps-pkg-actions">
                        ${!isActive ? `<button class="ps-btn ps-btn-primary ps-btn-sm ps-switch-pkg" data-id="${escapeHtml(item.id)}">切换使用</button>` : ""}
                        <button class="ps-btn ps-btn-danger ps-btn-sm ps-del-pkg" data-id="${escapeHtml(item.id)}">删除</button>
                    </div>
                </div>
            `;
        }).join("");

        bodyEl.innerHTML = `
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">已存剧情封包列表（独立保存各自进度）</span>
                    <button id="ps-new-blank-pkg" class="ps-btn ps-btn-sm">+ 新建空白线</button>
                </div>
                ${listHtml}
                <div class="ps-hint">
                    导入新封包时会自动加入此列表并保留旧封包进度；随时点击「切换使用」即可切回任意一条剧情线继续游玩。
                </div>
            </div>
        `;

        document.getElementById("ps-new-blank-pkg").addEventListener("click", () => {
            const blank = createBlankProfile(`新剧情线 #${store.profiles.length + 1}`);
            store.profiles.unshift(blank);
            store.activeProfileId = blank.id;
            activeTab = "edit";
            saveSettings();
            renderPanelContent();
        });

        bodyEl.querySelectorAll(".ps-switch-pkg").forEach(btn => {
            btn.addEventListener("click", () => {
                const targetId = btn.getAttribute("data-id");
                if (store.profiles.some(item => item.id === targetId)) {
                    store.activeProfileId = targetId;
                    activeTab = "fate";
                    saveSettings();
                    renderPanelContent();
                }
            });
        });

        bodyEl.querySelectorAll(".ps-del-pkg").forEach(btn => {
            btn.addEventListener("click", () => {
                const targetId = btn.getAttribute("data-id");
                const target = store.profiles.find(item => item.id === targetId);
                if (!target) return;
                if (!confirm(`确定要删除封包「${target.storyTitle}」及其进度存档吗？`)) return;

                clearProfileAuth(target);
                store.profiles = store.profiles.filter(item => item.id !== targetId);
                if (store.profiles.length === 0) {
                    const blank = createBlankProfile();
                    store.profiles.push(blank);
                }
                if (store.activeProfileId === targetId) {
                    store.activeProfileId = store.profiles[0].id;
                }
                saveSettings();
                renderPanelContent();
            });
        });
    }

    function renderFooter(footerEl, isUnlockedState) {
        const p = getActiveProfile();
        const auth = getProfileAuth(p);
        const canEdit = !p.isSealed || auth.isAuthorUnlocked;
        const hasAnyPassword = Boolean(p.passwordHash || p.authorPasswordHash);

        footerEl.innerHTML = `
            <div class="ps-footer-group">
                ${(isUnlockedState && hasAnyPassword) ? `<button id="ps-lock-now" class="ps-btn ps-btn-sm">立即锁定</button>` : ""}
                <label class="ps-btn ps-btn-sm" style="cursor:pointer;">
                    + 导入新封包
                    <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
                </label>
            </div>
            <div class="ps-footer-group">
                ${(isUnlockedState && canEdit)
                    ? `<button id="ps-export-sealed" class="ps-btn ps-btn-primary ps-btn-sm">导出加密封包</button>`
                    : `<span class="ps-hint" style="margin:0;">旧封包进度已自动存档</span>`
                }
            </div>
        `;

        const lockBtn = document.getElementById("ps-lock-now");
        if (lockBtn) {
            lockBtn.addEventListener("click", () => {
                clearProfileAuth(p);
                renderPanelContent();
            });
        }

        document.getElementById("ps-import-file").addEventListener("change", handleImportPackage);

        const exportBtn = document.getElementById("ps-export-sealed");
        if (exportBtn) {
            exportBtn.addEventListener("click", () => {
                if (!p.passwordHash && !p.authorPasswordHash) {
                    if (!confirm("你还没有设置任何密码，确定要导出无密码封包吗？")) return;
                }
                const pkg = {
                    version: "1.3",
                    isSealed: true,
                    storyTitle: p.storyTitle,
                    plotline: p.plotline,
                    endings: p.endings.map(e => ({ ...e, prob: 0 })),
                    passwordHash: p.passwordHash,
                    authorPasswordHash: p.authorPasswordHash
                };
                const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${p.storyTitle || "plot"}_sealed.json`;
                a.click();
                URL.revokeObjectURL(url);
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
                const store = getStore();
                const importedProfile = {
                    id: "pkg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
                    storyTitle: pkg.storyTitle || "导入的剧情线",
                    plotline: pkg.plotline,
                    endings: pkg.endings.map(item => ({
                        id: item.id || ("end_" + Date.now()),
                        name: item.name || "未命名结局",
                        desc: item.desc || "",
                        prob: 0
                    })),
                    passwordHash: pkg.passwordHash || "",
                    authorPasswordHash: pkg.authorPasswordHash || "",
                    isSealed: true,
                    updatedAt: Date.now()
                };

                // 不覆盖旧封包，直接新增一条存档并切换过去
                store.profiles.unshift(importedProfile);
                store.activeProfileId = importedProfile.id;
                activeTab = "fate";
                saveSettings();
                renderPanelContent();
                alert(`封包「${importedProfile.storyTitle}」已导入并加入封包列表！旧封包的进度已完整保留。`);
            } catch (err) {
                alert("读取封包失败，请检查 JSON 格式。");
            }
        };
        reader.readAsText(file);
        e.target.value = "";
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
