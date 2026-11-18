import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "@/lib/utils";

export const HoverCard = PreviewCard.Root;

export function HoverCardContent({
  anchor,
  className,
  ...props
}: PreviewCard.Popup.Props & { anchor: HTMLElement | null }) {
  return (
    <PreviewCard.Portal>
      <PreviewCard.Positioner
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={8}
        className="z-[80]"
      >
        <PreviewCard.Popup
          {...props}
          className={cn(
            "link-preview-card rounded-xl border border-stone-200 bg-[#FFFDFC] p-4 text-sm text-stone-800 shadow-xl outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
            className,
          )}
        />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  );
}
