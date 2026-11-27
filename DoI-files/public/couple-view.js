import {
  coupleAccountAction, coupleProfile, coupleSummary, resolveConflict, syncCouple,
} from "./couple.js";
import { formatDay } from "./dates.js";

let displayedCode = null;
let busy = false;

export function coupleStatusText(profile, summary) {
  if (summary.lastError) return summary.lastError;
  if (!summary.checked) return "正在检查联机状态。";
  if (profile.space?.paired) {
    const conflicts = new Set(summary.queue.filter(({ error }) => error).map(({ id }) => id)).size;
    const pending = summary.queue.filter(({ error }) => !error).length;
    if (conflicts) return conflicts + " 条记录需要处理同步冲突。";
    if (pending) return pending + " 项改动待同步。";
    if (summary.syncing) return "正在同步。";
    return "配对成功，已同步。";
  }
  return profile.space ? "等待伴侣加入。" : "可使用邀请码加入，或恢复已有账号。";
}

export async function coupleView(ui) {
  const { element, button, labeledField, heading, notify, refresh, back, openShared, exportShared } = ui;
  const profile = coupleProfile();
  const summary = await coupleSummary();
  const status = element("p", "range couple-status", coupleStatusText(profile, summary));
  status.id = "couple-status";
  status.setAttribute("role", "status");

  async function action(run, control) {
    if (busy) return;
    busy = true;
    control.disabled = true;
    try {
      const result = await run();
      const accountId = coupleProfile().accountId;
      if (result?.inviteCode) displayedCode = { kind: "invite", accountId, value: result.inviteCode };
      if (result?.recoveryCode) displayedCode = { kind: "recovery", accountId, value: result.recoveryCode };
      if (result?.profile && !result.profile.accountId) displayedCode = null;
      refresh();
    } catch (error) {
      notify(error.message || "操作失败，请重试。", true);
    } finally {
      busy = false;
      control.disabled = false;
    }
  }

  function form(title, field, route, fieldName) {
    const input = element("input", "input code-input");
    input.type = "password";
    input.required = true;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    const submit = element("button", "button primary", title);
    submit.type = "submit";
    const entry = element("form", "couple-form", labeledField(field, input), submit);
    entry.addEventListener("submit", (event) => {
      event.preventDefault();
      void action(() => coupleAccountAction(route, { [fieldName]: input.value.trim() }), submit);
    });
    return entry;
  }

  function accountButton(label, route, payload, confirmMessage) {
    const control = button(label, () => {
      if (confirmMessage && !window.confirm(confirmMessage)) return;
      if (route === "leave") displayedCode = null;
      void action(() => coupleAccountAction(route, payload), control);
    }, route === "leave" ? "button danger" : "button secondary");
    return control;
  }

  function codeCard() {
    if (!displayedCode || displayedCode.accountId !== profile.accountId) return null;
    const { kind, value } = displayedCode;
    if (kind === "invite" && (!profile.space || profile.space.paired)) return null;
    const title = kind === "invite" ? "邀请码（24 小时内一次有效）" : "你的恢复码";
    const copy = button("复制", async () => {
      try {
        await navigator.clipboard.writeText(value);
        notify("已复制。");
      } catch {
        notify("可以长按上方文字复制。", true);
      }
    }, "button secondary");
    const close = button("收起", () => {
      displayedCode = null;
      refresh();
    }, "button quiet");
    return element("section", "card settings-card",
      element("h2", "", title),
      element("code", "couple-code", value),
      kind === "recovery" ? element("p", "range", "请自行保存。换手机或清除网页数据后，用它恢复账号。") : null,
      element("div", "settings-actions", copy, close),
    );
  }

  const cards = [
    button("‹ 返回设置", back, "back-button"),
    heading("情侣空间"),
    element("section", "card settings-card",
      element("h2", "", profile.space?.paired ? "你们已配对" : "双人配对"),
      status,
      profile.space?.paired ? element("div", "settings-actions",
        button("打开共享月历", openShared, "button primary"),
        button("立即同步", async () => { await syncCouple(); refresh(); }, "button secondary"),
      ) : null,
    ),
    codeCard(),
  ];

  if (!profile.accountId) {
    cards.push(
      element("section", "card settings-card", element("h2", "", "用邀请码加入"), form("加入空间", "邀请码", "join", "inviteCode")),
      element("section", "card settings-card", element("h2", "", "恢复账号"), form("恢复账号", "恢复码", "recover", "recoveryCode")),
      element("details", "card settings-card",
        element("summary", "", "首次开通"),
        form("创建空间", "开通码", "bootstrap", "setupCode"),
      ),
    );
    return cards;
  }

  if (!profile.space) {
    cards.push(element("section", "card settings-card",
      element("h2", "", "加入或创建"),
      form("加入空间", "邀请码", "join", "inviteCode"),
      element("div", "settings-actions", accountButton("创建新空间", "new-space", {})),
    ));
  } else if (!profile.space.paired) {
    cards.push(element("section", "card settings-card",
      element("h2", "", "邀请伴侣"),
      element("p", "range", "将一次性邀请码交给对方。对方加入后，双方可以使用共享月历。"),
      element("div", "settings-actions", accountButton("生成邀请码", "invite", {})),
    ));
  }

  const conflicts = [...new Map(summary.queue.filter(({ error }) => error).map((op) => [op.id, op])).values()];
  for (const op of conflicts) {
    const pending = summary.queue.filter((item) => item.id === op.id && item.record).at(-1);
    const keep = button("另存为本机记录", () => void action(() => resolveConflict(op.id, true), keep), "button secondary");
    const discard = button("采用云端版本", () => {
      if (window.confirm("确定舍弃这条记录待同步的本机修改？")) {
        void action(() => resolveConflict(op.id, false), discard);
      }
    }, "button quiet");
    cards.push(element("section", "card settings-card",
      element("h2", "", pending ? formatDay(pending.record.occurredOn, true) + "的记录" : "待处理的删除"),
      element("p", "range", op.error),
      element("div", "settings-actions", pending ? keep : null, discard),
    ));
  }

  if (profile.space) {
    const leave = accountButton(
      profile.space.paired ? "解除配对" : "关闭邀请空间", "leave", { spaceId: profile.space.id },
      "确定关闭这个空间？双方将失去对该空间的联机访问。需要的共享记录可先导出。",
    );
    cards.push(element("section", "card settings-card",
      element("h2", "", "共享资料"),
      element("div", "settings-actions",
        profile.space.paired ? button("导出共享备份", exportShared, "button secondary") : null,
        leave,
      ),
    ));
  }
  cards.push(element("section", "card settings-card",
    element("h2", "", "当前账号"),
    element("div", "settings-actions",
      accountButton("更换恢复码", "recovery", {}, "更换后原恢复码失效。确定继续？"),
      accountButton("退出登录", "logout", {}),
    ),
  ));
  return cards;
}
