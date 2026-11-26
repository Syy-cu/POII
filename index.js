(() => {
    const MODULE_NAME = "st_plot_steering";
    const PROMPT_KEY = "st_plot_steering_prompt";

    function createBlankPackage(title = "未命名剧情线") {
        const ts = Date.now();
        return {
            id: "pkg_" + ts + "_" + Math.floor(Math.random() * 1000),
            storyTitle: title,
            plotline: "",
            endings: [
                { id: "end_1", name: "结局 A", desc: "", prob: 0 },
                { id: "end_2", name: "结局 B", desc: "", prob: 0 }
            ],
            passwordHash: "",
            authorPasswordHash: "",
            isSealed: false
        };
    }

    let isUnlocked = false;
    let isAuthorUnlocked = false;
    let activeTab = "fate";
    let pkgDrawerOpen = false;
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
       多封包存档数据结构（兼容旧版自动迁移）
       ========================================= */
    function getRootSettings() {
        const ctx = getContextSafe();
        const extSettings = ctx.extensionSettings || (window._psFallbackSettings = window._psFallbackSettings || {});
        if (!extSettings[MODULE_NAME]) {
            const firstPkg = createBlankPackage();
            extSettings[MODULE_NAME] = {
                enabled: true,
                activePackageId: firstPkg.id,
                packages: [firstPkg]
            };
        }

        const root = extSettings[MODULE_NAME];

        // 兼容旧版单剧情线结构，自动迁入封包列表
        if (!Array.isArray(root.packages)) {
            const migrated = {
                id: "pkg_migrated",
                storyTitle: root.storyTitle || "未命名剧情线",
                plotline: root.plotline || "",
                endings: Array.isArray(root.endings) && root.endings.length
                    ? root.endings
                    : [
                        { id: "end_1", name: "结局 A", desc: "", prob: 0 },
                        { id: "end_2", name: "结局 B", desc: "", prob: 0 }
                    ],
                passwordHash: root.passwordHash || "",
                authorPasswordHash: root.authorPasswordHash || "",
                isSealed: Boolean(root.isSealed)
            };
            root.packages = [migrated];
            root.activePackageId = migrated.id;
            if (typeof root.enabled !== "boolean") root.enabled = true;
        }

        if (root.packages.length === 0) {
            const blank = createBlankPackage();
            root.packages.push(blank);
            root.activePackageId = blank.id;
        }

        if (!root.packages.some(p => p.id === root.activePackageId)) {
            root.activePackageId = root.packages[0].id;
        }

        return root;
    }

    function getActivePackage() {
        const root = getRootSettings();
        const pkg = root.packages.find(p => p.id === root.activePackageId) || root.packages[0];
        if (typeof pkg.authorPasswordHash === "undefined") pkg.authorPasswordHash = "";
        if (!Array.isArray(pkg.endings) || pkg.endings.length === 0) {
            pkg.endings = [
                { id: "end_1", name: "结局 A", desc: "", prob: 0 },
                { id: "end_2", name: "结局 B", desc: "", prob: 0 }
            ];
        }
        return pkg;
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
       记住密码（按封包独立存储）
       ========================================= */
    function getAuthStorageKey(pkg) {
        return "ps_remember_" + pkg.id + "_" + (pkg.passwordHash || "none") + "_" + (pkg.authorPasswordHash || "none");
    }

    function restoreSavedAuth() {
        try {
            const pkg = getActivePackage();
            const hasAnyPwd = Boolean(pkg.passwordHash || pkg.authorPasswordHash);
            if (!hasAnyPwd) {
                isUnlocked = true;
                isAuthorUnlocked = !pkg.isSealed;
                return;
            }
            isUnlocked = false;
            isAuthorUnlocked = false;
            const saved = localStorage.getItem(getAuthStorageKey(pkg));
            if (saved === "author" && pkg.authorPasswordHash) {
                isUnlocked = true;
                isAuthorUnlocked = true;
            } else if (saved === "player" && pkg.passwordHash) {
                isUnlocked = true;
                isAuthorUnlocked = false;
            }
        } catch (e) {}
    }

    function clearSavedAuth() {
        try {
            const pkg = getActivePackage();
            localStorage.removeItem(getAuthStorageKey(pkg));
        } catch (e) {}
    }

    function switchPackage(pkgId) {
        const root = getRootSettings();
        if (!root.packages.some(p => p.id === pkgId)) return;
        root.activePackageId = pkgId;
        pkgDrawerOpen = false;
        activeTab = "fate";
        restoreSavedAuth();
        saveSettings();
        renderPanelContent();
    }

    function deletePackage(pkgId) {
        const root = getRootSettings();
        const target = root.packages.find(p => p.id === pkgId);
        if (!target) return;
        if (!confirm(`确定要删除存档「${target.storyTitle || "未命名剧情线"}」吗？删除后无法恢复。`)) return;

        root.packages = root.packages.filter(p => p.id !== pkgId);
        if (root.packages.length === 0) {
            const blank = createBlankPackage();
            root.packages.push(blank);
            root.activePackageId = blank.id;
        } else if (root.activePackageId === pkgId) {
            root.activePackageId = root.packages[0].id;
        }

        restoreSavedAuth();
        saveSettings();
        renderPanelContent();
    }

    /* =========================================
       解析当前消息中的结局分数
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
        const pkg = getActivePackage();
        let changed = false;
        pkg.endings.forEach(e => {
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
            const root = getRootSettings();
            if (!root.enabled) return;

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
       核心：向 AI 注入当前选中封包的大纲与单结局累加规则
       ========================================= */
    function injectPlotPrompt() {
        try {
            const ctx = getContextSafe();
            if (typeof ctx.setExtensionPrompt !== "function") return;

            const root = getRootSettings();
            const pkg = getActivePackage();
            const promptType = ctx.extension_prompt_types ? ctx.extension_prompt_types.IN_PROMPT : 1;

            if (!root.enabled || (!pkg.plotline.trim() && pkg.endings.length === 0)) {
                ctx.setExtensionPrompt(PROMPT_KEY, "", promptType, 0);
                return;
            }

            const endingsText = pkg.endings
                .map((e, i) => `${i + 1}. [ID:${e.id}] ${e.name}（当前偏向进度 ${e.prob}%）：${e.desc || "无详细描述"}`)
                .join("\n");

            const promptText = [
                "[系统隐藏指令：剧情大纲与结局累加判定系统]",
                "你必须在保持角色扮演自然流畅的前提下，严格遵循以下主线大纲与结局设定。请结合当前对话历史与已有记忆/设定判断当前进度：已经发生或已经完成的剧情与线索直接跳过，绝不重复触发，顺着当前进度自然往后推进。",
                "",
                "【主线大纲】",
                pkg.plotline || "（未设定）",
                "",
                "【预设结局分支（初始均为 0%）】",
                endingsText,
                "",
                "【结局判定与加分铁律】",
                "1. 所有结局初始为 0%，各自独立累加，不需要总和为 100%。",
                "2. 每轮回复，请判断本轮剧情最偏向哪一个结局，【每次只能给这 1 个最偏向的结局增加数值】（根据剧情权重增加 5~15，上限 100），其他结局数值保持原样不变；若本轮纯日常无偏向，则全部保持不变。",
                "3. 当剧情推进至终局阶段时，请以【当前数值最高】的那个结局作为最终走向并收束剧情。",
                "",
                "【强制输出格式】",
                "在每次回复的最末尾，必须附加一个隐藏的 JSON 判定块，严格使用 <plot_steer> 和 </plot_steer> 包裹（不要套用代码块），输出更新后的各结局数值：",
                "<plot_steer>",
                "{",
                `  "probs": { ${pkg.endings.map(e => `"${e.id}": ${e.prob}`).join(", ")} }`,
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
                    <div id="ps-pkg-bar-container"></div>
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
            const root = getRootSettings();
            root.enabled = !root.enabled;
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

    function renderPackageBar(containerEl) {
        const root = getRootSettings();
        const activePkg = getActivePackage();

        let drawerHtml = "";
        if (pkgDrawerOpen) {
            const listHtml = root.packages.map(p => {
                const isActive = p.id === activePkg.id;
                const isLockedPkg = Boolean(p.passwordHash || p.authorPasswordHash);
                const maxEnd = (p.endings || []).reduce((best, cur) => (cur.prob > (best ? best.prob : -1) ? cur : best), null);
                const metaText = p.isSealed
                    ? (isLockedPkg ? "封印封包 · 🔒 加密存档" : "封印封包")
                    : (maxEnd && maxEnd.prob > 0 ? `自建 · 领先：${escapeHtml(maxEnd.name)} (${maxEnd.prob}%)` : "自建 · 初始 0%");

                return `
                    <div class="ps-pkg-item ${isActive ? "ps-pkg-active" : ""}" data-pkg-id="${escapeHtml(p.id)}">
                        <div class="ps-pkg-item-info">
                            <div class="ps-pkg-item-title">${isActive ? "▸ " : ""}${escapeHtml(p.storyTitle || "未命名剧情线")}</div>
                            <div class="ps-pkg-item-meta">${metaText}</div>
                        </div>
                        <button class="ps-btn ps-btn-danger ps-btn-sm ps-del-pkg-btn" data-pkg-id="${escapeHtml(p.id)}">删除</button>
                    </div>
                `;
            }).join("");

            drawerHtml = `
                <div class="ps-pkg-drawer">
                    <div class="ps-pkg-list">${listHtml}</div>
                    <div class="ps-pkg-drawer-actions">
                        <button id="ps-new-blank-pkg" class="ps-btn ps-btn-sm">+ 新建空白线</button>
                        <label class="ps-btn ps-btn-primary ps-btn-sm" style="cursor:pointer;">
                            + 导入新封包
                            <input type="file" id="ps-drawer-import-file" accept=".json" style="display:none;" />
                        </label>
                    </div>
                </div>
            `;
        }

        containerEl.innerHTML = `
            <div class="ps-pkg-bar">
                <div class="ps-pkg-current">
                    <span style="opacity:0.6;flex-shrink:0;">当前存档：</span>
                    <span class="ps-pkg-current-name">${escapeHtml(activePkg.storyTitle || "未命名剧情线")}</span>
                </div>
                <button id="ps-toggle-pkg-drawer" class="ps-btn ps-btn-sm">
                    封包列表 (${root.packages.length}) ${pkgDrawerOpen ? "▲" : "▼"}
                </button>
            </div>
            ${drawerHtml}
        `;

        document.getElementById("ps-toggle-pkg-drawer").addEventListener("click", () => {
            pkgDrawerOpen = !pkgDrawerOpen;
            renderPanelContent();
        });

        if (pkgDrawerOpen) {
            containerEl.querySelectorAll(".ps-pkg-item").forEach(item => {
                item.addEventListener("click", (e) => {
                    if (e.target.closest(".ps-del-pkg-btn")) return;
                    const id = item.getAttribute("data-pkg-id");
                    switchPackage(id);
                });
            });

            containerEl.querySelectorAll(".ps-del-pkg-btn").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    deletePackage(btn.getAttribute("data-pkg-id"));
                });
            });

            document.getElementById("ps-new-blank-pkg").addEventListener("click", () => {
                const blank = createBlankPackage(`新剧情线 ${root.packages.length + 1}`);
                root.packages.push(blank);
                root.activePackageId = blank.id;
                pkgDrawerOpen = false;
                activeTab = "edit";
                isUnlocked = true;
                isAuthorUnlocked = true;
                saveSettings();
                renderPanelContent();
            });

            document.getElementById("ps-drawer-import-file").addEventListener("change", handleImportPackage);
        }
    }

    function renderPanelContent() {
        const root = getRootSettings();
        const pkg = getActivePackage();
        const canEdit = !pkg.isSealed || isAuthorUnlocked;
        const badgeEl = document.getElementById("ps-mode-badge");
        const pkgBarEl = document.getElementById("ps-pkg-bar-container");
        const tabsEl = document.getElementById("ps-tabs-container");
        const bodyEl = document.getElementById("ps-body");
        const footerEl = document.getElementById("ps-footer");

        updateHeaderToggleUI(root.enabled);
        renderPackageBar(pkgBarEl);

        if (pkg.isSealed) {
            badgeEl.textContent = isAuthorUnlocked ? "已封印 · 作者已提权" : "已封印 · 防剧透包";
            badgeEl.classList.add("ps-sealed");
        } else {
            badgeEl.textContent = "作者编辑模式";
            badgeEl.classList.remove("ps-sealed");
        }

        const hasAnyPassword = Boolean(pkg.passwordHash || pkg.authorPasswordHash);

        if (hasAnyPassword && !isUnlocked) {
            tabsEl.innerHTML = "";
            bodyEl.innerHTML = `
                <div class="ps-lock-screen">
                    <div class="ps-lock-icon">🔒</div>
                    <div style="font-size:15px;font-weight:500;">${escapeHtml(pkg.storyTitle)}</div>
                    <div class="ps-lock-desc">
                        当前剧情线与结局大纲已加密锁定。<br>
                        输入玩家密码可查看结局进度；输入作者密码可直接进入编辑模式。
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
                        导入新封包
                        <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
                    </label>
                </div>
                <div class="ps-footer-group">
                    <span class="ps-hint" style="margin:0;">上方可切换其他已存封包</span>
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
                <div class="ps-tab ${activeTab === "fate" ? "ps-active" : ""}" data-tab="fate">结局偏向进度</div>
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
        const pkg = getActivePackage();
        const inputEl = document.getElementById("ps-unlock-input");
        const errEl = document.getElementById("ps-unlock-error");
        const rememberEl = document.getElementById("ps-remember-pwd");
        const shouldRemember = rememberEl ? rememberEl.checked : false;
        const hashed = hashPassword(inputEl ? inputEl.value : "");

        if (pkg.authorPasswordHash && hashed === pkg.authorPasswordHash) {
            isUnlocked = true;
            isAuthorUnlocked = true;
            if (shouldRemember) {
                try { localStorage.setItem(getAuthStorageKey(pkg), "author"); } catch (e) {}
            } else {
                clearSavedAuth();
            }
            renderPanelContent();
            return;
        }

        if (pkg.passwordHash && hashed === pkg.passwordHash) {
            isUnlocked = true;
            isAuthorUnlocked = false;
            if (shouldRemember) {
                try { localStorage.setItem(getAuthStorageKey(pkg), "player"); } catch (e) {}
            } else {
                clearSavedAuth();
            }
            renderPanelContent();
            return;
        }

        if (errEl) errEl.textContent = "密码错误，无法解锁。";
    }

    function renderFateTab(bodyEl) {
        const pkg = getActivePackage();
        const maxProb = pkg.endings.reduce((m, e) => Math.max(m, e.prob || 0), 0);

        const probsHtml = pkg.endings.length
            ? pkg.endings.map(e => {
                const isLead = maxProb > 0 && e.prob === maxProb;
                return `
                    <div class="ps-prob-item">
                        <div class="ps-prob-head">
                            <span>${escapeHtml(e.name)}${isLead ? `<span class="ps-lead-tag">当前领先</span>` : ""}</span>
                            <span style="opacity:0.85;font-weight:500;">${e.prob}%</span>
                        </div>
                        <div class="ps-prob-bar-bg">
                            <div class="ps-prob-bar-fill" style="width:${e.prob}%;"></div>
                        </div>
                    </div>
                `;
            }).join("")
            : `<div class="ps-hint">尚未设置任何结局。</div>`;

        bodyEl.innerHTML = `
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">当前结局偏向进度（初始 0%，单轮累加）</span>
                    <button id="ps-reset-probs" class="ps-btn ps-btn-sm">归零重置</button>
                </div>
                ${probsHtml}
                <div class="ps-hint" style="margin-top:12px;">
                    每轮仅给最偏向的 1 个结局加分，终局将自动导向数值最高的结局。切换上方「封包列表」可独立保存不同剧情的进度。
                </div>
            </div>
        `;

        document.getElementById("ps-reset-probs").addEventListener("click", () => {
            if (!pkg.endings.length) return;
            pkg.endings.forEach(e => { e.prob = 0; });
            saveSettings();
            renderPanelContent();
        });
    }

    function renderEditTab(bodyEl) {
        const pkg = getActivePackage();
        const canEdit = !pkg.isSealed || isAuthorUnlocked;
        const disabledAttr = canEdit ? "" : "disabled";

        const endingsEditorHtml = pkg.endings.map((e, idx) => `
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
            const elevateBox = pkg.authorPasswordHash
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
                    <span class="ps-label">1. 玩家防剧透密码（给玩家查看结局进度用，不可改大纲）</span>
                </div>
                <div class="ps-input-row" style="max-width:100%;">
                    <input type="password" id="ps-new-password" class="ps-input" placeholder="${pkg.passwordHash ? "已设置玩家密码（输入新密码可覆盖）" : "设置玩家解锁密码..."}" />
                    <button id="ps-set-password-btn" class="ps-btn">保存玩家密码</button>
                </div>
            </div>
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">2. 作者管理密码（仅作者本人保留，封印后也可解锁编辑）</span>
                </div>
                <div class="ps-input-row" style="max-width:100%;">
                    <input type="password" id="ps-new-author-password" class="ps-input" placeholder="${pkg.authorPasswordHash ? "已设置作者密码（输入新密码可覆盖）" : "设置作者管理密码..."}" />
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
                <input type="text" id="ps-story-title" class="ps-input" value="${escapeHtml(pkg.storyTitle)}" placeholder="输入剧情线名称..." ${disabledAttr} />
            </div>
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">主线剧情大纲（随每次聊天发送给 AI）</span>
                </div>
                <textarea id="ps-plotline" class="ps-textarea" placeholder="输入核心世界观、主线脉络、关键转折点..." ${disabledAttr}>${escapeHtml(pkg.plotline)}</textarea>
            </div>
            <div class="ps-section">
                <div class="ps-section-header">
                    <span class="ps-label">结局分支设定（共 ${pkg.endings.length} 个）</span>
                    ${canEdit ? `<button id="ps-add-ending" class="ps-btn ps-btn-sm">+ 添加结局</button>` : ""}
                </div>
                <div id="ps-endings-list">${endingsEditorHtml}</div>
            </div>
            ${passwordSectionHtml}
        `;

        if (!canEdit && pkg.authorPasswordHash) {
            const tryElevate = () => {
                const input = document.getElementById("ps-author-elevate-input");
                const err = document.getElementById("ps-author-elevate-err");
                if (hashPassword(input ? input.value : "") === pkg.authorPasswordHash) {
                    isAuthorUnlocked = true;
                    try { localStorage.setItem(getAuthStorageKey(pkg), "author"); } catch (e) {}
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
                pkg.storyTitle = e.target.value;
                const nameEl = document.querySelector(".ps-pkg-current-name");
                if (nameEl) nameEl.textContent = pkg.storyTitle || "未命名剧情线";
                saveSettings();
            });
            document.getElementById("ps-plotline").addEventListener("input", (e) => {
                pkg.plotline = e.target.value;
                saveSettings();
            });

            bodyEl.querySelectorAll(".ps-end-name").forEach(inp => {
                inp.addEventListener("input", () => {
                    pkg.endings[Number(inp.getAttribute("data-idx"))].name = inp.value;
                    saveSettings();
                });
            });

            bodyEl.querySelectorAll(".ps-end-desc").forEach(ta => {
                ta.addEventListener("input", () => {
                    pkg.endings[Number(ta.getAttribute("data-idx"))].desc = ta.value;
                    saveSettings();
                });
            });

            document.getElementById("ps-add-ending").addEventListener("click", () => {
                pkg.endings.push({ id: "end_" + Date.now(), name: `结局 ${pkg.endings.length + 1}`, desc: "", prob: 0 });
                saveSettings();
                renderPanelContent();
            });

            bodyEl.querySelectorAll(".ps-del-ending").forEach(btn => {
                btn.addEventListener("click", () => {
                    pkg.endings.splice(Number(btn.getAttribute("data-idx")), 1);
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
                        pkg.passwordHash = "";
                        saveSettings();
                        alert("已清除玩家密码。");
                        renderPanelContent();
                    }
                    return;
                }
                clearSavedAuth();
                pkg.passwordHash = hashPassword(pwd);
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
                        pkg.authorPasswordHash = "";
                        saveSettings();
                        alert("已清除作者密码。");
                        renderPanelContent();
                    }
                    return;
                }
                clearSavedAuth();
                pkg.authorPasswordHash = hashPassword(pwd);
                saveSettings();
                if (inp) inp.value = "";
                alert("作者管理密码已保存！封印导出后凭此密码可随时解除只读编辑。");
                renderPanelContent();
            });
        }
    }

    function renderFooter(footerEl) {
        const pkg = getActivePackage();
        const canEdit = !pkg.isSealed || isAuthorUnlocked;
        const hasAnyPassword = Boolean(pkg.passwordHash || pkg.authorPasswordHash);

        footerEl.innerHTML = `
            <div class="ps-footer-group">
                ${hasAnyPassword ? `<button id="ps-lock-now" class="ps-btn ps-btn-sm">立即锁定</button>` : ""}
                <label class="ps-btn ps-btn-sm" style="cursor:pointer;">
                    导入新封包
                    <input type="file" id="ps-import-file" accept=".json" style="display:none;" />
                </label>
            </div>
            <div class="ps-footer-group">
                ${canEdit
                    ? `<button id="ps-export-sealed" class="ps-btn ps-btn-primary ps-btn-sm">导出加密封包</button>`
                    : `<button id="ps-new-from-footer" class="ps-btn ps-btn-sm">+ 新建空白线</button>`
                }
            </div>
        `;

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
                if (!pkg.passwordHash && !pkg.authorPasswordHash) {
                    if (!confirm("你还没有设置任何密码，确定要导出无密码封包吗？")) return;
                }
                const out = {
                    version: "1.3",
                    isSealed: true,
                    storyTitle: pkg.storyTitle,
                    plotline: pkg.plotline,
                    endings: pkg.endings.map(e => ({ ...e, prob: 0 })),
                    passwordHash: pkg.passwordHash,
                    authorPasswordHash: pkg.authorPasswordHash
                };
                const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${pkg.storyTitle || "plot"}_sealed.json`;
                a.click();
                URL.revokeObjectURL(url);
            });
        }

        const newBtn = document.getElementById("ps-new-from-footer");
        if (newBtn) {
            newBtn.addEventListener("click", () => {
                const root = getRootSettings();
                const blank = createBlankPackage(`新剧情线 ${root.packages.length + 1}`);
                root.packages.push(blank);
                root.activePackageId = blank.id;
                activeTab = "edit";
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
                const parsed = JSON.parse(evt.target.result);
                if (!parsed.endings || typeof parsed.plotline !== "string") {
                    alert("无效的剧情封包文件。");
                    return;
                }
                const root = getRootSettings();
                const newPkg = {
                    id: "pkg_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
                    storyTitle: parsed.storyTitle || "导入的剧情线",
                    plotline: parsed.plotline,
                    endings: parsed.endings.map(end => ({
                        id: end.id || ("end_" + Date.now() + "_" + Math.floor(Math.random() * 1000)),
                        name: end.name || "未命名结局",
                        desc: end.desc || "",
                        prob: 0
                    })),
                    passwordHash: parsed.passwordHash || "",
                    authorPasswordHash: parsed.authorPasswordHash || "",
                    isSealed: true
                };
                root.packages.push(newPkg);
                root.activePackageId = newPkg.id;
                pkgDrawerOpen = false;
                activeTab = "fate";
                restoreSavedAuth();
                saveSettings();
                renderPanelContent();
                alert(`剧情封包「${newPkg.storyTitle}」已添加到存档列表（旧封包进度已保留）！`);
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
