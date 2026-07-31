"""
Telegram Бот (@BotFather) на aiogram 3.x v2.0.
Управление сделками, уведомления об авто-оплате в сети Base, статистика и ручной контроль.
"""

import asyncio
from typing import Optional, Callable, Any
from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    CallbackQuery,
    BufferedInputFile,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
)
from aiogram.filters import Command, CommandObject

from src.config import config
from src.utils.logger import logger
from src.models.order import Order
from src.models.repository import OrderRepository


class TelegramAdminBot:
    """
    Асинхронный Telegram-бот для администратора/продавца.
    Управляет уведомлениями об авто-оплате Base, статистикой и сделками.
    """

    def __init__(self, token: Optional[str] = None, repository: Optional[OrderRepository] = None):
        self.token = token or config.TELEGRAM_BOT_TOKEN
        self.admin_ids = config.admin_ids_list
        self.repository = repository or OrderRepository()
        self.bot: Optional[Bot] = None
        self.dp: Optional[Dispatcher] = None
        self._is_running = False

        # Callbacks от диспетчера автоматизации
        self._on_payment_confirmed_cb: Optional[Callable[[str], Any]] = None
        self._on_refresh_qr_cb: Optional[Callable[[str], Any]] = None
        self._on_cancel_order_cb: Optional[Callable[[str], Any]] = None
        self._on_mock_order_cb: Optional[Callable[[str, str, bool], Any]] = None
        self._on_manual_2fa_cb: Optional[Callable[[str, str], Any]] = None
        self._on_auto_pay_cb: Optional[Callable[[str], Any]] = None

    def register_automation_callbacks(
        self,
        on_payment_confirmed: Optional[Callable[[str], Any]] = None,
        on_refresh_qr: Optional[Callable[[str], Any]] = None,
        on_cancel_order: Optional[Callable[[str], Any]] = None,
        on_mock_order: Optional[Callable[[str, str, bool], Any]] = None,
        on_manual_2fa: Optional[Callable[[str, str], Any]] = None,
        on_auto_pay: Optional[Callable[[str], Any]] = None
    ) -> None:
        """Регистрирует callback-функции."""
        self._on_payment_confirmed_cb = on_payment_confirmed
        self._on_refresh_qr_cb = on_refresh_qr
        self._on_cancel_order_cb = on_cancel_order
        self._on_mock_order_cb = on_mock_order
        self._on_manual_2fa_cb = on_manual_2fa
        self._on_auto_pay_cb = on_auto_pay

    async def start(self) -> bool:
        """Инициализирует бота и обработчики команд/кнопок."""
        if not self.token or "123456789:" in self.token:
            logger.warning("⚠️ TELEGRAM_BOT_TOKEN не установлен или тестовый. Бот будет работать в консольном режиме.")
            return False

        try:
            self.bot = Bot(token=self.token)
            self.dp = Dispatcher()
            self._register_handlers()
            self._is_running = True
            logger.info("🤖 Telegram бот успешно инициализирован.")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка при инициализации Telegram бота: {e}")
            return False

    def _register_handlers(self) -> None:
        """Регистрирует команды и обработчики кнопок."""
        assert self.dp is not None

        @self.dp.message(Command("start", "help"))
        async def cmd_start_help(message: Message) -> None:
            if not self._is_admin(message.from_user.id if message.from_user else 0):
                await message.answer("⛔ У вас нет доступа к этому боту управления.")
                return

            welcome_text = (
                "👋 **Привет! Я бот автоматизации X Premium & FunPay v2.0**\n\n"
                "⚡ **Режим полной автоматизации:**\n"
                "1. Покупатель присылает логин/пароль в чат FunPay.\n"
                "2. Бот авторизуется в X.com и при необходимости запрашивает 2FA.\n"
                "3. **AI-ассистент (OpenRouter)** автоматически отвечает на любые вопросы покупателя в чате!\n"
                "4. **Ончейн-движок Base** автоматически оплачивает подписку без QR-кода!\n"
                "5. Покупатель получает уведомление о завершении сделки.\n\n"
                "📋 **Команды:**\n"
                "`/status` — Просмотр активных заказов\n"
                "`/stats` — Финансовая статистика и учет сделок\n"
                "`/mock_order <логин> <пароль> [2fa]` — Создать тестовый заказ\n"
                "`/2fa <id_заказа> <код>` — Ввести 2FA код вручную"
            )
            await message.answer(welcome_text, parse_mode="Markdown")

        @self.dp.message(Command("status"))
        async def cmd_status(message: Message) -> None:
            if not self._is_admin(message.from_user.id if message.from_user else 0):
                return

            active_orders = self.repository.get_active_orders()
            if not active_orders:
                await message.answer("✅ В настоящий момент нет активных незавершенных заказов.")
                return

            text = f"📊 **Активные заказы ({len(active_orders)}):**\n\n"
            for o in active_orders:
                text += (
                    f"▫️ **ID**: `{o.order_id}` | Статус: `{o.status.value}`\n"
                    f"   👤 Покупатель: `{o.buyer_username}` | 🔑 Логин: `{o.credentials.login}`\n\n"
                )
            await message.answer(text, parse_mode="Markdown")

        @self.dp.message(Command("stats"))
        async def cmd_stats(message: Message) -> None:
            if not self._is_admin(message.from_user.id if message.from_user else 0):
                return

            summary = self.repository.get_financial_summary()
            text = (
                "📈 **ФИНАНСОВАЯ СТАТИСТИКА И УЧЕТ СДЕЛОК (BASE)**\n\n"
                f"📦 Всего сделок: **{summary['total_orders']}**\n"
                f"✅ Завершено заказов: **{summary['completed_orders']}**\n"
                f"🌐 Ончейн транзакций Base: **{summary['onchain_tx_count']}**\n"
                f"💵 Общий оборот: **${summary['total_usd_volume']}**\n"
                f"💎 Чистая прибыль: **${summary['total_profit_usd']}**\n"
            )
            await message.answer(text, parse_mode="Markdown")

        @self.dp.message(Command("mock_order", "test_order"))
        async def cmd_mock_order(message: Message, command: CommandObject) -> None:
            if not self._is_admin(message.from_user.id if message.from_user else 0):
                return

            args = command.args
            if not args or len(args.split()) < 2:
                await message.answer(
                    "⚠️ Формат: `/mock_order <логин> <пароль> [2fa]`\n"
                    "Пример: `/mock_order test_user@gmail.com pass123 2fa`",
                    parse_mode="Markdown"
                )
                return

            parts = args.split()
            login = parts[0]
            password = parts[1]
            require_2fa = "2fa" in [p.lower() for p in parts[2:]]

            await message.answer(f"🚀 Запущен тестовый заказ для `{login}` (2FA={'Да' if require_2fa else 'Нет'})...",
                                 parse_mode="Markdown")

            if self._on_mock_order_cb:
                if asyncio.iscoroutinefunction(self._on_mock_order_cb):
                    await self._on_mock_order_cb(login, password, require_2fa)
                else:
                    self._on_mock_order_cb(login, password, require_2fa)

        @self.dp.message(Command("2fa"))
        async def cmd_2fa(message: Message, command: CommandObject) -> None:
            if not self._is_admin(message.from_user.id if message.from_user else 0):
                return

            args = command.args
            if not args or len(args.split()) < 2:
                await message.answer("⚠️ Формат: `/2fa <ID_заказа> <код>`\nПример: `/2fa #FP12345 839201`",
                                     parse_mode="Markdown")
                return

            parts = args.split()
            order_id = parts[0]
            code = parts[1]
            await message.answer(f"🔐 Вручную отправлен 2FA код `{code}` для заказа `{order_id}`...", parse_mode="Markdown")

            if self._on_manual_2fa_cb:
                if asyncio.iscoroutinefunction(self._on_manual_2fa_cb):
                    await self._on_manual_2fa_cb(order_id, code)
                else:
                    self._on_manual_2fa_cb(order_id, code)

        @self.dp.callback_query(F.data.startswith("paid_"))
        async def cb_paid(query: CallbackQuery) -> None:
            order_id = query.data.replace("paid_", "") if query.data else ""
            await query.answer("✅ Подтверждаем оплату...")

            if self._on_payment_confirmed_cb:
                if asyncio.iscoroutinefunction(self._on_payment_confirmed_cb):
                    await self._on_payment_confirmed_cb(order_id)
                else:
                    self._on_payment_confirmed_cb(order_id)

            if query.message:
                await query.message.edit_caption(
                    caption=f"✅ **Заказ {order_id} отмечен как оплаченный!**\nПокупателю отправлено уведомление.",
                    parse_mode="Markdown"
                )

        @self.dp.callback_query(F.data.startswith("autopay_"))
        async def cb_autopay(query: CallbackQuery) -> None:
            order_id = query.data.replace("autopay_", "") if query.data else ""
            await query.answer("⚡ Запускаем авто-оплату в Base...")
            if self._on_auto_pay_cb:
                if asyncio.iscoroutinefunction(self._on_auto_pay_cb):
                    await self._on_auto_pay_cb(order_id)
                else:
                    self._on_auto_pay_cb(order_id)

        @self.dp.callback_query(F.data.startswith("refresh_qr_"))
        async def cb_refresh_qr(query: CallbackQuery) -> None:
            order_id = query.data.replace("refresh_qr_", "") if query.data else ""
            await query.answer("🔄 Запрашиваем новый QR код...")
            if self._on_refresh_qr_cb:
                if asyncio.iscoroutinefunction(self._on_refresh_qr_cb):
                    await self._on_refresh_qr_cb(order_id)
                else:
                    self._on_refresh_qr_cb(order_id)

        @self.dp.callback_query(F.data.startswith("cancel_"))
        async def cb_cancel(query: CallbackQuery) -> None:
            order_id = query.data.replace("cancel_", "") if query.data else ""
            await query.answer("❌ Заказ отменяется...")

            if self._on_cancel_order_cb:
                if asyncio.iscoroutinefunction(self._on_cancel_order_cb):
                    await self._on_cancel_order_cb(order_id)
                else:
                    self._on_cancel_order_cb(order_id)

            if query.message:
                await query.message.edit_caption(
                    caption=f"❌ **Заказ {order_id} был отменен администратором.**",
                    parse_mode="Markdown"
                )

    def _is_admin(self, user_id: int) -> bool:
        """Проверяет, входит ли ID в список админов."""
        if not self.admin_ids:
            return True
        return user_id in self.admin_ids

    async def broadcast(self, text: str, reply_markup: Optional[InlineKeyboardMarkup] = None) -> None:
        """Отправляет текстовое сообщение всем администраторам."""
        if not self.bot or not self._is_running:
            logger.info(f"💬 [Telegram Mock Broadcast]\n   {text}")
            return

        for admin_id in self.admin_ids:
            try:
                await self.bot.send_message(
                    chat_id=admin_id,
                    text=text,
                    reply_markup=reply_markup,
                    parse_mode="Markdown"
                )
            except Exception as e:
                logger.error(f"Не удалось отправить сообщение админу {admin_id}: {e}")

    async def notify_new_order(self, order: Order) -> None:
        """Уведомляет о новом поступившем заказе."""
        text = (
            f"📦 **НОВЫЙ ЗАКАЗ FUNPAY** `#{order.order_id}`\n\n"
            f"👤 Покупатель: `{order.buyer_username}`\n"
            f"🔑 Логин X.com: `{order.credentials.login}`\n"
            f"⚙️ **Статус**: Авто-вход в X.com и подготовка ончейн-оплаты Base..."
        )
        await self.broadcast(text)

    async def notify_2fa_required(self, order: Order, destination_hint: str) -> None:
        """Уведомляет о том, что от покупателя требуется 2FA-код."""
        text = (
            f"🚨 **ТРЕБУЕТСЯ 2FA КОД** для заказа `#{order.order_id}`\n\n"
            f"👤 Покупатель: `{order.buyer_username}`\n"
            f"📧 Подсказка: `{destination_hint}`\n\n"
            f"ℹ️ *Код автоматически запрошен у покупателя в чате FunPay.*\n\n"
            f"💡 При необходимости вы можете ввести код вручную командой:\n"
            f"`/2fa {order.order_id} <код>`"
        )
        await self.broadcast(text)

    async def notify_auto_payment_success(self, order: Order) -> None:
        """Уведомляет об успешной автоматической оплате в сети Base."""
        text = (
            f"⚡ **АВТО-ОПЛАТА ПОДПИСКИ В СЕТИ BASE**\n\n"
            f"🆔 Заказ: `#{order.order_id}`\n"
            f"👤 Покупатель: `{order.buyer_username}`\n"
            f"🔑 Аккаунт: `{order.credentials.login}`\n"
            f"🔗 **Tx Hash**: `{order.tx_hash}`\n"
            f"💰 Сумма: **{order.amount_crypto}** (`~${order.amount_usd}`)\n"
            f"💎 Прибыль: **${order.profit_usd}**\n\n"
            f"✅ *Транзакция подтверждена в блокчейне Base, подписка активирована. Клиент уведомлен!*"
        )
        await self.broadcast(text)

    async def send_payment_qr(self, order: Order, qr_image_bytes: bytes) -> None:
        """Отправляет фотографию QR-кода оплаты (для ручного режима)."""
        caption = (
            f"🔥 **ОПЛАТА ПОДПИСКИ X PREMIUM**\n"
            f"🆔 Заказ: `#{order.order_id}`\n"
            f"👤 Покупатель: `{order.buyer_username}`\n"
            f"🔑 Аккаунт: `{order.credentials.login}`\n"
            f"🌐 Блокчейн: **Base**\n"
            f"👛 Кошелек: **Trust Wallet** / WalletConnect\n\n"
            f"📲 *Отсканируйте этот QR-код через приложение Trust Wallet или нажмите кнопку авто-оплаты!*"
        )

        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="⚡ Авто-оплата в Base (Кошелек бота)", callback_data=f"autopay_{order.order_id}")],
                [InlineKeyboardButton(text="✅ Оплачено вручную", callback_data=f"paid_{order.order_id}")],
                [
                    InlineKeyboardButton(text="🔄 Обновить QR", callback_data=f"refresh_qr_{order.order_id}"),
                    InlineKeyboardButton(text="❌ Отменить", callback_data=f"cancel_{order.order_id}")
                ]
            ]
        )

        if not self.bot or not self._is_running:
            logger.info(f"🖼️ [Telegram Mock QR Photo]\n{caption}\n[Кнопки: ⚡ Авто-оплата | ✅ Оплачено | 🔄 Обновить | ❌ Отменить]")
            return

        for admin_id in self.admin_ids:
            try:
                photo_file = BufferedInputFile(file=qr_image_bytes, filename=f"qr_{order.order_id}.png")
                await self.bot.send_photo(
                    chat_id=admin_id,
                    photo=photo_file,
                    caption=caption,
                    reply_markup=kb,
                    parse_mode="Markdown"
                )
            except Exception as e:
                logger.error(f"Ошибка отправки QR-кода админу {admin_id}: {e}")

    async def notify_order_completed(self, order: Order) -> None:
        """Уведомляет об успешном завершении заказа."""
        text = (
            f"🎉 **ЗАКАЗ `#{order.order_id}` УСПЕШНО ЗАВЕРШЕН!**\n\n"
            f"👤 Покупатель: `{order.buyer_username}`\n"
            f"🔑 Аккаунт: `{order.credentials.login}`\n"
            f"✅ Подписка X Premium активирована. Клиент уведомлен в чате FunPay."
        )
        await self.broadcast(text)

    async def notify_order_failed(self, order: Order, error_msg: str) -> None:
        """Уведомляет об ошибке выполнения заказа."""
        text = (
            f"❌ **ОШИБКА ВЫПОЛНЕНИЯ ЗАКАЗА `#{order.order_id}`**\n\n"
            f"👤 Покупатель: `{order.buyer_username}`\n"
            f"⚠️ Причина: `{error_msg}`\n\n"
            f"Пожалуйста, проверьте аккаунт вручную."
        )
        await self.broadcast(text)

    async def start_polling(self) -> None:
        """Запускает опрос Telegram."""
        if not self.dp or not self.bot or not self._is_running:
            return
        logger.info("🚀 Запуск опроса команд Telegram-бота...")
        await self.dp.start_polling(self.bot, handle_signals=False)

    async def stop(self) -> None:
        """Останавливает Telegram бота."""
        self._is_running = False
        if self.bot and self.bot.session:
            await self.bot.session.close()
        logger.info("Telegram бот остановлен.")
