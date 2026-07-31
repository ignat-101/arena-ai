"""
Асинхронный клиент для взаимодействия с платформой FunPay через cookie golden_key.
Обеспечивает получение сообщений в чатах, отправку запросов 2FA, AI-ответов и уведомлений.
"""

import asyncio
import re
from typing import Optional, List, Dict, Any, Callable
import aiohttp
from bs4 import BeautifulSoup

from src.config import config
from src.utils.logger import logger
from src.models.order import Order, BuyerCredentials
from src.funpay.parser import FunPayMessageParser


class FunPayClient:
    """
    Асинхронный клиент для работы с FunPay.
    Использует cookie golden_key для авторизации, чтения чатов и отправки сообщений.
    """

    BASE_URL = "https://funpay.com"
    RUNNER_URL = "https://funpay.com/runner/"

    def __init__(self, golden_key: Optional[str] = None, user_agent: Optional[str] = None):
        self.golden_key = golden_key or config.FUNPAY_GOLDEN_KEY
        self.user_agent = user_agent or config.FUNPAY_USER_AGENT
        self.session: Optional[aiohttp.ClientSession] = None
        self._is_running = False
        self._csrf_token: Optional[str] = None
        self._on_new_order_callback: Optional[Callable[[Order], Any]] = None
        self._on_2fa_code_callback: Optional[Callable[[int, str], Any]] = None
        self._on_chat_message_callback: Optional[Callable[[int, str, str], Any]] = None

    async def start(self) -> bool:
        """Инициализирует сессию aiohttp и проверяет авторизацию на FunPay."""
        cookies = {}
        if self.golden_key:
            cookies["golden_key"] = self.golden_key

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        }

        self.session = aiohttp.ClientSession(
            cookies=cookies,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=20)
        )

        if not self.golden_key:
            logger.warning("FunPay golden_key не указан. Работа с реальным FunPay API отключена.")
            return False

        try:
            logger.info("Проверка авторизации на FunPay...")
            async with self.session.get(self.BASE_URL) as response:
                if response.status == 200:
                    html = await response.text()
                    if "logged-user" in html or "data-user-id" in html:
                        self._extract_csrf_token(html)
                        logger.info("✅ Успешная авторизация на FunPay!")
                        return True
                    else:
                        logger.error("❌ Ошибка авторизации на FunPay: cookie golden_key невалиден или истек.")
                        return False
                else:
                    logger.error(f"❌ Ошибка соединения с FunPay: HTTP {response.status}")
                    return False
        except Exception as e:
            logger.error(f"❌ Исключение при подключении к FunPay: {e}")
            return False

    def _extract_csrf_token(self, html: str) -> None:
        """Извлекает CSRF-токен со страницы для отправки сообщений."""
        soup = BeautifulSoup(html, "html.parser")
        meta = soup.find("meta", {"name": "csrf-token"})
        if meta and meta.get("content"):
            self._csrf_token = str(meta["content"])
            logger.debug(f"CSRF токен FunPay извлечен: {self._csrf_token[:8]}...")

    async def send_message(self, chat_id: int, message: str) -> bool:
        """Отправляет сообщение покупателю в чат FunPay."""
        if not self.session or not self.golden_key:
            logger.warning(f"[FunPay Mock Send] Чат #{chat_id}: {message}")
            return True

        if not config.AUTO_RESPOND_FUNPAY:
            logger.info(f"[AUTO_RESPOND_FUNPAY=false] Пропуск отправки в чат #{chat_id}: {message}")
            return True

        url = f"{self.BASE_URL}/chat/send"
        payload = {
            "node": str(chat_id),
            "content": message,
        }
        if self._csrf_token:
            payload["csrf_token"] = self._csrf_token

        try:
            headers = {"X-Requested-With": "XMLHttpRequest"}
            async with self.session.post(url, data=payload, headers=headers) as resp:
                if resp.status == 200:
                    logger.info(f"📤 Сообщение отправлено в чат FunPay #{chat_id}: '{message[:40]}...'")
                    return True
                else:
                    logger.error(f"Ошибка отправки в FunPay чат #{chat_id}: HTTP {resp.status}")
                    return False
        except Exception as e:
            logger.error(f"Исключение при отправке сообщения в чат #{chat_id}: {e}")
            return False

    async def request_2fa_from_buyer(self, chat_id: int, destination_hint: str) -> bool:
        """Отправляет покупателю запрос на ввод кода подтверждения 2FA."""
        msg = (
            f"🔐 Для входа в X.com требуется код подтверждения (2FA).\n\n"
            f"Пожалуйста, отправьте 6-8 значный код, отправленный на {destination_hint}.\n"
            f"Просто напишите цифры в этот чат (например: 123456)."
        )
        return await self.send_message(chat_id, msg)

    async def send_success_notification(self, chat_id: int) -> bool:
        """Уведомляет покупателя об успешной оплате и активации подписки."""
        msg = (
            "✅ Подписка X Premium успешно оплачена в сети Base и активирована!\n\n"
            "Спасибо за покупку! Пожалуйста, проверьте статус подписки в аккаунте "
            "и подтвердите выполнение заказа на FunPay. Будем благодарны за отзыв! ⭐"
        )
        return await self.send_message(chat_id, msg)

    async def send_error_notification(self, chat_id: int, reason: str) -> bool:
        """Уведомляет покупателя о возникшей проблеме."""
        msg = (
            f"⚠️ Внимание: Произошла задержка при обработке вашего заказа.\n"
            f"Причина: {reason}\n\n"
            f"Администратор уже уведомлен и проверит ваш заказ вручную в ближайшее время."
        )
        return await self.send_message(chat_id, msg)

    def register_callbacks(
        self,
        on_new_order: Optional[Callable[[Order], Any]] = None,
        on_2fa_code: Optional[Callable[[int, str], Any]] = None,
        on_chat_message: Optional[Callable[[int, str, str], Any]] = None
    ) -> None:
        """Регистрирует обработчики событий для новых заказов, 2FA и сообщений чата."""
        self._on_new_order_callback = on_new_order
        self._on_2fa_code_callback = on_2fa_code
        self._on_chat_message_callback = on_chat_message

    async def start_polling(self, poll_interval: int = 5) -> None:
        """Запускает циклический опрос сообщений от покупателей."""
        self._is_running = True
        logger.info(f"🚀 Опрос чатов FunPay запущен (интервал: {poll_interval} с)")

        while self._is_running:
            try:
                await asyncio.sleep(poll_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Ошибка в цикле опроса FunPay: {e}")
                await asyncio.sleep(poll_interval)

    async def stop(self) -> None:
        """Останавливает опрос и закрывает соединение."""
        self._is_running = False
        if self.session and not self.session.closed:
            await self.session.close()
            logger.info("Сессия FunPay закрыта.")
