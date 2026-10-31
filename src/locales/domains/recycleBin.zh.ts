export const zh = {
  // ---- 抽屉头部 ----
  "recycleBin.title": "回收站",
  "recycleBin.description": "删除的账号会先移到这里，保留 30 天后自动清理；可随时恢复，或永久删除。",
  "recycleBin.close": "关闭",

  "recycleBin.loading": "正在加载回收站…",
  "recycleBin.loadFailed": "回收站加载失败",
  "recycleBin.empty.title": "回收站是空的",
  "recycleBin.empty.description": "删除的账号会先移到这里，30 天内都可以恢复。",
  // 空态四要素里的**出口**（缺出口等于把用户丢在原地）。
  "recycleBin.empty.action": "关闭",

  // ---- 条目 ----
  "recycleBin.entry.unnamed": "未命名账号",
  "recycleBin.entry.deletedLabel": "删除于",
  "recycleBin.entry.expiresLabel": "到期",

  // ---- 操作 ----
  "recycleBin.restore": "恢复",
  "recycleBin.purge": "永久删除",
  "recycleBin.clear": "清空回收站",
  "recycleBin.cancel": "取消",

  // ---- 永久删除的二次确认（唯一不可逆步）----
  "recycleBin.purge.title": "永久删除账号",
  "recycleBin.purge.desc": "将永久删除「{name}」，此操作不可恢复，并会一并删除其凭据 / 快照。",
  "recycleBin.purge.confirm": "永久删除",

  // ---- 清空的二次确认（批量 ⇒ 明示条数）----
  "recycleBin.clear.title": "清空回收站",
  "recycleBin.clear.desc": "将永久删除回收站中的 {n} 个账号，此操作不可恢复，并会一并删除它们的凭据 / 快照。",
  "recycleBin.clear.confirm": "清空",

  // ---- Toast ----
  "recycleBin.toast.restored": "账号已恢复",
  "recycleBin.toast.restoreFail": "恢复失败",
  "recycleBin.toast.purged": "已永久删除",
  "recycleBin.toast.purgeFail": "永久删除失败",
  "recycleBin.toast.cleared": "回收站已清空（{n} 项）",
  "recycleBin.toast.clearFail": "清空回收站失败",
} as const;
