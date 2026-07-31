#!/usr/bin/env python3
"""
Автоматизированный набор тестов v2.0 (Unit & Integration Tests)
для проверки корректности работы всех компонентов:
- Парсер сообщений FunPay
- Генератор QR-кодов
- SQLite репозиторий с ончейн и финансовыми полями
- AI-ассистент поддержки через OpenRouter
- Движок авто-оплаты в блокчейне Base
- Оркестрация заказов (Full Auto)
"""

import asyncio
import os
import sys
import time
import unittest
from pathlib import Path

from src.models.order import Order, OrderStatus, BuyerCredentials
from src.models.repository import OrderRepository
from src.funpay.parser import FunPayMessageParser
from src.utils.qr_generator import QRGenerator
from src.services.automation_manager import AutomationManager
from src.ai.support_agent import AISupportAgent
from src.crypto.base_payer import BaseOnChainPayer
from src.config import config


class TestXPremiumAutomationV2(unittest.TestCase):
    """Тестовый набор v2.0 для проверки всех компонентов системы."""

    def setUp(self):
        self.test_db_path = "data/test_suite_v2.db"
        if os.path.exists(self.test_db_path):
            os.remove(self.test_db_path)
        self.repo = OrderRepository(self.test_db_path)

    def tearDown(self):
        if os.path.exists(self.test_db_path):
            os.remove(self.test_db_path)

    def test_01_funpay_parser_credentials(self):
        """Проверка распознавания логина и пароля из сообщений покупателя."""
        msg1 = "Привет! Мой логин: cool_crypto@gmail.com Пароль: SuperPass2026!"
        creds1 = FunPayMessageParser.extract_credentials(msg1)
        self.assertIsNotNone(creds1)
        self.assertEqual(creds1[0], "cool_crypto@gmail.com")
        self.assertEqual(creds1[1], "SuperPass2026!")

    def test_02_funpay_parser_2fa_code(self):
        """Проверка извлечения 6-8 значных кодов подтверждения (2FA)."""
        msg1 = "код 839201"
        self.assertEqual(FunPayMessageParser.extract_2fa_code(msg1), "839201")
        msg2 = "вот пришел код: 12345678"
        self.assertEqual(FunPayMessageParser.extract_2fa_code(msg2), "12345678")

    def test_03_qr_generator(self):
        """Проверка генерации PNG-изображения для QR-кода оплаты на Base."""
        test_uri = "wc:test_trust_wallet_uri@1?bridge=https%3A%2F%2Fbridge.walletconnect.org&key=base_123"
        img_bytes = QRGenerator.generate_qr_image_bytes(test_uri, title="BASE", subtitle="Trust Wallet")
        self.assertIsInstance(img_bytes, bytes)
        self.assertGreater(len(img_bytes), 1000)
        self.assertTrue(img_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_04_sqlite_repository(self):
        """Проверка сохранения, изменения статусов и финансовой статистики в SQLite v2.0."""
        order = Order(
            order_id="#FP101010",
            funpay_chat_id=555666,
            buyer_username="db_tester",
            credentials=BuyerCredentials(login="test@x.com", password="pwd"),
            tx_hash="0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00",
            amount_usd=10.0,
            profit_usd=4.0
        )
        self.repo.save_order(order)
        retrieved = self.repo.get_order("#FP101010")
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.tx_hash, "0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00")

        # Проверка сводной статистики Base
        summary = self.repo.get_financial_summary()
        self.assertEqual(summary["total_orders"], 1)

    def test_05_ai_support_agent(self):
        """Проверка AI-ассистента поддержки (локальная база знаний и OpenRouter)."""
        agent = AISupportAgent()
        reply_srok = agent._knowledge_base_fallback("А сколько длится подписка?")
        self.assertIn("месяц", reply_srok.lower())
        reply_garant = agent._knowledge_base_fallback("А есть гарантия?")
        self.assertIn("гарант", reply_garant.lower())

    def test_06_base_on_chain_payer(self):
        """Проверка движка ончейн-оплаты в блокчейне Base (web3.py / симуляция)."""
        async def run_payer_test():
            payer = BaseOnChainPayer(use_mock=True)
            res = await payer.execute_automatic_payment(recipient_address="0x1234567890123456789012345678901234567890")
            self.assertTrue(res["success"])
            self.assertTrue(res["tx_hash"].startswith("0x"))
            self.assertIn("8453", res["network"])
        asyncio.run(run_payer_test())

    def test_07_full_automation_manager_lifecycle(self):
        """Интеграционный тест v2.0: авто-вход X.com -> авто-оплата в сети Base -> COMPLETED."""
        async def run_async_test():
            manager = AutomationManager(repository=self.repo, use_mock_browser=True)
            await manager.start()

            order = Order(
                order_id="#TEST_FULL_AUTO",
                funpay_chat_id=777888,
                buyer_username="flow_buyer_v2",
                credentials=BuyerCredentials(login="instant_user@gmail.com", password="pass")
            )
            await manager.process_new_order(order)
            await asyncio.sleep(2)

            saved = self.repo.get_order("#TEST_FULL_AUTO")
            self.assertIsNotNone(saved)
            # В версии 2.0 при AUTOMATIC_CRYPTO_PAYMENT=true заказ сразу оплачивается в сети Base
            self.assertEqual(saved.status, OrderStatus.COMPLETED)
            self.assertTrue(saved.tx_hash.startswith("0x"), "Должна присутствовать ончейн-транзакция Base")
            self.assertEqual(saved.payment_method, "base_automatic")

            await manager.stop()

        asyncio.run(run_async_test())


if __name__ == "__main__":
    print("=========================================================================")
    print("🚀 ЗАПУСК НАБОРА ТЕСТОВ (UNIT & INTEGRATION TESTS v2.0)")
    print("=========================================================================")
    unittest.main(verbosity=2)
