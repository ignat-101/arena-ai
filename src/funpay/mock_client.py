"""
Мок-клиент FunPay v2.0 для локального тестирования без реального аккаунта FunPay.
Поддерживает симуляцию входящих заказов, вопросов в чате для AI-ассистента и ввода 2FA-кодов.
"""

import asyncio
import time
from typing import Optional, Callable, Any
from src.utils.logger import logger
from src.models.order import Order, BuyerCredentials, OrderStatus
from src.funpay.client import FunPayClient
from src.funpay.parser import FunPayMessageParser


class MockFunPayClient(FunPayClient):
    """
    Эмулятор клиента FunPay для тестирования автоматизации, Telegram-бота и AI чата.
    """

    def __init__(self):
        super().__init__(golden_key="mock_key", user_agent="Mock/2.0")
        self.mock_chats = {}
        logger.info("🧪 Инициализирован MockFunPayClient v2.0 (режим тестирования FunPay)")

    async def start(self) -> bool:
        """Имитирует успешную авторизацию на FunPay."""
        logger.info("✅ [Mock] Успешная эмуляция авторизации на FunPay!")
        return True

    async def send_message(self, chat_id: int, message: str) -> bool:
        """Логирует отправляемое сообщение в консоль."""
        logger.info(f"📬 [Mock FunPay Чат #{chat_id}] Отправлено покупателю:\n"
                    f"   ----------------------------------------\n"
                    f"   {message}\n"
                    f"   ----------------------------------------")
        return True

    async def simulate_incoming_order(
        self,
        login: str,
        password: str,
        buyer_username: str = "crypto_buyer",
        chat_id: int = 100500,
        order_id: str = "#FP998877"
    ) -> Order:
        """
        Имитирует получение сообщения от покупателя с логином и паролем для оформления заказа.
        Вызывает зарегистрированный callback `on_new_order`.
        """
        logger.info(f"📥 [Mock FunPay] Покупатель {buyer_username} прислал данные для заказа {order_id}:\n"
                    f"   Логин: {login} | Пароль: ***")

        creds = BuyerCredentials(login=login, password=password)
        order = Order(
            order_id=order_id,
            funpay_chat_id=chat_id,
            buyer_username=buyer_username,
            status=OrderStatus.NEW,
            credentials=creds
        )

        if self._on_new_order_callback:
            if asyncio.iscoroutinefunction(self._on_new_order_callback):
                await self._on_new_order_callback(order)
            else:
                self._on_new_order_callback(order)

        return order

    async def simulate_buyer_2fa_reply(self, chat_id: int, code: str) -> None:
        """
        Имитирует ответ покупателя в чат с кодом 2FA.
        Вызывает зарегистрированный callback `on_2fa_code`.
        """
        logger.info(f"📥 [Mock FunPay Чат #{chat_id}] Покупатель прислал код подтверждения: '{code}'")
        extracted_code = FunPayMessageParser.extract_2fa_code(code) or code

        if self._on_2fa_code_callback:
            if asyncio.iscoroutinefunction(self._on_2fa_code_callback):
                await self._on_2fa_code_callback(chat_id, extracted_code)
            else:
                self._on_2fa_code_callback(chat_id, extracted_code)

    async def simulate_buyer_chat_message(self, chat_id: int, text: str, buyer_username: str = "Клиент") -> None:
        """
        Имитирует вопрос покупателя в чате (для ответа AI-ассистентом).
        """
        logger.info(f"📥 [Mock FunPay Чат #{chat_id}] {buyer_username} спрашивает: '{text}'")
        if self._on_chat_message_callback:
            if asyncio.iscoroutinefunction(self._on_chat_message_callback):
                await self._on_chat_message_callback(chat_id, text, buyer_username)
            else:
                self._on_chat_message_callback(chat_id, text, buyer_username)

    async def start_polling(self, poll_interval: int = 5) -> None:
        """В мок-режиме просто удерживаем цикл."""
        self._is_running = True
        while self._is_running:
            await asyncio.sleep(poll_interval)

    async def stop(self) -> None:
        """Остановка мок-клиента."""
        self._is_running = False
        logger.info("[Mock FunPay] Клиент остановлен.")
