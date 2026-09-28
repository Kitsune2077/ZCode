/**
 * `useNewApiAccount` 的 hook 级回归测试：用真实 React（配合下方极简 fake DOM）驱动
 * 真实 hook 与真实 StoreProvider / ServiceProvider，锁定两条收敛规则：
 *
 * 1. 凭据未变时，一次成功的账号读取是**终态**——不再重读连接、不再发请求。
 * 2. 令牌续期确实发生后，恰好重读一次连接、账号请求序列收敛，随后静默。
 *
 * bug 背景（对应 docs/newapi-account-usage.md「读取收敛」）：账号读取 effect 曾把
 * `connectionLoading` 列为依赖，且读取成功后无条件 `refreshConnection()`。两者叠加成
 * 无限重跑闭环：每轮 loading 翻转都把成功读取重新拉起，左下角在真实用户名与中性
 * 「NewAPI」之间闪烁、每轮向 NewAPI 发 3 个请求，直到某次读取失败停在 error 态
 * （用户名固定为「NewAPI」、用量页报「无法读取用量统计」）。引用收敛
 * （`resolveStableNewApiConnection`）只是必要条件，本文件锁定的是充分条件：
 * 修复前场景 1 在 50ms 内产生 ~180 次读取。
 *
 * 运行方式与同目录其它测试一致：`node --import tsx --test <本文件>`。
 * 源码内 `@/` 别名由文件开头的 resolve hook 映射到 `../src`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

/* ---------------------------------------------------------------------------
 * 极简 fake DOM：只为让 react-dom/client 在 node:test 里渲染 null 树并跑 effect。
 * 不模拟布局与事件语义，仅覆盖 React 提交路径实际触碰的节点 API。
 * ------------------------------------------------------------------------- */
/** 最小 DOMTokenList：只支持 theme 应用路径用到的 toggle/contains。 */
class FakeClassList {
  private readonly tokens = new Set<string>();
  toggle(name: string, force?: boolean): void {
    const enabled = force ?? !this.tokens.has(name);
    if (enabled) this.tokens.add(name);
    else this.tokens.delete(name);
  }
  contains(name: string): boolean {
    return this.tokens.has(name);
  }
}

class FakeElement {
  readonly nodeType = 1;
  tagName: string;
  readonly style: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, unknown[]> = {};
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  nextSibling: FakeElement | null = null;
  previousSibling: FakeElement | null = null;
  private readonly doc: FakeDocument;
  constructor(doc: FakeDocument, tag = "div") {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
  }
  get ownerDocument(): FakeDocument {
    return this.doc;
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    // removeChild 会原地修改 children，不能边遍历边删；从头部逐个摘除。
    while (this.firstChild) {
      this.removeChild(this.firstChild);
    }
    if (value) this.appendChild(new FakeTextNode(this.doc, value));
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentNode?.removeChild(child);
    const last = this.lastChild;
    this.children.push(child);
    child.parentNode = this;
    child.previousSibling = last;
    child.nextSibling = null;
    if (last) last.nextSibling = child;
    return child;
  }
  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    child.parentNode?.removeChild(child);
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) {
      this.appendChild(child);
      return child;
    }
    const prev = ref.previousSibling;
    this.children.splice(index, 0, child);
    child.parentNode = this;
    child.previousSibling = prev;
    child.nextSibling = ref;
    ref.previousSibling = child;
    if (prev) prev.nextSibling = child;
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.previousSibling) child.previousSibling.nextSibling = child.nextSibling;
    if (child.nextSibling) child.nextSibling.previousSibling = child.previousSibling;
    child.parentNode = null;
    child.previousSibling = null;
    child.nextSibling = null;
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }
  addEventListener(type: string, listener: unknown): void {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: unknown): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== listener);
  }
}

class FakeTextNode extends FakeElement {
  private readonly text: string;
  constructor(doc: FakeDocument, text: string) {
    super(doc, "#text");
    this.text = text;
  }
  get textContent(): string {
    return this.text;
  }
}

