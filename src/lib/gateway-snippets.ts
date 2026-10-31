
import type { Translate } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/zh";

export type GatewayProtocolKey = "openai" | "anthropic";

/** 协议元数据。`endpoint` / `authHeader` 是**英文契约，不翻译**。 */
export interface GatewayProtocol {
  key: GatewayProtocolKey;
  /** 已 i18n 的展示标签键。 */
  labelKey: TranslationKey;
  /** 端点（英文契约）。 */
  endpoint: string;
  /** 认证头名（英文契约）。 */
  authHeader: string;
}

/** 协议元数据表（键是联合类型 ⇒ 查表必然命中）。 */
const PROTOCOLS: Record<GatewayProtocolKey, GatewayProtocol> = {
  openai: {
    key: "openai",
    labelKey: "shared.gateway.access.protocol.openai",
    endpoint: "POST /v1/chat/completions",
    authHeader: "Authorization: Bearer",
  },
  anthropic: {
    key: "anthropic",
    labelKey: "shared.gateway.access.protocol.anthropic",
    endpoint: "POST /v1/messages",
    authHeader: "x-api-key",
  },
};

/** 协议 Tab 的渲染顺序（OpenAI 在前，与原型一致）。 */
export const GATEWAY_PROTOCOLS: readonly GatewayProtocol[] = [PROTOCOLS.openai, PROTOCOLS.anthropic];

/** 取协议元数据（键是联合类型 ⇒ 无回落分支）。 */
export function protocolOf(key: GatewayProtocolKey): GatewayProtocol {
  return PROTOCOLS[key];
}

/** 工具定义：品牌名（Codex / opencode / Claude Code）保持英文；只有 generic 的标签走 i18n。 */
interface AccessToolDef {
  key: string;
  /** 固定展示名（品牌名，不翻译）。 */
  label?: string;
  /** 需要 i18n 的展示名（仅 generic）。 */
  labelKey?: TranslationKey;
}

/**
 * 该协议下**已知**的工具（D28：硬编码 + 词条；generic 的标签走 i18n）。
 *
 * ⚠️ 只列**能确认**的客户端；未确认的一律走 `generic`（协议 + 通用参数 + 以其官方文档为准）。
 */
const ACCESS_TOOLS: Record<GatewayProtocolKey, readonly AccessToolDef[]> = {
  openai: [
    { key: "codex", label: "Codex" },
    { key: "opencode", label: "opencode" },
    { key: "generic", labelKey: "shared.gateway.access.tool.genericOpenai" },
  ],
  anthropic: [
    { key: "claude-code", label: "Claude Code" },
    { key: "opencode", label: "opencode" },
    { key: "generic", labelKey: "shared.gateway.access.tool.genericAnthropic" },
  ],
};

/** 该协议下的工具 Tab（已 i18n 的标签）。 */
export function accessTools(
  t: Translate,
  protocol: GatewayProtocolKey,
): { key: string; label: string }[] {
  return ACCESS_TOOLS[protocol].map((tool) => ({
    key: tool.key,
    label: tool.labelKey ? t(tool.labelKey) : (tool.label ?? tool.key),
  }));
}

export interface AccessSnippetInput {
  t: Translate;
  protocol: GatewayProtocolKey;
  /** 工具 key（`codex` / `claude-code` / `opencode` / `generic`）。 */
  tool: string;
  /** 网关的 OpenAI 兼容 base（**含 `/v1`**）。 */
  baseUrl: string;
  /** **根地址**（去掉 `/v1`）—— Anthropic 系客户端会自己拼 `/v1/messages`。 */
  rootUrl: string;
  /** 已脱敏的 Key 前缀，或「请先创建 Key」的占位文案。 */
  key: string;
  /**
   * 示例模型名（**必传**）。
   *
   * ⚠️ 必须是 **`available && !disabled`** 的第一个（别拿一个被禁用的模型当例子）。
   * 必传而不是可选：可选就会有人不传、然后退回硬编码 —— 那正是 P3 修掉的缺陷。
   */
  model: string;
}

