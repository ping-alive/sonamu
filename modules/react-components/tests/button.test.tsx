import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../src/components/ui/button";

// oxlint-disable-next-line anti-slop/no-module-mocking -- unplugin-icons 가상 모듈은 테스트 Vite 설정에 없으므로 빈 svg로 대신합니다.
vi.mock("~icons/lucide/loader-2", () => ({ default: () => <svg /> }));

const Icon = () => <svg />;

function inner(markup: string) {
  return markup.replace(/^<button[^>]*>/, "").replace(/<\/button>$/, "");
}

describe("Button 글자 감싸기", () => {
  it("아이콘 뒤의 글자를 span으로 감싸 아이콘 전용 판정을 피한다", () => {
    const markup = renderToStaticMarkup(
      <Button>
        <Icon />
        추가
      </Button>,
    );
    expect(inner(markup)).toBe("<svg></svg><span>추가</span>");
  });

  it("이어진 글자는 span 하나로 묶고, 공백뿐인 글자는 버린다", () => {
    const markup = renderToStaticMarkup(
      <Button>
        {"확인"} {2} <Icon />
      </Button>,
    );
    expect(inner(markup)).toBe("<span>확인 2 </span><svg></svg>");
  });

  it("이미 감싼 글자와 아이콘만 있는 버튼은 그대로 둔다", () => {
    expect(
      inner(
        renderToStaticMarkup(
          <Button>
            <Icon />
            <span>추가</span>
          </Button>,
        ),
      ),
    ).toBe("<svg></svg><span>추가</span>");
    expect(
      inner(
        renderToStaticMarkup(
          <Button>
            <Icon />
          </Button>,
        ),
      ),
    ).toBe("<svg></svg>");
  });

  it("asChild면 자식을 감싸지 않는다", () => {
    const markup = renderToStaticMarkup(
      <Button asChild>
        <a href="/">이동</a>
      </Button>,
    );
    expect(markup).toMatch(/^<a [^>]*>이동<\/a>$/);
  });
});
