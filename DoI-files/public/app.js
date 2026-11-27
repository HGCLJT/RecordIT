import {
  currentTimeSlot, dayKey, dayNumber, formatDay, formatMonth, localDay, monthBounds,
  shiftMonth, statsRange, timeSlotLabel, timeSlots, weekday, weekdays,
} from "./dates.js";
import {
  addRecord, databaseEvents, deleteRecord, getNickname, getRecord, getRecords,
  mergeRecords, previewMerge, RecordConflict, saveNickname, updateRecord,
} from "./db.js";
import { buildHeatmap, calculateStats } from "./stats.js";
import { downloadBackup, parseBackup, prepareBackup, supportsFileShare } from "./backup.js";
import { chooseAndroidBackup, hasAndroidDocuments, saveAndroidBackup } from "./android.js";
import {
  coupleEvents, coupleProfile, coupleSummary, deleteSharedRecord, initialiseCouple,
  saveSharedRecord, sharedRecord, sharedRecords, syncCouple,
} from "./couple.js";
import { coupleView, coupleStatusText } from "./couple-view.js";
import { albumView } from "./album-view.js";

const page = document.querySelector("#page");
const tabbar = document.querySelector("#tabbar");
const sheet = document.querySelector("#sheet");
const notice = document.querySelector("#notice");
const cacheState = document.querySelector("#cache-state");
const todayAtLaunch = localDay();

const state = {
  view: "calendar",
  scope: "local",
  calendarMonth: todayAtLaunch.slice(0, 7),
  selectedDay: todayAtLaunch,
  historyMonth: todayAtLaunch.slice(0, 7),
  statsMonth: "recent",
  detailId: null,
  detailOrigin: "calendar",
};
let renderToken = 0;
let noticeTimer;
let sheetBusy = false;

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function button(label, activate, className = "button") {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", activate);
  return node;
}

function heading(title, action = null) {
  return element("div", "page-heading", element("h1", "", title), action);
}

function emptyState(message) {
  return element("p", "empty-state", message);
}

function notify(message, isError = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.dataset.kind = isError ? "error" : "success";
  notice.hidden = false;
  if (!isError) noticeTimer = setTimeout(() => { notice.hidden = true; }, 3500);
}

function switchView(view) {
  state.view = view;
  if (view === "history") state.historyMonth = localDay().slice(0, 7);
  window.scrollTo(0, 0);
  void render(true);
}

function showDay(day) {
  state.calendarMonth = day.slice(0, 7);
  state.selectedDay = day;
  switchView("calendar");
}

function showDetail(id, origin) {
  state.detailId = id;
  state.detailOrigin = origin;
  switchView("detail");
}

function returnFromDetail() {
  state.view = state.detailOrigin;
  state.detailId = null;
  window.scrollTo(0, 0);
  void render(true);
}

function compareRecords(a, b) {
  return b.occurredOn.localeCompare(a.occurredOn) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id);
}

function recordList(records, origin, emptyMessage) {
  if (!records.length) return emptyState(emptyMessage);

  const items = [...records].sort(compareRecords).map((record) => {
    const summary = [
      timeSlotLabel(record.timeSlot),
      record.durationMinutes === null ? "" : record.durationMinutes + " 分钟",
    ].filter(Boolean).join(" · ");
    const row = button("", () => showDetail(record.id, origin), "record-row");
    row.append(
      element("span", "record-date", formatDay(record.occurredOn)),
      summary ? element("span", "record-summary", summary) : element("span", "record-summary"),
      element("span", "chevron", "›"),
    );
    row.lastElementChild.setAttribute("aria-hidden", "true");
    return element("li", "", row);
  });
  return element("ul", "record-list", items);
}

function listRecords(range) {
  return state.scope === "shared" ? sharedRecords(range) : getRecords(range);
}

function scopeControls() {
  if (!coupleProfile().space?.paired) return null;
  const tabs = ["local", "shared"].map((scope) => {
    const control = button(scope === "local" ? "本机记录" : "两人共享", () => {
      state.scope = scope;
      void render();
      if (scope === "shared") void syncCouple();
    }, "choice");
    control.setAttribute("aria-pressed", String(state.scope === scope));
    return control;
  });
  return element("div", "record-scope", tabs);
}

