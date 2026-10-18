import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { type VariantProps } from "class-variance-authority";
import * as React from "react";
import LoaderIcon from "~icons/lucide/loader-2";

import { cn } from "../../lib/utils";

const buttonVariantsConfig = {
  variant: {
    // semantic variants (shadcn/ui 기본)
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    destructive:
      "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
    outline:
      "border bg-background text-foreground hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
    link: "text-primary underline-offset-4 hover:underline",

    // solid color variants
    red: "bg-red-500 text-white hover:bg-red-600",
    yellow: "bg-yellow-500 text-white hover:bg-yellow-600",
    green: "bg-green-500 text-white hover:bg-green-600",
    blue: "bg-blue-500 text-white hover:bg-blue-600",
    cyan: "bg-cyan-500 text-white hover:bg-cyan-600",
    purple: "bg-purple-500 text-white hover:bg-purple-600",
    pink: "bg-pink-500 text-white hover:bg-pink-600",
    orange: "bg-orange-500 text-white hover:bg-orange-600",
  },
  size: {
    // button sizes
    // - 아이콘만 있는 버튼: 정사각형 (px-0 aspect-square)
    // - 텍스트 / 아이콘 + 텍스트 버튼: 일반 패딩 유지 (가로 자동 확장)
    // `:only-child`는 텍스트 노드를 세지 않으므로, Button이 글자를 span으로 감싸 이 판정을 맞춥니다(wrapText).
    xs: "h-6 px-2 py-1 text-xs [&_svg]:size-3 has-[>svg]:px-1.5 has-[>svg:only-child]:px-0 has-[>svg:only-child]:aspect-square",
    sm: "h-7 px-3 py-1.5 text-xs [&_svg]:size-3.5 has-[>svg]:px-2 has-[>svg:only-child]:px-0 has-[>svg:only-child]:aspect-square",
    default:
      "h-9 px-4 py-2 [&_svg]:size-4 has-[>svg]:px-3 has-[>svg:only-child]:px-0 has-[>svg:only-child]:aspect-square",
    lg: "h-11 px-6 py-3 text-base [&_svg]:size-5 has-[>svg]:px-4 has-[>svg:only-child]:px-0 has-[>svg:only-child]:aspect-square",
    xl: "h-13 px-8 py-4 text-lg [&_svg]:size-6 has-[>svg]:px-6 has-[>svg:only-child]:px-0 has-[>svg:only-child]:aspect-square",
  },
} as const;

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer",
  {
    variants: buttonVariantsConfig,
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    icon?: React.ReactElement;
    loading?: boolean;
  };

/**
 * 이어진 글자(문자열·숫자) 자식을 span 하나로 묶습니다.
 *
 * 크기 variant는 `has-[>svg:only-child]`로 아이콘만 있는 버튼을 알아보는데, CSS `:only-child`는 텍스트 노드를 세지 않습니다.
 * 그래서 `<Button><PlusIcon />추가</Button>`이 아이콘 전용으로 판정되어 패딩 0·정사각형이 됩니다.
 * 글자를 요소로 만들어 주면 판정이 맞습니다.
 *
 * - 이어진 글자를 하나로 묶는 것은 브라우저가 이어진 텍스트 노드를 flex 항목 하나로 다루는 것과 같게 하려는 것입니다.
 *   조각마다 감싸면 `{label}{count}` 사이에 gap이 끼어듭니다.
 * - 공백뿐인 글자는 flex 컨테이너가 원래 그리지 않으므로 버립니다. 감싸면 그 자리에 gap이 생깁니다.
 * - 이미 `<span>`으로 감싼 글자는 요소라서 건드리지 않습니다.
 *
 * shadcn처럼 자동 판정을 없애고 `size="icon"`을 두는 쪽이 더 단순하지만, 아이콘 전용 버튼을 쓰는 모든 앱을 고쳐야 하는
 * 깨지는 변경이라 이 방법을 택했습니다(SON-554).
 */
function wrapText(children: React.ReactNode): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let text: React.ReactNode[] = [];
  const flush = () => {
    const joined = text.join("");
    if (joined.trim() !== "") {
      nodes.push(<span key={`text-${nodes.length}`}>{joined}</span>);
    }
    text = [];
  };

  for (const child of React.Children.toArray(children)) {
    // toArray가 null·boolean을 걸러 내므로, 요소가 아니면 글자(문자열·숫자)입니다.
    if (React.isValidElement(child)) {
      flush();
      nodes.push(child);
    } else {
      text.push(child);
    }
  }
  flush();

  return nodes;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, icon, children, loading, disabled, asChild = false, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";

    const iconOnly = React.Children.count(children) === 0;

    const leadingIcon = loading ? <LoaderIcon className="animate-spin" /> : icon;
    // asChild는 Slot에 자식 하나를 그대로 넘겨야 하므로 감싸지 않습니다.
    const content = asChild ? children : wrapText(children);

    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {iconOnly ? (
          leadingIcon
        ) : leadingIcon ? (
          <span className="contents">
            {leadingIcon}
            {content}
          </span>
        ) : (
          content
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants, buttonVariantsConfig, type ButtonProps };
