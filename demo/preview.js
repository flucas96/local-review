async page => {
  await page.waitForFunction(() => window.demoReady === true);
  const times = await page.evaluate(() => window.demoMoments);
  for (const time of times) {
    await page.evaluate(value => window.setDemoTime(value), time);
    await page.screenshot({path:`output/playwright/key-${time}.png`,animations:'disabled'});
  }
  return {width:1920,height:1080,times};
}
