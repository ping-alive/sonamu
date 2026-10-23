import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Pagination } from "../src/components/ui/pagination";
import { SonamuProvider } from "../src/contexts/sonamu-context";
import { rcKeysKo } from "../src/i18n/rc-keys";

// oxlint-disable-next-line anti-slop/no-module-mocking -- unplugin-icons 가상 모듈은 테스트 Vite 설정에 없으므로 빈 svg로 대신합니다.
vi.mock("~icons/lucide/loader-2", () => ({ default: () => <svg /> }));

function renderPagination(value: number, total: number) {
  return renderToStaticMarkup(
    <Pagination value={value} total={total} itemsPerPage={20} onValueChange={() => undefined} />,
  );
}

function nextButton(markup: string) {
  return markup.match(/<button\b[^>]*><span>Next<\/span><\/button>/)?.[0];
}

describe("Pagination 범위와 이동", () => {
  it.each([1, 2])("결과가 없으면 %i페이지에서도 0–0을 표시하고 다음 이동을 막는다", (page) => {
    const markup = renderPagination(page, 0);

    expect(markup).toContain("Showing 0-0 of 0");
    expect(nextButton(markup)).toContain('disabled=""');
  });

  it("0건 표시에도 제공된 한국어 번역을 사용한다", () => {
    const markup = renderToStaticMarkup(
      <SonamuProvider SD={(key: keyof typeof rcKeysKo) => rcKeysKo[key]}>
        <Pagination value={1} total={0} itemsPerPage={20} onValueChange={() => undefined} />
      </SonamuProvider>,
    );

    expect(markup).toContain("0개 중 0-0");
  });

  it.each([
    { page: 2, expectedRange: "Showing 21-25 of 25" },
    { page: 3, expectedRange: "Showing 25-25 of 25" },
  ])("마지막 페이지와 초과 페이지에서 다음 이동을 막는다: $page", ({ page, expectedRange }) => {
    const markup = renderPagination(page, 25);

    expect(markup).toContain(expectedRange);
    expect(nextButton(markup)).toContain('disabled=""');
  });

  it("다음 결과가 있으면 정상 범위와 활성화된 다음 버튼을 유지한다", () => {
    const markup = renderPagination(1, 25);

    expect(markup).toContain("Showing 1-20 of 25");
    expect(nextButton(markup)).toBeDefined();
    expect(nextButton(markup)).not.toContain('disabled=""');
  });
});
