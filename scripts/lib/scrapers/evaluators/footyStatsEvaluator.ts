// FootyStats calendar logic
import type { Page, Browser } from "puppeteer";

export const evaluateFootyStatsCalendar = async (
  page: Page,
  browser: Browser,
): Promise<string | null> => {
  const calendarSelector = ".calendar";
  const hasCalendar = await page.$(calendarSelector);
  if (!hasCalendar) return null;

  const getWeekKey = async () =>
    page.evaluate(() => {
      const cal = document.querySelector(".calendar");
      if (!cal) return "";
      const year = cal.getAttribute("data-current-year") || "";
      const week = cal.getAttribute("data-current-week") || "";
      return `${year}-${week}`;
    });

  const extractCalendarText = async () =>
    page.evaluate(() => {
      const cal = document.querySelector(".calendar");
      if (!cal) return "";
      const blocks = Array.from(
        cal.querySelectorAll(".calendar-date-container"),
      );
      const parts: string[] = [];
      for (const block of blocks) {
        const date =
          block
            .querySelector(".calendar-date")
            ?.textContent?.trim() || "";
        if (date) parts.push(date);
        const games = Array.from(
          block.querySelectorAll(".calendar-game"),
        );
        for (const game of games) {
          const home =
            game
              .querySelector(".team-home .team-title a")
              ?.textContent?.trim() || "";
          const away =
            game
              .querySelector(".team-away .team-title a")
              ?.textContent?.trim() || "";
          const time =
            game
              .querySelector(".match-info .match-time")
              ?.textContent?.trim() || "";
          const line = [home, time, away]
            .filter((v) => v)
            .join(" ");
          if (line) parts.push(`- ${line}`);
        }
      }
      return parts.join("\n").trim();
    });

  const waitForWeekChange = async (prevKey: string) => {
    try {
      await page.waitForFunction(
        (key) => {
          const cal = document.querySelector(".calendar");
          if (!cal) return false;
          const year = cal.getAttribute("data-current-year") || "";
          const week = cal.getAttribute("data-current-week") || "";
          return `${year}-${week}` !== key;
        },
        { timeout: 10000 },
        prevKey,
      );
    } catch {
      // Ignore timeouts; we will extract whatever is available.
    }
    return getWeekKey();
  };

  const initialKey = await getWeekKey();
  const currentText = await extractCalendarText();

  let nextText = "";
  const nextBtn = await page.$(".calendar-next");
  if (nextBtn) {
    await nextBtn.click();
    const nextKey = await waitForWeekChange(initialKey);
    if (nextKey && nextKey !== initialKey) {
      nextText = await extractCalendarText();
    }
  }

  let prevText = "";
  const prevBtn = await page.$(".calendar-prev");
  if (prevBtn) {
    const afterNextKey = await getWeekKey();
    if (afterNextKey && afterNextKey !== initialKey) {
      await prevBtn.click();
      await waitForWeekChange(afterNextKey);
    }
    const backKey = await getWeekKey();
    await prevBtn.click();
    const prevKey = await waitForWeekChange(backKey);
    if (prevKey && prevKey !== backKey) {
      prevText = await extractCalendarText();
    }
  }

  const sections: string[] = [];
  if (currentText) sections.push(`Current week:\n${currentText}`);
  if (nextText) sections.push(`Next week:\n${nextText}`);
  if (prevText) sections.push(`Previous week:\n${prevText}`);
  const calendarText = sections.join("\n\n").trim();
  if (calendarText) {
    await browser.close();
    return calendarText;
  }

  return null;
};
