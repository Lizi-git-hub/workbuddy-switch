
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import * as api from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: Scope;
  /** 入库成功后的回调（父级据此重取列表）。 */
  onAdded?: (name: string) => void;
}

export function PasteCredentialDialog({ open, onOpenChange, scope, onAdded }: Props) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** 每次打开都清空：上一次的凭据留在框里既碍眼也有泄露风险。 */
  function handleOpenChange(next: boolean) {
    if (next) {
      setText("");
      setError("");
      setBusy(false);
    }
    onOpenChange(next);
  }

  async function submit() {
    if (!text.trim()) {
      setError(t("shared.srv.paste.emptyDesc"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.accountsPasteCredential(scope, text);
      const name = result.account?.nickname || result.account?.id || "";
      onOpenChange(false);
      onAdded?.(String(name || ""));
    } catch (e) {
      setError(api.asError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("shared.srv.paste.title")}</DialogTitle>
          <DialogDescription>{t("shared.srv.paste.desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='{"accessToken":"…","refreshToken":"…"}'
            spellCheck={false}
            autoComplete="off"
            className="min-h-[150px] font-mono text-[11.5px]"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("shared.srv.paste.hint.wb")}
          </p>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="break-all">{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("wbAccounts.dialog.oauthClose")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("shared.srv.paste.verify")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
