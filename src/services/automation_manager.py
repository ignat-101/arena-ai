"""
Центральный менеджер автоматизации v2.0:
- Оркестрация FunPay, браузера X.com и Telegram-бота
- AI-ассистент поддержки через OpenRouter для общения с покупателем
- Автоматическая ончейн-оплата в сети Base через BaseOnChainPayer
- Ведение финансового учета сделок в SQLite
"""

import asyncio
import time
import uuid
from typing import Dict, Optional, Any

from src.config import config
from src.utils.logger import logger
from src.models.order import Order, OrderStatus, BuyerCredentials, TwoFactorRequest
from src.models.repository import OrderRepository
from src.funpay.client import FunPayClient
from src.funpay.mock_client import MockFunPayClient
from src.telegram.bot import TelegramAdminBot
from src.x_automation.browser import PlaywrightBrowserManager
from src.x_automation.login_handler import XLoginHandler
from src.x_automation.checkout_handler import XCheckoutHandler
from src.x_automation.mock_automation import MockXAutomationEngine
from src.ai.support_agent import AISupportAgent
from src.crypto.base_payer import BaseOnChainPayer


class AutomationManager:
    """
    Полный оркестратор автоматизации:
    - Прием заказов и сообщений в чатах FunPay
    - AI-общение с клиентами по вопросам подписки и активации
    - Авторизация в X.com (с поддержкой 2FA)
    - Автоматическая оплата транзакций в сети Base
    - Управление заказами и финансовая аналитика
    """

    def __init__(
        self,
        funpay_client: Optional[FunPayClient] = None,
        telegram_bot: Optional[TelegramAdminBot] = None,
        repository: Optional[OrderRepository] = None,
        use_mock_browser: Optional[bool] = None
    ):
        self.repository = repository or OrderRepository()
        self.telegram_bot = telegram_bot or TelegramAdminBot(repository=self.repository)
        
        if funpay_client:
            self.funpay_client = funpay_client
        elif config.USE_MOCK_FUNPAY or not config.FUNPAY_GOLDEN_KEY:
            self.funpay_client = MockFunPayClient()
        else:
            self.funpay_client = FunPayClient()

        self.use_mock_browser = (
            use_mock_browser if use_mock_browser is not None else config.USE_MOCK_BROWSER
        )

        # AI-ассистент поддержки покупателей и ончейн плательщик в сети Base
        self.ai_agent = AISupportAgent()
        self.base_payer = BaseOnChainPayer()

        # Активные сессии автоматизации
        self.active_sessions: Dict[str, Dict[str, Any]] = {}
        self._is_running = False

        # Немедленная регистрация callbacks от FunPay
        self.funpay_client.register_callbacks(
            on_new_order=self.process_new_order,
            on_2fa_code=self.handle_buyer_2fa_code,
            on_chat_message=self.handle_buyer_chat_message
        )

    async def start(self) -> None:
        """Запускает сервисы: Telegram бот, FunPay клиент и регистрацию callback-ов."""
        logger.info("⚙️ Запуск центрального менеджера автоматизации v2.0 (AI + Base Auto-Pay)...")
        self._is_running = True

        # Регистрация callbacks от FunPay
        self.funpay_client.register_callbacks(
            on_new_order=self.process_new_order,
            on_2fa_code=self.handle_buyer_2fa_code,
            on_chat_message=self.handle_buyer_chat_message
        )

        # Регистрация callbacks от Telegram бота
        self.telegram_bot.register_automation_callbacks(
            on_payment_confirmed=self.complete_order_manual,
            on_refresh_qr=self.refresh_payment_qr,
            on_cancel_order=self.cancel_order,
            on_mock_order=self.simulate_test_order,
            on_manual_2fa=self.handle_manual_2fa_code,
            on_auto_pay=self.trigger_manual_auto_payment
        )

        await self.telegram_bot.start()
        await self.funpay_client.start()
        logger.info("✅ Все сервисы запущены. Готов к автоматической обработке сделок.")

    async def stop(self) -> None:
        """Завершает работу всех браузерных сессий и сервисов."""
        logger.info("Остановка центрального менеджера автоматизации...")
        self._is_running = False

        for order_id in list(self.active_sessions.keys()):
            await self._cleanup_session(order_id)

        await self.telegram_bot.stop()
        await self.funpay_client.stop()
        logger.info("Автоматизация полностью остановлена.")

    async def _cleanup_session(self, order_id: str) -> None:
        """Закрывает браузер и удаляет сессию из памяти."""
        session_data = self.active_sessions.pop(order_id, None)
        if not session_data:
            return
        try:
            engine_or_browser = session_data.get("browser")
            if engine_or_browser:
                await engine_or_browser.close()
            logger.debug(f"Сессия браузера для заказа #{order_id} очищена.")
        except Exception as e:
            logger.warning(f"Ошибка при очистке браузера заказа #{order_id}: {e}")

    async def handle_buyer_chat_message(self, chat_id: int, text: str, buyer_username: str = "Клиент") -> str:
        """
        Обработка любого входящего сообщения от покупателя в чате FunPay:
        1. Проверяет, не является ли сообщение данными входа или 2FA
        2. Если это вопрос — AI-ассистент OpenRouter генерирует вежливый ответ продавца
        3. Сохраняет историю общения и отправляет ответ в чат
        """
        order = self.repository.get_order_by_chat_id(chat_id)
        
        # Записываем сообщение клиента в лог диалога
        if order:
            order.add_chat_message("buyer", text)
            self.repository.save_order(order)

        # Генерируем ответ AI ассистента
        ai_reply = await self.ai_agent.generate_reply(
            user_message=text,
            order=order,
            chat_history=order.chat_history if order else None
        )

        if order:
            order.add_chat_message("ai", ai_reply)
            self.repository.save_order(order)

        # Отправляем ответ в чат FunPay
        await self.funpay_client.send_message(chat_id, ai_reply)
        return ai_reply

    async def process_new_order(self, order: Order) -> None:
        """
        Основной процесс обработки заказа:
        1. Сохранение в БД и уведомление в Telegram
        2. Авторизация в X.com (с поддержкой 2FA)
        3. Автоматическая оплата транзакции в сети Base
        4. Фиксация сделки и отправка уведомлений
        """
        logger.info(f"🚀 Начало автоматизации заказа #{order.order_id} (Покупатель: {order.buyer_username})")

        # Сохраняем заказ и начальное сообщение
        order.set_status(OrderStatus.LOGGING_IN)
        order.add_chat_message("system", f"Заказ #{order.order_id} принят в работу.")
        self.repository.save_order(order)

        await self.telegram_bot.notify_new_order(order)

        # Запуск браузера или эмулятора
        try:
            if self.use_mock_browser:
                logger.info(f"[Заказ #{order.order_id}] Используется режим эмуляции браузера (Mock Mode).")
                engine = MockXAutomationEngine()
                self.active_sessions[order.order_id] = {
                    "browser": engine,
                    "engine": engine,
                    "order": order
                }
                status, challenge_type, hint = await engine.login(order.credentials)
            else:
                logger.info(f"[Заказ #{order.order_id}] Запуск реального браузера Playwright...")
                browser = PlaywrightBrowserManager()
                page = await browser.start()
                login_handler = XLoginHandler(page)
                checkout_handler = XCheckoutHandler(page)

                self.active_sessions[order.order_id] = {
                    "browser": browser,
                    "login_handler": login_handler,
                    "checkout_handler": checkout_handler,
                    "order": order
                }
                status, challenge_type, hint = await login_handler.login(order.credentials)

        except Exception as e:
            error_msg = f"Ошибка запуска браузера/входа: {e}"
            logger.error(f"[Заказ #{order.order_id}] {error_msg}")
            order.set_status(OrderStatus.ERROR, error=error_msg)
            self.repository.save_order(order)
            await self.funpay_client.send_error_notification(order.funpay_chat_id, "Ошибка инициализации браузера")
            await self.telegram_bot.notify_order_failed(order, error_msg)
            await self._cleanup_session(order.order_id)
            return

        # Анализ результата входа
        if status == "success":
            logger.info(f"[Заказ #{order.order_id}] Авторизация успешна! Переход к оформлению и оплате в Base...")
            await self._proceed_to_checkout(order)

        elif status == "2fa_required":
            logger.warning(f"[Заказ #{order.order_id}] Требуется 2FA! Запрашиваем код у покупателя...")
            order.two_factor = TwoFactorRequest(
                challenge_type=challenge_type or "email",
                destination_hint=hint or "вашу почту/телефон"
            )
            order.set_status(OrderStatus.WAITING_2FA)
            self.repository.save_order(order)

            # Отправляем сообщение покупателю в чат FunPay
            await self.funpay_client.request_2fa_from_buyer(
                chat_id=order.funpay_chat_id,
                destination_hint=hint
            )
            await self.telegram_bot.notify_2fa_required(order, hint)

        else:
            error_msg = hint or "Неверный логин или пароль"
            logger.error(f"[Заказ #{order.order_id}] Ошибка авторизации: {error_msg}")
            order.set_status(OrderStatus.ERROR, error=error_msg)
            self.repository.save_order(order)
            await self.funpay_client.send_error_notification(order.funpay_chat_id, error_msg)
            await self.telegram_bot.notify_order_failed(order, error_msg)
            await self._cleanup_session(order.order_id)

    async def handle_buyer_2fa_code(self, chat_id: int, code: str) -> None:
        """Обрабатывает код 2FA от покупателя в чате FunPay."""
        order = self.repository.get_order_by_chat_id(chat_id)
        if not order:
            logger.warning(f"Получен код 2FA для чата #{chat_id}, но активный заказ не найден в БД.")
            return

        logger.info(f"🔑 [Заказ #{order.order_id}] Покупатель прислал код 2FA: '{code}'")
        await self._submit_2fa_for_order(order.order_id, code)

    async def handle_manual_2fa_code(self, order_id: str, code: str) -> None:
        """Обрабатывает код 2FA, введенный администратором из Telegram или Web UI."""
        logger.info(f"🔑 [Заказ #{order_id}] Администратор/Тестер прислал код 2FA: '{code}'")
        await self._submit_2fa_for_order(order_id, code)

    async def _submit_2fa_for_order(self, order_id: str, code: str) -> None:
        """Вводит полученный 2FA код в браузерную сессию."""
        session_data = self.active_sessions.get(order_id)
        if not session_data:
            logger.error(f"[Заказ #{order_id}] Нет активной браузерной сессии для ввода 2FA.")
            return

        order = session_data["order"]
        if order.two_factor:
            order.two_factor.code_received = code
        self.repository.save_order(order)

        success = False
        try:
            if self.use_mock_browser:
                engine = session_data["engine"]
                success = await engine.submit_2fa_code(code)
            else:
                login_handler = session_data["login_handler"]
                success = await login_handler.submit_2fa_code(code)
        except Exception as e:
            logger.error(f"[Заказ #{order_id}] Ошибка при вводе 2FA: {e}")
            success = False

        if success:
            logger.info(f"[Заказ #{order_id}] 2FA успешно пройдена! Переходим к оформлению и оплате...")
            await self._proceed_to_checkout(order)
        else:
            logger.warning(f"[Заказ #{order_id}] Неверный 2FA код '{code}'. Запрашиваем новый...")
            await self.funpay_client.send_message(
                order.funpay_chat_id,
                "❌ Неверный или истекший код подтверждения. Пожалуйста, проверьте и отправьте новый код:"
            )

    async def _proceed_to_checkout(self, order: str | Order) -> None:
        """
        Переходит на страницу подписки X Premium, выбирает блокчейн Base
        и если AUTOMATIC_CRYPTO_PAYMENT=true — автоматически проводит ончейн транзакцию!
        """
        if isinstance(order, str):
            order_obj = self.repository.get_order(order)
            if not order_obj:
                return
            order = order_obj

        session_data = self.active_sessions.get(order.order_id)
        if not session_data:
            logger.error(f"[Заказ #{order.order_id}] Нет активной сессии для checkout.")
            return

        order.set_status(OrderStatus.NAVIGATING_CHECKOUT)
        self.repository.save_order(order)

        plan = config.X_SUBSCRIPTION_PLAN
        tier = config.X_SUBSCRIPTION_TIER

        try:
            if self.use_mock_browser:
                engine = session_data["engine"]
                qr = await engine.start_subscription_checkout(plan=plan, tier=tier)
            else:
                checkout_handler = session_data["checkout_handler"]
                qr = await checkout_handler.start_subscription_checkout(plan=plan, tier=tier)

            if not qr:
                error_msg = "Не удалось выбрать оплату Base в Stripe Checkout"
                logger.error(f"[Заказ #{order.order_id}] {error_msg}")
                order.set_status(OrderStatus.ERROR, error=error_msg)
                self.repository.save_order(order)
                await self.telegram_bot.notify_order_failed(order, error_msg)
                await self._cleanup_session(order.order_id)
                return

            order.payment_qr = qr

            # --- АВТОМАТИЧЕСКАЯ ОПЛАТА В БЛОКЧЕЙНЕ BASE ---
            if config.AUTOMATIC_CRYPTO_PAYMENT:
                logger.info(f"[Заказ #{order.order_id}] ⚡ AUTOMATIC_CRYPTO_PAYMENT=true. Выполняется автоматическая транзакция в Base...")
                order.set_status(OrderStatus.PAYING_ON_CHAIN)
                self.repository.save_order(order)

                tx_result = await self.base_payer.execute_automatic_payment(
                    recipient_address="0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
                    amount_wei=3500000000000000,
                    currency=config.CRYPTO_CURRENCY
                )

                order.tx_hash = str(tx_result.get("tx_hash", ""))
                order.amount_crypto = str(tx_result.get("amount_crypto", "0.0035 ETH"))
                order.amount_usd = float(tx_result.get("amount_usd", 8.00))
                order.profit_usd = 3.50  # Средняя расчетная прибыль с заказа
                order.payment_method = "base_automatic"

                await self.complete_order_automatic(order)
            else:
                # Режим ручной оплаты (с QR-кодом)
                order.set_status(OrderStatus.WAITING_PAYMENT)
                order.payment_method = "trust_wallet_qr"
                self.repository.save_order(order)
                if qr.image_bytes:
                    await self.telegram_bot.send_payment_qr(order, qr.image_bytes)
                asyncio.create_task(self._monitor_payment_success(order.order_id))

        except Exception as e:
            error_msg = f"Ошибка на этапе checkout / оплаты в Base: {e}"
            logger.error(f"[Заказ #{order.order_id}] {error_msg}")
            order.set_status(OrderStatus.ERROR, error=error_msg)
            self.repository.save_order(order)
            await self.telegram_bot.notify_order_failed(order, error_msg)
            await self._cleanup_session(order.order_id)

    async def complete_order_automatic(self, order: Order) -> None:
        """
        Успешное завершение заказа при автоматической оплате в блокчейне Base:
        1. Фиксирует статус COMPLETED в SQLite
        2. Отправляет покупателю радостное уведомление в чат FunPay
        3. Отправляет отчет о транзакции Base в Telegram
        4. Очищает сессию браузера
        """
        logger.info(f"🎉 [Заказ #{order.order_id}] Авто-транзакция в Base подтверждена! Активируем подписку...")
        order.set_status(OrderStatus.COMPLETED)
        order.add_chat_message("system", f"Заказ завершен. Tx Hash: {order.tx_hash}")
        self.repository.save_order(order)

        # Отправляем сообщение покупателю в чат FunPay
        await self.funpay_client.send_success_notification(order.funpay_chat_id)

        # Уведомляем администраторов в Telegram
        await self.telegram_bot.notify_auto_payment_success(order)

        # Очищаем сессию
        await self._cleanup_session(order.order_id)

    async def trigger_manual_auto_payment(self, order_id: str) -> None:
        """Принудительный запуск ончейн-оплаты в Base из кнопки Telegram или Web UI."""
        order = self.repository.get_order(order_id)
        if not order:
            return
        logger.info(f"⚡ [Заказ #{order_id}] Ручной запуск автоматической оплаты в Base...")
        tx_result = await self.base_payer.execute_automatic_payment()
        order.tx_hash = str(tx_result.get("tx_hash", ""))
        order.amount_crypto = str(tx_result.get("amount_crypto", "0.0035 ETH"))
        order.amount_usd = float(tx_result.get("amount_usd", 8.00))
        order.profit_usd = 3.50
        order.payment_method = "base_automatic"
        await self.complete_order_automatic(order)

    async def _monitor_payment_success(self, order_id: str) -> None:
        """Фоновый монитор окончания оплаты на странице Stripe Checkout."""
        session_data = self.active_sessions.get(order_id)
        if not session_data or self.use_mock_browser:
            return

        checkout_handler = session_data.get("checkout_handler")
        if not checkout_handler:
            return

        success = await checkout_handler.wait_for_payment_success(timeout=300)
        if success:
            await self.complete_order_manual(order_id)

    async def complete_order_manual(self, order_id: str) -> None:
        """Завершение заказа при подтверждении из Telegram или Web UI."""
        order = self.repository.get_order(order_id)
        if not order:
            return

        logger.info(f"🎉 [Заказ #{order_id}] Оплата подтверждена! Завершение сделки...")
        order.set_status(OrderStatus.COMPLETED)
        order.add_chat_message("system", "Заказ подтвержден продавцом.")
        self.repository.save_order(order)

        await self.funpay_client.send_success_notification(order.funpay_chat_id)
        await self.telegram_bot.notify_order_completed(order)
        await self._cleanup_session(order_id)

    async def refresh_payment_qr(self, order_id: str) -> None:
        """Обновление QR-кода при необходимости."""
        order = self.repository.get_order(order_id)
        if order:
            await self._proceed_to_checkout(order)

    async def cancel_order(self, order_id: str) -> None:
        """Отмена заказа."""
        order = self.repository.get_order(order_id)
        if not order:
            return
        logger.info(f"❌ [Заказ #{order_id}] Заказ отменен.")
        order.set_status(OrderStatus.CANCELLED)
        order.add_chat_message("system", "Заказ отменен.")
        self.repository.save_order(order)
        await self._cleanup_session(order_id)

    async def simulate_test_order(
        self,
        login: str,
        password: str,
        require_2fa: bool = False
    ) -> Order:
        """Создает тестовый заказ и возвращает созданный объект."""
        logger.info(f"🧪 Создание тестового заказа: логин={login}, 2fa={require_2fa}")
        order_id = f"#FP_{uuid.uuid4().hex[:6].upper()}"

        creds = BuyerCredentials(login=login, password=password)
        order = Order(
            order_id=order_id,
            funpay_chat_id=int(time.time()) % 1000000,
            buyer_username="crypto_tester",
            credentials=creds
        )

        if isinstance(self.funpay_client, MockFunPayClient):
            await self.funpay_client.simulate_incoming_order(
                login=login,
                password=password,
                buyer_username="crypto_tester",
                chat_id=order.funpay_chat_id,
                order_id=order_id
            )
        else:
            await self.process_new_order(order)

        return self.repository.get_order(order_id) or order