class FakeDocument {
  readonly nodeType = 9;
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: unknown = null;
  private readonly docListeners: Record<string, unknown[]> = {};
  constructor() {
    this.body = new FakeElement(this, "body");
    this.documentElement = new FakeElement(this, "html");
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(this, text);
  }
  addEventListener(type: string, listener: unknown): void {
    (this.docListeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: unknown): void {
    this.docListeners[type] = (this.docListeners[type] ?? []).filter((fn) => fn !== listener);
  }
}

const fakeDocument = new FakeDocument();
const fakeWindow = {
  document: fakeDocument,
  // react-dom 的 getActiveElementDeep 会对 activeElement 做 instanceof 检查。
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  HTMLInputElement: class {},
  navigator: { userAgent: "node-test" },
  matchMedia: () => ({ matches: false }),
};
fakeDocument.defaultView = fakeWindow;
Object.assign(globalThis, {
  document: fakeDocument,
  window: fakeWindow,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
});

/* ---------------------------------------------------------------------------
 * 源码内的 `@/` 别名（tsconfig paths）不会被 tsx 解析；这里补一个 resolve hook。
 * 必须在动态 import 源码模块之前注册。
 * ------------------------------------------------------------------------- */
const uiSrcDir = join(import.meta.dirname, "..", "src");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(join(uiSrcDir, specifier.slice(2))).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { useNewApiAccount } = await import("../src/hooks/useNewApiAccount.js");
const { ServiceProvider } = await import("../src/hooks/useServices.js");
const { StoreProvider } = await import("../src/store/StoreProvider.js");
const {
  clearNewApiConnection,
  saveNewApiConnection,
  saveNewApiRefreshCookie,
} = await import("../src/lib/newApiConnection.js");
const { resetNewApiKnownStateForTests } = await import("../src/lib/newApiKnownState.js");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

function accountInfo(username: string) {
  return {
    username,
    quota: 500_000,
    usedQuota: 0,
    requestCount: 0,
    role: 100,
    roleLabel: "root",
    quotaPerUnit: 500_000,
    displayInCurrency: true,
    currencySymbol: "$",
    daily: [],
  };
}

interface WorldOptions {
  /** 这些令牌的账号读取抛 401，用于触发续期路径。 */
  readonly failTokens?: ReadonlySet<string>;
}

function createWorld(options: WorldOptions = {}) {
  const credentials = new Map<string, string>();
  const calls = {
    accountTokens: [] as string[],
    exchangedCookies: [] as string[],
  };
  const credentialService = {
    // 真实凭据读取走 renderer→Host 的 RPC，setLoading(true) 与结果落地分属两次渲染。
    // 若用立即 resolve 的微任务，两次 setLoading 会被 React 批处理成一次渲染，
    // loading 净不变——恰好把修复前“loading 翻转重跑 effect”的闭环意外治愈，
    // 回归测试就失效了。这里强制至少隔一个宏任务，保持与真实 IPC 相同的时序形态。
    load: async (key: string) => {
      await sleep(0);
      return credentials.get(key) ?? null;
    },
    save: async (key: string, value: string) => {
      await sleep(0);
      credentials.set(key, value);
    },
    delete: async (key: string) => {
      await sleep(0);
      credentials.delete(key);
    },
  };
  const providerSettingsService = {
    getNewApiAccountInfo: async ({ accessToken }: { accessToken: string }) => {
      calls.accountTokens.push(accessToken);
      if (options.failTokens?.has(accessToken)) {
        throw new Error("401 unauthorized");
      }
      return accountInfo("tester");
    },
    exchangeNewApiSession: async ({ refreshCookie }: { refreshCookie: string }) => {
      calls.exchangedCookies.push(refreshCookie);
      return { accessToken: "token-fresh", rotatedRefreshCookie: "cookie-v2" };
    },
  };
  const broadcastService = {
    send: async () => {},
    acquireClaim: async () => ({}) as never,
    commitClaim: async () => {},
    releaseClaim: async () => {},
    tryClaim: async () => true,
    onMessage: (() => ({ dispose() {} })) as never,
  };
  return { credentials, calls, credentialService, providerSettingsService, broadcastService };
}

type AccountProbe = ReturnType<typeof mountAccountProbe>;

function mountAccountProbe(
  world: ReturnType<typeof createWorld>,
  renderLog?: { hasConnection: boolean; status: string }[],
) {
  let latest: ReturnType<typeof useNewApiAccount> | null = null;
  function Probe() {
    latest = useNewApiAccount();
    if (renderLog) {
      renderLog.push({
        hasConnection: latest.connection !== null,
        status: latest.state.status,
      });
    }
    return null;
  }
  const services = {
    credentialService: world.credentialService,
    providerSettingsService: world.providerSettingsService,
  } as unknown as Parameters<typeof ServiceProvider>[0]["services"];
  const container = fakeDocument.createElement("div");
  const root = createRoot(container as never);
  root.render(
    createElement(
      StoreProvider,
      { broadcastService: world.broadcastService as never },
      createElement(ServiceProvider, { services }, createElement(Probe)),
    ),
  );
  return {
    get latest() {
      return latest;
    },
    unmount: () => root.unmount(),
  };
}

async function seedConnection(
  world: ReturnType<typeof createWorld>,
  accessToken: string,
  refreshCookie: string,
): Promise<void> {
  await saveNewApiConnection(world.credentialService, {
    providerId: "newapi-1",
    // 带 /v1 的 API 根：覆盖读取方的归一化分支；地址取 RFC 5737 文档保留段，
    // 无真实归属，且本测试的网络调用全部被 fake，地址不参与解析。
    baseUrl: "http://192.0.2.10:3000/v1",
    accessToken,
  });
  await saveNewApiRefreshCookie(world.credentialService, {
    providerId: "newapi-1",
    refreshCookie,
  });
}

/** 静默期断言：等待一段时间后调用数不再增长，证明读取已收敛而不是慢速循环。 */
async function assertQuiet(probe: AccountProbe, world: ReturnType<typeof createWorld>): Promise<number> {
  const readsAtStart = world.calls.accountTokens.length;
  const statusAtStart = probe.latest?.state.status;
  await sleep(300);
  assert.equal(
    world.calls.accountTokens.length,
    readsAtStart,
    `expected no further account reads, got: ${JSON.stringify(world.calls.accountTokens)}`,
  );
  assert.equal(probe.latest?.state.status, statusAtStart);
  return readsAtStart;
}

test("stable credentials converge to exactly one account read (no flicker loop)", async () => {
  resetNewApiKnownStateForTests();
  const world = createWorld();
  await seedConnection(world, "token-v1", "cookie-v1");
  const probe = mountAccountProbe(world);
  try {
    await waitFor(() => probe.latest?.state.status === "ready");
    assert.equal(probe.latest.state.info.username, "tester");
    // 修复前：读取成功后无条件 refreshConnection + loading 依赖翻转，50ms 内 ~180 次读取。
    const totalReads = await assertQuiet(probe, world);
    assert.equal(totalReads, 1, `expected exactly one account read, got ${totalReads}`);
    assert.equal(world.calls.exchangedCookies.length, 0);
  } finally {
    probe.unmount();
  }
});

test("token renewal re-reads the connection exactly once, then converges", async () => {
  resetNewApiKnownStateForTests();
  const world = createWorld({ failTokens: new Set(["token-stale"]) });
  await seedConnection(world, "token-stale", "cookie-v1");
  const probe = mountAccountProbe(world);
  try {
    await waitFor(() => probe.latest?.state.status === "ready");
    // stale 失败 → cookie 兑换 → fresh 重试成功 → 连接换新对象 → fresh 稳态成功。
    await waitFor(() => world.calls.accountTokens.length >= 3);
    const totalReads = await assertQuiet(probe, world);
    assert.equal(totalReads, 3, `expected [stale, fresh-retry, fresh-steady], got ${totalReads}`);
    assert.deepEqual(world.calls.accountTokens, ["token-stale", "token-fresh", "token-fresh"]);
    assert.deepEqual(world.calls.exchangedCookies, ["cookie-v1"]);
    assert.equal(probe.latest.connection?.accessToken, "token-fresh");
    assert.equal(world.credentials.get("newapi:newapi-1:access_token"), "token-fresh");
    assert.equal(world.credentials.get("newapi:newapi-1:refresh_cookie"), "cookie-v2");
  } finally {
    probe.unmount();
  }
});

test("a second footer instance mounts ready from the seed without flashing", async () => {
  resetNewApiKnownStateForTests();
  const world = createWorld();
  await seedConnection(world, "token-v1", "cookie-v1");

  // 第一个实例（主界面 footer）正常读取并落定种子。
  const firstRenderLog: { hasConnection: boolean; status: string }[] = [];
  const first = mountAccountProbe(world, firstRenderLog);
  try {
    await waitFor(() => first.latest?.state.status === "ready");
    await assertQuiet(first, world);
  } finally {
    first.unmount();
  }

  // 第二个实例（设置页 footer 二次挂载）：首帧即显示连接与上次读取的账号，
  // 不出现「连接使用」（无连接）或 loading/idle 过渡——这正是打开设置→使用统计
  // 时左下角闪回「连接使用」的回归场景（spec 验收场景 R）。
  const secondRenderLog: { hasConnection: boolean; status: string }[] = [];
  const second = mountAccountProbe(world, secondRenderLog);
  try {
    // 种子让首帧即 ready，waitFor 会立即返回；真实刷新要等挂载 effect 执行后再断言。
    await waitFor(() => second.latest?.state.status === "ready");
    await waitFor(() => world.calls.accountTokens.length >= 2);
    await sleep(300);
    assert.equal(
      world.calls.accountTokens.length,
      2,
      "挂载后必须恰好真实刷新一次（种子只是首帧渲染，不是缓存）",
    );
    assert.deepEqual(
      secondRenderLog[0],
      { hasConnection: true, status: "ready" },
      "第二实例首帧必须直接从种子进入 ready",
    );
    assert.ok(
      secondRenderLog.every(
        (entry) => entry.hasConnection && (entry.status === "ready" || entry.status === "loading"),
      ),
      `不应出现无连接或 idle 帧: ${JSON.stringify(secondRenderLog)}`,
    );
    assert.equal(second.latest.state.info.username, "tester");
  } finally {
    second.unmount();
  }
});

test("disconnect clears the seed so a fresh instance starts disconnected", async () => {
  resetNewApiKnownStateForTests();
  const world = createWorld();
  await seedConnection(world, "token-v1", "cookie-v1");
  const first = mountAccountProbe(world);
  try {
    await waitFor(() => first.latest?.state.status === "ready");
  } finally {
    first.unmount();
  }

  await clearNewApiConnection(world.credentialService, "newapi-1");
  const secondRenderLog: { hasConnection: boolean; status: string }[] = [];
  const second = mountAccountProbe(world, secondRenderLog);
  try {
    await waitFor(() => second.latest?.state.status === "idle");
    assert.deepEqual(
      secondRenderLog[0],
      { hasConnection: false, status: "idle" },
      "断开后新实例首帧必须即未连接（种子已清空）",
    );
  } finally {
    second.unmount();
  }
});