/**
 * 生成可粘贴的接入片段（**协议 × 工具**）。
 *
 * 认证头由 `protocol` 决定（Anthropic → `x-api-key`；OpenAI → `Authorization: Bearer`）；
 * `generic` 只给通用参数，**不编造配置文件片段**。
 */
export function gatewaySnippet({
  t,
  protocol,
  tool,
  baseUrl,
  rootUrl,
  key,
  model,
}: AccessSnippetInput): string {
  // Anthropic 系客户端自己拼 `/v1/messages` ⇒ 给**根地址**；OpenAI 系给含 `/v1` 的 base。
  const base = protocol === "anthropic" ? rootUrl : baseUrl;
  const authHeader = protocolOf(protocol).authHeader;

  switch (tool) {
    case "claude-code":
      // `ANTHROPIC_MODEL` 必须显式给（见文件头 P3 第 3 条缺陷）—— 不能因为「自动发现」就省掉。
      return [
        `export ANTHROPIC_BASE_URL=${rootUrl}`,
        `export ANTHROPIC_AUTH_TOKEN=${key}`,
        `export ANTHROPIC_MODEL=${model}`,
      ].join("\n");

    case "codex":
      // Codex 的 `model_provider`：`base_url` 指向本网关（OpenAI 兼容），`env_key` 指明 Key 的环境变量名。
      return [
        `# ${t("shared.gateway.access.codex.title")}`,
        `base_url = "${baseUrl}"`,
        `env_key  = "BUDDY_SWITCH_KEY"    # ${t("shared.gateway.access.codex.envKeyNote")}`,
        `# ${t("shared.gateway.access.codex.docNote")}`,
      ].join("\n");

    case "opencode":
      return [
        `# ${t("shared.gateway.access.opencode.title")}`,
        `baseURL = "${base}"`,
        `apiKey  = "${key}"`,
        `# ${t("shared.gateway.access.opencode.docNote")}`,
      ].join("\n");

    default:
      return [
        `# ${t(
          protocol === "anthropic"
            ? "shared.gateway.access.tool.genericAnthropic"
            : "shared.gateway.access.tool.genericOpenai",
        )}`,
        `Base URL : ${base}`,
        `API Key  : ${key}   (${t("shared.gateway.access.authHeaderLabel")}: ${authHeader})`,
        `${t("shared.gateway.snippet.model")} : ${t("shared.gateway.access.generic.modelHint", {
          url: `${rootUrl}/v1/models`,
        })}`,
      ].join("\n");
  }
}

export interface AccessCurlInput {
  protocol: GatewayProtocolKey;
  /** **根地址**（去掉 `/v1`）—— 端点路径取自 `protocolOf(protocol).endpoint`（**含** `/v1`）。 */
  rootUrl: string;
  /** 示例模型名（与接入片段同一取值）。 */
  model: string;
}

/**
 * 「原始请求（调试用）」curl 片段（原型 `buddy-switch-prototype.html:2903-2910` / `:2929-2930`）。
 *
 * 认证头由**协议**决定，与 `gatewaySnippet` **同源**（复用 `protocolOf(protocol).authHeader`）：
 * Anthropic → `x-api-key`；OpenAI → `Authorization: Bearer`。Key 用环境变量占位而不是脱敏前缀 ——
 * 那串带省略号（`sk-wb-…`），粘进终端只会报错。
 */
export function gatewayCurl({ protocol, rootUrl, model }: AccessCurlInput): string {
  const proto = protocolOf(protocol);
  const url = `${rootUrl}${proto.endpoint.replace(/^POST\s+/, "")}`;
  if (protocol === "anthropic") {
    return [
      `curl ${url} \\`,
      `  -H "${proto.authHeader}: $BUDDY_SWITCH_KEY" \\`,
      `  -H "anthropic-version: 2023-06-01" \\`,
      `  -d '{"model":"${model}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`,
    ].join("\n");
  }
  return [
    `curl ${url} \\`,
    `  -H "${proto.authHeader}: $BUDDY_SWITCH_KEY" \\`,
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}]}'`,
  ].join("\n");
}