function monthControls(month, onChange, today) {
  const previous = button("‹", () => onChange(shiftMonth(month, -1)), "arrow");
  previous.setAttribute("aria-label", "上个月");
  previous.disabled = shiftMonth(month, -1) === month;
  const next = button("›", () => onChange(shiftMonth(month, 1)), "arrow");
  next.setAttribute("aria-label", "下个月");
  next.disabled = month >= today.slice(0, 7);
  return element("div", "month-controls", element("h2", "", formatMonth(month)), previous, next);
}

async function calendarView() {
  const today = localDay();
  const month = state.calendarMonth;
  const selected = state.selectedDay;
  const range = monthBounds(month);
  const records = await listRecords(range);
  const marked = new Set(records.map(({ occurredOn }) => occurredOn));
  const start = dayNumber(range.start);
  const end = dayNumber(range.end);
  const cells = weekdays.map((value) => element("span", "weekday", value));
  const offset = weekday(start);
  for (let index = 0; index < offset; index++) cells.push(element("span", "day-spacer"));

  for (let ordinal = start; ordinal <= end; ordinal++) {
    const date = dayKey(ordinal);
    const hasRecords = marked.has(date);
    const cell = button(String(Number(date.slice(8))), () => {
      state.selectedDay = date;
      void render();
    }, "day");
    cell.setAttribute("aria-pressed", String(date === selected));
    cell.setAttribute("aria-label", formatDay(date, true) + (hasRecords ? "，有记录" : ""));
    if (date === today) cell.setAttribute("aria-current", "date");
    if (hasRecords) cell.append(element("span", "day-dot"));
    cells.push(cell);
  }

  const changeMonth = (value) => {
    state.calendarMonth = value;
    state.selectedDay = value === today.slice(0, 7) ? today : null;
    void render();
  };
  const dateGrid = element("div", "calendar-grid", cells);
  const monthCard = element("section", "card calendar-card",
    element("div", "calendar-toolbar",
      monthControls(month, changeMonth, today),
      button("今天", () => showDay(localDay()), "small-button"),
    ),
    dateGrid,
  );

  const add = button("+ 新建记录", () => openRecordForm(localDay()), "button primary");
  const history = button("历史记录 ›", () => switchView("history"), "button quiet");
  const dateTitle = selected ? formatDay(selected) : "当天记录";
  const items = selected ? records.filter(({ occurredOn }) => occurredOn === selected) : [];
  const append = selected && selected <= today && selected !== today
    ? button("补记", () => openRecordForm(selected), "small-button") : null;
  return [
    heading("月历", add),
    scopeControls(),
    monthCard,
    element("section", "day-section",
      element("div", "section-heading",
        element("div", "section-name", element("h2", "", dateTitle),
          items.length ? element("span", "count", items.length + " 条") : null),
        append,
        history,
      ),
      selected ? recordList(items, "calendar", "当天还没有记录。") : emptyState("选择日期后查看当天记录。"),
    ),
  ];
}

async function historyView() {
  const month = state.historyMonth;
  const today = localDay();
  const records = await listRecords(monthBounds(month));
  return [
    button("‹ 返回月历", () => switchView("calendar"), "back-button"),
    heading("历史记录"),
    scopeControls(),
    element("section", "card history-card", monthControls(month, (nextMonth) => {
      state.historyMonth = nextMonth;
      void render();
    }, today)),
    recordList(records, "history", "这个月还没有记录。"),
  ];
}

function detailField(term, value, className) {
  if (!value) return null;
  return element("div", "detail-field", element("dt", "", term), element("dd", className, value));
}

