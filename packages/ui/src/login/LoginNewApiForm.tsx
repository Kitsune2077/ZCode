import { useState } from "react";
import type { NewApiApiFormat } from "@zcode/services";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import {
  TID_LOGIN_NEW_API_ACCESS_TOKEN_INPUT,
  TID_LOGIN_NEW_API_BASE_URL_INPUT,
  TID_LOGIN_NEW_API_CANCEL_BUTTON,
  TID_LOGIN_NEW_API_ERROR,
  TID_LOGIN_NEW_API_FORMAT_TRIGGER,
  TID_LOGIN_NEW_API_SUBMIT_BUTTON,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { saveNewApiConnection, loadNewApiConnection } from "@/lib/newApiConnection.js";
import { logger } from "@/logger.js";
import { buildLoginApiKeyDefaultModelPreferenceFromSelection } from "@/login/LoginApiKeyForm.helpers.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

interface LoginNewApiFormProps {
  onCancel: () => void;
  onSaved: (providerId: string) => void | Promise<void>;
}

const API_FORMAT_OPTIONS: readonly NewApiApiFormat[] = [
  "openai-chat-completions",
  "anthropic-messages",
];

/**
 * NewAPI 自动配置入口：用访问令牌换取（必要时创建）API Key，拉取模型列表并落成个人 Provider。
 * 访问令牌与 API 根地址存入凭据服务，供左下角身份与用量页后续读取。
 */
export function LoginNewApiForm({ onCancel, onSaved }: LoginNewApiFormProps) {
  const { intl } = useZCodeIntl();
  const { credentialService, modelSelectionService, providerSettingsService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [accessTokenValue, setAccessTokenValue] = useState("");
  const [apiFormat, setApiFormat] = useState<NewApiApiFormat>("openai-chat-completions");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const baseUrl = baseUrlValue.trim();
    const accessToken = accessTokenValue.trim();
    if (!baseUrl) {
      setError(intl.formatMessage({ id: "login.newApi.emptyBaseUrlError" }));
      return;
    }
    if (!accessToken) {
      setError(intl.formatMessage({ id: "login.newApi.emptyTokenError" }));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // 重新登录时替换上一次落下的 NewAPI Provider，而不是再建一个：
      // 否则每次连接都会堆出 NewAPI2 / NewAPI3。凭据里的 providerId 只由本流程写入，
      // 用户手工删掉后服务端会跳过删除，直接新建。
      const previousConnection = await loadNewApiConnection(credentialService);
      const created = await providerSettingsService.provisionNewApiProvider({
        accessToken,
        apiFormat,
        baseUrl,
        ...(previousConnection ? { replaceProviderId: previousConnection.providerId } : {}),
      });
      // 先落凭据再标记登录成功：登录计数自增会触发左下角/用量页重新读取 NewAPI 连接，
      // 顺序反了会读到旧凭据（首次登录时为空）。
      await saveNewApiConnection(credentialService, {
        accessToken,
        baseUrl: created.baseUrl,
        providerId: created.providerId,
      });
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved(created.providerId);
    } catch (saveError) {
      logger.error("[LoginEntry] NewAPI 自动配置失败", { error: saveError });
      setError(
        intl.formatMessage(
          { id: "login.newApi.saveError" },
          { error: saveError instanceof Error ? saveError.message : String(saveError) },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "login.newApi.title" })}
        </h2>
        <p className="text-ui-sm/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "login.newApi.description" })}
        </p>
        <div className="space-y-2">
          <Input
            id="login-new-api-base-url"
            size="lg"
            className="h-10 w-full text-ui-base"
            data-testid={TID_LOGIN_NEW_API_BASE_URL_INPUT}
            aria-label={intl.formatMessage({ id: "login.newApi.baseUrlLabel" })}
            value={baseUrlValue}
            placeholder={intl.formatMessage({ id: "login.newApi.baseUrlPlaceholder" })}
            autoComplete="off"
            disabled={saving}
            onChange={(event) => {
              setBaseUrlValue(event.target.value);
              setError(null);
            }}
          />
          <Input
            id="login-new-api-access-token"
            type="password"
            size="lg"
            className="h-10 w-full text-ui-base"
            data-testid={TID_LOGIN_NEW_API_ACCESS_TOKEN_INPUT}
            aria-label={intl.formatMessage({ id: "login.newApi.accessTokenLabel" })}
            value={accessTokenValue}
            placeholder={intl.formatMessage({ id: "login.newApi.accessTokenPlaceholder" })}
            autoComplete="off"
            disabled={saving}
            onChange={(event) => {
              setAccessTokenValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                baseUrlValue.trim() &&
                accessTokenValue.trim() &&
                !saving
              ) {
                void submit();
              }
            }}
          />
          <Select
            value={apiFormat}
            onValueChange={(value) => setApiFormat(value as NewApiApiFormat)}
            disabled={saving}
          >
            <SelectTrigger
              id="login-new-api-format"
              size="lg"
              className="h-10 w-full text-ui-base"
              data-testid={TID_LOGIN_NEW_API_FORMAT_TRIGGER}
              aria-label={intl.formatMessage({ id: "login.newApi.apiFormatLabel" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="rounded-lg">
              {API_FORMAT_OPTIONS.map((format) => (
                <SelectItem key={format} value={format} className="rounded-md">
                  {intl.formatMessage({ id: `login.newApi.apiFormat.${format}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_NEW_API_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_NEW_API_SUBMIT_BUTTON}
          disabled={!baseUrlValue.trim() || !accessTokenValue.trim() || saving}
          onClick={() => void submit()}
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.newApi.continue" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_NEW_API_CANCEL_BUTTON}
          disabled={saving}
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "login.newApi.cancel" })}
        </Button>
      </div>
    </div>
  );
}
