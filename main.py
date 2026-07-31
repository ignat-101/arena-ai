#!/usr/bin/env python3
"""
Главный входной модуль CLI-приложения v2.0 для полной автоматизации покупки подписок
X.com Premium для клиентов FunPay с авто-оплатой в сети Base, AI-поддержкой через OpenRouter
и Web-дашбордом для тестирования и контроля.

Использование:
    python main.py [run]                 -- Запуск демона автоматизации (FunPay + Telegram Bot + Web Дашборд)
    python main.py web                   -- Запуск только Web-дашборда и симулятора сделок (по умолчанию порт 8000)
    python main.py test-order <log> <pwd> [--2fa] -- Тестовый заказ с авто-оплатой в Base и проверкой 2FA
    python main.py test-telegram         -- Тест отправки уведомления и QR-кода в Telegram
    python main.py test-funpay           -- Тест авторизации на FunPay (golden_key)
    python main.py status                -- Просмотр активных заказов в БД
    python main.py stats                 -- Просмотр финансовой статистики и учета сделок
"""

import argparse
import asyncio
import sys
import time
import uvicorn
from typing import List

from src.config import config
from src.utils.logger import logger
from src.services.automation_manager import AutomationManager
from src.models.order import Order, BuyerCredentials, OrderStatus
from src.models.repository import OrderRepository
from src.utils.qr_generator import QRGenerator
from src.telegram.bot import TelegramAdminBot
from src.funpay.client import FunPayClient
from src.web.app import WebDashboardApp


def print_banner() -> None:
    """Выводит ASCII-баннер при запуске программы."""
    banner = """
  ███████╗██╗   ██╗███╗   ██╗██████╗  █████╗ ██╗   ██╗    
  ██╔════╝██║   ██║████╗  ██║██╔══██╗██╔══██╗╚██╗ ██╔╝    
  █████╗  ██║   ██║██╔██╗ ██║██████╔╝███████║ ╚████╔╝     
  ██╔══╝  ██║   ██║██║╚██╗██║██╔═══╝ ██╔══██║  ╚██╔╝      
  ██║     ╚██████╔╝██║ ╚████║██║     ██║  ██║   ██║       
  ╚═╝      ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝  ╚═╝   ╚═╝       
    X.COM PREMIUM AUTOMATION v2.0 • BASE AUTO-PAY • OPENROUTER AI • WEB UI
"""
    print(banner)


async def _run_uvicorn_in_background(app, host: str, port: int) -> None:
    """Запускает сервер Uvicorn в асинхронном фоновом цикле."""
    config_uv = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config_uv)
    await server.serve()


async def run_daemon(args: argparse.Namespace) -> None:
    """Запускает полный сервис: FunPay Listener + Telegram Bot + Web Дашборд."""
    print_banner()

    warnings = config.validate_essential_settings()
    for w in warnings:
        logger.warning(w)

    use_mock_browser = args.mock_browser or config.USE_MOCK_BROWSER
    use_mock_funpay = args.mock_funpay or config.USE_MOCK_FUNPAY
    web_port = args.web_port or config.WEB_PORT

    logger.info(f"🚀 Старт автоматизации v2.0: mock_browser={use_mock_browser}, mock_funpay={use_mock_funpay}")
    logger.info(f"🌐 Сеть оплаты: {config.BLOCKCHAIN_NETWORK} (Auto-Pay: {config.AUTOMATIC_CRYPTO_PAYMENT})")

    manager = AutomationManager(use_mock_browser=use_mock_browser)
    await manager.start()

    # Если Web-дашборд не отключен, запускаем его параллельно
    web_task = None
    if not args.no_web:
        web_app = WebDashboardApp(manager)
        logger.info(f"🌐 Web-дашборд и симулятор сделок доступен по адресу http://localhost:{web_port}/")
        web_task = asyncio.create_task(_run_uvicorn_in_background(web_app.app, config.WEB_HOST, web_port))

    logger.info("ℹ️ Для тестирования создайте заказ на Web-дашборде или отправьте /mock_order в Telegram-боте.")

    try:
        while True:
            await asyncio.sleep(5)
    except KeyboardInterrupt:
        logger.info("Получен сигнал остановки (Ctrl+C)...")
    finally:
        await manager.stop()
        if web_task:
            web_task.cancel()


