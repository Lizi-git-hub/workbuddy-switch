/**
 * 模型单价编辑 —— **卡片式**，与插件 `RateEditor` 同构：
 *
 * - 一个模型**一张卡**（不是全局表格）：头部是模型名 + 该模型的 token 量 +
 *   峰谷开关；卡体是「非峰」与「峰值」两张价格卡，各持**四档绝对价**
 *   （输入 / 缓存读 / 缓存写 / 输出）。
 * - 峰谷开关是**每模型**的：全天一个价的厂商关掉开关，峰值卡整个消失，
 *   任何时刻都按非峰卡计 —— 这才是对它的诚实配置。
 * - 高峰时段**内置官方规则**（周一至五 9-12 / 14-18），不做配置项。
 * - 只显示当前数据里出现过的模型（有消耗才值得配价），按 token 量降序。
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  FALLBACK_RATE,
  loadRates,
  saveRates,
  type ModelRate,
  type RateTable,
} from "@/lib/model-pricing";

/** 卡体内两行价格卡的列（顺序对齐插件：输入 / 缓存读 / 缓存写 / 输出）。 */
const FIELDS: { key: keyof ModelRate; label: string }[] = [
  { key: "input", label: "输入" },
  { key: "cacheRead", label: "缓存读" },
  { key: "cacheWrite", label: "缓存写" },
  { key: "output", label: "输出" },
];

/** 单卡的可编辑草稿（全部数字，直接存 ModelRate）。 */
type Draft = ModelRate;

export function RateEditor({
  models,
  onSaved,
}: {
  /** 当前数据里出现过的模型（含 token 量，按量降序）。 */
  models: { name: string; tokens: number }[];
  /** 保存成功后回调（父组件重读单价表并重算费用）。 */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RateTable>(() => loadRates());

  const rows = [...models].sort((a, b) => b.tokens - a.tokens);

  function openEditor() {
    setDraft(loadRates());
    setOpen(true);
  }

  function update(model: string, field: keyof ModelRate, raw: string) {
    const value = Number(raw);
    setDraft((prev) => {
      const key = model.toLowerCase();
      const base: Draft = prev[key] ?? FALLBACK_RATE;
      return {
        ...prev,
        [key]: { ...base, [field]: Number.isFinite(value) && value >= 0 ? value : 0 },
      };
    });
  }

  /** 翻转某一行（模型）的峰谷开关。 */
  function togglePeak(model: string, next: boolean) {
    setDraft((prev) => {
      const key = model.toLowerCase();
      const base: Draft = prev[key] ?? FALLBACK_RATE;
      return { ...prev, [key]: { ...base, peakEnabled: next } };
    });
  }

  function save() {
    saveRates(draft);
    setOpen(false);
    onSaved();
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={openEditor}>
        单价设置
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[760px]">
          <DialogHeader>
            <DialogTitle>模型单价（元 / 百万 token）</DialogTitle>
          </DialogHeader>

          <div className="max-h-[460px] min-w-0 space-y-3 overflow-y-auto pr-1">
            {rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">当前窗口没有记录到任何模型。</p>
            ) : null}
            {rows.map((row) => {
              const key = row.name.toLowerCase();
              const rate: Draft = draft[key] ?? FALLBACK_RATE;
              return (
                <article key={row.name} className="rounded-lg border border-border/60 p-3">
                  <header className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <code className="text-xs font-medium" title={row.name}>
                      {row.name}
                    </code>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {compactShare(row.tokens)} tokens
                    </span>
                    <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={rate.peakEnabled}
                        onChange={(event) => togglePeak(row.name, event.target.checked)}
                        className="size-3.5 accent-[var(--primary)]"
                      />
                      区分峰谷
                    </label>
                  </header>
                  {/* 非峰卡 */}
                  <div className="grid grid-cols-[52px_repeat(4,minmax(0,1fr))] items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">非峰</span>
                    {FIELDS.map((field) => (
                      <Input
                        key={field.key}
                        type="number"
                        min={0}
                        step="0.01"
                        value={String(rate[field.key])}
                        onChange={(event) => update(row.name, field.key, event.target.value)}
                        aria-label={`非峰 · ${field.label}`}
                        className="h-7 text-right text-xs tabular-nums"
                      />
                    ))}
                  </div>
                  {/* 峰值卡：开关打开才出现 —— 关掉时这个模型全天一个价。 */}
                  {rate.peakEnabled ? (
                    <div className="mt-2 grid grid-cols-[52px_repeat(4,minmax(0,1fr))] items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">峰值</span>
                      {FIELDS.map((field) => {
                        const peakKey = `peak${field.key[0].toUpperCase()}${field.key.slice(1)}` as keyof ModelRate;
                        return (
                          <Input
                            key={peakKey}
                            type="number"
                            min={0}
                            step="0.01"
                            value={String(rate[peakKey])}
                            onChange={(event) => update(row.name, peakKey, event.target.value)}
                            aria-label={`峰值 · ${field.label}`}
                            className="h-7 text-right text-xs tabular-nums"
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={save}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 与主视图同一套「万 / 亿」刻度（局部引用，避免循环依赖）。 */
function compactShare(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)} 万`;
  return String(Math.round(value));
}
