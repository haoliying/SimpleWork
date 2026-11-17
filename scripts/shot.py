import sys, asyncio
from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8899"
OUT = sys.argv[2] if len(sys.argv) > 2 else "shot.png"
COLLAPSE = len(sys.argv) > 3 and sys.argv[3] == "collapsed"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_timeout(1200)
        if COLLAPSE:
            await pg.click("#collapseBtn")
            await pg.wait_for_timeout(400)
        await pg.screenshot(path=OUT)
        # 再截一张侧栏展开的
        if not COLLAPSE:
            await pg.click("#collapseBtn")
            await pg.wait_for_timeout(400)
            await pg.screenshot(path=OUT.replace(".png", "-collapsed.png"))
        await b.close()

asyncio.run(main())
