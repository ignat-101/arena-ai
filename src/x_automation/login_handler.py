"""
Автоматизация авторизации на X.com (Twitter): ввод логина/пароля и обработка 2FA проверки.
"""

import asyncio
from typing import Optional, Tuple
from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from src.models.order import BuyerCredentials
from src.utils.logger import logger


class XLoginHandler:
    """Обработчик входа на сайт X.com с распознаванием запросов 2FA."""

    LOGIN_URL = "https://x.com/i/flow/login"
    HOME_URL = "https://x.com/home"

    def __init__(self, page: Page):
        self.page = page

    async def login(self, creds: BuyerCredentials) -> Tuple[str, str, str]:
        """
        Выполняет авторизацию в X.com.
        Возвращает кортеж (статус, тип_2fa, подсказка_2fa):
        - status: 'success', '2fa_required', 'failed', 'error'
        - challenge_type: 'email', 'sms', 'totp', ''
        - hint: подсказка (например, email пользователя)
        """
        logger.info(f"🔑 Переход на страницу авторизации X.com для пользователя {creds.login}...")
        try:
            await self.page.goto(self.LOGIN_URL, wait_until="domcontentloaded")
            await asyncio.sleep(2)

            # --- 1. ВВОД ЛОГИНА / EMAIL / ТЕЛЕФОНА ---
            username_input_selector = (
                "input[autocomplete='username'], input[name='text'], input[data-testid='ocfEnterTextTextInput']"
            )
            logger.debug("Ожидание поля ввода логина...")
            username_input = await self.page.wait_for_selector(username_input_selector, timeout=15000)
            if not username_input:
                logger.error("❌ Не удалось найти поле ввода логина на X.com.")
                return "failed", "", ""

            await username_input.fill(creds.login)
            await asyncio.sleep(0.8)

            # Кнопка 'Next' / 'Далее'
            next_button_selector = "button:has-text('Next'), button:has-text('Далее'), [role='button']:has-text('Next')"
            next_btn = await self.page.wait_for_selector(next_button_selector, timeout=5000)
            if next_btn:
                await next_btn.click()
                await asyncio.sleep(2)

            # --- 2. ПРОВЕРКА ПРОМЕЖУТОЧНОГО ШАГА ("Введите имя пользователя или телефон") ---
            # X иногда требует подтвердить handle, если ввели почту или телефон
            try:
                extra_check = await self.page.wait_for_selector(
                    "input[data-testid='ocfEnterTextTextInput']", timeout=3000
                )
                if extra_check and await extra_check.is_visible():
                    logger.info("⚠️ X.com запрашивает дополнительное подтверждение имени пользователя.")
                    handle_to_enter = creds.extra_username or creds.login
                    await extra_check.fill(handle_to_enter)
                    await asyncio.sleep(0.5)
                    next_btn_extra = await self.page.wait_for_selector(
                        "button:has-text('Next'), button:has-text('Далее')", timeout=3000
                    )
                    if next_btn_extra:
                        await next_btn_extra.click()
                        await asyncio.sleep(2)
            except PlaywrightTimeoutError:
                # Промежуточного шага не возникло, продолжаем
                pass

            # --- 3. ВВОД ПАРОЛЯ ---
            logger.debug("Ожидание поля ввода пароля...")
            password_selector = "input[name='password'], input[type='password']"
            password_input = await self.page.wait_for_selector(password_selector, timeout=10000)
            if not password_input:
                logger.error("❌ Не найдено поле ввода пароля. Возможно, логин неверный или заблокирован.")
                return "failed", "", ""

            await password_input.fill(creds.password)
            await asyncio.sleep(0.8)

            # Кнопка 'Log in' / 'Войти'
            login_btn_selector = (
                "button:has-text('Log in'), button:has-text('Войти'), "
                "[data-testid='LoginForm_Login_Button']"
            )
            login_btn = await self.page.wait_for_selector(login_btn_selector, timeout=5000)
            if login_btn:
                await login_btn.click()
                await asyncio.sleep(3)

            # --- 4. ПРОВЕРКА РЕЗУЛЬТАТА И ПОИСК ЗАПРОСА 2FA ---
            return await self._check_login_result()

        except Exception as e:
            logger.error(f"❌ Ошибка в процессе входа на X.com: {e}")
            return "error", "", str(e)

    async def _check_login_result(self) -> Tuple[str, str, str]:
        """Проверяет текущий URL и DOM на наличие успешного входа или запроса 2FA."""
        await asyncio.sleep(2)
        current_url = self.page.url
        logger.debug(f"Проверка статуса входа. Текущий URL: {current_url}")

        if "/home" in current_url or "/explore" in current_url:
            logger.info("✅ Вход в аккаунт X.com выполнен успешно!")
            return "success", "", ""

        # Проверяем, есть ли форма 2FA (проверочный код на почту/SMS/приложение)
        if "/challenge/" in current_url or "/account/access" in current_url:
            logger.warning("🚨 X.com запрашивает двухфакторную аутентификацию (2FA)!")

            # Пытаемся определить подсказку, куда отправлен код
            challenge_type = "email"
            destination_hint = "вашу почту/телефон/приложение"

            try:
                page_text = await self.page.inner_text("body")
                if "email" in page_text.lower() or "почт" in page_text.lower():
                    challenge_type = "email"
                    destination_hint = "электронную почту"
                elif "sms" in page_text.lower() or "phone" in page_text.lower() or "телефон" in page_text.lower():
                    challenge_type = "sms"
                    destination_hint = "телефон по SMS"
                elif "authenticator" in page_text.lower() or "приложени" in page_text.lower():
                    challenge_type = "totp"
                    destination_hint = "приложение-аутентификатор (Google/Authy)"

                # Поиск маскированного email или телефона (например, x***@gmail.com)
                import re
                mask_match = re.search(r'([a-zA-Z0-9_\-\.]+?\*{2,}[a-zA-Z0-9_\-\.]*?@[a-zA-Z0-9\.\-]+|\+\d\*{2,}\d+)', page_text)
                if mask_match:
                    destination_hint = f"{destination_hint} ({mask_match.group(1)})"
            except Exception as e:
                logger.debug(f"Не удалось извлечь детальную подсказку 2FA: {e}")

            return "2fa_required", challenge_type, destination_hint

        # Если остаточная страница не home и не challenge, проверяем наличие ошибок на странице
        try:
            error_text = await self.page.inner_text("[data-testid='toast']", timeout=2000)
            if error_text:
                logger.error(f"❌ Ошибка входа X.com: {error_text}")
                return "failed", "", error_text
        except PlaywrightTimeoutError:
            pass

        # Неоднозначное состояние (например, CAPTCHA или медленная загрузка)
        logger.warning(f"⚠️ Статус входа не определен однозначно. URL: {current_url}")
        return "2fa_required", "security_code", "подтверждение безопасности"

    async def submit_2fa_code(self, code: str) -> bool:
        """
        Вводит полученный 2FA код на странице проверки и подтверждает форму.
        """
        logger.info(f"🔐 Ввод кода 2FA: '{code}' на странице X.com...")
        try:
            input_selector = (
                "input[name='text'], input[data-testid='ocfEnterTextTextInput'], "
                "input[type='text'], input[type='number']"
            )
            code_input = await self.page.wait_for_selector(input_selector, timeout=10000)
            if not code_input:
                logger.error("❌ Не найдено поле для ввода кода 2FA.")
                return False

            await code_input.fill(code)
            await asyncio.sleep(0.8)

            # Нажимаем кнопку 'Next' / 'Confirm' / 'Подтвердить'
            confirm_btn_selector = (
                "button:has-text('Next'), button:has-text('Далее'), "
                "button:has-text('Confirm'), button:has-text('Подтвердить'), "
                "[role='button']:has-text('Next')"
            )
            confirm_btn = await self.page.wait_for_selector(confirm_btn_selector, timeout=5000)
            if confirm_btn:
                await confirm_btn.click()
                await asyncio.sleep(4)

            current_url = self.page.url
            if "/home" in current_url or "/explore" in current_url or "/settings" in current_url:
                logger.info("✅ 2FA успешно пройдена! Вход в X.com выполнен.")
                return True
            else:
                logger.warning(f"⚠️ После ввода 2FA URL остался на проверочной странице: {current_url}")
                return False

        except Exception as e:
            logger.error(f"❌ Ошибка при вводе 2FA кода: {e}")
            return False
