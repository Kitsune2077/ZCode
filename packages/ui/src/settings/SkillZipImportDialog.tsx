import { useState } from "react";
import { FileArchive, Loader2 } from "lucide-react";
import type { SkillZipImportResult } from "@zcode/services";
import type { ISkillSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { formatRemoteSkillSyncError } from "@/settings/skillSyncErrorFormat.js";
import { RemoteSkillSyncResultList } from "@/settings/RemoteSkillSyncResultList.js";

type Step = "pick" | "importing" | "complete";

/** 涓庢湇鍔＄鍚庣紑鏍￠獙淇濇寔鍚屼竴鍒ゅ畾锛孶I 鍏堟嫤鎴伩鍏嶄竴娆℃棤鎰忎箟鐨?RPC銆?*/
export function isZipFilePath(filePath: string): boolean {
  return /\.zip$/iu.test(filePath.trim());
}

interface SkillZipImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 浣跨敤鏈満 base services 鐨?skillSyncService锛屽鍏ョ洰鏍囨槸鏈満鐢ㄦ埛绾?~/.zcode/skills銆?*/
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
  const [result, setResult] = useState<SkillZipImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("pick");
    setResult(null);
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    // 瀵煎叆杩涜涓姝㈠叧闂紝閬垮厤鐢ㄦ埛璇互涓哄凡鍙栨秷鑰屽疄闄?host 浠嶅湪鍐欑洏銆?
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
    // 鐢ㄦ埛鍙栨秷鏂囦欢閫夋嫨瑙嗕负鏃犳搷浣滐紝淇濇寔寮圭獥褰撳墠鐘舵€併€?
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
      // 鍏堝け鏁?draft session 鎶€鑳戒笂涓嬫枃骞跺埛鏂板垪琛紝鍐嶅睍绀虹粨鏋滐紝
      // 淇濊瘉寮圭獥鑳屽悗鐨勬妧鑳藉垪琛ㄤ笌瀵煎叆鍐呭涓€鑷淬€?
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