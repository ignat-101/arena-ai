#!/usr/bin/env python3
"""
Утилита диагностики и проверки подключения к реальным производственным сервисам:
1. Base Mainnet RPC (EVM Chain ID 8453) и проверка баланса кошелька продавца
2. OpenRouter API (LLM AI-ассистент)
3. Telegram Bot API (@BotFather)
4. FunPay API (по cookie golden_key)

Использование:
    python check_prod.py
"""

import asyncio
import os
import sys

from src.config import config
from src.utils.logger import logger
from src.crypto.base_payer import BaseOnChainPayer
from src.ai.support_agent import AISupportAgent
from src.telegram.bot import TelegramAdminBot
from src.funpay.client import FunPayClient


def print_banner() -> None:
    print("""
=============================================================================
🛠️  X.COM PREMIUM AUTOMATION v2.0 • PRODUCTION CONNECTIVITY DIAGNOSTICS
=============================================================================
""")


async def run_diagnostics() -> None:
    print_banner()

    # 1. Проверка настроек в .env
    print("📋 [1/4] ПРОВЕРКА КОНФИГУРАЦИИ .ENV")
    print("-" * 75)
    print(f"  • AUTOMATIC_CRYPTO_PAYMENT : {config.AUTOMATIC_CRYPTO_PAYMENT}")
    print(f"  • USE_MOCK_CRYPTO          : {config.USE_MOCK_CRYPTO}")
    print(f"  • USE_MOCK_BROWSER         : {config.USE_MOCK_BROWSER}")
    print(f"  • USE_MOCK_FUNPAY          : {config.USE_MOCK_FUNPAY}")
    print(f"  • BASE_RPC_URL             : {config.BASE_RPC_URL}")
    print(f"  • OPENROUTER_MODEL         : {config.OPENROUTER_MODEL}")
    print("-" * 75)

    # 2. Проверка Base Mainnet (web3.py + кошелек)
    print("\n🌐 [2/4] ПРОВЕРКА БЛОКЧЕЙНА BASE MAINNET (EVM CHAIN ID 8453)")
    print("-" * 75)
    payer = BaseOnChainPayer()
    if config.USE_MOCK_CRYPTO or not config.SELLER_WALLET_PRIVATE_KEY:
        print("  ℹ️  Включен безопасный режим эмуляции (USE_MOCK_CRYPTO=true) или не указан ключ продавца.")
        print("     Система будет корректно имитировать ончейн-транзакции без реальных списаний.")
    else:
        connected, msg, data = payer.check_connection_and_balance()
        if connected:
            print(f"  ✅ {msg}")
            print(f"     Адрес кошелька : {data.get('address')}")
            print(f"     Баланс ETH     : {data.get('balance_eth'):.6f} ETH")
            print(f"     Текущий блок   : #{data.get('block_number')}")
        else:
            print(f"  ❌ {msg}")
    print("-" * 75)

    # 3. Проверка AI-ассистента (OpenRouter API vs База знаний)
    print("\n🤖 [3/4] ПРОВЕРКА AI-АССИСТЕНТА ПОДДЕРЖКИ В ЧАТЕ FUNPAY")
    print("-" * 75)
    agent = AISupportAgent()
    test_question = "А сколько длится подписка X Premium?"
    reply = await agent.generate_reply(test_question)
    print(f"  Вопрос покупателя : '{test_question}'")
    print(f"  Ответ ассистента  : '{reply}'")
    if config.OPENROUTER_API_KEY and "sk-or-v1-" in config.OPENROUTER_API_KEY:
        print("  ℹ️  Используется OpenRouter API ключ.")
    else:
        print("  ℹ️  API ключ OpenRouter не указан — работает встроенная интеллектуальная база знаний.")
    print("-" * 75)

    # 4. Проверка FunPay & Telegram Bot
    print("\n📱 [4/4] ПРОВЕРКА TELEGRAM BOT & FUNPAY API")
    print("-" * 75)
    tg = TelegramAdminBot()
    if not config.TELEGRAM_BOT_TOKEN or "123456789:" in config.TELEGRAM_BOT_TOKEN:
        print("  ℹ️  TELEGRAM_BOT_TOKEN является шаблоном. Telegram-бот работает в режиме консольного лога.")
    else:
        tg_ok = await tg.start()
        print(f"  • Telegram Bot (@BotFather) : {'✅ Подключено' if tg_ok else '❌ Ошибка подключения'}")
        await tg.stop()

    fp = FunPayClient()
    if not config.FUNPAY_GOLDEN_KEY:
        print("  ℹ️  FUNPAY_GOLDEN_KEY не указан. Работает эмулятор входящих чатов FunPay.")
    else:
        fp_ok = await fp.start()
        print(f"  • FunPay API (golden_key)   : {'✅ Авторизовано' if fp_ok else '❌ Ошибка авторизации (проверьте cookie)'}")
        await fp.stop()
    print("-" * 75)

    print("\n✅ ДИАГНОСТИКА PRODUCTION-КОМПОНЕНТОВ ЗАВЕРШЕНА!")
    print("   Для запуска сервиса выполните: python3 main.py run\n")


if __name__ == "__main__":
    asyncio.run(run_diagnostics())
