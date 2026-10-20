async page => {
  await page.waitForFunction(() => window.demoReady === true);
  const times = [0,1800,3200,3800,4800,5160,7000,9401,10800,12100,14200,15000,16200,17800,20000,21800,24200,25550,27300,28000,29500];
  for (const time of times) {
    await page.evaluate(value => window.setDemoTime(value), time);
    await page.screenshot({path:`output/playwright/key-${time}.png`,animations:'disabled'});
  }
  return {width:1920,height:1080,times};
}
