import { useState } from "react";
import { FileArchive, Loader2 } from "lucide-react";
import type { SkillSyncImportResult } from "@zcode/shared";
import type { ISkillSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { formatRemoteSkillSyncError } from "@/settings/RemoteSkillSyncDialog.js";
import { RemoteSkillSyncResultList } from "@/settings/RemoteSkillSyncResultList.js";

type Step = "pick" | "importing" | "complete";

/** 与服务端后缀校验保持同一判定，UI 先拦截避免一次无意义的 RPC。 */
export function isZipFilePath(filePath: string): boolean {
  return /\.zip$/iu.test(filePath.trim());
}

interface SkillZipImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 使用本机 base services 的 skillSyncService，导入目标是本机用户级 ~/.zcode/skills。 */
  skillSyncService: ISkillSyncService;
  onImported: () => Promise<void> | void;
}

export function SkillZipImportDialog({
  open,
  onOpenChange,
  skillSyncService,
  onImported,
}: SkillZipImportDialogProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [step, setStep] = useState<Step>("pick");
  const [result, setResult] = useState<SkillSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("pick");
    setResult(null);
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    // 导入进行中禁止关闭，避免用户误以为已取消而实际 host 仍在写盘。
    if (!nextOpen && step === "importing") {
      return;
    }
    if (nextOpen) {
      reset();
    }
    onOpenChange(nextOpen);
  };

  const selectAndImport = async () => {
    if (step === "importing") {
      return;
    }
    setError(null);
    const filePath = await platform.selectFile();
    // 用户取消文件选择视为无操作，保持弹窗当前状态。
    if (!filePath) {
      return;
    }
    if (!isZipFilePath(filePath)) {
      setError(intl.formatMessage({ id: "settings.skills.zipImport.notZipFile" }));
      return;
    }
    setStep("importing");
    try {
      const importResult = await skillSyncService.importSkillsZipArchive({ filePath });
      // 先失效 draft session 技能上下文并刷新列表，再展示结果，
      // 保证弹窗背后的技能列表与导入内容一致。
      await onImported();
      setResult(importResult);
      setStep("complete");
    } catch (importError) {
      setError(formatRemoteSkillSyncError(importError, intl));
      setStep("pick");
    }
  };

  const selectLabel = intl.formatMessage({ id: "settings.skills.zipImport.select" });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.skills.zipImport.title" })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "pick" ? (
            <>
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.skills.zipImport.description" })}
              </p>
              <div className="flex justify-end">
                <Button type="button" onClick={() => void selectAndImport()}>
                  <FileArchive className="size-3.5" aria-hidden="true" />
                  {selectLabel}
                </Button>
              </div>
            </>
          ) : null}
          {step === "importing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.skills.zipImport.importing" })}
            </div>
          ) : null}
          {step === "complete" && result ? (
            <>
              <RemoteSkillSyncResultList
                result={result}
                completeMessageId="settings.skills.zipImport.complete"
                statusMessageIdPrefix="settings.skills.zipImport"
              />
              {result.results.length === 0 ? (
                <p className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.skills.zipImport.emptyArchive" })}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  {intl.formatMessage({ id: "common.close" })}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