async def run_web_only(args: argparse.Namespace) -> None:
    """Запускает только Web-дашборд и интерактивный симулятор."""
    print_banner()
    web_port = args.web_port or config.WEB_PORT
    logger.info(f"🌐 Запуск только Web-дашборда на порту {web_port}...")

    manager = AutomationManager(use_mock_browser=True)
    await manager.start()

    web_app = WebDashboardApp(manager)
    logger.info(f"✅ Перейдите в браузере: http://localhost:{web_port}/")

    try:
        await _run_uvicorn_in_background(web_app.app, config.WEB_HOST, web_port)
    except KeyboardInterrupt:
        logger.info("Остановка Web-дашборда...")
    finally:
        await manager.stop()


async def run_test_order(args: argparse.Namespace) -> None:
    """
    Запускает тестовый сценарий заказа для проверки работы:
    1. Авторизации на X.com
    2. Запроса и ввода 2FA кода
    3. Автоматической ончейн-транзакции в сети Base
    4. Отправки уведомлений в Telegram
    """
    print_banner()
    logger.info("🧪 ЗАПУСК ТЕСТОВОГО СЦЕНАРИЯ С АВТО-ОПЛАТОЙ В BASE")
    login = args.login
    password = args.password
    require_2fa = args.require_2fa

    use_mock_browser = args.mock_browser or config.USE_MOCK_BROWSER
    logger.info(f"Логин: {login} | 2FA проверка: {'ДА' if require_2fa else 'НЕТ'} | Auto-Pay: ДА")

    manager = AutomationManager(use_mock_browser=use_mock_browser)
    await manager.start()

    logger.info("📦 Симуляция создания заказа от покупателя FunPay...")
    await manager.simulate_test_order(login=login, password=password, require_2fa=require_2fa)

    await asyncio.sleep(6)

    # Проверяем, потребовалась ли 2FA
    active_orders = manager.repository.get_active_orders()
    for order in active_orders:
        if order.status == OrderStatus.WAITING_2FA:
            logger.info("=========================================================================")
            logger.info("🔐 ЗАКАЗ НАХОДИТСЯ В ОЖИДАНИИ 2FA КОДА!")
            logger.info("Симуляция ответа покупателя с кодом '839201' через 3 секунды...")
            logger.info("=========================================================================")
            await asyncio.sleep(3)
            await manager.handle_buyer_2fa_code(order.funpay_chat_id, "839201")
            await asyncio.sleep(6)

    logger.info("✅ Тестовый сценарий успешно завершен. Проверьте сообщения в Telegram и историю в БД!")
    await manager.stop()


async def run_test_telegram(args: argparse.Namespace) -> None:
    """Проверяет токен Telegram бота и отправляет тестовое уведомление об авто-оплате."""
    print_banner()
    logger.info("🤖 Проверка подключения Telegram бота...")

    if not config.TELEGRAM_BOT_TOKEN or "123456789:" in config.TELEGRAM_BOT_TOKEN:
        logger.error("❌ TELEGRAM_BOT_TOKEN в файле .env не установлен или является шаблоном!")
        return

    bot = TelegramAdminBot()
    success = await bot.start()
    if not success:
        return

    test_order = Order(
        order_id="#TEST_AUTO_BASE",
        funpay_chat_id=123,
        buyer_username="test_buyer_base",
        credentials=BuyerCredentials(login="test_user_x@gmail.com", password="SecretPassword"),
        tx_hash="0xd803aaf9085133e6a0b917864f41ef7c60c89e53310c6d032c9a600e67eb7958",
        amount_crypto="0.0035 ETH",
        amount_usd=8.05,
        profit_usd=3.50
    )

    logger.info(f"Отправка тестового отчета об авто-оплате в сети Base админам {bot.admin_ids}...")
    await bot.notify_auto_payment_success(test_order)
    await asyncio.sleep(2)
    await bot.stop()
    logger.info("✅ Тестовая отправка в Telegram завершена!")


async def run_test_funpay(args: argparse.Namespace) -> None:
    """Проверяет подключение к платформе FunPay по cookie golden_key."""
    print_banner()
    logger.info("🛒 Проверка подключения и авторизации FunPay...")

    if not config.FUNPAY_GOLDEN_KEY:
        logger.error("❌ FUNPAY_GOLDEN_KEY не установлен в конфигурации / .env!")
        return

    client = FunPayClient()
    success = await client.start()
    if success:
        logger.info("✅ Авторизация на FunPay прошла успешно. Cookie golden_key действителен.")
    else:
        logger.error("❌ Ошибка авторизации на FunPay. Проверьте golden_key.")
    await client.stop()


