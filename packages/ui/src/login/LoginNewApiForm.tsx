import { useState } from "react";
import type { NewApiApiFormat } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ChevronDownIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import {
  TID_LOGIN_NEW_API_ACCESS_TOKEN_INPUT,
  TID_LOGIN_NEW_API_ADVANCED_TOGGLE,
  TID_LOGIN_NEW_API_BASE_URL_INPUT,
  TID_LOGIN_NEW_API_BROWSER_BUTTON,
  TID_LOGIN_NEW_API_CANCEL_BUTTON,
  TID_LOGIN_NEW_API_ERROR,
  TID_LOGIN_NEW_API_FORMAT_TRIGGER,
  TID_LOGIN_NEW_API_PROVIDER_INPUT,
  TID_LOGIN_NEW_API_SUBMIT_BUTTON,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  loadNewApiReplaceProviderId,
  saveNewApiConnection,
  saveNewApiRefreshCookie,
} from "@/lib/newApiConnection.js";
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

type OpenNewApiLoginWindow = NonNullable<IPlatformService["openNewApiLoginWindow"]>;

/**
 * NewAPI 自动配置入口。两条路径，按平台能力自适应：
 *
 * 1. **浏览器登录**（有 `openNewApiLoginWindow` 能力时为主路径，当前仅 Desktop）：
 *    在独立登录窗口里完成 dashboard 登录——OAuth / 密码等任何 NewAPI 部署支持的登录方式
 *    都可用——再拿会话 cookie 换访问令牌。文案不特指任何 OAuth 提供方，具体支持哪些由目标部署决定。
 * 2. **手动访问令牌**（折叠为「高级」选项）：老版本 NewAPI 没有 `new_api_refresh` 会话、
 *    企业策略不允许内嵌登录，或 Web 等没有浏览器登录能力的平台（此时展开为主路径）。
 *
 * 两条路径最终都落到同一条落库流程（换取 / 创建 API Key → 落成个人 Provider → 写凭据），
 * 不各写一份。
 */
