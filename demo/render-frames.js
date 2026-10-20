async page => {
  await page.waitForFunction(() => window.demoReady === true);
  const start = Number(page.url().match(/[?&]start=(\d+)/u)?.[1] ?? 0);
  const end = Math.min(start + 225,900);
  for (let frame=start;frame<end;frame++) {
    await page.evaluate(time => window.setDemoTime(time),frame*1000/30);
    await page.screenshot({path:`output/playwright/frame-${String(frame).padStart(4,'0')}.png`,animations:'disabled'});
  }
  return {start,end,fps:30};
}
