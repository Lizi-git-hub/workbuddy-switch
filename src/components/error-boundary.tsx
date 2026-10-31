import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT, type Translate } from "@/lib/i18n";

interface Props {
  children: ReactNode;
  /** 由函数式外壳注入（class 组件拿不到 `useT()`）。 */
  t: Translate;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copied: boolean;
}

/** 把异常与组件栈拼成可粘贴的纯文本（用户反馈时直接贴这一段）。 */
export function formatErrorDetails(error: Error, info: ErrorInfo | null): string {
  const head = `${error.name || "Error"}: ${error.message || "(无消息)"}`;
  const stack = error.stack ? `\n\n${error.stack}` : "";
  const componentStack = info?.componentStack
    ? `\n\n--- 组件栈 ---${info.componentStack}`
    : "";
  return `${head}${stack}${componentStack}`;
}

class ErrorBoundaryImpl extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不吞：控制台（开发时）与详情面板（桌面端唯一出口）都要留下痕迹。
    console.error("[Buddy Switch] 渲染异常已被错误边界接住：", error, info);
    this.setState({ info });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleCopy = (): void => {
    const { error, info } = this.state;
    if (!error) return;
    // 刻意不用 `lib/clipboard`：它的反馈走 sonner toast，而 `<Toaster/>` 在 `App`
    // 内部 —— 崩溃时它已经不在了，用户会「点了没反应」。这里用就地状态反馈。
    void navigator.clipboard
      .writeText(formatErrorDetails(error, info))
      .then(() => this.setState({ copied: true }))
      .catch(() => this.setState({ copied: false }));
  };

  render(): ReactNode {
    const { error, info, copied } = this.state;
    if (!error) return this.props.children;

    const { t } = this.props;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-xl gap-0 py-0">
          <div className="flex items-start gap-3 px-6 py-6">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold text-foreground">{t("app.error.title")}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("app.error.description")}
              </p>
              <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-muted-foreground">
                {formatErrorDetails(error, info)}
              </pre>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={this.handleReload}>
                  <RotateCw />
                  {t("app.error.reload")}
                </Button>
                <Button size="sm" variant="outline" onClick={this.handleCopy}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? t("app.error.copied") : t("app.error.copy")}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }
}

/**
 * 函数式外壳：只为拿到会随语言切换重渲染的 `t`。
 *
 * 语言切换时 `useT()` 让**这里**重渲染，`ErrorBoundaryImpl` 是它的子节点，
 * 于是错误面板的文案也跟着切 —— 不需要给 class 组件开 `contextType` 之类的后门。
 */
export function ErrorBoundary({ children }: { children: ReactNode }) {
  const t = useT();
  return <ErrorBoundaryImpl t={t}>{children}</ErrorBoundaryImpl>;
}