def run_status(args: argparse.Namespace) -> None:
    """Выводит список активных и недавних заказов из локальной базы данных."""
    print_banner()
    repo = OrderRepository()
    orders = repo.get_all_orders(limit=20)
    if not orders:
        print("База данных пуста. Заказы еще не создавались.")
        return

    print(f"📊 СОСТОЯНИЕ ЗАКАЗОВ В БАЗЕ ДАННЫХ ({len(orders)} записей):")
    print("-" * 95)
    for o in orders:
        created_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(o.created_at))
        tx_disp = (o.tx_hash[:10] + "..." + o.tx_hash[-6:]) if o.tx_hash else "—"
        print(f"[{created_str}] ID: {o.order_id:<12} | Статус: {o.status.value:<12} | "
              f"Покупатель: {o.buyer_username:<10} | Tx: {tx_disp:<18} | +${o.profit_usd:.2f}")
    print("-" * 95)


def run_stats(args: argparse.Namespace) -> None:
    """Выводит финансовую статистику и учет сделок по ончейн-транзакциям в Base."""
    print_banner()
    repo = OrderRepository()
    summary = repo.get_financial_summary()
    print("📈 ФИНАНСОВАЯ СТАТИСТИКА И УЧЕТ СДЕЛОК (BASE MAINNET)")
    print("=" * 60)
    print(f"  Всего сделок в системе     : {summary['total_orders']}")
    print(f"  Завершено и оплачено       : {summary['completed_orders']}")
    print(f"  Ончейн транзакций Base     : {summary['onchain_tx_count']}")
    print(f"  Общий финансовый оборот   : ${summary['total_usd_volume']:.2f}")
    print(f"  Чистая расчетная прибыль   : ${summary['total_profit_usd']:.2f}")
    print("=" * 60)


def parse_arguments() -> argparse.Namespace:
    """Разбор аргументов командной строки."""
    parser = argparse.ArgumentParser(
        description="X.com Premium FunPay Automation v2.0 (Base Auto-Pay / OpenRouter AI / Web Dashboard)"
    )
    subparsers = parser.add_subparsers(dest="command", help="Команда для выполнения")

    # Команда run (по умолчанию)
    parser_run = subparsers.add_parser("run", help="Запустить демона автоматизации с Web-дашбордом")
    parser_run.add_argument("--mock-browser", action="store_true", help="Режим эмуляции браузера")
    parser_run.add_argument("--mock-funpay", action="store_true", help="Режим эмуляции FunPay")
    parser_run.add_argument("--no-web", action="store_true", help="Отключить запуск Web-дашборда")
    parser_run.add_argument("--web-port", type=int, default=8000, help="Порт Web-сервера (по умолчанию 8000)")

    # Команда web
    parser_web = subparsers.add_parser("web", help="Запустить только Web-дашборд и симулятор сделок")
    parser_web.add_argument("--web-port", type=int, default=8000, help="Порт Web-сервера")

    # Команда test-order
    parser_test_order = subparsers.add_parser("test-order", help="Симулировать заказ с авто-оплатой в Base")
    parser_test_order.add_argument("login", help="Логин пользователя X.com для теста")
    parser_test_order.add_argument("password", help="Пароль пользователя X.com для теста")
    parser_test_order.add_argument("--2fa", dest="require_2fa", action="store_true", help="Принудительно запросить 2FA код")
    parser_test_order.add_argument("--mock-browser", action="store_true", default=True, help="Режим эмуляции браузера")

    # Команда test-telegram
    subparsers.add_parser("test-telegram", help="Проверить работу Telegram бота")

    # Команда test-funpay
    subparsers.add_parser("test-funpay", help="Проверить авторизацию FunPay по golden_key")

    # Команда status
    subparsers.add_parser("status", help="Просмотреть активные и завершенные заказы в БД")

    # Команда stats
    subparsers.add_parser("stats", help="Просмотреть финансовую статистику и учет сделок в Base")

    return parser.parse_args()


def main() -> None:
    """Главная точка входа в программу v2.0."""
    args = parse_arguments()
    command = args.command or "run"

    if command == "status":
        run_status(args)
    elif command == "stats":
        run_stats(args)
    elif command == "test-order":
        asyncio.run(run_test_order(args))
    elif command == "test-telegram":
        asyncio.run(run_test_telegram(args))
    elif command == "test-funpay":
        asyncio.run(run_test_funpay(args))
    elif command == "web":
        asyncio.run(run_web_only(args))
    elif command == "run":
        asyncio.run(run_daemon(args))
    else:
        asyncio.run(run_daemon(args))


if __name__ == "__main__":
    main()
