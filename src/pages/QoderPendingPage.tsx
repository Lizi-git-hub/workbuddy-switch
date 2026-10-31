import { useLocation, useNavigate } from "react-router-dom";
import { PlugZap } from "lucide-react";

import { ScopeChip, scopeLabel } from "@/components/scope-chip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useT } from "@/lib/i18n";
import { platformDescriptor, platformOfPath } from "@/lib/platforms/registry";
import { scopeOf } from "@/lib/scope";
import { useScope } from "@/lib/use-scope";

export default function QoderPendingPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const product = platformOfPath(location.pathname);
  const [region] = useScope(product);
  const scope = scopeOf(product, region);
  /* 产品名走注册表（唯一来源），**不**写死 `Qoder` —— 与侧栏产品切换器同一纪律。 */
  const productLabel = t(platformDescriptor(product).labelKey);

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-7 pt-[26px] pb-[60px]">
      <header className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-[640] tracking-[-0.02em]">
            {t("qoder.page.pending.title")}
          </h1>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            {productLabel} · {scopeLabel(t, scope)}
          </p>
        </div>
        <div className="grow" />
        <ScopeChip scope={scope} />
      </header>

      <Card className="gap-0 py-0">
        <EmptyState
          icon={PlugZap}
          title={t("qoder.page.pending.title")}
          description={t("qoder.page.pending.description")}
          action={
            <Button variant="outline" size="sm" onClick={() => navigate(`/s/${scope}/accounts`)}>
              {t("qoder.page.pending.action")}
            </Button>
          }
        />
      </Card>
    </div>
  );
}
