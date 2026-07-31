"""
Автоматизация оформления подписки X Premium и выбора оплаты Crypto -> Base -> Trust Wallet.
"""

import asyncio
import time
from typing import Optional
from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from src.config import config
from src.utils.logger import logger
from src.models.order import PaymentQR
from src.utils.qr_generator import QRGenerator


class XCheckoutHandler:
    """
    Обработчик оформления подписки X Premium:
    1. Выбор плана (Basic, Premium, Premium+) и периода (Monthly/Annual)
    2. Переход к оплате через Stripe
    3. Выбор криптовалютной оплаты -> Блокчейн Base -> Trust Wallet / WalletConnect
    4. Получение платежного QR-кода
    """

    PREMIUM_SIGNUP_URL = "https://x.com/i/premium_sign_up"

    def __init__(self, page: Page):
        self.page = page

    async def start_subscription_checkout(
        self,
        plan: str = "premium",
        tier: str = "monthly"
    ) -> Optional[PaymentQR]:
        """
        Запускает процесс оформления подписки и возвращает объект PaymentQR
        с данными для оплаты в сети Base через Trust Wallet.
        """
        logger.info(f"🛒 Переход к оформлению подписки X Premium (План: {plan}, Период: {tier})...")
        try:
            await self.page.goto(self.PREMIUM_SIGNUP_URL, wait_until="domcontentloaded")
            await asyncio.sleep(3)

            # --- 1. ВЫБОР ПЕРИОДА (MONTHLY / ANNUAL) ---
            if tier.lower() == "monthly":
                monthly_btn = await self.page.query_selector(
                    "button:has-text('Monthly'), [role='tab']:has-text('Monthly'), button:has-text('Ежемесячно')"
                )
                if monthly_btn:
                    await monthly_btn.click()
                    await asyncio.sleep(1)
            elif tier.lower() == "annual":
                annual_btn = await self.page.query_selector(
                    "button:has-text('Annual'), [role='tab']:has-text('Annual'), button:has-text('Ежегодно')"
                )
                if annual_btn:
                    await annual_btn.click()
                    await asyncio.sleep(1)

            # --- 2. ВЫБОР ПЛАНА (BASIC / PREMIUM / PREMIUM+) ---
            # Ищем кнопку Subscribe для выбранного тарифа
            plan_keywords = {
                "premium_basic": ["Basic", "Базовый"],
                "premium": ["Premium", "Премиум"],
                "premium_plus": ["Premium+", "Премиум+"],
            }
            keywords = plan_keywords.get(plan.lower(), ["Premium", "Премиум"])

            # Клик по кнопке подписки
            subscribe_btn_selector = (
                "button:has-text('Subscribe'), button:has-text('Подписаться'), "
                "[role='button']:has-text('Subscribe')"
            )
            subscribe_buttons = await self.page.query_selector_all(subscribe_btn_selector)
            if subscribe_buttons:
                # Берем первую или подходящую кнопку
                await subscribe_buttons[0].click()
                await asyncio.sleep(4)
            else:
                logger.warning("Не найдена кнопка Subscribe на X.com. Попытка прямого поиска платежной формы...")

            # --- 3. РАБОТА СО СТРАНИЦЕЙ / IFRAME ОПЛАТЫ STRIPE ---
            return await self._process_stripe_checkout(plan, tier)

        except Exception as e:
            logger.error(f"❌ Ошибка в процессе оформления подписки: {e}")
            return None

    async def _process_stripe_checkout(self, plan: str, tier: str) -> Optional[PaymentQR]:
        """
        Навигация в платежном окне Stripe Checkout:
        - Выбор способа оплаты: Crypto / WalletConnect / Trust Wallet
        - Выбор сети блокчейна: Base
        - Извлечение ссылки на оплату и генерация QR-кода
        """
        logger.info("💳 Ожидание загрузки платежной формы Stripe...")
        await asyncio.sleep(3)

        try:
            # 1. Выбор оплаты Crypto / WalletConnect в Stripe
            crypto_tab_selector = (
                "button:has-text('Crypto'), [role='radio']:has-text('Crypto'), "
                "button:has-text('WalletConnect'), button:has-text('Trust Wallet'), "
                ".PaymentMethodBtn--crypto"
            )
            try:
                crypto_tab = await self.page.wait_for_selector(crypto_tab_selector, timeout=10000)
                if crypto_tab:
                    await crypto_tab.click()
                    await asyncio.sleep(2)
            except PlaywrightTimeoutError:
                logger.debug("Вкладка Crypto не найдена по прямому селектору, проверяем селекты...")

            # 2. ВЫБОР БЛОКЧЕЙНА BASE (ТРЕБОВАНИЕ ПОЛЬЗОВАТЕЛЯ: код будет выбирать base как блокчейн)
            logger.info("🌐 Выбор сети блокчейна: BASE (Base Network)...")
            network_selector = (
                "select[name='network'], button:has-text('Base'), "
                "[aria-label*='Base'], div[role='option']:has-text('Base')"
            )
            try:
                network_el = await self.page.wait_for_selector(network_selector, timeout=10000)
                if network_el:
                    # Если это выпадающий список select
                    tag_name = await network_el.evaluate("el => el.tagName.toLowerCase()")
                    if tag_name == "select":
                        await network_el.select_option(label="Base")
                    else:
                        await network_el.click()
                    await asyncio.sleep(2)
            except PlaywrightTimeoutError:
                logger.warning("Селектор сети Base не появился мгновенно. Продолжаем поиск WalletConnect URI...")

            # 3. ИЗВЛЕЧЕНИЕ WALLETCONNECT URI ИЛИ ССЫЛКИ ДЛЯ QR-КОДА
            logger.info("📱 Поиск данных для генерации QR-кода Trust Wallet...")
            wc_uri = None

            # Вариант А: Ищем ссылку wc: (WalletConnect URI) в DOM
            try:
                links = await self.page.query_selector_all("a[href^='wc:'], [data-uri^='wc:']")
                for link in links:
                    href = await link.get_attribute("href") or await link.get_attribute("data-uri")
                    if href and href.startswith("wc:"):
                        wc_uri = href
                        break
            except Exception as e:
                logger.debug(f"Поиск атрибута href='wc:' не удался: {e}")

            # Вариант Б: Ищем внутри iframe Stripe
            if not wc_uri:
                for frame in self.page.frames:
                    try:
                        links = await frame.query_selector_all("a[href^='wc:'], [data-uri^='wc:']")
                        for link in links:
                            href = await link.get_attribute("href") or await link.get_attribute("data-uri")
                            if href and href.startswith("wc:"):
                                wc_uri = href
                                break
                        if wc_uri:
                            break
                    except Exception:
                        continue

            # Если удалось получить URI, генерируем изображение PNG через наш QRGenerator
            if wc_uri:
                logger.info(f"✅ Успешно получен WalletConnect URI: {wc_uri[:35]}...")
                img_bytes = QRGenerator.generate_qr_image_bytes(
                    data=wc_uri,
                    title="BASE • TRUST WALLET",
                    subtitle=f"X Premium ({plan.upper()} • {tier.upper()})"
                )
                return PaymentQR(
                    uri_data=wc_uri,
                    network="Base",
                    wallet="Trust Wallet",
                    amount_str=f"X Premium ({plan} - {tier})",
                    expires_at=time.time() + 900,
                    image_bytes=img_bytes
                )
            else:
                logger.warning("Не удалось извлечь WalletConnect URI со страницы Stripe.")
                return None

        except Exception as e:
            logger.error(f"❌ Ошибка в процессе выбора блокчейна Base в Stripe: {e}")
            return None

    async def wait_for_payment_success(self, timeout: int = 300) -> bool:
        """
        Ожидает завершения оплаты (редирект на success-страницу или сообщение об успехе).
        """
        logger.info(f"⏳ Ожидание подтверждения оплаты в браузере (тайм-аут: {timeout} с)...")
        start_time = time.time()
        while time.time() - start_time < timeout:
            current_url = self.page.url
            if "success" in current_url or "/home" in current_url:
                logger.info("✅ Оплата подписки подтверждена в браузере!")
                return True

            try:
                success_el = await self.page.query_selector("text='Payment successful', text='Оплата успешна'")
                if success_el:
                    logger.info("✅ Обнаружено сообщение об успешной оплате!")
                    return True
            except Exception:
                pass

            await asyncio.sleep(5)

        logger.warning("⏱️ Время ожидания подтверждения оплаты в браузере истекло.")
        return False
