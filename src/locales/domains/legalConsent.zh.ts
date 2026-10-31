export const zh = {
  "legalConsent.title": "使用前请确认",
  "legalConsent.intro":
    "Buddy Switch 会与本机的第三方客户端共用登录态，并按你的配置向上游服务发起请求。继续之前，请确认你已了解以下行为：",
  "legalConsent.item.accounts":
    "多账号管理：读写本机客户端已有的认证数据，用于登录态切换与续期。",
  "legalConsent.item.automation":
    "自动化行为：自动签到、Token 保活、定时任务会按你的配置向官方服务发起请求（默认关闭，需逐项开启）。",
  "legalConsent.item.gateway":
    "额度转发：本地网关可以把模型额度以 OpenAI 兼容接口提供给你自己的客户端；默认只监听 127.0.0.1，需手动创建 Key 才会转发。",
  "legalConsent.consequence":
    "上述行为可能不符合你所签署的服务条款，由此产生的账号限制、额度回收、封禁或法律纠纷由你自行承担。完整条款见 docs/policies/DISCLAIMER.md；如不同意，请关闭并卸载本应用。",
  "legalConsent.checkbox": "我已阅读并理解上述风险，自愿承担使用后果",
  "legalConsent.accept": "同意并继续",
  "legalConsent.accepting": "正在保存…",
  "legalConsent.saveFailed": "无法保存确认记录。请检查数据目录是否可写后重试。",
};