export function LoginNewApiForm({ onCancel, onSaved }: LoginNewApiFormProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { credentialService, modelSelectionService, providerSettingsService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  // Web 等平台没有登录窗口能力（浏览器安全模型不允许跨 origin 读 cookie，见
  // packages/services/docs/newapi-browser-login.md「平台能力边界」）：浏览器登录入口
  // 整体不渲染，手动令牌从「高级」折叠区升级为主路径。
  const openLoginWindow = platform.openNewApiLoginWindow;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [providerValue, setProviderValue] = useState("");
  const [accessTokenValue, setAccessTokenValue] = useState("");
  const [apiFormat, setApiFormat] = useState<NewApiApiFormat>("openai-chat-completions");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 两条路径共用的落库流程。
   *
   * `refreshCookie` 只有浏览器登录才有：存下来供访问令牌过期后自动续期。
   */
  const persistConnection = async (input: {
    baseUrl: string;
    accessToken: string;
    refreshCookie?: string;
  }) => {
    // 重新登录时替换上一次落下的 NewAPI Provider，而不是再建一个：
    // 否则每次连接都会堆出 NewAPI2 / NewAPI3，旧账号的模型也会继续留在模型列表里。
    // 这里取的是跨「断开连接」保留的替换目标（活动指针 ?? last_provider），
    // 因此断开后换域名、换账号重登同样会替换。替换目标已被用户手工删除时下游只创建。
    const replaceProviderId = await loadNewApiReplaceProviderId(credentialService);
    const created = await providerSettingsService.provisionNewApiProvider({
      accessToken: input.accessToken,
      apiFormat,
      baseUrl: input.baseUrl,
      ...(replaceProviderId ? { replaceProviderId } : {}),
    });
    // 先落凭据再标记登录成功：登录计数自增会触发左下角/用量页重新读取 NewAPI 连接，
    // 顺序反了会读到旧凭据（首次登录时为空）。
    await saveNewApiConnection(credentialService, {
      accessToken: input.accessToken,
      baseUrl: created.baseUrl,
      providerId: created.providerId,
    });
    if (input.refreshCookie) {
      await saveNewApiRefreshCookie(credentialService, {
        providerId: created.providerId,
        refreshCookie: input.refreshCookie,
      });
    }
    const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
      await modelSelectionService.getView(),
      created.providerId,
    );
    markApiKeyLoginSuccess(defaultModelPreference);
    await onSaved(created.providerId);
  };

  const runPersist = async (input: {
    baseUrl: string;
    accessToken: string;
    refreshCookie?: string;
  }) => {
    setSaving(true);
    setError(null);
    try {
      await persistConnection(input);
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

  const submitAccessToken = async () => {
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
    await runPersist({ accessToken, baseUrl });
  };

  const loginWithBrowser = async (openWindow: OpenNewApiLoginWindow) => {
    const baseUrl = baseUrlValue.trim();
    if (!baseUrl) {
      setError(intl.formatMessage({ id: "login.newApi.emptyBaseUrlError" }));
      return;
    }

    const provider = providerValue.trim();
    setSaving(true);
    setError(null);
    try {
      const result = await openWindow({
        baseUrl,
        ...(provider ? { provider } : {}),
      });
      if (result.status === "cancelled") {
        // 用户主动关闭窗口不是错误：保持安静，让用户可以重新点。
        return;
      }
      if (result.status === "timeout") {
        setError(intl.formatMessage({ id: "login.newApi.browserTimeout" }));
        return;
      }
      if (result.status === "failed") {
        setError(result.message);
        return;
      }

      const session = await providerSettingsService.exchangeNewApiSession({
        baseUrl: result.origin,
        refreshCookie: result.cookieValue,
      });
      // 服务端在兑换时可能已经轮换过会话 cookie；有轮换值就必须存新的，旧的已失效。
      await runPersist({
        accessToken: session.accessToken,
        baseUrl: result.origin,
        refreshCookie: session.rotatedRefreshCookie ?? result.cookieValue,
      });
    } catch (loginError) {
      logger.error("[LoginEntry] NewAPI 浏览器登录失败", { error: loginError });
      setError(
        intl.formatMessage(
          { id: "login.newApi.saveError" },
          { error: loginError instanceof Error ? loginError.message : String(loginError) },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const manualTokenSection = (
    <>
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
            void submitAccessToken();
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
      <Button
        type="button"
        variant="outline"
        className="h-10 w-full text-ui-base"
        size="lg"
        data-testid={TID_LOGIN_NEW_API_SUBMIT_BUTTON}
        disabled={!baseUrlValue.trim() || !accessTokenValue.trim() || saving}
        onClick={() => void submitAccessToken()}
      >
        {intl.formatMessage({ id: "login.newApi.continue" })}
      </Button>
    </>
  );

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
        </div>
      </div>

      {/* 浏览器登录入口只在有 openNewApiLoginWindow 能力的平台渲染（当前仅 Desktop）；
          Web 端缺少该能力时整体隐藏，手动令牌成为主路径。 */}
      {openLoginWindow ? (
        <div className="space-y-2">
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "login.newApi.browserLoginHint" })}
          </p>
          <Input
            id="login-new-api-provider"
            size="lg"
            className="h-10 w-full text-ui-base"
            data-testid={TID_LOGIN_NEW_API_PROVIDER_INPUT}
            aria-label={intl.formatMessage({ id: "login.newApi.providerLabel" })}
            value={providerValue}
            placeholder={intl.formatMessage({ id: "login.newApi.providerPlaceholder" })}
            autoComplete="off"
            disabled={saving}
            onChange={(event) => {
              setProviderValue(event.target.value);
              setError(null);
            }}
          />
          <Button
            type="button"
            className="h-10 w-full text-ui-base"
            size="lg"
            data-testid={TID_LOGIN_NEW_API_BROWSER_BUTTON}
            disabled={!baseUrlValue.trim() || saving}
            onClick={() => void loginWithBrowser(openLoginWindow)}
          >
            {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {intl.formatMessage({ id: "login.newApi.browserLogin" })}
          </Button>
        </div>
      ) : null}

      {/* 手动访问令牌是回退路径：有浏览器登录的平台折叠进「高级」，没有的平台直接展开为主路径。 */}
      {openLoginWindow ? (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-9 w-full justify-between px-3 text-ui-sm text-foreground-subtle"
              data-testid={TID_LOGIN_NEW_API_ADVANCED_TOGGLE}
            >
              <span>{intl.formatMessage({ id: "login.newApi.advancedToggle" })}</span>
              <ChevronDownIcon
                className={advancedOpen ? "size-4" : "size-4 -rotate-90"}
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">{manualTokenSection}</CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="space-y-2">
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "login.newApi.manualOnlyHint" })}
          </p>
          {manualTokenSection}
        </div>
      )}

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_NEW_API_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          variant="ghost"
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
