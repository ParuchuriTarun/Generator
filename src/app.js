(() => {
  "use strict";

  const DATA = window.__CHECKLIST_DATA__;
  if (!DATA || !Array.isArray(DATA.sheets)) {
    document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">Checklist data could not be loaded.</p>';
    return;
  }

  const STORAGE_KEY = "sbig.surpriseVisit.v1";
  const PHOTO_DB_NAME = "sbig.surpriseVisit.photos";
  const PHOTO_STORE = "photos";
  const MAX_PHOTOS = 10;
  const TOTAL_ITEMS = DATA.sheets.reduce((sum, sheet) => sum + sheet.total, 0);
  const PDF_PAGE_WIDTH_MM = 210;
  const PDF_PAGE_HEIGHT_MM = 297;
  const PDF_REPORT_HEIGHT_MM = 296;

  const ICONS = {
    check: '<svg class="icon icon-xs" aria-hidden="true"><use href="#i-check"></use></svg>',
    x: '<svg class="icon icon-xs" aria-hidden="true"><use href="#i-x"></use></svg>',
    camera: '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-camera"></use></svg>',
    close: '<svg class="icon" aria-hidden="true"><use href="#i-x"></use></svg>',
  };

  const sheetById = new Map();
  const itemById = new Map();
  DATA.sheets.forEach((sheet, sheetIndex) => {
    sheet.index = sheetIndex;
    sheet.items = [];
    sheetById.set(sheet.id, sheet);
    sheet.sections.forEach((section) => {
      section.items.forEach((item) => {
        item.sheetId = sheet.id;
        item.sheetTitle = sheet.title;
        item.sectionTitle = section.title;
        sheet.items.push(item);
        itemById.set(item.id, { sheet, section, item });
      });
    });
  });

  const branchByName = new Map(DATA.branches.map((branch) => [branch.name, branch]));

  let state = defaultState();
  let activeSheetId = "ops";
  let restored = false;
  let saveTimer = null;
  let toastTimer = null;
  let toastAction = null;
  let lastRemovedPhoto = null;
  let busyItems = new Set();
  let printPrepared = false;
  let topbarObserver = null;
  let photosReady = Promise.resolve();
  let pdfBusy = false;
  let pdfCancelled = false;

  const els = {};

  function defaultState() {
    return {
      branch: "",
      date: todayISO(),
      category: "",
      address: "",
      auditor: "",
      manager: "",
      answers: {},
      remarks: {},
      photos: {},
      savedAt: 0,
    };
  }

  function todayISO() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function nl2br(value) {
    return escapeHtml(value).replace(/\r?\n/g, "<br>");
  }

  function formatDateLong(value) {
    if (!value) return "Not set";
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return "Not set";
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
  }

  function shortText(value, length) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
  }

  function currentSheet() {
    return sheetById.get(activeSheetId) || DATA.sheets[0];
  }

  function answerValue(itemId) {
    return state.answers[itemId] || "";
  }

  function sheetStats(sheet) {
    let yes = 0;
    let no = 0;
    let photos = 0;
    let remarks = 0;
    sheet.items.forEach((item) => {
      const answer = state.answers[item.id];
      if (answer === "yes") yes += 1;
      else if (answer === "no") no += 1;
      const note = (state.remarks[item.id] || "").trim();
      if (note) remarks += 1;
      const list = state.photos[item.id];
      if (Array.isArray(list)) photos += list.length;
    });
    return {
      yes,
      no,
      answered: yes + no,
      pending: sheet.total - yes - no,
      photos,
      remarks,
    };
  }

  function overallStats() {
    const result = { yes: 0, no: 0, answered: 0, pending: 0, photos: 0, total: TOTAL_ITEMS };
    DATA.sheets.forEach((sheet) => {
      const stats = sheetStats(sheet);
      result.yes += stats.yes;
      result.no += stats.no;
      result.answered += stats.answered;
      result.photos += stats.photos;
    });
    result.pending = result.total - result.answered;
    return result;
  }

  function percent(value, total) {
    return total ? Math.round((value / total) * 100) : 0;
  }

  function setSaveStatus(kind, text) {
    els.saveStatus.dataset.state = kind;
    els.saveStatus.textContent = text;
  }

  function scheduleSave() {
    setSaveStatus("saving", "Saving…");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(persistState, 320);
  }

  function persistState() {
    window.clearTimeout(saveTimer);
    try {
      const payload = {
        version: 1,
        branch: state.branch,
        date: state.date,
        category: state.category,
        address: state.address,
        auditor: state.auditor,
        manager: state.manager,
        answers: state.answers,
        remarks: state.remarks,
        active: activeSheetId,
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      state.savedAt = payload.savedAt;
      const time = new Date(payload.savedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      setSaveStatus("saved", `Saved at ${time}`);
    } catch (error) {
      setSaveStatus("error", "Not saved");
      showToast("This browser could not save the visit. Print or keep the tab open.");
    }
  }

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      raw = null;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const next = defaultState();
      next.branch = typeof parsed.branch === "string" ? parsed.branch : "";
      next.date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || "") ? parsed.date : todayISO();
      next.category = ["A", "B", "C", "NA"].includes(parsed.category) ? parsed.category : "";
      next.address = typeof parsed.address === "string" ? parsed.address : "";
      next.auditor = typeof parsed.auditor === "string" ? parsed.auditor : "";
      next.manager = typeof parsed.manager === "string" ? parsed.manager : "";
      next.answers = {};
      if (parsed.answers && typeof parsed.answers === "object") {
        Object.entries(parsed.answers).forEach(([id, value]) => {
          if (itemById.has(id) && (value === "yes" || value === "no")) {
            next.answers[id] = value;
          }
        });
      }
      next.remarks = {};
      if (parsed.remarks && typeof parsed.remarks === "object") {
        Object.entries(parsed.remarks).forEach(([id, value]) => {
          if (itemById.has(id) && typeof value === "string") {
            next.remarks[id] = value;
          }
        });
      }
      next.photos = {};
      next.savedAt = Number(parsed.savedAt) || 0;
      state = next;
      restored = true;
      if (sheetById.has(parsed.active)) {
        activeSheetId = parsed.active;
      }
    } catch (error) {
      state = defaultState();
    }
  }

  function openPhotoDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (openPhotoDb.db) return Promise.resolve(openPhotoDb.db);
    if (openPhotoDb.failed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (db) => {
        if (settled) return;
        settled = true;
        openPhotoDb.db = db;
        if (!db) openPhotoDb.failed = true;
        resolve(db);
      };
      let request;
      try {
        request = indexedDB.open(PHOTO_DB_NAME, 1);
      } catch (error) {
        finish(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.createObjectStore(PHOTO_STORE, { keyPath: "itemId" });
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      window.setTimeout(() => finish(null), 4000);
    });
  }

  function photoDbRequest(mode, operation) {
    return openPhotoDb().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        let tx;
        try {
          tx = db.transaction(PHOTO_STORE, mode);
        } catch (error) {
          resolve(null);
          return;
        }
        const store = tx.objectStore(PHOTO_STORE);
        let result = null;
        try {
          const request = operation(store);
          if (request) {
            request.onsuccess = () => {
              result = request.result;
            };
          }
        } catch (error) {
          resolve(null);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      });
    });
  }

  const PhotoStore = {
    getAll() {
      return photoDbRequest("readonly", (store) => store.getAll()).then((rows) => rows || []);
    },
    put(itemId, photos) {
      return photoDbRequest("readwrite", (store) => {
        if (Array.isArray(photos) && photos.length) {
          return store.put({ itemId, photos });
        }
        return store.delete(itemId);
      }).then((result) => result !== null);
    },
    clear() {
      return photoDbRequest("readwrite", (store) => store.clear()).then((result) => result !== null);
    },
  };

  async function restorePhotos() {
    const rows = await PhotoStore.getAll();
    if (!Array.isArray(rows) || !rows.length) return;
    let found = false;
    rows.forEach((row) => {
      if (!row || !itemById.has(row.itemId) || !Array.isArray(row.photos)) return;
      const valid = row.photos.filter(
        (photo) =>
          photo &&
          typeof photo === "object" &&
          typeof photo.src === "string" &&
          photo.src.startsWith("data:image/")
      );
      if (valid.length) {
        state.photos[row.itemId] = valid.slice(0, MAX_PHOTOS);
        found = true;
      }
    });
    if (!found) return;
    refreshAllPhotoStrips();
    updateProgress();
  }

  function requirementFor(item) {
    if (!item.req) return "";
    if (!["A", "B", "C"].includes(state.category)) return "";
    const value = item.req[state.category];
    return value && value !== "—" && value !== "-" ? value : "";
  }

  function requirementHtml(item) {
    const value = requirementFor(item);
    if (!value) return "";
    const className = value === "Must" ? "req req-must" : "req req-optional";
    return `<span class="${className}" title="Requirement for category ${escapeHtml(
      state.category
    )} branches">${escapeHtml(value)}</span>`;
  }

  function photosHtml(itemId) {
    const photos = Array.isArray(state.photos[itemId]) ? state.photos[itemId] : [];
    const full = photos.length >= MAX_PHOTOS;
    const stop = itemById.get(itemId);
    const label = stop ? `checkpoint ${stop.item.n}` : "this checkpoint";
    const thumbs = photos
      .map(
        (photo, index) => `
          <div class="thumb-wrap">
            <button type="button" class="thumb-open" data-photo-open="${escapeHtml(
              photo.id
            )}" data-item-id="${escapeHtml(itemId)}" aria-label="View photo ${index + 1} of ${
              photos.length
            } for ${escapeHtml(label)}">
              <img src="${photo.src}" alt="Evidence photo ${index + 1}" decoding="async">
            </button>
            <button type="button" class="thumb-remove" data-photo-remove="${escapeHtml(
              photo.id
            )}" data-item-id="${escapeHtml(itemId)}" aria-label="Remove photo ${
              index + 1
            } from ${escapeHtml(label)}" title="Remove photo">
              ${ICONS.close}
            </button>
          </div>`
      )
      .join("");
    return `
      <div class="photo-strip" data-item-id="${escapeHtml(itemId)}">
        ${thumbs}
        <button type="button" class="photo-add" data-photo-add="${escapeHtml(itemId)}" ${
          full ? "disabled" : ""
        } title="${full ? "10 photo limit reached" : "Add up to 10 photos"}">
          ${ICONS.camera}
          <span>${full ? "Limit reached" : "Add photos"}</span>
        </button>
        <span class="photo-count" data-full="${full}">${photos.length} / ${MAX_PHOTOS}</span>
      </div>`;
  }

  function renderSheet() {
    const sheet = currentSheet();
    const stats = sheetStats(sheet);
    const nextSheet = DATA.sheets[sheet.index + 1] || null;
    const sectionHtml = sheet.sections
      .map((section, sectionIndex) => {
        const itemHtml = section.items
          .map((item) => {
            const answer = state.answers[item.id] || "";
            const textId = `q-${item.id}`;
            const remarkId = `r-${item.id}`;
            return `
              <article class="item" data-id="${escapeHtml(item.id)}">
                <div class="item-num" aria-hidden="true">${String(item.n).padStart(2, "0")}</div>
                <div class="item-main">
                  <p class="item-text" id="${textId}">${escapeHtml(item.text)}</p>
                  <div class="item-tags">${requirementHtml(item)}</div>
                </div>
                <div class="answer" role="group" aria-labelledby="${textId}">
                  <button type="button" class="mark mark-yes" data-answer="yes" data-item-id="${escapeHtml(
                    item.id
                  )}" aria-pressed="${answer === "yes"}">
                    ${ICONS.check}<span>Yes</span>
                  </button>
                  <button type="button" class="mark mark-no" data-answer="no" data-item-id="${escapeHtml(
                    item.id
                  )}" aria-pressed="${answer === "no"}">
                    ${ICONS.x}<span>No</span>
                  </button>
                </div>
                <div class="item-notes">
                  <label class="sr-only" for="${remarkId}">Remarks for checkpoint ${item.n}</label>
                  <textarea class="remark" id="${remarkId}" rows="1" data-remark-id="${escapeHtml(
                    item.id
                  )}" placeholder="Add a remark">${escapeHtml(state.remarks[item.id] || "")}</textarea>
                  ${photosHtml(item.id)}
                </div>
              </article>`;
          })
          .join("");
        return `
          <section class="check-section" aria-labelledby="sec-${sheet.id}-${sectionIndex}">
            <div class="section-bar">
              <h3 class="section-title" id="sec-${sheet.id}-${sectionIndex}">
                ${escapeHtml(section.title)}${
                  section.subtitle ? `<span class="section-sub">${escapeHtml(section.subtitle)}</span>` : ""
                }
              </h3>
              <span class="section-count">${section.items.length} ${
                section.items.length === 1 ? "checkpoint" : "checkpoints"
              }</span>
            </div>
            <div class="items">${itemHtml}</div>
          </section>`;
      })
      .join("");

    const showCategoryHint =
      sheet.id === "infra" && !["A", "B", "C", "NA"].includes(state.category);
    const categoryHint = showCategoryHint
      ? `<p class="sheet-note"><span><strong>Requirement levels:</strong> choose the branch category in Visit details to show whether each facility is required for that category.</span></p>`
      : "";

    const noteHtml = sheet.note
      ? `<p class="sheet-note"><span><strong>Note:</strong> ${escapeHtml(sheet.note)}</span></p>`
      : "";

    const endButton = nextSheet
      ? `<button type="button" class="btn btn-secondary" data-next-sheet="${nextSheet.id}">Continue to ${escapeHtml(
          nextSheet.nav
        )} checklist</button>`
      : `<button type="button" class="btn btn-secondary" data-download-pdf>Download PDF report</button>`;

    const endText = nextSheet
      ? "The PDF report includes all three checklists, whether complete or pending."
      : "All three checklists are included in the PDF report. It downloads automatically when ready.";

    els.sheetPanel.setAttribute("aria-labelledby", `tab-${sheet.id}`);
    els.sheetPanel.innerHTML = `
      <header class="sheet-head">
        <div class="sheet-head-main">
          <p class="sheet-kicker">Checklist ${sheet.index + 1} of ${DATA.sheets.length}</p>
          <h2 class="sheet-title">${escapeHtml(sheet.title)}</h2>
          <p class="sheet-intro">${escapeHtml(sheet.intro)}</p>
        </div>
        <div class="sheet-head-side" id="sheet-progress"></div>
      </header>
      ${categoryHint}
      ${sectionHtml}
      ${noteHtml}
      <div class="sheet-end">
        <p>${escapeHtml(endText)}</p>
        ${endButton}
      </div>`;

    els.sheetPanel.dataset.sheet = sheet.id;
    updateProgress();
    window.requestAnimationFrame(growAllRemarks);
    syncTabs();
  }

  function syncTabs() {
    DATA.sheets.forEach((sheet) => {
      const tab = els.tabs.querySelector(`[data-sheet="${sheet.id}"]`);
      if (!tab) return;
      const stats = sheetStats(sheet);
      const count = tab.querySelector(".tab-count");
      if (count) count.textContent = `${stats.answered}/${sheet.total}`;
      tab.setAttribute("aria-selected", String(sheet.id === activeSheetId));
      tab.tabIndex = sheet.id === activeSheetId ? 0 : -1;
      tab.setAttribute(
        "aria-label",
        `${sheet.nav} checklist, ${stats.answered} of ${sheet.total} answered`
      );
    });
  }

  function updateProgress() {
    const overall = overallStats();
    const percentOverall = percent(overall.answered, overall.total);
    if (els.overallAnswered) els.overallAnswered.textContent = String(overall.answered);
    if (els.overallBar) els.overallBar.style.width = `${percentOverall}%`;
    if (els.overallBar && els.overallBar.parentElement) {
      els.overallBar.parentElement.setAttribute("aria-valuenow", String(overall.answered));
    }
    if (els.overallYes) els.overallYes.textContent = String(overall.yes);
    if (els.overallNo) els.overallNo.textContent = String(overall.no);
    if (els.overallPhotos) els.overallPhotos.textContent = String(overall.photos);

    syncTabs();

    const sheet = currentSheet();
    const stats = sheetStats(sheet);
    const progress = els.sheetPanel.querySelector("#sheet-progress");
    if (progress) {
      const sheetPercent = percent(stats.answered, sheet.total);
      progress.innerHTML = `
        <div class="sheet-progress-line">
          <span><strong>${stats.answered}</strong> of ${sheet.total} answered</span>
          <span>${sheetPercent}%</span>
        </div>
        <div class="progress-track" role="progressbar" aria-label="Progress for ${escapeHtml(
          sheet.title
        )}" aria-valuemin="0" aria-valuemax="${sheet.total}" aria-valuenow="${stats.answered}">
          <div class="progress-fill" style="width:${sheetPercent}%"></div>
        </div>
        <div class="sheet-split">
          <span><strong>${stats.yes}</strong> yes</span>
          <span><strong>${stats.no}</strong> no</span>
          <span><strong>${stats.photos}</strong> photos</span>
        </div>`;
    }
  }

  function growAllRemarks() {
    els.sheetPanel.querySelectorAll(".remark").forEach(autoGrow);
  }

  function autoGrow(element) {
    if (!(element instanceof HTMLTextAreaElement)) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(42, element.scrollHeight)}px`;
  }

  function refreshPhotoStrip(itemId) {
    const strip = els.sheetPanel.querySelector(
      `.photo-strip[data-item-id="${itemId}"]`
    );
    if (!strip) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = photosHtml(itemId).trim();
    const replacement = wrapper.firstElementChild;
    if (replacement) strip.replaceWith(replacement);
  }

  function refreshAllPhotoStrips() {
    Object.keys(state.photos).forEach((itemId) => refreshPhotoStrip(itemId));
  }

  function setAnswer(itemId, value) {
    if (!itemById.has(itemId)) return;
    const next = state.answers[itemId] === value ? "" : value;
    if (next) state.answers[itemId] = next;
    else delete state.answers[itemId];
    const article = els.sheetPanel.querySelector(`.item[data-id="${itemId}"]`);
    if (article) {
      article.querySelectorAll(".mark").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.answer === next));
      });
    }
    updateProgress();
    scheduleSave();
  }

  function setRemark(itemId, value) {
    if (!itemById.has(itemId)) return;
    if (value) state.remarks[itemId] = value;
    else delete state.remarks[itemId];
    scheduleSave();
  }

  function setActiveSheet(sheetId, options = {}) {
    if (!sheetById.has(sheetId) || sheetId === activeSheetId) {
      if (sheetId === activeSheetId && options.focusTab) {
        const tab = els.tabs.querySelector(`[data-sheet="${sheetId}"]`);
        if (tab) tab.focus();
      }
      return;
    }
    activeSheetId = sheetId;
    if (window.location.hash !== `#${sheetId}`) {
      window.history.replaceState(null, "", `#${sheetId}`);
    }
    renderSheet();
    updateProgress();
    if (options.scroll) scrollToChecklist();
    if (options.focusTab) {
      const tab = els.tabs.querySelector(`[data-sheet="${sheetId}"]`);
      if (tab) tab.focus();
    }
  }

  function scrollToChecklist() {
    const topbar = document.querySelector(".topbar");
    const tabs = els.tabs;
    const offset = (topbar ? topbar.offsetHeight : 0) + (tabs ? tabs.offsetHeight : 0) + 12;
    const top = els.workspace.getBoundingClientRect().top + window.scrollY - offset;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }

  function applyBranchDetails(branch) {
    state.branch = branch.name;
    state.category = branch.category || "";
    state.address = branch.address || "";
    els.branchInput.value = branch.name;
    els.categoryInput.value = ["A", "B", "C", "NA"].includes(branch.category)
      ? branch.category
      : "";
    els.addressInput.value = branch.address || "";
    autoGrow(els.addressInput);
    if (activeSheetId === "infra") renderSheet();
    else updateProgress();
    scheduleSave();
  }

  function syncDetailsFromState() {
    els.branchInput.value = state.branch || "";
    els.dateInput.value = state.date || todayISO();
    els.categoryInput.value = ["A", "B", "C", "NA"].includes(state.category)
      ? state.category
      : "";
    els.addressInput.value = state.address || "";
    els.auditorInput.value = state.auditor || "";
    els.managerInput.value = state.manager || "";
    autoGrow(els.addressInput);
  }

  function filterBranches(query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return DATA.branches.slice();
    return DATA.branches.filter((branch) => {
      return (
        branch.name.toLowerCase().includes(needle) ||
        branch.address.toLowerCase().includes(needle) ||
        branch.category.toLowerCase() === needle
      );
    });
  }

  let branchResults = [];
  let branchActiveIndex = -1;

  function renderBranchList(query, resetFilter) {
    let filter = query;
    if (resetFilter) {
      const exact = branchByName.get(filter.trim());
      if (exact) filter = "";
    }
    const matches = filterBranches(filter);
    branchResults = matches.slice(0, 80);
    branchActiveIndex = -1;
    const selectedIndex = branchResults.findIndex((branch) => branch.name === state.branch);
    const options = branchResults
      .map((branch, index) => {
        return `<li id="branch-opt-${index}" class="combo-option" role="option" data-branch-name="${escapeHtml(
          branch.name
        )}" aria-selected="${branch.name === state.branch}">
          <span class="combo-name">${escapeHtml(branch.name)}</span>
          <span class="combo-cat">${escapeHtml(branch.category || "—")}</span>
        </li>`;
      })
      .join("");
    const metaText = matches.length
      ? filter
        ? `${matches.length} matching ${matches.length === 1 ? "branch" : "branches"}`
        : `${DATA.branches.length} branches in the reference`
      : "No branches match that search";
    els.branchList.innerHTML = matches.length
      ? `${options}<li class="combo-meta" role="presentation">${metaText}</li>`
      : `<li class="combo-empty" role="presentation">${metaText}. You can still type a branch name.</li>`;
    if (selectedIndex >= 0) {
      branchActiveIndex = selectedIndex;
      updateBranchActive();
    }
  }

  function openBranchList(options = {}) {
    els.branchList.hidden = false;
    els.branchCombo.dataset.open = "true";
    els.branchInput.setAttribute("aria-expanded", "true");
    renderBranchList(els.branchInput.value, options.resetFilter !== false);
  }

  function closeBranchList() {
    els.branchList.hidden = true;
    els.branchCombo.dataset.open = "false";
    els.branchInput.setAttribute("aria-expanded", "false");
    els.branchInput.removeAttribute("aria-activedescendant");
    els.branchList.querySelectorAll("[data-active]").forEach((option) => {
      option.removeAttribute("data-active");
    });
    branchActiveIndex = -1;
  }

  function updateBranchActive() {
    const options = Array.from(els.branchList.querySelectorAll(".combo-option"));
    options.forEach((option, index) => {
      if (index === branchActiveIndex) option.dataset.active = "true";
      else option.removeAttribute("data-active");
    });
    if (branchActiveIndex >= 0 && options[branchActiveIndex]) {
      const option = options[branchActiveIndex];
      els.branchInput.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else {
      els.branchInput.removeAttribute("aria-activedescendant");
    }
  }

  function moveBranchActive(direction) {
    if (els.branchList.hidden) openBranchList({ resetFilter: false });
    const options = els.branchList.querySelectorAll(".combo-option");
    if (!options.length) return;
    const next = branchActiveIndex < 0 ? 0 : branchActiveIndex + direction;
    branchActiveIndex = Math.max(0, Math.min(options.length - 1, next));
    updateBranchActive();
  }

  function chooseBranch(name) {
    const branch = branchByName.get(name);
    if (!branch) return;
    applyBranchDetails(branch);
    closeBranchList();
    els.branchInput.focus();
    showToast(`Branch details filled from the reference: ${branch.name}.`);
  }

  function initialize() {
    els.saveStatus = document.getElementById("save-status");
    els.printButton = document.getElementById("print-button");
    els.resetButton = document.getElementById("reset-button");
    els.tabs = document.querySelector(".work-tabs");
    els.workspace = document.querySelector(".workspace");
    els.sheetPanel = document.getElementById("sheet-panel");
    els.overallAnswered = document.getElementById("overall-answered");
    els.overallBar = document.getElementById("overall-bar");
    els.overallYes = document.getElementById("overall-yes");
    els.overallNo = document.getElementById("overall-no");
    els.overallPhotos = document.getElementById("overall-photos");
    els.overallTotal = document.getElementById("overall-total");
    const overallTrack = els.overallBar ? els.overallBar.parentElement : null;
    if (els.overallTotal) els.overallTotal.textContent = String(TOTAL_ITEMS);
    if (overallTrack) overallTrack.setAttribute("aria-valuemax", String(TOTAL_ITEMS));
    els.branchInput = document.getElementById("branch-input");
    els.branchCombo = document.querySelector(".combo");
    els.branchList = document.getElementById("branch-list");
    els.branchToggle = document.getElementById("branch-toggle");
    els.dateInput = document.getElementById("date-input");
    els.categoryInput = document.getElementById("category-input");
    els.addressInput = document.getElementById("address-input");
    els.auditorInput = document.getElementById("auditor-input");
    els.managerInput = document.getElementById("manager-input");
    els.photoInput = document.getElementById("photo-input");
    els.photoDialog = document.getElementById("photo-dialog");
    els.photoImage = document.getElementById("photo-large");
    els.photoTitle = document.getElementById("photo-dialog-title");
    els.photoSub = document.getElementById("photo-dialog-sub");
    els.photoDownload = document.getElementById("photo-download");
    els.pdfDialog = document.getElementById("pdf-dialog");
    els.pdfTitle = document.getElementById("pdf-dialog-title");
    els.pdfStatus = document.getElementById("pdf-status");
    els.pdfHint = document.getElementById("pdf-hint");
    els.pdfProgress = document.getElementById("pdf-progress");
    els.pdfProgressFill = document.getElementById("pdf-progress-fill");
    els.pdfCancel = document.getElementById("pdf-cancel-button");
    els.pdfClose = document.getElementById("pdf-close-button");
    els.resetDialog = document.getElementById("reset-dialog");
    els.resetConfirm = document.getElementById("reset-confirm");
    els.toast = document.getElementById("toast");
    els.toastMessage = document.getElementById("toast-message");
    els.toastAction = document.getElementById("toast-action");
    els.printRoot = document.getElementById("print-root");

    loadState();
    const hash = window.location.hash.replace("#", "");
    if (sheetById.has(hash)) activeSheetId = hash;
    else if (!sheetById.has(activeSheetId)) activeSheetId = "ops";

    els.saveStatus.textContent = restored ? "Visit restored" : "Autosave on";
    syncDetailsFromState();
    renderSheet();
    updateProgress();
    bindEvents();
    observeTopbar();

    if (restored) {
      showToast("Restored your saved visit from this browser.");
    }

    photosReady = restorePhotos();

    if (new URLSearchParams(window.location.search).get("print") === "1") {
      window.setTimeout(async () => {
        try {
          await photosReady;
          buildPrintReport();
        } catch (error) {
          console.error(error);
        }
      }, 300);
    }
  }

  function showToast(message, options = {}) {
    window.clearTimeout(toastTimer);
    els.toastMessage.textContent = message;
    toastAction = typeof options.onAction === "function" ? options.onAction : null;
    if (toastAction) {
      els.toastAction.hidden = false;
      els.toastAction.textContent = options.actionLabel || "Undo";
    } else {
      els.toastAction.hidden = true;
      els.toastAction.textContent = "Undo";
    }
    els.toast.classList.remove("is-visible");
    void els.toast.offsetWidth;
    els.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(hideToast, options.duration || (toastAction ? 7000 : 3800));
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    els.toast.classList.remove("is-visible");
    toastAction = null;
    els.toastAction.hidden = true;
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      if (!els.branchCombo.contains(event.target)) closeBranchList();
    });

    els.branchInput.addEventListener("focus", () => {
      openBranchList({ resetFilter: true });
    });

    els.branchInput.addEventListener("input", () => {
      state.branch = els.branchInput.value;
      scheduleSave();
      openBranchList({ resetFilter: false });
    });

    els.branchInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveBranchActive(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        if (!els.branchList.hidden && branchActiveIndex >= 0 && branchResults[branchActiveIndex]) {
          event.preventDefault();
          chooseBranch(branchResults[branchActiveIndex].name);
        }
      } else if (event.key === "Escape") {
        closeBranchList();
      } else if (event.key === "Tab") {
        closeBranchList();
      }
    });

    els.branchInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (els.branchCombo.contains(document.activeElement)) return;
        closeBranchList();
        const match = branchByName.get(els.branchInput.value.trim());
        if (match && !state.category && !state.address) {
          applyBranchDetails(match);
        }
      }, 120);
    });

    els.branchToggle.addEventListener("click", () => {
      if (els.branchList.hidden) {
        openBranchList({ resetFilter: true });
        els.branchInput.focus();
      } else {
        closeBranchList();
      }
    });

    els.branchList.addEventListener("mousedown", (event) => {
      if (event.target.closest(".combo-option")) event.preventDefault();
    });

    els.branchList.addEventListener("click", (event) => {
      const option = event.target.closest("[data-branch-name]");
      if (option) chooseBranch(option.dataset.branchName);
    });

    els.dateInput.addEventListener("input", () => {
      state.date = els.dateInput.value;
      scheduleSave();
    });

    els.categoryInput.addEventListener("change", () => {
      state.category = els.categoryInput.value;
      scheduleSave();
      if (activeSheetId === "infra") renderSheet();
    });

    els.addressInput.addEventListener("input", () => {
      state.address = els.addressInput.value;
      autoGrow(els.addressInput);
      scheduleSave();
    });

    els.auditorInput.addEventListener("input", () => {
      state.auditor = els.auditorInput.value;
      scheduleSave();
    });

    els.managerInput.addEventListener("input", () => {
      state.manager = els.managerInput.value;
      scheduleSave();
    });

    els.tabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-sheet]");
      if (!tab) return;
      setActiveSheet(tab.dataset.sheet, { scroll: true });
    });

    els.tabs.addEventListener("keydown", (event) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const index = DATA.sheets.findIndex((sheet) => sheet.id === activeSheetId);
      let next = index;
      if (event.key === "ArrowLeft") next = (index - 1 + DATA.sheets.length) % DATA.sheets.length;
      if (event.key === "ArrowRight") next = (index + 1) % DATA.sheets.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = DATA.sheets.length - 1;
      setActiveSheet(DATA.sheets[next].id, { scroll: true, focusTab: true });
    });

    els.sheetPanel.addEventListener("click", (event) => {
      const answer = event.target.closest(".mark");
      if (answer) {
        setAnswer(answer.dataset.itemId, answer.dataset.answer);
        return;
      }
      const addPhoto = event.target.closest("[data-photo-add]");
      if (addPhoto) {
        openPhotoPicker(addPhoto.dataset.photoAdd);
        return;
      }
      const openPhoto = event.target.closest("[data-photo-open]");
      if (openPhoto) {
        openPhotoViewer(openPhoto.dataset.itemId, openPhoto.dataset.photoOpen);
        return;
      }
      const removePhotoButton = event.target.closest("[data-photo-remove]");
      if (removePhotoButton) {
        removePhoto(removePhotoButton.dataset.itemId, removePhotoButton.dataset.photoRemove);
        return;
      }
      const nextSheet = event.target.closest("[data-next-sheet]");
      if (nextSheet) {
        setActiveSheet(nextSheet.dataset.nextSheet, { scroll: true });
        return;
      }
      if (event.target.closest("[data-download-pdf]")) downloadPdfReport();
    });

    els.sheetPanel.addEventListener("input", (event) => {
      const remark = event.target.closest(".remark");
      if (!remark) return;
      autoGrow(remark);
      setRemark(remark.dataset.remarkId, remark.value);
    });

    els.sheetPanel.addEventListener("dragover", (event) => {
      const strip = event.target.closest(".photo-strip");
      if (!strip || !event.dataTransfer) return;
      if (Array.from(event.dataTransfer.types).includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        strip.classList.add("is-dragover");
      }
    });

    els.sheetPanel.addEventListener("dragleave", (event) => {
      const strip = event.target.closest(".photo-strip");
      if (strip && !strip.contains(event.relatedTarget)) strip.classList.remove("is-dragover");
    });

    els.sheetPanel.addEventListener("drop", (event) => {
      const strip = event.target.closest(".photo-strip");
      if (!strip || !event.dataTransfer) return;
      event.preventDefault();
      strip.classList.remove("is-dragover");
      addFiles(strip.dataset.itemId, event.dataTransfer.files);
    });

    els.photoInput.addEventListener("change", () => {
      const itemId = els.photoInput.dataset.itemId;
      const files = Array.from(els.photoInput.files || []);
      els.photoInput.value = "";
      if (itemId && files.length) addFiles(itemId, files);
    });

    els.printButton.addEventListener("click", downloadPdfReport);

    els.resetButton.addEventListener("click", () => {
      if (!els.resetDialog.open) els.resetDialog.showModal();
    });

    els.resetConfirm.addEventListener("click", resetVisit);

    els.pdfCancel.addEventListener("click", requestPdfCancel);
    els.pdfClose.addEventListener("click", () => els.pdfDialog.close());

    els.pdfDialog.addEventListener("cancel", (event) => {
      if (pdfBusy) {
        event.preventDefault();
        requestPdfCancel();
      }
    });

    els.pdfDialog.addEventListener("click", (event) => {
      if (event.target === els.pdfDialog && !pdfBusy) els.pdfDialog.close();
    });

    els.photoDialog.addEventListener("click", (event) => {
      if (event.target === els.photoDialog) els.photoDialog.close();
    });

    els.resetDialog.addEventListener("click", (event) => {
      if (event.target === els.resetDialog) els.resetDialog.close();
    });

    document.querySelectorAll("[data-close-photo]").forEach((button) => {
      button.addEventListener("click", () => els.photoDialog.close());
    });

    document.querySelectorAll("[data-close-reset]").forEach((button) => {
      button.addEventListener("click", () => els.resetDialog.close());
    });

    els.toastAction.addEventListener("click", () => {
      const action = toastAction;
      hideToast();
      if (action) action();
    });

    window.addEventListener("hashchange", () => {
      const id = window.location.hash.replace("#", "");
      if (sheetById.has(id) && id !== activeSheetId) {
        setActiveSheet(id, { scroll: false });
      }
    });

    window.addEventListener("pagehide", () => persistState());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistState();
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(growAllRemarks, 120);
    });

    window.addEventListener("beforeprint", () => {
      if (!printPrepared) {
        try {
          buildPrintReport();
        } catch (error) {
          console.error(error);
        }
      }
    });

    window.addEventListener("afterprint", () => {
      printPrepared = false;
    });
  }

  function observeTopbar() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    if (topbarObserver) topbarObserver.disconnect();
    topbarObserver = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
    });
    topbarObserver.observe(topbar);
    document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  }

  function openPhotoPicker(itemId) {
    if (!itemById.has(itemId)) return;
    if (busyItems.has(itemId)) {
      showToast("Please wait for the current photos to finish processing.");
      return;
    }
    const photos = state.photos[itemId] || [];
    if (photos.length >= MAX_PHOTOS) {
      showToast(`This remark already has ${MAX_PHOTOS} photos. Remove one to add another.`);
      return;
    }
    els.photoInput.dataset.itemId = itemId;
    els.photoInput.value = "";
    els.photoInput.click();
  }

  function isImageFile(file) {
    if (!file) return false;
    if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
    return /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(file.name || "");
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The image could not be opened."));
      image.src = url;
    });
  }

  async function compressImage(file) {
    if (!file) throw new Error("No file.");
    if (file.size > 40 * 1024 * 1024) {
      throw new Error("The image is larger than 40 MB.");
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImageFromUrl(url);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) throw new Error("The image has no dimensions.");
      const maxEdge = 1600;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The image could not be processed.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const src = canvas.toDataURL("image/jpeg", 0.86);
      return {
        id: uid(),
        name: file.name || "Photo",
        src,
        width: canvas.width,
        height: canvas.height,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function setPhotoBusy(itemId, busy) {
    const strip = els.sheetPanel.querySelector(`.photo-strip[data-item-id="${itemId}"]`);
    if (!strip) return;
    const button = strip.querySelector(".photo-add");
    if (!button) return;
    button.disabled = busy;
    const label = button.querySelector("span");
    if (label) label.textContent = busy ? "Adding…" : "Add photos";
  }

  async function addFiles(itemId, fileList) {
    if (!itemById.has(itemId) || busyItems.has(itemId)) return;
    const files = Array.from(fileList || []).filter(isImageFile);
    if (!files.length) {
      showToast("Choose image files such as JPG, PNG or WebP.");
      return;
    }
    const existing = Array.isArray(state.photos[itemId]) ? state.photos[itemId] : [];
    const slots = MAX_PHOTOS - existing.length;
    if (slots <= 0) {
      showToast(`This remark already has ${MAX_PHOTOS} photos. Remove one to add another.`);
      return;
    }
    const accepted = files.slice(0, slots);
    const skipped = files.length - accepted.length;
    busyItems.add(itemId);
    setPhotoBusy(itemId, true);
    const added = [];
    const failed = [];
    for (const file of accepted) {
      try {
        added.push(await compressImage(file));
      } catch (error) {
        failed.push(file.name || "one image");
      }
    }
    if (added.length) {
      state.photos[itemId] = existing.concat(added).slice(0, MAX_PHOTOS);
      refreshPhotoStrip(itemId);
      updateProgress();
      const saved = await PhotoStore.put(itemId, state.photos[itemId]);
      if (!saved) {
        showToast("Photos added. Browser storage could not save them, so print before closing this tab.");
      }
    } else {
      refreshPhotoStrip(itemId);
    }
    busyItems.delete(itemId);

    const messages = [];
    if (added.length) {
      messages.push(`${added.length} ${added.length === 1 ? "photo" : "photos"} added.`);
    }
    if (skipped > 0) {
      messages.push(`${skipped} not added because the limit is ${MAX_PHOTOS} per remark.`);
    }
    if (failed.length) {
      messages.push(
        `${failed.length} ${failed.length === 1 ? "file" : "files"} could not be read. Try JPG or PNG.`
      );
    }
    if (messages.length) showToast(messages.join(" "), { duration: failed.length ? 7000 : 3800 });
  }

  function removePhoto(itemId, photoId) {
    const list = Array.isArray(state.photos[itemId]) ? state.photos[itemId].slice() : [];
    const index = list.findIndex((photo) => photo.id === photoId);
    if (index < 0) return;
    const removed = { photo: list[index], index };
    const next = list.filter((photo) => photo.id !== photoId);
    if (next.length) state.photos[itemId] = next;
    else delete state.photos[itemId];
    refreshPhotoStrip(itemId);
    updateProgress();
    PhotoStore.put(itemId, next);
    showToast("Photo removed.", {
      actionLabel: "Undo",
      onAction: () => {
        const current = Array.isArray(state.photos[itemId]) ? state.photos[itemId].slice() : [];
        if (current.length >= MAX_PHOTOS) {
          showToast(`Cannot undo: this remark already has ${MAX_PHOTOS} photos.`);
          return;
        }
        const restored = current.slice();
        restored.splice(Math.min(removed.index, restored.length), 0, removed.photo);
        state.photos[itemId] = restored;
        refreshPhotoStrip(itemId);
        updateProgress();
        PhotoStore.put(itemId, restored);
        showToast("Photo restored.");
      },
    });
  }

  function openPhotoViewer(itemId, photoId) {
    const entry = itemById.get(itemId);
    if (!entry) return;
    const list = Array.isArray(state.photos[itemId]) ? state.photos[itemId] : [];
    const index = list.findIndex((photo) => photo.id === photoId);
    if (index < 0) return;
    const photo = list[index];
    els.photoImage.src = photo.src;
    els.photoImage.alt = `Photo ${index + 1} for checkpoint ${entry.item.n}: ${entry.item.text}`;
    els.photoTitle.textContent = photo.name || "Photo evidence";
    els.photoSub.textContent = `Checkpoint ${entry.item.n}: ${shortText(entry.item.text, 180)}`;
    els.photoDownload.href = photo.src;
    els.photoDownload.download = `checkpoint-${entry.item.n}-photo-${index + 1}.jpg`;
    if (!els.photoDialog.open) els.photoDialog.showModal();
  }

  async function resetVisit() {
    els.resetDialog.close();
    window.clearTimeout(saveTimer);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* storage can be unavailable */
    }
    state = defaultState();
    activeSheetId = "ops";
    lastRemovedPhoto = null;
    busyItems = new Set();
    els.printRoot.innerHTML = "";
    window.history.replaceState(null, "", "#ops");
    await PhotoStore.clear();
    syncDetailsFromState();
    renderSheet();
    updateProgress();
    setSaveStatus("ready", "Autosave on");
    showToast("Visit cleared. You can start a new visit.");
  }

  function branchLabel() {
    return (state.branch || "").trim() || "Branch not specified";
  }

  function dateLabel() {
    return formatDateLong(state.date);
  }

  function coverMeta(label, value) {
    return `<div>
      <span class="cover-label">${escapeHtml(label)}</span>
      <span class="cover-value">${escapeHtml(value || "Not recorded")}</span>
    </div>`;
  }

  function makeCoverPage() {
    const overall = overallStats();
    const summaryRows = DATA.sheets
      .map((sheet) => {
        const stats = sheetStats(sheet);
        return `<tr>
          <td>${escapeHtml(sheet.title)}</td>
          <td>${stats.answered} / ${sheet.total}</td>
          <td class="cover-num-yes">${stats.yes}</td>
          <td class="cover-num-no">${stats.no}</td>
          <td>${stats.pending}</td>
          <td>${stats.photos}</td>
        </tr>`;
      })
      .join("");
    const page = document.createElement("div");
    page.className = "print-page cover-page";
    page.innerHTML = `
      <div class="cover-band">
        <div class="cover-brandline">
          <strong>SBI General Insurance</strong>
          <span>Branch operations</span>
        </div>
        <p class="cover-kicker">Branch surprise visit</p>
        <h1 class="cover-title">${escapeHtml(branchLabel())}</h1>
        <p class="cover-sub">Compliance checklist report</p>
        <p class="cover-address">${escapeHtml(state.address || "Branch address not recorded.")}</p>
      </div>
      <div class="cover-content">
        <div class="cover-meta">
          ${coverMeta("Visit date", dateLabel())}
          ${coverMeta("Branch category", state.category || "Not set")}
          ${coverMeta("Auditor", state.auditor)}
          ${coverMeta("Branch manager", state.manager)}
        </div>
        <div class="cover-stats">
          <div class="cover-stat"><strong>${overall.total}</strong><span>checkpoints</span></div>
          <div class="cover-stat"><strong>${overall.yes}</strong><span>marked yes</span></div>
          <div class="cover-stat"><strong>${overall.no}</strong><span>marked no</span></div>
          <div class="cover-stat"><strong>${overall.pending}</strong><span>pending</span></div>
          <div class="cover-stat"><strong>${overall.photos}</strong><span>photos</span></div>
        </div>
        <div class="cover-summary-head">
          <h2>Checklist summary</h2>
          <p>${overall.answered} of ${overall.total} checkpoints answered</p>
        </div>
        <table class="cover-table">
          <thead>
            <tr>
              <th>Checklist</th>
              <th>Answered</th>
              <th>Yes</th>
              <th>No</th>
              <th>Pending</th>
              <th>Photos</th>
            </tr>
          </thead>
          <tbody>
            ${summaryRows}
            <tr>
              <td>Total</td>
              <td>${overall.answered} / ${overall.total}</td>
              <td>${overall.yes}</td>
              <td>${overall.no}</td>
              <td>${overall.pending}</td>
              <td>${overall.photos}</td>
            </tr>
          </tbody>
        </table>
        <div class="cover-signoff">
          <h2>Sign-off</h2>
          <p class="cover-note">Photo evidence is reproduced beside the relevant checkpoint. Every item is printed, whether answered, marked no, or still pending.</p>
          <div class="signoff-grid">
            <div class="signoff-cell">
              <span class="signoff-label">Auditor</span>
              <span class="signoff-line"></span>
              <span class="signoff-name">${state.auditor ? escapeHtml(state.auditor) : "&nbsp;"}</span>
            </div>
            <div class="signoff-cell">
              <span class="signoff-label">Branch manager</span>
              <span class="signoff-line"></span>
              <span class="signoff-name">${state.manager ? escapeHtml(state.manager) : "&nbsp;"}</span>
            </div>
            <div class="signoff-cell">
              <span class="signoff-label">Date</span>
              <span class="signoff-line"></span>
              <span class="signoff-name">${escapeHtml(dateLabel())}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="pp-foot cover-foot">
        <span>${escapeHtml(dateLabel())}</span>
        <span class="pp-internal">Internal use only</span>
        <span class="pp-page-num"></span>
      </div>`;
    return page;
  }

  function resultHtml(yes, no) {
    return `<div class="pp-options">
      <span class="pp-option ${yes ? "is-on is-yes" : ""}"><span class="pp-box">${yes ? "✓" : ""}</span>Yes</span>
      <span class="pp-option ${no ? "is-on is-no" : ""}"><span class="pp-box">${no ? "✗" : ""}</span>No</span>
    </div>${!yes && !no ? '<div class="pp-pending">Not marked</div>' : ""}`;
  }

  function printNotesHtml(item) {
    const remark = String(state.remarks[item.id] || "").trim();
    const photos = Array.isArray(state.photos[item.id]) ? state.photos[item.id] : [];
    const remarkHtml = remark
      ? `<div class="pp-remark">${nl2br(remark)}</div>`
      : '<div class="pp-remark pp-remark-empty">No remark recorded.</div>';
    const photosHtml = photos.length
      ? `<div class="pp-photos count-${photos.length}">${photos
          .map(
            (photo, index) => `<figure class="pp-photo">
              <img src="${photo.src}" alt="Evidence photo ${index + 1} for checkpoint ${
              item.n
            }">
              <figcaption>${index + 1}</figcaption>
            </figure>`
          )
          .join("")}</div>`
      : "";
    return remarkHtml + photosHtml;
  }

  function makePrintItemRow(item) {
    const answer = state.answers[item.id] || "";
    const requirement = requirementFor(item);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="td-num">${item.n}</td>
      <td>
        <div class="pp-check">
          ${escapeHtml(item.text)}${
            requirement ? `<span class="pp-req">${escapeHtml(requirement)}</span>` : ""
          }
        </div>
      </td>
      <td>${resultHtml(answer === "yes", answer === "no")}</td>
      <td>${printNotesHtml(item)}</td>`;
    return row;
  }

  function makePrintSectionRow(section, continued) {
    const row = document.createElement("tr");
    row.className = "pp-section";
    row.innerHTML = `<td colspan="4">
      <span class="pp-section-title">${escapeHtml(section.title)}</span>
      ${section.subtitle ? `<span class="pp-section-sub">${escapeHtml(section.subtitle)}</span>` : ""}
      ${continued ? '<span class="pp-section-sub">continued</span>' : ""}
    </td>`;
    return row;
  }

  function makePrintNoteRow(note) {
    const row = document.createElement("tr");
    row.className = "pp-note-row";
    row.innerHTML = `<td colspan="4"><strong>Note</strong> ${escapeHtml(note)}</td>`;
    return row;
  }

  function makeChecklistPage(sheet, continued) {
    const stats = sheetStats(sheet);
    const page = document.createElement("div");
    page.className = "print-page";
    const title = continued
      ? `<div class="pp-cont">
          <span>${escapeHtml(sheet.title)}, continued</span>
          <span>${stats.answered} of ${sheet.total} answered</span>
        </div>`
      : `<div class="pp-title">
          <div class="pp-title-top">
            <div>
              <p class="pp-kicker">Checklist ${sheet.index + 1} of ${DATA.sheets.length}</p>
              <h2>${escapeHtml(sheet.title)}</h2>
            </div>
            <span class="pp-total">${sheet.total} checkpoints</span>
          </div>
          <p class="pp-intro">${escapeHtml(sheet.intro)}</p>
          <div class="pp-statline">
            <span><strong>${stats.yes}</strong> yes</span>
            <span><strong>${stats.no}</strong> no</span>
            <span><strong>${stats.pending}</strong> pending</span>
            <span><strong>${stats.photos}</strong> photos</span>
          </div>
        </div>`;
    page.innerHTML = `
      <div class="pp-run">
        <div class="pp-run-brand">
          <strong>SBI General Insurance</strong>
          <span>Branch surprise visit</span>
        </div>
        <span class="pp-run-branch">${escapeHtml(branchLabel())}</span>
      </div>
      <div class="pp-body">
        ${title}
        <table class="pp-table">
          <colgroup>
            <col class="c-num">
            <col class="c-check">
            <col class="c-result">
            <col class="c-notes">
          </colgroup>
          <thead>
            <tr>
              <th class="th-num">#</th>
              <th>Checkpoint</th>
              <th class="th-result">Result</th>
              <th>Remarks and photo evidence</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pp-foot">
        <span>${escapeHtml(dateLabel())}</span>
        <span class="pp-internal">Internal use only</span>
        <span class="pp-page-num"></span>
      </div>`;
    els.printRoot.appendChild(page);
    return page;
  }

  function printBodyOverflows(page) {
    const body = page.querySelector(".pp-body");
    return body ? body.scrollHeight > body.clientHeight + 1 : false;
  }

  function buildPrintReport() {
    els.printRoot.innerHTML = "";
    const cover = makeCoverPage();
    els.printRoot.appendChild(cover);

    DATA.sheets.forEach((sheet) => {
      let page = makeChecklistPage(sheet, false);
      let tbody = page.querySelector("tbody");

      sheet.sections.forEach((section) => {
        if (!section.items.length) return;
        let sectionRow = makePrintSectionRow(section, false);
        const firstRow = makePrintItemRow(section.items[0]);
        tbody.appendChild(sectionRow);
        tbody.appendChild(firstRow);
        if (printBodyOverflows(page)) {
          tbody.removeChild(firstRow);
          tbody.removeChild(sectionRow);
          page = makeChecklistPage(sheet, true);
          tbody = page.querySelector("tbody");
          tbody.appendChild(makePrintSectionRow(section, false));
          tbody.appendChild(firstRow);
        }

        for (let index = 1; index < section.items.length; index += 1) {
          const row = makePrintItemRow(section.items[index]);
          tbody.appendChild(row);
          if (!printBodyOverflows(page)) continue;
          tbody.removeChild(row);
          page = makeChecklistPage(sheet, true);
          tbody = page.querySelector("tbody");
          sectionRow = makePrintSectionRow(section, true);
          tbody.appendChild(sectionRow);
          tbody.appendChild(row);
          if (printBodyOverflows(page)) {
            tbody.removeChild(sectionRow);
          }
        }
      });

      if (sheet.note) {
        const noteRow = makePrintNoteRow(sheet.note);
        tbody.appendChild(noteRow);
        if (printBodyOverflows(page)) {
          tbody.removeChild(noteRow);
          page = makeChecklistPage(sheet, true);
          tbody = page.querySelector("tbody");
          tbody.appendChild(noteRow);
        }
      }
    });

    const pages = Array.from(els.printRoot.querySelectorAll(".print-page"));
    pages.forEach((page, index) => {
      const number = page.querySelector(".pp-page-num");
      if (number) number.textContent = `Page ${index + 1} of ${pages.length}`;
    });
    return pages.length;
  }

  async function downloadPdfReport() {
    if (pdfBusy) return;
    const JsPDF = window.jspdf && window.jspdf.jsPDF;
    const renderer = window.htmlToImage;
    if (typeof JsPDF !== "function" || !renderer || typeof renderer.toCanvas !== "function") {
      showToast("The PDF engine did not load. Reload this file and try again.");
      return;
    }

    pdfBusy = true;
    pdfCancelled = false;
    els.printButton.disabled = true;
    resetPdfDialog();
    if (!els.pdfDialog.open) els.pdfDialog.showModal();
    els.pdfCancel.focus();

    let stage = null;
    try {
      els.pdfStatus.textContent = "Collecting checklist answers and photos…";
      await photosReady;
      buildPrintReport();
      const pages = Array.from(els.printRoot.querySelectorAll(".print-page"));
      if (!pages.length) throw new Error("The report has no pages.");

      await waitForImages(els.printRoot);
      if (document.fonts && document.fonts.ready) await document.fonts.ready;

      stage = document.createElement("div");
      stage.className = "pdf-stage";
      stage.setAttribute("aria-hidden", "true");
      document.body.appendChild(stage);

      const pdf = new JsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      pdf.setProperties({
        title: pdfFilename().replace(/\.pdf$/i, ""),
        subject: "Branch surprise visit compliance checklist",
        author: state.auditor || "SBI General Insurance",
        creator: "Branch Surprise Visit Checklist",
      });

      for (let index = 0; index < pages.length; index += 1) {
        if (pdfCancelled) throw pdfCancelError();
        updatePdfProgress(index, pages.length, `Rendering page ${index + 1} of ${pages.length}…`);
        const clone = pages[index].cloneNode(true);
        stage.replaceChildren(clone);
        await waitForImages(clone);
        const bounds = clone.getBoundingClientRect();
        const canvas = await renderer.toCanvas(clone, {
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
          pixelRatio: 2,
          backgroundColor: "#ffffff",
          skipFonts: true,
          cacheBust: false,
          logging: false,
        });
        if (pdfCancelled) throw pdfCancelError();
        const image = canvas.toDataURL("image/jpeg", 0.92);
        if (index > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(
          image,
          "JPEG",
          0,
          0,
          PDF_PAGE_WIDTH_MM,
          PDF_REPORT_HEIGHT_MM,
          undefined,
          "FAST"
        );
        updatePdfProgress(index + 1, pages.length, `Rendered page ${index + 1} of ${pages.length}.`);
        await new Promise((resolve) => window.setTimeout(resolve, 30));
      }

      if (pdfCancelled) throw pdfCancelError();
      els.pdfStatus.textContent = "Saving the PDF…";
      els.pdfHint.textContent = "Your download should start automatically.";
      const filename = pdfFilename();
      const blob = pdf.output("blob");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      els.pdfDialog.close();
      showToast(`PDF downloaded: ${filename}`, { duration: 6000 });
    } catch (error) {
      if (error && error.cancelled) {
        els.pdfDialog.close();
        showToast("PDF creation cancelled.");
      } else {
        console.error(error);
        showPdfError(
          "Something stopped the PDF from being created. Your answers are safe — close this window and try again."
        );
        showToast("PDF could not be created. Try again.");
      }
    } finally {
      if (stage) stage.remove();
      pdfBusy = false;
      els.printButton.disabled = false;
    }
  }

  function pdfCancelError() {
    const error = new Error("PDF creation cancelled.");
    error.cancelled = true;
    return error;
  }

  function requestPdfCancel() {
    if (!pdfBusy || pdfCancelled) return;
    pdfCancelled = true;
    els.pdfCancel.disabled = true;
    els.pdfCancel.textContent = "Cancelling…";
    els.pdfStatus.textContent = "Stopping after this page…";
  }

  function resetPdfDialog() {
    els.pdfDialog.classList.remove("is-error");
    els.pdfTitle.textContent = "Creating your PDF";
    els.pdfStatus.textContent = "Preparing the report…";
    els.pdfHint.textContent = "Each A4 page is rendered in turn. The file downloads automatically when it is ready.";
    els.pdfProgressFill.style.width = "0%";
    els.pdfProgress.setAttribute("aria-valuenow", "0");
    els.pdfCancel.hidden = false;
    els.pdfCancel.disabled = false;
    els.pdfCancel.textContent = "Cancel";
    els.pdfClose.hidden = true;
  }

  function showPdfError(message) {
    els.pdfDialog.classList.add("is-error");
    els.pdfTitle.textContent = "PDF could not be created";
    els.pdfStatus.textContent = message;
    els.pdfHint.textContent = "Close this window and try again. Your checklist answers and photos remain saved in this browser.";
    els.pdfProgressFill.style.width = "100%";
    els.pdfProgress.setAttribute("aria-valuenow", "100");
    els.pdfCancel.hidden = true;
    els.pdfClose.hidden = false;
    els.pdfClose.focus();
  }

  function updatePdfProgress(done, total, label) {
    const percent = total ? Math.round((done / total) * 100) : 0;
    els.pdfProgressFill.style.width = `${percent}%`;
    els.pdfProgress.setAttribute("aria-valuenow", String(percent));
    if (label) els.pdfStatus.textContent = label;
  }

  async function waitForImages(root) {
    const images = Array.from(root.querySelectorAll("img"));
    await Promise.allSettled(
      images.map((image) => {
        if (image.complete && image.naturalWidth) {
          return typeof image.decode === "function" ? image.decode().catch(() => {}) : Promise.resolve();
        }
        return new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          image.addEventListener("load", finish, { once: true });
          image.addEventListener("error", finish, { once: true });
          window.setTimeout(finish, 5000);
        });
      })
    );
  }

  function pdfFilename() {
    const clean = (value) =>
      String(value || "")
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/^[. ]+|[. ]+$/g, "")
        .slice(0, 80);
    const branch = clean(state.branch) || "Branch not specified";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(state.date || "") ? state.date : todayISO();
    return `Branch Surprise Visit - ${branch} - ${date}.pdf`;
  }

  // Exposed for the build/test harness; the UI uses the same functions.
  window.__buildPrintReport = buildPrintReport;
  window.__downloadPdfReport = downloadPdfReport;

  initialize();
})();