async function detailView() {
  const shared = state.scope === "shared";
  const profile = coupleProfile();
  const [record, nickname] = await Promise.all([
    shared ? sharedRecord(state.detailId) : getRecord(state.detailId),
    getNickname(),
  ]);
  const back = button("‹ 返回列表", returnFromDetail, "back-button");
  if (!record) return [back, heading("记录详情"), emptyState("这条记录已不存在。")];

  const editable = !shared || record.authorId === profile.accountId;
  const edit = editable ? button("编辑", () => openRecordForm(record.occurredOn, record), "button primary") : null;
  const remove = editable ? button("删除记录", async () => {
    if (!window.confirm("确定删除这条记录？")) return;
    remove.disabled = true;
    try {
      if (shared) await deleteSharedRecord(record, profile);
      else await deleteRecord(record);
      notify(shared ? "删除已保存，等待同步。" : "记录已删除。");
      returnFromDetail();
    } catch (error) {
      notify(error instanceof DOMException ? "删除失败，请重试。" : error.message, true);
      remove.disabled = false;
    }
  }, "button danger") : null;
  const share = !shared && profile.space?.paired ? button("共享这条旧记录", async () => {
    if (!window.confirm("将整条记录连同感受与备注共享给伴侣？")) return;
    share.disabled = true;
    try {
      await saveSharedRecord(record, null, profile);
      notify("记录已加入共享空间，等待同步。");
    } catch (error) {
      notify(error.message || "未能共享记录。", true);
    } finally {
      share.disabled = false;
    }
  }, "button secondary") : null;

  return [
    back,
    heading("记录详情", edit),
    element("section", "card detail-card",
      element("dl", "detail-list",
        detailField("日期", formatDay(record.occurredOn, true)),
        shared
          ? detailField("添加人", record.authorId === profile.accountId ? "你" : nickname || "伴侣")
          : detailField("伴侣", nickname),
        detailField("时段", timeSlotLabel(record.timeSlot)),
        detailField("时长", record.durationMinutes === null ? "" : record.durationMinutes + " 分钟"),
        detailField("感受与备注", record.note, "note-text"),
      ),
    ),
    element("div", "settings-actions", share, remove),
  ];
}

function labeledField(label, input, name) {
  return element("label", "field", element("span", "field-label", label), input, name);
}

function sheetLayout(title, body, footer, wrapper = element("div", "sheet-layout")) {
  if (sheet.open) return;
  const name = element("h2", "", title);
  name.id = "sheet-title";
  const dismiss = button("×", closeSheet, "icon-button");
  dismiss.setAttribute("aria-label", "关闭");
  wrapper.append(
    element("div", "sheet-heading", name, dismiss),
    element("div", "sheet-body", ...body),
    element("div", "sheet-footer", ...footer),
  );
  sheet.replaceChildren(wrapper);
  sheet.showModal();
}

function closeSheet() {
  if (!sheetBusy) sheet.close();
}

sheet.addEventListener("cancel", (event) => {
  if (sheetBusy) event.preventDefault();
});

function fitSheetToViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  sheet.style.setProperty("--available-height", Math.round(viewport.height) + "px");
  const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  sheet.style.setProperty("--keyboard-offset", Math.round(offset) + "px");
}

window.visualViewport?.addEventListener("resize", fitSheetToViewport);
window.visualViewport?.addEventListener("scroll", fitSheetToViewport);
fitSheetToViewport();

