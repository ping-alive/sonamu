import { type Meta, type StoryObj } from "@storybook/react-vite";
import PlusIcon from "~icons/lucide/plus";

import { Button, type buttonVariantsConfig } from "./button";

const variantKeys = [
  "default",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
  "red",
  "yellow",
  "green",
  "blue",
  "cyan",
  "purple",
  "pink",
  "orange",
] satisfies Array<keyof typeof buttonVariantsConfig.variant>;
const sizeKeys = ["xs", "sm", "default", "lg", "xl"] satisfies Array<
  keyof typeof buttonVariantsConfig.size
>;

const meta = {
  component: Button,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: variantKeys },
    size: { control: "select", options: sizeKeys },
  },
  args: {
    children: "Button",
    variant: "default",
    size: "default",
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      {variantKeys.map((v) => (
        <Button key={v} {...args} variant={v}>
          {v}
        </Button>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      {sizeKeys.map((s) => (
        <Button key={s} {...args} size={s}>
          {s}
        </Button>
      ))}
    </div>
  ),
};

// 아이콘만 있는 버튼은 정사각형, 아이콘에 글자를 붙이면 일반 패딩입니다.
// 글자는 span으로 감싸지 않아도 됩니다. Button이 이어진 글자를 span 하나로 묶어 아이콘 전용 판정(`:only-child`)을 맞춥니다(SON-554).
export const IconAndText: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      <Button {...args}>
        <PlusIcon />
      </Button>
      <Button {...args}>
        <PlusIcon />
        Add
      </Button>
      <Button {...args}>
        <PlusIcon />
        Add {3}
      </Button>
    </div>
  ),
};
