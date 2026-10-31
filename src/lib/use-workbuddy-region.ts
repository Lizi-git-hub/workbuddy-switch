import type { Region } from "@/lib/types";
import { useScope } from "@/lib/use-scope";

export function useWorkbuddyRegion(): [Region, (next: Region) => void] {
  return useScope("workbuddy");
}