function openRecordForm(initialDay, original = null) {
  const shared = state.scope === "shared";
  const profile = coupleProfile();
  const now = new Date();
  const today = localDay(now);
  const draftId = original?.id ?? crypto.randomUUID();
  let automatic = !original && initialDay === today;
  let chosenSlot = original?.timeSlot ?? (automatic ? currentTimeSlot(now) : null);
  const form = element("form", "sheet-layout");
  form.noValidate = true;
  const dateInput = element("input", "input");
  dateInput.type = "date";
  dateInput.name = "occurredOn";
  dateInput.max = today;
  dateInput.value = initialDay;
  dateInput.required = true;

  const slotButtons = timeSlots.map(({ id, label }) => {
    const item = button(label, () => {
      automatic = false;
      chosenSlot = chosenSlot === id ? null : id;
      syncSlots();
    }, "choice");
    item.dataset.slot = id;
    return item;
  });
  function syncSlots() {
    for (const item of slotButtons) item.setAttribute("aria-pressed", String(item.dataset.slot === chosenSlot));
  }
  syncSlots();
  dateInput.addEventListener("input", () => {
    if (automatic && dateInput.value && dateInput.value < localDay()) {
      automatic = false;
      chosenSlot = null;
      syncSlots();
    }
  });
  const slotGroup = element("fieldset", "field",
    element("legend", "field-label", "发生时段"), element("div", "choices", slotButtons),
  );

  const durationInput = element("input", "input");
  durationInput.type = "text";
  durationInput.inputMode = "numeric";
  durationInput.name = "durationMinutes";
  durationInput.placeholder = "分钟";
  durationInput.value = original?.durationMinutes ?? "";
  const durationChoices = [10, 20, 30].map((minutes) => {
    const choice = button(minutes + " 分钟", () => {
      durationInput.value = minutes;
      syncDuration();
    }, "choice");
    choice.dataset.minutes = minutes;
    return choice;
  });
  function syncDuration() {
    for (const choice of durationChoices) {
      choice.setAttribute("aria-pressed", String(choice.dataset.minutes === durationInput.value));
    }
  }
  syncDuration();
  durationInput.addEventListener("input", syncDuration);
  durationInput.setAttribute("aria-label", "时长（分钟）");
  const durationGroup = element("fieldset", "field",
    element("legend", "field-label", "时长"),
    element("div", "choices", durationChoices),
    durationInput,
  );

  const noteInput = element("textarea", "input textarea");
  noteInput.name = "note";
  noteInput.rows = 4;
  noteInput.value = original?.note ?? "";
  noteInput.placeholder = "写下当时的感受或其他细节";
  const feedback = element("p", "inline-error");
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;
  const submit = element("button", "button primary full-width", original ? "保存修改" : "新建记录");
  submit.type = "submit";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sheetBusy) return;
    feedback.hidden = true;
    const durationText = durationInput.value.trim();
    if (!Number.isFinite(dayNumber(dateInput.value))) {
      feedback.textContent = "请选择有效的日期。";
      feedback.hidden = false;
      return;
    }
    if (durationText && !/^\d+$/.test(durationText)) {
      feedback.textContent = "时长请输入正整数分钟。";
      feedback.hidden = false;
      return;
    }

    const date = dateInput.value;
    const timestamp = new Date().toISOString();
    const fields = {
      id: draftId,
      occurredOn: date,
      timeSlot: chosenSlot,
      durationMinutes: durationText ? Number(durationText) : null,
      note: noteInput.value,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    sheetBusy = true;
    submit.disabled = true;
    try {
      if (shared) await saveSharedRecord(fields, original, profile);
      else if (original) await updateRecord(original, fields);
      else await addRecord(fields);
      sheet.close();
      notify(shared ? "已保存到本机，等待同步。" : "记录已保存。");
      if (original) void render();
      else showDay(date);
    } catch (error) {
      const message = error instanceof DOMException ? "保存失败，请重试。" : error.message;
      feedback.textContent = message;
      feedback.hidden = false;
      if (error instanceof RecordConflict) {
        feedback.textContent = error.message + " 可先复制已填写的备注。";
      }
    } finally {
      sheetBusy = false;
      submit.disabled = false;
    }
  });

  sheetLayout(original ? "编辑记录" : "新建记录",
    [shared ? element("p", "range", "整条记录（含感受与备注）将对双方可见。") : null,
      labeledField("日期", dateInput), slotGroup, durationGroup, labeledField("感受与备注", noteInput)],
    [feedback, submit], form);
}

function formatRange({ start, end }) {
  return formatDay(start, true) + " – " + formatDay(end, start.slice(0, 4) !== end.slice(0, 4));
}

function metric(label, value, unit) {
  return element("div", "metric",
    element("dt", "", label),
    element("dd", "", element("strong", "", String(value)), element("span", "", unit)),
  );
}

function renderHeatmap(heatmap, range) {
  const cells = Array.from({ length: heatmap.offset }, () => element("span", "heatmap-spacer"));
  for (const { date, count } of heatmap.days) {
    const cell = button("", () => showDay(date), "heatmap-cell");
    cell.dataset.level = String(Math.min(count, 3));
    const label = formatDay(date, true) + "，" + count + " 次";
    cell.setAttribute("aria-label", label);
    cell.title = label;
    cells.push(cell);
  }
  const scroller = element("div", "heatmap-scroll", element("div", "heatmap", cells));
  scroller.setAttribute("aria-label", "每日记录热力图，可横向滚动");
  scroller.tabIndex = 0;
  const legend = element("div", "heatmap-legend", [0, 1, 2, 3].map((level) => {
    const key = element("span", "legend-key");
    key.dataset.level = level;
    return element("span", "", key, level === 3 ? "3+" : String(level));
  }));
  return element("section", "card stat-card",
    element("div", "section-heading", element("h2", "", "近一年热力图"), legend),
    element("p", "range", formatRange(range)),
    scroller,
  );
}

function barList(items, unit = " 次") {
  const largest = Math.max(1, ...items.map(({ count }) => count));
  return element("ul", "bars", items.map(({ label, count }) => {
    const fill = element("span", "bar-fill");
    fill.style.width = (count / largest * 100) + "%";
    const track = element("span", "bar-track", fill);
    track.setAttribute("aria-hidden", "true");
    return element("li", "bar-row", element("span", "", label), track, element("span", "bar-value", count + unit));
  }));
}

