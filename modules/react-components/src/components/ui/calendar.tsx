"use client";

import * as React from "react";
import { DayPicker } from "react-day-picker";
import { type DateRange } from "react-day-picker";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import ChevronLeftIcon from "~icons/lucide/chevron-left";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";

// react-day-picker 9+는 Chevron 컴포넌트 하나에 orientation을 넘겨 좌우 화살표를 그린다
function CalendarChevron({
  orientation,
  className,
}: {
  orientation?: "left" | "right" | "up" | "down";
  className?: string;
}) {
  if (orientation === "left") return <ChevronLeftIcon className={cn("h-4 w-4", className)} />;
  if (orientation === "down") return <ChevronDownIcon className={cn("h-4 w-4", className)} />;
  return <ChevronRightIcon className={cn("h-4 w-4", className)} />;
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0 relative",
        month: "space-y-4",
        month_caption: "flex justify-center pt-1 relative items-center w-full",
        caption_label: "text-sm font-medium inline-flex items-center gap-1",
        dropdowns: "flex items-center justify-center gap-1",
        dropdown_root:
          "relative inline-flex items-center rounded-md border border-input px-2 h-7 text-sm has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
        dropdown: "absolute inset-0 opacity-0 cursor-pointer",
        months_dropdown: "",
        years_dropdown: "",
        nav: "space-x-1 flex items-center absolute inset-x-0 top-0 justify-between z-10",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute left-1",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute right-1",
        ),
        month_grid: "w-full border-collapse space-y-1",
        weekdays: "flex",
        weekday: "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: cn(
          "h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-accent/10",
          props.mode === "range"
            ? "[&:has(>.day-range-end)]:rounded-r-md [&:has(>.day-range-start)]:rounded-l-md first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md"
            : "[&:has([aria-selected])]:rounded-md",
        ),
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal aria-selected:opacity-100",
        ),
        range_start: "day-range-start",
        range_end: "day-range-end",
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent/10 text-foreground",
        outside:
          "day-outside text-muted-foreground opacity-50 aria-selected:bg-transparent aria-selected:opacity-100 aria-selected:text-foreground",
        disabled: "text-muted-foreground opacity-50",
        range_middle: "aria-selected:bg-transparent aria-selected:text-foreground",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: CalendarChevron,
      }}
      {...props}
    />
  );
}

export { Calendar };
export type { DateRange };
