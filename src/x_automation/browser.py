"""
Управление жизненным циклом браузера Playwright: запуск, контекст, скриншоты, прокси и маскировка.
"""

import asyncio
from pathlib import Path
from typing import Optional, Any
from playwright.async_api import async_playwright, Playwright, Browser, BrowserContext, Page

from src.config import config
from src.utils.logger import logger


class PlaywrightBrowserManager:
    """Менеджер браузера Playwright с настройками маскировки и поддержкой прокси."""

    def __init__(
        self,
        headless: Optional[bool] = None,
        proxy: Optional[str] = None,
        timeout: int = 60000
    ):
        self.headless = headless if headless is not None else config.PLAYWRIGHT_HEADLESS
        self.proxy = proxy or config.PLAYWRIGHT_PROXY
        self.timeout = timeout
        self.playwright: Optional[Playwright] = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.screenshot_dir = Path("screenshots")
        self.screenshot_dir.mkdir(exist_ok=True)

    async def start(self) -> Page:
        """Запускает браузер Chromium и возвращает новую страницу."""
        logger.info(f"🌐 Запуск браузера Playwright (headless={self.headless})...")
        try:
            self.playwright = await async_playwright().start()

            launch_options: dict[str, Any] = {
                "headless": self.headless,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-extensions",
                    "--disable-gpu"
                ]
            }

            if self.proxy:
                logger.info(f"Используется прокси-сервер: {self.proxy}")
                launch_options["proxy"] = {"server": self.proxy}

            self.browser = await self.playwright.chromium.launch(**launch_options)

            # Настройки контекста (Viewport, User-Agent, локаль)
            context_options = {
                "viewport": {"width": 1280, "height": 800},
                "user_agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
                ),
                "locale": "en-US",
                "timezone_id": "America/New_York",
                "ignore_https_errors": True,
            }

            self.context = await self.browser.new_context(**context_options)
            self.page = await self.context.new_page()
            self.page.set_default_timeout(self.timeout)

            # Внедряем скрипт маскировки webdriver
            await self.page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )

            logger.info("✅ Браузер успешно запущен и готов к работе.")
            return self.page
        except Exception as e:
            logger.error(f"❌ Ошибка при запуске браузера Playwright: {e}")
            await self.close()
            raise

    async def take_screenshot(self, filename: str = "error_screenshot.png") -> str:
        """Делает скриншот текущей страницы для отладки."""
        if not self.page:
            return ""
        filepath = self.screenshot_dir / filename
        try:
            await self.page.screenshot(path=str(filepath), full_page=True)
            logger.debug(f"📸 Скриншот сохранен: {filepath}")
            return str(filepath)
        except Exception as e:
            logger.warning(f"Не удалось сохранить скриншот {filename}: {e}")
            return ""

    async def close(self) -> None:
        """Корректно завершает работу браузера и контекста."""
        if self.context:
            await self.context.close()
            self.context = None
        if self.browser:
            await self.browser.close()
            self.browser = None
        if self.playwright:
            await self.playwright.stop()
            self.playwright = None
        logger.info("Браузер Playwright закрыт.")