async function statsView() {
  const today = localDay();
  const month = state.statsMonth;
  const recent = statsRange("recent", today);
  const range = statsRange(month, today);
  const recentPromise = listRecords(recent);
  const [records, heatmapRecords] = await Promise.all([month === "recent" ? recentPromise : listRecords(range), recentPromise]);
  const stats = calculateStats(records, range);
  const heatmap = buildHeatmap(heatmapRecords, recent);

  const monthInput = element("input", "input month-input");
  monthInput.type = "month";
  monthInput.value = month === "recent" ? today.slice(0, 7) : month;
  monthInput.max = today.slice(0, 7);
  monthInput.setAttribute("aria-label", "选择统计月份");
  monthInput.addEventListener("change", () => {
    const value = monthInput.value;
    if (!Number.isFinite(dayNumber(value + "-01")) || value > today.slice(0, 7)) {
      monthInput.value = month === "recent" ? today.slice(0, 7) : month;
      return;
    }
    state.statsMonth = value;
    void render();
  });

  const recentButton = button("近一年", () => {
    state.statsMonth = "recent";
    void render();
  }, "choice");
  recentButton.setAttribute("aria-pressed", String(month === "recent"));
  const chooseMonth = button("按月", () => {
    state.statsMonth = monthInput.value || today.slice(0, 7);
    void render();
  }, "choice");
  chooseMonth.setAttribute("aria-pressed", String(month !== "recent"));
  const rangeControls = element("div", "stat-controls", recentButton, chooseMonth, monthInput);
  const durationContent = stats.duration.samples
    ? [
        element("p", "stat-highlight", stats.duration.mean.toFixed(1) + " 分钟"),
        element("p", "range", stats.duration.samples + " 条记录填写了时长"),
        barList(stats.duration.buckets),
      ]
    : emptyState("暂无时长数据。");
  const timeContent = stats.timeSamples ? barList(stats.byTimeSlot) : emptyState("暂无时段数据。");

  return [
    heading("统计"),
    scopeControls(),
    element("section", "card stat-card",
      rangeControls, element("p", "range", formatRange(range)),
      element("dl", "metric-grid",
        metric("记录次数", stats.total, "次"),
        metric("周均", stats.weeklyAverage.toFixed(2), "次"),
        metric("有记录的天数", stats.activeDays, "天"),
      ),
    ),
    renderHeatmap(heatmap, recent),
    element("div", "stat-grid",
      element("section", "card stat-card",
        element("h2", "", "平均时长"),
        element("p", "range", formatRange(range)),
        durationContent,
      ),
      element("section", "card stat-card",
        element("h2", "", "连续记录"),
        element("p", "range", formatRange(range)),
        element("p", "stat-highlight", stats.longestStreak + " 天"),
        element("p", "range", "最长连续有记录天数"),
      ),
    ),
    element("div", "stat-grid",
      element("section", "card stat-card",
        element("h2", "", "星期分布"),
        element("p", "range", formatRange(range)),
        barList(stats.byWeekday),
      ),
      element("section", "card stat-card",
        element("h2", "", "时段分布"),
        element("p", "range", formatRange(range)),
        timeContent,
        element("p", "range", "未填写 " + stats.unspecified + " 次"),
      ),
    ),
  ];
}

function openBackupExport(file) {
  const actions = [];
  const nativeDocuments = hasAndroidDocuments();
  if (nativeDocuments || supportsFileShare(file)) {
    const share = button("保存到文件", async () => {
      if (sheetBusy) return;
      sheetBusy = true;
      share.disabled = true;
      try {
        if (nativeDocuments) {
          if (!await saveAndroidBackup(file)) return;
        } else {
          await navigator.share({ files: [file] });
        }
        sheet.close();
      } catch (error) {
        if (error.name !== "AbortError") {
          errorState.textContent = nativeDocuments ? error.message : "系统保存不可用，请选择下载。";
        }
      } finally {
        sheetBusy = false;
        share.disabled = false;
      }
    }, "button primary");
    actions.push(share);
  }
  const errorState = element("p", "inline-error");
  errorState.setAttribute("role", "status");
  if (!nativeDocuments) {
    actions.push(button("下载 JSON", () => {
      if (sheetBusy) return;
      downloadBackup(file);
      closeSheet();
    }, actions.length ? "button secondary" : "button primary"));
  }
  sheetLayout("导出备份", [element("p", "file-name", file.name), errorState], actions);
}

