/**
 * NewAPI 冷启动模型同步的 Toast 文案选择（纯函数）。
 *
 * 规则见 docs/newapi-provider-provisioning.md「冷启动模型同步」：只有存在差异才提示，
 * 且按「仅新增 / 仅移除 / 两者都有」选择文案，避免出现"新增 2、移除 0"这种占位符噪音。
 */
export type NewApiModelSyncToastMessageId =
  | "newapi.modelSync.toast.added"
  | "newapi.modelSync.toast.removed"
  | "newapi.modelSync.toast.addedAndRemoved";

/** 返回 null 表示不需要任何提示（无差异）。 */
export function pickNewApiModelSyncToastMessageId(
  addedCount: number,
  removedCount: number,
): NewApiModelSyncToastMessageId | null {
  if (addedCount <= 0 && removedCount <= 0) {
    return null;
  }
  if (addedCount > 0 && removedCount > 0) {
    return "newapi.modelSync.toast.addedAndRemoved";
  }
  return addedCount > 0 ? "newapi.modelSync.toast.added" : "newapi.modelSync.toast.removed";
}