function openRestorePreview(records, preview) {
  const feedback = element("p", "inline-error");
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;
  const restore = button("确认恢复", async () => {
    if (sheetBusy) return;
    sheetBusy = true;
    restore.disabled = true;
    feedback.hidden = true;
    try {
      const result = await mergeRecords(records);
      sheet.close();
      notify("恢复完成，新增 " + result.added + " 条，跳过 " + result.skipped + " 条。");
    } catch {
      feedback.textContent = "未能恢复此备份，原记录已保留。";
      feedback.hidden = false;
    } finally {
      sheetBusy = false;
      restore.disabled = false;
    }
  }, "button primary");
  sheetLayout("恢复预览",
    [element("dl", "metric-grid preview-metrics", metric("预计新增", preview.added, "条"), metric("预计跳过", preview.skipped, "条"))],
    [feedback, button("取消", closeSheet, "button secondary"), restore]);
}

async function settingsView() {
  const nickname = await getNickname();
  const nicknameInput = element("input", "input");
  nicknameInput.type = "text";
  nicknameInput.name = "partnerNickname";
  nicknameInput.autocomplete = "off";
  nicknameInput.value = nickname;
  nicknameInput.placeholder = "选填";
  const submit = element("button", "button secondary", "保存昵称");
  submit.type = "submit";
  const profile = element("form", "profile-form", labeledField("伴侣昵称", nicknameInput), submit);
  profile.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      nicknameInput.value = await saveNickname(nicknameInput.value);
      notify("昵称已保存。");
    } catch {
      notify("未能保存昵称，请重试。", true);
    } finally {
      submit.disabled = false;
    }
  });

  const backupFile = element("input", "");
  backupFile.type = "file";
  backupFile.accept = ".json,application/json";
  backupFile.hidden = true;
  const exportButton = button("导出 JSON", async () => {
    exportButton.disabled = true;
    try {
      const file = await prepareBackup();
      if (state.view === "settings" && exportButton.isConnected) openBackupExport(file);
    } catch {
      notify("未能准备备份，请重试。", true);
    } finally {
      exportButton.disabled = false;
    }
  }, "button secondary");
  const restoreButton = button("从备份恢复", () => {
    if (hasAndroidDocuments()) void restoreFrom(chooseAndroidBackup);
    else backupFile.click();
  }, "button secondary");
  backupFile.addEventListener("change", () => {
    const file = backupFile.files[0];
    backupFile.value = "";
    if (file) void restoreFrom(() => file);
  });

  async function restoreFrom(getFile) {
    restoreButton.disabled = true;
    try {
      const file = await getFile();
      if (!file) return;
      const records = await parseBackup(file);
      const preview = await previewMerge(records);
      if (state.view === "settings" && restoreButton.isConnected) openRestorePreview(records, preview);
    } catch (error) {
      notify(error instanceof DOMException ? "未能读取备份。" : error.message, true);
    } finally {
      restoreButton.disabled = false;
    }
  }

  return [
    heading("设置"),
    element("section", "card settings-card",
      element("div", "section-heading",
        element("h2", "", "情侣空间"),
        button("打开 ›", () => switchView("couple"), "button quiet"),
      ),
    ),
    element("section", "card settings-card", profile),
    element("section", "card settings-card",
      element("h2", "", "备份与恢复"),
      element("p", "range", "以普通 JSON 文件导出或恢复本机记录。"),
      element("div", "settings-actions", exportButton, restoreButton),
      backupFile,
    ),
  ];
}

function openCoupleView() {
  return coupleView({
    element, button, labeledField, heading, notify,
    refresh: () => { if (state.view === "couple") void render(); },
    back: () => switchView("settings"),
    openShared: () => {
      state.scope = "shared";
      showDay(localDay());
      void syncCouple();
    },
    exportShared: async () => {
      try {
        const file = await prepareBackup(await sharedRecords());
        if (state.view === "couple") openBackupExport(file);
      } catch {
        notify("未能准备共享备份。", true);
      }
    },
  });
}

function openAlbumView() {
  return albumView(coupleProfile(), {
    element, button, heading, emptyState, sheet, sheetLayout, notify,
    setSheetBusy: (busy) => { sheetBusy = busy; },
    openCouple: () => switchView("couple"),
  });
}

const views = {
  calendar: calendarView, history: historyView, detail: detailView, stats: statsView, settings: settingsView,
  couple: openCoupleView, album: openAlbumView,
};

async function render(focus = false) {
  const token = ++renderToken;
  const view = state.view;
  const activeTab = view === "history" || view === "detail" ? "calendar" : view === "couple" ? "settings" : view;
  for (const tab of tabbar.querySelectorAll("button")) {
    if (tab.dataset.view === activeTab) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  const priorHeatmapScroll = view === "stats" ? page.querySelector(".heatmap-scroll")?.scrollLeft : undefined;
  page.setAttribute("aria-busy", "true");
  try {
    const content = await views[view]();
    if (token !== renderToken) return;
    page.replaceChildren(...content.filter((node) => node !== null && node !== undefined));
    const heatmapScroll = page.querySelector(".heatmap-scroll");
    if (heatmapScroll) heatmapScroll.scrollLeft = priorHeatmapScroll ?? heatmapScroll.scrollWidth;
    if (focus) page.focus({ preventScroll: true });
  } catch (error) {
    if (token !== renderToken) return;
    const message = error.name === "VersionError"
      ? "应用版本需要更新。请关闭 DoI 后重新打开。"
      : "无法打开本机数据。";
    page.replaceChildren(emptyState(message), button("重试", () => void render(), "button secondary"));
  } finally {
    if (token === renderToken) page.removeAttribute("aria-busy");
  }
}

for (const tab of tabbar.querySelectorAll("button")) {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
}

databaseEvents.addEventListener("blocked", () => {
  notify("数据升级等待中。请关闭其他 DoI 页面。", true);
});
databaseEvents.addEventListener("versionchange", () => {
  notify("数据版本已更新，请关闭 DoI 后重新打开。", true);
});

function setCacheState(message, status) {
  cacheState.textContent = message;
  cacheState.dataset.state = status;
  cacheState.hidden = false;
}

async function enableOffline() {
  if (!("serviceWorker" in navigator)) {
    setCacheState("离线不可用", "warning");
    return;
  }
  setCacheState("准备离线资源", "pending");
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
    const displayState = () => {
      if (registration.waiting && registration.active) {
        setCacheState("新版就绪 · 重开更新", "ready");
      } else if (registration.active?.state === "activated") {
        setCacheState("离线可用", "ready");
      }
    };
    const watch = (worker) => {
      worker?.addEventListener("statechange", () => {
        if (worker.state === "redundant" && !registration.active) {
          setCacheState("缓存失败 · 联网重开", "warning");
        } else {
          displayState();
        }
      });
    };
    watch(registration.installing);
    registration.addEventListener("updatefound", () => watch(registration.installing));
    navigator.serviceWorker.addEventListener("controllerchange", displayState);
    void navigator.serviceWorker.ready.then(displayState);
    displayState();
  } catch {
    setCacheState("缓存失败 · 联网重开", "warning");
  }
}

let pairedSpaceId = null;
coupleEvents.addEventListener("change", async (event) => {
  const profile = coupleProfile();
  if (event.detail === "profile") {
    const nextSpaceId = profile.space?.paired ? profile.space.id : null;
    if (nextSpaceId !== pairedSpaceId) {
      pairedSpaceId = nextSpaceId;
      state.scope = nextSpaceId ? "shared" : "local";
      if (state.view === "detail") state.view = "calendar";
    }
    if (state.view === "album" && sheet.open) sheet.close();
    if (state.view !== "settings") void render();
  } else if (event.detail === "records" &&
    (state.view === "couple" ||
      (state.scope === "shared" && ["calendar", "history", "detail", "stats"].includes(state.view))) && !sheet.open) {
    void render();
  } else if (state.view === "couple") {
    const status = document.querySelector("#couple-status");
    if (status) status.textContent = coupleStatusText(profile, await coupleSummary());
  }
});

function syncIfActive() {
  if (!document.hidden && coupleProfile().accountId) void syncCouple();
}
window.addEventListener("online", syncIfActive);
document.addEventListener("visibilitychange", syncIfActive);
setInterval(syncIfActive, 30_000);

window.addEventListener("doi:android-back", (event) => {
  if (sheet.open) {
    event.preventDefault();
    closeSheet();
  } else if (state.view !== "calendar") {
    event.preventDefault();
    if (state.view === "detail") returnFromDetail();
    else switchView(state.view === "couple" ? "settings" : "calendar");
  }
});

void render();
void enableOffline();
void initialiseCouple().catch(() => {});
